import { randomUUID } from "node:crypto";
import {
  DomainError,
  ErrorCode,
  type Lease,
  type LeasePreset,
  type ProjectRegistryEntry,
  type SessionSummary,
} from "../types.js";

/** Default lease TTL when no config is threaded in (PRD §7 Project Lease). */
const DEFAULT_LEASE_TTL_MS = 30 * 60 * 1000; // 30 minutes

/**
 * Issue a new active project Lease (PRD §7 Project Lease / §8.2
 * project_select) for the given registry entry and preset.
 */
export function makeLease(entry: ProjectRegistryEntry, preset: LeasePreset): Lease {
  const issuedAt = Date.now();
  return {
    projectId: entry.projectId,
    leaseId: `lease_${randomUUID()}`,
    projectRoot: entry.root,
    preset,
    issuedAt,
    expiresAt: issuedAt + DEFAULT_LEASE_TTL_MS,
  };
}

/**
 * Cross-session lease conflict, as reported to the caller that lost the race.
 * Carries who holds the project and until when so the message can say more
 * than "denied" — otherwise there is no way to tell an occupied project from
 * a preset that is simply too weak.
 */
export interface WriteLockHolder {
  slot: string;
  sessionKey: string;
  /** Absent for stdio holders and for sessions persisted before takeover. */
  clientId?: string;
  /** Name the holding conversation gave itself, when it gave one. */
  workerName?: string;
  heldSince: number;
  expiresAt: number;
}

/** Presets whose capability set includes `write`. Kept in sync with
 * ALLOWED_CAPABILITIES in lease-guard.ts, which is the source of truth. */
const WRITE_PRESETS: ReadonlySet<LeasePreset> = new Set<LeasePreset>(["full-write"]);
/** Presets that can run project commands/tests. */
const VERIFY_PRESETS: ReadonlySet<LeasePreset> = new Set<LeasePreset>([
  "tests-only",
  "full-write",
]);

function isLive(lease: Lease | null, projectId: string, now: number): lease is Lease {
  return lease !== null && lease.projectId === projectId && lease.expiresAt >= now;
}

/**
 * Find a live write lease held on `projectId` by a session other than
 * `selfSessionKey`.
 *
 * Only unexpired leases count. A stale entry left behind by a crashed or
 * disconnected client must never lock the owner out of their own project —
 * expiry is the backstop for the case where `transport.onclose` never fired.
 */
export function findWriteLockHolder(
  sessions: readonly SessionSummary[],
  projectId: string,
  selfSessionKey: string,
  now: number = Date.now(),
): WriteLockHolder | undefined {
  for (const session of sessions) {
    if (session.sessionKey === selfSessionKey) continue;
    const { lease } = session;
    if (!isLive(lease, projectId, now)) continue;
    if (!WRITE_PRESETS.has(lease.preset)) continue;
    return {
      slot: session.slot,
      sessionKey: session.sessionKey,
      clientId: session.clientId,
      workerName: session.workerName,
      heldSince: lease.issuedAt,
      expiresAt: lease.expiresAt,
    };
  }
  return undefined;
}

/**
 * Any live lease a sibling session holds on this project, of any preset.
 *
 * `findWriteLockHolder` only sees full-write/control leases, because only
 * those need cross-connector exclusivity. But `project_select` mints a fresh
 * lease on every call regardless of preset, and only the write-capable branch
 * ever released a prior holder. Selecting tests-only (or read-only, or
 * image-only) skipped that release entirely and minted an independent lease
 * chain that coexisted with an already-held full-write one — the same
 * connector then had two live leases on one project. Every later tool call
 * lands on a fresh per-call session that adopts *a* sibling lease, and with
 * two to choose from it picked whichever happened to come first, alternating
 * between granted and PERMISSION_DENIED call to call.
 *
 * This finds every such sibling, of any preset, so project_select can
 * drain a split chain down to one per connector. `listSessions` is
 * insertion-ordered, so a foreign read/test lease or a differently-named
 * window that connected first is a normal first match — returning only that
 * one and stopping lets this connector's own earlier grant survive the
 * re-select. Whether to actually take each over is still gated by
 * `canTakeOverWriteLock` at the call site — this only locates the candidates.
 */
export function findSiblingLeases(
  sessions: readonly SessionSummary[],
  projectId: string,
  selfSessionKey: string,
  now: number = Date.now(),
): WriteLockHolder[] {
  const found: WriteLockHolder[] = [];
  for (const session of sessions) {
    if (session.sessionKey === selfSessionKey) continue;
    const { lease } = session;
    if (!isLive(lease, projectId, now)) continue;
    found.push({
      slot: session.slot,
      sessionKey: session.sessionKey,
      clientId: session.clientId,
      workerName: session.workerName,
      heldSince: lease.issuedAt,
      expiresAt: lease.expiresAt,
    });
  }
  return found;
}

/**
 * Slots of other live sessions that can also run tests on `projectId`.
 *
 * Concurrent test runs are allowed rather than blocked — tests are re-runnable
 * and blocking a second look at a project is more disruptive than the risk.
 * They are reported so a run that fails on a port clash or a half-written
 * build directory can be explained instead of looking random.
 */
export function findVerifyPeers(
  sessions: readonly SessionSummary[],
  projectId: string,
  selfSessionKey: string,
  now: number = Date.now(),
): string[] {
  const peers: string[] = [];
  for (const session of sessions) {
    if (session.sessionKey === selfSessionKey) continue;
    const { lease } = session;
    if (!isLive(lease, projectId, now)) continue;
    if (VERIFY_PRESETS.has(lease.preset)) peers.push(session.slot);
  }
  return peers;
}

/** Throw PROJECT_LOCKED when another live session already holds the write
 * lease. Called both when a lease is issued (fail fast, before the model
 * plans work it cannot do) and again at write time as a second line. */
/**
 * Whether a held write lock should be handed to the requester instead of
 * refusing them.
 *
 * An MCP session id is not stable for the life of a conversation: a client can
 * reconnect and arrive under a new one while its previous session is still
 * attached to a live transport. The sweep only reclaims leases whose transport
 * is gone, so that stale session keeps the project — and the very conversation
 * that took the lease is locked out of it, by itself, until the lease expires.
 * Observed in the field: a full-write lease granted at 04:11:40, its own next
 * tool call refused at 04:12:05, and re-selecting refused as PROJECT_LOCKED
 * twelve seconds later.
 *
 * One OAuth client id is one connector. When the holder authenticated as the
 * same client the requester did, this is that connector coming back, so the
 * lock moves rather than standing in its own way. Different client ids are
 * genuinely different callers and are still refused.
 *
 * Stdio callers have no client id; absent identity never grants takeover.
 */
export function canTakeOverWriteLock(
  holder: Pick<WriteLockHolder, "clientId" | "workerName">,
  requesterClientId: string | undefined,
  requesterWorkerName?: string,
): boolean {
  if (requesterClientId === undefined || holder.clientId === undefined) return false;
  if (holder.clientId !== requesterClientId) return false;
  // Same connector is necessary but no longer sufficient. Ten ChatGPT windows
  // share one client id, so unnamed they are indistinguishable and each would
  // silently take the project from the last — two conversations editing one
  // repository while both believe they hold it. When both sides named
  // themselves, only a matching name is the same worker returning.
  if (holder.workerName !== undefined && requesterWorkerName !== undefined) {
    return holder.workerName === requesterWorkerName;
  }
  return true;
}

export function assertWritable(
  sessions: readonly SessionSummary[],
  projectId: string,
  projectLabel: string,
  selfSessionKey: string,
  now: number = Date.now(),
  requesterClientId?: string,
  requesterWorkerName?: string,
): void {
  const holder = findWriteLockHolder(sessions, projectId, selfSessionKey, now);
  if (!holder) return;
  if (canTakeOverWriteLock(holder, requesterClientId, requesterWorkerName)) return;
  const until = new Date(holder.expiresAt).toISOString().slice(11, 16);
  throw new DomainError(
    ErrorCode.PROJECT_LOCKED,
    `${projectLabel} is being edited by ${holder.workerName ? `worker "${holder.workerName}"` : "another session"} ` +
      `(slot ${holder.slot}, until ${until} UTC). ` +
      `Close that conversation or wait for its lease to expire, or select this project read-only.`,
    {
      projectId,
      heldBySlot: holder.slot,
      heldByWorker: holder.workerName,
      heldSince: holder.heldSince,
      expiresAt: holder.expiresAt,
      holderPreset: "full-write",
    },
  );
}

/** Shape session state is expected to carry the active lease under (PRD §10 sessions.json). */
interface SessionWithLease {
  lease?: Lease;
  activeLease?: Lease;
}

function isSessionWithLease(session: unknown): session is SessionWithLease {
  return typeof session === "object" && session !== null;
}

/**
 * Look up and validate the active lease for `projectId` from session state.
 *
 * @throws {DomainError} LEASE_REQUIRED if no valid lease exists for the project.
 */
export function requireLease(session: unknown, projectId: string): Lease {
  if (!isSessionWithLease(session)) {
    throw new DomainError(ErrorCode.LEASE_REQUIRED, "No active session/lease", { projectId });
  }

  const lease = session.lease ?? session.activeLease;
  if (!lease) {
    throw new DomainError(ErrorCode.LEASE_REQUIRED, "No active lease for project", { projectId });
  }

  if (lease.projectId !== projectId) {
    throw new DomainError(
      ErrorCode.LEASE_REQUIRED,
      "Active lease is for a different project",
      { projectId, leaseProjectId: lease.projectId },
    );
  }

  if (Date.now() > lease.expiresAt) {
    throw new DomainError(ErrorCode.LEASE_REQUIRED, "Lease expired", {
      projectId,
      expiresAt: lease.expiresAt,
    });
  }

  return lease;
}
