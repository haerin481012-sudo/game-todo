"use strict";

/*
 * 날짜 문자열 유틸 + 연속 달성(스트릭)·배지 계산.
 * DOM과 저장소를 쓰지 않는 순수 함수만 둔다. app.js와 tests/streak.test.html이 함께 쓴다.
 * 날짜는 모두 로컬 기준 "YYYY-MM-DD" 문자열. toISOString()은 UTC라 날짜가 밀리므로 쓰지 않는다.
 */

/* ===== 날짜 유틸 ===== */
// 로컬 시간 기준 "YYYY-MM-DD".
function getLocalDateString(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

// "YYYY-MM-DD"를 로컬 자정의 Date로. new Date("YYYY-MM-DD")는 UTC로 해석되므로 쓰지 않는다.
function parseLocalDate(dateString) {
  const [y, m, d] = dateString.split("-").map(Number);
  return new Date(y, m - 1, d);
}

// 월말·연말·윤년·서머타임은 setDate(로컬 달력 기준)가 알아서 처리한다.
function addDays(dateString, days) {
  const date = parseLocalDate(dateString);
  date.setDate(date.getDate() + days);
  return getLocalDateString(date);
}

/* ===== 달력 ===== */
// "YYYY-MM"에서 months달 이동한 "YYYY-MM".
function addMonths(monthString, months) {
  const [y, m] = monthString.split("-").map(Number);
  const date = new Date(y, m - 1 + months, 1);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

// 월간 달력 칸 (일요일 시작). 첫 주 앞의 빈칸은 null, 이어서 그 달의 "YYYY-MM-DD".
function getCalendarCells(monthString) {
  const [y, m] = monthString.split("-").map(Number);
  const leadingBlanks = new Date(y, m - 1, 1).getDay();
  const daysInMonth = new Date(y, m, 0).getDate(); // 다음 달 0일 = 이번 달 마지막 날
  const cells = Array(leadingBlanks).fill(null);
  for (let day = 1; day <= daysInMonth; day++) {
    cells.push(`${monthString}-${String(day).padStart(2, "0")}`);
  }
  return cells;
}

/* ===== 연속 달성 ===== */
const STREAK_BADGES = Object.freeze([
  { id: "streak-3", days: 3, name: "불꽃 시작", icon: "🔥" },
  { id: "streak-7", days: 7, name: "일주일 챔피언", icon: "🏆" },
  { id: "streak-14", days: 14, name: "꾸준함의 달인", icon: "💎" },
  { id: "streak-30", days: 30, name: "한 달의 전설", icon: "👑" },
]);

/*
 * 현재 연속 일수: 오늘 올클리어했으면 오늘부터, 아직 못 했으면 어제부터 거꾸로 이어진 날 수.
 * (오늘은 아직 끝나지 않았으므로 오늘 미완료만으로 연속이 끊기지 않는다.)
 */
function getCurrentStreak(clearDates, today) {
  const cleared = new Set(clearDates);
  let day = cleared.has(today) ? today : addDays(today, -1);
  let count = 0;
  while (cleared.has(day)) {
    count += 1;
    day = addDays(day, -1);
  }
  return count;
}

// 최고 연속 기록: 기록 전체에서 하루씩 이어진 가장 긴 구간의 길이.
function getBestStreak(clearDates) {
  const days = [...new Set(clearDates)].sort();
  let best = 0;
  let run = 0;
  days.forEach((day, i) => {
    run = i > 0 && addDays(days[i - 1], 1) === day ? run + 1 : 1;
    best = Math.max(best, run);
  });
  return best;
}

// 최고 연속 기록으로 받을 수 있는 배지 id (STREAK_BADGES 순서).
function getEarnedBadgeIds(bestStreak) {
  return STREAK_BADGES.filter((badge) => bestStreak >= badge.days).map((badge) => badge.id);
}

/*
 * 이미 받은 배지에 새로 받을 배지를 더한다. 한 번 받은 배지는 연속이 끊겨도 빼지 않는다.
 * 반환값: { badges: 합친 id 목록, newlyEarned: 이번에 새로 받은 배지 객체 목록 }
 */
function mergeBadges(ownedIds, bestStreak) {
  const owned = new Set(ownedIds);
  const newlyEarned = STREAK_BADGES.filter((badge) => bestStreak >= badge.days && !owned.has(badge.id));
  return {
    badges: [...ownedIds, ...newlyEarned.map((badge) => badge.id)],
    newlyEarned,
  };
}
