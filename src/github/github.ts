import { execFile } from "node:child_process";
import { DomainError, ErrorCode } from "../types.js";
import { redact } from "../policy/secrets.js";
import { buildSafeChildEnv } from "../exec/command-runner.js";

const COMMAND_TIMEOUT_MS = 60_000;
const MAX_OUTPUT_BYTES = 10 * 1024 * 1024;
const REPOSITORY_PART = /^[A-Za-z0-9_.-]+$/u;

export interface GitHubCommandCall {
  cwd: string;
  command: "git" | "gh";
  args: string[];
  stdin?: string;
}

export type GitHubCommandRunner = (call: GitHubCommandCall) => Promise<string>;

export interface GitHubIssueUpdate {
  title?: string;
  body?: string;
  addLabels?: string[];
  removeLabels?: string[];
  addAssignees?: string[];
  removeAssignees?: string[];
}

export interface GitHubPullRequestUpdate {
  title?: string;
  body?: string;
}

async function defaultRunner(call: GitHubCommandCall): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      call.command,
      call.args,
      {
        cwd: call.cwd,
        env: buildSafeChildEnv(),
        timeout: COMMAND_TIMEOUT_MS,
        maxBuffer: MAX_OUTPUT_BYTES,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(
            new DomainError(ErrorCode.COMMAND_NOT_ALLOWED, `${call.command} command failed`, {
              command: call.command,
              args: call.args,
              stderr: redact(stderr),
            }),
          );
          return;
        }
        resolve(stdout);
      },
    );
    child.stdin?.end(call.stdin);
  });
}

function invalidOrigin(remote: string): never {
  throw new DomainError(ErrorCode.COMMAND_NOT_ALLOWED, "Project origin is not a supported github.com repository", {
    remote: redact(remote),
  });
}

function canonicalRepository(owner: string | undefined, repository: string | undefined, remote: string): string {
  const name = repository?.replace(/\.git$/u, "");
  if (!owner || !name || !REPOSITORY_PART.test(owner) || !REPOSITORY_PART.test(name)) {
    return invalidOrigin(remote);
  }
  return `${owner}/${name}`;
}

export function parseGitHubRepository(remote: string): string {
  const value = remote.trim();
  const scp = /^git@github\.com:([^/]+)\/([^/]+)$/u.exec(value);
  if (scp) return canonicalRepository(scp[1], scp[2], remote);

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return invalidOrigin(remote);
  }
  if (parsed.hostname.toLowerCase() !== "github.com") return invalidOrigin(remote);
  if (parsed.protocol === "ssh:" && parsed.username !== "git") return invalidOrigin(remote);
  if (parsed.protocol !== "https:" && parsed.protocol !== "ssh:") return invalidOrigin(remote);
  const parts = parsed.pathname.split("/").filter(Boolean);
  if (parts.length !== 2) return invalidOrigin(remote);
  return canonicalRepository(parts[0], parts[1], remote);
}

async function projectRepository(root: string, runner: GitHubCommandRunner): Promise<string> {
  const remote = await runner({
    cwd: root,
    command: "git",
    args: ["config", "--get", "remote.origin.url"],
  });
  return parseGitHubRepository(remote);
}

async function runGitHub(
  root: string,
  args: string[],
  runner: GitHubCommandRunner,
  stdin?: string,
): Promise<string> {
  const repository = await projectRepository(root, runner);
  return runner({
    cwd: root,
    command: "gh",
    args: [...args, "--repo", repository],
    stdin,
  });
}

function parseJson<T>(raw: string, operation: string): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new DomainError(ErrorCode.COMMAND_NOT_ALLOWED, `GitHub ${operation} returned invalid JSON`);
  }
}

function parseCreatedUrl(raw: string, resource: "issues" | "pull"): { number: number; url: string } {
  const url = raw.trim();
  const pattern =
    resource === "issues"
      ? /^https:\/\/github\.com\/[^/]+\/[^/]+\/issues\/(\d+)$/u
      : /^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/(\d+)$/u;
  const match = pattern.exec(url);
  if (!match?.[1]) {
    throw new DomainError(ErrorCode.COMMAND_NOT_ALLOWED, `GitHub ${resource} creation returned an unexpected URL`);
  }
  return { number: Number(match[1]), url };
}

function appendRepeated(args: string[], flag: string, values: readonly string[] | undefined): void {
  for (const value of values ?? []) args.push(flag, value);
}

export async function listGitHubIssues(
  root: string,
  options: { state?: "open" | "closed" | "all"; limit?: number },
  runner: GitHubCommandRunner = defaultRunner,
): Promise<Record<string, unknown>[]> {
  const raw = await runGitHub(
    root,
    [
      "issue",
      "list",
      "--state",
      options.state ?? "open",
      "--limit",
      String(options.limit ?? 30),
      "--json",
      "number,title,state,url,labels,assignees,author,createdAt,updatedAt",
    ],
    runner,
  );
  return parseJson<Record<string, unknown>[]>(raw, "Issue list");
}

export async function getGitHubIssue(
  root: string,
  number: number,
  runner: GitHubCommandRunner = defaultRunner,
): Promise<Record<string, unknown>> {
  const raw = await runGitHub(
    root,
    [
      "issue",
      "view",
      String(number),
      "--json",
      "number,title,body,state,url,labels,assignees,author,comments,createdAt,updatedAt",
    ],
    runner,
  );
  return parseJson<Record<string, unknown>>(raw, "Issue detail");
}

export async function createGitHubIssue(
  root: string,
  input: { title: string; body: string; labels?: string[]; assignees?: string[] },
  runner: GitHubCommandRunner = defaultRunner,
): Promise<{ number: number; url: string }> {
  const args = ["issue", "create", "--title", input.title, "--body-file", "-"];
  appendRepeated(args, "--label", input.labels);
  appendRepeated(args, "--assignee", input.assignees);
  return parseCreatedUrl(await runGitHub(root, args, runner, input.body), "issues");
}

export async function updateGitHubIssue(
  root: string,
  number: number,
  input: GitHubIssueUpdate,
  runner: GitHubCommandRunner = defaultRunner,
): Promise<{ number: number; updated: true }> {
  const args = ["issue", "edit", String(number)];
  if (input.title !== undefined) args.push("--title", input.title);
  if (input.body !== undefined) args.push("--body-file", "-");
  appendRepeated(args, "--add-label", input.addLabels);
  appendRepeated(args, "--remove-label", input.removeLabels);
  appendRepeated(args, "--add-assignee", input.addAssignees);
  appendRepeated(args, "--remove-assignee", input.removeAssignees);
  await runGitHub(root, args, runner, input.body);
  return { number, updated: true };
}

export async function commentOnGitHubIssue(
  root: string,
  number: number,
  body: string,
  runner: GitHubCommandRunner = defaultRunner,
): Promise<{ number: number; url: string }> {
  const url = (await runGitHub(root, ["issue", "comment", String(number), "--body-file", "-"], runner, body)).trim();
  return { number, url };
}

export async function setGitHubIssueState(
  root: string,
  number: number,
  state: "open" | "closed",
  runner: GitHubCommandRunner = defaultRunner,
): Promise<{ number: number; state: "open" | "closed" }> {
  await runGitHub(root, ["issue", state === "closed" ? "close" : "reopen", String(number)], runner);
  return { number, state };
}

async function currentBranch(root: string, runner: GitHubCommandRunner): Promise<string> {
  const branch = (
    await runner({
      cwd: root,
      command: "git",
      args: ["rev-parse", "--abbrev-ref", "HEAD"],
    })
  ).trim();
  if (!branch || branch === "HEAD") {
    throw new DomainError(ErrorCode.COMMAND_NOT_ALLOWED, "Pull Request creation requires a named current branch");
  }
  return branch;
}

export async function createGitHubPullRequest(
  root: string,
  input: { title: string; body: string; base?: string },
  runner: GitHubCommandRunner = defaultRunner,
): Promise<{ number: number; url: string }> {
  const branch = await currentBranch(root, runner);
  const args = ["pr", "create", "--head", branch, "--title", input.title, "--body-file", "-"];
  if (input.base) args.push("--base", input.base);
  return parseCreatedUrl(await runGitHub(root, args, runner, input.body), "pull");
}

export async function updateGitHubPullRequest(
  root: string,
  number: number,
  input: GitHubPullRequestUpdate,
  runner: GitHubCommandRunner = defaultRunner,
): Promise<{ number: number; updated: true }> {
  const args = ["pr", "edit", String(number)];
  if (input.title !== undefined) args.push("--title", input.title);
  if (input.body !== undefined) args.push("--body-file", "-");
  await runGitHub(root, args, runner, input.body);
  return { number, updated: true };
}

export async function commentOnGitHubPullRequest(
  root: string,
  number: number,
  body: string,
  runner: GitHubCommandRunner = defaultRunner,
): Promise<{ number: number; url: string }> {
  const url = (await runGitHub(root, ["pr", "comment", String(number), "--body-file", "-"], runner, body)).trim();
  return { number, url };
}

export async function requestGitHubPullRequestReview(
  root: string,
  number: number,
  reviewers: string[],
  runner: GitHubCommandRunner = defaultRunner,
): Promise<{ number: number; reviewers: string[] }> {
  const args = ["pr", "edit", String(number)];
  appendRepeated(args, "--add-reviewer", reviewers);
  await runGitHub(root, args, runner);
  return { number, reviewers };
}

export async function getGitHubPullRequestChecks(
  root: string,
  number: number,
  runner: GitHubCommandRunner = defaultRunner,
): Promise<Record<string, unknown>[]> {
  let raw: string;
  try {
    raw = await runGitHub(
      root,
      [
        "pr",
        "checks",
        String(number),
        "--json",
        "bucket,completedAt,description,event,link,name,startedAt,state,workflow",
      ],
      runner,
    );
  } catch (error) {
    const details = error instanceof DomainError ? error.details : undefined;
    const stderr =
      typeof details === "object" && details !== null && "stderr" in details
        ? String((details as { stderr?: unknown }).stderr ?? "")
        : "";
    if (stderr.toLowerCase().includes("no checks reported")) return [];
    throw error;
  }
  return parseJson<Record<string, unknown>[]>(raw, "check results");
}
