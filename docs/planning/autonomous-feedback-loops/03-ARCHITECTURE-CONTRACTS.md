# 03 — 아키텍처와 계약

## 1. 현재 구조

```text
ChatGPT
  │ MCP / Actions 요청
  ▼
src/server/tools.ts
  ├─ goal_loop ────────────── goals/<loopId>.loop.json
  ├─ command/local shell ──── src/exec/**
  ├─ E2E ──────────────────── src/e2e/local-e2e.ts
  └─ work queue ───────────── src/state/work-queue.ts

로컬 런타임은 요청에 응답하지만 ChatGPT 대화를 먼저 호출하지 않는다.
```

## 2. 목표 구조

```text
방법 A: 현재 ChatGPT 흐름

ChatGPT ─ goal_loop ─ GoalLoopStore + GoalStateMachine
   │                         │
   ├─ inspect/edit           ├─ currentDiffHash
   │                         └─ latestVerificationRunId
   └─ verification_run ─ VerificationRunner
                            ├─ VerificationProfileLoader
                            ├─ 기존 command/E2E guard
                            └─ VerificationReportStore
   │
   └─ feedback_record ─ FeedbackStore
           │
           └─ skill_improvement_propose ─ SkillImprovementProposalStore
                                                 │
                                                 └─ 사용자 승인 후 guarded Git/GitHub PR

방법 B: 대화 종료 후

Owner CLI/Admin ─ BackgroundJobStore ─ BackgroundExecutor
                                          ├─ OpenAIResponsesProvider
                                          ├─ BackgroundToolExecutor
                                          │    └─ 기존 domain 함수 + 동일 guard
                                          ├─ synthetic project lease
                                          └─ VerificationRunner(방법 A 공유)
```

## 3. ADR

### ADR-001 — 방법 A는 새 모델 호출기가 아니라 기존 ChatGPT 호출 흐름을 유지

Status: Accepted / Related: REQ-A-001~006

Context: `goal_loop`는 ChatGPT에게 다음 행동과 재호출 지시를 이미 반환한다.

Options:

- A. 서버가 OpenAI API를 호출해 한 MCP tool call 안에서 수리까지 끝낸다.
- B. `goal_loop` 상태기계와 `verification_run`을 제공하고 ChatGPT가 라운드를 계속 호출한다.

Decision: B.

Reason: 방법 A의 실행·수리와 improver pass는 현재 ChatGPT가 수행한다. 별도 API 비용·자격증명·
두 번째 모델 컨텍스트를 도입하지 않고, 확인된 feedback만 영속화해 다음 요청에서도 재사용한다.

Consequences: ChatGPT가 tool result 뒤 다음 tool call을 하지 않으면 루프가 멈춘다. 이 한계는
방법 B가 아니라 ChatGPT 호출 정책의 경계다.

Rollback: 새 상태 필드와 tool을 제거하면 기존 `goal_loop` 기록 동작으로 복귀한다.

### ADR-002 — 검증은 선언형 프로필과 구조화된 report로 고정

Status: Accepted / Related: REQ-A-001, REQ-A-002, REQ-A-004

Decision:

- 선택적 파일 `.chatgpt2codex/verification.json`을 프로젝트 안에서 읽는다.
- 파일이 없으면 `command_list`와 package script에서 `typecheck`, `build`, `test`를 발견한다.
- 실행 결과를 `.chatgpt2codex/verification/<runId>/report.json`에 저장한다.
- report는 현재 Git diff hash를 포함한다.
- profile 에러는 `VERIFICATION_PROFILE_INVALID`로 표준화한다.

Reason: 자연어 `lastResult`만으로는 성공 판정, stale 결과 탐지, 증거 재사용이 불가능하다.

Rollback: 프로필이 없으면 기존 명령별 수동 호출 흐름을 사용할 수 있다.

### ADR-003 — 방법 B는 ChatGPT 웹 대화가 아닌 OpenAI Responses API 세션

Status: Accepted with Product Gate / Related: REQ-B-001~004

Context: MCP와 현재 저장소의 WorkQueue는 pull-only다. 공식 ChatGPT MCP 문서에서 서버가
종료된 채팅을 먼저 시작하는 계약을 확인하지 못했다.

Options:

- A. 브라우저 자동화로 ChatGPT 입력창에 prompt를 입력한다.
- B. 비공개 ChatGPT endpoint와 소비자 세션 cookie를 사용한다.
- C. 로컬 executor가 OpenAI Responses API를 호출하고 자체 job 문맥을 소유한다.
- D. 결과를 queue에 저장하고 사용자의 다음 ChatGPT 메시지까지 기다린다.

Decision: 자동 실행은 C. API 설정이 없을 때 D는 결과 보관 경로로만 사용한다.

Reason: C만 문서화된 개발자 API, 명시적 비용, 취소·재시작·감사 계약을 제공한다.

Consequences:

- 기존 ChatGPT 웹 대화 기록과 별개의 API 세션이다.
- OpenAI API 키와 사용료가 필요하다.
- 같은 웹 대화가 MUST이면 방법 B는 구현하지 않는다.

Rollback: background feature flag를 끄고 job 파일을 보존한 채 executor를 중지한다.

### ADR-004 — background tool은 작은 전용 allowlist로 domain 함수를 호출

Status: Accepted / Related: REQ-B-003

Decision: `BackgroundToolExecutor`는 다음 7개 operation만 제공한다.

1. `code_search`
2. `file_read_slice`
3. `file_apply_patch`
4. `file_create`
5. `command_run`
6. `verification_run`
7. `repo_diff_summary`

각 operation은 새 Zod schema로 모델 입력을 검증한 뒤 `src/code/**`, `src/exec/**`,
`src/state/checkpoints.ts`, 방법 A의 verification runner를 직접 호출한다.

금지:

- SDK-private `_registeredTools` 접근 확대.
- `local_shell_run`, desktop control, Git commit/push, GitHub write, 외부 URL.
- MCP/Actions handler를 HTTP loopback으로 재호출.

Reason: 전체 tool catalog를 background에 주면 기존 remote approval 경계가 사라진다.

Rollback: allowlist에서 operation을 제거하면 저장된 job은 blocked로 끝나고 프로젝트 변경은
추가로 발생하지 않는다.

### ADR-005 — background write lock은 synthetic session lease로 재사용

Status: Accepted / Related: REQ-B-001, REQ-B-003, REQ-B-004

Decision:

- job claim 시 session key `background:<jobId>`로 `Store.setSession`을 호출한다.
- `clientId="background-runner"`, `workerName=jobId.slice(0, 12)`,
  preset은 job의 `tests-only|full-write`다.
- 기존 `assertWritable`로 다른 ChatGPT session과 충돌 여부를 검사한다.
- terminal 상태에서 `releaseSessionLease`를 호출한다.

Reason: 별도 lock 파일은 interactive session이 보지 못해 동시 편집을 막지 못한다.

Rollback: synthetic session을 release하면 기존 session map에는 schema 변경이 남지 않는다.

### ADR-006 — provider 응답과 tool 실행은 write-ahead 단계로 분리

Status: Accepted / Related: REQ-B-004

Decision:

```text
provider response 저장
→ tool invocation을 pending 상태로 저장(비멱등 mutation이면 checkpoint + mutation 계약 검증)
→ tool 실행
→ tool result 저장
→ invocation done
→ 다음 provider request
```

`invocationId`가 done이면 재시작 후 동일 tool response는 재실행하지 않는다.
mutation operation은 실행 직전 checkpoint를 만들고 invocation에 checkpoint id를 저장한다.
비멱등 mutation은 mutation hash 비교 결과가 일치하지 않으면 `blocked` 처리로 종료한다.

Reason: API 응답을 받은 뒤 프로세스가 종료되어도 안전 계약이 가능한 범위에서 tool 재실행을 억제한다.

Rollback: blocked job의 checkpoint를 기존 checkpoint restore 흐름으로 되돌릴 수 있다.

### ADR-007 — 방법 A의 학습은 feedback ledger와 사람이 승인하는 Skill PR

Status: Accepted / Related: REQ-A-005, REQ-A-006

Decision:

- 현재 ChatGPT가 실행 Agent와 improver 역할을 모두 맡는다. 별도 모델 API나 background worker를
  방법 A에 추가하지 않는다.
- 사용자가 확인한 `whatWentWrong`과 `whyItWasWrong`만 feedback record로 저장한다.
- 대화·코드·로그 원문 대신 evidence ID, redacted 요약, 관련 Skill 경로만 저장한다.
- 반복 feedback review는 같은 Skill의 확인된 feedback 3건 이상일 때 현재 대화에서 실행한다.
- 결과는 한 Skill 파일의 작은 unified diff를 담은 proposal로만 저장하고 working tree에 적용하지 않는다.
- patch 적용, commit/push, GitHub PR 생성은 기존 guarded 도구와 별도의 사용자 승인을 사용한다.
- merge 결과를 사람이 확인하기 전에는 proposal을 `adopted`로 표시하지 않는다.

Reason: Warp식 자기개선의 핵심인 피드백 재사용은 방법 A에 포함하되, 잘못된 학습이 모든 후속
작업에 확산되는 것을 사람의 review/merge gate로 차단한다.

Rollback: feedback/proposal tool을 비활성화해도 verification과 goal loop 동작은 유지되며,
저장된 proposal은 적용되지 않은 문서로 남는다.

## 4. 계약

### 4.1 VerificationProfile

```ts
interface VerificationProfile {
  version: 1;
  commands: Array<{
    commandId: string;
    timeoutSec?: number;
  }>;
  server?: {
    command: string;
    waitUrl: string;
    timeoutSec: number;
  };
  scenarios?: Array<
    | { kind: "http"; method: "GET" | "POST"; url: string; expectStatus: number }
    | { kind: "screenshot"; url?: string; appName?: string; label: string }
  >;
  limits: { maxAttempts: number; maxMinutes: number };
}
```

Invariants:

- URL은 `localhost`, `127.0.0.1`, `[::1]`만 허용.
- commandId는 `command_list`가 발견한 명령만 허용.
- `maxAttempts` 1~5, `maxMinutes` 1~120.
- command 실행 순서는 입력 순서이며 report에 그대로 남긴다.

### 4.2 VerificationReport

```ts
interface VerificationReport {
  version: 1;
  runId: string;
  projectId: string;
  attempt: number;
  startedAt: string;
  finishedAt: string;
  diffHash: string;
  verdict: "passed" | "failed" | "blocked";
  failureFingerprint?: string;
  checks: Array<{
    id: string;
    kind: "command" | "http" | "screenshot";
    status: "passed" | "failed" | "blocked";
    exitCode?: number;
    summary: string;
    evidencePaths: string[];
  }>;
}
```

`failureFingerprint`는 실패 check id, exit code, redacted summary의 SHA-256이다. 로그 원문은
fingerprint에 넣지 않는다.

### 4.3 GoalLoopDocument v2

```ts
interface GoalLoopDocumentV2 {
  version: 2;
  loopId: string;
  projectId?: string;
  phase:
    | "PLANNING"
    | "IMPLEMENTING"
    | "VERIFYING"
    | "REPAIRING"
    | "SUCCEEDED"
    | "BLOCKED"
    | "EXHAUSTED";
  maxTurns: number;
  turn: number;
  latestVerificationRunId?: string;
  currentDiffHash?: string;
  consecutiveFailureFingerprintCount: number;
  turns: GoalLoopTurn[];
}
```

v1 파일은 읽을 때 메모리에서 v2로 올리고 다음 write에 v2로 저장한다. 원본 목표 preview와
기존 turns는 보존한다.

### 4.4 FeedbackRecord와 SkillImprovementProposal

```ts
interface FeedbackRecord {
  version: 1;
  feedbackId: string;
  projectId: string;
  loopId: string;
  skillPath: string;
  whatWentWrong: string;
  whyItWasWrong: string;
  evidenceIds: string[];
  confirmedByUser: true;
  createdAt: string;
}

interface SkillImprovementProposal {
  version: 1;
  proposalId: string;
  targetProjectId: string;
  skillPath: string;
  baseHash: string;
  supportingFeedbackIds: string[];
  contradictingFeedbackIds: string[];
  summary: string;
  unifiedDiff: string;
  status: "proposed" | "approved" | "rejected" | "adopted";
  createdAt: string;
  updatedAt: string;
}
```

불변 조건:

- feedback는 `confirmedByUser=true`만 저장하며 `whyItWasWrong`은 비어 있을 수 없다.
- `skillPath`는 선택된 target project 안의 `SKILL.md` 한 개만 가리킨다.
- proposal 생성 시 파일을 수정하지 않으며 base hash가 달라지면 승인·적용을 거부한다.
- unified diff는 한 파일, 최대 120줄이며 credential·대화 원문·코드/로그 원문을 포함하지 않는다.
- supporting과 contradicting feedback을 함께 노출하고, 충돌을 해소할 수 없으면 proposal을 만들지 않는다.

파일:

- `{stateDir}/improvements/feedback/<feedbackId>.json`
- `{stateDir}/improvements/proposals/<proposalId>.json`

디렉터리 0700, 파일 0600, sibling temp + atomic rename을 사용한다.

### 4.5 BackgroundJob

```ts
type BackgroundJobStatus =
  | "queued"
  | "running"
  | "waiting_tool"
  | "verifying"
  | "succeeded"
  | "blocked"
  | "failed"
  | "cancelled";

interface BackgroundJob {
  version: 1;
  jobId: string;
  projectId: string;
  objectivePreview: string;
  status: BackgroundJobStatus;
  preset: "tests-only" | "full-write";
  model: string;
  maxTurns: number;
  maxCostUsd: number;
  deadlineAt: string;
  turn: number;
  previousResponseId?: string;
  usage: { inputTokens: number; outputTokens: number; estimatedCostUsd: number };
  activeInvocation?: BackgroundInvocation;
  latestVerificationRunId?: string;
  blockedReason?: string;
  createdAt: string;
  updatedAt: string;
}
```

파일: `{stateDir}/background/jobs/<jobId>.json`, 디렉터리 0700, 파일 0600, sibling temp +
atomic rename. objective 원문은 저장하지 않고 1000자 redacted preview만 저장한다.

### 4.6 Provider

```ts
interface ModelProvider {
  createTurn(input: {
    model: string;
    objective: string;
    previousResponseId?: string;
    toolResults: BackgroundToolResult[];
    tools: BackgroundToolDefinition[];
  }): Promise<ProviderTurn>;
}
```

`OpenAIResponsesProvider`는 `POST https://api.openai.com/v1/responses`를 사용한다.
Authorization은 `OPENAI_API_KEY`에서 요청 직전에 만들고 객체·파일·ledger에 보관하지 않는다.
요청 timeout 기본 120초, 429·5xx retry 최대 2회, retry delay는 `Retry-After`가 있을 때 그
값을 사용하고 없으면 즉시 blocked 처리한다.
`maxCostUsd` 하한은 생성 시 soft-cap(안전 잔액)과 `estimatedCostUsd`로 우선 계산한다.
정확한 초과 판정은 response usage 후 hard-check로 수행한다. usage 미제공/가격 미등록이면
`BUDGET_EXCEEDED`로 blocked 처리한다.

### 4.7 오류

신규 `ErrorCode`:

- `VERIFICATION_PROFILE_INVALID`
- `VERIFICATION_FAILED`
- `FEEDBACK_INVALID`
- `SKILL_IMPROVEMENT_BLOCKED`
- `BACKGROUND_DISABLED`
- `BACKGROUND_JOB_NOT_FOUND`
- `BACKGROUND_POLICY_BLOCKED`
- `PROVIDER_AUTH_FAILED`
- `PROVIDER_RATE_LIMITED`
- `BUDGET_EXCEEDED`

모델·도구·dashboard 결과에는 redacted message와 code만 반환한다. stack, API response header,
API key, owner token은 반환하지 않는다.

### 4.8 API와 UI

MCP tools:

- `verification_profile`
- `verification_run`
- `feedback_record`
- `skill_improvement_review`
- `skill_improvement_propose`
- `background_job_create`
- `background_job_status`
- `background_job_cancel`

Actions:

- 방법 A의 `verification_profile`, `verification_run`, `feedback_record`,
  `skill_improvement_review`, `skill_improvement_propose`를 명시적으로 노출.
- Skill patch 적용과 Git/GitHub write는 improvement Action이 직접 수행하지 않는다.
- background create/cancel은 generic Actions에서 제외하고 owner dashboard와 local CLI에서만
  호출한다.

Admin:

- `/status.json`에 `verificationRuns` 최근 10건, pending improvement proposal 최근 10건,
  `backgroundJobs` open + 최근 terminal 10건.
- `/admin`에 phase, attempt/turn, pending improvement proposal, budget, last evidence,
  cancel form을 표시.
- objective 원문, prompt, model output 원문은 표시하지 않는다.

### 4.9 상태 전이

정의되지 않은 전이는 `BACKGROUND_POLICY_BLOCKED` 또는 상태기계 오류로 거부한다.

| 현재 | 이벤트 | 다음 |
|---|---|---|
| queued | executor claim + lease 성공 | running |
| queued | lease 충돌 | blocked |
| running | provider tool call | waiting_tool |
| waiting_tool | safe tool 성공 | running |
| waiting_tool | verification_run 시작 | verifying |
| verifying | passed + final response | succeeded |
| any non-terminal | cancel | cancelled |
| any non-terminal | maxTurns/cost/deadline | blocked |
| running | provider auth 실패 | blocked |

Skill improvement proposal 전이:

| 현재 | 이벤트 | 다음 |
|---|---|---|
| proposed | 사용자 승인 기록 | approved |
| proposed | 사용자 거부 | rejected |
| approved | base hash 불일치 | proposed |
| approved | 승인된 PR merge를 사람이 확인 | adopted |

## 5. ASSUMED

### ASSUMED-001 — 방법 A 최대 검증 시도 3회

근거: 동일 실패 2회 감지와 별개로 다른 실패가 이어지는 무한 루프를 제한한다.
영향: 네 번째 수정이 필요한 작업은 exhausted로 끝난다.
롤백: profile의 `limits.maxAttempts`를 1~5 범위에서 변경한다.

### ASSUMED-002 — 방법 B는 기본 비활성

근거: 별도 API 비용과 무인 file write가 발생한다.
영향: 설치 후 설정 전에는 background job을 만들 수 없다.
롤백: 소유자가 `CHATGPT2CODEX_BACKGROUND=1`을 설정하고 서버를 재시작한다.

### ASSUMED-003 — 비용은 사용자가 반드시 지정

근거: 모델별 가격은 바뀌며 저장소가 최신 가격표를 보장할 수 없다.
영향: `maxCostUsd` 누락 시 job 생성이 실패한다.
롤백: 없음. 비용 없는 무인 실행은 허용하지 않는다.

### ASSUMED-004 — Responses API 가격 계산표는 설정 파일

근거: usage token은 응답에 있지만 USD 환산 가격은 릴리스마다 달라질 수 있다.
영향: 모델 가격이 등록되지 않으면 soft-cap을 보수적으로 계산하고 첫 응답 후 `estimatedCostUsd` 비교에서
`BUDGET_EXCEEDED`로 blocked한다. 첫 응답 전에 exact pre-flight 보장은 제공되지 않는다.
롤백: owner-only 설정에 모델별 input/output million-token 가격을 등록한다.

### ASSUMED-005 — 자동 review 임계값은 같은 Skill의 feedback 3건

근거: 단일 사례를 일반 원칙으로 과잉 일반화하지 않으면서 반복 실패를 조기에 포착한다.
영향: feedback 1~2건은 저장만 하고 proposal을 만들지 않는다.
롤백: owner-only 설정에서 2~10 범위로 조정한다.

## 6. 알려진 조정 지점

| # | 계획 가정 | 달라질 수 있는 이유 | 실행 에이전트 확인 방법 |
|---|---|---|---|
| 1 | `goal_loop` 파일이 `goals/<loopId>.loop.json` | 경로 리팩터링 | `src/server/tools.ts`의 `loopFile` 선언을 읽고 실제 경로 사용 |
| 2 | command runner가 commandId 실행을 지원 | 시그니처 변경 | `src/exec/command-runner.ts` export와 `tools.ts` 호출부를 읽어 일치 |
| 3 | checkpoint 생성 함수가 mutation 전 호출 가능 | 입력 타입 변경 | `src/state/checkpoints.ts`와 기존 tools 호출부 확인 |
| 4 | `Store.setSession`이 임의 sessionKey를 받음 | store contract 변경 | `src/state/store.ts`, `src/types.ts`의 setSession 확인 |
| 5 | Responses API가 `previous_response_id`를 지원 | 외부 API 변경 | 구현 시 공식 OpenAI Responses API 문서를 확인하고 provider adapter 내부만 조정 |
| 6 | API usage에 input/output token이 누락될 수 있음 | 응답 schema 변경 | provider fixture를 실제 공식 schema와 대조 후 missing usage 시 즉시 blocked 대응 |
| 7 | 개선 대상은 선택된 project 안의 `SKILL.md` | Skill 저장소 구조 차이 | project discovery 후 실제 Skill 경로를 사용자에게 표시하고 project 밖 경로는 거부 |
| 8 | 기존 guarded Git/GitHub 도구가 승인된 proposal 전달에 사용 가능 | 도구 계약 변경 | `src/server/tools.ts`의 git/GitHub write 승인 경계를 읽고 직접 우회하지 않음 |

위 지점에서 실제 코드가 계획과 다르면 질문하지 말고 실제 코드에 맞춰 조정하고, 조정 내용을
결과 보고에 포함한다. 단, ChatGPT 웹 push API 존재 여부가 계획과 달라졌다면 ADR-003을 새
공식 문서 근거로 갱신한 뒤 구현한다.

## 7. AUTONOMOUS / MANUAL

```text
[AUTONOMOUS]
- 방법 A 전체 구현·테스트·로컬 E2E.
- 방법 A feedback 저장과 적용되지 않은 Skill improvement proposal 생성.
- 방법 B provider를 제외한 job store, policy executor, fixture 기반 통합 테스트.

[MANUAL]
1. 방법 A Skill patch 적용과 PR 생성 승인
   누가: 저장소 소유자
   입력: proposal diff, supporting/contradicting feedback, base hash
   통과: 사용자가 proposal별로 명시적으로 승인
   실패: 파일·Git 상태 변경 없이 proposed 또는 rejected 유지
2. 방법 B 제품 경계 승인
   누가: 저장소 소유자
   언제: 방법 B 구현 PR 시작 전
   선택: 별도 OpenAI API 세션을 허용
   없으면: 방법 B PR 전체 BLOCKED, 방법 A 영향 없음

3. OPENAI_API_KEY 주입
   누가: 저장소 소유자
   언제: 방법 B 실 API smoke 전
   없으면: fixture 테스트까지만 완료, 실 API QA BLOCKED

4. model·maxCostUsd·가격표 설정
   누가: 저장소 소유자
   언제: 첫 background job 생성 전
   없으면: job 생성 거부

5. 외부 배포·git push
   누가: 저장소 소유자
   언제: 전체 검증 후
   없으면: 로컬 코드만 완성, 배포되지 않음
```
