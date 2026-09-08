import { describe, expect, it } from "vitest";
import { ShellApprovalStore, SHELL_APPROVAL_TTL_MS, type ShellApprovalBinding } from "./shell-approvals.js";

const binding: ShellApprovalBinding = {
  command: "curl https://example.test", root: "/project", cwd: "/project/sub", timeoutSec: 60,
  declaredWritesWorkspace: false, declaredNeedsNetwork: false, declaredDestructive: false, inferredNetwork: true,
  sessionKey: "session-a", clientId: "client-a", projectId: "project-a", leaseId: "lease-a",
};

describe("ShellApprovalStore", () => {
  it("requires an exact, one-use approved binding", () => {
    const store = new ShellApprovalStore(() => 100);
    const pending = store.request(binding).record;
    expect(store.decide(pending.approvalId, pending.approveChallenge, true)).toBe(true);
    expect(store.consumeApproved(pending.approvalId, binding)).toBe(true);
    expect(store.consumeApproved(pending.approvalId, binding)).toBe(false);
  });

  it.each<Partial<ShellApprovalBinding>>([
    { command: "curl https://other.test" }, { root: "/other" }, { cwd: "/project/other" }, { timeoutSec: 61 },
    { declaredWritesWorkspace: true }, { declaredNeedsNetwork: true }, { declaredDestructive: true }, { inferredNetwork: false }, { sessionKey: "session-b" },
    { clientId: "client-b" }, { projectId: "project-b" }, { leaseId: "lease-b" },
  ])("rejects a changed binding: %o", (change) => {
    const store = new ShellApprovalStore(() => 100);
    const pending = store.request(binding).record;
    expect(store.decide(pending.approvalId, pending.approveChallenge, true)).toBe(true);
    expect(store.consumeApproved(pending.approvalId, { ...binding, ...change })).toBe(false);
  });

  it("rejects bad challenge, denial, and expiry without timers", () => {
    let now = 100;
    const store = new ShellApprovalStore(() => now);
    const pending = store.request(binding).record;
    expect(store.decide(pending.approvalId, "wrong", true)).toBe(false);
    expect(store.decide(pending.approvalId, pending.approveChallenge, false)).toBe(false);
    expect(store.decide(pending.approvalId, pending.denyChallenge, false)).toBe(true);
    expect(store.consumeApproved(pending.approvalId, binding)).toBe(false);
    const expiring = store.request(binding).record;
    now += SHELL_APPROVAL_TTL_MS + 1;
    expect(store.decide(expiring.approvalId, expiring.approveChallenge, true)).toBe(false);
  });

  it("keeps an approved record until its exact request consumes it", () => {
    const store = new ShellApprovalStore(() => 100);
    const approved = store.request(binding).record;
    expect(store.decide(approved.approvalId, approved.approveChallenge, true)).toBe(true);
    store.request({ ...binding, command: "curl https://new.test" });
    expect(store.consumeApproved(approved.approvalId, binding)).toBe(true);
  });
});
