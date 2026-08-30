import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { VerificationProfile } from "./types.js";
import { computeVerificationDiffHash, runVerification } from "./runner.js";

const profile: VerificationProfile = {
  version: 1,
  commands: [{ commandId: "npm:typecheck" }, { commandId: "npm:test" }],
  scenarios: [{ kind: "http", method: "GET", url: "http://127.0.0.1:4321/health", expectStatus: 200 }],
  limits: { maxAttempts: 3, maxMinutes: 30 },
};

describe("runVerification", () => {
  it("changes the diff hash when an untracked file is added", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "chatgpt2codex-runner-git-"));
    const { execFile } = await import("node:child_process");
    await new Promise<void>((resolve, reject) => {
      execFile("git", ["init", "-q"], { cwd: root }, (error) => error ? reject(error) : resolve());
    });
    const before = await computeVerificationDiffHash(root);
    await import("node:fs/promises").then(({ writeFile }) => writeFile(path.join(root, "new-file.txt"), "new"));
    const after = await computeVerificationDiffHash(root);

    expect(after).not.toBe(before);
  });

  it("runs checks in order and persists a passed report", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "chatgpt2codex-runner-"));
    const calls: string[] = [];
    const report = await runVerification(root, "project-1", profile, 1, {
      runCommand: vi.fn(async (_root, commandId) => {
        calls.push(commandId);
        return {
          exitCode: 0,
          stdoutSummary: "ok",
          stderrSummary: "",
          durationMs: 2,
          outputTruncated: false,
        };
      }),
      getWorkingDiff: vi.fn(async () => "diff"),
      fetch: vi.fn(async () => new Response("ok", { status: 200 })),
    });

    expect(calls).toEqual(["npm:typecheck", "npm:test"]);
    expect(report.verdict).toBe("passed");
    expect(report.checks.map((check) => check.status)).toEqual(["passed", "passed", "passed"]);
    expect(JSON.parse(await readFile(path.join(root, report.evidencePath), "utf8"))).toMatchObject({
      runId: report.runId,
      verdict: "passed",
    });
  });

  it("records command failure and skips later executable checks", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "chatgpt2codex-runner-"));
    const report = await runVerification(root, "project-1", profile, 1, {
      runCommand: vi
        .fn()
        .mockResolvedValueOnce({
          exitCode: 1,
          stdoutSummary: "",
          stderrSummary: "failed",
          durationMs: 2,
          outputTruncated: false,
        }),
      getWorkingDiff: vi.fn(async () => ""),
      fetch: vi.fn(),
    });

    expect(report.verdict).toBe("failed");
    expect(report.checks).toHaveLength(1);
    expect(report.failureFingerprint).toMatch(/^[a-f0-9]{64}$/);
  });
});
