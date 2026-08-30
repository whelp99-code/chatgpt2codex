import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { redact } from "../policy/secrets.js";
import { getWorkingDiff } from "../state/checkpoints.js";
import { runCommand } from "../exec/command-runner.js";
import {
  captureE2eAppScreenshot,
  captureE2eUrlScreenshot,
  startE2eServer,
  stopE2eServer,
} from "../e2e/local-e2e.js";
import { verificationReportPath, writeVerificationReport } from "./report-store.js";
import type {
  VerificationCheck,
  VerificationProfile,
  VerificationReport,
} from "./types.js";

const execFileAsync = promisify(execFile);

type CommandResult = Awaited<ReturnType<typeof runCommand>>;

export interface VerificationRunnerDeps {
  runCommand(root: string, commandId: string, args?: string[], timeoutSec?: number): Promise<CommandResult>;
  getWorkingDiff(root: string): Promise<string>;
  fetch(input: string | URL | Request, init?: RequestInit): Promise<Response>;
  startServer: typeof startE2eServer;
  stopServer: typeof stopE2eServer;
  screenshot(
    root: string,
    scenario: Extract<NonNullable<VerificationProfile["scenarios"]>[number], { kind: "screenshot" }>,
  ): Promise<{ path: string }>;
}

function defaultRunnerDeps(): VerificationRunnerDeps {
  return {
    runCommand,
    getWorkingDiff,
    fetch: globalThis.fetch,
    startServer: startE2eServer,
    stopServer: stopE2eServer,
    screenshot: async (root, scenario) => {
      if (scenario.url) return captureE2eUrlScreenshot(root, { url: scenario.url, label: scenario.label });
      if (!scenario.appName) throw new Error("Screenshot scenario requires url or appName");
      return captureE2eAppScreenshot(root, { appName: scenario.appName, label: scenario.label });
    },
  };
}

function fingerprint(check: VerificationCheck): string {
  return createHash("sha256")
    .update(`${check.id}\0${check.exitCode ?? ""}\0${check.summary}`)
    .digest("hex");
}

export async function computeVerificationDiffHash(
  projectRoot: string,
  readDiff: (root: string) => Promise<string> = getWorkingDiff,
): Promise<string> {
  const diff = await readDiff(projectRoot);
  let status = "";
  let untrackedHashes = "";
  try {
    const result = await execFileAsync(
      "git",
      ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
      { cwd: projectRoot, windowsHide: true, maxBuffer: 10 * 1024 * 1024 },
    );
    status = String(result.stdout);
    const untracked = status
      .split("\0")
      .filter((record) => record.startsWith("?? "))
      .map((record) => record.slice(3));
    const hashes = await Promise.all(untracked.map(async (file) => {
      const hashed = await execFileAsync(
        "git",
        ["hash-object", "--", file],
        { cwd: projectRoot, windowsHide: true, maxBuffer: 1024 * 1024 },
      );
      return `${file}\0${String(hashed.stdout).trim()}`;
    }));
    untrackedHashes = hashes.sort().join("\0");
  } catch {
    // Non-Git projects still get a stable hash from the guarded diff provider.
  }
  return createHash("sha256").update(`${diff}\0${status}\0${untrackedHashes}`).digest("hex");
}

export async function runVerification(
  projectRoot: string,
  projectId: string,
  profile: VerificationProfile,
  attempt: number,
  overrides: Partial<VerificationRunnerDeps> = {},
): Promise<VerificationReport> {
  const deps = { ...defaultRunnerDeps(), ...overrides };
  const startedAt = new Date().toISOString();
  const runId = `vr_${Date.now()}_${randomUUID().slice(0, 8)}`;
  const checks: VerificationCheck[] = [];
  const deadline = Date.now() + profile.limits.maxMinutes * 60_000;
  let serverPid: number | undefined;

  try {
    for (const command of profile.commands) {
      if (Date.now() >= deadline) {
        checks.push({
          id: command.commandId,
          kind: "command",
          status: "blocked",
          summary: "Verification deadline exceeded",
          evidencePaths: [],
        });
        break;
      }
      const result = await deps.runCommand(projectRoot, command.commandId, undefined, command.timeoutSec);
      const summary = redact(result.exitCode === 0 ? result.stdoutSummary : result.stderrSummary).slice(0, 2000);
      const check: VerificationCheck = {
        id: command.commandId,
        kind: "command",
        status: result.exitCode === 0 ? "passed" : "failed",
        exitCode: result.exitCode,
        summary,
        evidencePaths: [],
      };
      checks.push(check);
      if (check.status !== "passed") break;
    }

    if (checks.every((check) => check.status === "passed") && profile.server) {
      const server = await deps.startServer(projectRoot, {
        command: profile.server.command,
        waitUrl: profile.server.waitUrl,
        waitTimeoutSec: profile.server.timeoutSec,
        label: `verification-${runId}`,
      });
      serverPid = server.pid;
      if (server.wait && !server.wait.ok) {
        checks.push({
          id: "server",
          kind: "http",
          status: "failed",
          summary: redact(server.wait.error ?? "Server did not become ready"),
          evidencePaths: [path.relative(projectRoot, server.logPath)],
        });
      }
    }

    if (checks.every((check) => check.status === "passed")) {
      for (const [index, scenario] of (profile.scenarios ?? []).entries()) {
        if (scenario.kind === "http") {
          const response = await deps.fetch(scenario.url, {
            method: scenario.method,
            signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())),
          });
          checks.push({
            id: `http:${index + 1}`,
            kind: "http",
            status: response.status === scenario.expectStatus ? "passed" : "failed",
            summary: `HTTP ${response.status}; expected ${scenario.expectStatus}`,
            evidencePaths: [],
          });
        } else {
          const shot = await deps.screenshot(projectRoot, scenario);
          checks.push({
            id: `screenshot:${index + 1}`,
            kind: "screenshot",
            status: "passed",
            summary: scenario.label,
            evidencePaths: [path.relative(projectRoot, shot.path)],
          });
        }
        if (checks.at(-1)?.status !== "passed") break;
      }
    }
  } catch (error) {
    checks.push({
      id: `runtime:${checks.length + 1}`,
      kind: "command",
      status: "failed",
      summary: redact(error instanceof Error ? error.message : String(error)).slice(0, 2000),
      evidencePaths: [],
    });
  } finally {
    if (serverPid) await deps.stopServer({ pid: serverPid });
  }

  const failed = checks.find((check) => check.status !== "passed");
  const diffHash = await computeVerificationDiffHash(projectRoot, deps.getWorkingDiff);
  const report: VerificationReport = {
    version: 1,
    runId,
    projectId,
    attempt,
    startedAt,
    finishedAt: new Date().toISOString(),
    diffHash,
    verdict: failed?.status === "blocked" ? "blocked" : failed ? "failed" : "passed",
    failureFingerprint: failed ? fingerprint(failed) : undefined,
    checks,
    evidencePath: path.relative(projectRoot, verificationReportPath(projectRoot, runId)),
  };
  await writeVerificationReport(projectRoot, report);
  return report;
}
