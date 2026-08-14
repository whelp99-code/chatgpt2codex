# 설계: 세션별 리스 (Per-session lease)

상태: 초안 · 대상: v0.3.0 · 작성 근거: 코드 조사 2026-08-14

---

## 1. 문제

리스(출입증)가 서버 전체에 한 장뿐입니다. `sessions.json`이 단일 문서고, 그 안에
`activeProjectId`와 `lease`가 각각 하나씩만 있습니다.

```json
{ "activeProjectId": "webapp", "lease": { "projectId": "webapp", ... } }
```

새 리스를 발급하면 이전 것을 덮어씁니다. 그래서 ChatGPT 대화창을 두 개 열면
서로의 리스를 빼앗습니다.

```
창 A: webapp 선택          → 리스 = webapp
창 B: api 선택             → 리스 = api        (A의 것이 사라짐)
창 A: 파일 수정 시도       → LEASE_REQUIRED "Active lease is for a different project"
```

창 A는 아무 잘못 없이 권한을 잃습니다. 다시 선택하면 이번엔 B가 같은 이유로
막힙니다. 결과적으로 한 번에 프로젝트 하나만 작업할 수 있습니다.

더 위험한 쪽은 조용히 성공하는 경우입니다. 창 B에서 프로젝트를 명시하지 않고
"테스트 돌려줘"라고 하면, 창 A가 잡아둔 프로젝트에서 실행됩니다. 사용자는 어느
프로젝트에서 실행됐는지 알 방법이 없습니다.

## 2. 목표

ChatGPT 대화창마다 독립적인 리스를 갖게 합니다. 창 N개가 각각 다른 프로젝트를
동시에 작업할 수 있고, 서로 간섭하지 않습니다.

비목표: 자율 실행. 서버는 여전히 스스로 작업을 시작하지 않습니다. 이 설계는
"ChatGPT가 두뇌"라는 전제를 그대로 둡니다.

## 3. 결정 사항

| 항목 | 결정 |
|---|---|
| 리스 저장 단위 | MCP 세션 ID별 |
| 프로젝트 지정 방법 | 기존 `project_select` 그대로 (이름 → 서버가 폴더 해석) |
| 새 세션의 기본 프로젝트 | 시작 기본값이 있으면 상속, 없으면 되묻기 |
| 시작 고정 옵션 | 전역 강제 → 새 세션의 기본값으로 강등 |
| 같은 프로젝트 읽기 | 여러 세션 동시 허용 |
| 같은 프로젝트 검증 | 여러 세션 동시 허용, 경고만 |
| 같은 프로젝트 쓰기 | 한 세션만, 경고 후 차단 |
| 잠금 유효 조건 | 세션 생존 **그리고** 리스 미만료 |

## 4. 데이터 모델

`sessions.json`을 세션 맵으로 바꿉니다.

```jsonc
{
  "version": 2,
  "updatedAt": 1755000000000,
  "sessions": {
    "3f2a-...": {
      "activeProjectId": "webapp",
      "mode": "edit",
      "lease": { "projectId": "webapp", "preset": "full-write", ... },
      "slot": "W01",
      "lastActiveAtMs": 1755000000000
    },
    "9b7c-...": {
      "activeProjectId": "api",
      "mode": "read",
      "lease": { "projectId": "api", "preset": "read-only", ... },
      "slot": "W02",
      "lastActiveAtMs": 1755000000000
    }
  },
  "defaults": {
    "activeProjectId": "webapp",
    "preset": "full-write"
  }
}
```

`slot`은 사람이 읽기 위한 짧은 이름입니다. 세션 ID는 UUID라 대시보드나 오류
메시지에 그대로 노출하기엔 깁니다. 비어 있는 가장 작은 번호를 배정하고, 세션이
사라지면 반납합니다.

`defaults`는 시작 고정 옵션이 들어가는 자리입니다. 전역 리스를 만드는 대신
"프로젝트를 고르지 않은 새 세션이 물려받을 값"으로 의미가 바뀝니다.

## 5. 세션 ID 전달 경로

전송 계층에는 이미 세션 ID가 있습니다.

```js
// src/server/http.ts:416
const sessionId = req.header("mcp-session-id");
const tracked = sessions.get(sessionId);
```

문제는 이 값이 상태 저장 계층까지 내려가지 않는다는 점입니다. `ToolContext`에
현재 요청의 세션 ID를 실어서 전달합니다.

```ts
interface ToolContext {
  // ...기존 필드
  /** 이 요청을 보낸 MCP 세션. stdio 모드에서는 "stdio" 고정. */
  sessionKey: string;
}
```

**이 선택이 변경 규모를 결정합니다.** `requireProjectLease(ctx, projectId, capability)`가
22곳에서 호출되는데, 전부 이미 `ctx`를 첫 인자로 받습니다. 세션 ID를 `ctx`에
실으면 **22곳은 한 줄도 바뀌지 않습니다.**

실제로 손대는 곳은 `ctx.store.getSession()` / `setSession()`을 부르는 6곳씩입니다.

```
src/server/tools.ts:93,104     세션 읽기/쓰기
src/workspace/active.ts:41     활성 프로젝트 조회
src/workspace/lease-guard.ts:30  리스 검사 ← 핵심
src/cli.ts:176,177,220,480     컨텍스트 구성, 시작 고정, 초기화
```

## 6. 잠금 정책

권한 표는 이미 존재하고 그대로 씁니다.

```js
// src/workspace/lease-guard.ts
"read-only":  ["read"]
"tests-only": ["read", "verify"]
"full-write": ["read", "verify", "write", "image", "remote"]
"image-only": ["read", "image"]
"control":    ["read", "control"]
```

`write` 능력을 가진 프리셋은 `full-write` 하나뿐입니다. 따라서 배타 잠금의
대상은 `full-write` 리스입니다.

### 검사 지점 두 곳

**리스 발급 시 (`project_select`)** — 우선 여기서 막습니다. ChatGPT가 작업 계획을
세운 뒤에 거부당하면 대화 한 턴이 낭비됩니다.

```
full-write 요청
  → 같은 프로젝트를 full-write로 잡은 살아있는 다른 세션이 있는가?
      있음 → PROJECT_LOCKED 로 거부
      없음 → 발급
```

**쓰기 직전 (`requireProjectLease(ctx, id, "write")`)** — 방어선 두 번째입니다.
발급 시점에 막았다면 여기까지 올 일이 거의 없지만, 상태가 어긋난 경우를 잡습니다.
비용이 사실상 없으므로 넣습니다.

### 오류

기존 `ErrorCode`에 잠금 전용 코드가 없어 `PERMISSION_DENIED`로 뭉뚱그려지면
"프리셋 권한 부족"과 "다른 세션이 점유 중"을 구분할 수 없습니다. 새로 추가합니다.

```ts
PROJECT_LOCKED = "PROJECT_LOCKED",
```

메시지에 점유자 정보를 함께 실어, ChatGPT가 사용자에게 원인을 설명할 수 있게
합니다. 단순히 "권한 없음"으로 끝나면 왜 안 되는지 알 수 없습니다.

```ts
throw new DomainError(
  ErrorCode.PROJECT_LOCKED,
  `${entry.name} is being edited in another session (slot ${holder.slot}, until ${hhmm}).`,
  { projectId, heldBySlot, heldSince, expiresAt, holderPreset: "full-write" },
);
```

### 검증(verify) 동시 실행

차단하지 않되 경고를 실어 보냅니다. 테스트는 다시 돌리면 되는 작업이라 차단까지
갈 필요가 없고, 결과가 이상할 때 원인을 짐작할 수 있게만 하면 충분합니다.

```
verify 요청 → 같은 프로젝트에서 verify 중인 다른 세션 있음
            → 실행은 허용
            → 응답에 warnings: ["slot W02 is also running tests on this project"]
```

빌드 산출물이 섞이거나 포트가 충돌해 실패했을 때, ChatGPT가 이 경고를 근거로
"다른 창에서도 테스트 중이라 결과가 섞였을 수 있습니다"라고 설명할 수 있습니다.

### 읽기

제한 없습니다. 다만 쓰기 세션이 있는 프로젝트를 읽을 때는 응답에 표시를 넣어,
ChatGPT가 오래된 내용으로 판단하는 것을 줄입니다.

```
warnings: ["slot W01 is editing this project; contents may change"]
```

### 승급과 강등

| 상황 | 결과 |
|---|---|
| 같은 세션이 같은 프로젝트 재선택 | 자기 자신과는 충돌하지 않음. 허용 |
| read-only → full-write, 다른 쓰기 세션 없음 | 허용 |
| read-only → full-write, 다른 쓰기 세션 있음 | PROJECT_LOCKED |
| full-write → read-only | 항상 허용. 즉시 잠금 해제 |

## 7. 생명주기 — 유령 잠금 방지

**가장 위험한 실패 모드는 창을 닫았는데 잠금이 안 풀려서 자기 프로젝트에서
자기가 잠기는 것입니다.**

잠금이 유효하려면 두 조건을 **모두** 만족해야 합니다.

1. 해당 세션이 `sessions` 맵에 살아 있을 것
2. 리스가 만료되지 않았을 것

정상 종료는 이미 처리되어 있습니다.

```js
// src/server/http.ts:461
transport.onclose = () => {
  const closedSessionId = transport?.sessionId;
  if (closedSessionId) sessions.delete(closedSessionId);
};
```

네트워크가 끊겨 정상 종료 신호가 오지 않은 경우는 만료 시간이 처리합니다.
기존 정리 주기(`http.ts:394` `sweepInterval`)에서 죽은 세션의 리스를 함께
회수하고 슬롯 번호를 반납합니다.

전송 계층의 `sessions` 맵(메모리)과 `sessions.json`(디스크)이 두 벌로 존재하게
되므로, 정리 주기가 둘을 맞추는 유일한 지점이 되도록 합니다. 서버 재시작 시에는
메모리 맵이 비어 있으므로 디스크의 모든 세션 항목을 죽은 것으로 간주해 정리합니다.

## 8. 마이그레이션

기존 `sessions.json`은 version 1의 평평한 구조입니다. 그대로 읽으면 스키마
검증에서 실패합니다. 로드 시 변환합니다.

```
version 1 발견
  → sessions: { "legacy": { 기존 activeProjectId/mode/lease } }
  → defaults: { activeProjectId: 기존 activeProjectId }
  → version 2 로 기록
```

`legacy` 항목은 살아있는 세션이 아니므로 첫 정리 주기에서 회수됩니다. 결과적으로
기존 설정은 `defaults`로만 남아 "다음 창이 물려받을 기본 프로젝트"가 됩니다.
사용자 입장에서는 지금과 같은 동작입니다.

## 9. 시작 고정 옵션의 변경

현재 `--active-project-root`는 서버가 뜨는 순간 전역 리스를 만들어 박아둡니다.

```js
// src/cli.ts:220
const lease = makeLease(entry, preset);
await ctx.store.setSession({ activeProjectId: entry.projectId, mode: "read", lease });
```

아직 아무도 접속하지 않았는데 리스가 존재하는 상태입니다. 세션별 모델에서는
이것이 성립하지 않습니다. 리스를 만들지 않고 `defaults`만 기록하도록 바꿉니다.

```js
await ctx.store.setDefaults({ activeProjectId: entry.projectId, preset });
```

새 세션이 프로젝트를 고르지 않은 채 파일 작업을 시도하면, `defaults`가 있으면
그것으로 리스를 발급하고 없으면 `PROJECT_NOT_SELECTED`로 되물립니다.

## 10. 변경 파일

| 파일 | 변경 |
|---|---|
| `src/state/store.ts` | 스키마 v2, 세션 맵, 마이그레이션, `setDefaults` |
| `src/types.ts` | `ToolContext.sessionKey`, `PROJECT_LOCKED` |
| `src/workspace/lease-guard.ts` | 세션별 조회 + 잠금 검사 |
| `src/workspace/project-select.ts` | 발급 시 잠금 검사, 슬롯 배정 |
| `src/workspace/active.ts` | 세션별 활성 프로젝트 |
| `src/server/http.ts` | `sessionKey` 주입, 정리 주기에 리스 회수 추가 |
| `src/server/tools.ts` | 세션 읽기/쓰기 2곳, 경고 필드 추가 |
| `src/cli.ts` | 시작 고정 → defaults, stdio는 `sessionKey="stdio"` |

`requireProjectLease` 호출 22곳은 **변경 없음**. 시그니처가 `ctx`를 통하기 때문입니다.

## 11. 테스트 계획

기존 418개 중 리스 관련 테스트가 세션 전역을 가정하고 있으므로 함께 갱신합니다.

새로 추가할 항목:

- 서로 다른 두 세션이 다른 프로젝트를 동시에 잡고 각자 편집에 성공
- 두 번째 세션이 같은 프로젝트에 `full-write` 요청 시 `PROJECT_LOCKED`
- 오류 상세에 점유 슬롯과 만료 시각이 포함
- 두 세션이 같은 프로젝트를 읽기로 동시 점유 성공
- 쓰기 점유 중 읽기 응답에 경고 포함
- 검증 동시 실행은 허용되고 경고만 포함
- 점유 세션이 닫히면 즉시 다른 세션이 잡을 수 있음
- 만료된 리스는 세션이 살아 있어도 잠금으로 치지 않음
- 서버 재시작 후 디스크의 옛 세션이 잠금을 유지하지 않음
- v1 `sessions.json`이 v2로 변환되고 `defaults`로 이어짐
- 같은 세션의 재선택은 자기 자신과 충돌하지 않음
- stdio 모드가 고정 `sessionKey`로 동작

## 12. 부수 발견

설계 중 발견한 기존 결함입니다. 이 작업과 함께 고치는 것이 자연스럽습니다.

`SessionSchema`의 리스 프리셋 열거형에 `control`이 빠져 있습니다.

```js
preset: z.enum(["read-only", "tests-only", "full-write", "image-only"])
```

`LeasePreset` 타입에는 `control`이 있으므로(`src/types.ts`), control 리스를
저장하려 하면 스키마 검증에서 거부됩니다. v2 스키마를 쓰면서 함께 수정합니다.

## 13. 이후 작업

이 설계가 들어가면 다음이 얹을 자리를 얻습니다. 각각 별도 작업입니다.

**대시보드** — 슬롯 맵이 그대로 화면이 됩니다. 어느 슬롯이 어느 프로젝트를
어떤 권한으로 잡고 있는지, 스크린샷의 `활성 슬롯 0/16`이 여기서 나옵니다.

**작업 큐** — "어느 슬롯의 어느 프로젝트"라는 좌표가 생겨야 작업을 배정할 수
있습니다. 지금은 좌표가 없어 얹을 곳이 없습니다.

**검증 게이트** — 편집 응답에 테스트 결과를 실어 보내는 기능. 세션별 상태가
있어야 진행률을 슬롯별로 추적할 수 있습니다.
