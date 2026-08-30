# 02 — 요구사항과 인수 기준

MUST 12개. 각 요구사항은 정상·실패 인수 기준을 가진다.

## 방법 A — 현재 ChatGPT 흐름의 실행·검증·학습 루프

### REQ-A-001 — 프로젝트 검증 프로필

Actor: ChatGPT / Trigger: 자율 루프 시작 / Precondition: 프로젝트 선택 완료 /
Input: 명령 목록, 선택적 서버 시작·준비 URL·시나리오, 라운드·시간 한도 /
Validation: 명령은 기존 command/shell guard 통과, URL은 loopback만 허용 /
Output: 정규화된 `VerificationProfile` / State: 없음 /
Failure: 프로필 부재는 발견된 package script로 안전한 기본 프로필 생성, 명시 프로필 오류는
`VERIFICATION_PROFILE_INVALID` / Security: 외부 URL과 secret 경로 금지 /
Excluded: 운영 배포·외부 서비스 호출.

- `ACCEPT-A-001-N`: Given `typecheck`, `build`, `test`가 있는 프로젝트, When 기본 프로필을
  해석, Then 순서가 `typecheck` → `build` → `test`이고 각 명령이 allowlist에 존재한다.
- `ACCEPT-A-001-F`: Given 외부 URL 또는 차단 명령이 든 프로필, When 해석,
  Then 실행 전 거부되고 subprocess가 생성되지 않는다.

### REQ-A-002 — 구조화된 검증 실행

Actor: ChatGPT / Trigger: `verification_run` 호출 / Input: projectId, profile, attempt /
Authorization: `tests-only` 이상 / Processing: 명령 순차 실행, 선택적 서버·시나리오 실행,
증거 수집, 서버 정리 / Output: `VerificationReport` /
State: 프로젝트 `.chatgpt2codex/verification/<runId>/report.json` /
Failure: 한 gate 실패 시 뒤의 mutation 없는 증거 수집만 수행하고 failed 판정 /
Performance: profile timeout과 전체 timeout 적용.

- `ACCEPT-A-002-N`: Given 모든 gate 성공, When 실행, Then `verdict=passed`, 명령별 exit 0,
  증거 경로가 프로젝트 내부에 존재하고 시작한 서버가 종료된다.
- `ACCEPT-A-002-F`: Given 두 번째 gate exit 1, When 실행, Then `verdict=failed`,
  실패 명령·redacted stderr·로그 경로가 반환되고 시작한 서버가 종료된다.

### REQ-A-003 — 목표 상태기계와 자동 수리 라운드

Actor: ChatGPT / Trigger: `goal_loop` / States:
`PLANNING → IMPLEMENTING → VERIFYING → REPAIRING → VERIFYING → SUCCEEDED|BLOCKED|EXHAUSTED` /
Input: loopId, last result, optional verification report /
Output: 정확히 한 다음 행동 묶음 / State: 기존 goal loop JSON을 versioned schema로 확장 /
Failure: 동일 실패 지문 2회 또는 maxTurns 도달 시 `EXHAUSTED`.

- `ACCEPT-A-003-N`: Given 구현 후 첫 검증 실패와 두 번째 검증 성공, When 각 보고서를
  `goal_loop`에 전달, Then `REPAIRING`, `VERIFYING`, `SUCCEEDED` 순서로 전이한다.
- `ACCEPT-A-003-F`: Given 같은 실패 지문이 2회 연속, When 두 번째 보고서를 전달,
  Then `EXHAUSTED`, `continueRequired=false`이고 추가 편집 행동을 반환하지 않는다.

### REQ-A-004 — 증거 없는 완료 금지

Actor: ChatGPT / Trigger: 완료 판정 / Precondition: 최신 verification report 존재 /
Output: 완료 상태, 실행 명령, 종료 코드, 관찰 시나리오, 증거 경로, 잔여 위험 /
Failure: report 부재·오래된 report·작업 diff 이후 생성되지 않은 report는 완료 거부.

- `ACCEPT-A-004-N`: Given 현재 diff hash와 일치하는 passed report, When 완료 판정,
  Then `SUCCEEDED`와 증거 요약을 반환한다.
- `ACCEPT-A-004-F`: Given report 생성 뒤 코드가 수정됨, When 완료 판정,
  Then `VERIFYING`으로 돌아가며 성공 문구를 반환하지 않는다.

### REQ-A-005 — 이유가 포함된 명시적 피드백 축적

Actor: 사용자와 현재 ChatGPT / Trigger: 작업 결과에 대한 사용자 교정 /
Input: projectId, loopId, 관련 Skill, `whatWentWrong`, `whyItWasWrong`, evidence runId /
Validation: 사용자가 명시적으로 확인한 교정만 허용하고 관련 verification/goal evidence 존재 확인 /
State: `{stateDir}/improvements/feedback/<feedbackId>.json` 0600 atomic file /
Output: redacted `FeedbackRecord` / Excluded: 대화 원문, 파일·로그 원문, 추론한 사용자 의도.

- `ACCEPT-A-005-N`: Given 사용자가 잘못된 결과와 이유를 설명하고 관련 runId가 존재,
  When `feedback_record`를 호출, Then 1000자 이하 redacted 요약과 evidence ID만 저장되고
  원문 대화·코드·로그는 저장되지 않는다.
- `ACCEPT-A-005-F`: Given 이유가 비어 있거나 사용자가 확인하지 않은 자동 추론,
  When 저장을 시도, Then `FEEDBACK_INVALID`로 거부되고 feedback 파일이 생성되지 않는다.

### REQ-A-006 — 작은 Skill 개선안과 사람 승인 PR

Actor: 현재 ChatGPT의 improver pass / Trigger: 같은 Skill의 재사용 가능한 feedback 3건 이상 /
Input: feedback IDs, targetProjectId, skillPath, baseHash /
Processing: 반복 원인 묶기, 충돌 evidence 표시, 단일 Skill 파일의 최소 unified diff 생성 /
Output: 적용되지 않은 `SkillImprovementProposal` /
Authorization: patch 적용과 GitHub PR 생성은 별도의 사용자 승인 필요 /
Excluded: 자동 Skill 수정, 자동 commit/push/merge, 프로젝트 밖 path.

- `ACCEPT-A-006-N`: Given 같은 원인의 확인된 feedback 3건과 현재 Skill base hash,
  When `skill_improvement_propose`를 호출, Then 한 Skill 파일만 수정하는 proposal이 저장되고
  working tree는 바뀌지 않으며 supporting/contradicting feedback ID가 모두 표시된다.
- `ACCEPT-A-006-F`: Given 서로 모순되는 feedback만 있거나 patch가 둘 이상의 파일·허용 경로 밖을
  수정, When proposal 생성, Then `SKILL_IMPROVEMENT_BLOCKED`로 거부되고 파일·Git 상태가 변하지 않는다.

## 방법 B — 백그라운드 API 에이전트

### REQ-B-001 — 지속 작업 생성과 명시적 활성화

Actor: 소유자 / Trigger: owner-only API 또는 로컬 CLI로 job 생성 /
Input: projectId, objective, verification profile, model, maxTurns, maxCostUsd /
Authorization: 로컬 호출 또는 owner token / State:
`queued → running → waiting_tool → verifying → succeeded|blocked|failed|cancelled` /
Default: 백그라운드 실행 비활성.

- `ACCEPT-B-001-N`: Given 기능 활성화와 유효 입력, When job 생성, Then 0600 상태 파일에
  `queued`로 저장되고 executor가 정확히 한 번 claim한다.
- `ACCEPT-B-001-F`: Given 기능 비활성 또는 예산 0 이하, When 생성, Then 거부되고 모델 API가
  호출되지 않는다.

### REQ-B-002 — OpenAI API 모델 라운드

Actor: background executor / Trigger: queued 또는 복구 가능한 job /
Input: objective, 직전 tool 결과, redacted evidence /
Output: 모델 메시지 또는 허용된 tool call /
State: provider response id, turn count, 누적 usage·비용 추정 /
Failure: 429·5xx는 bounded retry 후 blocked, 4xx 인증 실패는 즉시 blocked /
Security: API key는 환경·OS credential source에서만 읽고 파일·로그·모델 입력에 기록하지 않음.

- `ACCEPT-B-002-N`: Given stub provider가 tool call 뒤 final을 반환, When executor 실행,
  Then 두 응답이 같은 job에 기록되고 usage가 누적된다.
- `ACCEPT-B-002-F`: Given provider 401, When executor 실행, Then `blocked`,
  `reason=provider_auth`이고 key·Authorization header가 모든 산출물에 없다.

### REQ-B-003 — 로컬 tool call 정책 재검증

Actor: background executor / Trigger: 모델 tool call 수신 /
Authorization: job 전용 `tests-only` 또는 제한된 `full-write` lease /
Processing: 전용 allowlist, Zod input, path confinement, command guard, approval policy를
모두 통과한 호출만 실행 / Forbidden: control, push, 배포, credential, 외부 메시지 /
Failure: 거부된 호출은 모델에 정책 오류로 반환하고 job을 blocked 처리.

- `ACCEPT-B-003-N`: Given allowlisted file read와 test command, When 모델이 호출,
  Then 선택 프로젝트 안에서 실행되고 redacted 결과가 다음 모델 입력으로 전달된다.
- `ACCEPT-B-003-F`: Given `git_push`, 외부 URL 또는 프로젝트 밖 path, When 모델이 호출,
  Then 실행되지 않고 audit에 정책 코드만 남으며 job이 `blocked` 된다.

### REQ-B-004 — 재시작 복구와 예산 중단

Actor: background executor / Trigger: 프로세스 시작 또는 라운드 종료 /
Processing: stale running job을 lease 만료 후 queued로 복구, idempotency key로 tool 중복 실행
방지, maxTurns·maxCostUsd·deadline 검사 / Output: 최종 상태와 evidence summary.

- `ACCEPT-B-004-N`: Given tool 실행 결과 저장 후 프로세스 종료, When 재시작,
  Then 저장된 결과를 재사용하고 같은 tool invocation을 다시 실행하지 않는다.
- `ACCEPT-B-004-F`: Given 다음 라운드가 예산 추정치를 넘김, When 예산 검사,
  Then 첫 provider 응답 사용량을 기준으로 hard-check 후 `blocked`, `reason=cost_limit`으로 종료한다.

## 공통 기반

### REQ-C-001 — 증거·감사·비밀 경계

모든 report, job, audit에는 projectId, runId/jobId, 상태, 명령 ID, exit code, redacted 요약,
상대 증거 경로만 저장한다. prompt 원문, 파일 원문, API key, owner token, 절대 secret 경로는
저장하지 않는다.

- `ACCEPT-C-001-N`: Given 일반 실패 로그, When 저장, Then 원인과 상대 경로는 남는다.
- `ACCEPT-C-001-F`: Given 토큰 형태 문자열 포함 로그, When 저장, Then 원문이 redaction된다.

### REQ-C-002 — 소유자 관측과 중단

owner dashboard와 로컬 CLI는 active job/run, 현재 phase, attempt, 예산, 마지막 증거,
cancel 결과를 제공한다. cancel 후 새 모델·tool 호출을 시작하지 않는다.

- `ACCEPT-C-002-N`: Given running job, When status 조회, Then phase·turn·usage·last evidence가
  표시되고 objective 원문은 노출되지 않는다.
- `ACCEPT-C-002-F`: Given cancel 직후 대기 중 provider 응답 도착, When executor가 응답 처리,
  Then 결과를 폐기하고 상태를 `cancelled`로 유지한다.

## SHOULD

- 방법 A의 passed report를 방법 B의 초기 context로 재사용한다.
- Skill 개선안은 기존 prompt 문구를 누적하기보다 반복 사용 가능한 원칙 한 가지를 수정한다.
- 승인된 Skill PR이 merge된 뒤에만 해당 proposal을 `adopted`로 표시한다.
- macOS 메뉴바에서 job 상태와 cancel을 제공한다.
- 성공·blocked 시 로컬 알림을 제공하되 ChatGPT 웹 자동 입력은 하지 않는다.

## 배치 질문과 안전 기본값

`Q-001`: 방법 B가 반드시 기존 ChatGPT 웹 대화창을 자동 재개해야 하는가?

- 권장안: 아니오. 별도 OpenAI API 에이전트 세션으로 실행한다.
- 안전 기본값: API 세션으로 구현하고 결과만 dashboard에 표시한다.
- 영향: “같은 대화창”이 MUST이면 방법 B 전체가 공식 push API 확인 전 BLOCKED.

`Q-002`: 기본 모델과 비용 한도는 무엇인가?

- 권장안: 설정 필수로 두고 제품 기본값을 만들지 않는다.
- 안전 기본값: model 또는 maxCostUsd가 없으면 job 생성 거부.
- 영향: REQ-B-001, REQ-B-002, REQ-B-004.
