import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { DomainError, ErrorCode } from "../types.js";
import { redact } from "../policy/secrets.js";
import { defaultGitHubRunner, projectRepository, type GitHubCommandRunner } from "./github.js";

/**
 * GitHub-centred development management: Issues are the work source,
 * a Projects (v2) board is a view over those same Issues, PR/CI are the
 * evidence. See docs/development-management-tool.md.
 *
 * Everything here is additive and idempotent. Nothing deletes, overwrites an
 * existing Issue body, rewrites a shared Project's single-select options, or
 * marks work Done without evidence that is checked against GitHub itself.
 */

export const STATUS_OPTIONS = ["Backlog", "Ready", "In Progress", "Verify", "Done"] as const;
export type ManagementStatus = (typeof STATUS_OPTIONS)[number];
export const PRIORITY_OPTIONS = ["P0", "P1", "P2", "P3"] as const;

export const LABEL_MIGRATION_STAGED = "migration:staged";
export const LABEL_BLOCKED = "blocked";
export const LABEL_CANCELLED = "cancelled";

export interface LabelSpec {
  name: string;
  color: string;
  description: string;
}

export const DEFAULT_LABELS: readonly LabelSpec[] = [
  { name: "type:feature", color: "1d76db", description: "사용자 결과를 만드는 기능 작업" },
  { name: "type:bug", color: "d73a4a", description: "현재 동작의 결함" },
  { name: "type:research", color: "c5def5", description: "불확실한 요구사항 조사 (승인된 요구사항 아님)" },
  { name: "type:docs", color: "0075ca", description: "문서 작업" },
  { name: LABEL_BLOCKED, color: "b60205", description: "차단됨 — 원래 Status는 유지, 원인·다음 담당자·확인 시각을 댓글로 기록" },
  { name: LABEL_CANCELLED, color: "cfd3d7", description: "취소 — 완료(Done)로 계산하지 않음" },
  { name: LABEL_MIGRATION_STAGED, color: "fbca04", description: "이관 대기 — Ready 실행 큐와 자동 개발 대상에서 제외" },
  { name: "historical", color: "ededed", description: "과거 완료 기록 (현재 버전 검증 아님)" },
  { name: "test-item", color: "f9d0c4", description: "관리 설정 시험 항목" },
];

const LABEL_NAME = /^[^\s,][^,]{0,49}$/u;
const HEX_COLOR = /^[0-9a-fA-F]{6}$/u;
const OWNER_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/u;
const SOURCE_SYSTEM = /^[a-z0-9][a-z0-9_-]{0,31}$/u;
const SOURCE_ID = /^[A-Za-z0-9][A-Za-z0-9._:#/-]{0,199}$/u;
const SHA = /^[0-9a-f]{40}$/u;
const DIGEST = /^sha256:[0-9a-f]{64}$/u;

function fail(message: string, details?: Record<string, unknown>): never {
  throw new DomainError(ErrorCode.COMMAND_NOT_ALLOWED, message, details);
}

function parseJson<T>(raw: string, operation: string): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fail(`GitHub ${operation} returned invalid JSON`);
  }
}

function splitRepository(repository: string): { owner: string; name: string } {
  const [owner, name] = repository.split("/");
  return { owner: owner!, name: name! };
}

async function gh(root: string, args: string[], runner: GitHubCommandRunner, stdin?: string): Promise<string> {
  return runner({ cwd: root, command: "gh", args, stdin });
}

/** `gh api` against this project's own repository. The endpoint suffix is built here, never by the caller. */
async function repoApi(
  root: string,
  runner: GitHubCommandRunner,
  suffix: string,
  options: { method?: "GET" | "POST"; body?: unknown } = {},
): Promise<unknown> {
  const repository = await projectRepository(root, runner);
  const args = ["api", `repos/${repository}${suffix}`, "--method", options.method ?? "GET"];
  if (options.body !== undefined) args.push("--input", "-");
  const raw = await gh(root, args, runner, options.body === undefined ? undefined : JSON.stringify(options.body));
  return parseJson<unknown>(raw, `api ${suffix.split("?")[0]}`);
}

interface GraphQlResponse<T> {
  data?: T;
  errors?: Array<{ message?: string; type?: string }>;
}

async function graphql<T>(root: string, runner: GitHubCommandRunner, query: string, variables: Record<string, unknown>): Promise<T> {
  let raw: string;
  try {
    raw = await gh(root, ["api", "graphql", "--input", "-"], runner, JSON.stringify({ query, variables }));
  } catch (error) {
    const details = error instanceof DomainError ? (error.details as { stderr?: unknown } | undefined) : undefined;
    const stderr = String(details?.stderr ?? "");
    if (/INSUFFICIENT_SCOPES|scopes?\b/iu.test(stderr)) {
      fail("GitHub Projects access failed. The gh login needs the `project` scope (run `gh auth refresh -s project` on the host).", {
        stderr: redact(stderr),
      });
    }
    throw error;
  }
  const parsed = parseJson<GraphQlResponse<T>>(raw, "GraphQL");
  if (parsed.errors?.length) {
    const messages = parsed.errors.map((e) => e.message ?? e.type ?? "error").join("; ");
    const scopeHint = /scope/iu.test(messages) ? " The gh login needs the `project` scope (`gh auth refresh -s project`)." : "";
    fail(`GitHub GraphQL error: ${redact(messages)}.${scopeHint}`);
  }
  if (!parsed.data) fail("GitHub GraphQL returned no data");
  return parsed.data;
}

// ---------------------------------------------------------------------------
// Labels and milestones
// ---------------------------------------------------------------------------

export async function ensureLabels(
  root: string,
  labels: readonly LabelSpec[] = DEFAULT_LABELS,
  options: { dryRun?: boolean } = {},
  runner: GitHubCommandRunner = defaultGitHubRunner,
): Promise<{ created: string[]; reused: string[]; dryRun: boolean }> {
  for (const label of labels) {
    if (!LABEL_NAME.test(label.name) || !HEX_COLOR.test(label.color) || label.description.length > 100) {
      fail(`Invalid label spec: ${label.name}`);
    }
  }
  const repository = await projectRepository(root, runner);
  const existing = parseJson<Array<{ name: string }>>(
    await gh(root, ["label", "list", "--limit", "1000", "--json", "name", "--repo", repository], runner),
    "label list",
  );
  const have = new Set(existing.map((l) => l.name.toLowerCase()));
  const created: string[] = [];
  const reused: string[] = [];
  for (const label of labels) {
    if (have.has(label.name.toLowerCase())) {
      reused.push(label.name);
      continue;
    }
    if (!options.dryRun) {
      await gh(
        root,
        ["label", "create", label.name, "--color", label.color, "--description", label.description, "--repo", repository],
        runner,
      );
    }
    have.add(label.name.toLowerCase());
    created.push(label.name);
  }
  return { created, reused, dryRun: options.dryRun === true };
}

export async function ensureMilestone(
  root: string,
  input: { title: string; description?: string; dueOn?: string },
  options: { dryRun?: boolean } = {},
  runner: GitHubCommandRunner = defaultGitHubRunner,
): Promise<{ number?: number; title: string; url?: string; result: "created" | "reused" | "would_create" }> {
  const title = input.title.trim();
  if (!title || title.length > 100) fail("Milestone title must be 1-100 characters");
  for (let page = 1; page <= 20; page += 1) {
    const batch = (await repoApi(root, runner, `/milestones?state=all&per_page=100&page=${page}`)) as Array<{
      number: number;
      title: string;
      html_url: string;
    }>;
    const hit = batch.find((m) => m.title === title);
    if (hit) return { number: hit.number, title, url: hit.html_url, result: "reused" };
    if (batch.length < 100) break;
  }
  if (options.dryRun) return { title, result: "would_create" };
  const body: Record<string, unknown> = { title };
  if (input.description) body.description = input.description;
  if (input.dueOn) body.due_on = input.dueOn;
  const created = (await repoApi(root, runner, "/milestones", { method: "POST", body })) as {
    number: number;
    html_url: string;
  };
  return { number: created.number, title, url: created.html_url, result: "created" };
}

// ---------------------------------------------------------------------------
// Projects (v2)
// ---------------------------------------------------------------------------

interface SingleSelectField {
  id: string;
  name: string;
  options: Array<{ id: string; name: string }>;
}

export interface ProjectInfo {
  id: string;
  number: number;
  title: string;
  url: string;
  public: boolean;
  closed: boolean;
  owner: string;
  fields: SingleSelectField[];
}

const PROJECT_FIELDS_FRAGMENT = `
  id number title url public closed
  fields(first: 50) { nodes { ... on ProjectV2SingleSelectField { id name options { id name } } } }
`;

type RawProject = Omit<ProjectInfo, "owner" | "fields"> & { fields: { nodes: Array<Partial<SingleSelectField>> } };

function toProjectInfo(raw: RawProject, owner: string): ProjectInfo {
  return {
    id: raw.id,
    number: raw.number,
    title: raw.title,
    url: raw.url,
    public: raw.public,
    closed: raw.closed,
    owner,
    fields: raw.fields.nodes.filter((f): f is SingleSelectField => Boolean(f.id && f.name && f.options)),
  };
}

export async function findProject(
  root: string,
  owner: string,
  title: string,
  runner: GitHubCommandRunner = defaultGitHubRunner,
): Promise<{ ownerId: string; ownerType: "User" | "Organization"; project?: ProjectInfo; candidates: Array<{ number: number; title: string; url: string }> }> {
  if (!OWNER_LOGIN.test(owner)) fail("Invalid project owner login");
  const query = `query($login: String!, $q: String!) {
    repositoryOwner(login: $login) {
      __typename id
      ... on User { projectsV2(first: 50, query: $q) { nodes { ${PROJECT_FIELDS_FRAGMENT} } } }
      ... on Organization { projectsV2(first: 50, query: $q) { nodes { ${PROJECT_FIELDS_FRAGMENT} } } }
    }
  }`;
  const data = await graphql<{
    repositoryOwner: { __typename: "User" | "Organization"; id: string; projectsV2?: { nodes: RawProject[] } } | null;
  }>(root, runner, query, { login: owner, q: title });
  if (!data.repositoryOwner) fail(`GitHub owner not found: ${owner}`);
  const nodes = data.repositoryOwner.projectsV2?.nodes ?? [];
  const exact = nodes.filter((p) => p.title === title);
  if (exact.length > 1) {
    fail(`More than one Project owned by ${owner} is titled "${title}"; pass projectNumber to choose one.`, {
      candidates: exact.map((p) => ({ number: p.number, url: p.url })),
    });
  }
  return {
    ownerId: data.repositoryOwner.id,
    ownerType: data.repositoryOwner.__typename,
    project: exact[0] ? toProjectInfo(exact[0], owner) : undefined,
    candidates: nodes.map((p) => ({ number: p.number, title: p.title, url: p.url })),
  };
}

export async function getProjectByNumber(
  root: string,
  owner: string,
  number: number,
  runner: GitHubCommandRunner = defaultGitHubRunner,
): Promise<ProjectInfo> {
  if (!OWNER_LOGIN.test(owner)) fail("Invalid project owner login");
  const query = `query($login: String!, $n: Int!) {
    repositoryOwner(login: $login) {
      ... on User { projectV2(number: $n) { ${PROJECT_FIELDS_FRAGMENT} } }
      ... on Organization { projectV2(number: $n) { ${PROJECT_FIELDS_FRAGMENT} } }
    }
  }`;
  const data = await graphql<{ repositoryOwner: { projectV2?: RawProject | null } | null }>(root, runner, query, {
    login: owner,
    n: number,
  });
  const raw = data.repositoryOwner?.projectV2;
  if (!raw) fail(`Project ${owner}#${number} not found or not visible to the gh login`);
  return toProjectInfo(raw, owner);
}

export interface FieldGap {
  field: string;
  missingField: boolean;
  missingOptions: string[];
}

export function projectFieldGaps(project: ProjectInfo): FieldGap[] {
  const gaps: FieldGap[] = [];
  for (const [name, wanted] of [
    ["Status", STATUS_OPTIONS],
    ["Priority", PRIORITY_OPTIONS],
  ] as const) {
    const field = project.fields.find((f) => f.name === name);
    const have = new Set(field?.options.map((o) => o.name) ?? []);
    const missingOptions = wanted.filter((o) => !have.has(o));
    if (!field || missingOptions.length) gaps.push({ field: name, missingField: !field, missingOptions });
  }
  return gaps;
}

const OPTION_COLORS: Record<string, string> = {
  Backlog: "GRAY",
  Ready: "BLUE",
  "In Progress": "YELLOW",
  Verify: "PURPLE",
  Done: "GREEN",
  P0: "RED",
  P1: "ORANGE",
  P2: "YELLOW",
  P3: "GRAY",
};

function optionInputs(names: readonly string[]): Array<{ name: string; color: string; description: string }> {
  return names.map((name) => ({ name, color: OPTION_COLORS[name] ?? "GRAY", description: "" }));
}

/** The views this tool cannot create: GitHub's API does not expose Project views. */
export const MANUAL_VIEW_STEPS = [
  "전체: Table 뷰, Group by Status, 필드 Repository·Assignee·Milestone·Status·Priority 표시",
  "제품별: Table 뷰, Filter `repo:<owner>/<repo>` (제품마다 하나)",
  "blocked: Filter `label:blocked`",
  "Verify: Filter `status:Verify`",
  "Workflows 메뉴: 'Item added to project' → Status=Backlog, 'Item closed' 자동 Done은 끄거나 검토 (취소·미검증 종료가 Done이 되지 않게)",
];

export async function ensureProject(
  root: string,
  input: { owner?: string; title: string; projectNumber?: number; createIfMissing?: boolean; addMissingFields?: boolean; dryRun?: boolean },
  runner: GitHubCommandRunner = defaultGitHubRunner,
): Promise<{
  result: "reused" | "created" | "would_create" | "not_found";
  project?: ProjectInfo;
  fieldGaps: FieldGap[];
  fieldsCreated: string[];
  manualSteps: string[];
  candidates?: Array<{ number: number; title: string; url: string }>;
}> {
  const repository = await projectRepository(root, runner);
  const owner = input.owner ?? splitRepository(repository).owner;
  let project: ProjectInfo | undefined;
  let lookup: Awaited<ReturnType<typeof findProject>> | undefined;
  if (input.projectNumber !== undefined) {
    project = await getProjectByNumber(root, owner, input.projectNumber, runner);
  } else {
    lookup = await findProject(root, owner, input.title, runner);
    project = lookup.project;
  }

  const manualSteps = [...MANUAL_VIEW_STEPS];
  if (project) {
    const fieldGaps = projectFieldGaps(project);
    const fieldsCreated: string[] = [];
    // Existing Projects may be shared with other products. Only ever add a
    // field that is entirely missing: rewriting a single-select option list
    // through the API can reset values other products already set.
    if (input.addMissingFields && !input.dryRun) {
      for (const gap of fieldGaps) {
        if (!gap.missingField) continue;
        await createSingleSelectField(root, runner, project.id, gap.field, gap.field === "Status" ? STATUS_OPTIONS : PRIORITY_OPTIONS);
        fieldsCreated.push(gap.field);
      }
      if (fieldsCreated.length) project = await getProjectByNumber(root, owner, project.number, runner);
    }
    for (const gap of projectFieldGaps(project)) {
      if (gap.missingOptions.length) {
        manualSteps.push(
          `기존 ${gap.field} 필드에 옵션 추가 필요 (공유 Project이므로 UI에서 영향 확인 후): ${gap.missingOptions.join(", ")}`,
        );
      }
    }
    return { result: "reused", project, fieldGaps, fieldsCreated, manualSteps };
  }

  if (!input.createIfMissing) {
    return { result: "not_found", fieldGaps: [], fieldsCreated: [], manualSteps, candidates: lookup?.candidates };
  }
  if (input.dryRun) return { result: "would_create", fieldGaps: [], fieldsCreated: [], manualSteps };

  const created = await graphql<{ createProjectV2: { projectV2: { number: number } } }>(
    root,
    runner,
    `mutation($ownerId: ID!, $title: String!) { createProjectV2(input: { ownerId: $ownerId, title: $title }) { projectV2 { number } } }`,
    { ownerId: lookup!.ownerId, title: input.title },
  );
  let fresh = await getProjectByNumber(root, owner, created.createProjectV2.projectV2.number, runner);
  // A brand-new, empty, private Project: replacing the default Status options
  // (Todo / In Progress / Done) cannot disturb anyone's data.
  const status = fresh.fields.find((f) => f.name === "Status");
  const fieldsCreated: string[] = [];
  if (status) {
    try {
      await graphql(
        root,
        runner,
        `mutation($fieldId: ID!, $options: [ProjectV2SingleSelectFieldOptionInput!]) {
          updateProjectV2Field(input: { fieldId: $fieldId, singleSelectOptions: $options }) { projectV2Field { ... on ProjectV2SingleSelectField { id } } }
        }`,
        { fieldId: status.id, options: optionInputs(STATUS_OPTIONS) },
      );
      fieldsCreated.push("Status");
    } catch (error) {
      // The Project already exists at this point; report instead of failing
      // half-way so a rerun reuses it rather than creating a second one.
      manualSteps.push(
        `새 Project의 Status 옵션을 UI에서 ${STATUS_OPTIONS.join(" / ")} 로 바꾸세요 (API 갱신 실패: ${error instanceof Error ? redact(error.message) : "unknown"})`,
      );
    }
  } else {
    await createSingleSelectField(root, runner, fresh.id, "Status", STATUS_OPTIONS);
    fieldsCreated.push("Status");
  }
  if (!fresh.fields.some((f) => f.name === "Priority")) {
    await createSingleSelectField(root, runner, fresh.id, "Priority", PRIORITY_OPTIONS);
    fieldsCreated.push("Priority");
  }
  const repoNode = await graphql<{ repository: { id: string } }>(
    root,
    runner,
    `query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { id } }`,
    splitRepository(repository),
  );
  await graphql(
    root,
    runner,
    `mutation($projectId: ID!, $repositoryId: ID!) { linkProjectV2ToRepository(input: { projectId: $projectId, repositoryId: $repositoryId }) { clientMutationId } }`,
    { projectId: fresh.id, repositoryId: repoNode.repository.id },
  );
  fresh = await getProjectByNumber(root, owner, fresh.number, runner);
  return { result: "created", project: fresh, fieldGaps: projectFieldGaps(fresh), fieldsCreated, manualSteps };
}

async function createSingleSelectField(
  root: string,
  runner: GitHubCommandRunner,
  projectId: string,
  name: string,
  options: readonly string[],
): Promise<void> {
  await graphql(
    root,
    runner,
    `mutation($projectId: ID!, $name: String!, $options: [ProjectV2SingleSelectFieldOptionInput!]) {
      createProjectV2Field(input: { projectId: $projectId, dataType: SINGLE_SELECT, name: $name, singleSelectOptions: $options }) { projectV2Field { ... on ProjectV2SingleSelectField { id } } }
    }`,
    { projectId, name, options: optionInputs(options) },
  );
}

async function issueNode(
  root: string,
  number: number,
  runner: GitHubCommandRunner,
): Promise<{ id: string; number: number; url: string; state: string; body: string; labels: string[]; milestone?: string }> {
  const repository = await projectRepository(root, runner);
  const raw = parseJson<{
    id: string;
    number: number;
    url: string;
    state: string;
    body: string;
    labels: Array<{ name: string }>;
    milestone: { title: string } | null;
  }>(
    await gh(root, ["issue", "view", String(number), "--json", "id,number,url,state,body,labels,milestone", "--repo", repository], runner),
    "Issue detail",
  );
  return {
    id: raw.id,
    number: raw.number,
    url: raw.url,
    state: raw.state,
    body: raw.body ?? "",
    labels: raw.labels.map((l) => l.name),
    milestone: raw.milestone?.title,
  };
}

/** addProjectV2ItemById returns the existing item when the Issue is already on the board. */
export async function addIssueToProject(
  root: string,
  project: ProjectInfo,
  issueNumber: number,
  runner: GitHubCommandRunner = defaultGitHubRunner,
): Promise<{ itemId: string; issueNumber: number }> {
  const issue = await issueNode(root, issueNumber, runner);
  const data = await graphql<{ addProjectV2ItemById: { item: { id: string } } }>(
    root,
    runner,
    `mutation($projectId: ID!, $contentId: ID!) { addProjectV2ItemById(input: { projectId: $projectId, contentId: $contentId }) { item { id } } }`,
    { projectId: project.id, contentId: issue.id },
  );
  return { itemId: data.addProjectV2ItemById.item.id, issueNumber };
}

async function setSingleSelect(
  root: string,
  runner: GitHubCommandRunner,
  project: ProjectInfo,
  itemId: string,
  fieldName: string,
  optionName: string,
): Promise<void> {
  const field = project.fields.find((f) => f.name === fieldName);
  const option = field?.options.find((o) => o.name === optionName);
  if (!field || !option) {
    fail(`Project field ${fieldName} has no option "${optionName}". Run dev_management project_ensure to see the field gaps.`);
  }
  await graphql(
    root,
    runner,
    `mutation($projectId: ID!, $itemId: ID!, $fieldId: ID!, $optionId: String!) {
      updateProjectV2ItemFieldValue(input: { projectId: $projectId, itemId: $itemId, fieldId: $fieldId, value: { singleSelectOptionId: $optionId } }) { projectV2Item { id } }
    }`,
    { projectId: project.id, itemId, fieldId: field.id, optionId: option.id },
  );
}

// ---------------------------------------------------------------------------
// Done evidence
// ---------------------------------------------------------------------------

export interface DoneEvidence {
  kind: "code" | "document";
  /** Verified commit (code). */
  sha?: string;
  /** Verified artifact digest, `sha256:<64 hex>` (document, or a built artifact). */
  artifactDigest?: string;
  scopeVersion: string;
  environment: string;
  verifiedAt: string;
  runUrl: string;
  /** How the Issue's acceptance conditions were confirmed. A merged PR alone is not acceptance. */
  acceptance: string;
}

export interface EvidenceCheck {
  ok: boolean;
  failures: string[];
  checks: Array<{ name: string; conclusion: string | null; status: string }>;
}

const PASSING_CONCLUSIONS = new Set(["success", "neutral", "skipped"]);

export async function verifyDoneEvidence(
  root: string,
  issueNumber: number,
  evidence: DoneEvidence,
  runner: GitHubCommandRunner = defaultGitHubRunner,
  now: Date = new Date(),
): Promise<EvidenceCheck> {
  const failures: string[] = [];
  const checks: EvidenceCheck["checks"] = [];
  const issue = await issueNode(root, issueNumber, runner);
  if (issue.labels.includes(LABEL_CANCELLED)) failures.push("Issue is cancelled; cancellation is never Done.");
  if (issue.labels.includes(LABEL_BLOCKED)) failures.push("Issue is labelled blocked.");
  if (issue.labels.includes(LABEL_MIGRATION_STAGED)) failures.push("Issue is still migration:staged.");
  if (issue.milestone && evidence.scopeVersion !== issue.milestone) {
    failures.push(`scopeVersion "${evidence.scopeVersion}" does not match the Issue milestone "${issue.milestone}".`);
  }
  if (!evidence.scopeVersion.trim()) failures.push("scopeVersion is required.");
  if (!evidence.environment.trim()) failures.push("environment is required.");
  if (evidence.acceptance.trim().length < 10) failures.push("acceptance must say how the Issue's acceptance conditions were confirmed.");
  if (!/^https:\/\//u.test(evidence.runUrl)) failures.push("runUrl must be an https link to the run/result.");
  const verifiedAt = Date.parse(evidence.verifiedAt);
  if (Number.isNaN(verifiedAt)) failures.push("verifiedAt must be an ISO timestamp.");
  else if (verifiedAt > now.getTime() + 5 * 60_000) failures.push("verifiedAt is in the future.");
  if (evidence.artifactDigest !== undefined && !DIGEST.test(evidence.artifactDigest)) {
    failures.push("artifactDigest must be sha256:<64 hex>.");
  }

  if (evidence.kind === "code") {
    if (!evidence.sha || !SHA.test(evidence.sha)) {
      failures.push("Code evidence needs the full 40-character verified commit sha.");
    } else {
      let commitDate: number | undefined;
      try {
        const commit = (await repoApi(root, runner, `/commits/${evidence.sha}`)) as {
          commit?: { committer?: { date?: string } };
        };
        commitDate = Date.parse(commit.commit?.committer?.date ?? "");
      } catch {
        failures.push(`Commit ${evidence.sha} is not on GitHub.`);
      }
      if (commitDate !== undefined && !Number.isNaN(commitDate) && !Number.isNaN(verifiedAt) && verifiedAt < commitDate) {
        failures.push("verifiedAt predates the commit: the evidence is stale.");
      }
      if (commitDate !== undefined) {
        const runs = (await repoApi(root, runner, `/commits/${evidence.sha}/check-runs?per_page=100`)) as {
          check_runs?: Array<{ name: string; status: string; conclusion: string | null }>;
        };
        for (const run of runs.check_runs ?? []) checks.push({ name: run.name, status: run.status, conclusion: run.conclusion });
        if (checks.length === 0) failures.push("No CI check runs exist for this commit; an unrun test is not a pass.");
        const pending = checks.filter((c) => c.status !== "completed");
        const failed = checks.filter((c) => c.status === "completed" && !PASSING_CONCLUSIONS.has(c.conclusion ?? ""));
        if (pending.length) failures.push(`CI still running: ${pending.map((c) => c.name).join(", ")}`);
        if (failed.length) failures.push(`CI not passing: ${failed.map((c) => `${c.name}=${c.conclusion}`).join(", ")}`);
        if (checks.length && !checks.some((c) => c.conclusion === "success")) failures.push("No check run concluded success.");
      }
    }
  } else if (!evidence.artifactDigest && !evidence.sha) {
    failures.push("Document evidence needs artifactDigest or the sha of the reviewed document.");
  }
  return { ok: failures.length === 0, failures, checks };
}

export function evidenceComment(issueNumber: number, evidence: DoneEvidence, check: EvidenceCheck): string {
  const lines = [
    `<!-- chatgpt2codex:done-evidence issue=${issueNumber} -->`,
    "### Done 근거",
    `- Issue: #${issueNumber}`,
    `- 종류: ${evidence.kind}`,
    evidence.sha ? `- 검증 SHA: \`${evidence.sha}\`` : "",
    evidence.artifactDigest ? `- 산출물 digest: \`${evidence.artifactDigest}\`` : "",
    `- 범위 버전: ${evidence.scopeVersion}`,
    `- 환경: ${evidence.environment}`,
    `- 검증 시각: ${evidence.verifiedAt}`,
    `- 실행 결과: ${evidence.runUrl}`,
    `- 인수 확인: ${evidence.acceptance}`,
    check.checks.length ? `- CI: ${check.checks.map((c) => `${c.name}=${c.conclusion}`).join(", ")}` : "",
  ];
  return lines.filter(Boolean).join("\n");
}

export async function setItemStatus(
  root: string,
  input: {
    project: ProjectInfo;
    issueNumber: number;
    status: ManagementStatus;
    priority?: (typeof PRIORITY_OPTIONS)[number];
    evidence?: DoneEvidence;
    readyApproved?: boolean;
  },
  runner: GitHubCommandRunner = defaultGitHubRunner,
): Promise<{ itemId: string; status: ManagementStatus; evidence?: EvidenceCheck }> {
  const repository = await projectRepository(root, runner);
  let evidenceResult: EvidenceCheck | undefined;
  if (input.status === "Ready") {
    const issue = await issueNode(root, input.issueNumber, runner);
    if (issue.labels.includes(LABEL_MIGRATION_STAGED)) fail("migration:staged Issues stay out of the Ready queue until cutover is approved.");
    if (issue.labels.includes(LABEL_CANCELLED)) fail("A cancelled Issue cannot be Ready.");
    if (!/완료 조건|acceptance/iu.test(issue.body)) fail("Ready needs acceptance conditions (완료 조건) in the Issue body.");
    if (!input.readyApproved) fail("Ready needs readyApproved=true, recording that the scope and execution were approved by a person.");
  }
  if (input.status === "Done") {
    if (!input.evidence) fail("Done requires evidence (sha or artifactDigest, scopeVersion, environment, verifiedAt, runUrl, acceptance).");
    evidenceResult = await verifyDoneEvidence(root, input.issueNumber, input.evidence, runner);
    if (!evidenceResult.ok) {
      throw new DomainError(ErrorCode.COMMAND_NOT_ALLOWED, "Done evidence rejected; the Issue keeps its current Status.", {
        failures: evidenceResult.failures,
      });
    }
  }
  const { itemId } = await addIssueToProject(root, input.project, input.issueNumber, runner);
  await setSingleSelect(root, runner, input.project, itemId, "Status", input.status);
  if (input.priority) await setSingleSelect(root, runner, input.project, itemId, "Priority", input.priority);
  if (evidenceResult && input.evidence) {
    await gh(
      root,
      ["issue", "comment", String(input.issueNumber), "--body-file", "-", "--repo", repository],
      runner,
      evidenceComment(input.issueNumber, input.evidence, evidenceResult),
    );
  }
  return { itemId, status: input.status, evidence: evidenceResult };
}

// ---------------------------------------------------------------------------
// Blocked / cancelled
// ---------------------------------------------------------------------------

export async function markBlocked(
  root: string,
  input: { issueNumber: number; blocked: boolean; cause?: string; nextOwner?: string; checkAt?: string },
  runner: GitHubCommandRunner = defaultGitHubRunner,
): Promise<{ issueNumber: number; blocked: boolean }> {
  const repository = await projectRepository(root, runner);
  if (input.blocked && (!input.cause?.trim() || !input.nextOwner?.trim() || !input.checkAt?.trim())) {
    fail("Blocking needs cause, nextOwner, and checkAt.");
  }
  await gh(
    root,
    ["issue", "edit", String(input.issueNumber), input.blocked ? "--add-label" : "--remove-label", LABEL_BLOCKED, "--repo", repository],
    runner,
  );
  const body = input.blocked
    ? `<!-- chatgpt2codex:blocked -->\n### 차단\n- 원인: ${input.cause}\n- 다음 담당자: ${input.nextOwner}\n- 확인 시각: ${input.checkAt}\n\nStatus는 원래 단계를 유지합니다.`
    : `<!-- chatgpt2codex:unblocked -->\n### 차단 해제\n${input.cause ?? ""}`.trim();
  await gh(root, ["issue", "comment", String(input.issueNumber), "--body-file", "-", "--repo", repository], runner, body);
  return { issueNumber: input.issueNumber, blocked: input.blocked };
}

export async function cancelIssue(
  root: string,
  input: { issueNumber: number; reason: string },
  runner: GitHubCommandRunner = defaultGitHubRunner,
): Promise<{ issueNumber: number; closedAs: "not planned" }> {
  if (input.reason.trim().length < 3) fail("Cancelling needs a reason.");
  const repository = await projectRepository(root, runner);
  await gh(root, ["issue", "edit", String(input.issueNumber), "--add-label", LABEL_CANCELLED, "--repo", repository], runner);
  await gh(
    root,
    ["issue", "close", String(input.issueNumber), "--reason", "not planned", "--comment", `취소: ${input.reason}`, "--repo", repository],
    runner,
  );
  return { issueNumber: input.issueNumber, closedAs: "not planned" };
}

// ---------------------------------------------------------------------------
// Idempotent Issue upsert and the source -> GitHub mapping
// ---------------------------------------------------------------------------

export interface SourceItem {
  sourceSystem: string;
  sourceId: string;
  sourceUrl?: string;
  sourceUpdatedAt?: string;
  sourceHash?: string;
  sourceAuthor?: string;
  sourceCreatedAt?: string;
  title: string;
  body: string;
  labels?: string[];
  milestone?: string;
  priority?: (typeof PRIORITY_OPTIONS)[number];
  /** Link to this existing Issue instead of creating one (explicit reuse). */
  targetIssue?: number;
  /** Deliberately not migrated. */
  excludeReason?: string;
}

export type MappingResult = "created" | "reused" | "excluded" | "blocked" | "would_create";

export interface MappingEntry {
  source_system: string;
  source_id: string;
  source_url: string;
  source_updated_at: string;
  source_hash: string;
  target_repo: string;
  target_issue: number | null;
  target_url: string;
  result: MappingResult;
  reason: string;
  recorded_at: string;
}

export function sourceMarker(system: string, id: string): string {
  return `<!-- chatgpt2codex:source system=${system} id=${id} -->`;
}

const MARKER_PATTERN = /<!-- chatgpt2codex:source system=([a-z0-9_-]+) id=(\S+) -->/gu;

function sourceKey(system: string, id: string): string {
  return `${system}\u0000${id}`;
}

function sourceFingerprint(item: SourceItem): string {
  return item.sourceHash ?? item.sourceUpdatedAt ?? createHash("sha256").update(`${item.title}\n${item.body}`).digest("hex").slice(0, 16);
}

function issueBody(item: SourceItem): string {
  const meta = [
    "",
    "---",
    "<details><summary>출처 (원본 메타데이터)</summary>",
    "",
    `- 원본 시스템: ${item.sourceSystem}`,
    `- 원본 ID: ${item.sourceId}`,
    item.sourceUrl ? `- 원본 URL: ${item.sourceUrl}` : "",
    item.sourceAuthor ? `- 원본 작성자: ${item.sourceAuthor}` : "",
    item.sourceCreatedAt ? `- 원본 작성 시각: ${item.sourceCreatedAt}` : "",
    item.sourceUpdatedAt ? `- 원본 수정 시각: ${item.sourceUpdatedAt}` : "",
    "- 이 Issue의 실제 생성자·생성 시각은 GitHub 기록을 따릅니다.",
    "",
    "</details>",
    sourceMarker(item.sourceSystem, item.sourceId),
  ];
  return `${item.body}\n${meta.filter((l) => l !== "").join("\n")}\n`;
}

export function mappingPath(stateDir: string, repository: string): string {
  return path.join(stateDir, "management", repository.replace("/", "__"), "mapping.json");
}

export async function readMapping(stateDir: string, repository: string): Promise<MappingEntry[]> {
  try {
    const raw = await fs.readFile(mappingPath(stateDir, repository), "utf8");
    const parsed = JSON.parse(raw) as { entries?: MappingEntry[] };
    return Array.isArray(parsed.entries) ? parsed.entries : [];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

async function writeMapping(stateDir: string, repository: string, entries: MappingEntry[]): Promise<string> {
  const file = mappingPath(stateDir, repository);
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${randomUUID()}.tmp`;
  await fs.writeFile(temp, `${JSON.stringify({ repository, entries }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await fs.rename(temp, file);
  return file;
}

export function mappingCsv(entries: readonly MappingEntry[]): string {
  const header: Array<keyof MappingEntry> = [
    "source_system",
    "source_id",
    "source_url",
    "source_updated_at",
    "source_hash",
    "target_repo",
    "target_issue",
    "target_url",
    "result",
    "reason",
    "recorded_at",
  ];
  const cell = (v: unknown): string => {
    const s = v === null || v === undefined ? "" : String(v);
    return /[",\n]/u.test(s) ? `"${s.replace(/"/gu, '""')}"` : s;
  };
  return [header.join(","), ...entries.map((e) => header.map((h) => cell(e[h])).join(","))].join("\n");
}

interface ScannedIssue {
  number: number;
  title: string;
  url: string;
  state: string;
}

const SCAN_LIMIT = 5000;

async function scanIssues(
  root: string,
  repository: string,
  runner: GitHubCommandRunner,
): Promise<{ byMarker: Map<string, ScannedIssue[]>; byTitle: Map<string, ScannedIssue[]>; byNumber: Map<number, ScannedIssue>; truncated: boolean }> {
  const raw = parseJson<Array<ScannedIssue & { body: string }>>(
    await gh(
      root,
      ["issue", "list", "--state", "all", "--limit", String(SCAN_LIMIT), "--json", "number,title,url,state,body", "--repo", repository],
      runner,
    ),
    "Issue scan",
  );
  const byMarker = new Map<string, ScannedIssue[]>();
  const byTitle = new Map<string, ScannedIssue[]>();
  const byNumber = new Map<number, ScannedIssue>();
  for (const issue of raw) {
    const slim = { number: issue.number, title: issue.title, url: issue.url, state: issue.state };
    byNumber.set(issue.number, slim);
    const title = issue.title.trim().toLowerCase();
    byTitle.set(title, [...(byTitle.get(title) ?? []), slim]);
    for (const match of (issue.body ?? "").matchAll(MARKER_PATTERN)) {
      const key = sourceKey(match[1]!, match[2]!);
      byMarker.set(key, [...(byMarker.get(key) ?? []), slim]);
    }
  }
  return { byMarker, byTitle, byNumber, truncated: raw.length >= SCAN_LIMIT };
}

export interface UpsertReport {
  repository: string;
  t0: string;
  dryRun: boolean;
  mappingFile?: string;
  counts: { input: number; created: number; reused: number; excluded: number; blocked: number; would_create: number };
  reconciled: boolean;
  duplicatesOnGitHub: Array<{ source: string; issues: number[] }>;
  sourceChanged: Array<{ source: string; issue: number | null; before: string; now: string }>;
  entries: MappingEntry[];
  projectItems: Array<{ issueNumber: number; itemId: string }>;
}

/**
 * Create-or-reuse Issues for a list of source records, recording every
 * outcome. Matching order follows the migration contract: the stored mapping
 * first, then the hidden source marker in Issue bodies; a bare title match is
 * never treated as the same work and is reported as blocked for review.
 * Re-running the same input creates nothing new.
 */
export async function upsertSourceIssues(
  root: string,
  stateDir: string,
  input: {
    items: SourceItem[];
    dryRun: boolean;
    staged: boolean;
    project?: ProjectInfo;
  },
  runner: GitHubCommandRunner = defaultGitHubRunner,
  now: () => Date = () => new Date(),
): Promise<UpsertReport> {
  const repository = await projectRepository(root, runner);
  const t0 = now().toISOString();
  const stored = await readMapping(stateDir, repository);
  const storedByKey = new Map(stored.map((e) => [sourceKey(e.source_system, e.source_id), e]));
  const scan = await scanIssues(root, repository, runner);
  const entries: MappingEntry[] = [];
  const seen = new Set<string>();
  const sourceChanged: UpsertReport["sourceChanged"] = [];
  const projectItems: UpsertReport["projectItems"] = [];
  const duplicatesOnGitHub: UpsertReport["duplicatesOnGitHub"] = [];
  let mappingFile: string | undefined;

  const persist = async (): Promise<void> => {
    if (input.dryRun) return;
    const merged = new Map(stored.map((e) => [sourceKey(e.source_system, e.source_id), e]));
    for (const e of entries) if (e.result === "created" || e.result === "reused" || e.result === "excluded") merged.set(sourceKey(e.source_system, e.source_id), e);
    mappingFile = await writeMapping(stateDir, repository, [...merged.values()]);
  };

  for (const item of input.items) {
    const base = {
      source_system: item.sourceSystem,
      source_id: item.sourceId,
      source_url: item.sourceUrl ?? "",
      source_updated_at: item.sourceUpdatedAt ?? "",
      source_hash: sourceFingerprint(item),
      target_repo: repository,
      recorded_at: now().toISOString(),
    };
    const record = (result: MappingResult, reason: string, issue?: { number: number; url: string }): void => {
      entries.push({ ...base, target_issue: issue?.number ?? null, target_url: issue?.url ?? "", result, reason });
    };

    if (!SOURCE_SYSTEM.test(item.sourceSystem) || !SOURCE_ID.test(item.sourceId)) {
      record("blocked", "invalid sourceSystem/sourceId");
      continue;
    }
    const key = sourceKey(item.sourceSystem, item.sourceId);
    if (seen.has(key)) {
      record("blocked", "duplicate source in this input");
      continue;
    }
    seen.add(key);

    if (item.excludeReason) {
      record("excluded", item.excludeReason);
      continue;
    }

    const markerHits = scan.byMarker.get(key) ?? [];
    if (markerHits.length > 1) {
      duplicatesOnGitHub.push({ source: `${item.sourceSystem}:${item.sourceId}`, issues: markerHits.map((i) => i.number) });
    }
    const previous = storedByKey.get(key);
    const fingerprint = base.source_hash;
    if (previous && previous.source_hash && previous.source_hash !== fingerprint) {
      sourceChanged.push({ source: `${item.sourceSystem}:${item.sourceId}`, issue: previous.target_issue, before: previous.source_hash, now: fingerprint });
    }

    let reuse: ScannedIssue | undefined;
    let reason = "";
    if (previous?.target_issue && scan.byNumber.has(previous.target_issue)) {
      reuse = scan.byNumber.get(previous.target_issue);
      reason = "stored mapping";
    } else if (markerHits.length) {
      reuse = markerHits[0];
      reason = "source marker in Issue body";
    } else if (item.targetIssue !== undefined) {
      reuse = scan.byNumber.get(item.targetIssue);
      reason = "explicit targetIssue";
      if (!reuse) {
        record("blocked", `targetIssue #${item.targetIssue} not found`);
        continue;
      }
    }

    if (reuse) {
      record("reused", reason, reuse);
    } else {
      const titleHits = scan.byTitle.get(item.title.trim().toLowerCase()) ?? [];
      if (titleHits.length) {
        record(
          "blocked",
          `title matches existing Issue(s) ${titleHits.map((i) => `#${i.number}`).join(", ")} without a source marker; set targetIssue to reuse or change the title`,
        );
        continue;
      }
      if (scan.truncated) {
        record("blocked", `repository has more than ${SCAN_LIMIT} Issues; duplicate check incomplete`);
        continue;
      }
      if (input.dryRun) {
        record("would_create", "no existing Issue for this source");
        continue;
      }
      const labels = [...new Set([...(item.labels ?? []), ...(input.staged ? [LABEL_MIGRATION_STAGED] : [])])];
      const args = ["issue", "create", "--title", item.title, "--body-file", "-", "--repo", repository];
      for (const label of labels) args.push("--label", label);
      if (item.milestone) args.push("--milestone", item.milestone);
      const url = (await gh(root, args, runner, issueBody(item))).trim();
      const number = Number(/\/issues\/(\d+)$/u.exec(url)?.[1]);
      if (!Number.isInteger(number) || number <= 0) fail("GitHub Issue creation returned an unexpected URL");
      const created = { number, title: item.title, url, state: "OPEN" };
      scan.byNumber.set(number, created);
      scan.byMarker.set(key, [created]);
      record("created", "no existing Issue for this source", created);
      // Record each creation before the next API call, so an interrupted run
      // resumes against the Issues it already made.
      await persist();
    }

    const entry = entries[entries.length - 1]!;
    if (input.project && !input.dryRun && entry.target_issue) {
      const { itemId } = await addIssueToProject(root, input.project, entry.target_issue, runner);
      projectItems.push({ issueNumber: entry.target_issue, itemId });
      if (entry.result === "created") {
        // New and staged work starts in Backlog; it never lands in Ready here.
        await setSingleSelect(root, runner, input.project, itemId, "Status", "Backlog");
        if (item.priority) await setSingleSelect(root, runner, input.project, itemId, "Priority", item.priority);
      }
    }
  }
  await persist();

  const counts = { input: input.items.length, created: 0, reused: 0, excluded: 0, blocked: 0, would_create: 0 };
  for (const e of entries) counts[e.result] += 1;
  const reconciled = counts.input === counts.created + counts.reused + counts.excluded + counts.blocked + counts.would_create;
  return { repository, t0, dryRun: input.dryRun, mappingFile, counts, reconciled, duplicatesOnGitHub, sourceChanged, entries, projectItems };
}
