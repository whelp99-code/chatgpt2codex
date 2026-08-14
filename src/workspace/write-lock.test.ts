import { describe, expect, it } from "vitest";
import { assertWritable, findVerifyPeers, findWriteLockHolder } from "./project-select.js";
import { DomainError, ErrorCode, type Lease, type SessionSummary } from "../types.js";

/**
 * Concurrency policy for two sessions on one project:
 *   read    shared
 *   verify  shared, warned
 *   write   exclusive, refused with the holder named
 *
 * Only live, unexpired leases lock. A stale entry must never leave the owner
 * unable to edit their own project.
 */
describe("cross-session write lock", () => {
  const now = 1_000_000;

  function lease(
    projectId: string,
    preset: Lease["preset"],
    { expiresAt = now + 60_000, issuedAt = now - 60_000 } = {},
  ): Lease {
    return {
      projectId,
      leaseId: `lease_${projectId}_${preset}`,
      projectRoot: `/w/${projectId}`,
      preset,
      issuedAt,
      expiresAt,
    };
  }

  function session(sessionKey: string, slot: string, l: Lease | null): SessionSummary {
    return {
      sessionKey,
      slot,
      activeProjectId: l?.projectId ?? null,
      mode: "edit",
      lease: l,
      lastActiveAtMs: now,
    };
  }

  it("reports the holder when another session has a write lease", () => {
    const sessions = [session("other", "W02", lease("webapp", "full-write"))];
    const holder = findWriteLockHolder(sessions, "webapp", "me", now);
    expect(holder?.slot).toBe("W02");
    expect(holder?.sessionKey).toBe("other");
  });

  it("does not treat the caller's own write lease as a conflict", () => {
    const sessions = [session("me", "W01", lease("webapp", "full-write"))];
    expect(findWriteLockHolder(sessions, "webapp", "me", now)).toBeUndefined();
  });

  it("lets several sessions hold read leases on one project", () => {
    const sessions = [
      session("a", "W01", lease("webapp", "read-only")),
      session("b", "W02", lease("webapp", "read-only")),
    ];
    expect(findWriteLockHolder(sessions, "webapp", "me", now)).toBeUndefined();
  });

  it("ignores a write lease held on a different project", () => {
    const sessions = [session("other", "W02", lease("api", "full-write"))];
    expect(findWriteLockHolder(sessions, "webapp", "me", now)).toBeUndefined();
  });

  it("ignores an expired write lease so a dead session cannot lock a project", () => {
    const sessions = [
      session("ghost", "W02", lease("webapp", "full-write", { expiresAt: now - 1 })),
    ];
    expect(findWriteLockHolder(sessions, "webapp", "me", now)).toBeUndefined();
  });

  it("treats tests-only as non-exclusive, since it cannot write", () => {
    const sessions = [session("other", "W02", lease("webapp", "tests-only"))];
    expect(findWriteLockHolder(sessions, "webapp", "me", now)).toBeUndefined();
  });

  describe("assertWritable", () => {
    it("passes when nobody else holds the project", () => {
      expect(() => assertWritable([], "webapp", "webapp", "me", now)).not.toThrow();
    });

    it("throws PROJECT_LOCKED naming the slot and expiry", () => {
      const sessions = [session("other", "W02", lease("webapp", "full-write"))];
      try {
        assertWritable(sessions, "webapp", "webapp", "me", now);
        expect.unreachable("expected PROJECT_LOCKED");
      } catch (err) {
        const domain = err as DomainError;
        // PERMISSION_DENIED would blur "your preset is too weak" together with
        // "someone else has it", which need different fixes from the user.
        expect(domain.code).toBe(ErrorCode.PROJECT_LOCKED);
        expect(domain.message).toContain("W02");
        expect(domain.details?.heldBySlot).toBe("W02");
        expect(domain.details?.expiresAt).toBe(now + 60_000);
      }
    });

    it("suggests the read-only path in the refusal", () => {
      const sessions = [session("other", "W02", lease("webapp", "full-write"))];
      expect(() => assertWritable(sessions, "webapp", "webapp", "me", now)).toThrow(/read-only/);
    });
  });

  describe("verify peers", () => {
    it("lists other sessions that can run commands on the project", () => {
      const sessions = [
        session("a", "W02", lease("webapp", "tests-only")),
        session("b", "W03", lease("webapp", "full-write")),
      ];
      expect(findVerifyPeers(sessions, "webapp", "me", now).sort()).toEqual(["W02", "W03"]);
    });

    it("excludes read-only sessions, which cannot run anything", () => {
      const sessions = [session("a", "W02", lease("webapp", "read-only"))];
      expect(findVerifyPeers(sessions, "webapp", "me", now)).toEqual([]);
    });

    it("excludes the caller and expired leases", () => {
      const sessions = [
        session("me", "W01", lease("webapp", "full-write")),
        session("gone", "W02", lease("webapp", "full-write", { expiresAt: now - 1 })),
      ];
      expect(findVerifyPeers(sessions, "webapp", "me", now)).toEqual([]);
    });
  });
});
