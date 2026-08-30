import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { DomainError, ErrorCode } from "../types.js";
import type { VerificationReport } from "../verification/types.js";

export type GoalLoopPhase =
  | "PLANNING"
  | "IMPLEMENTING"
  | "VERIFYING"
  | "REPAIRING"
  | "SUCCEEDED"
  | "BLOCKED"
  | "EXHAUSTED";

export interface GoalLoopTurn {
  turn: number;
  at: string;
  lastResult?: string;
  nextActions?: string[];
}

export interface GoalLoopDocumentV2 {
  version: 2;
  loopId: string;
  projectId?: string;
  goalPreview?: string;
  mode?: string;
  phase: GoalLoopPhase;
  maxTurns: number;
  turn: number;
  latestVerificationRunId?: string;
  currentDiffHash?: string;
  consecutiveFailureFingerprintCount: number;
  lastFailureFingerprint?: string;
  turns: GoalLoopTurn[];
}

const turnSchema = z.object({
  turn: z.number().int().min(1),
  at: z.string(),
  lastResult: z.string().optional(),
  nextActions: z.array(z.string()).optional(),
});

const documentSchema = z.object({
  version: z.literal(2),
  loopId: z.string().min(1),
  projectId: z.string().optional(),
  goalPreview: z.string().optional(),
  mode: z.string().optional(),
  phase: z.enum(["PLANNING", "IMPLEMENTING", "VERIFYING", "REPAIRING", "SUCCEEDED", "BLOCKED", "EXHAUSTED"]),
  maxTurns: z.number().int().min(1).max(50),
  turn: z.number().int().min(0),
  latestVerificationRunId: z.string().optional(),
  currentDiffHash: z.string().optional(),
  consecutiveFailureFingerprintCount: z.number().int().min(0),
  lastFailureFingerprint: z.string().optional(),
  turns: z.array(turnSchema),
});

function loopPath(stateDir: string, loopId: string): string {
  if (!/^[A-Za-z0-9_.-]+$/.test(loopId)) {
    throw new DomainError(ErrorCode.NOT_IMPLEMENTED, "Invalid goal loop id", { loopId });
  }
  return path.join(stateDir, "goals", `${loopId}.loop.json`);
}

export function advanceGoalLoop(
  document: GoalLoopDocumentV2,
  event: { type: "verification"; report: VerificationReport; currentDiffHash: string },
): GoalLoopDocumentV2 {
  const next: GoalLoopDocumentV2 = {
    ...document,
    latestVerificationRunId: event.report.runId,
    currentDiffHash: event.currentDiffHash,
  };
  if (event.report.diffHash !== event.currentDiffHash) {
    return { ...next, phase: "VERIFYING" };
  }
  if (event.report.verdict === "passed") {
    return {
      ...next,
      phase: "SUCCEEDED",
      consecutiveFailureFingerprintCount: 0,
      lastFailureFingerprint: undefined,
    };
  }
  if (event.report.verdict === "blocked") return { ...next, phase: "BLOCKED" };

  const fingerprint = event.report.failureFingerprint;
  const count = fingerprint && fingerprint === document.lastFailureFingerprint
    ? document.consecutiveFailureFingerprintCount + 1
    : 1;
  return {
    ...next,
    phase: count >= 2 || document.turn >= document.maxTurns ? "EXHAUSTED" : "REPAIRING",
    consecutiveFailureFingerprintCount: count,
    lastFailureFingerprint: fingerprint,
  };
}

export async function saveGoalLoop(stateDir: string, document: GoalLoopDocumentV2): Promise<void> {
  const parsed = documentSchema.parse(document);
  const dir = path.join(stateDir, "goals");
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const target = loopPath(stateDir, parsed.loopId);
  const temp = path.join(dir, `.${parsed.loopId}.${process.pid}.${Date.now()}.tmp`);
  await writeFile(temp, `${JSON.stringify(parsed, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temp, target);
}

export async function loadGoalLoop(stateDir: string, loopId: string): Promise<GoalLoopDocumentV2 | undefined> {
  let input: unknown;
  try {
    input = JSON.parse(await readFile(loopPath(stateDir, loopId), "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  const current = documentSchema.safeParse(input);
  if (current.success) return current.data;

  const legacy = input as {
    loopId?: unknown;
    projectId?: unknown;
    goalPreview?: unknown;
    mode?: unknown;
    maxTurns?: unknown;
    turns?: unknown;
  };
  const turns = z.array(turnSchema).catch([]).parse(legacy.turns);
  return documentSchema.parse({
    version: 2,
    loopId,
    projectId: typeof legacy.projectId === "string" ? legacy.projectId : undefined,
    goalPreview: typeof legacy.goalPreview === "string" ? legacy.goalPreview : undefined,
    mode: typeof legacy.mode === "string" ? legacy.mode : undefined,
    phase: "IMPLEMENTING",
    maxTurns: typeof legacy.maxTurns === "number" ? legacy.maxTurns : 12,
    turn: turns.length,
    consecutiveFailureFingerprintCount: 0,
    turns,
  });
}
