import { DomainError, ErrorCode, type Lease, type LeasePreset, type ToolContext } from "../types.js";
import { assertWritable, findVerifyPeers, requireLease } from "./project-select.js";

/**
 * Capability ceiling checked against the active project lease's preset.
 * Shared by src/server/tools.ts (file/command/git tools) and
 * src/control/tools.ts (desktop-control tools) so both enforce the same
 * preset -> capability table from a single source of truth.
 */
export type LeaseCapability = "read" | "verify" | "write" | "image" | "remote" | "control";

const ALLOWED_CAPABILITIES: Record<LeasePreset, ReadonlySet<LeaseCapability>> = {
  "read-only": new Set(["read"]),
  "tests-only": new Set(["read", "verify"]),
  "full-write": new Set(["read", "verify", "write", "image", "remote"]),
  "image-only": new Set(["read", "image"]),
  control: new Set(["read", "control"]),
};

/**
 * Require an unexpired lease for `projectId` that permits `capability`.
 * Throws LEASE_REQUIRED (no/expired/mismatched lease) or PERMISSION_DENIED
 * (lease exists but its preset does not grant the requested capability).
 */
/**
 * Find a live lease on `projectId` held by another session of the same
 * connector, and adopt it into this session.
 *
 * ChatGPT opens a fresh MCP session per tool call. Observed in the audit log:
 * `project_select` took a full-write lease under session e265ddff at 05:18:01,
 * and the next twelve tool calls each arrived under a session id of their own.
 * Binding a lease to a session id assumes the id outlives the call that
 * created it, and against a stateless client it does not — the conversation
 * loses the lease it just took, one call later.
 *
 * The connector is the durable identity, so a lease follows it. Same client
 * id, same project, still unexpired: adopt and continue. Absent identity
 * adopts nothing, and a lease belonging to another connector is never touched.
 */
async function adoptSiblingLease(ctx: ToolContext, projectId: string): Promise<Lease | undefined> {
  if (!ctx.clientId || !ctx.store.listSessions) return undefined;
  const sessions = await ctx.store.listSessions();
  const now = Date.now();
  const sibling = sessions.find(
    (s) =>
      s.sessionKey !== ctx.sessionKey &&
      s.clientId !== undefined &&
      s.clientId === ctx.clientId &&
      s.lease !== null &&
      s.lease.projectId === projectId &&
      s.lease.expiresAt > now,
  );
  if (!sibling?.lease) return undefined;

  // Move it rather than copy it: two sessions holding the same write lease
  // would each pass assertWritable against the other and defeat exclusivity.
  await ctx.store.setSession(
    {
      activeProjectId: projectId,
      mode: sibling.mode,
      lease: sibling.lease,
      clientId: ctx.clientId,
    },
    ctx.sessionKey,
  );
  await ctx.store.releaseSessionLease?.(sibling.sessionKey);
  await ctx.ledger
    .append({
      type: "lease.inherited",
      projectId,
      fromSlot: sibling.slot,
      preset: sibling.lease.preset,
    })
    .catch(() => undefined);
  return sibling.lease;
}

export async function requireProjectLease(
  ctx: ToolContext,
  projectId: string,
  capability: LeaseCapability = "read",
): Promise<Lease> {
  const session = await ctx.store.getSession(ctx.sessionKey);
  let lease: Lease;
  try {
    lease = requireLease(session, projectId);
  } catch (err) {
    const adopted = await adoptSiblingLease(ctx, projectId);
    if (!adopted) throw err;
    lease = adopted;
  }
  if (!ALLOWED_CAPABILITIES[lease.preset].has(capability)) {
    throw new DomainError(ErrorCode.PERMISSION_DENIED, `Lease preset ${lease.preset} does not allow ${capability}`, {
      projectId,
      preset: lease.preset,
      capability,
    });
  }

  // Second line of defence. project_select already refuses to hand out a
  // conflicting write lease, so reaching here means state drifted — a lease
  // issued before another session's, a hand-edited sessions.json, or a race
  // between two selects. Cheap enough to always re-check.
  if (capability === "write" && ctx.store.listSessions) {
    const sessions = await ctx.store.listSessions();
    assertWritable(sessions, projectId, projectId, ctx.sessionKey, Date.now(), ctx.clientId);
  }

  return lease;
}

/**
 * Slots of other live sessions also able to run tests on this project.
 * Surfaced as a warning on verify-capable tool results rather than blocking:
 * two concurrent test runs in one checkout can collide over ports and build
 * output, and saying so turns a mystifying failure into an explicable one.
 */
export async function verifyPeerWarnings(
  ctx: ToolContext,
  projectId: string,
): Promise<string[]> {
  if (!ctx.store.listSessions) return [];
  const peers = findVerifyPeers(await ctx.store.listSessions(), projectId, ctx.sessionKey);
  if (peers.length === 0) return [];
  return [
    `Slot${peers.length > 1 ? "s" : ""} ${peers.join(", ")} can also run commands on this project; ` +
      `concurrent runs may collide over ports or build output.`,
  ];
}
