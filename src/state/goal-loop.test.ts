import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { VerificationReport } from "../verification/types.js";
import {
  advanceGoalLoop,
  loadGoalLoop,
  saveGoalLoop,
  type GoalLoopDocumentV2,
} from "./goal-loop.js";

function document(overrides: Partial<GoalLoopDocumentV2> = {}): GoalLoopDocumentV2 {
  return {
    version: 2,
    loopId: "loop-1",
    projectId: "project-1",
    phase: "VERIFYING",
    maxTurns: 3,
    turn: 1,
    consecutiveFailureFingerprintCount: 0,
    turns: [],
    ...overrides,
  };
}

function report(overrides: Partial<VerificationReport> = {}): VerificationReport {
  return {
    version: 1,
    runId: "vr-1",
    projectId: "project-1",
    attempt: 1,
    startedAt: new Date(0).toISOString(),
    finishedAt: new Date(1).toISOString(),
    diffHash: "diff-1",
    verdict: "passed",
    checks: [],
    evidencePath: "/tmp/report.json",
    ...overrides,
  };
}

describe("goal loop state", () => {
  it("rejects a stale passed report and returns to verifying", () => {
    const next = advanceGoalLoop(document(), {
      type: "verification",
      report: report(),
      currentDiffHash: "diff-2",
    });

    expect(next.phase).toBe("VERIFYING");
    expect(next.latestVerificationRunId).toBe("vr-1");
  });

  it("succeeds only with a passed report for the current diff", () => {
    const next = advanceGoalLoop(document(), {
      type: "verification",
      report: report(),
      currentDiffHash: "diff-1",
    });

    expect(next.phase).toBe("SUCCEEDED");
  });

  it("exhausts after the same failure fingerprint twice", () => {
    const first = advanceGoalLoop(document(), {
      type: "verification",
      report: report({ verdict: "failed", failureFingerprint: "same" }),
      currentDiffHash: "diff-1",
    });
    const second = advanceGoalLoop(first, {
      type: "verification",
      report: report({ runId: "vr-2", verdict: "failed", failureFingerprint: "same" }),
      currentDiffHash: "diff-1",
    });

    expect(first.phase).toBe("REPAIRING");
    expect(second.phase).toBe("EXHAUSTED");
  });

  it("persists version 2 atomically", async () => {
    const stateDir = await mkdtemp(path.join(tmpdir(), "chatgpt2codex-goal-"));
    await saveGoalLoop(stateDir, document());

    expect(await loadGoalLoop(stateDir, "loop-1")).toMatchObject({ version: 2, loopId: "loop-1" });
    expect(JSON.parse(await readFile(path.join(stateDir, "goals", "loop-1.loop.json"), "utf8"))).toMatchObject({
      version: 2,
    });
  });
});
