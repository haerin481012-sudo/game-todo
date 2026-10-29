# Quest To-do

할 일을 관리하고 매일 올클리어를 이어 가는 게임형 할 일 관리 웹앱입니다.

> **개편 중 (`feature/pet-streak` 브랜치):** 보상 구조를 포인트·상점에서 **펫 키우기 + 연속 달성 달력**으로 바꾸고 있습니다. 포인트·상점·구매 내역은 제거했고, 펫·달력·배지 화면은 다음 단계에서 추가합니다.

HTML · CSS · 순수 JavaScript만 사용합니다. 프레임워크, 빌드 도구, 외부 라이브러리, 서버, 외부 폰트가 없습니다.

## 실행 방법

`index.html`을 더블클릭하면 브라우저에서 바로 실행됩니다. 설치나 빌드는 필요 없습니다.

- Chrome 또는 Edge를 권장합니다.
- Firefox는 설정에 따라 `file://`로 연 페이지에서 저장이 되지 않을 수 있습니다.

## 기능

### 할 일
- 제목(앞뒤 공백 제거 후 1~50자)과 카테고리(업무 / 개인 / 공부)로 추가합니다. Enter 키로도 추가됩니다.
- 체크박스로 완료하고 해제합니다. 완료한 항목은 취소선이 그어지고 목록 아래로 내려갑니다.
- 수정 버튼을 누르거나 제목을 더블클릭하면 제목과 카테고리를 바꿀 수 있습니다. Enter로 저장, Esc로 취소합니다.
- 삭제할 때는 확인 창이 뜹니다.
- ◀ ▶ 버튼으로 날짜를 이동하고, "오늘" 버튼으로 돌아옵니다. 미래 날짜의 할 일은 체크할 수 없습니다.
- 카테고리 필터: 전체 / 업무 / 개인 / 공부
- 진행 막대에는 그날 전체(필터와 무관)의 완료 수, 퍼센트, 올클리어까지 남은 개수가 표시됩니다.
- 앱을 켜 둔 채 자정이 지나면 오늘 화면이 새 날짜로 넘어갑니다.

### 게임 효과
- 올클리어하면 축하 배너와 색종이가 나오고, 올클리어가 풀리면 토스트로 알려 줍니다.
- OS에서 "애니메이션 줄이기"를 켜 두면 움직임이 꺼집니다.

## 올클리어 규칙

- **올클리어:** 그날 대상 할 일(기록용 제외)이 3개 이상이고, 그날 할 일(기록용 포함)이 모두 완료된 상태입니다.
- 올클리어한 날짜는 `clearDates`에 기록됩니다. 해제, 미완료 항목 추가, 완료 항목 삭제로 올클리어가 깨지면 그 날짜가 빠지고, 다시 올클리어하면 다시 들어갑니다.
- 지난 날짜에도 같은 규칙이 적용됩니다.
- **기록용 할 일:** 그 날짜가 지난 뒤에 만든 할 일은 "기록용"으로 표시되고, 올클리어 최소 개수에 들어가지 않습니다. 지난 날짜에 할 일을 몰아 넣어 올클리어를 채우는 것을 막기 위해서입니다.

## 데이터 저장

모든 데이터는 브라우저의 `localStorage`에 저장됩니다. 서버로 전송되지 않습니다. 브라우저나 기기마다 데이터가 따로 저장되고, 브라우저 데이터를 지우면 함께 사라집니다.

| 키 | 내용 |
|---|---|
| `gameTodo.v2` | 전체 상태 (JSON) |
| `gameTodo.backup` | 읽을 수 없었던 v2 저장값의 원본 (가장 최근 1개) |
| `gameTodo.v1` | 이전 버전(포인트·상점) 데이터. 읽기만 하고 지우지 않습니다 |
| `gameTodo.v1.backup` | v1 → v2 변환 직전에 복사해 둔 v1 원본 |

```js
// gameTodo.v2
{
  version: 2,
  todos: [{ id, title, category, date, done, createdAt, completedAt }],
  clearDates: ["YYYY-MM-DD"],                     // 올클리어한 날짜 (오름차순)
  pet: { name: "", growth: 0, createdAt: "YYYY-MM-DD" },
  badges: []                                      // 받은 배지 id
}
```

- `category`: `"work"` | `"personal"` | `"study"`
- `date`, `pet.createdAt`: 로컬 날짜 `"YYYY-MM-DD"`. UTC 기준인 `toISOString()`은 사용하지 않습니다.
- `createdAt`, `completedAt`: 밀리초 타임스탬프. 완료 전의 `completedAt`은 `null`입니다.
- 선택한 날짜와 필터는 저장하지 않습니다. 새로고침하면 오늘, 전체로 돌아갑니다.
- 브라우저 탭을 여러 개 열어도 다른 탭에서 저장한 내용을 바로 반영해서 서로 덮어쓰지 않습니다.

### v1에서 옮기기
앱을 시작할 때 `gameTodo.v2`가 없고 `gameTodo.v1`이 있으면 한 번 변환합니다.

1. v1 원본 문자열을 `gameTodo.v1.backup`에 그대로 복사합니다. `gameTodo.v1`은 지우지 않습니다.
2. `todos`는 그대로 옮깁니다(형식이 잘못된 항목만 제외).
3. `bonusDates`를 `clearDates`로 옮기고, `pet.growth`는 `clearDates` 개수로 시작합니다.
4. `points`, `purchases`는 옮기지 않습니다.
5. 결과를 바로 `gameTodo.v2`에 저장합니다. 다음부터는 v2만 읽습니다.

v1 JSON이 깨졌거나 v1 형식이 아니면 빈 v2로 시작합니다. 이때도 원본은 백업과 v1 키에 남아 있습니다.

### 저장값에 문제가 있을 때
- (v2) JSON이 깨졌거나, 지원하지 않는 버전이거나, 형식이 잘못된 항목이 섞여 있으면 원본을 `gameTodo.backup`에 남긴 뒤 시작합니다.
- 일부 항목만 잘못된 경우에는 정상 항목은 그대로 쓰고 잘못된 항목만 건너뜁니다.
- 모든 localStorage 접근은 try/catch로 감싸져 있어서, 저장소가 막혀 있어도 오류 없이 빈 상태로 시작합니다.
- 백업은 개발자 도구(F12) → Application → Local Storage에서 볼 수 있습니다.

## 파일 구조

```
game-todo/
├── index.html   화면 구조 (헤더, 탭, 할 일 패널, 토스트·배너 영역)
├── style.css    스타일. 색상은 :root의 CSS 변수로 관리
├── app.js       상태, 저장·변환, 올클리어 규칙, 렌더링, 이벤트
└── README.md
```

## 수정 가이드

### 설정값 바꾸기 (`app.js` 위쪽)
- `CONFIG.MIN_TODOS_FOR_CLEAR`: 올클리어로 인정하는 최소 할 일 수
- `CATEGORY_LABELS`: 카테고리 표시 이름
- 색상: `style.css`의 `:root` 변수. 카테고리 색은 `--cat-*` 변수입니다.

### 코드 구조
- **저장소 접근:** `readStorage()` / `writeStorage()`만 사용합니다. 둘 다 예외를 잡습니다.
- **불러오기:** `loadState()` → (v2 있음) `migrateState()` → `normalizeState()` / (v1만 있음) `migrateFromV1()` → `convertV1ToV2()`
- **올클리어 판정:** `updateClearDate()` 한 곳에서 `clearDates`를 갱신합니다. 할 일 상태를 바꾼 뒤에 호출합니다.
- **상태 변경 함수:** `addTodo`, `setTodoDone`, `deleteTodo`는 `state`만 바꾸고 `updateClearDate()` 결과를 돌려줍니다. `finishChange()`가 저장(`commit()`)과 효과 표시를 마무리합니다.
- **보안:** 사용자 입력은 항상 `textContent` 또는 `.value`로 넣습니다. `innerHTML`은 쓰지 않습니다.

### 저장 형식을 바꿀 때
1. `STATE_VERSION`을 올립니다.
2. `MIGRATIONS`에 "이전 버전 → 다음 버전" 변환 함수를 추가합니다.
   ```js
   const MIGRATIONS = {
     2: (s) => ({ ...s, version: 3, streak: 0 }),
   };
   ```
3. 필요하면 `normalizeState()`와 검사 함수(`isValidTodo` 등)를 새 형식에 맞춥니다.

같은 키 안의 버전 변환은 `MIGRATIONS`가 맡습니다. 변환 함수가 없으면 옛 데이터는 백업된 뒤 초기 상태로 시작합니다. (v1 → v2는 저장 키까지 바뀌므로 `migrateFromV1()`이 따로 처리합니다.)
