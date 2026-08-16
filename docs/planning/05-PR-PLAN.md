# 05 — PR 계획

티어 M. PR 4개, 전부 SEQUENTIAL. 세 PR이 `src/server/admin.ts`를 공유하므로 병렬 실행하지
않는다 (File Ownership).

골격: `공통 계약 + Walking Skeleton(PR-001) → 표시 슬라이스(PR-002) → 이력 슬라이스(PR-003)
→ 하드닝·인수(PR-004)`.

**선행 조건 (MANUAL-1): [PR #1](https://github.com/whelp99-code/chatgpt2codex/pull/1) 머지 후
`main`에서 분기한다.** `src/server/http.ts`를 두 브랜치가 건드리므로 이를 어기면 충돌한다.

---

## PR-001 — 활동 시각 배관과 상태 판정 (Walking Skeleton)

```
PR ID: PR-001
Title: 세션 활동 시각을 대시보드까지 잇고 진행중/대기를 표시한다
Risk: R-01(R1), R-03(R1), R-04(R2), R-09(R2)
Execution Type: SEQUENTIAL
Related REQ: REQ-STAT-001, REQ-STAT-002
Purpose:
  전송 계층에만 있던 정확한 활동 시각을 admin까지 흘려보내, 가장 얇은 흐름 하나를
  전 레이어(http → admin → HTML)로 관통시킨다.
Predecessors: 없음 (MANUAL-1 완료 후)
Successors: PR-002, PR-003

[출력]
  수정: src/server/admin.ts       — SlotView.status 추가, localStatus 시그니처 확장, 상태 배지 렌더
        src/server/http.ts        — registerAdminRoutes 호출에 활동 시각 provider 주입
        src/server/admin.test.ts  — 상태 판정 테스트 추가
  생성: 없음
  삭제: 없음
  새 Symbol: SessionActivityStatus 타입, ACTIVE_WINDOW_MS 상수, AdminDeps 인터페이스
  새 API: GET /status.json 응답의 slots[].status 필드
  새 테스트: ACCEPT-STAT-003, ACCEPT-STAT-004

[금지]
  src/state/store.ts        — 이 PR은 디스크 스키마를 건드리지 않는다
  src/server/tools.ts       — 도구 경로에 코드를 넣지 않는다 (ADR-001)
  src/workspace/**          — 리스 로직 불변
  기존 테스트의 assertion 수정

[Change Budget] 직접 수정 3파일 / 신규 0 / 논리 변경 약 120줄 / Migration 0 — 예산 내

[검증 명령]
  Format    N/A — 저장소에 format 스크립트 없음 (01 문서 §1)
  Lint      N/A — 저장소에 lint 스크립트 없음
  Typecheck npm run typecheck    → 종료 코드 0
  Build     npm run build        → 종료 코드 0
  Unit      npm test             → 종료 코드 0, 463개 + 신규 테스트 전부 통과
  ※ 반드시 build → test 순서 (01 문서 §2의 dist 의존성)

[완료 기준]
  REQ-STAT-001·REQ-STAT-002 구현 · 신규 테스트 통과 · 기존 463개 유지 · 금지 파일 미변경
```

### PR-001 SUB / DETAIL

```
SUB ID: PR-001-SUB-001
Title: SlotView에 status를 더하고 localStatus가 활동 시각 provider를 받게 한다
Purpose: 상태 계산의 자리를 만든다
Related REQ: REQ-STAT-002

[대상 파일]
  MODIFY: src/server/admin.ts
  READ_ONLY: src/types.ts, src/server/http.ts
  FORBIDDEN: src/state/store.ts, src/server/tools.ts

[구현 순서]
  STEP 1. admin.ts 상단(기존 상수 PEER_TIMEOUT_MS 근처)에 상수와 타입을 추가한다.
    변경 내용:
      export type SessionActivityStatus = "active" | "idle";
      const DEFAULT_ACTIVE_WINDOW_MS = 90_000;   // ASSUMED-001
    검증: npm run typecheck → 0

  STEP 2. SlotView(현재 23~31행)에 필드를 더한다.
    변경 내용: status: SessionActivityStatus;
    검증: typecheck가 localStatus의 미할당을 오류로 잡는다 (다음 STEP에서 해소)

  STEP 3. localStatus의 시그니처를 확장한다.
    현재: localStatus(ctx: ToolContext, maxSlots: number)
    변경: localStatus(ctx: ToolContext, maxSlots: number, deps?: AdminDeps)

      export interface AdminDeps {
        /** sessionKey → 마지막 활동 epoch ms. 전송 계층 메모리 Map에서 온다. */
        activity?: () => ReadonlyMap<string, number>;
        activeWindowMs?: number;
        now?: () => number;      // 테스트에서 시각을 고정하기 위한 주입점
      }

    입력: 기존 인자 + 선택적 deps
    출력: InstanceStatus (slots[].status가 채워진 상태)
    검증: 인자를 넘기지 않는 기존 호출부가 그대로 컴파일된다

  STEP 4. slots를 만드는 map 안(현재 111~126행)에서 상태를 계산한다.
    로직:
      const lastActive = deps?.activity?.().get(session.sessionKey) ?? session.lastActiveAtMs;
      const status = now - lastActive < activeWindowMs ? "active" : "idle";
    ※ `??` 폴백이 R-04(stdio 세션) 대응이자 ADR-001의 롤백 경로다. 지우지 말 것.
    오류 처리: activity()가 던지면 폴백을 쓴다 — try/catch로 감싸고 store 값으로 떨어진다
    검증: npm run build && npm test → 0

  STEP 5. registerAdminRoutes 안의 localStatus 호출 **두 곳 모두**에 deps를 넘긴다.
    ※ 이 단계를 빠뜨리면 SUB-002에서 주입한 값이 아무 데도 쓰이지 않는다. 타입 검사도
      통과하고 테스트도 초록인데 화면의 상태는 영원히 "대기"에 머문다 — 조용히 실패한다.
    대상 (계획 작성 시점 확인, grep -n "localStatus(" src/server/admin.ts 로 재확인할 것):
      239행  res.json(await localStatus(ctx, options.maxSlots));
             → await localStatus(ctx, options.maxSlots, options)
      265행  const instances = [await localStatus(ctx, options.maxSlots), ...peerResults];
             → [await localStatus(ctx, options.maxSlots, options), ...peerResults]
    ※ /status.json(239)과 /admin(265)이 각각 따로 부른다. 한쪽만 고치면 JSON에는 상태가
      나오는데 화면에는 안 나오는(또는 그 반대) 어긋남이 생긴다.
    검증: npm run build && npm test → 0

[계약]
  Symbol: localStatus(ctx: ToolContext, maxSlots: number, deps?: AdminDeps): Promise<InstanceStatus>
  Exceptions: 던지지 않는다 (activity provider의 예외를 흡수)
  Side Effects: 없음 (읽기 전용)
  External Calls: 없음

[검증] 명령: npm run build && npm test / 기대 종료 코드 0 / 기대 결과: 기존 463개 통과 유지

[완료 기준]
  SlotView.status 존재 · 기존 호출부 무수정 컴파일 · 타입 검사 통과 · 범위 외 미변경
```

```
SUB ID: PR-001-SUB-002
Title: http.ts가 전송 계층 활동 Map을 admin에 주입한다
Purpose: 정확한 활동 시각을 실제로 흘려보낸다 (Walking Skeleton의 관통점)
Related REQ: REQ-STAT-001

[대상 파일]
  MODIFY: src/server/http.ts
  READ_ONLY: src/server/admin.ts
  FORBIDDEN: src/server/tools.ts, src/state/**

[구현 순서]
  STEP 1. registerAdminRoutes 호출부를 찾는다 (계획 작성 시점 366행, CONFIRMED).
    확인 방법: grep -n "registerAdminRoutes(app" src/server/http.ts

  STEP 2. 옵션 객체에 activity provider를 더한다.
    현재 코드 (366~369행, CONFIRMED):
      registerAdminRoutes(app, ctx, {
        maxSlots: config.maxSessions,
        secureCookies: publicUrl.protocol === "https:",
      });
    변경 후:
      registerAdminRoutes(app, ctx, {
        maxSlots: config.maxSessions,
        secureCookies: publicUrl.protocol === "https:",   // 그대로 둔다
        activity: () => new Map(                           // 신규
          [...sessions].map(([id, s]) => [id, s.lastActiveAtMs]),
        ),
      });
    ※ Map을 매 호출마다 새로 만든다. 내부 Map을 그대로 넘기면 admin이 전송 계층 상태를
      들여다보게 되고, 실수로 변형할 여지가 생긴다.
    입력: 없음 / 출력: ReadonlyMap<string, number>
    검증: grep -n "lastActiveAtMs" src/server/http.ts 로 Map 값의 실제 필드명 확인 (조정 지점 #2)

  STEP 3. registerAdminRoutes의 options 타입에 activity를 optional로 추가한다 (admin.ts).
    ※ SUB-001의 AdminDeps를 그대로 재사용한다. 타입을 새로 만들지 않는다.
    검증: npm run build && npm test → 0

[계약]
  Symbol: registerAdminRoutes(app, ctx, options: { maxSlots: number; secureCookies: boolean } & AdminDeps): void
  Exceptions: 없음
  Side Effects: 없음
  External Calls: 없음

[검증] 명령: npm run build && npm test / 기대 종료 코드 0 / 기대 결과: 기존 테스트 유지

[완료 기준] 주입 경로 연결 · 타입 검사 통과 · sessions Map 원본을 그대로 노출하지 않음
```

```
SUB ID: PR-001-SUB-003
Title: 대시보드 표에 상태 배지를 그리고 테스트를 추가한다
Purpose: 사람이 눈으로 확인할 수 있는 지점까지 관통을 끝낸다
Related REQ: REQ-STAT-002

[대상 파일]
  MODIFY: src/server/admin.ts (slotRows), src/server/admin.test.ts
  READ_ONLY: 없음
  FORBIDDEN: src/server/http.ts (SUB-002에서 이미 확정)

[구현 순서]
  STEP 1. slotRows(현재 311~334행)의 표에 상태 열을 넣는다.
    변경 내용: 헤더 "상태" 추가, 각 행에 배지
      const statusPill = slot.status === "active"
        ? `<span class="pill w">진행중</span>`
        : `<span class="pill r">대기</span>`;
    ※ 기존 .pill 클래스를 재사용한다 (admin.ts:302~304). 새 CSS를 만들지 않는다.
    ※ 색만으로 구분하지 않는다 — 텍스트를 함께 넣는다 (03 문서 §4.5 접근성).
    검증: 렌더 결과 문자열에 "진행중"과 "대기"가 나타난다

  STEP 2. admin.test.ts에 테스트 2개를 추가한다.
    ACCEPT-STAT-003: 활동 5초 전 세션은 active, 10분 전 세션은 idle
      → deps.now를 고정값으로 주입해 시각 의존성을 없앤다
    ACCEPT-STAT-004: activity Map에 없는 세션은 idle이고 예외가 나지 않는다
    ※ 기존 테스트 방식(mkdtemp + 실제 Store)을 따른다 (01 문서 §6)
    검증: npm run build && npm test → 0

[계약]
  Symbol: slotRows(status: InstanceStatus): string  (시그니처 불변, 출력 HTML만 변경)
  Exceptions: 없음
  Side Effects: 없음

[검증] 명령: npm run build && npm test / 기대 종료 코드 0 / 기대 결과: 신규 2개 포함 465개 통과

[완료 기준] ACCEPT-STAT-003·004 통과 · 기존 테스트 미파괴 · esc() 적용 확인(R-07)
```

### PR-001 디스패치 프롬프트

```text
사전 조건: MANUAL-1(PR #1 머지) 완료 확인. `git log --oneline origin/main -1`로
CSP 커밋이 main에 있는지 확인하고, main에서 새 브랜치를 딴다.

TASK: PR-001 — 세션 활동 시각을 대시보드까지 잇고 진행중/대기 상태를 표시한다

DELIVERABLE:
- 변경 diff (src/server/admin.ts, src/server/http.ts, src/server/admin.test.ts)
- `npm run build && npm test` 출력 (종료 코드 포함)
- 계획과 다르게 조정한 지점 목록 (없으면 "없음")

SCOPE:
- 먼저 읽기: docs/planning/05-PR-PLAN.md의 PR-001 섹션 전체,
  docs/planning/03-ARCHITECTURE-CONTRACTS.md의 ADR-001과 §4.5 UI 계약,
  docs/planning/01-DISCOVERY-BASELINE.md §4.2 (활동 시각이 두 곳에 따로 있는 이유)
- 수정 허용: src/server/admin.ts, src/server/http.ts(registerAdminRoutes 호출부만),
  src/server/admin.test.ts
- 수정 금지: src/state/**, src/server/tools.ts, src/workspace/**, 기존 테스트의 assertion
- 계획서와 실제 코드가 다르면: 질문하지 말고 grep/read로 실제를 확인해 맞추고,
  조정 내용을 DELIVERABLE에 보고한다. 특히 조정 지점 #2(http.ts의 세션 Map 필드명)와
  #3(registerAdminRoutes 시그니처)을 먼저 확인하라.
- 테스트 우회 금지: skip/삭제/assertion 약화/ts-ignore/빈 catch로 통과시키지 않는다.
  단 SUB-001 STEP 4의 activity() 예외 흡수는 요구된 동작이며, 폴백 값을 반드시 사용한다.

VERIFY: npm run build && npm test → 기대 종료 코드 0,
  기대 결과: 기존 463개 + 신규 2개 = 465개 통과. 실패 0.
이 명령이 통과해야 완료다. "될 것으로 예상"은 완료가 아니다.

보고 규칙: 진행 상황은 "WORKING: {현재 작업}", 막히면 추측하지 말고 "BLOCKED: {필요한 것}".
```

---

## PR-002 — 세션 이름을 폴더명과 슬롯으로 병기

```
PR ID: PR-002
Title: 대시보드 세션 열을 "폴더명 (W01)" 형식으로 바꾼다
Risk: R-06(R1), R-07(R1)
Execution Type: SEQUENTIAL
Related REQ: REQ-NAME-001
Purpose: 표에서 슬롯 번호와 프로젝트를 눈으로 짝지어야 하는 부담을 없앤다
Predecessors: PR-001 (같은 slotRows 함수를 건드린다)
Successors: PR-003

[출력]
  수정: src/server/admin.ts (slotRows의 열 구성), src/server/admin.test.ts
  생성: 없음 / 삭제: 없음
  새 Symbol: sessionLabel(slot: SlotView): string
  새 API: 없음 (표시 변경만)
  새 테스트: ACCEPT-NAME-001, ACCEPT-NAME-002

[금지]
  src/server/http.ts, src/state/**, src/workspace/**
  status.json의 기존 필드 (projectName은 그대로 둔다 — 피어 호환)

[Change Budget] 직접 수정 2파일 / 신규 0 / 논리 변경 약 40줄 / Migration 0 — 예산 내

[검증 명령]
  Typecheck npm run typecheck → 0
  Build     npm run build     → 0
  Unit      npm test          → 0, 신규 2개 포함 전부 통과

[완료 기준] REQ-NAME-001 구현 · 절대 경로 미노출 · null 세션이 "(W02)"로 표시 · 기존 테스트 유지

[SUB 목록]
  PR-002-SUB-001 — sessionLabel 헬퍼 추가와 표 열 통합
  PR-002-SUB-002 — ACCEPT-NAME-001·002 테스트 추가
```

### PR-002 디스패치 프롬프트

```text
사전 조건: PR-001 완료 및 검증 통과.

TASK: PR-002 — 대시보드 세션 열을 "폴더명 (W01)" 형식으로 병기한다

DELIVERABLE:
- 변경 diff (src/server/admin.ts, src/server/admin.test.ts)
- `npm run build && npm test` 출력 (종료 코드 포함)
- 조정 지점 보고 — 특히 조정 지점 #1(ProjectRegistryEntry.name이 폴더명인지) 확인 결과

SCOPE:
- 먼저 읽기: docs/planning/05-PR-PLAN.md의 PR-002 섹션,
  docs/planning/02-REQUIREMENTS-ACCEPTANCE.md의 REQ-NAME-001과 인수 기준 2건,
  docs/planning/03-ARCHITECTURE-CONTRACTS.md의 ASSUMED-004
- 수정 허용: src/server/admin.ts, src/server/admin.test.ts
- 수정 금지: src/server/http.ts, src/state/**, src/workspace/**,
  InstanceStatus의 기존 필드(projectName 유지 — 구버전 피어 호환)
- 계획서와 실제 코드가 다르면: 질문하지 말고 실제에 맞춰 조정 후 보고.
  ProjectRegistryEntry.name이 폴더명이 아니면 basename(entry.root)를 쓰고 그 사실을 보고하라.
- 출력은 반드시 기존 esc()를 거친다 (XSS, 위험 R-07).
- 테스트 우회 금지.

VERIFY: npm run build && npm test → 기대 종료 코드 0, 신규 2개 포함 전부 통과.
  추가 확인: 렌더 결과 HTML에 "/Volumes/" 또는 "/home/" 문자열이 세션 열에 없어야 한다.

보고 규칙: WORKING / BLOCKED 형식 사용.
```

---

## PR-003 — 완료 이력 기록과 표시

```
PR ID: PR-003
Title: 세션 종료를 이력으로 남기고 대시보드에 최근 완료를 보여준다
Risk: R-02(R2), R-05(R2), R-11(R3), R-08(R1)
Execution Type: SEQUENTIAL
Related REQ: REQ-HIST-001, REQ-HIST-002
Purpose: 끝난 작업이 화면에서 사라지지 않고 며칠간 남게 한다
Predecessors: PR-002
Successors: PR-004

[출력]
  생성: src/state/session-history.ts       — SessionHistory 클래스 (record / list)
        src/state/session-history.test.ts  — 기록·보존·손상 줄 처리 테스트
  수정: src/server/http.ts                 — 주기 sweep(현재 427행)의 반환값을 이력에 기록
        src/server/admin.ts                — history를 status에 싣고 완료 영역 렌더
        src/server/admin.test.ts           — ACCEPT-HIST-003·004
  새 Symbol: SessionHistory, SessionHistoryRecord
  새 API: GET /status.json 응답의 history 배열
  새 테스트: ACCEPT-HIST-001 ~ 004

[금지]
  src/state/ledger.ts        — 감사 로그는 건드리지 않는다 (ADR-002)
  src/state/store.ts         — sessions.json 스키마 불변
  src/server/http.ts의 415행(시작 시 sweepSessions(null)) — 이력을 붙이지 않는다 (ADR-004, R-05)
  src/server/tools.ts

[Change Budget] 직접 수정 3파일 / 신규 2 / 논리 변경 약 280줄 / Migration 0 — 예산 내

[검증 명령]
  Typecheck npm run typecheck → 0
  Build     npm run build     → 0
  Unit      npm test          → 0, 신규 4개 이상 포함 전부 통과

[완료 기준]
  REQ-HIST-001·002 구현 · 파일 권한 0600 확인 · 쓰기 실패가 sweep을 막지 않음(R-11 예방 4항목)
  · 시작 시 sweep이 이력을 만들지 않음 · 기존 테스트 유지

[SUB 목록] DECOMPOSITION: PENDING
  사유: 롤링 웨이브. PR-001·002가 admin.ts의 구조를 바꾼 뒤 그 결과 위에서 분해해야
  대상 위치와 시그니처가 정확해진다. PR-002 완료 시점에 이 섹션을 SUB/DETAIL로 채운다.
  다만 R-11(R3) 대응은 분해 전이라도 확정 사항이며 04 문서의 예방 4개 항목을 그대로 따른다.
```

---

## PR-004 — 동시성 회귀 보호와 설정 하드닝

```
PR ID: PR-004
Title: 다중 프로젝트 동시 편집을 테스트로 못 박고 임계값을 환경변수로 뺀다
Risk: R-03(R1)
Execution Type: SEQUENTIAL
Related REQ: REQ-SESS-001, REQ-STAT-003
Purpose:
  이미 동작하는 동시 편집이 앞으로도 깨지지 않게 고정하고, ASSUMED로 잡은 두 값을
  코드 수정 없이 바꿀 수 있게 만든다.
Predecessors: PR-003
Successors: 없음 (인수)

[출력]
  수정: src/server/admin.ts 또는 설정 로딩 지점 — 환경변수 2개 읽기
        src/workspace/project-select.test.ts — 동시성 회귀 테스트 (실존 확인됨)
        ※ 같은 디렉터리의 lease-guard-sessions.test.ts, write-lock.test.ts에 이미 인접
          주제의 테스트가 있다. 먼저 읽고 중복이면 그쪽에 덧붙인다.
  새 Symbol: 없음 (기존 상수를 환경변수로 대체)
  새 테스트: ACCEPT-SESS-001, ACCEPT-SESS-002, REQ-STAT-003의 잘못된 값 처리

[금지]
  리스 로직 자체(src/workspace/project-select.ts의 assertWritable) — 테스트만 추가하고
  동작을 바꾸지 않는다

[Change Budget] 직접 수정 2파일 / 신규 1 / 논리 변경 약 120줄 / Migration 0 — 예산 내

[검증 명령]
  Typecheck npm run typecheck → 0
  Build     npm run build     → 0
  Unit      npm test          → 0

[완료 기준]
  ACCEPT-SESS-001·002 통과 · 환경변수 미설정 시 기본값 동작 · 잘못된 값에서 기본값 폴백
  · 전체 테스트 통과

[SUB 목록] DECOMPOSITION: PENDING
  사유: 롤링 웨이브. PR-001·003에서 상수가 놓일 최종 위치가 정해진 뒤 분해한다.
```

---

## 요구사항 추적표

| REQ | Acceptance | PR | SUB | 구현 파일 | 검증 명령 | 상태 |
|---|---|---|---|---|---|---|
| REQ-SESS-001 | ACCEPT-SESS-001, 002 | PR-004 | PENDING | 테스트만 (동작은 기존 코드) | `npm run build && npm test` | 계획됨 |
| REQ-STAT-001 | ACCEPT-STAT-001, 002 | PR-001 | SUB-002 | src/server/http.ts | `npm run build && npm test` | 계획됨 |
| REQ-STAT-002 | ACCEPT-STAT-003, 004 | PR-001 | SUB-001, 003 | src/server/admin.ts | `npm run build && npm test` | 계획됨 |
| REQ-STAT-003 | 기본값 폴백 테스트 | PR-004 | PENDING | 설정 로딩 지점 | `npm run build && npm test` | 계획됨 |
| REQ-NAME-001 | ACCEPT-NAME-001, 002 | PR-002 | SUB-001, 002 | src/server/admin.ts | `npm run build && npm test` | 계획됨 |
| REQ-HIST-001 | ACCEPT-HIST-001, 002 | PR-003 | PENDING | src/state/session-history.ts, src/server/http.ts | `npm run build && npm test` | 계획됨 |
| REQ-HIST-002 | ACCEPT-HIST-003, 004 | PR-003 | PENDING | src/state/session-history.ts, src/server/admin.ts | `npm run build && npm test` | 계획됨 |

## 실행 순서 요약

```
MANUAL-1 (PR #1 머지)
   ↓
PR-001  활동 시각 배관 + 상태 표시      [DETAIL까지 분해 완료]
   ↓
PR-002  이름 병기                      [SUB까지 분해 완료]
   ↓
PR-003  완료 이력                      [PENDING — PR-002 후 분해]
   ↓
PR-004  회귀 테스트 + 환경변수          [PENDING — PR-003 후 분해]
   ↓
MANUAL-2 (맥·우분투 배포)
```

---

## 부록 — REVIEW LOG

적대적 리뷰 1회 수행 (2026-08-16). 계획서를 신뢰하지 않고 반증하는 방향으로 읽었다.

### 기계 검사 결과 (실제 실행)

| 검사 | 결과 | 판정 |
|---|---|---|
| 모호어 grep (11개 패턴) | 검출 0건 | 통과 |
| TBD·TODO·FIXME·??? | 검출 0건 | 통과 |
| DECOMPOSITION: PENDING | 2건 (PR-003, PR-004) | 통과 — 둘 다 롤링 웨이브 사유 기재 |
| 검증 명령 실존 대조 | 참조 3개(`npm run build`·`npm run typecheck`·`npm test`) 전부 package.json에 존재 | 통과 — 미실존 0 |
| 빈칸 스캔 | 30건 검출 → **전부 오탐** | 통과 |
| 행 번호 인용 대조 | 15개 인용 전수 대조 | 14개 일치, 1개 부정확 → F-003으로 수정 |

빈칸 30건은 ADR·요구사항 템플릿이 `Context:` 뒤 줄바꿈하고 내용을 쓰는 형식이라 정규식이
헤더 줄만 보고 빈칸으로 센 것이다. 실제로 값이 비어 있는 필드는 없다.

재검 시 TBD류가 1건 잡히는데, 바로 위 표의 "TBD·TODO·FIXME·???" 행이 자기 자신을 잡은
것이다. 인용 맥락이므로 통과로 판정한다 (체크리스트 §0의 단서 조항).

행 번호 대조는 `admin.ts:23/118/274/302-304/311/371`, `http.ts:69/415/427/470`,
`tools.ts:1386`, `types.ts:63`, `store.ts:311/349`, `project-select.ts:112`,
`ledger.ts:19`을 실제 파일과 맞춰본 것이며 F-003 한 건을 빼고 전부 정확했다.

### 소견

```
Finding ID: F-001 / Severity: HIGH / 위치: 05-PR-PLAN.md, PR-001-SUB-001·SUB-002
문제:
  SUB-002가 registerAdminRoutes에 activity provider를 주입하도록 지시하지만, 그 값을
  localStatus까지 전달하라는 지시가 어디에도 없었다. registerAdminRoutes 안에서
  localStatus는 여전히 (ctx, options.maxSlots) 두 인자로만 불린다.
실행 에이전트가 막히는 시나리오:
  막히지 않는다 — 그게 문제다. 타입 검사가 통과하고(세 번째 인자가 optional),
  단위 테스트도 통과한다(테스트는 localStatus를 직접 호출하며 deps를 손으로 넘긴다).
  실제 화면만 조용히 틀린다: 주입한 값이 아무 데도 쓰이지 않아 모든 세션이 영원히
  "대기"로 표시된다. 초록 불을 보고 완료로 보고하게 되는 결함이다.
요구 수정: SUB-001에 STEP 5를 추가해 호출부 배선을 명시한다.
조치: 완료. STEP 5 추가.
```

```
Finding ID: F-002 / Severity: HIGH / 위치: 05-PR-PLAN.md, PR-001-SUB-001
문제:
  localStatus 호출 지점이 admin.ts에 두 곳(239행 /status.json, 265행 /admin)인데
  계획서는 이를 구분하지 않았다.
실행 에이전트가 막히는 시나리오:
  한쪽만 고치면 /status.json에는 status가 실리는데 /admin 화면에는 안 나오거나 그 반대가
  된다. 두 표면이 어긋나면 원인을 찾기 어렵다 — 서버는 정상이고 API도 정상인데 화면만
  틀린 것처럼 보인다.
요구 수정: STEP 5에 두 행 번호와 각각의 변경 전후를 명시하고, 한쪽만 고쳤을 때의
  증상을 적어 놓는다.
조치: 완료. STEP 5에 239·265행을 각각 기재.
```

```
Finding ID: F-003 / Severity: MEDIUM / 위치: 05-PR-PLAN.md, PR-001-SUB-002 STEP 1
문제:
  registerAdminRoutes 호출부를 "현재 360행 부근"으로 적었으나 실제는 366행이다.
  더 문제는 이 값이 확인 없이 추정으로 쓰였다는 것 — 계획서의 다른 행 번호는 모두
  파일을 열어 확인한 값인데 이것만 아니었다.
실행 에이전트가 막히는 시나리오:
  "부근"이라 적어 실무상 찾기는 한다. 다만 확인하지 않은 값이 확인된 값들 사이에 섞여
  있으면 계획서 전체의 신뢰도가 떨어진다.
요구 수정: 실제 행 번호와 현재 코드 전문을 CONFIRMED 표시와 함께 기재.
조치: 완료. 366행 + secureCookies 실제 값(publicUrl.protocol === "https:")까지 기재.
```

```
Finding ID: F-004 / Severity: LOW / 위치: 05-PR-PLAN.md, PR-004 [출력]
문제:
  테스트 파일을 "project-select.test.ts 또는 신규 테스트 파일"로 적어 실존 여부를
  확인하지 않은 것처럼 읽힌다. 실제로는 존재하며, 같은 디렉터리에
  lease-guard-sessions.test.ts와 write-lock.test.ts라는 인접 주제 테스트도 있다.
실행 에이전트가 막히는 시나리오:
  기존 파일을 못 보고 새 파일을 만들어 같은 주제의 테스트가 두 곳으로 갈린다.
요구 수정: 실존을 명시하고 인접 파일을 먼저 읽도록 지시.
조치: 완료.
```

### 체크리스트 점검 (F-001~004 조치 후)

| 항목 | 판정 |
|---|---|
| 1. 실행 가능성 — 파일 경로 특정, 계약 수준, 기대 종료 코드, 조정 지점, MANUAL 분리, 디스패치 프롬프트 | 통과 |
| 2. 완전성 — MUST 6개 전부 정상+실패 인수 기준, 추적표 연결, OUT_OF_SCOPE, N/A 사유, 롤백 | 통과 |
| 3. 정합성 — 의존 그래프 선형(순환 없음), File Ownership 순차, Change Budget 내, Walking Skeleton이 실제 관통 | 통과 |
| 4. 정직성 — CONFIRMED 근거, ASSUMED 4건 근거·영향·롤백, 위험 R3 1건 존재, 티어 수치 일치 | 통과 |

### 최종 판정

**CRITICAL 0건 / HIGH 2건(F-001·F-002, 조치 완료) / MEDIUM 1건(조치 완료) / LOW 1건(조치 완료).**

HIGH 두 건이 같은 성격이라는 점을 남겨 둔다. 둘 다 "실행 에이전트가 막히는" 결함이 아니라
**막히지 않고 통과해 버리는** 결함이었다. 타입 검사도 테스트도 초록인데 화면만 틀리는 종류다.
계획서의 검증 명령(`npm test`)만으로는 이런 결함이 잡히지 않으므로, PR-001 완료 시
`docs/planning/`의 검증 외에 **실제 브라우저로 /admin을 열어 상태 배지를 눈으로 확인**할 것.
이 세션에서 격리 dev 서버(포트 7980, HOME을 스크래치패드로 분리)를 띄워 두었으므로 그대로 쓰면 된다.
