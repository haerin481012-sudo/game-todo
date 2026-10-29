"use strict";

/* ===== 설정 ===== */
const CONFIG = Object.freeze({
  MIN_TODOS_FOR_CLEAR: 3, // 올클리어로 인정하는 최소 할 일 수
  MAX_TODOS_PER_DAY: 20, // 하루에 추가할 수 있는 최대 할 일 수
  PET_NAME_MAX_LENGTH: 12,
});

// 성장 단계. growth가 min 이상이면 그 단계. 아래에서 위로 오름차순.
const PET_STAGES = Object.freeze([
  { min: 0, name: "알", icon: "🥚" },
  { min: 3, name: "아기", icon: "🐣" },
  { min: 7, name: "어린이", icon: "🐥" },
  { min: 14, name: "어른", icon: "🐔" },
  { min: 30, name: "전설", icon: "🐉" },
]);

const PET_MOODS = Object.freeze({
  happy: { label: "신남", icon: "😆", note: "오늘 올클리어했어요!" },
  normal: { label: "보통", icon: "🙂", note: "오늘도 올클리어하면 신나요." },
  sad: { label: "시무룩", icon: "😢", note: "올클리어를 기다리고 있어요." },
});

const STORAGE_KEY = "gameTodo.v2";
const STATE_VERSION = 2;
// 이전 버전(포인트·상점) 저장 키. 읽기만 하고 지우지 않는다.
const LEGACY_KEY = "gameTodo.v1";
// v1 → v2 변환 직전에 v1 원본 문자열을 그대로 복사해 두는 키.
const LEGACY_BACKUP_KEY = "gameTodo.v1.backup";
// v2 저장값을 읽을 수 없을 때 덮어쓰기 전에 원본을 남겨 두는 키 (가장 최근 것만).
const BACKUP_KEY = "gameTodo.backup";

/*
 * 같은 키(gameTodo.v2) 안에서의 저장 형식 변환. 키는 "변환 전 버전", 값은 다음 버전으로 바꾸는 함수.
 * 상태 구조를 바꿀 때는 STATE_VERSION을 올리고 여기에 변환 함수를 추가한다. 예:
 *   2: (s) => ({ ...s, version: 3, streak: 0 }),
 * (v1 → v2는 저장 키까지 바뀌므로 migrateFromV1()이 따로 맡는다.)
 */
const MIGRATIONS = {};
const CATEGORIES = ["work", "personal", "study"];
const CATEGORY_LABELS = { work: "업무", personal: "개인", study: "공부" };
const TITLE_MAX_LENGTH = 50;

/*
 * 상태 구조 (v2):
 * {
 *   version: 2,
 *   todos: [todo, ...],
 *   clearDates: ["YYYY-MM-DD", ...],   // 올클리어한 날짜 (오름차순, 중복 없음)
 *   pet: { name: string, growth: number, createdAt: "YYYY-MM-DD" },
 *   badges: [string, ...]              // 받은 배지 id
 * }
 *
 * todo 구조:
 * {
 *   id: string,
 *   title: string,
 *   category: "work" | "personal" | "study",
 *   date: "YYYY-MM-DD",
 *   done: boolean,
 *   createdAt: number (ms),
 *   completedAt: number | null (ms)
 * }
 */

/* ===== 날짜 표시 ===== */
// getLocalDateString / parseLocalDate / addDays와 연속 달성 계산은 streak.js에 있다.
const WEEKDAYS = ["일", "월", "화", "수", "목", "금", "토"];

// "2026-10-29(목)"
function formatDateLabel(dateString) {
  return `${dateString}(${WEEKDAYS[parseLocalDate(dateString).getDay()]})`;
}

/* ===== 저장소 접근 ===== */
// localStorage는 차단·용량 초과 등으로 예외를 던질 수 있으므로 모든 접근을 여기서 감싼다.
function readStorage(key) {
  try {
    return localStorage.getItem(key);
  } catch (err) {
    console.error(`저장소에서 "${key}"를 읽을 수 없습니다.`, err);
    return null;
  }
}

function writeStorage(key, value) {
  try {
    localStorage.setItem(key, value);
    return true;
  } catch (err) {
    console.error(`저장소에 "${key}"를 쓸 수 없습니다.`, err);
    return false;
  }
}

/* ===== 상태 ===== */
function createPet(growth = 0) {
  return { name: "", growth, createdAt: getLocalDateString() };
}

function createInitialState() {
  return {
    version: STATE_VERSION,
    todos: [],
    clearDates: [],
    pet: createPet(),
    badges: [],
  };
}

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

const isObject = (value) => value !== null && typeof value === "object";
const isDateString = (value) => typeof value === "string" && DATE_PATTERN.test(value);

function isValidTodo(todo) {
  return isObject(todo)
    && typeof todo.id === "string"
    && typeof todo.title === "string"
    && CATEGORIES.includes(todo.category)
    && typeof todo.date === "string" && DATE_PATTERN.test(todo.date)
    && typeof todo.done === "boolean"
    && Number.isFinite(todo.createdAt);
}

// 배열이면 형식이 맞는 항목만 남긴다. 버린 항목이 있으면 problems에 적는다.
function keepValid(list, isValid, label, problems) {
  if (!Array.isArray(list)) {
    if (list !== undefined) problems.push(`${label} 목록이 배열이 아님`);
    return [];
  }
  const valid = list.filter(isValid);
  if (valid.length !== list.length) {
    problems.push(`형식이 잘못된 ${label} ${list.length - valid.length}개`);
  }
  return valid;
}

// 옛 버전 상태를 MIGRATIONS로 한 단계씩 현재 버전까지 올린다. 올릴 수 없으면 null.
// 이 앱보다 새 버전의 데이터는 건드리지 않는다(null).
function migrateState(raw) {
  if (!isObject(raw) || !Number.isInteger(raw.version) || raw.version > STATE_VERSION) {
    return null;
  }
  let current = raw;
  while (current.version < STATE_VERSION) {
    const migrate = MIGRATIONS[current.version];
    if (!migrate) return null;
    current = migrate(current);
  }
  return current;
}

function normalizeTodos(list, problems) {
  return keepValid(list, isValidTodo, "할 일", problems).map((todo) => ({
    ...todo,
    completedAt: todo.done && Number.isFinite(todo.completedAt) ? todo.completedAt : null,
  }));
}

// 형식이 맞는 날짜만 남기고 중복 제거 + 오름차순 정렬.
function normalizeDates(list, label, problems) {
  return [...new Set(keepValid(list, isDateString, label, problems))].sort();
}

function normalizePet(raw, problems) {
  if (!isObject(raw)) {
    if (raw !== undefined) problems.push("펫 정보가 객체가 아님");
    return createPet();
  }
  const growthOk = Number.isInteger(raw.growth) && raw.growth >= 0;
  if (!growthOk) problems.push("펫 성장치가 잘못됨");
  return {
    name: typeof raw.name === "string" ? raw.name : "",
    growth: growthOk ? raw.growth : 0,
    createdAt: isDateString(raw.createdAt) ? raw.createdAt : getLocalDateString(),
  };
}

// 현재 버전 형태인지 확인하고, 빠지거나 잘못된 값은 기본값으로 바꾸거나 버린다.
function normalizeState(raw, problems = []) {
  return {
    version: STATE_VERSION,
    todos: normalizeTodos(raw.todos, problems),
    clearDates: normalizeDates(raw.clearDates, "올클리어 날짜", problems),
    pet: normalizePet(raw.pet, problems),
    badges: [...new Set(keepValid(raw.badges, (id) => typeof id === "string", "배지", problems))],
  };
}

// 다음 저장 때 덮어써지기 전에 원본 문자열을 백업 키에 남긴다.
function backupRawState(json, reason) {
  console.warn(`저장 데이터 문제(${reason}). 원본을 localStorage "${BACKUP_KEY}"에 백업합니다.`);
  writeStorage(BACKUP_KEY, JSON.stringify({ backedUpAt: Date.now(), reason, data: json }));
}

/*
 * v1 상태 → v2 상태.
 * - todos는 그대로 (형식이 잘못된 항목만 버림)
 * - bonusDates → clearDates, 펫 성장치는 올클리어한 날 수로 시작
 * - points, purchases는 옮기지 않는다 (v1 원본은 백업 키와 v1 키에 남아 있음)
 */
function convertV1ToV2(v1) {
  const problems = [];
  const clearDates = normalizeDates(v1.bonusDates, "보너스 날짜", problems);
  const converted = {
    version: STATE_VERSION,
    todos: normalizeTodos(v1.todos, problems),
    clearDates,
    pet: createPet(clearDates.length),
    badges: [],
  };
  return { converted, problems };
}

// v2가 없고 v1이 있을 때 한 번 실행된다. 결과는 바로 v2 키에 저장해서 다음부터는 v2를 읽는다.
// v1이 깨졌거나 v1 형식이 아니면 빈 v2로 시작한다. 어느 경우든 v1 키는 지우지 않는다.
function migrateFromV1(legacyJson) {
  if (!writeStorage(LEGACY_BACKUP_KEY, legacyJson)) {
    console.warn(`v1 원본을 "${LEGACY_BACKUP_KEY}"에 복사하지 못했습니다. 원본은 "${LEGACY_KEY}"에 그대로 있습니다.`);
  }

  let next;
  try {
    const v1 = JSON.parse(legacyJson);
    if (!isObject(v1) || v1.version !== 1) {
      throw new Error(`v1 형식이 아님 (version: ${isObject(v1) ? v1.version : typeof v1})`);
    }
    const { converted, problems } = convertV1ToV2(v1);
    if (problems.length > 0) {
      console.warn(`v1 → v2 변환 중 건너뛴 항목: ${problems.join(", ")}`);
    }
    next = converted;
  } catch (err) {
    console.warn("v1 데이터를 변환할 수 없어 빈 상태로 시작합니다.", err);
    next = createInitialState();
  }

  writeStorage(STORAGE_KEY, JSON.stringify(next));
  return next;
}

function loadState() {
  const json = readStorage(STORAGE_KEY);
  if (json === null) {
    const legacyJson = readStorage(LEGACY_KEY);
    return legacyJson === null ? createInitialState() : migrateFromV1(legacyJson);
  }

  let raw;
  try {
    raw = JSON.parse(json);
  } catch (err) {
    backupRawState(json, `JSON 해석 실패: ${err.message}`);
    return createInitialState();
  }

  try {
    const migrated = migrateState(raw);
    if (!migrated) {
      backupRawState(json, `지원하지 않는 버전: ${isObject(raw) ? raw.version : typeof raw}`);
      return createInitialState();
    }
    const problems = [];
    const loaded = normalizeState(migrated, problems);
    if (problems.length > 0) {
      backupRawState(json, problems.join(", "));
    }
    return loaded;
  } catch (err) {
    backupRawState(json, `불러오기 오류: ${err.message}`);
    return createInitialState();
  }
}

function saveState() {
  return writeStorage(STORAGE_KEY, JSON.stringify(state));
}

let state = loadState();

// 화면에서 보고 있는 날짜와 카테고리 필터 (저장하지 않음). 새로고침하면 오늘, 전체.
let selectedDate = getLocalDateString();
let categoryFilter = "all";
// 수정 중인 할 일 id (저장하지 않음). 한 번에 하나만 수정한다.
let editingId = null;

/* ===== 할 일 ===== */
function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

// 앞뒤 공백 제거 후 1~50자인지 확인. 이모지도 1자로 세도록 코드포인트 단위로 센다.
function validateTitle(rawTitle) {
  const title = rawTitle.trim();
  const length = Array.from(title).length;
  if (length === 0) {
    return { ok: false, title, error: "" };
  }
  if (length > TITLE_MAX_LENGTH) {
    return { ok: false, title, error: `제목은 ${TITLE_MAX_LENGTH}자 이하로 입력해 주세요.` };
  }
  return { ok: true, title, error: "" };
}

function findTodo(id) {
  return state.todos.find((todo) => todo.id === id);
}

// "YYYY-MM-DD"는 문자열 비교가 곧 날짜 비교다.
function isFutureTodo(todo) {
  return todo.date > getLocalDateString();
}

function normalizeCategory(category) {
  return CATEGORIES.includes(category) ? category : "work";
}

/* ===== 올클리어 · 펫 성장 ===== */
// 그날 할 일이 3개 이상이고 모두 완료.
function isAllClear(date) {
  const { total, remaining } = getProgress(date);
  return total >= CONFIG.MIN_TODOS_FOR_CLEAR && remaining === 0;
}

function getPetStage(growth) {
  let index = 0;
  PET_STAGES.forEach((stage, i) => {
    if (growth >= stage.min) index = i;
  });
  return { ...PET_STAGES[index], index, next: PET_STAGES[index + 1] ?? null };
}

/*
 * 할 일 상태를 바꾼 "뒤에" 호출한다. 펫 성장은 이 함수에서만 바뀐다.
 * - 오늘 날짜만 반영: 올클리어를 새로 달성하면 clearDates에 오늘 추가 + growth +1,
 *   깨지면 오늘을 빼고 growth -1. clearDates가 하루 한 번만 오르게 막는다.
 * - 지난 날짜·미래 날짜는 clearDates와 growth를 건드리지 않는다.
 *   (지난 날짜를 나중에 몰아서 체크해 성장시키는 것을 막기 위해)
 * - 올클리어가 새로 추가되면 연속 기록을 다시 계산해 배지를 준다(syncBadges).
 * 반환값: { date, growthChange: 1 | -1 | 0, stageUp, newBadges }
 */
function updateGrowth(date) {
  const result = { date, growthChange: 0, stageUp: false, newBadges: [] };
  if (date !== getLocalDateString()) return result;

  const allClear = isAllClear(date);
  const recorded = state.clearDates.includes(date);
  const before = getPetStage(state.pet.growth);

  if (allClear && !recorded) {
    state.clearDates = [...state.clearDates, date].sort();
    state.pet.growth += 1;
    result.growthChange = 1;
    result.newBadges = syncBadges();
  } else if (!allClear && recorded) {
    state.clearDates = state.clearDates.filter((d) => d !== date);
    state.pet.growth = Math.max(0, state.pet.growth - 1);
    result.growthChange = -1;
  }
  result.stageUp = getPetStage(state.pet.growth).index > before.index;
  return result;
}

// 최고 연속 기록으로 받을 배지를 state.badges에 더한다. 한 번 받은 배지는 빼지 않는다.
// 반환값: 새로 받은 배지 목록
function syncBadges() {
  const { badges, newlyEarned } = mergeBadges(state.badges, getBestStreak(state.clearDates));
  state.badges = badges;
  return newlyEarned;
}

// 오늘 올클리어 → 신남, 어제 올클리어 → 보통, 2일 이상 못 함 → 시무룩.
// 막 만든 펫(만든 날·다음 날)은 아직 기회가 없었으므로 보통.
function getPetMood() {
  const today = getLocalDateString();
  const yesterday = addDays(today, -1);
  if (state.clearDates.includes(today)) return PET_MOODS.happy;
  if (state.clearDates.includes(yesterday) || state.pet.createdAt >= yesterday) return PET_MOODS.normal;
  return PET_MOODS.sad;
}

// 앞뒤 공백 제거 후 1~12자.
function validatePetName(rawName) {
  const name = rawName.trim();
  const length = Array.from(name).length;
  if (length === 0) return { ok: false, name, error: "이름을 입력해 주세요." };
  if (length > CONFIG.PET_NAME_MAX_LENGTH) {
    return { ok: false, name, error: `이름은 ${CONFIG.PET_NAME_MAX_LENGTH}자 이하로 입력해 주세요.` };
  }
  return { ok: true, name, error: "" };
}

/* 아래 변경 함수들은 state만 바꾼다. 저장과 다시 그리기는 commit()이 맡는다.
 * 실패하면 null, 성공하면 updateGrowth()의 결과를 돌려준다. */

function isDayFull(date) {
  return getTodosForDate(date).length >= CONFIG.MAX_TODOS_PER_DAY;
}

function addTodo(title, category) {
  if (isDayFull(selectedDate)) return null;
  state.todos.push({
    id: generateId(),
    title,
    category: normalizeCategory(category),
    date: selectedDate,
    done: false,
    createdAt: Date.now(),
    completedAt: null,
  });
  return updateGrowth(selectedDate); // 미완료 항목이 늘어 올클리어가 깨질 수 있다
}

function setTodoDone(id, done) {
  const todo = findTodo(id);
  if (!todo || isFutureTodo(todo) || todo.done === done) return null;
  todo.done = done;
  todo.completedAt = done ? Date.now() : null;
  // 지난 날짜를 올클리어한 경우 "성장 없음"을 알려 주기 위한 표시
  const pastClear = done && todo.date < getLocalDateString() && isAllClear(todo.date);
  return { ...updateGrowth(todo.date), pastClear };
}

function renamePet(name) {
  state.pet.name = name;
}

function updateTodo(id, title, category) {
  const todo = findTodo(id);
  if (!todo) return false;
  todo.title = title;
  todo.category = normalizeCategory(category);
  return true;
}

function deleteTodo(id) {
  const index = state.todos.findIndex((todo) => todo.id === id);
  if (index === -1) return null;
  const [removed] = state.todos.splice(index, 1);
  // 미완료든 완료든 지우면 올클리어 여부가 바뀔 수 있다.
  return updateGrowth(removed.date);
}

function commit() {
  if (!saveState()) {
    showTodoError("저장에 실패했습니다. 새로고침하면 사라질 수 있어요.");
  }
  render();
}

function getTodosForDate(date) {
  return state.todos.filter((todo) => todo.date === date);
}

// 선택된 날짜 + 카테고리 필터. 미완료가 위, 완료가 아래이고 각 그룹 안에서는 추가한 순서.
function getVisibleTodos() {
  return getTodosForDate(selectedDate)
    .filter((todo) => categoryFilter === "all" || todo.category === categoryFilter)
    .sort((a, b) => Number(a.done) - Number(b.done) || a.createdAt - b.createdAt);
}

// 진행률은 필터와 상관없이 그날 전체 기준.
function getProgress(date) {
  const todos = getTodosForDate(date);
  const total = todos.length;
  const done = todos.filter((todo) => todo.done).length;
  return {
    total,
    done,
    remaining: total - done,
    percent: total === 0 ? 0 : Math.round((done / total) * 100),
  };
}

/* ===== 게임 효과 ===== */
const TOAST_DURATION = 1500;
const BANNER_DURATION = 2600;
const CONFETTI_COLORS = ["var(--gold)", "var(--accent)", "var(--cat-work-fg)", "var(--cat-personal-fg)", "var(--cat-study-fg)"];

// type: "gain" | "loss" | "info" | "warn"
function showToast(message, type, duration = TOAST_DURATION) {
  const toast = document.createElement("div");
  toast.className = `toast toast-${type}`;
  toast.textContent = message;
  document.getElementById("toast-area").append(toast);

  setTimeout(() => {
    toast.classList.add("is-leaving");
    // 애니메이션이 꺼져 있어도 반드시 지워지도록 타이머로도 제거
    toast.addEventListener("animationend", () => toast.remove(), { once: true });
    setTimeout(() => toast.remove(), 400);
  }, duration);
}

let bannerTimer = null;

function showBanner(message) {
  const banner = document.getElementById("celebration");
  document.getElementById("celebration-text").textContent = message;

  banner.querySelectorAll(".confetti").forEach((el) => el.remove());
  for (let i = 0; i < 24; i++) {
    const piece = document.createElement("span");
    piece.className = "confetti";
    piece.style.left = `${Math.random() * 100}%`;
    piece.style.background = CONFETTI_COLORS[i % CONFETTI_COLORS.length];
    piece.style.animationDelay = `${Math.random() * 0.6}s`;
    banner.append(piece);
  }

  banner.classList.remove("is-leaving");
  banner.hidden = false;
  clearTimeout(bannerTimer);
  bannerTimer = setTimeout(hideBanner, BANNER_DURATION);
}

function hideBanner() {
  const banner = document.getElementById("celebration");
  if (banner.hidden) return;
  clearTimeout(bannerTimer);
  banner.classList.add("is-leaving");
  bannerTimer = setTimeout(() => {
    banner.hidden = true;
    banner.classList.remove("is-leaving");
  }, 300);
}

function getClearDateText(date) {
  if (date === getLocalDateString()) return "오늘";
  const d = parseLocalDate(date);
  return `${d.getMonth() + 1}월 ${d.getDate()}일`;
}

// updateGrowth() 결과를 토스트·배너로 보여준다.
function showGrowthFeedback(result) {
  if (!result) return;
  const { growthChange, stageUp, pastClear, newBadges = [] } = result;

  if (pastClear) {
    showToast("지난 날짜는 올클리어해도 펫이 자라지 않아요", "info", 2500);
  }
  if (growthChange > 0) {
    const stage = getPetStage(state.pet.growth);
    const growthText = stageUp
      ? `${stage.icon} ${state.pet.name || "펫"}, ${stage.name} 단계로 성장!`
      : `오늘 올클리어! ${state.pet.name || "펫"} 성장 +1`;
    if (newBadges.length > 0) {
      // 배지가 더 드문 일이라 배너는 배지에, 성장은 토스트로
      const badge = newBadges[newBadges.length - 1];
      showBanner(`${badge.icon} 배지 획득! ${badge.name}`);
      showToast(growthText, "gain", 2500);
    } else {
      showBanner(growthText);
    }
  } else if (growthChange < 0) {
    showToast("오늘 올클리어가 풀려서 성장 -1", "loss");
  }
}

// 사용자 입력(제목)은 반드시 textContent로 넣는다. innerHTML 사용 금지.
function createTodoItem(todo) {
  const li = document.createElement("li");
  li.className = "todo-item";
  li.classList.toggle("is-done", todo.done);
  li.dataset.id = todo.id;

  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  checkbox.className = "todo-check";
  checkbox.checked = todo.done;
  checkbox.dataset.action = "toggle";
  checkbox.setAttribute("aria-label", "완료");
  if (isFutureTodo(todo)) {
    checkbox.disabled = true;
    checkbox.title = "미래 날짜의 할 일은 완료할 수 없어요";
  }
  // label로 감싸서 40×40 터치 영역을 만든다
  const checkWrap = document.createElement("label");
  checkWrap.className = "todo-check-wrap";
  checkWrap.append(checkbox);

  const title = document.createElement("span");
  title.className = "todo-title";
  title.textContent = todo.title;
  title.title = "더블클릭해서 수정";

  const badge = document.createElement("span");
  badge.className = `badge badge-${todo.category}`;
  badge.textContent = CATEGORY_LABELS[todo.category] || todo.category;

  const actions = document.createElement("div");
  actions.className = "todo-actions";
  actions.append(
    createButton("수정", "edit"),
    createButton("삭제", "delete", "btn-danger"),
  );

  li.append(checkWrap, title, badge, actions);
  return li;
}

function createButton(label, action, extraClass = "") {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = `btn btn-small ${extraClass}`.trim();
  btn.textContent = label;
  btn.dataset.action = action;
  return btn;
}

// 수정 모드 행. 값은 .value로 넣으므로 HTML로 해석되지 않는다.
function createTodoEditItem(todo) {
  const li = document.createElement("li");
  li.className = "todo-item is-editing";
  li.dataset.id = todo.id;

  const form = document.createElement("form");
  form.className = "todo-edit-form";
  form.noValidate = true;

  const input = document.createElement("input");
  input.type = "text";
  input.className = "todo-input";
  input.maxLength = TITLE_MAX_LENGTH;
  input.value = todo.title;
  input.setAttribute("aria-label", "할 일 제목 수정");

  const select = document.createElement("select");
  select.className = "todo-select";
  select.setAttribute("aria-label", "카테고리 수정");
  CATEGORIES.forEach((category) => {
    const option = document.createElement("option");
    option.value = category;
    option.textContent = CATEGORY_LABELS[category];
    select.append(option);
  });
  select.value = todo.category;

  const save = document.createElement("button");
  save.type = "submit";
  save.className = "btn btn-small btn-primary";
  save.textContent = "저장";

  form.append(input, select, save, createButton("취소", "cancel"));

  const error = document.createElement("p");
  error.className = "form-error";
  error.setAttribute("role", "alert");
  error.hidden = true;

  li.append(form, error);
  return li;
}

function renderDateBar() {
  const today = getLocalDateString();
  document.getElementById("date-label").textContent = formatDateLabel(selectedDate);
  document.getElementById("date-today").disabled = selectedDate === today;
  document.getElementById("date-note").hidden = selectedDate >= today;
}

function renderFilter() {
  document.querySelectorAll("#category-filter .filter-btn").forEach((btn) => {
    const active = btn.dataset.filter === categoryFilter;
    btn.classList.toggle("is-active", active);
    btn.setAttribute("aria-pressed", String(active));
  });
}

function getRemainingText({ total, remaining }) {
  if (total === 0) return "할 일이 없어요";
  if (total < CONFIG.MIN_TODOS_FOR_CLEAR) {
    return `올클리어는 할 일 ${CONFIG.MIN_TODOS_FOR_CLEAR}개부터 (${CONFIG.MIN_TODOS_FOR_CLEAR - total}개 더 추가)`;
  }
  if (remaining === 0) return "올클리어! 🎉";
  return `올클리어까지 ${remaining}개 남음`;
}

function renderProgress() {
  const progress = getProgress(selectedDate);
  const isClear = isAllClear(selectedDate);

  document.getElementById("progress-count").textContent =
    `${progress.done} / ${progress.total} 완료 (${progress.percent}%)`;

  const remaining = document.getElementById("progress-remaining");
  remaining.textContent = getRemainingText(progress);
  remaining.classList.toggle("is-clear", isClear);

  const fill = document.getElementById("progress-fill");
  fill.style.width = `${progress.percent}%`;
  fill.classList.toggle("is-clear", isClear);
  document.getElementById("progress-bar").setAttribute("aria-valuenow", String(progress.percent));
}

function getEmptyText() {
  if (categoryFilter !== "all" && getTodosForDate(selectedDate).length > 0) {
    return `${CATEGORY_LABELS[categoryFilter]} 할 일이 없어요`;
  }
  return selectedDate === getLocalDateString() ? "오늘 할 일을 추가해 보세요" : "이 날의 할 일을 추가해 보세요";
}

// 할 일 탭 전체(날짜 바, 진행 막대, 필터, 목록)를 다시 그린다.
function renderTodos() {
  renderDateBar();
  renderProgress();
  renderFilter();

  const list = document.getElementById("todo-list");
  const empty = document.getElementById("todo-empty");
  const todos = getVisibleTodos();

  // 수정 중이던 항목이 사라졌으면 수정 모드 해제
  if (editingId !== null && !todos.some((todo) => todo.id === editingId)) {
    editingId = null;
  }

  list.replaceChildren(
    ...todos.map((todo) => (todo.id === editingId ? createTodoEditItem(todo) : createTodoItem(todo))),
  );
  empty.textContent = getEmptyText();
  empty.hidden = todos.length > 0;

  const editInput = list.querySelector(".is-editing .todo-input");
  if (editInput) {
    editInput.focus();
    editInput.select();
  }
}

function renderPet() {
  const { pet } = state;
  const stage = getPetStage(pet.growth);
  const mood = getPetMood();
  const name = pet.name || "이름 없는 펫";

  // 헤더 요약
  document.getElementById("header-pet-icon").textContent = stage.icon;
  document.getElementById("header-pet-name").textContent = name;
  document.getElementById("header-pet-mood").textContent = mood.icon;
  document.getElementById("header-pet").title = `${name} · ${stage.name} · ${mood.label}`;

  // 펫 탭
  document.getElementById("pet-icon").textContent = stage.icon;
  document.getElementById("pet-name").textContent = name;
  document.getElementById("pet-stage").textContent = `${stage.name} 단계 · 성장 ${pet.growth}`;
  document.getElementById("pet-mood").textContent = `${mood.icon} ${mood.label} · ${mood.note}`;

  // 다음 단계까지 진행률 (현재 단계 시작점부터)
  const fill = document.getElementById("pet-progress-fill");
  const next = document.getElementById("pet-next");
  let percent = 100;
  if (stage.next) {
    percent = Math.round(((pet.growth - stage.min) / (stage.next.min - stage.min)) * 100);
    next.textContent = `${stage.next.icon} ${stage.next.name}까지 올클리어 ${stage.next.min - pet.growth}번 더`;
  } else {
    next.textContent = "최고 단계예요!";
  }
  fill.style.width = `${percent}%`;
  document.getElementById("pet-progress").setAttribute("aria-valuenow", String(percent));
}

function getStreakNote(current, today) {
  if (state.clearDates.includes(today)) return `오늘까지 ${current}일 연속 올클리어!`;
  if (current > 0) return `오늘도 올클리어하면 ${current + 1}일 연속이에요.`;
  return "오늘 올클리어하면 연속 기록이 시작돼요.";
}

function createBadgeItem(badge) {
  const owned = state.badges.includes(badge.id);
  const li = document.createElement("li");
  li.className = "badge-card";
  li.classList.toggle("is-locked", !owned);

  const icon = document.createElement("span");
  icon.className = "badge-card-icon";
  icon.setAttribute("aria-hidden", "true");
  icon.textContent = owned ? badge.icon : "🔒";

  const name = document.createElement("strong");
  name.className = "badge-card-name";
  name.textContent = badge.name;

  const condition = document.createElement("span");
  condition.className = "badge-card-condition";
  condition.textContent = owned ? "획득" : `연속 ${badge.days}일`;

  li.append(icon, name, condition);
  return li;
}

function renderStreak() {
  const today = getLocalDateString();
  const current = getCurrentStreak(state.clearDates, today);
  document.getElementById("streak-current").textContent = String(current);
  document.getElementById("streak-best").textContent = String(getBestStreak(state.clearDates));
  document.getElementById("streak-note").textContent = getStreakNote(current, today);
  document.getElementById("badge-list").replaceChildren(...STREAK_BADGES.map(createBadgeItem));
}

// 화면 전체를 다시 그린다.
function render() {
  renderTodos();
  renderPet();
  renderStreak();
}

function showTodoError(message) {
  const el = document.getElementById("todo-error");
  el.textContent = message;
  el.hidden = message === "";
}

function initTodoForm() {
  const form = document.getElementById("todo-form");
  const titleInput = document.getElementById("todo-title");
  const categorySelect = document.getElementById("todo-category");

  // form submit은 버튼 클릭과 Enter 키 모두 처리한다.
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const result = validateTitle(titleInput.value);
    showTodoError(result.error);
    if (!result.ok) {
      titleInput.focus();
      return;
    }

    if (isDayFull(selectedDate)) {
      showTodoError(`하루 할 일은 최대 ${CONFIG.MAX_TODOS_PER_DAY}개까지 추가할 수 있어요.`);
      return;
    }

    if (finishChange(addTodo(result.title, categorySelect.value))) {
      titleInput.value = "";
    }
    titleInput.focus();
  });

  titleInput.addEventListener("input", () => showTodoError(""));
}

/* ===== 펫 이름 ===== */
// required: 첫 실행처럼 이름이 꼭 필요할 때는 취소·Esc로 닫을 수 없다.
function openPetNameDialog(required) {
  const dialog = document.getElementById("pet-name-dialog");
  const input = document.getElementById("pet-name-input");
  dialog.dataset.required = String(required);
  document.getElementById("pet-name-title").textContent = required ? "펫 이름을 지어 주세요" : "펫 이름 바꾸기";
  document.getElementById("pet-name-cancel").hidden = required;
  document.getElementById("pet-name-error").hidden = true;
  input.value = state.pet.name;
  if (!dialog.open) dialog.showModal();
  input.focus();
  input.select();
}

function initPetName() {
  const dialog = document.getElementById("pet-name-dialog");
  const form = document.getElementById("pet-name-form");
  const input = document.getElementById("pet-name-input");
  const error = document.getElementById("pet-name-error");
  input.maxLength = CONFIG.PET_NAME_MAX_LENGTH;

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const result = validatePetName(input.value);
    if (!result.ok) {
      error.textContent = result.error;
      error.hidden = false;
      input.focus();
      return;
    }
    renamePet(result.name);
    commit();
    dialog.close();
  });

  input.addEventListener("input", () => {
    error.hidden = true;
  });
  document.getElementById("pet-name-cancel").addEventListener("click", () => dialog.close());
  // Esc: 이름이 꼭 필요할 때는 닫히지 않게 막는다.
  dialog.addEventListener("cancel", (e) => {
    if (dialog.dataset.required === "true") e.preventDefault();
  });

  document.getElementById("pet-rename").addEventListener("click", () => openPetNameDialog(false));
  document.getElementById("header-pet").addEventListener("click", () => switchTab("pet"));
}

function selectDate(date) {
  selectedDate = date;
  editingId = null;
  renderTodos();
}

/* ===== 날짜 바뀜 감지 ===== */
const DAY_CHECK_INTERVAL = 30 * 1000;
let lastKnownToday = getLocalDateString();

// 켜 둔 채 자정이 지나면: 오늘을 보고 있었으면 새 오늘로 옮기고,
// 다른 날짜를 보고 있었으면 그대로 두되 "오늘" 버튼·체크 가능 여부 등을 다시 그린다.
function checkDayChange() {
  const today = getLocalDateString();
  if (today === lastKnownToday) return;
  // 수정 중이면 입력이 날아가지 않게 다음 확인 때로 미룬다.
  if (editingId !== null) return;

  if (selectedDate === lastKnownToday) {
    selectedDate = today;
  }
  lastKnownToday = today;
  render(); // 날짜가 바뀌면 펫 기분도 바뀐다
}

function initDayWatcher() {
  setInterval(checkDayChange, DAY_CHECK_INTERVAL);
  // 절전 등으로 타이머가 멈췄다 돌아오는 경우
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) checkDayChange();
  });
  window.addEventListener("focus", checkDayChange);
}

function initDateBar() {
  document.getElementById("date-prev").addEventListener("click", () => selectDate(addDays(selectedDate, -1)));
  document.getElementById("date-next").addEventListener("click", () => selectDate(addDays(selectedDate, 1)));
  document.getElementById("date-today").addEventListener("click", () => selectDate(getLocalDateString()));
}

function initFilter() {
  document.getElementById("category-filter").addEventListener("click", (e) => {
    const btn = e.target.closest(".filter-btn");
    if (!btn) return;
    categoryFilter = btn.dataset.filter;
    // 필터를 고르면 추가 칸의 카테고리도 맞춰서, 새로 추가한 항목이 바로 보이게 한다.
    if (categoryFilter !== "all") {
      document.getElementById("todo-category").value = categoryFilter;
    }
    renderTodos();
  });
}

// 변경 함수의 결과를 마무리한다: 성공이면 저장·다시 그리기·효과, 실패(null)면 화면만 원래대로.
function finishChange(result) {
  if (!result) {
    renderTodos(); // 막힌 체크박스 등을 원래 상태로
    return false;
  }
  commit();
  showGrowthFeedback(result);
  return true;
}

function startEditing(id) {
  editingId = id;
  renderTodos();
}

function stopEditing() {
  editingId = null;
  renderTodos();
}

// 목록은 매번 다시 그려지므로 이벤트는 목록(ul)에 위임한다.
function initTodoList() {
  const list = document.getElementById("todo-list");
  const getId = (el) => el.closest(".todo-item")?.dataset.id;

  list.addEventListener("change", (e) => {
    if (e.target.dataset.action !== "toggle") return;
    finishChange(setTodoDone(getId(e.target), e.target.checked));
  });

  list.addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-action]");
    if (!btn) return;
    const id = getId(btn);

    if (btn.dataset.action === "edit") {
      startEditing(id);
    } else if (btn.dataset.action === "cancel") {
      stopEditing();
    } else if (btn.dataset.action === "delete") {
      const todo = findTodo(id);
      // confirm()은 일반 텍스트로만 표시되므로 제목을 넣어도 안전하다.
      if (todo && confirm(`"${todo.title}" 할 일을 삭제할까요?`)) {
        finishChange(deleteTodo(id));
      }
    }
  });

  list.addEventListener("dblclick", (e) => {
    if (e.target.closest(".todo-title")) {
      startEditing(getId(e.target));
    }
  });

  // Enter: 제목 입력란에서 누르면 form이 submit된다.
  list.addEventListener("submit", (e) => {
    if (!e.target.matches(".todo-edit-form")) return;
    e.preventDefault();
    const form = e.target;
    const result = validateTitle(form.querySelector(".todo-input").value);
    if (!result.ok) {
      const error = form.parentElement.querySelector(".form-error");
      error.textContent = result.error || "제목을 입력해 주세요.";
      error.hidden = false;
      form.querySelector(".todo-input").focus();
      return;
    }
    updateTodo(editingId, result.title, form.querySelector(".todo-select").value);
    editingId = null;
    commit();
  });

  list.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && e.target.closest(".todo-edit-form")) {
      e.preventDefault();
      stopEditing();
    }
  });
}

/* ===== 탭 ===== */
function switchTab(name) {
  document.querySelectorAll(".tab").forEach((tab) => {
    const active = tab.dataset.tab === name;
    tab.classList.toggle("is-active", active);
    tab.setAttribute("aria-selected", String(active));
    tab.tabIndex = active ? 0 : -1;
  });
  document.querySelectorAll(".panel").forEach((panel) => {
    panel.hidden = panel.id !== `panel-${name}`;
  });
}

function initTabs() {
  const tabs = Array.from(document.querySelectorAll(".tab"));

  tabs.forEach((tab, index) => {
    tab.addEventListener("click", () => switchTab(tab.dataset.tab));

    // 좌우 화살표로 탭 이동
    tab.addEventListener("keydown", (e) => {
      if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
      const step = e.key === "ArrowRight" ? 1 : -1;
      const next = tabs[(index + step + tabs.length) % tabs.length];
      switchTab(next.dataset.tab);
      next.focus();
    });
  });
}

/* ===== 시작 ===== */
function init() {
  initTabs();
  initDateBar();
  initFilter();
  initTodoForm();
  initTodoList();
  initPetName();
  initDayWatcher();
  document.getElementById("celebration").addEventListener("click", hideBanner);

  // 다른 브라우저 탭에서 저장하면 그 내용을 다시 읽는다. 안 그러면 이 탭이 다음에 저장할 때 덮어쓴다.
  window.addEventListener("storage", (e) => {
    if (e.key !== STORAGE_KEY) return;
    state = loadState();
    render();
    // 다른 탭에서 이름을 지었으면 이 탭의 "이름 짓기" 창은 닫는다.
    const dialog = document.getElementById("pet-name-dialog");
    if (state.pet.name && dialog.open && dialog.dataset.required === "true") dialog.close();
  });

  // v1에서 옮겨 온 기록처럼 이미 배지 조건을 채운 경우 조용히 배지를 맞춰 둔다.
  if (syncBadges().length > 0) saveState();

  render();
  if (!state.pet.name) {
    openPetNameDialog(true); // 처음 실행(또는 v1에서 옮겨 온 직후)에는 이름부터 짓는다
  }
}

init();
