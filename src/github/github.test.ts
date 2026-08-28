import { describe, expect, it } from "vitest";
import { DomainError, ErrorCode } from "../types.js";
import {
  commentOnGitHubIssue,
  commentOnGitHubPullRequest,
  createGitHubIssue,
  createGitHubPullRequest,
  getGitHubIssue,
  getGitHubPullRequestChecks,
  listGitHubIssues,
  parseGitHubRepository,
  requestGitHubPullRequestReview,
  setGitHubIssueState,
  updateGitHubIssue,
  updateGitHubPullRequest,
  type GitHubCommandCall,
  type GitHubCommandRunner,
} from "./github.js";

function makeRunner(): { calls: GitHubCommandCall[]; runner: GitHubCommandRunner } {
  const calls: GitHubCommandCall[] = [];
  const runner: GitHubCommandRunner = async (call) => {
    calls.push(call);
    if (call.command === "git") {
      if (call.args.includes("remote.origin.url")) return "git@github.com:acme/widgets.git\n";
      if (call.args.includes("--abbrev-ref")) return "feature/delivery-tools\n";
    }
    const joined = call.args.join(" ");
    if (joined.startsWith("issue list")) {
      return JSON.stringify([{ number: 12, title: "Bug", state: "OPEN", url: "https://github.com/acme/widgets/issues/12" }]);
    }
    if (joined.startsWith("issue view")) {
      return JSON.stringify({ number: 12, title: "Bug", body: "Details", state: "OPEN" });
    }
    if (joined.startsWith("issue create")) return "https://github.com/acme/widgets/issues/13\n";
    if (joined.startsWith("issue comment")) return "https://github.com/acme/widgets/issues/13#issuecomment-1\n";
    if (joined.startsWith("pr create")) return "https://github.com/acme/widgets/pull/21\n";
    if (joined.startsWith("pr comment")) return "https://github.com/acme/widgets/pull/21#issuecomment-2\n";
    if (joined.startsWith("pr checks")) {
      return JSON.stringify([{ name: "test", state: "SUCCESS", bucket: "pass", link: "https://example.test/check" }]);
    }
    return "";
  };
  return { calls, runner };
}

describe("parseGitHubRepository", () => {
  it.each([
    ["https://github.com/acme/widgets.git", "acme/widgets"],
    ["git@github.com:acme/widgets.git", "acme/widgets"],
    ["ssh://git@github.com/acme/widgets.git", "acme/widgets"],
  ])("accepts a GitHub origin %s", (remote, expected) => {
    expect(parseGitHubRepository(remote)).toBe(expected);
  });

  it.each([
    "https://gitlab.com/acme/widgets.git",
    "https://github.example.com/acme/widgets.git",
    "file:///tmp/widgets",
    "https://github.com/acme/widgets/extra",
  ])("rejects a non-GitHub or malformed origin %s", (remote) => {
    expect(() => parseGitHubRepository(remote)).toThrowError(
      expect.objectContaining<Partial<DomainError>>({ code: ErrorCode.COMMAND_NOT_ALLOWED }),
    );
  });
});

describe("GitHub Issue delivery commands", () => {
  it("lists and reads Issues from the project origin", async () => {
    const { calls, runner } = makeRunner();
    await expect(listGitHubIssues("/project", { state: "all", limit: 20 }, runner)).resolves.toHaveLength(1);
    await expect(getGitHubIssue("/project", 12, runner)).resolves.toMatchObject({ number: 12 });

    const ghCalls = calls.filter((call) => call.command === "gh");
    expect(ghCalls).toHaveLength(2);
    expect(ghCalls.every((call) => call.args.includes("acme/widgets"))).toBe(true);
  });

  it("creates Issues with body content on stdin", async () => {
    const { calls, runner } = makeRunner();
    await expect(
      createGitHubIssue(
        "/project",
        { title: "Delivery bug", body: "Sensitive body", labels: ["bug"], assignees: ["octocat"] },
        runner,
      ),
    ).resolves.toEqual({ number: 13, url: "https://github.com/acme/widgets/issues/13" });

    const create = calls.find((call) => call.command === "gh" && call.args[0] === "issue" && call.args[1] === "create");
    expect(create?.args).toContain("-");
    expect(create?.args).not.toContain("Sensitive body");
    expect(create?.stdin).toBe("Sensitive body");
  });

  it("updates Issue text, labels, assignees, comments, and state without arbitrary gh access", async () => {
    const { calls, runner } = makeRunner();
    await updateGitHubIssue(
      "/project",
      12,
      {
        title: "Updated",
        body: "Updated body",
        addLabels: ["ready"],
        removeLabels: ["blocked"],
        addAssignees: ["octocat"],
        removeAssignees: ["hubot"],
      },
      runner,
    );
    await commentOnGitHubIssue("/project", 12, "Comment body", runner);
    await setGitHubIssueState("/project", 12, "closed", runner);
    await setGitHubIssueState("/project", 12, "open", runner);

    const edit = calls.find((call) => call.command === "gh" && call.args[1] === "edit");
    expect(edit?.args).toEqual(
      expect.arrayContaining([
        "--add-label",
        "ready",
        "--remove-label",
        "blocked",
        "--add-assignee",
        "octocat",
        "--remove-assignee",
        "hubot",
      ]),
    );
    expect(edit?.stdin).toBe("Updated body");
    expect(calls.some((call) => call.args[0] === "issue" && call.args[1] === "close")).toBe(true);
    expect(calls.some((call) => call.args[0] === "issue" && call.args[1] === "reopen")).toBe(true);
  });
});

describe("GitHub Pull Request delivery commands", () => {
  it("creates a PR only from the current branch", async () => {
    const { calls, runner } = makeRunner();
    await expect(
      createGitHubPullRequest("/project", { title: "Ship delivery tools", body: "PR body", base: "main" }, runner),
    ).resolves.toEqual({ number: 21, url: "https://github.com/acme/widgets/pull/21" });

    const create = calls.find((call) => call.command === "gh" && call.args[0] === "pr" && call.args[1] === "create");
    expect(create?.args).toEqual(expect.arrayContaining(["--head", "feature/delivery-tools", "--base", "main"]));
    expect(create?.args).not.toContain("PR body");
    expect(create?.stdin).toBe("PR body");
  });

  it("updates and comments on PRs, requests reviewers, and never emits merge commands", async () => {
    const { calls, runner } = makeRunner();
    await updateGitHubPullRequest("/project", 21, { title: "Updated PR", body: "Updated body" }, runner);
    await commentOnGitHubPullRequest("/project", 21, "Review note", runner);
    await requestGitHubPullRequestReview("/project", 21, ["octocat", "acme/platform"], runner);

    expect(calls.some((call) => call.args[0] === "pr" && call.args[1] === "edit")).toBe(true);
    expect(calls.some((call) => call.args[0] === "pr" && call.args[1] === "comment")).toBe(true);
    expect(calls.some((call) => call.args.includes("merge"))).toBe(false);
  });

  it("reads CI and check results without changing repository state", async () => {
    const { calls, runner } = makeRunner();
    await expect(getGitHubPullRequestChecks("/project", 21, runner)).resolves.toEqual([
      expect.objectContaining({ name: "test", bucket: "pass" }),
    ]);
    const checks = calls.find((call) => call.command === "gh" && call.args[1] === "checks");
    expect(checks?.args).toContain("--json");
  });

  it("returns an empty check list when GitHub reports no checks", async () => {
    const runner: GitHubCommandRunner = async (call) => {
      if (call.command === "git") return "https://github.com/acme/widgets.git\n";
      throw new DomainError(ErrorCode.COMMAND_NOT_ALLOWED, "gh command failed", {
        stderr: "no checks reported on the 'feature' branch\n",
      });
    };

    await expect(getGitHubPullRequestChecks("/project", 21, runner)).resolves.toEqual([]);
  });
});
