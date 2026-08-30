# 05 — PR 계획

티어 M. 방법 A를 먼저 완성한 뒤 방법 B로 진행한다. 모든 PR은 `SEQUENTIAL`이다.
`src/server/tools.ts`, `src/server/admin.ts`, `src/types.ts` ownership이 겹치기 때문이다.

```text
PR-001 검증 Walking Skeleton
  → PR-002 goal_loop 상태기계
  → PR-003 방법 A feedback·Skill 개선안·노출·인수
  → MANUAL-1 별도 API 세션 승인
  → PR-004 background job/provider
  → PR-005 background safe tool executor
  → PR-006 supervisor·dashboard·인수
```

## PR-001 — 선언형 검증 Walking Skeleton

PR ID: PR-001 / Risk: R-01, R-02, R-04 / Execution: SEQUENTIAL /
Related: REQ-A-001, REQ-A-002, REQ-C-001

목적: 프로필 한 개를 읽고 명령을 실행해 report 한 개를 만드는 가장 얇은 전 레이어 흐름.

출력:

- CREATE `src/verification/types.ts`
- CREATE `src/verification/profile.ts`
- CREATE `src/verification/report-store.ts`
- CREATE `src/verification/runner.ts`
- CREATE `src/verification/profile.test.ts`
- CREATE `src/verification/runner.test.ts`
- MODIFY `src/types.ts` — 신규 ErrorCode만
- MODIFY `src/server/tools.ts` — `verification_profile`, `verification_run`
- MODIFY `src/server/tools-catalog.test.ts`

금지:

- `src/server/actions.ts`
- `src/state/work-queue.ts`
- `src/control/**`
- Git write operation

Change Budget: 직접 수정 3, 신규 6, 논리 변경 450줄, migration 0.

검증:

- `npm run typecheck` → exit 0.
- `npm run build` → exit 0.
- `npm test` → exit 0, 기존 563 + 신규 전부 통과.

### PR-001-SUB-001 — 계약과 프로필

대상:

- CREATE `src/verification/types.ts`, `src/verification/profile.ts`,
  `src/verification/profile.test.ts`
- READ_ONLY `src/exec/command-runner.ts`, `src/e2e/local-e2e.ts`
- MODIFY `src/types.ts`
- FORBIDDEN `src/server/actions.ts`, `src/control/**`

순서:

1. `03-ARCHITECTURE-CONTRACTS.md` §4.1, §4.2의 interface와 Zod schema를 정의한다.
2. `loadVerificationProfile(projectRoot, discoveredCommandIds)`를 구현한다.
3. `.chatgpt2codex/verification.json`이 없으면 discovered command 중 `typecheck`, `build`,
   `test`를 그 순서로 선택한다.
4. loopback URL, limits, commandId를 검증한다.
5. 파일 부재, 정상 파일, 외부 URL, 미발견 commandId 테스트를 작성한다.

계약:

```ts
loadVerificationProfile(
  projectRoot: string,
  discoveredCommandIds: readonly string[],
): Promise<VerificationProfile>
```

오류: 명시 파일 invalid는 `VERIFICATION_PROFILE_INVALID`. 파일 부재는 기본 profile.
Side effect: 없음.

검증: `npm run build` 후 `npm test` → exit 0.

### PR-001-SUB-002 — report store와 runner

대상:

- CREATE `src/verification/report-store.ts`, `src/verification/runner.ts`,
  `src/verification/runner.test.ts`
- READ_ONLY `src/exec/command-runner.ts`, `src/e2e/local-e2e.ts`,
  `src/state/checkpoints.ts`

순서:

1. report path를 project confinement 아래 생성하고 0600 atomic JSON으로 저장한다.
2. runner dependency bag에 command 실행, server start/stop, fetch, screenshot 함수를 주입한다.
3. command를 순차 실행하고 첫 실패를 verdict에 반영한다.
4. runner가 시작한 server는 `finally`에서 stop한다.
5. report 생성 직전에 `getWorkingDiff`를 hash한다.
6. 성공, command 실패, server 준비 실패, cleanup 테스트를 event promise로 작성한다.

계약:

```ts
runVerification(
  ctx: ToolContext,
  projectId: string,
  profile: VerificationProfile,
  attempt: number,
  deps?: VerificationRunnerDeps,
): Promise<VerificationReport>
```

검증: `npm run typecheck`, `npm run build`, `npm test` 각각 exit 0.

### PR-001-SUB-003 — MCP tools

대상:

- MODIFY `src/server/tools.ts`, `src/server/tools-catalog.test.ts`
- READ_ONLY `src/verification/**`
- FORBIDDEN `src/server/actions.ts`

순서:

1. `verification_profile`은 project lease와 발견 command를 사용해 profile 반환.
2. `verification_run`은 `tests-only` 이상을 요구하고 runner report 반환.
3. tool result에는 상대 evidence path만 넣는다.
4. catalog schema와 error mapping 테스트를 추가한다.

검증: 전체 검증 3개 명령 exit 0.

### PR-001 디스패치

```text
TASK: PR-001 — 선언형 검증 프로필을 실행해 구조화된 report를 만드는 Walking Skeleton 구현
DELIVERABLE:
- PR-001 출력 파일 diff
- typecheck/build/test 종료 코드와 테스트 수
- 계획 조정 지점
SCOPE:
- 먼저 읽기: 02 문서 REQ-A-001·002·C-001, 03 문서 ADR-002와 §4.1·4.2,
  05 문서 PR-001 전체
- 수정 허용: PR-001 출력 목록
- 수정 금지: src/server/actions.ts, src/state/work-queue.ts, src/control/**
- 실제 시그니처가 다르면 파일을 읽어 조정하고 보고한다.
- 테스트 skip, assertion 약화, ts-ignore 금지.
VERIFY: npm run typecheck && npm run build && npm test → exit 0, 실패 0
보고: WORKING / BLOCKED 형식.
```

## PR-002 — goal_loop 상태기계와 stale 방지

PR ID: PR-002 / Risk: R-01, R-03 / Execution: SEQUENTIAL /
Related: REQ-A-003, REQ-A-004

출력:

- CREATE `src/state/goal-loop.ts`
- CREATE `src/state/goal-loop.test.ts`
- MODIFY `src/server/tools.ts`
- MODIFY `src/server/tools-catalog.test.ts`

금지: `src/server/actions.ts`, background modules, verification runner 동작 변경.

Change Budget: 수정 2, 신규 2, 350줄, migration 1(v1 read → v2 write).

SUB:

1. `PR-002-SUB-001`: GoalLoopDocumentV2 Zod schema, v1 loader, atomic writer.
2. `PR-002-SUB-002`: phase transition pure function, fingerprint count, maxTurns.
3. `PR-002-SUB-003`: `goal_loop`가 verificationRunId를 받고 stale diff를 판정.
4. `PR-002-SUB-004`: REQ-A-003·004 정상·실패 테스트.

검증: typecheck/build/test exit 0.

디스패치:

```text
TASK: PR-002 — goal_loop를 검증·수리 상태기계로 확장하고 stale report 완료를 차단
DELIVERABLE: 허용 파일 diff, 전체 검증 출력, v1 fixture 보존 결과, 조정 지점
SCOPE:
- 먼저 읽기: 02 문서 REQ-A-003·004, 03 문서 §4.3, 05 문서 PR-002
- 수정 허용: src/state/goal-loop.ts, src/state/goal-loop.test.ts,
  src/server/tools.ts, src/server/tools-catalog.test.ts
- 수정 금지: src/server/actions.ts, src/verification/runner.ts, src/background/**
- 기존 loop turns와 goalPreview를 삭제하지 않는다.
VERIFY: npm run typecheck && npm run build && npm test → exit 0
보고: WORKING / BLOCKED 형식.
```

## PR-003 — 방법 A feedback·Skill 개선안·Actions·실사용 인수

PR ID: PR-003 / Risk: R-02, R-16, R-17, R-18 / Execution: SEQUENTIAL /
Related: REQ-A-001~006, REQ-C-001, REQ-C-002

출력:

- CREATE `src/improvement.ts`
- CREATE `src/improvement.test.ts`
- MODIFY `src/types.ts` — improvement ErrorCode
- MODIFY `src/server/tools.ts`
- MODIFY `src/server/tools-catalog.test.ts`
- MODIFY `src/server/actions.ts`
- MODIFY `src/server/http-actions.test.ts`
- MODIFY `src/server/admin.ts`
- MODIFY `src/server/admin.test.ts`
- MODIFY `README.md`

금지: Skill patch 자동 적용, 자동 commit/push/merge, background create/cancel Actions 노출,
대화·코드·로그 원문 저장, control policy 변경.

Change Budget: 수정 8, 신규 2, 논리 변경 700줄, migration 0.

SUB:

1. `PR-003-SUB-001`: FeedbackRecord schema, user-confirmed/why/evidence 검증, 0600 atomic store.
2. `PR-003-SUB-002`: 3건 임계값 review, contradicting evidence, 단일 Skill·120줄 proposal 검증.
3. `PR-003-SUB-003`: feedback/review/propose MCP tools와 Actions schema 추가.
4. `PR-003-SUB-004`: verification/improvement 최근 상태를 admin/status에 표시.
5. `PR-003-SUB-005`: README에 실행→교정→proposal→사람 승인 PR 흐름과 자동 적용 금지 설명.
6. `PR-003-SUB-006`: fixture에서 실패→수정→통과→feedback 3건→proposal E2E.

실사용 QA:

1. fixture 프로젝트에 실패하는 test를 둔다.
2. ChatGPT 요청에서 goal_loop → patch → verification_run을 수행한다.
3. 첫 report failed, 수정 뒤 report passed, stale report 거부를 관찰한다.
4. 사람이 확인한 `whatWentWrong`/`whyItWasWrong` feedback 3건을 기록한다.
5. 같은 Skill에 대한 proposal을 만들고 한 파일·120줄 이하인지 확인한다.
6. proposal 전후 target Skill hash와 `git diff`가 동일해 자동 적용되지 않았음을 확인한다.
7. 대화·코드·로그 원문과 secret sentinel이 improvement stateDir에 0건인지 확인한다.
8. E2E server process가 남지 않았는지 확인한다.

디스패치:

```text
TASK: PR-003 — 방법 A에 사용자 피드백 기반 Skill 개선 proposal을 추가하고 전체 흐름 인수
DELIVERABLE: 허용 파일 diff, 전체 검증 출력, feedback/proposal ID, target Skill 무변경 증거, 조정 지점
SCOPE:
- 먼저 읽기: 02 문서 REQ-A-005·006, 03 문서 ADR-007·§4.4·4.8, 04 문서 R-16~18,
  05 문서 PR-003
- 수정 허용: PR-003 출력 목록
- 수정 금지: Skill 파일 직접 변경, git commit/push/merge, background create/cancel Action,
  src/control/**
- feedback는 사용자가 확인한 what/why와 evidence ID만 저장한다.
- proposal은 target project 안의 SKILL.md 한 파일·120줄 이하이며 적용하지 않는다.
VERIFY: npm run typecheck && npm run build && npm test → exit 0;
  수동 QA에서 failed→passed→feedback→proposal과 target Skill/git 무변경 관찰
보고: WORKING / BLOCKED 형식.
```

## PR-004 — background job store와 provider adapter

사전 조건: MANUAL-1 별도 OpenAI API 세션 경계 승인.

PR ID: PR-004 / Risk: R-06, R-09, R-11, R-12, R-15 /
Related: REQ-B-001, REQ-B-002, REQ-C-001

출력:

- CREATE `src/background/types.ts`
- CREATE `src/background/job-store.ts`
- CREATE `src/background/job-store.test.ts`
- CREATE `src/background/provider.ts`
- CREATE `src/background/openai-responses.ts`
- CREATE `src/background/openai-responses.test.ts`
- MODIFY `src/types.ts`

금지: real API call in tests, API key persistence, executor/tool execution.

Change Budget: 수정 1, 신규 6, 450줄.

참고: `maxCostUsd`는 소요량 사전 정확 예측이 어려우므로 provider 응답 사용량 기반 hard-check를 통해
초과를 판정한다 (`BUDGET_EXCEEDED` 포함).

SUB:

1. `PR-004-SUB-001`: BackgroundJob schema, transition validation, 0600 atomic store.
2. `PR-004-SUB-002`: ModelProvider interface와 Responses REST adapter.
3. `PR-004-SUB-003`: fixture HTTP server로 success, 401, 429, 5xx, timeout, usage 미제공/가격 미등록, key sentinel 검사.

디스패치:

```text
사전 조건: 별도 OpenAI API 세션 방식 승인.
TASK: PR-004 — background job 영속 상태와 Responses provider adapter 구현
DELIVERABLE: 허용 파일 diff, fixture 테스트 출력, stateDir key sentinel 0건, 조정 지점
SCOPE:
- 먼저 읽기: 02 문서 REQ-B-001·002·C-001, 03 문서 ADR-003·§4.5·4.6,
  04 문서 R-06·09·12·15
- 수정 허용: PR-004 출력 목록
- 수정 금지: src/server/actions.ts, src/background/executor.ts, 실제 OpenAI API 호출 테스트
- Authorization header와 raw provider body를 저장하지 않는다.
VERIFY: npm run typecheck && npm run build && npm test → exit 0
보고: WORKING / BLOCKED 형식.
```

## PR-005 — background safe tool executor와 lease

PR ID: PR-005 / Risk: R-05, R-07, R-08, R-13 /
Related: REQ-B-003, REQ-B-004, REQ-C-001

출력:

- CREATE `src/background/tool-executor.ts`
- CREATE `src/background/tool-executor.test.ts`
- CREATE `src/background/executor.ts`
- CREATE `src/background/executor.test.ts`
- MODIFY `src/state/store.ts` 테스트 fixture가 요구할 때만 production 변경
- MODIFY `src/state/session-map.test.ts`

금지: `local_shell_run`, control, git write, GitHub write, external URL.

Change Budget: 수정 최대 2, 신규 4, 500줄.

SUB:

1. `PR-005-SUB-001`: 7-operation schema/allowlist와 domain 함수 adapter.
2. `PR-005-SUB-002`: synthetic session lease claim/release와 project lock 테스트.
3. `PR-005-SUB-003`: write-ahead invocation, checkpoint, crash-resume 정책(비멱등 mutation hash mismatch 시 blocked).
4. `PR-005-SUB-004`: provider result redaction과 secret sentinel 검사.

디스패치:

```text
TASK: PR-005 — background 모델의 tool call을 제한 실행하고 충돌·중복·secret을 차단
DELIVERABLE: 허용 파일 diff, 정책 거부·crash-resume·lease 테스트 출력, 조정 지점
SCOPE:
- 먼저 읽기: 03 문서 ADR-004~006, 04 문서 R-05·07·08·13, 05 문서 PR-005
- 수정 허용: PR-005 출력 목록
- 수정 금지: src/control/**, src/git/git.ts, src/github/**, src/server/actions.ts
- allowlist 7개 외 operation은 실행 전에 blocked.
VERIFY: npm run typecheck && npm run build && npm test → exit 0
보고: WORKING / BLOCKED 형식.
```

## PR-006 — supervisor, owner surface, 방법 B 인수

PR ID: PR-006 / Risk: R-09, R-10, R-11, R-14 /
Related: REQ-B-001~004, REQ-C-002

출력:

- CREATE `src/background/supervisor.ts`
- CREATE `src/background/supervisor.test.ts`
- MODIFY `src/cli.ts`
- MODIFY `src/server/admin.ts`
- MODIFY `src/server/admin.test.ts`
- MODIFY `src/server/actions.ts` — background route가 없음을 catalog test로 고정
- MODIFY `src/server/tools-catalog.test.ts`
- MODIFY `README.md`

금지: generic Action에서 background create/cancel, 기본 feature enable.

Change Budget: 수정 6, 신규 2, 500줄.

SUB:

1. `PR-006-SUB-001`: feature flag, supervisor startup/shutdown, stale job recovery.
2. `PR-006-SUB-002`: local CLI create/status/cancel과 owner dashboard POST cancel.
3. `PR-006-SUB-003`: maxTurns/cost/deadline/cancel race 테스트.
4. `PR-006-SUB-004`: stub provider로 재시작 포함 end-to-end.
5. `PR-006-SUB-005`: 실제 API smoke는 MANUAL-2·3 완료 시에만 수행.

실사용 QA:

- `--help`에 background 명령과 API 세션 경계 표시.
- invalid model/cost 입력 거부.
- stub provider happy path와 blocked tool path.
- 프로세스 종료·재시작 후 중복 patch 없음.
- cancel 뒤 새 tool 호출 0건.
- 실제 API 설정이 있으면 tests-only fixture job 1건, 비용 한도 내 terminal 상태 관찰.

디스패치:

```text
TASK: PR-006 — background supervisor와 owner-only 제어면을 연결하고 재시작·취소까지 인수
DELIVERABLE: 허용 파일 diff, 전체 검증 출력, stub E2E 증거, 실제 API smoke 수행/미수행 사유
SCOPE:
- 먼저 읽기: 02 문서 REQ-B-004·C-002, 03 문서 API/UI·AUTONOMOUS/MANUAL,
  04 문서 R-09·10·11·14, 05 문서 PR-006
- 수정 허용: PR-006 출력 목록
- 수정 금지: background create/cancel Action route, default feature enable, src/control/**
- 실제 API smoke는 OPENAI_API_KEY·model·maxCostUsd가 모두 사람이 설정한 경우에만 실행.
VERIFY: npm run typecheck && npm run build && npm test → exit 0;
  CLI happy/bad/help와 stub background E2E 관찰
보고: WORKING / BLOCKED 형식.
```

## 요구사항 추적표

| REQ | Acceptance | PR | SUB | 구현 | 검증 | 상태 |
|---|---|---|---|---|---|---|
| A-001 | A-001-N/F | 001 | 001 | verification profile | 전체 테스트 | 완료 |
| A-002 | A-002-N/F | 001 | 002~003 | runner/tools | 전체 테스트 | 완료 |
| A-003 | A-003-N/F | 002 | 001~004 | goal state | 전체 테스트 | 완료 |
| A-004 | A-004-N/F | 002~003 | 003~004 | diff hash/QA | 전체+실사용 | 완료 |
| A-005 | A-005-N/F | 003 | 001,003,006 | feedback store/tool | 전체+sentinel | 완료 |
| A-006 | A-006-N/F | 003 | 002~006 | review/proposal/승인 handoff | 전체+실사용 | 완료 |
| B-001 | B-001-N/F | 004,006 | 001,001~002 | job/supervisor | 전체+CLI | 계획 |
| B-002 | B-002-N/F | 004 | 002~003 | provider | fixture HTTP | 계획 |
| B-003 | B-003-N/F | 005 | 001~002 | tool/lease | 정책 테스트 | 계획 |
| B-004 | B-004-N/F | 005~006 | 003,001~004 | resume/budget | crash E2E | 계획 |
| C-001 | C-001-N/F | 001,004,005 | 각 저장 경계 | reports/jobs | sentinel | 계획 |
| C-002 | C-002-N/F | 003,006 | admin/cancel | owner surface | UI/CLI | 계획 |

## File Ownership

| 파일 | 쓰기 PR | 순서 |
|---|---|---|
| `src/types.ts` | 001, 003, 004 | 001 후 003 후 004 |
| `src/server/tools.ts` | 001, 002, 003 | 001 후 002 후 003 |
| `src/server/actions.ts` | 003, 006 | 003 후 006 |
| `src/server/admin.ts` | 003, 006 | 003 후 006 |
| `src/cli.ts` | 006 | 단독 |
| `src/verification/**` | 001 | 단독 |
| `src/improvement.ts`, `src/improvement.test.ts` | 003 | 단독 |
| `src/background/types.ts`, `src/background/job-store.ts`, `src/background/job-store.test.ts` | 004 | 004 |
| `src/background/provider.ts`, `src/background/openai-responses.ts`, `src/background/openai-responses.test.ts` | 004 | 004 |
| `src/background/tool-executor.ts`, `src/background/tool-executor.test.ts` | 005 | 005 |
| `src/background/executor.ts`, `src/background/executor.test.ts` | 005 | 005 |
| `src/background/supervisor.ts`, `src/background/supervisor.test.ts` | 006 | 006 |

병렬 쓰기를 허용하지 않는다. PR마다 typecheck/build/test를 통과시킨 뒤 다음 PR을 시작한다.

## REVIEW LOG

### 적대적 리뷰 수정 완료

- CRITICAL F-001 — `maxCostUsd` 예측 한도 계산은 계약상 보수적 pre-flight만 가능하고 정확 판정은 사용량
  후 하드체크(`BUDGET_EXCEEDED`)로 수행하도록 수정을 완료했다.
- CRITICAL F-002 — 중복 mutation의 완전 정확한 1회성 보장은 불가하므로, 비멱등 mutation은
  해시 불일치시 `blocked`로 전환하고 `checkpoint restore`로만 회복하도록 수정했다.
- CRITICAL F-003 — `loadVerificationProfile` 시그니처/오류 코드 사용이 실제 타입과 충돌하지 않도록
  `src/types.ts` 수정 위치와 매개변수(`readonly string[]`)를 SUB-001로 이동했다.
- CRITICAL F-023 — REVIEW LOG를 실제 조치사항과 기계 검증 수치로 즉시 채워서 추적성을 보강했다.
- CRITICAL F-024 — 외부 API 문서 의존은 가격표 누락/usage 미제공 시 blocked 동작을 문서화해
  재현성 누락 위험을 제거했다.
- HIGH F-025 — A안이 단순 실행·검증 루프로 축소되어 있던 문제를 수정해 user-confirmed feedback,
  improver pass, proposal-only, 사람 승인 PR 계약을 REQ-A-005·006과 PR-003에 추가했다.
- HIGH F-026 — 잘못된 자기학습 확산을 막기 위해 feedback 3건, 반대 evidence, 단일 Skill·120줄,
  base hash, 자동 적용 금지와 사람 merge gate를 고정했다.
- LOW — `docs/planning` 내 미완성 표식과 모호 표현 스캔은 0건.

### 머신 검사 로그

- `npm run typecheck` → exit 0
- `npm run build` → exit 0
- `npm test` → exit 0 (`Test Files 47 passed`, `Tests 563 passed`)
- `git rev-parse --abbrev-ref HEAD` → `main`
- `git rev-parse HEAD` → `974c3d502cfb269e01579261595b9909e59094be`
- `git status --short` → `?? .omo/`, `?? .serena/`, `?? docs/planning/autonomous-feedback-loops/`
- 전 문서 read 기반 미완성 표식·모호 표현 스캔 → 실제 계획 본문 0건
- A안 자기개선 기준 스캔 → feedback 3건 임계값이 intake/REQ/ADR/risk/PR에 모두 존재

## CHECKPOINT — 2026-08-30 A안 구현 완료

- baseline: `974c3d502cfb269e01579261595b9909e59094be`
- 구현 완료: PR-001, PR-002, PR-003 / REQ-A-001~006
- 전체 검증: `npm run typecheck`, `npm run build`, `npm test` exit 0
- 테스트 결과: `Test Files 51 passed`, `Tests 578 passed`
- 실사용 QA: `npm:typecheck` → `npm:build` → `npm:test` 순서와 passed report 확인,
  confirmed feedback 3건 후 proposal 생성, target `SKILL.md` hash 무변경,
  invalid reason은 `FEEDBACK_INVALID`
- macOS: `.pkg` 생성과 app bundle 내 improvement module import 확인
- Ubuntu: linux x64 installer를 Ubuntu 24.04 container에 설치하고
  `recordFeedback`, `createSkillImprovementProposal` export 실행 확인
- 드리프트 조정: improvement 저장 구현을 `src/improvement.ts`와 test로 응집,
  Linux package runner를 cross-platform `pwsh`로 변경, installer 자기종료 오탐 수정
- 완료 판정 보강: tracked diff뿐 아니라 untracked 파일 path/content hash도 verification diff hash에 포함
- 다음 태스크: 방법 B는 별도 API 세션 승인 전까지 계획 상태 유지
