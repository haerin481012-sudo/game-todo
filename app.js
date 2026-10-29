"use strict";

/* ===== 설정 ===== */
const CONFIG = Object.freeze({
  POINTS_PER_TODO: 10,
  ALL_CLEAR_BONUS: 50,
  MIN_TODOS_FOR_BONUS: 3,
});

const STORAGE_KEY = "gameTodo.v1";
// 읽을 수 없는 저장값은 지우기 전에 여기에 한 벌 남겨 둔다 (가장 최근 것만).
const BACKUP_KEY = "gameTodo.backup";
const STATE_VERSION = 1;

/*
 * 저장 형식 변환. 키는 "변환 전 버전", 값은 그 버전의 상태를 다음 버전으로 바꾸는 함수.
 * 상태 구조를 바꿀 때는 STATE_VERSION을 올리고 여기에 변환 함수를 추가한다. 예:
 *   1: (s) => ({ ...s, version: 2, streak: 0 }),
 */
const MIGRATIONS = {};
const CATEGORIES = ["work", "personal", "study"];
const CATEGORY_LABELS = { work: "업무", personal: "개인", study: "공부" };
const TITLE_MAX_LENGTH = 50;

// 상점 상품 (저장하지 않음). 구매 내역에는 구매 당시의 name/price를 따로 남긴다.
const SHOP_ITEMS = Object.freeze([
  { id: "triangle-kimbap", name: "삼각김밥", price: 200, icon: "🍙" },
  { id: "americano", name: "아메리카노", price: 500, icon: "☕" },
  { id: "ice-cream", name: "아이스크림", price: 800, icon: "🍦" },
  { id: "burger-set", name: "버거 세트", price: 1500, icon: "🍔" },
  { id: "movie-ticket", name: "영화 관람권", price: 3000, icon: "🎬" },
]);

const COUPON_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

/*
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

/* ===== 날짜 유틸 ===== */
// 로컬 시간 기준 "YYYY-MM-DD". toISOString()은 UTC라 한국 시간 오전 9시 이전엔 전날로 밀린다.
function getLocalDateString(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

const WEEKDAYS = ["일", "월", "화", "수", "목", "금", "토"];

// "YYYY-MM-DD"를 로컬 자정의 Date로. new Date("YYYY-MM-DD")는 UTC로 해석되므로 쓰지 않는다.
function parseLocalDate(dateString) {
  const [y, m, d] = dateString.split("-").map(Number);
  return new Date(y, m - 1, d);
}

// 월말·연말도 setDate가 알아서 넘겨준다.
function addDays(dateString, days) {
  const date = parseLocalDate(dateString);
  date.setDate(date.getDate() + days);
  return getLocalDateString(date);
}

// "2026-10-29(목)"
function formatDateLabel(dateString) {
  return `${dateString}(${WEEKDAYS[parseLocalDate(dateString).getDay()]})`;
}

// "2026-10-29 14:05" (로컬 시간)
function formatDateTime(timestamp) {
  const date = new Date(timestamp);
  const h = String(date.getHours()).padStart(2, "0");
  const min = String(date.getMinutes()).padStart(2, "0");
  return `${getLocalDateString(date)} ${h}:${min}`;
}

// 받침 유무로 "을"/"를" 선택. 한글이 아니면 "을(를)".
function withObjectParticle(word) {
  const code = word.charCodeAt(word.length - 1) - 0xac00;
  if (code < 0 || code > 11171) return `${word}을(를)`;
  return word + (code % 28 === 0 ? "를" : "을");
}

// 1500 → "1,500P"
function formatPoints(points) {
  return `${points.toLocaleString("ko-KR")}P`;
}

/* ===== 상태 ===== */
function createInitialState() {
  return {
    version: STATE_VERSION,
    points: 0,
    todos: [],
    bonusDates: [],
    purchases: [],
  };
}

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

const isObject = (value) => value !== null && typeof value === "object";

function isValidTodo(todo) {
  return isObject(todo)
    && typeof todo.id === "string"
    && typeof todo.title === "string"
    && CATEGORIES.includes(todo.category)
    && typeof todo.date === "string" && DATE_PATTERN.test(todo.date)
    && typeof todo.done === "boolean"
    && Number.isFinite(todo.createdAt);
}

function isValidPurchase(purchase) {
  return isObject(purchase)
    && typeof purchase.id === "string"
    && typeof purchase.name === "string"
    && Number.isFinite(purchase.price)
    && typeof purchase.code === "string"
    && Number.isFinite(purchase.purchasedAt);
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

// 현재 버전 형태인지 확인하고, 빠지거나 잘못된 값은 기본값으로 바꾸거나 버린다.
function normalizeState(raw, problems = []) {
  const todos = keepValid(raw.todos, isValidTodo, "할 일", problems).map((todo) => ({
    ...todo,
    completedAt: todo.done && Number.isFinite(todo.completedAt) ? todo.completedAt : null,
  }));
  const isDate = (d) => typeof d === "string" && DATE_PATTERN.test(d);
  const bonusDates = [...new Set(keepValid(raw.bonusDates, isDate, "보너스 날짜", problems))];
  return {
    version: STATE_VERSION,
    points: Number.isFinite(raw.points) ? Math.max(0, raw.points) : 0,
    todos,
    bonusDates,
    purchases: keepValid(raw.purchases, isValidPurchase, "구매 내역", problems),
  };
}

// 다음 저장 때 덮어써지기 전에 원본 문자열을 백업 키에 남긴다.
function backupRawState(json, reason) {
  console.warn(`저장 데이터 문제(${reason}). 원본을 localStorage "${BACKUP_KEY}"에 백업합니다.`);
  try {
    localStorage.setItem(BACKUP_KEY, JSON.stringify({ backedUpAt: Date.now(), reason, data: json }));
  } catch (err) {
    console.error("백업에 실패했습니다.", err);
  }
}

function loadState() {
  let json;
  try {
    json = localStorage.getItem(STORAGE_KEY);
  } catch (err) {
    console.error("저장소를 읽을 수 없어 초기 상태로 시작합니다.", err);
    return createInitialState();
  }
  if (json === null) {
    return createInitialState();
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
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    return true;
  } catch (err) {
    console.error("상태를 저장하지 못했습니다.", err);
    return false;
  }
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

/* ===== 포인트 ===== */
// 포인트 대상 할 일이 3개 이상이고, 그날 할 일(기록용 포함)이 모두 완료.
function isAllClear(date) {
  const { rewardable, remaining } = getProgress(date);
  return rewardable >= CONFIG.MIN_TODOS_FOR_BONUS && remaining === 0;
}

/*
 * 모든 포인트 변경은 이 함수에서만 한다. 할 일 상태를 바꾼 "뒤에" 호출한다.
 * - doneDelta: 이번 변경으로 늘어난(+1) / 줄어든(-1) 포인트 대상 완료 항목 수 → ±POINTS_PER_TODO
 * - 그날의 올클리어 여부를 다시 확인해서, 새로 달성하면 보너스 지급 + bonusDates에 추가,
 *   깨졌으면 보너스 회수 + bonusDates에서 제거. bonusDates가 중복 지급을 막는다.
 * - 포인트는 0 밑으로 내려가지 않는다. 회수할 포인트가 모자라면 포인트는 건드리지 않고
 *   shortage(모자란 양)를 돌려준다. 호출한 쪽이 tryChange()로 변경 전체를 되돌린다.
 * 반환값: { date, doneDelta, bonusChange: 1 | -1 | 0, shortage }
 */
function settlePoints(date, doneDelta) {
  let delta = doneDelta * CONFIG.POINTS_PER_TODO;
  let bonusChange = 0;

  const allClear = isAllClear(date);
  const hasBonus = state.bonusDates.includes(date);
  if (allClear && !hasBonus) {
    delta += CONFIG.ALL_CLEAR_BONUS;
    state.bonusDates.push(date);
    bonusChange = 1;
  } else if (!allClear && hasBonus) {
    delta -= CONFIG.ALL_CLEAR_BONUS;
    state.bonusDates = state.bonusDates.filter((d) => d !== date);
    bonusChange = -1;
  }

  const next = state.points + delta;
  if (next < 0) {
    return { date, doneDelta, bonusChange, shortage: -next };
  }
  state.points = next;
  return { date, doneDelta, bonusChange, shortage: 0 };
}

// 변경을 적용해 보고, 포인트가 모자라 회수할 수 없으면 state를 통째로 되돌린다.
// 회수를 건너뛰고 진행하면 "해제 → 다시 완료"로 포인트를 계속 얻을 수 있기 때문.
function tryChange(change) {
  const snapshot = structuredClone(state);
  const result = change();
  if (result?.shortage > 0) {
    state = snapshot;
  }
  return result;
}

/* 아래 변경 함수들은 state(포인트 포함)만 바꾼다. 저장과 다시 그리기는 commit()이 맡는다.
 * 실패하면 null, 성공하면 settlePoints()의 결과를 돌려준다. */

function addTodo(title, category) {
  state.todos.push({
    id: generateId(),
    title,
    category: normalizeCategory(category),
    date: selectedDate,
    done: false,
    createdAt: Date.now(),
    completedAt: null,
  });
  return settlePoints(selectedDate, 0); // 미완료 항목이 늘어 올클리어가 깨질 수 있다
}

function setTodoDone(id, done) {
  const todo = findTodo(id);
  if (!todo || isFutureTodo(todo) || todo.done === done) return null;
  todo.done = done;
  todo.completedAt = done ? Date.now() : null;
  const rewardable = isRewardable(todo);
  const settled = settlePoints(todo.date, rewardable ? (done ? 1 : -1) : 0);
  return { ...settled, recordOnly: done && !rewardable };
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
  // 완료 항목이면 받은 포인트 회수. 미완료든 완료든 올클리어 여부가 바뀔 수 있다.
  return settlePoints(removed.date, removed.done && isRewardable(removed) ? -1 : 0);
}

/* ===== 상점 ===== */
function findShopItem(itemId) {
  return SHOP_ITEMS.find((item) => item.id === itemId);
}

function randomChars(length) {
  // 36의 배수(252) 이상인 값은 버려서 글자마다 확률이 같게 한다.
  let result = "";
  const buf = new Uint8Array(1);
  while (result.length < length) {
    crypto.getRandomValues(buf);
    if (buf[0] < 252) result += COUPON_CHARS[buf[0] % COUPON_CHARS.length];
  }
  return result;
}

// "GIFT-XXXX-XXXX". 기존 구매 내역과 겹치면 다시 만든다.
function generateCouponCode() {
  let code;
  do {
    code = `GIFT-${randomChars(4)}-${randomChars(4)}`;
  } while (state.purchases.some((p) => p.code === code));
  return code;
}

// 포인트가 충분하면 차감하고 구매 기록을 남긴다. 실패하면 null.
function purchaseItem(itemId) {
  const item = findShopItem(itemId);
  if (!item || state.points < item.price) return null;

  state.points -= item.price;
  const purchase = {
    id: generateId(),
    itemId: item.id,
    name: item.name,
    price: item.price,
    code: generateCouponCode(),
    purchasedAt: Date.now(),
  };
  state.purchases.push(purchase);
  return purchase;
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

// 그 날짜가 지난 뒤에 만든 할 일은 기록용이라 포인트·보너스 대상이 아니다.
// (그날 또는 미리 만들어 둔 할 일은 나중에 완료해도 포인트를 받는다.)
function isRewardable(todo) {
  return getLocalDateString(new Date(todo.createdAt)) <= todo.date;
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
    rewardable: todos.filter(isRewardable).length,
    percent: total === 0 ? 0 : Math.round((done / total) * 100),
  };
}

/* ===== 렌더링 ===== */
let renderedPoints = null; // 직전에 그린 포인트. 처음 그릴 때는 애니메이션 없음.

function renderPoints() {
  const el = document.getElementById("points-value");
  el.textContent = state.points.toLocaleString("ko-KR");

  if (renderedPoints !== null && renderedPoints !== state.points) {
    el.classList.remove("is-up", "is-down");
    void el.offsetWidth; // 클래스를 다시 붙여도 애니메이션이 처음부터 재생되게
    el.classList.add(state.points > renderedPoints ? "is-up" : "is-down");
  }
  renderedPoints = state.points;
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

// settlePoints() 결과를 토스트·배너로 보여준다.
function showPointFeedback(result) {
  if (!result) return;
  const { date, doneDelta, bonusChange, recordOnly } = result;

  if (recordOnly) {
    showToast("기록용 할 일이라 포인트는 없어요", "info");
  }
  if (doneDelta !== 0) {
    const amount = Math.abs(doneDelta) * CONFIG.POINTS_PER_TODO;
    showToast(doneDelta > 0 ? `+${amount}P` : `-${amount}P`, doneDelta > 0 ? "gain" : "loss");
  }
  if (bonusChange > 0) {
    showBanner(`${getClearDateText(date)} 올클리어! +${CONFIG.ALL_CLEAR_BONUS}P`);
  } else if (bonusChange < 0) {
    showToast(`올클리어 보너스 -${CONFIG.ALL_CLEAR_BONUS}P`, "loss");
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

  li.append(checkWrap, title, badge);
  if (!isRewardable(todo)) {
    const recordTag = document.createElement("span");
    recordTag.className = "badge badge-record";
    recordTag.textContent = "기록용";
    recordTag.title = "날짜가 지난 뒤에 만든 할 일이라 포인트가 없어요";
    li.append(recordTag);
  }
  li.append(actions);
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

function getRemainingText({ total, remaining, rewardable }, date) {
  if (total === 0) return "할 일이 없어요";
  if (rewardable < CONFIG.MIN_TODOS_FOR_BONUS) {
    // 지난 날짜에 새로 추가하는 할 일은 기록용이라 더 추가해도 보너스 조건을 채울 수 없다.
    if (date < getLocalDateString()) return "올클리어 보너스 대상이 아닌 날이에요";
    return `올클리어는 할 일 ${CONFIG.MIN_TODOS_FOR_BONUS}개부터 (${CONFIG.MIN_TODOS_FOR_BONUS - rewardable}개 더 추가)`;
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
  remaining.textContent = getRemainingText(progress, selectedDate);
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

function createShopCard(item) {
  const card = document.createElement("div");
  card.className = "shop-card";

  const icon = document.createElement("span");
  icon.className = "shop-icon";
  icon.setAttribute("aria-hidden", "true");
  icon.textContent = item.icon;

  const name = document.createElement("span");
  name.className = "shop-name";
  name.textContent = item.name;

  const price = document.createElement("span");
  price.className = "shop-price";
  price.textContent = formatPoints(item.price);

  const lack = item.price - state.points;
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "btn btn-primary";
  btn.textContent = "구매";
  btn.dataset.itemId = item.id;
  btn.disabled = lack > 0;

  const lackText = document.createElement("p");
  lackText.className = "shop-lack";
  lackText.textContent = lack > 0 ? `${formatPoints(lack)} 부족` : "";

  card.append(icon, name, price, btn, lackText);
  return card;
}

function renderShop() {
  document.getElementById("shop-grid").replaceChildren(...SHOP_ITEMS.map(createShopCard));
}

function createHistoryItem(purchase) {
  const li = document.createElement("li");
  li.className = "history-item";

  const icon = document.createElement("span");
  icon.className = "history-icon";
  icon.setAttribute("aria-hidden", "true");
  icon.textContent = findShopItem(purchase.itemId)?.icon ?? "🎁";

  const name = document.createElement("span");
  name.className = "history-name";
  name.textContent = purchase.name;

  const price = document.createElement("span");
  price.className = "history-price";
  price.textContent = `-${formatPoints(purchase.price)}`;

  const date = document.createElement("span");
  date.className = "history-date";
  date.textContent = formatDateTime(purchase.purchasedAt);

  const code = document.createElement("span");
  code.className = "history-code";
  code.textContent = purchase.code;

  li.append(icon, name, price, date, code);
  return li;
}

function renderHistory() {
  // 뒤집은 뒤 안정 정렬 → 같은 시각(ms)에 산 것도 나중에 산 것이 위로.
  const purchases = [...state.purchases].reverse().sort((a, b) => b.purchasedAt - a.purchasedAt);
  document.getElementById("history-list").replaceChildren(...purchases.map(createHistoryItem));
  document.getElementById("history-empty").hidden = purchases.length > 0;
}

function showCouponDialog(purchase) {
  document.getElementById("coupon-icon").textContent = findShopItem(purchase.itemId)?.icon ?? "🎁";
  document.getElementById("coupon-item").textContent = `${purchase.name} · ${formatPoints(purchase.price)} 사용`;
  document.getElementById("coupon-code").textContent = purchase.code;
  document.getElementById("coupon-dialog").showModal();
}

function render() {
  renderPoints();
  renderTodos();
  renderShop();
  renderHistory();
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

    const settled = tryChange(() => addTodo(result.title, categorySelect.value));
    if (finishChange(settled, (lack) => `올클리어 보너스를 돌려줄 포인트가 ${lack} 부족해서 추가할 수 없어요`)) {
      titleInput.value = "";
    }
    titleInput.focus();
  });

  titleInput.addEventListener("input", () => showTodoError(""));
}

function initShop() {
  document.getElementById("shop-grid").addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-item-id]");
    if (!btn) return;
    const item = findShopItem(btn.dataset.itemId);
    if (!item) return;
    if (!confirm(`${withObjectParticle(item.name)} ${formatPoints(item.price)}로 구매할까요?`)) return;

    const purchase = purchaseItem(item.id);
    if (!purchase) {
      alert("포인트가 부족해요.");
      render();
      return;
    }
    commit();
    showCouponDialog(purchase);
  });
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
  renderTodos();
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

// tryChange() 결과를 마무리한다: 성공이면 저장·다시 그리기·효과, 포인트 부족이면 안내만.
// blockedMessage(모자란 포인트 문자열) → 안내 문구
function finishChange(settled, blockedMessage) {
  if (!settled) {
    renderTodos();
    return false;
  }
  if (settled.shortage > 0) {
    showToast(blockedMessage(formatPoints(settled.shortage)), "warn", 2500);
    renderTodos(); // 체크박스 등 화면을 원래 상태로
    return false;
  }
  commit();
  showPointFeedback(settled);
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
    const settled = tryChange(() => setTodoDone(getId(e.target), e.target.checked));
    finishChange(settled, (lack) => `포인트가 ${lack} 부족해서 완료를 해제할 수 없어요`);
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
        const settled = tryChange(() => deleteTodo(id));
        finishChange(settled, (lack) => `포인트가 ${lack} 부족해서 삭제할 수 없어요`);
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
  initShop();
  initDayWatcher();
  document.getElementById("celebration").addEventListener("click", hideBanner);

  // 다른 브라우저 탭에서 저장하면 그 내용을 다시 읽는다. 안 그러면 이 탭이 다음에 저장할 때 덮어쓴다.
  window.addEventListener("storage", (e) => {
    if (e.key !== STORAGE_KEY) return;
    state = loadState();
    render();
  });

  render();
}

init();
