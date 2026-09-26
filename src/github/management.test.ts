import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { GitHubCommandCall, GitHubCommandRunner } from "./github.js";
import {
  LABEL_MIGRATION_STAGED,
  ensureLabels,
  ensureProject,
  mappingCsv,
  readMapping,
  setItemStatus,
  sourceMarker,
  upsertSourceIssues,
  verifyDoneEvidence,
  type DoneEvidence,
  type ProjectInfo,
  type SourceItem,
} from "./management.js";
import { scaffoldManagementFiles } from "./management-setup.js";
import { shellApprovalGuidance } from "../exec/local-shell.js";

interface FakeIssue {
  number: number;
  title: string;
  body: string;
  state: string;
  labels: string[];
  milestone?: string;
}

const SHA = "a".repeat(40);

function fakeGitHub() {
  const calls: GitHubCommandCall[] = [];
  const issues: FakeIssue[] = [];
  const labels = new Set(["bug", "blocked"]);
  let checkRuns: Array<{ name: string; status: string; conclusion: string | null }> = [
    { name: "test", status: "completed", conclusion: "success" },
  ];
  let commitDate = "2026-09-20T00:00:00Z";
  const runner: GitHubCommandRunner = async (call) => {
    calls.push(call);
    const a = call.args;
    if (call.command === "git") {
      if (a.includes("remote.origin.url")) return "git@github.com:acme/widgets.git\n";
      return "";
    }
    const joined = a.join(" ");
    if (joined.startsWith("label list")) return JSON.stringify([...labels].map((name) => ({ name })));
    if (joined.startsWith("label create")) {
      labels.add(a[2]!);
      return "";
    }
    if (joined.startsWith("issue list")) return JSON.stringify(issues.map((i) => ({ ...i, url: `https://github.com/acme/widgets/issues/${i.number}` })));
    if (joined.startsWith("issue create")) {
      const number = issues.length + 1;
      const issueLabels: string[] = [];
      a.forEach((v, i) => {
        if (v === "--label") issueLabels.push(a[i + 1]!);
      });
      issues.push({ number, title: a[a.indexOf("--title") + 1]!, body: call.stdin ?? "", state: "OPEN", labels: issueLabels });
      return `https://github.com/acme/widgets/issues/${number}\n`;
    }
    if (joined.startsWith("issue view")) {
      const issue = issues.find((i) => i.number === Number(a[2]))!;
      return JSON.stringify({
        id: `I_${issue.number}`,
        number: issue.number,
        url: `https://github.com/acme/widgets/issues/${issue.number}`,
        state: issue.state,
        body: issue.body,
        labels: issue.labels.map((name) => ({ name })),
        milestone: issue.milestone ? { title: issue.milestone } : null,
      });
    }
    if (joined.startsWith("issue comment")) return "https://github.com/acme/widgets/issues/1#issuecomment-1\n";
    if (a[0] === "api" && a[1] === "graphql") {
      const body = JSON.parse(call.stdin ?? "{}") as { query: string };
      if (body.query.includes("addProjectV2ItemById")) return JSON.stringify({ data: { addProjectV2ItemById: { item: { id: "PVTI_1" } } } });
      if (body.query.includes("updateProjectV2ItemFieldValue")) return JSON.stringify({ data: { updateProjectV2ItemFieldValue: { projectV2Item: { id: "PVTI_1" } } } });
      return JSON.stringify({ data: {} });
    }
    if (a[0] === "api" && /commits\/[0-9a-f]{40}\/check-runs/u.test(a[1]!)) return JSON.stringify({ check_runs: checkRuns });
    if (a[0] === "api" && /commits\/[0-9a-f]{40}$/u.test(a[1]!)) return JSON.stringify({ commit: { committer: { date: commitDate } } });
    return "";
  };
  return {
    calls,
    issues,
    labels,
    runner,
    setCheckRuns: (runs: typeof checkRuns) => {
      checkRuns = runs;
    },
    setCommitDate: (date: string) => {
      commitDate = date;
    },
    creates: () => calls.filter((c) => c.args[0] === "issue" && c.args[1] === "create").length,
  };
}

const board: ProjectInfo = {
  id: "PVT_1",
  number: 3,
  title: "JM Development",
  url: "https://github.com/users/acme/projects/3",
  public: false,
  closed: false,
  owner: "acme",
  fields: [
    {
      id: "F_status",
      name: "Status",
      options: ["Backlog", "Ready", "In Progress", "Verify", "Done"].map((name) => ({ id: `O_${name}`, name })),
    },
    { id: "F_priority", name: "Priority", options: ["P0", "P1", "P2", "P3"].map((name) => ({ id: `O_${name}`, name })) },
  ],
};

let stateDir: string;
beforeEach(async () => {
  stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "c2c-mgmt-"));
});
afterEach(async () => {
  await fs.rm(stateDir, { recursive: true, force: true });
});

function item(id: string, extra: Partial<SourceItem> = {}): SourceItem {
  return { sourceSystem: "linear", sourceId: id, sourceUpdatedAt: "2026-09-01T00:00:00Z", title: `Task ${id}`, body: `Body ${id}`, ...extra };
}

describe("ensureLabels", () => {
  it("creates only missing labels and nothing on dry run", async () => {
    const gh = fakeGitHub();
    const dry = await ensureLabels("/repo", undefined, { dryRun: true }, gh.runner);
    expect(dry.reused).toContain("blocked");
    expect(gh.calls.some((c) => c.args[1] === "create")).toBe(false);

    const real = await ensureLabels("/repo", undefined, {}, gh.runner);
    expect(real.created).toEqual(dry.created);
    const again = await ensureLabels("/repo", undefined, {}, gh.runner);
    expect(again.created).toEqual([]);
  });
});

describe("upsertSourceIssues", () => {
  it("creates once, then reuses on a rerun with zero new Issues", async () => {
    const gh = fakeGitHub();
    const items = [item("ENG-1"), item("ENG-2"), item("ENG-3", { excludeReason: "historical, kept in source" })];
    const first = await upsertSourceIssues("/repo", stateDir, { items, dryRun: false, staged: true }, gh.runner);
    expect(first.counts).toMatchObject({ input: 3, created: 2, reused: 0, excluded: 1, blocked: 0 });
    expect(first.reconciled).toBe(true);
    expect(gh.issues[0]!.labels).toContain(LABEL_MIGRATION_STAGED);
    expect(gh.issues[0]!.body).toContain(sourceMarker("linear", "ENG-1"));

    const second = await upsertSourceIssues("/repo", stateDir, { items, dryRun: false, staged: true }, gh.runner);
    expect(second.counts).toMatchObject({ created: 0, reused: 2, excluded: 1 });
    expect(gh.creates()).toBe(2);
  });

  it("resumes from the source marker when the stored mapping was lost", async () => {
    const gh = fakeGitHub();
    await upsertSourceIssues("/repo", stateDir, { items: [item("ENG-1")], dryRun: false, staged: false }, gh.runner);
    await fs.rm(path.join(stateDir, "management"), { recursive: true });
    const rerun = await upsertSourceIssues("/repo", stateDir, { items: [item("ENG-1")], dryRun: false, staged: false }, gh.runner);
    expect(rerun.entries[0]).toMatchObject({ result: "reused", reason: "source marker in Issue body", target_issue: 1 });
    expect(gh.creates()).toBe(1);
  });

  it("never treats a bare title match as the same work, and blocks input duplicates", async () => {
    const gh = fakeGitHub();
    gh.issues.push({ number: 1, title: "Task ENG-9", body: "hand-written", state: "OPEN", labels: [] });
    const report = await upsertSourceIssues("/repo", stateDir, { items: [item("ENG-9"), item("ENG-9")], dryRun: false, staged: false }, gh.runner);
    expect(report.entries.map((e) => e.result)).toEqual(["blocked", "blocked"]);
    expect(report.entries[0]!.reason).toMatch(/title matches/u);
    expect(report.entries[1]!.reason).toMatch(/duplicate source/u);
    expect(gh.creates()).toBe(0);

    const linked = await upsertSourceIssues("/repo", stateDir, { items: [item("ENG-9", { targetIssue: 1 })], dryRun: false, staged: false }, gh.runner);
    expect(linked.entries[0]).toMatchObject({ result: "reused", target_issue: 1 });
  });

  it("dry run writes nothing and reports would_create", async () => {
    const gh = fakeGitHub();
    const report = await upsertSourceIssues("/repo", stateDir, { items: [item("ENG-1")], dryRun: true, staged: true }, gh.runner);
    expect(report.counts.would_create).toBe(1);
    expect(report.reconciled).toBe(true);
    expect(gh.creates()).toBe(0);
    expect(await readMapping(stateDir, "acme/widgets")).toEqual([]);
  });

  it("reports a source that changed since it was mapped instead of overwriting", async () => {
    const gh = fakeGitHub();
    await upsertSourceIssues("/repo", stateDir, { items: [item("ENG-1")], dryRun: false, staged: false }, gh.runner);
    const changed = await upsertSourceIssues(
      "/repo",
      stateDir,
      { items: [item("ENG-1", { sourceUpdatedAt: "2026-09-10T00:00:00Z", body: "edited upstream" })], dryRun: false, staged: false },
      gh.runner,
    );
    expect(changed.sourceChanged).toHaveLength(1);
    expect(gh.issues[0]!.body).toContain("Body ENG-1");
  });

  it("adds new Issues to the board in Backlog, never Ready", async () => {
    const gh = fakeGitHub();
    const report = await upsertSourceIssues("/repo", stateDir, { items: [item("ENG-1")], dryRun: false, staged: true, project: board }, gh.runner);
    expect(report.projectItems).toEqual([{ issueNumber: 1, itemId: "PVTI_1" }]);
    const statusWrite = gh.calls.find((c) => c.stdin?.includes("updateProjectV2ItemFieldValue"));
    expect(JSON.parse(statusWrite!.stdin!).variables.optionId).toBe("O_Backlog");
  });

  it("stores the mapping outside the repository with owner-only permissions", async () => {
    const gh = fakeGitHub();
    const report = await upsertSourceIssues("/repo", stateDir, { items: [item("ENG-1")], dryRun: false, staged: false }, gh.runner);
    expect(report.mappingFile?.startsWith(stateDir)).toBe(true);
    if (process.platform !== "win32") {
      expect((await fs.stat(report.mappingFile!)).mode & 0o777).toBe(0o600);
    }
    const csv = mappingCsv(await readMapping(stateDir, "acme/widgets"));
    expect(csv.split("\n")[0]).toBe(
      "source_system,source_id,source_url,source_updated_at,source_hash,target_repo,target_issue,target_url,result,reason,recorded_at",
    );
  });
});

describe("Done evidence", () => {
  const evidence: DoneEvidence = {
    kind: "code",
    sha: SHA,
    scopeVersion: "v1.0",
    environment: "ubuntu-24.04 CI",
    verifiedAt: "2026-09-21T00:00:00Z",
    runUrl: "https://github.com/acme/widgets/actions/runs/1",
    acceptance: "Ran the acceptance checklist in the Issue against staging.",
  };
  const now = new Date("2026-09-22T00:00:00Z");

  async function issueWith(extra: Partial<FakeIssue> = {}) {
    const gh = fakeGitHub();
    gh.issues.push({ number: 1, title: "t", body: "## 완료 조건\n- x", state: "OPEN", labels: [], milestone: "v1.0", ...extra });
    return gh;
  }

  it("accepts passing CI on the verified sha", async () => {
    const gh = await issueWith();
    const check = await verifyDoneEvidence("/repo", 1, evidence, gh.runner, now);
    expect(check).toMatchObject({ ok: true, failures: [] });
  });

  it.each([
    ["failing CI", (gh: ReturnType<typeof fakeGitHub>) => gh.setCheckRuns([{ name: "test", status: "completed", conclusion: "failure" }]), /CI not passing/u],
    ["no CI at all", (gh: ReturnType<typeof fakeGitHub>) => gh.setCheckRuns([]), /No CI check runs/u],
    ["CI still running", (gh: ReturnType<typeof fakeGitHub>) => gh.setCheckRuns([{ name: "test", status: "in_progress", conclusion: null }]), /still running/u],
    ["evidence older than the commit", (gh: ReturnType<typeof fakeGitHub>) => gh.setCommitDate("2026-09-21T12:00:00Z"), /stale/u],
  ])("rejects %s", async (_label, arrange, message) => {
    const gh = await issueWith();
    arrange(gh);
    const check = await verifyDoneEvidence("/repo", 1, evidence, gh.runner, now);
    expect(check.ok).toBe(false);
    expect(check.failures.join("\n")).toMatch(message);
  });

  it("rejects cancelled Issues and a scope version that is not the milestone", async () => {
    const gh = await issueWith({ labels: ["cancelled"], milestone: "v2.0" });
    const check = await verifyDoneEvidence("/repo", 1, evidence, gh.runner, now);
    expect(check.failures.join("\n")).toMatch(/cancelled/u);
    expect(check.failures.join("\n")).toMatch(/milestone/u);
  });

  it("status_set refuses Done without evidence and never moves the item", async () => {
    const gh = await issueWith();
    await expect(setItemStatus("/repo", { project: board, issueNumber: 1, status: "Done" }, gh.runner)).rejects.toThrow(/evidence/u);
    gh.setCheckRuns([{ name: "test", status: "completed", conclusion: "failure" }]);
    await expect(setItemStatus("/repo", { project: board, issueNumber: 1, status: "Done", evidence }, gh.runner)).rejects.toThrow(/rejected/u);
    expect(gh.calls.some((c) => c.stdin?.includes("updateProjectV2ItemFieldValue"))).toBe(false);
  });

  it("status_set keeps migration:staged work out of Ready and requires approval", async () => {
    const staged = await issueWith({ labels: [LABEL_MIGRATION_STAGED] });
    await expect(setItemStatus("/repo", { project: board, issueNumber: 1, status: "Ready", readyApproved: true }, staged.runner)).rejects.toThrow(
      /migration:staged/u,
    );
    const plain = await issueWith();
    await expect(setItemStatus("/repo", { project: board, issueNumber: 1, status: "Ready" }, plain.runner)).rejects.toThrow(/readyApproved/u);
    const ok = await setItemStatus("/repo", { project: board, issueNumber: 1, status: "Ready", readyApproved: true }, plain.runner);
    expect(ok.status).toBe("Ready");
  });
});

describe("scaffoldManagementFiles", () => {
  let root: string;
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "c2c-scaffold-"));
  });
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });
  const input = { mode: "existing_project" as const, productName: "Widgets", workername: "widgets", repository: "acme/widgets", projectTitle: "JM Development" };

  it("writes missing files once and skips everything on a rerun", async () => {
    const first = await scaffoldManagementFiles(root, input);
    expect(first.created).toEqual(
      expect.arrayContaining(["docs/development-management.md", ".github/pull_request_template.md", "AGENTS.md", ".github/workflows/management-check.yml"]),
    );
    const doc = await fs.readFile(path.join(root, "docs/development-management.md"), "utf8");
    expect(doc).toContain("PREPARE_MIGRATION");
    expect(doc).toContain("Refs acme/widgets#");
    const second = await scaffoldManagementFiles(root, input);
    expect(second.created).toEqual([]);
  });

  it("never edits an existing AGENTS.md or duplicates an existing PR template", async () => {
    await fs.writeFile(path.join(root, "AGENTS.md"), "# Mine\n");
    await fs.mkdir(path.join(root, ".github"), { recursive: true });
    await fs.writeFile(path.join(root, ".github", "PULL_REQUEST_TEMPLATE.md"), "existing\n");
    const result = await scaffoldManagementFiles(root, input);
    expect(await fs.readFile(path.join(root, "AGENTS.md"), "utf8")).toBe("# Mine\n");
    expect(result.agentsSnippet).toContain("docs/development-management.md");
    expect(result.created).not.toContain(".github/pull_request_template.md");
    expect(result.skipped.map((s) => s.reason).join("\n")).toMatch(/equivalent exists/u);
  });

  it("dry run writes nothing", async () => {
    const result = await scaffoldManagementFiles(root, { ...input, dryRun: true });
    expect(result.created.length).toBeGreaterThan(0);
    expect(await fs.readdir(root)).toEqual([]);
  });
});

describe("shellApprovalGuidance", () => {
  it("points file writes at file_create and a remote owner at SSH forwarding", () => {
    const guidance = shellApprovalGuidance(
      "cat > src/app.ts <<'EOF'\nconst host = 'ssh';\nEOF",
      "http://127.0.0.1:7979/admin/shell-approvals/abc",
    );
    expect(guidance.fileWriteHint).toMatch(/file_create/u);
    expect(guidance.approvalAccessHint).toContain("ssh -L 7979:127.0.0.1:7979");
  });

  it("stays quiet for a plain network command", () => {
    expect(shellApprovalGuidance("npm install", undefined)).toEqual({});
    expect(shellApprovalGuidance("curl https://example.com > /dev/null", undefined)).toEqual({});
  });
});

describe("ensureProject", () => {
  function projectRunner(existing: boolean) {
    const mutations: string[] = [];
    const statusOptions = existing ? ["Todo", "In Progress", "Done"] : ["Todo", "In Progress", "Done"];
    const project = {
      id: "PVT_9",
      number: 9,
      title: "JM Development",
      url: "https://github.com/users/acme/projects/9",
      public: false,
      closed: false,
      fields: { nodes: [{ id: "F_s", name: "Status", options: statusOptions.map((name) => ({ id: name, name })) }] },
    };
    let created = existing;
    const runner: GitHubCommandRunner = async (call) => {
      if (call.command === "git") return "git@github.com:acme/widgets.git\n";
      const body = JSON.parse(call.stdin ?? "{}") as { query: string };
      const q = body.query;
      if (q.startsWith("mutation")) mutations.push(/mutation[^{]*\{\s*(\w+)/u.exec(q)?.[1] ?? q);
      if (q.includes("createProjectV2(")) {
        created = true;
        return JSON.stringify({ data: { createProjectV2: { projectV2: { number: 9 } } } });
      }
      if (q.includes("projectsV2(")) {
        return JSON.stringify({ data: { repositoryOwner: { __typename: "User", id: "U_1", projectsV2: { nodes: created ? [project] : [] } } } });
      }
      if (q.includes("projectV2(number")) return JSON.stringify({ data: { repositoryOwner: { projectV2: project } } });
      if (q.includes("repository(owner")) return JSON.stringify({ data: { repository: { id: "R_1" } } });
      return JSON.stringify({ data: {} });
    };
    return { runner, mutations };
  }

  it("reuses an existing shared Project without rewriting its options", async () => {
    const { runner, mutations } = projectRunner(true);
    const result = await ensureProject("/repo", { title: "JM Development", addMissingFields: true }, runner);
    expect(result.result).toBe("reused");
    expect(mutations).toEqual(["createProjectV2Field"]);
    expect(result.manualSteps.join("\n")).toMatch(/Backlog, Ready, Verify/u);
  });

  it("reports not_found unless creation is explicitly requested", async () => {
    const { runner, mutations } = projectRunner(false);
    expect((await ensureProject("/repo", { title: "JM Development" }, runner)).result).toBe("not_found");
    expect(mutations).toEqual([]);
    const created = await ensureProject("/repo", { title: "JM Development", createIfMissing: true }, runner);
    expect(created.result).toBe("created");
    expect(mutations).toEqual(["createProjectV2", "updateProjectV2Field", "createProjectV2Field", "linkProjectV2ToRepository"]);
  });
});
