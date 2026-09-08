import { createHash, randomBytes, randomUUID } from "node:crypto";

export const SHELL_APPROVAL_TTL_MS = 5 * 60 * 1000;
const MAX_APPROVALS = 200;

export interface ShellApprovalBinding {
  command: string;
  root: string;
  cwd: string;
  timeoutSec: number;
  declaredWritesWorkspace: boolean;
  declaredNeedsNetwork: boolean;
  declaredDestructive: boolean;
  inferredNetwork: boolean;
  sessionKey: string;
  clientId?: string;
  projectId: string;
  leaseId: string;
}

export interface ShellApprovalRecord extends ShellApprovalBinding {
  approvalId: string;
  expiresAt: number;
  approveChallenge: string;
  denyChallenge: string;
  state: "pending" | "approved" | "denied" | "consumed";
  resumeTokenHash?: string;
}

function sameBinding(a: ShellApprovalBinding, b: ShellApprovalBinding): boolean {
  return a.command === b.command && a.root === b.root && a.cwd === b.cwd && a.timeoutSec === b.timeoutSec &&
    a.declaredWritesWorkspace === b.declaredWritesWorkspace && a.declaredNeedsNetwork === b.declaredNeedsNetwork && a.declaredDestructive === b.declaredDestructive &&
    a.inferredNetwork === b.inferredNetwork && a.sessionKey === b.sessionKey && a.clientId === b.clientId &&
    a.projectId === b.projectId && a.leaseId === b.leaseId;
}

/** Process-local, one-use approvals. They intentionally disappear on restart. */
export class ShellApprovalStore {
  private readonly records = new Map<string, ShellApprovalRecord>();

  constructor(private readonly now: () => number = Date.now) {}

  request(binding: ShellApprovalBinding, requireResumeToken = false): { record: ShellApprovalRecord; resumeToken?: string } {
    this.prune();
    while (this.records.size >= MAX_APPROVALS) this.records.delete(this.records.keys().next().value as string);
    const resumeToken = requireResumeToken ? randomBytes(32).toString("base64url") : undefined;
    const record: ShellApprovalRecord = {
      ...binding, approvalId: randomUUID(), approveChallenge: randomUUID(), denyChallenge: randomUUID(), expiresAt: this.now() + SHELL_APPROVAL_TTL_MS, state: "pending",
      ...(resumeToken ? { resumeTokenHash: createHash("sha256").update(resumeToken).digest("base64url") } : {}),
    };
    this.records.set(record.approvalId, record);
    return { record, resumeToken };
  }

  getPending(approvalId: string): ShellApprovalRecord | undefined {
    const record = this.records.get(approvalId);
    if (!record || record.expiresAt < this.now() || record.state !== "pending") return undefined;
    return record;
  }

  getPendingForRetry(approvalId: string, binding: ShellApprovalBinding, resumeToken?: string): ShellApprovalRecord | undefined {
    const record = this.getPending(approvalId);
    if (!record || !sameBinding(record, binding)) return undefined;
    if (record.resumeTokenHash !== undefined && (!resumeToken || createHash("sha256").update(resumeToken).digest("base64url") !== record.resumeTokenHash)) return undefined;
    return record;
  }

  pending(): ShellApprovalRecord[] {
    this.prune();
    return [...this.records.values()].filter((record) => record.state === "pending");
  }

  decide(approvalId: string, challenge: string, approve: boolean): boolean {
    const record = this.getPending(approvalId);
    if (!record || (approve ? record.approveChallenge : record.denyChallenge) !== challenge) return false;
    record.state = approve ? "approved" : "denied";
    return true;
  }

  consumeApproved(approvalId: string, binding: ShellApprovalBinding, resumeToken?: string): boolean {
    const record = this.records.get(approvalId);
    if (!record || record.expiresAt < this.now() || record.state !== "approved" || !sameBinding(record, binding) ||
      (record.resumeTokenHash !== undefined && (!resumeToken || createHash("sha256").update(resumeToken).digest("base64url") !== record.resumeTokenHash))) return false;
    record.state = "consumed";
    return true;
  }

  private prune(): void {
    for (const [id, record] of this.records) if (record.expiresAt < this.now() || record.state === "denied" || record.state === "consumed") this.records.delete(id);
  }
}
