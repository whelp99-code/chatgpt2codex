# 01 — 저장소 조사와 Baseline

## 1. 검증 명령

`package.json`에서 직접 확인했다.

| 용도 | 명령 | 상태 |
|---|---|---|
| 타입 검사 | `npm run typecheck` | CONFIRMED |
| 빌드 | `npm run build` | CONFIRMED |
| 테스트 | `npm test` | CONFIRMED |
| Lint | N/A — 스크립트 없음 | CONFIRMED |
| Format | N/A — 스크립트 없음 | CONFIRMED |

테스트 중 `dist/cli.js`를 실행하는 항목이 있으므로 전체 검증 순서는
`npm run typecheck` → `npm run build` → `npm test`로 고정한다.

## 2. Baseline 실행 결과

2026-08-29 현재 (working tree 기준):
`main` 브랜치, `974c3d502cfb269e01579261595b9909e59094be`.

```text
npm run typecheck → exit 0
npm run build     → exit 0
npm test          → exit 0, Test Files 47 passed, Tests 563 passed
```

`git status`에서는 `.omo/`, `.serena/`, `docs/planning/autonomous-feedback-loops/`가 untracked로 확인됨.
기존 실패 없음. 계획 구현 후 발생하는 실패는 새 변경의 회귀로 취급한다.

## 3. 현재 기능 지도

| 기능 | 근거 | 판정 |
|---|---|---|
| ChatGPT 주도 반복 안내 | `src/server/tools.ts`의 `goal_intake`, `goal_loop` | CONFIRMED |
| 로컬 명령 실행 | `src/exec/command-runner.ts`, `src/exec/local-shell.ts` | CONFIRMED |
| 서버 시작·URL 준비 확인 | `src/e2e/local-e2e.ts`의 `startE2eServer` | CONFIRMED |
| 앱·URL 열기와 스크린샷 | `src/e2e/local-e2e.ts` | CONFIRMED |
| Actions 노출 | `src/server/actions.ts`의 명시적 `ACTION_ROUTES` | CONFIRMED |
| 프로젝트 작업 큐 | `src/state/work-queue.ts` | CONFIRMED |
| 세션·리스 | `src/state/store.ts`, `src/types.ts` | CONFIRMED |
| 운영 현황판 | `src/server/admin.ts` | CONFIRMED |
| 감사 기록 | `src/state/ledger.ts` | CONFIRMED |

## 4. 방법 A의 현재 단절

`goal_loop`는 라운드 번호와 `lastResult`를 파일에 기록하고 다음 도구 호출 문장을 반환한다.
그러나 다음 항목은 없다.

- 프로젝트별 검증 명세.
- 명령·로컬 시나리오 결과를 하나의 판정으로 합치는 구조화된 실행기.
- `IMPLEMENTING`, `VERIFYING`, `REPAIRING`, `SUCCEEDED`, `BLOCKED` 상태 전이.
- 동일 실패 지문 감지와 반복 중단.
- 완료 보고에 필요한 명령, 종료 코드, 로그, 스크린샷 목록의 고정 계약.
- 사람이 확인한 교정과 “왜 틀렸는지”를 구조화해 다음 요청에 재사용하는 feedback store.
- 반복 feedback을 한 Skill의 작은 patch proposal로 바꾸는 improver pass.
- Skill 변경을 자동 적용하지 않고 사람 review/merge까지 추적하는 상태 계약.

`INFERRED`: 방법 A는 새 모델 호출기가 필요하지 않다. 기존 ChatGPT 요청이 계속 도구를
호출하도록 `goal_loop` 상태와 검증 결과 계약을 강화하고, 현재 ChatGPT가 별도 단계에서
improver 역할을 수행하면 된다.

## 5. 방법 B의 현재 단절

`src/state/work-queue.ts`는 작업을 저장하지만, worker가 `goal_loop`를 호출해야만 전달한다.
소스 주석과 테스트가 이 pull-only 성질을 명시한다. 다음 항목은 없다.

- 실행 가능한 persistent job 상태.
- OpenAI API provider.
- 모델 출력의 tool call을 로컬 정책으로 재검증하는 executor.
- API 비용·토큰·라운드 한도.
- 프로세스 재시작 후 job 복구.
- 모델 API 자격증명의 안전한 로딩과 비기록 보장.

## 6. 외부 계약 확인

- OpenAI ChatGPT MCP 앱 문서:
  `https://help.openai.com/en/articles/12584461-developer-mode-and-mcp-apps-in-chatgpt-beta`
- OpenAI Apps in ChatGPT 문서:
  `https://help.openai.com/en/articles/11487775-connectors-and-mcp`

두 문서는 사용자가 채팅에서 앱을 선택하거나 언급해 도구를 호출하는 흐름을 설명한다.
서버가 종료된 ChatGPT 웹 대화를 먼저 깨우는 API 계약은 확인되지 않았다. 이 부재를
`UNKNOWN`이 아니라 방법 B의 금지 경계로 취급한다. 공식 문서에 계약이 추가되면 별도 ADR로
재검토한다.

## 7. 따라야 할 코드 패턴

- 도구 경계 입력은 Zod로 검증한다 (`src/server/tools.ts`).
- 오류는 `DomainError`와 `ErrorCode`로 전달한다 (`src/types.ts`).
- 상태 파일은 0700 디렉터리, 0600 파일, validated JSON/JSONL을 사용한다.
- subprocess는 argv 배열과 기존 guard를 사용하며 `shell: true`를 도입하지 않는다.
- 원격 세션은 control 권한을 자체 발급하지 못한다.
- Actions는 전체 MCP catalog가 아니라 명시적 allowlist로 노출한다.
- 테스트는 고정 sleep 대신 정확한 이벤트나 상태 전이를 기다린다.

## 8. 티어

MUST 12개, 예상 변경 파일 25개, migration 1개 이하, 최고 위험 R3 예상.
따라서 **티어 M**으로 판정하고 문서 6개로 분리한다.
