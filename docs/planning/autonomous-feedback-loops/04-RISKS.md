# 04 — 위험

점수 = Probability × Impact × Detectability, 각 1~5. D는 5가 탐지하기 어려움.
`1~15 R1 / 16~35 R2 / 36~75 R3 / 76~125 R4`.

| ID | 위험 | P | I | D | 점수 | 등급 | 예방 | 복구 |
|---|---|---:|---:|---:|---:|---|---|---|
| R-01 | stale passed report로 수정 후 코드를 완료 처리 | 3 | 4 | 3 | 36 | R3 | diff hash 일치 강제 | 최신 verification 재실행 |
| R-02 | E2E 서버 process가 실패 뒤 남음 | 3 | 3 | 2 | 18 | R2 | runner `finally`에서 process group 종료 | pid/runId로 stop |
| R-03 | 같은 실패를 무한 수정 | 3 | 3 | 2 | 18 | R2 | fingerprint 2회, attempt/turn 상한 | exhausted 후 사람 검토 |
| R-04 | 프로필 명령으로 guard 우회 | 2 | 5 | 3 | 30 | R2 | commandId discovery + 기존 guard | 실행 전 거부 |
| R-05 | background가 interactive 작업과 동시 편집 | 3 | 5 | 3 | 45 | R3 | synthetic session lease | job 취소, checkpoint restore |
| R-06 | provider 요청·로그에 API key 노출 | 2 | 5 | 4 | 40 | R3 | env-only, header 미기록, redaction 검사 | key 폐기·재발급 |
| R-07 | 모델이 push/deploy/control을 실행 | 3 | 5 | 2 | 30 | R2 | 7-operation allowlist | blocked + checkpoint restore |
| R-08 | crash 경계에서 patch/command 중복 실행 | 3 | 4 | 4 | 48 | R3 | write-ahead invocation + mutation contract + non-idempotent operation block | checkpoint restore |
| R-09 | 비용 계산 누락으로 무제한 API 사용 | 2 | 5 | 3 | 30 | R2 | 가격표/usage 기반 soft cap + 사용량 기반 hard check | cancel, API usage sentinel 확인 |
| R-10 | cancel 뒤 늦은 provider 응답이 tool 실행 | 2 | 5 | 4 | 40 | R3 | 응답 처리 전 status 재조회 | job cancelled 유지, 결과 폐기 |
| R-11 | 사용자가 같은 ChatGPT 웹 대화가 재개된다고 오해 | 4 | 3 | 2 | 24 | R2 | 제품 명칭·UI에 별도 API 세션 명시 | background 비활성 |
| R-12 | job 상태 파일 손상으로 작업 유실 | 2 | 4 | 3 | 24 | R2 | Zod + atomic rename | 손상 job 격리, checkpoint 보존 |
| R-13 | 모델에 코드·로그가 과다 전송되어 secret 유출 | 2 | 5 | 4 | 40 | R3 | 기존 secret path 차단, 결과 redaction·size cap | job 차단, key/secret 회전 |
| R-14 | Actions에 background create가 노출되어 원격 무인 작업 활성화 | 2 | 5 | 3 | 30 | R2 | ACTION_ROUTES 제외 + catalog test | route 제거, feature flag off |
| R-15 | Responses API schema 변경으로 잘못된 tool 해석 | 2 | 4 | 3 | 24 | R2 | provider adapter와 fixture contract test | provider blocked |
| R-16 | 단일·악성 feedback을 일반 원칙으로 학습 | 3 | 4 | 4 | 48 | R3 | user-confirmed + 3건 임계값 + 반대 evidence 표시 | proposal reject |
| R-17 | Skill 개선 patch가 넓어 기존 동작을 회귀 | 3 | 4 | 3 | 36 | R3 | 한 파일·120줄 제한 + base hash + 사람 review | PR close/revert |
| R-18 | 대화·코드·로그 원문이 feedback에 영구 저장 | 2 | 5 | 4 | 40 | R3 | 구조화 요약과 evidence ID만 저장 + sentinel test | record 격리·사용자 승인 후 삭제 |

## R3 실패 모드

### R-01 — stale report

Trigger: passed report 뒤 source patch가 적용됨.
Failure: 이전 report를 최신으로 오인해 성공 반환.
Detection: report `diffHash`와 `getWorkingDiff` hash 불일치.
Recovery: phase를 VERIFYING으로 되돌리고 새 run 생성.

### R-05 — write lease 충돌

Trigger: ChatGPT 세션이 full-write lease를 가진 프로젝트에 background job이 claim.
Failure: 두 실행 주체가 같은 파일을 변경해 patch hash mismatch 또는 의미 충돌.
Detection: `assertWritable`이 synthetic session 발급 전에 `PROJECT_LOCKED`.
Recovery: job을 `blocked(reason=project_locked)` 처리하고 파일 변경 0건을 보장.

### R-06 — API key 노출

Trigger: provider error가 request headers를 포함하거나 debug object를 직렬화.
Failure: job JSON, ledger, tool result에 key가 남음.
Detection: fixture key sentinel을 전체 stateDir 산출물에서 검색하는 테스트.
Recovery: 즉시 key 폐기·재발급, 해당 산출물 삭제는 사용자 승인 후 수행.

### R-08 — 중복 mutation

Trigger: patch 성공 직후 result 저장 전 프로세스 종료.
Failure: 재시작 후 같은 patch를 다시 적용.
Detection: activeInvocation의 상태와 checkpoint id, patch hash 비교.
Recovery: hash가 이미 목표 상태면 done으로 기록; 다르면 job blocked 후 checkpoint restore 선택.

### R-10 — cancel race

Trigger: provider request in-flight 중 cancel.
Failure: response가 도착해 tool을 실행.
Detection: provider 응답 처리 직전 job store status 재조회.
Recovery: 응답 id만 audit하고 content를 폐기, cancelled 유지.

### R-13 — 모델 입력 secret

Trigger: command stderr나 read 결과에 credential 문자열 포함.
Failure: 외부 model API로 전송.
Detection: tool 결과를 provider에 넘기기 전 `redact`와 secret sentinel test.
Recovery: job blocked, credential 회전 안내, 원문은 저장하지 않음.

### R-16 — 잘못된 자기학습

Trigger: 한 번의 특수 사례나 prompt injection을 재사용 가능한 Skill 원칙으로 제안.
Failure: 이후 모든 작업에서 잘못된 행동이 반복됨.
Detection: supporting feedback 3건 미만, 사용자 확인 누락, contradicting evidence 존재 여부 검사.
Recovery: proposal을 rejected로 고정하고 Skill 파일과 Git 상태 변경 0건을 확인.

### R-17 — 과도한 Skill patch

Trigger: improver가 문제와 무관한 규칙·여러 파일을 함께 변경.
Failure: 개선과 관계없는 Agent 행동이 회귀.
Detection: 단일 `SKILL.md`, 120줄 diff, base hash, 관련 feedback ID 검증.
Recovery: PR을 merge하지 않고 close하며 이미 merge된 경우 기존 guarded revert 절차를 사람이 승인.

### R-18 — feedback 개인정보·secret 잔존

Trigger: 대화나 로그 원문을 feedback field에 복사.
Failure: 장기 상태 파일에 사용자 문장·secret·코드가 남음.
Detection: 길이 제한, redaction, fixture sentinel을 전체 improvement state에서 검색.
Recovery: record를 사용 중지·격리하고 실제 삭제는 사용자 승인 후 수행.

## 필수 보안·회귀 점검

| 항목 | 판정 |
|---|---|
| 인증 우회 | background create/cancel은 local/owner-only |
| 권한 상승 | synthetic lease preset 상한, control 금지 |
| Injection | 모델 입력은 Zod와 기존 path/command guard를 다시 통과 |
| XSS | admin 출력은 기존 escape 함수 사용 |
| CSRF | cancel form은 기존 owner session과 동일한 POST 보호 패턴 적용 |
| SSRF | verification URL은 loopback만 |
| Secret | R-06, R-13 |
| 동시성 | R-05, R-08, R-10 |
| 부분 저장 | atomic job/report writes |
| 데이터 손실 | mutation 전 checkpoint |
| 잘못된 자기학습 | user-confirmed feedback, 임계값, proposal-only, 사람 merge |
| Migration | GoalLoop v1→v2 read migration, 원문 turns 보존 |
| 외부 API 실패 | provider adapter가 blocked로 격리 |
| 기존 기능 회귀 | baseline 47 files, 563 tests가 하한 |

## 티어 재판정

MUST 12개, 예상 직접 수정·생성 25파일, migration 1개, 최고 R3 9건, R4 0건.
**티어 M 유지.**
