# 01 — 저장소 조사와 Baseline

## 1. 실행 명령 실존 확인 (CONFIRMED — `package.json` 직접 확인)

| 용도 | 명령 | 확인 |
|---|---|---|
| 타입 검사 | `npm run typecheck` (`tsc --noEmit`) | CONFIRMED |
| 빌드 | `npm run build` (`dist` 삭제 후 `tsc -p tsconfig.json`) | CONFIRMED |
| 테스트 | `npm test` (`vitest run`) | CONFIRMED |
| Lint | **없음** | CONFIRMED — `package.json`에 lint 스크립트 부재. 계획서 어디에서도 lint를 검증 단계로 쓰지 않는다 |
| Format | **없음** | CONFIRMED — prettier/biome 스크립트 부재 |

## 2. Baseline 실행 결과 (CONFIRMED — 2026-08-16 실행)

```
npm run typecheck   → exit 0
npm run build       → exit 0
npm test            → exit 0, Test Files 43 passed (43), Tests 463 passed (463)
```

**기존 실패 없음.** 따라서 이 작업 이후 발생하는 모든 실패는 이번 변경의 회귀로 간주한다.

주의 (CONFIRMED): `npm test`는 `dist/`가 없으면 `src/server/http-listen-failure.test.ts`의
3개 테스트가 `MODULE_NOT_FOUND`로 실패한다. 자식 프로세스를 띄워 `dist/cli.js`를 실행하기
때문이다. **검증 순서는 반드시 `build` → `test`.**

## 3. 저장소 지도 — 이번 작업 관련 부분만

```
src/
├── types.ts                     SessionSummary, ExecutionMode, Lease, ToolContext
├── cli.ts                       store 주입(178~182), 시작 시 sweepSessions(null) (492)
├── state/
│   ├── store.ts                 sessions.json v2 읽기·쓰기, 슬롯 할당, sweepSessions
│   └── ledger.ts                append-only JSONL (audit.jsonl) — append만 있고 읽기 없음
├── server/
│   ├── admin.ts                 /status.json, /admin 렌더링 ← 주 변경 대상
│   ├── http.ts                  MCP 전송 계층, 세션 Map, sweep 스케줄 ← 활동 시각 출처
│   └── tools.ts                 48개 MCP 도구, saveSession 호출 1곳
└── workspace/
    ├── lease-guard.ts           requireProjectLease — 모든 도구가 통과하는 관문
    └── project-select.ts        assertWritable — 프로젝트별 배타 쓰기 잠금
```

## 4. 핵심 발견 — 계획의 근간

### 4.1 다중 프로젝트 동시 처리는 이미 동작한다 (CONFIRMED)

`sessions.json`은 v2에서 세션 키별 맵이다 (`src/state/store.ts:106-111`). 주석이 이유를
명시한다: v1은 서버 전역 문서 하나여서 두 대화창이 서로의 프로젝트 선택을 덮어썼다.

쓰기 잠금은 프로젝트 단위로만 배타적이다 (`src/workspace/project-select.ts:112-134`
`assertWritable`). **서로 다른 프로젝트라면 충돌하지 않는다.** 같은 프로젝트를 두 창이
편집하려 할 때만 `PROJECT_LOCKED`이 나고, 그때 점유 슬롯과 만료 시각을 알려준다.

슬롯 상한은 100 (`maxSlots`, 라이브 확인: `mac-studio`의 `/status.json`이
`"maxSlots":100`). 실측 시점에 연결된 세션은 0개였다.

→ **REQ-01은 신규 구현이 아니라 회귀 테스트 대상이다.**

### 4.2 활동 시각이 두 곳에 따로 있고, 대시보드는 틀린 쪽을 본다 (CONFIRMED)

| 위치 | 갱신 시점 | 저장 | 대시보드가 보는가 |
|---|---|---|---|
| `sessions.json`의 `lastActiveAtMs` (`store.ts:311`) | `setSession()` 호출 시 | 디스크 | **예** (`admin.ts:123`) |
| 전송 계층 `sessions` Map의 `lastActiveAtMs` (`http.ts:470`) | **모든 MCP HTTP 요청마다** | 메모리 | 아니오 |

그리고 `setSession()`을 부르는 곳은 `src/server/tools.ts:1386` **단 한 곳**, `project_select`
도구 안이다 (`grep -c "saveSession(" src/server/tools.ts` → 2, 하나는 정의부).

**결론:** 대화창이 30분 동안 파일을 읽고 고치고 테스트를 돌려도, 디스크의
`lastActiveAtMs`는 맨 처음 `project_select` 시각에 멈춰 있다. 지금 값으로 "진행중"을
판정하면 **실제로 일하는 세션이 전부 '대기'로 보인다.**

→ **REQ-02의 실질 과제는 상태 계산식이 아니라 정확한 활동 시각을 대시보드까지 가져오는 것.**

### 4.3 세션 종료는 감지되지만 기록되지 않는다 (CONFIRMED)

`sweepSessions(liveKeys)`는 살아있지 않은 세션을 지우고 **지운 키 배열을 반환한다**
(`store.ts:349-364`). 호출 지점은 두 곳 (`http.ts:415`, `http.ts:427`):

- 서버 시작 시 `sweepSessions(null)` — 전부 삭제
- `sweepInterval` 안에서 살아있는 전송 계층 키 목록으로 주기 삭제

반환값 `removed`는 현재 **버려진다** (`void ctx.store.sweepSessions?.(...)`).

→ **이 반환값이 "완료" 이벤트의 자연스러운 발생 지점이다. 새 감지 로직이 필요 없다.**

세션 TTL은 30분 (`http.ts:69` `sessionTtlMs: 30 * 60 * 1000`). 즉 대화창을 닫아도
최대 30분 뒤에야 정리된다.

### 4.4 이력 저장소로 쓸 수 있는 것 (CONFIRMED)

`src/state/ledger.ts`는 `audit.jsonl`에 append-only로 이벤트를 쌓는다. `tools.ts`에서
30곳이 쓴다. **하지만 읽기 API가 없다** — 클래스에 `append()` 하나뿐이다.

선택지는 두 가지이며 03 문서의 ADR-002에서 결정한다: ledger에 읽기를 추가하느냐, 별도의
작은 이력 파일을 두느냐.

### 4.5 타입과 표시 구조 (CONFIRMED)

```ts
// src/types.ts:63
export type ExecutionMode = "observe" | "read" | "edit" | "verify" | "danger";

// src/types.ts:70-79
export interface SessionSummary {
  sessionKey: string;
  slot: string;              // "W01", "W02" — assignSlot이 할당, sweep되면 재사용
  activeProjectId: string | null;
  mode: ExecutionMode;
  lease: Lease | null;
  lastActiveAtMs: number;
}
```

`admin.ts`의 `SlotView`(23-31)는 이미 `projectName`을 담고, 표에도 프로젝트 열이 있다
(`slotRows`, 311-334). **`W01`과 프로젝트 이름이 별개 열로 이미 존재**하므로 REQ-03은
새 데이터가 아니라 **표시 형식 변경**이다.

프로젝트 이름의 출처는 `ProjectRegistryEntry.name`이다 (`admin.ts:118`). 이것이 폴더명인지
다른 값인지는 `03` 문서의 알려진 조정 지점 #1로 넘긴다.

## 5. 코드 패턴 (따라야 할 것)

| 패턴 | 근거 |
|---|---|
| 순수 함수를 export하고 테스트에서 직접 호출 | `admin.ts`의 `parsePeers`, `renderDashboard`, `localStatus`가 모두 export되고 `admin.test.ts`가 직접 import (CONFIRMED) |
| 디스크 상태는 zod 스키마로 파싱 | `store.ts`의 `SessionEntrySchema`, `SessionsFileV2Schema` (CONFIRMED) |
| 파일 권한은 0600, 디렉터리 0700 | `ledger.ts:19-21` (CONFIRMED) |
| 주석은 "왜"만 쓴다 | 저장소 전반. 예: `store.ts:101-105`가 v2 도입 이유를 설명 (CONFIRMED) |
| UI 문자열은 한국어 | `admin.ts:313` "연결된 세션이 없습니다" 등 (CONFIRMED) |
| 옵셔널 store 메서드는 `?.` 호출 | `ctx.store.sweepSessions?.(...)` (CONFIRMED) |

## 6. 테스트 작성 방식 (CONFIRMED — `admin.test.ts` 앞부분)

`vitest` + `mkdtemp`로 임시 상태 디렉터리를 만들고 실제 `Store`를 붙여 검증한다. 모킹보다
실제 파일을 쓰는 쪽이다. 새 테스트도 이 방식을 따른다.
