# GitHub 중심 개발 관리 (`dev_management`)

ChatGPT가 chatgpt2codex를 통해 선택한 프로젝트의 개발 관리 체계를 만들고 운영하는 도구다.

- **작업 원본**: 그 저장소의 GitHub Issues
- **통합 화면**: GitHub Projects(v2) — 같은 Issue를 참조만 함
- **근거**: PR과 CI

두 가지 흐름을 지원한다. 신규 프로젝트 관리 구축(`MANAGEMENT_SETUP_ONLY`)과 기존 프로젝트 전환 준비(`PREPARE_MIGRATION`)다.

저장소는 항상 프로젝트의 `origin`에서 유도한다. 호출자가 다른 저장소를 지정할 수 없다. 병합, 삭제, 강제 push, 자격증명·저장소 설정 변경은 하지 않는다.

## 호스트 준비

`gh`로 로그인한 계정을 그대로 쓴다. 기존 Issue/PR 도구([github-delivery.md](github-delivery.md))에 더해 Projects 쓰기에는 `project` 권한이 필요하다.

```bash
gh auth refresh -s project
gh auth status   # Token scopes 에 repo, project 가 보여야 함
```

ChatGPT에서는 먼저 `project_select` 를 `preset=full-write` 로 호출해야 한다. `survey`·`mapping_get`·`evidence_check` 는 읽기 권한(read lease)만으로 된다.

## 오퍼레이션

| operation | 권한 | 하는 일 |
| --- | --- | --- |
| `survey` | read | 기준선 조사: origin, 브랜치, HEAD SHA, 미커밋 파일, worktree, 기본 브랜치, AGENTS.md/템플릿/워크플로, 라벨·마일스톤, 열린 Issue 수, 열린 PR, gh 권한과 부족한 권한, Project 필드 차이. 읽지 못한 항목은 `unavailable` 에 이유와 함께 나온다. 조사 시각 `t0` 포함. |
| `scaffold` | write | **없는 관리 파일만** 만든다: `docs/development-management.md`, `.github/ISSUE_TEMPLATE/{feature,bug,research}.yml`, `.github/pull_request_template.md`, `.github/workflows/management-check.yml`(PR 본문 종료 키워드 검사, `contents: read` 권한, 외부 Action 없음), AGENTS.md(없을 때만). 기존 AGENTS.md는 수정하지 않고 `agentsSnippet` 을 돌려준다. `mode` 로 신규/기존을 고르고 `dryRun` 을 지원한다. |
| `branch_create` | write | 현재 HEAD에서 관리 브랜치 생성. 미커밋 변경은 stash/reset 하지 않고 `carriedUncommitted` 로 보고만 한다. `git_commit` 에 `paths` 로 관리 파일만 커밋한다. |
| `labels_ensure` | full-write | 기본 라벨 중 없는 것만 만든다: `type:*`, `blocked`, `cancelled`, `migration:staged`, `historical`, `test-item` |
| `milestone_ensure` | full-write | 같은 제목의 마일스톤이 있으면 재사용하고, 없으면 만든다 |
| `project_ensure` | read / full-write | 소유자·제목으로 Project를 찾고, 필드 차이와 UI에서 해야 할 설정을 알려 준다. `createIfMissing=true` 면 비공개 Project를 새로 만든다(Status: Backlog/Ready/In Progress/Verify/Done, Priority: P0–P3, 저장소 연결). 기존(공유) Project는 **옵션을 절대 바꾸지 않는다**. `addMissingFields=true` 여도 통째로 없는 필드만 추가한다. |
| `issues_upsert` | full-write | 원본 항목 → Issue 생성 또는 재사용(아래 참고). `dryRun` 기본값 **true**. |
| `mapping_get` | read | 저장된 원본→GitHub 대응표(JSON + CSV) |
| `status_set` | full-write | Project 항목 Status/Priority 설정. Ready·Done에는 아래 게이트가 걸린다 |
| `evidence_check` | read | Done 근거를 상태 변경 없이 미리 검사 |
| `issue_block` | full-write | `blocked` 라벨과 원인·다음 담당자·확인 시각 댓글을 남긴다. Status는 유지 |
| `issue_cancel` | full-write | `cancelled` 라벨을 붙이고 "not planned"로 종료. Done으로 세지 않는다 |

Draft PR은 기존 `github_pr_create`(또는 `github_delivery` `pr_create`)에 `draft: true` 를 주면 된다.

## `issues_upsert` — 중복 없는 생성·이관

각 항목은 `sourceSystem`(예: `linear`, `plan`), `sourceId`, 제목, 본문, 선택 메타데이터(URL, updatedAt/hash, 원본 작성자·시각, labels, milestone, priority)를 가진다.

매칭 순서는 다음과 같다.

1. **저장된 대응표**: chatgpt2codex 상태 디렉터리의 `management/<owner>__<repo>/mapping.json`. Git 밖에 있고 권한은 0600이다.
2. **Issue 본문의 원본 표식**: `<!-- chatgpt2codex:source system=… id=… -->`. 대응표가 없어져도 이 표식으로 이어서 진행한다.
3. `targetIssue` 로 **명시한 기존 Issue**.
4. 제목만 같은 Issue는 **같은 작업으로 보지 않고** `blocked` 로 보고한다. 재사용하려면 `targetIssue` 를 지정한다.

그 외 동작:

- `excludeReason` 을 준 항목은 `excluded` 로 처리한다. 같은 입력 안의 중복과 형식 오류는 `blocked` 로 처리한다.
- `staged=true` 면 `migration:staged` 라벨을 붙인다. `projectTitle` 을 주면 Project에 추가하고, 새 Issue는 **Backlog** 로 둔다. Ready로 넣지 않는다.
- Issue를 하나 만들 때마다 대응표를 즉시 저장한다. 중간에 끊겨도 같은 입력을 다시 실행하면 추가로 생성되는 Issue는 0개다.
- 원본의 updatedAt/hash가 이전 대응표와 다르면 `sourceChanged` 로 보고하고, 기존 Issue는 덮어쓰지 않는다.
- 결과: `counts`(input = created + reused + excluded + blocked + would_create), `reconciled`, `duplicatesOnGitHub`, `entries`(대응표 행).

원본 조회는 이 도구가 하지 않는다. ChatGPT가 Linear 등 자기 커넥터로 읽은 내용을 `items` 로 넘긴다. 이 내용은 데이터로만 다루고 명령으로 실행하지 않는다.

## Status 게이트

- **Ready** 조건: `migration:staged`·`cancelled` 라벨이 없을 것, 본문에 "완료 조건"(또는 Acceptance)이 있을 것, `readyApproved=true`(사람이 범위와 실행을 승인했다는 기록).
- **Done** 조건: 다음 필드를 가진 `evidence` 가 필요하다.
  - `kind`: `code` 또는 `document`
  - `sha` 또는 `artifactDigest`(`sha256:…`)
  - `scopeVersion`, `environment`, `verifiedAt`, `runUrl`
  - `acceptance`: 인수 조건을 어떻게 확인했는지
- **Done 검사 내용**:
  - 코드 작업은 해당 SHA가 GitHub에 있고, check run이 1개 이상 있으며, 모두 완료·통과(최소 1개 success)여야 한다.
  - 실행되지 않은 CI, 진행 중인 CI, 실패한 CI는 거부한다.
  - `verifiedAt` 이 커밋보다 이르면 오래된 근거로 거부한다.
  - Issue에 Milestone이 있으면 `scopeVersion` 이 그 이름과 같아야 한다.
  - `cancelled`·`blocked`·`migration:staged` Issue는 거부한다.
- 통과하면 Status를 바꾸고 근거 댓글을 남긴다. 거부되면 Status는 그대로다.
- PR 병합만으로는 Done이 되지 않는다. 템플릿과 워크플로가 `Refs owner/repo#N` 사용을 강제한다.

## API로 할 수 없는 것 (UI에서 직접)

GitHub API는 Project **뷰**와 **내장 워크플로 설정**을 지원하지 않는다. `project_ensure` 결과의 `manualSteps` 에 필요한 조작이 정확히 나온다:

- 뷰 만들기: 전체, 제품별, blocked, Verify
- 내장 워크플로 점검: "Item closed → Done" 등

기존 공유 Project의 Status 옵션이 모자라면, 영향 범위를 확인한 뒤 UI에서 추가하도록 안내한다.

## ChatGPT에서 쓰는 순서

### 신규 프로젝트 (`MANAGEMENT_SETUP_ONLY` → `SETUP_READY`)

1. `project_select` (full-write) → `dev_management` `survey` (`projectTitle: "JM Development"`)
2. `project_ensure`: 있으면 재사용한다. 없고 소유자가 확정됐을 때만 `createIfMissing: true`.
3. `labels_ensure` → `milestone_ensure`(버전 목표)
4. `branch_create` (`chore/dev-management`) → `scaffold` (`mode: "new_project"`) → `git_commit` (`paths` = `commitPaths`) → `git_push` → `github_pr_create` (`draft: true`, 본문에 `Refs`)
5. `issues_upsert` (`sourceSystem: "plan"`, 기획 항목별 `sourceId`): 먼저 dryRun으로 확인한 뒤 `dryRun: false`
6. 시험 항목으로 `status_set` Done 거부, `issue_cancel`, 재실행 시 생성 0을 확인하고 결과를 재조회한다.

### 기존 프로젝트 (`PREPARE_MIGRATION` → `MIGRATION_PREPARED` / `READY_FOR_CUTOVER`)

1. `survey` 로 기준선(`t0`, HEAD SHA, 미커밋 파일, 열린 PR)을 기록한다.
2. `branch_create` → `scaffold` (`mode: "existing_project"`). 기존 AGENTS.md는 `agentsSnippet` 을 `file_apply_patch` 로 병합한다.
3. 원본 항목을 `issues_upsert` (`staged: true`, `projectTitle`) dryRun으로 먼저 대조한다. 소수 대표 항목으로 실제 실행한 뒤 나머지로 확대한다.
4. `mapping_get` 으로 대응표를 확인하고 `counts.reconciled`, `duplicatesOnGitHub`, `sourceChanged` 가 모두 설명되는지 본다.
5. 운영 전환(원본 중단, `migration:staged` 해제, 기본 브랜치 병합)은 **별도 승인** 후에만 한다. 이 도구는 이를 자동으로 하지 않는다.
