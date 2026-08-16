# 03 — 아키텍처와 계약

## 1. 현재 구조

```
ChatGPT 대화창
   │ MCP over HTTP
   ▼
src/server/http.ts ───── sessions: Map<sessionId, {transport, lastActiveAtMs}>   [메모리, 요청마다 갱신]
   │                          │
   │ 도구 호출                 └─ sweepInterval → store.sweepSessions(liveKeys)   [반환값 버려짐]
   ▼
src/server/tools.ts ──── project_select만 store.setSession() 호출
   │
   ▼
src/state/store.ts ───── sessions.json v2 { sessionKey: {slot, lease, lastActiveAtMs, ...} }
   │
   ▼
src/server/admin.ts ──── localStatus() → SlotView[] → renderDashboard()
```

**끊어진 곳:** `admin.ts`는 `store`만 본다. 요청마다 갱신되는 정확한 활동 시각(`http.ts`의
메모리 Map)에 닿지 못한다.

## 2. 목표 구조

```
src/server/http.ts ───── sessions Map (기존)
   │                          │
   │                          ├─→ [신규] activity provider 함수로 노출
   │                          │
   │                          └─ sweepInterval → sweepSessions(liveKeys) 반환값
   │                                                    │
   │                                                    └─→ [신규] SessionHistory.record()
   ▼                                                              │
src/server/admin.ts ──── localStatus(ctx, maxSlots, deps)         ▼
   │                          ├─ deps.activity() ─── 상태 판정      src/state/session-history.ts
   │                          └─ deps.history() ──── 완료 목록  ←── sessions-history.jsonl
   ▼
renderDashboard() ────── "폴더명 (W01)" + 상태 배지 + 완료 영역
```

**설계 원칙:** `admin.ts`의 순수 함수 구조를 유지한다. 새 의존성은 전부 **주입받는 인자**로
넣어 테스트에서 가짜 값을 넣을 수 있게 한다. `admin.ts`가 `http.ts`를 import하지 않는다
(순환 의존 방지).

---

## 3. ADR

```
ADR-001: 활동 시각의 출처는 전송 계층 메모리 Map으로 한다
Status: Accepted / Date: 2026-08-16 / Related REQ: REQ-STAT-001, REQ-STAT-002 / PR-001

Context:
  대시보드가 읽는 sessions.json의 lastActiveAtMs는 project_select 때만 갱신된다
  (CONFIRMED: saveSession 호출 지점이 tools.ts:1386 단 한 곳). 반면 http.ts:470은 모든
  MCP HTTP 요청마다 메모리 Map의 lastActiveAtMs를 갱신한다.

Options Considered:
  A. 모든 도구 호출에서 store.setSession()을 부른다.
     — 도구 호출마다 sessions.json 전체를 다시 쓴다. 파일 쓰기가 도구 호출 수만큼 늘고,
       동시 세션이 많을수록 쓰기 경합이 커진다. REQ-STAT-001의 "추가 디스크 쓰기 0회"에 위배.
  B. http.ts의 기존 Map을 admin에 주입한다.
     — 이미 정확하게 갱신되고 있는 값을 쓰는 것이라 새 갱신 코드가 필요 없다. 디스크 쓰기 0회.
       서버 재시작 시 값이 사라지지만, 재시작하면 세션도 전부 sweep되므로 문제가 되지 않는다.
  C. 별도 in-memory activity registry를 만들고 도구 호출 관문에서 touch한다.
     — B와 결과가 같은데 "모든 도구가 반드시 지나는 관문"을 새로 찾아 보장해야 한다.
       requireProjectLease는 리스가 필요 없는 도구를 놓칠 수 있다.

Decision: B.
Reason:
  요구되는 데이터가 이미 정확한 형태로 존재한다. 새로 만드는 것은 그 값을 admin까지
  전달하는 통로뿐이며, 추가 쓰기도 새 관문 탐색도 없다.
Consequences:
  - localStatus의 시그니처가 바뀐다 → 기존 호출부와 테스트를 함께 고쳐야 한다.
  - stdio 세션(STDIO_SESSION_KEY)은 이 Map에 없다 → 항상 "대기"로 보인다. 위험 R-04로 관리.
  - 서버 재시작 직후 모든 세션이 "대기"로 시작한다. 첫 도구 호출로 즉시 교정되므로 수용한다.
Rollback:
  주입 인자를 optional로 만든다. 넘기지 않으면 store의 lastActiveAtMs로 되돌아가고
  기존 동작과 동일해진다. 코드 삭제 없이 호출부 한 줄로 되돌릴 수 있다.
```

```
ADR-002: 완료 이력은 audit.jsonl이 아니라 별도 파일에 쌓는다
Status: Accepted / Date: 2026-08-16 / Related REQ: REQ-HIST-001, REQ-HIST-002 / PR-003

Context:
  기존 Ledger(audit.jsonl)는 append-only JSONL이고 tools.ts에서 30곳이 쓴다
  (CONFIRMED). 다만 읽기 API가 없다 — 클래스에 append() 하나뿐이다.

Options Considered:
  A. Ledger에 read/tail API를 추가하고 audit.jsonl에서 세션 이벤트를 걸러 쓴다.
     — 파일 하나로 끝나지만, audit.jsonl은 모든 도구 이벤트가 쌓여 빠르게 커진다.
       대시보드를 열 때마다 그 전체를 훑어 세션 이벤트만 골라야 하고, 보존 기간이 지난
       세션 이력을 지우려면 감사 기록까지 건드리게 된다. 감사 로그는 재작성하지 않아야 한다.
  B. src/state/session-history.ts에 sessions-history.jsonl을 따로 둔다.
     — 세션당 한 줄만 쌓이므로 작다. 보존 정리가 감사 로그와 무관해진다.
       Ledger의 파일 권한·append 방식을 그대로 본떠 쓴다.

Decision: B.
Reason:
  보존 기간에 따른 삭제가 요구사항인데(REQ-HIST-002), 감사 로그는 절대 재작성하지 않는다는
  기존 설계(ledger.ts 주석 "never rewritten")와 정면으로 부딪힌다. 파일을 분리하면 두 정책이
  서로를 침범하지 않는다.
Consequences:
  - 상태 디렉터리에 파일이 하나 늘어난다 (sessions-history.jsonl).
  - audit.jsonl은 그대로 둔다 — 이번 작업으로 감사 기록 형식이 바뀌지 않는다.
Rollback:
  파일을 지우면 이력이 빈 목록으로 표시될 뿐 서버 동작에 영향이 없다.
```

```
ADR-003: 이력 정리는 기록 시점에 임계 줄 수를 넘겼을 때만 재작성으로 한다
Status: Accepted / Date: 2026-08-16 / Related REQ: REQ-HIST-002 / PR-003

Context:
  보존 기간이 지난 레코드를 화면에서 거르기만 하면 파일은 무한히 커진다(위험 R-02).

Options Considered:
  A. 읽을 때만 필터, 파일은 그대로 둔다 — 파일이 계속 커진다.
  B. 별도 타이머로 주기 정리 — 타이머와 그 종료 처리를 새로 관리해야 한다.
  C. record() 호출 시 줄 수가 임계(HISTORY_COMPACT_THRESHOLD)를 넘으면, 보존 기간 안의
     레코드만 남겨 파일을 다시 쓴다.

Decision: C.
Reason:
  이력은 세션이 끝날 때만 늘어나므로 기록 빈도가 매우 낮다(하루 수십 줄 수준). 그 드문
  경로에 정리를 얹으면 새 타이머 없이 파일 크기가 유계가 된다.
Consequences:
  - 임계를 넘는 그 한 번의 record()가 파일 전체를 다시 쓴다. 수천 줄 규모라 무시할 수 있다.
  - 재작성 중 프로세스가 죽으면 이력 일부가 유실될 수 있다. 감사 기록이 아니라 편의용
    표시 데이터이므로 수용한다(원본 감사 기록은 audit.jsonl에 그대로 남는다).
Rollback:
  임계값을 매우 크게 잡으면 사실상 A로 되돌아간다.
```

```
ADR-004: "완료"는 sweepSessions의 반환값으로만 만든다
Status: Accepted / Date: 2026-08-16 / Related REQ: REQ-HIST-001 / PR-003

Context:
  세션 종료를 감지할 새 코드가 필요해 보이지만, sweepSessions는 이미 제거한 키 배열을
  반환하고 그 값이 버려지고 있다 (CONFIRMED: http.ts:415, 427의 `void ctx.store.sweepSessions?.()`).

Decision:
  http.ts:427의 주기 sweep에서 반환값을 받아 이력에 기록한다.
  http.ts:415의 시작 시 sweepSessions(null)은 기록하지 않는다.
Reason:
  시작 시 sweep은 이전 프로세스가 남긴 잔재를 지우는 것이라, 이를 완료로 기록하면 서버를
  켤 때마다 가짜 완료 항목이 무더기로 생긴다(위험 R-05).
Consequences:
  - 대화창을 닫아도 최대 30분(sessionTtlMs) 뒤에야 완료로 넘어간다. 즉시 반영이 아니다.
    이 지연은 화면에 그대로 드러나므로 UI 문구로 설명한다.
Rollback:
  기록 호출을 제거하면 기존 동작(반환값 버림)으로 완전히 되돌아간다.
```

---

## 4. 계약

### 4.1 도메인

```
Entity: SessionActivityStatus
Fields: "active" | "idle"
Invariants: 활동 시각을 알 수 없으면 언제나 "idle" (안전한 쪽으로 떨어진다)
Commands: 없음 (파생 값이며 직접 설정하지 않는다)
Events: 없음
허용 상태 전이: idle → active (도구 호출 시) / active → idle (ACTIVE_WINDOW_MS 경과)
금지 상태 전이: 살아있는 세션이 "done"이 되는 것 — done은 세션이 사라진 뒤에만 존재한다
```

```
Entity: SessionHistoryRecord
Fields: slot, projectName, endedAt, lastActiveAtMs
Invariants: endedAt은 서버가 찍는다(호출자 값을 믿지 않는다) — ledger.ts:60과 같은 방침
Commands: record(entries)
Events: 없음
```

### 4.2 데이터

```
파일: {stateDir}/sessions-history.jsonl
형식: JSONL — 한 줄에 레코드 하나
권한: 파일 0600, 디렉터리 0700 (ledger.ts:19-21과 동일)
Retention: 기본 7일 (ASSUMED-002). 초과분은 ADR-003의 재작성으로 제거
암호화: 없음 — 프로젝트 이름과 시각만 담기며 상태 디렉터리 자체가 0700이다

레코드 스키마:
  {
    "slot":        string,          // "W01"
    "projectName": string | null,   // 프로젝트 미선택 세션은 null
    "endedAt":     number,          // epoch ms, 서버가 기록
    "lastActiveAtMs": number        // 제거 직전의 마지막 활동 시각
  }

기록하지 않는 것: 절대 경로, sessionKey(UUID), 도구 이름, 명령어, 파일 내용
  — sessionKey는 재사용되지 않는 임의 값이고 화면에도 쓰이지 않으므로 남길 이유가 없다
```

### 4.3 API

```
Method·Path: GET /status.json
AuthN·AuthZ: 기존 오너 토큰 (변경 없음)
Params·Body: 없음
성공 상태·응답: 200 — 기존 InstanceStatus에 아래 두 가지가 더해진다

  slots[].status : "active" | "idle"        (신규 필드)
  history        : SessionHistoryRecord[]   (신규 배열, 최근순, 보존 기간 내)

오류 상태·응답: 401 { error, error_description } — 기존과 동일
멱등성·Timeout·Retry: GET이며 부수 효과 없음. 기존 PEER_TIMEOUT_MS(4000ms) 정책 유지
```

**하위 호환:** 기존 필드는 하나도 바꾸지 않고 더하기만 한다. 피어가 구버전이면 `status`와
`history`가 없는 응답이 오는데, 이때 상태는 "idle", 이력은 빈 배열로 처리한다.

```
Method·Path: GET /admin
AuthN·AuthZ: 기존 오너 토큰 + c2c_admin 쿠키 (변경 없음)
성공 상태·응답: 200 text/html — 표시 내용만 확장
오류 상태·응답: 401 로그인 HTML — 기존과 동일
```

### 4.4 오류

`N/A — 신규 오류 코드 없음.` 이번 변경은 읽기 경로만 확장하며 새 실패 모드를 사용자에게
노출하지 않는다. 내부 실패(이력 쓰기·읽기)는 전부 삼키고 기본값으로 떨어진다
(ACCEPT-STAT-002, ACCEPT-HIST-002, ACCEPT-HIST-004).

### 4.5 UI

```
Screen·Route: GET /admin
Entry Condition: 오너 토큰 인증 통과
Data Source: localStatus() 결과 (자기 인스턴스 + 피어)

상태별 처리:
  INITIAL   기존과 동일 — 30초 자동 새로고침 (admin.ts:371)
  LOADING   N/A — 서버 사이드 렌더링이라 클라이언트 로딩 상태가 없다
  SUCCESS   세션 표 + 완료 영역
  EMPTY     세션 0개: 기존 문구 유지 "연결된 세션이 없습니다..."
            완료 0건: "최근 완료된 작업이 없습니다."
  오류      피어 연결 실패는 기존 InstanceError 카드 그대로
  RETRYING  N/A — 자동 새로고침이 재시도를 대신한다

세션 표 변경:
  기존: | 슬롯 | 프로젝트 | 권한 | 모드 | 만료 |
  변경: | 세션 | 상태 | 권한 | 모드 | 만료 |
        세션 열 = "chatgpt2codex-repo (W01)"   ← 폴더명 + 슬롯 병기
        상태 열 = 진행중(초록) / 대기(회색) 배지

완료 영역 (세션 표 아래, 워크스페이스 루트 줄 위):
  "최근 완료  ·  chatgpt2codex-repo (W01) 14:32  ·  AI-Engine (W02) 13:05"
  표시 문구에 정리 지연을 명시: "대화창을 닫으면 최대 30분 뒤 완료로 넘어갑니다."

접근성:
  상태를 색으로만 구분하지 않는다 — 배지에 "진행중"/"대기" 텍스트를 함께 넣는다.
  기존 .pill 클래스 체계를 재사용한다 (admin.ts:302-304).
```

### 4.6 이벤트

`N/A — 메시지 큐나 이벤트 버스를 쓰지 않는다.` 세션 종료는 함수 직접 호출로 전달한다.

### 4.7 상태 전이

| 현재 상태 | 이벤트 | 다음 상태 | 조건 | 실패 코드 |
|---|---|---|---|---|
| (없음) | 세션 연결 | idle | — | N/A |
| idle | 도구 호출 | active | 활동 시각 갱신 | N/A |
| active | 시간 경과 | idle | now - lastActive ≥ ACTIVE_WINDOW_MS | N/A |
| idle / active | sweepSessions가 제거 | done(이력) | 주기 sweep에서만 | N/A |
| done | — | (전이 없음) | 이력은 불변, 보존 기간 후 삭제만 | N/A |

정의되지 않은 전이는 일어나지 않는다. 특히 `done → active`는 없다 — 같은 대화창을 다시
열면 새 sessionKey가 발급되어 새 세션으로 시작한다.

---

## 5. ASSUMED 목록

```
ASSUMED-001: 진행중 판정 임계값 = 90초
근거: ChatGPT가 도구를 연쇄 호출하는 간격은 보통 수 초이고, 사람이 결과를 읽고 다음
      지시를 내리는 간격은 수십 초~수 분이다. 90초는 "모델이 일하는 중"과 "사람이 읽는 중"을
      가르는 값으로 잡았다. 실측 데이터는 없다.
영향: 너무 짧으면 일하는 세션이 대기로 깜빡이고, 너무 길면 손 놓은 세션이 진행중으로 남는다.
롤백: REQ-STAT-003의 CHATGPT2CODEX_ACTIVE_WINDOW_MS로 코드 변경 없이 조정.
```

```
ASSUMED-002: 이력 보존 기간 = 7일
근거: 사용자가 "하루~며칠치"를 원했다. 7일은 그 범위의 상단이며, 주 단위로 되돌아보기에
      자연스럽다. 세션당 한 줄이라 7일치도 수백 줄을 넘지 않는다.
영향: 길면 파일이 커지고, 짧으면 지난주 작업을 못 본다.
롤백: CHATGPT2CODEX_HISTORY_RETENTION_MS로 조정.
```

```
ASSUMED-003: 이력 압축 임계 = 5000줄
근거: 세션당 한 줄이므로 정상 사용에서는 몇 달을 써도 닿지 않는다. 비정상 상황(세션이
      계속 붙었다 끊기는 루프)에서만 발동하는 안전판으로 잡았다.
영향: 낮으면 재작성이 잦고, 높으면 파일이 커진 뒤에야 정리된다.
롤백: 상수를 키우면 사실상 정리하지 않는 동작이 된다.
```

```
ASSUMED-004: 프로젝트 "폴더명"은 ProjectRegistryEntry.name으로 충분하다
근거: admin.ts:118이 이미 이 값을 프로젝트 열에 쓰고 있고, 라이브 status.json에서
      "CORP-OS" 같은 값이 확인되어 경로가 아닌 이름으로 보인다.
영향: 이 값이 폴더명과 다르면(예: package.json의 name) 화면에 다른 문자열이 나온다.
롤백: 알려진 조정 지점 #1 — 실행 에이전트가 실제 값을 확인해 필요하면 root의 basename을 쓴다.
```

---

## 6. 알려진 조정 지점

| # | 계획서의 가정 | 다를 수 있는 이유 | 실행 에이전트 확인 방법 |
|---|---|---|---|
| 1 | `ProjectRegistryEntry.name`이 폴더명이다 | 레지스트리가 package.json의 name 등 다른 값을 담을 수 있다 | `grep -rn "name:" src/workspace/` 로 레지스트리 생성 지점을 찾아 확인. 폴더명이 아니면 `basename(entry.root)`를 쓴다 |
| 2 | `http.ts`의 세션 Map 변수명이 `sessions`이고 값에 `lastActiveAtMs`가 있다 | 리팩터링으로 이름·형태가 바뀌었을 수 있다 | `grep -n "lastActiveAtMs" src/server/http.ts` (계획 작성 시점 확인: 77, 400, 401, 420, 470, 481행) |
| 3 | `registerAdminRoutes(app, ctx, {maxSlots, secureCookies})` 시그니처 | 옵션 객체에 필드가 추가/변경됐을 수 있다 | `grep -n "registerAdminRoutes" src/` 로 정의와 호출부를 모두 확인해 양쪽을 함께 고친다 |
| 4 | `sweepSessions`가 제거된 키 배열을 반환한다 | 반환 타입이 void로 바뀌었을 수 있다 | `grep -n "sweepSessions" src/state/store.ts src/types.ts` |
| 5 | 상태 디렉터리 경로가 `ctx.stateDir`로 접근된다 | 필드명이 다를 수 있다 | `grep -n "stateDir" src/types.ts` |

**위 지점에서 실제 코드가 계획과 다르면 질문하지 말고 실제 코드에 맞춰 조정하고, 조정 내용을
결과 보고에 포함하라.**

---

## 7. AUTONOMOUS / MANUAL 구간

```
[AUTONOMOUS] PR-001 ~ PR-004 전부. 코드 수정·테스트·빌드까지 사람 개입 없이 수행 가능.

[MANUAL]
1. PR #1(CSP 수정) 머지 — 누가: 저장소 소유자 / 언제: PR-001 시작 전
   없으면: PR-001을 main에서 분기할 수 없다. fix/csp-loopback-form-action 위에서 작업하면
   같은 파일(src/server/http.ts)을 두 브랜치가 건드려 머지 충돌이 난다. BLOCKED.

2. 운영 배포(맥 dist 교체 / 우분투 재빌드) — 누가: 저장소 소유자 / 언제: 전체 완료 후
   없으면: 코드는 완성되지만 실제 대시보드에는 반영되지 않는다. 맥은 sudo가 필요하다.
```
