import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { resolveInProject } from "./policy/paths.js";
import { redact } from "./policy/secrets.js";
import { DomainError, ErrorCode } from "./types.js";

export interface FeedbackRecord {
  version: 1;
  feedbackId: string;
  projectId: string;
  loopId: string;
  skillPath: string;
  whatWentWrong: string;
  whyItWasWrong: string;
  evidenceIds: string[];
  confirmedByUser: true;
  createdAt: string;
}

export interface SkillImprovementProposal {
  version: 1;
  proposalId: string;
  targetProjectId: string;
  skillPath: string;
  baseHash: string;
  supportingFeedbackIds: string[];
  contradictingFeedbackIds: string[];
  summary: string;
  unifiedDiff: string;
  status: "proposed" | "approved" | "rejected" | "adopted";
  createdAt: string;
  updatedAt: string;
}

const feedbackInputSchema = z.object({
  projectId: z.string().min(1),
  loopId: z.string().min(1),
  skillPath: z.string().min(1),
  whatWentWrong: z.string().min(1).max(1000),
  whyItWasWrong: z.string().min(1).max(1000),
  evidenceIds: z.array(z.string().min(1)).min(1).max(20),
  confirmedByUser: z.literal(true),
});

function safeId(id: string, kind: string): string {
  if (!/^[A-Za-z0-9_.-]+$/.test(id)) {
    throw new DomainError(ErrorCode.FEEDBACK_INVALID, `Invalid ${kind} id`);
  }
  return id;
}

function validateSkillPath(skillPath: string): string {
  const normalized = skillPath.split(path.sep).join("/");
  if (
    path.isAbsolute(skillPath) ||
    normalized.split("/").includes("..") ||
    path.posix.basename(normalized) !== "SKILL.md"
  ) {
    throw new DomainError(ErrorCode.SKILL_IMPROVEMENT_BLOCKED, "skillPath must target one project-confined SKILL.md");
  }
  return normalized.replace(/^\.\//, "");
}

function feedbackDir(stateDir: string): string {
  return path.join(stateDir, "improvements", "feedback");
}

function proposalDir(stateDir: string): string {
  return path.join(stateDir, "improvements", "proposals");
}

async function atomicJson(target: string, value: unknown): Promise<void> {
  const dir = path.dirname(target);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const temp = path.join(dir, `.${path.basename(target)}.${process.pid}.${Date.now()}.tmp`);
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temp, target);
}

export async function recordFeedback(
  stateDir: string,
  input: Omit<FeedbackRecord, "version" | "feedbackId" | "createdAt">,
): Promise<FeedbackRecord> {
  const parsed = feedbackInputSchema.safeParse(input);
  if (!parsed.success) {
    throw new DomainError(ErrorCode.FEEDBACK_INVALID, "Feedback requires user-confirmed what/why and evidence");
  }
  let skillPath: string;
  try {
    skillPath = validateSkillPath(parsed.data.skillPath);
  } catch {
    throw new DomainError(ErrorCode.FEEDBACK_INVALID, "Feedback skillPath must target SKILL.md");
  }
  const feedbackId = `fb_${Date.now()}_${randomUUID().slice(0, 8)}`;
  const record: FeedbackRecord = {
    version: 1,
    feedbackId,
    projectId: parsed.data.projectId,
    loopId: parsed.data.loopId,
    skillPath,
    whatWentWrong: redact(parsed.data.whatWentWrong).slice(0, 1000),
    whyItWasWrong: redact(parsed.data.whyItWasWrong).slice(0, 1000),
    evidenceIds: parsed.data.evidenceIds,
    confirmedByUser: true,
    createdAt: new Date().toISOString(),
  };
  await atomicJson(path.join(feedbackDir(stateDir), `${feedbackId}.json`), record);
  return record;
}

export async function listFeedback(
  stateDir: string,
  filter: { projectId?: string; skillPath?: string } = {},
): Promise<FeedbackRecord[]> {
  let names: string[];
  try {
    names = await readdir(feedbackDir(stateDir));
  } catch {
    return [];
  }
  const records: FeedbackRecord[] = [];
  for (const name of names.filter((entry) => entry.endsWith(".json")).sort()) {
    try {
      const record = JSON.parse(await readFile(path.join(feedbackDir(stateDir), name), "utf8")) as FeedbackRecord;
      if (record.version !== 1 || record.confirmedByUser !== true) continue;
      if (filter.projectId && record.projectId !== filter.projectId) continue;
      if (filter.skillPath && record.skillPath !== validateSkillPath(filter.skillPath)) continue;
      records.push(record);
    } catch {
      continue;
    }
  }
  return records;
}

export async function reviewSkillFeedback(
  stateDir: string,
  input: { projectId: string; skillPath: string },
): Promise<{
  ready: boolean;
  requiredCount: number;
  feedback: FeedbackRecord[];
  repeatedReasons: Array<{ reason: string; count: number }>;
}> {
  const feedback = await listFeedback(stateDir, {
    projectId: input.projectId,
    skillPath: input.skillPath,
  });
  const counts = new Map<string, number>();
  for (const record of feedback) counts.set(record.whyItWasWrong, (counts.get(record.whyItWasWrong) ?? 0) + 1);
  return {
    ready: feedback.length >= 3,
    requiredCount: 3,
    feedback,
    repeatedReasons: [...counts.entries()]
      .map(([reason, count]) => ({ reason, count }))
      .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason)),
  };
}

async function feedbackById(stateDir: string, feedbackId: string): Promise<FeedbackRecord> {
  try {
    return JSON.parse(
      await readFile(path.join(feedbackDir(stateDir), `${safeId(feedbackId, "feedback")}.json`), "utf8"),
    ) as FeedbackRecord;
  } catch {
    throw new DomainError(ErrorCode.SKILL_IMPROVEMENT_BLOCKED, `Feedback record not found: ${feedbackId}`);
  }
}

function validateUnifiedDiff(unifiedDiff: string, skillPath: string): void {
  if (redact(unifiedDiff) !== unifiedDiff) {
    throw new DomainError(ErrorCode.SKILL_IMPROVEMENT_BLOCKED, "Proposal contains secret-like content");
  }
  const headers = unifiedDiff
    .split("\n")
    .filter((line) => line.startsWith("--- ") || line.startsWith("+++ "));
  if (
    headers.length !== 2 ||
    headers[0] !== `--- a/${skillPath}` ||
    headers[1] !== `+++ b/${skillPath}`
  ) {
    throw new DomainError(ErrorCode.SKILL_IMPROVEMENT_BLOCKED, "Proposal must change exactly one SKILL.md");
  }
  const changedLines = unifiedDiff
    .split("\n")
    .filter((line) => (line.startsWith("+") && !line.startsWith("+++")) || (line.startsWith("-") && !line.startsWith("---")))
    .length;
  if (changedLines === 0 || changedLines > 120) {
    throw new DomainError(ErrorCode.SKILL_IMPROVEMENT_BLOCKED, "Proposal diff must contain 1 to 120 changed lines");
  }
}

export async function createSkillImprovementProposal(
  stateDir: string,
  targetProjectRoot: string,
  input: {
    targetProjectId: string;
    skillPath: string;
    baseHash: string;
    supportingFeedbackIds: string[];
    contradictingFeedbackIds: string[];
    summary: string;
    unifiedDiff: string;
  },
): Promise<SkillImprovementProposal> {
  const skillPath = validateSkillPath(input.skillPath);
  if (input.supportingFeedbackIds.length < 3) {
    throw new DomainError(ErrorCode.SKILL_IMPROVEMENT_BLOCKED, "At least three supporting feedback records are required");
  }
  if (input.summary.trim().length === 0 || input.summary.length > 1000) {
    throw new DomainError(ErrorCode.SKILL_IMPROVEMENT_BLOCKED, "Proposal summary is invalid");
  }
  const feedback = await Promise.all(input.supportingFeedbackIds.map((id) => feedbackById(stateDir, id)));
  if (feedback.some((record) => record.projectId !== input.targetProjectId || record.skillPath !== skillPath)) {
    throw new DomainError(ErrorCode.SKILL_IMPROVEMENT_BLOCKED, "Supporting feedback must match project and Skill");
  }
  await Promise.all(input.contradictingFeedbackIds.map((id) => feedbackById(stateDir, id)));
  validateUnifiedDiff(input.unifiedDiff, skillPath);

  const absoluteSkillPath = await resolveInProject(targetProjectRoot, skillPath, { allowSymlink: false });
  const current = await readFile(absoluteSkillPath, "utf8");
  const currentHash = createHash("sha256").update(current).digest("hex");
  if (currentHash !== input.baseHash) {
    throw new DomainError(ErrorCode.SKILL_IMPROVEMENT_BLOCKED, "Skill changed after review", {
      expected: input.baseHash,
      actual: currentHash,
    });
  }

  const now = new Date().toISOString();
  const proposalId = `sip_${Date.now()}_${randomUUID().slice(0, 8)}`;
  const proposal: SkillImprovementProposal = {
    version: 1,
    proposalId,
    targetProjectId: input.targetProjectId,
    skillPath,
    baseHash: input.baseHash,
    supportingFeedbackIds: [...new Set(input.supportingFeedbackIds)],
    contradictingFeedbackIds: [...new Set(input.contradictingFeedbackIds)],
    summary: redact(input.summary),
    unifiedDiff: input.unifiedDiff,
    status: "proposed",
    createdAt: now,
    updatedAt: now,
  };
  await atomicJson(path.join(proposalDir(stateDir), `${proposalId}.json`), proposal);
  return proposal;
}

export async function listSkillImprovementProposals(
  stateDir: string,
  filter: { status?: SkillImprovementProposal["status"]; limit?: number } = {},
): Promise<SkillImprovementProposal[]> {
  let names: string[];
  try {
    names = await readdir(proposalDir(stateDir));
  } catch {
    return [];
  }
  const proposals: SkillImprovementProposal[] = [];
  for (const name of names.filter((entry) => entry.endsWith(".json")).sort().reverse()) {
    try {
      const proposal = JSON.parse(await readFile(path.join(proposalDir(stateDir), name), "utf8")) as SkillImprovementProposal;
      if (proposal.version !== 1) continue;
      if (filter.status && proposal.status !== filter.status) continue;
      proposals.push(proposal);
      if (proposals.length >= (filter.limit ?? 50)) break;
    } catch {
      continue;
    }
  }
  return proposals;
}
