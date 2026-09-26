import { promises as fs } from "node:fs";
import path from "node:path";
import { DomainError, ErrorCode } from "../types.js";
import { redact } from "../policy/secrets.js";
import { createFile } from "../code/patch.js";
import { defaultGitHubRunner, parseGitHubRepository, type GitHubCommandRunner } from "./github.js";
import { DEFAULT_LABELS, findProject, projectFieldGaps, type FieldGap } from "./management.js";

/**
 * The local half of development-management setup: a read-only baseline
 * survey, and scaffolding of the management files that are missing. Existing
 * files are never modified — an existing AGENTS.md gets a suggested snippet
 * back instead of an edit.
 */

export type ManagementMode = "new_project" | "existing_project";

export interface SurveyResult {
  t0: string;
  git: {
    repository?: string;
    branch?: string;
    head?: string;
    defaultBranch?: string;
    dirtyFiles: string[];
    worktrees: string[];
  };
  files: {
    agents: string[];
    issueTemplates: string[];
    pullRequestTemplate?: string;
    workflows: string[];
    managementDoc?: string;
  };
  github: {
    visibility?: string;
    hasIssuesEnabled?: boolean;
    hasProjectsEnabled?: boolean;
    viewerPermission?: string;
    tokenScopes?: string[];
    missingScopes: string[];
    labels?: { total: number; missingDefaults: string[] };
    milestones?: Array<{ number: number; title: string; state: string }>;
    openIssues?: number;
    openPullRequests?: Array<{ number: number; title: string; headRefName: string; isDraft: boolean; url: string }>;
    project?: { title: string; owner: string; found: boolean; url?: string; public?: boolean; fieldGaps?: FieldGap[] };
  };
  unavailable: Array<{ what: string; reason: string }>;
}

async function exists(file: string): Promise<boolean> {
  return fs.stat(file).then(
    () => true,
    () => false,
  );
}

async function listDir(dir: string): Promise<string[]> {
  return fs.readdir(dir).catch(() => [] as string[]);
}

function reason(error: unknown): string {
  if (error instanceof DomainError) {
    const stderr = (error.details as { stderr?: unknown } | undefined)?.stderr;
    return redact(`${error.message}${stderr ? `: ${String(stderr).trim().split("\n")[0]}` : ""}`);
  }
  return redact(error instanceof Error ? error.message : String(error));
}

export async function surveyProject(
  root: string,
  input: { projectTitle?: string; projectOwner?: string },
  runner: GitHubCommandRunner = defaultGitHubRunner,
  now: () => Date = () => new Date(),
): Promise<SurveyResult> {
  const unavailable: SurveyResult["unavailable"] = [];
  const attempt = async <T>(what: string, fn: () => Promise<T>): Promise<T | undefined> => {
    try {
      return await fn();
    } catch (error) {
      unavailable.push({ what, reason: reason(error) });
      return undefined;
    }
  };
  const git = (args: string[]): Promise<string> => runner({ cwd: root, command: "git", args });

  const result: SurveyResult = {
    t0: now().toISOString(),
    git: { dirtyFiles: [], worktrees: [] },
    files: { agents: [], issueTemplates: [], workflows: [] },
    github: { missingScopes: [] },
    unavailable,
  };

  const repository = await attempt("git origin", async () => parseGitHubRepository(await git(["config", "--get", "remote.origin.url"])));
  result.git.repository = repository;
  result.git.branch = (await attempt("current branch", () => git(["rev-parse", "--abbrev-ref", "HEAD"])))?.trim();
  result.git.head = (await attempt("HEAD sha", () => git(["rev-parse", "HEAD"])))?.trim();
  const status = await attempt("working tree status", () => git(["status", "--porcelain=v1"]));
  result.git.dirtyFiles = (status ?? "").split("\n").filter(Boolean).map((line) => line.slice(3));
  const worktrees = await attempt("worktrees", () => git(["worktree", "list", "--porcelain"]));
  result.git.worktrees = (worktrees ?? "")
    .split("\n")
    .filter((line) => line.startsWith("worktree "))
    .map((line) => line.slice("worktree ".length));

  for (const name of ["AGENTS.md", "CLAUDE.md", ".github/copilot-instructions.md"]) {
    if (await exists(path.join(root, name))) result.files.agents.push(name);
  }
  result.files.issueTemplates = (await listDir(path.join(root, ".github", "ISSUE_TEMPLATE"))).map((f) => `.github/ISSUE_TEMPLATE/${f}`);
  for (const candidate of PR_TEMPLATE_PATHS) {
    if (await exists(path.join(root, candidate))) {
      result.files.pullRequestTemplate = candidate;
      break;
    }
  }
  result.files.workflows = (await listDir(path.join(root, ".github", "workflows"))).map((f) => `.github/workflows/${f}`);
  if (await exists(path.join(root, MANAGEMENT_DOC))) result.files.managementDoc = MANAGEMENT_DOC;

  if (!repository) return result;
  const gh = (args: string[]): Promise<string> => runner({ cwd: root, command: "gh", args: [...args, "--repo", repository] });
  const ghNoRepo = (args: string[]): Promise<string> => runner({ cwd: root, command: "gh", args });

  const auth = await attempt("gh auth status", () => ghNoRepo(["auth", "status", "--hostname", "github.com"]));
  if (auth !== undefined) {
    const scopesLine = /Token scopes:\s*(.*)$/mu.exec(auth)?.[1];
    if (scopesLine !== undefined) {
      result.github.tokenScopes = [...scopesLine.matchAll(/'([^']+)'/gu)].map((m) => m[1]!);
      for (const needed of ["repo", "project"]) {
        const have = result.github.tokenScopes.some((s) => s === needed || (needed === "project" && s === "read:project"));
        if (!have) result.github.missingScopes.push(needed);
      }
      if (result.github.tokenScopes.includes("read:project") && !result.github.tokenScopes.includes("project")) {
        result.github.missingScopes.push("project (read:project is read-only; Project writes need project)");
      }
    }
  }

  const view = await attempt("repository settings", async () =>
    JSON.parse(
      await ghNoRepo([
        "repo",
        "view",
        repository,
        "--json",
        "visibility,hasIssuesEnabled,hasProjectsEnabled,viewerPermission,defaultBranchRef",
      ]),
    ) as {
      visibility: string;
      hasIssuesEnabled: boolean;
      hasProjectsEnabled: boolean;
      viewerPermission: string;
      defaultBranchRef: { name: string } | null;
    },
  );
  if (view) {
    result.github.visibility = view.visibility;
    result.github.hasIssuesEnabled = view.hasIssuesEnabled;
    result.github.hasProjectsEnabled = view.hasProjectsEnabled;
    result.github.viewerPermission = view.viewerPermission;
    result.git.defaultBranch = view.defaultBranchRef?.name;
  }

  const labels = await attempt("labels", async () => JSON.parse(await gh(["label", "list", "--limit", "1000", "--json", "name"])) as Array<{ name: string }>);
  if (labels) {
    const have = new Set(labels.map((l) => l.name.toLowerCase()));
    result.github.labels = { total: labels.length, missingDefaults: DEFAULT_LABELS.map((l) => l.name).filter((n) => !have.has(n.toLowerCase())) };
  }
  const milestones = await attempt("milestones", async () =>
    JSON.parse(await ghNoRepo(["api", `repos/${repository}/milestones?state=all&per_page=100`])) as Array<{ number: number; title: string; state: string }>,
  );
  if (milestones) result.github.milestones = milestones.map((m) => ({ number: m.number, title: m.title, state: m.state }));
  const issues = await attempt("open issues", async () => JSON.parse(await gh(["issue", "list", "--state", "open", "--limit", "5000", "--json", "number"])) as unknown[]);
  if (issues) result.github.openIssues = issues.length;
  result.github.openPullRequests = await attempt("open pull requests", async () =>
    JSON.parse(await gh(["pr", "list", "--state", "open", "--limit", "200", "--json", "number,title,headRefName,isDraft,url"])),
  );

  if (input.projectTitle) {
    const owner = input.projectOwner ?? repository.split("/")[0]!;
    const found = await attempt(`Project "${input.projectTitle}"`, () => findProject(root, owner, input.projectTitle!, runner));
    if (found) {
      result.github.project = found.project
        ? {
            title: input.projectTitle,
            owner,
            found: true,
            url: found.project.url,
            public: found.project.public,
            fieldGaps: projectFieldGaps(found.project),
          }
        : { title: input.projectTitle, owner, found: false };
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Scaffold
// ---------------------------------------------------------------------------

export const MANAGEMENT_DOC = "docs/development-management.md";
const PR_TEMPLATE_PATHS = [
  ".github/pull_request_template.md",
  ".github/PULL_REQUEST_TEMPLATE.md",
  "PULL_REQUEST_TEMPLATE.md",
  "docs/pull_request_template.md",
  "docs/PULL_REQUEST_TEMPLATE.md",
];

export interface ScaffoldInput {
  mode: ManagementMode;
  productName: string;
  workername: string;
  repository: string;
  projectTitle?: string;
  includeWorkflow?: boolean;
  dryRun?: boolean;
}

export interface ScaffoldResult {
  created: string[];
  skipped: Array<{ path: string; reason: string }>;
  agentsSnippet?: string;
  dryRun: boolean;
}

function managementDoc(input: ScaffoldInput): string {
  const project = input.projectTitle ?? "(통합 Project 미지정)";
  const migration =
    input.mode === "existing_project"
      ? `
## 이관 규칙 (기존 프로젝트)

- 실행 모드는 \`PREPARE_MIGRATION\`. GitHub 단독 운영 전환, 기존 연동 중단, 원본 보관·삭제는 별도 승인 사항이다.
- 원본 조회 시각 T0와 원본 ID·URL·updatedAt/해시를 대응표에 보존한다. 대응표는 Git이 아닌 chatgpt2codex 상태 디렉터리(\`management/<owner>__<repo>/mapping.json\`, 권한 0600)에 둔다.
- 매칭 순서: 저장된 대응표 → Issue 본문의 원본 표식(\`<!-- chatgpt2codex:source system=… id=… -->\`) → 제목은 보조 근거일 뿐 자동 재사용하지 않는다(차단으로 보고).
- 이관 Issue는 \`migration:staged\` 라벨과 Status \`Backlog\`로 시작하며 Ready 실행 큐와 자동 개발 대상에서 제외된다.
- 원본 작성자·시각은 출처 메타데이터로만 남긴다. GitHub 생성자·시각을 위장하지 않는다.
- 과거 완료 기록은 \`historical\` 라벨로 구분하고 현재 버전 검증 완료로 취급하지 않는다.
- 검증식: 원본 대상 수 = 신규 + 재사용 + 제외 + 차단. 같은 입력 재실행 시 추가 생성 0.
- 결과 상태: \`MIGRATION_PREPARED\` / \`READY_FOR_CUTOVER\` / \`LIVE_VERIFIED\` / \`BLOCKED\`. 실제 확인한 단계만 완료로 표시한다.
- 원본이 T0 이후 바뀌면 차이를 충돌로 보고하고 조용히 덮어쓰지 않는다.
`
      : `
## 설정 범위 (신규 프로젝트)

- 실행 모드는 \`MANAGEMENT_SETUP_ONLY\`. 제품 구현, 기본 브랜치 병합, 운영 배포는 별도 승인 사항이다.
- 결과 상태: \`SETUP_READY\`(설정 PR 준비) / \`LIVE_VERIFIED\`(승인·반영 후 실제 자동화 확인) / \`BLOCKED\`.
`;
  return `# 개발 관리 규칙 — ${input.productName}

이 문서가 개발 관리 절차의 단일 원본이다. AGENTS.md·템플릿은 이 문서를 가리키기만 한다.

- 저장소: \`${input.repository}\`
- 통합 Project: ${project}
- workername(에이전트 식별자): \`${input.workername}\` — GitHub 사용자명이 아니다. 담당자(Assignee)는 실제 GitHub 계정으로 지정한다.

## 원본과 화면

- **작업 원본**: 이 저장소의 GitHub Issues.
- **통합 화면**: GitHub Projects. 같은 Issue를 참조할 뿐 작업을 중앙 저장소에 복제하지 않는다.
- **코드·검증 근거**: PR과 CI.
- 별도 PM 앱, 중복 관리 DB, 양방향 동기화는 두지 않는다.

## 필드

Repository, Assignee, Milestone, Status, Priority만 기본 표시한다.

| Status | 의미 |
| --- | --- |
| Backlog | 범위·완료 조건이 아직 확정되지 않음 |
| Ready | 범위·완료 조건·선행 조건·실행 승인이 모두 충족됨 |
| In Progress | 작업 브랜치에서 진행 중 |
| Verify | 구현 완료, 검증 대기 |
| Done | 아래 완료 근거가 확인됨 |

- **취소**는 Done이 아니다. \`cancelled\` 라벨 + "not planned" 종료로 기록한다.
- **차단**은 Status를 바꾸지 않는다. \`blocked\` 라벨과 원인·다음 담당자·확인 시각 댓글로 기록한다.
- 불확실한 요구사항은 \`type:research\` Issue로 남기고 승인된 요구사항처럼 취급하지 않는다.

## Issue 작성

목표, 현재 근거, 포함 범위, 제외 범위, 완료 조건, 테스트 방법·대상 환경, 선행 Issue, 담당자, 다음 행동. 제품 목표 → 버전 목표(Milestone) → 상위 Issue → 검증 가능한 하위 Issue로 나눈다.

## 작업 절차 (에이전트 포함)

1. 승인된(Ready) Issue와 기존 담당/워커를 확인한다.
2. Issue별 브랜치·worktree에서 작업한다. DB·포트·임시 경로도 분리한다.
3. 변경 → 테스트 → 수정 → 재검증. 수정은 최대 3회, 기존의 더 엄격한 규칙이 우선한다. 범위 확대나 테스트 완화로 통과시키지 않는다.
4. PR 본문에는 \`Refs ${input.repository}#번호\`를 쓴다. \`Closes/Fixes/Resolves #번호\` 같은 종료 키워드와 병합 시 종료되는 Development 연결은 쓰지 않는다 — 병합이 곧 인수 완료가 아니기 때문이다.
5. PR 제출, CI 통과, 병합, 배포, 인수 완료는 서로 다른 사실이다.

## Done 근거

Done은 다음이 모두 있어야 한다. chatgpt2codex의 \`dev_management\` \`status_set\`(status=Done)이 이를 GitHub에 대조해 확인하고 Issue에 근거 댓글을 남긴다.

- Issue ID, 검증한 커밋 SHA 또는 산출물 digest(\`sha256:…\`)
- 범위 버전(Issue에 Milestone이 있으면 그 이름과 같아야 함), 환경, 검증 시각, 실행 결과 링크
- 인수 조건을 어떻게 확인했는지
- 코드 작업: 해당 SHA의 CI check run이 존재하고 모두 통과. 실행되지 않은 테스트는 통과가 아니다.
- 검증 시각이 커밋보다 이르면 오래된 근거로 거부한다. 검증 후 코드·범위가 바뀌면 다시 검증한다.
- 문서·조사 작업은 배포를 요구하지 않고 산출물 digest로 완료를 확인한다.

## Project 자동화 점검

- "Item added" → Backlog 권장.
- "Item closed"/"PR merged" → Done 자동 전환은 끄거나 검토한다. 취소·미검증 종료가 Done이 되면 안 된다.
- Done → Issue 자동 종료를 켜는 경우 순환 자동화가 생기지 않는지 확인한다.
- 공유 Project의 규칙 변경은 다른 제품에 대한 영향 범위 승인을 받는다.
${migration}
## 재개 규칙

작업이 중단되면 Issue 댓글의 마지막 근거와 PR/CI 상태에서 재개한다. 같은 입력을 다시 실행해도 Issue·댓글·관계가 중복 생성되지 않아야 한다.
`;
}

const FEATURE_TEMPLATE = `name: 기능
description: 사용자 결과를 만드는 기능 작업
labels: ["type:feature"]
body:
  - type: textarea
    id: goal
    attributes: { label: 목표, description: 누구의 어떤 문제를 해결하는가 }
    validations: { required: true }
  - type: textarea
    id: evidence
    attributes: { label: 현재 근거, description: 이 작업이 필요한 근거(코드·로그·요청 링크) }
  - type: textarea
    id: scope
    attributes: { label: 포함 범위 }
    validations: { required: true }
  - type: textarea
    id: out_of_scope
    attributes: { label: 제외 범위 }
  - type: textarea
    id: acceptance
    attributes: { label: 완료 조건, description: 인수 기준. Ready 전환에 필요 }
    validations: { required: true }
  - type: textarea
    id: test
    attributes: { label: 테스트 방법·대상 환경 }
    validations: { required: true }
  - type: input
    id: depends
    attributes: { label: 선행 Issue, placeholder: "#12, #15" }
  - type: input
    id: next
    attributes: { label: 다음 행동 }
`;

const BUG_TEMPLATE = `name: 버그
description: 현재 동작의 결함
labels: ["type:bug"]
body:
  - type: textarea
    id: actual
    attributes: { label: 현재 동작, description: 재현 절차와 실제 결과 }
    validations: { required: true }
  - type: textarea
    id: expected
    attributes: { label: 기대 동작 }
    validations: { required: true }
  - type: input
    id: version
    attributes: { label: 버전·SHA·환경 }
    validations: { required: true }
  - type: textarea
    id: evidence
    attributes: { label: 현재 근거, description: 로그·스크린샷 (비밀값 제외) }
  - type: textarea
    id: acceptance
    attributes: { label: 완료 조건 }
    validations: { required: true }
  - type: textarea
    id: test
    attributes: { label: 테스트 방법·대상 환경 }
`;

const RESEARCH_TEMPLATE = `name: 조사
description: 불확실한 요구사항 조사 — 결과는 승인된 요구사항이 아니다
labels: ["type:research"]
body:
  - type: textarea
    id: question
    attributes: { label: 확인할 질문 }
    validations: { required: true }
  - type: textarea
    id: why
    attributes: { label: 현재 근거와 불확실한 점 }
  - type: textarea
    id: acceptance
    attributes: { label: 완료 조건, description: 어떤 산출물(문서·결정 기록)이 나오면 끝나는가 }
    validations: { required: true }
`;

function prTemplate(repository: string): string {
  return `## Issue

Refs ${repository}#<번호>

<!-- 인수까지 추적하는 Issue는 Refs만 쓴다. Closes/Fixes/Resolves 는 병합 시 Issue를 닫으므로 쓰지 않는다. -->

## 변경 범위

-

## 검증 결과

- 검증 SHA:
- 환경:
- 실행 결과 링크:
- 실행하지 않은 검증과 이유:

## 위험과 복구 방법

-
`;
}

const WORKFLOW = `name: management-check

on:
  pull_request:
    types: [opened, edited, synchronize, reopened]

permissions:
  contents: read

jobs:
  refs-not-closing:
    runs-on: ubuntu-latest
    steps:
      - name: PR body uses Refs, not closing keywords
        env:
          PR_BODY: \${{ github.event.pull_request.body }}
        run: |
          if printf '%s' "$PR_BODY" | grep -Eiq '(^|[^[:alnum:]_])(close[sd]?|fix(e[sd])?|resolve[sd]?)[[:space:]]*:?[[:space:]]+([[:alnum:]_.-]+/[[:alnum:]_.-]+)?#[0-9]+'; then
            echo "PR body uses a closing keyword. Use 'Refs owner/repo#N' so merging does not close the Issue before acceptance." >&2
            exit 1
          fi
`;

function agentsFile(input: ScaffoldInput): string {
  return `# AGENTS.md

${agentsSnippet(input)}`;
}

function agentsSnippet(input: ScaffoldInput): string {
  return `## 개발 관리

- 작업 원본은 GitHub Issues, 통합 화면은 GitHub Projects, 근거는 PR·CI다. 절차는 \`${MANAGEMENT_DOC}\` 하나에만 둔다.
- workername: \`${input.workername}\` (에이전트 식별자, GitHub 사용자명 아님)
- Ready Issue만 작업한다. \`migration:staged\` 는 실행 대상이 아니다.
- PR 본문은 \`Refs ${input.repository}#번호\`. 종료 키워드를 쓰지 않는다.
- Done은 검증 SHA·범위 버전·환경·시각·실행 링크·인수 확인이 있을 때만. 취소는 Done이 아니다.
`;
}

/** Write each management file only where nothing equivalent exists. */
export async function scaffoldManagementFiles(root: string, input: ScaffoldInput): Promise<ScaffoldResult> {
  const created: string[] = [];
  const skipped: ScaffoldResult["skipped"] = [];
  let snippet: string | undefined;

  const plan: Array<{ path: string; content: string; equivalents?: string[] }> = [
    { path: MANAGEMENT_DOC, content: managementDoc(input) },
    { path: ".github/ISSUE_TEMPLATE/feature.yml", content: FEATURE_TEMPLATE },
    { path: ".github/ISSUE_TEMPLATE/bug.yml", content: BUG_TEMPLATE },
    { path: ".github/ISSUE_TEMPLATE/research.yml", content: RESEARCH_TEMPLATE },
    { path: ".github/pull_request_template.md", content: prTemplate(input.repository), equivalents: PR_TEMPLATE_PATHS },
  ];
  if (input.includeWorkflow !== false) {
    plan.push({ path: ".github/workflows/management-check.yml", content: WORKFLOW });
  }

  const agentsExists = await exists(path.join(root, "AGENTS.md"));
  if (agentsExists) {
    const current = await fs.readFile(path.join(root, "AGENTS.md"), "utf8");
    if (current.includes(MANAGEMENT_DOC)) {
      skipped.push({ path: "AGENTS.md", reason: `already references ${MANAGEMENT_DOC}` });
    } else {
      snippet = agentsSnippet(input);
      skipped.push({ path: "AGENTS.md", reason: "exists; not modified — merge agentsSnippet by hand or with file_apply_patch" });
    }
  } else {
    plan.push({ path: "AGENTS.md", content: agentsFile(input) });
  }

  for (const item of plan) {
    const equivalents = item.equivalents ?? [item.path];
    let existing: string | undefined;
    for (const candidate of equivalents) {
      if (await exists(path.join(root, candidate))) {
        existing = candidate;
        break;
      }
    }
    if (existing) {
      skipped.push({ path: item.path, reason: existing === item.path ? "exists; not modified" : `equivalent exists: ${existing}` });
      continue;
    }
    if (!input.dryRun) await createFile(root, item.path, item.content, false);
    created.push(item.path);
  }
  return { created, skipped, agentsSnippet: snippet, dryRun: input.dryRun === true };
}

const BRANCH_NAME = /^(?!.*\.\.)(?!.*\/\/)(?!.*@\{)[A-Za-z0-9][A-Za-z0-9._/-]{0,99}(?<![./])$/u;

/**
 * Start a management branch from the current HEAD. Uncommitted changes stay
 * in the working tree and are reported, never stashed or reset — commit the
 * management files by path so they are not mixed in.
 */
export async function createManagementBranch(
  root: string,
  branch: string,
  runner: GitHubCommandRunner = defaultGitHubRunner,
): Promise<{ branch: string; from: string; carriedUncommitted: string[] }> {
  if (!BRANCH_NAME.test(branch) || branch.endsWith(".lock")) {
    throw new DomainError(ErrorCode.COMMAND_NOT_ALLOWED, "Invalid branch name");
  }
  const git = (args: string[]): Promise<string> => runner({ cwd: root, command: "git", args });
  const existing = await git(["branch", "--list", branch]);
  if (existing.trim()) throw new DomainError(ErrorCode.COMMAND_NOT_ALLOWED, `Branch ${branch} already exists; reuse it instead of recreating it.`);
  const from = (await git(["rev-parse", "HEAD"])).trim();
  const dirty = (await git(["status", "--porcelain=v1"])).split("\n").filter(Boolean).map((line) => line.slice(3));
  await git(["switch", "-c", branch]);
  return { branch, from, carriedUncommitted: dirty };
}
