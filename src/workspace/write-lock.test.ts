import { describe, expect, it } from "vitest";
import {
  assertWritable,
  canTakeOverWriteLock,
  findVerifyPeers,
  findWriteLockHolder,
} from "./project-select.js";
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

  function session(
    sessionKey: string,
    slot: string,
    l: Lease | null,
    clientId?: string,
  ): SessionSummary {
    return {
      sessionKey,
      slot,
      activeProjectId: l?.projectId ?? null,
      mode: "edit",
      lease: l,
      lastActiveAtMs: now,
      clientId,
    };
  }

  // A conversation that reconnects arrives under a new MCP session id while
  // its previous session may still be attached to a live transport. Refusing
  // it locks the conversation out of the project it just took, by itself,
  // until the lease expires — observed in the field as a 30-minute stall.
  it("lets a connector reclaim a lease its own earlier session still holds", () => {
    const sessions = [session("old-session", "W01", lease("webapp", "full-write"), "client-A")];
    expect(() =>
      assertWritable(sessions, "webapp", "webapp", "new-session", now, "client-A"),
    ).not.toThrow();
  });

  it("still refuses a different connector holding the same project", () => {
    const sessions = [session("other", "W01", lease("webapp", "full-write"), "client-A")];
    expect(() =>
      assertWritable(sessions, "webapp", "webapp", "mine", now, "client-B"),
    ).toThrow(DomainError);
  });

  it("does not grant takeover on absent identity", () => {
    // Stdio callers carry no client id. Treating "unknown equals unknown" as a
    // match would hand every local caller anyone else's write lease.
    expect(canTakeOverWriteLock({ clientId: undefined }, undefined)).toBe(false);
    expect(canTakeOverWriteLock({ clientId: "client-A" }, undefined)).toBe(false);
    expect(canTakeOverWriteLock({ clientId: undefined }, "client-A")).toBe(false);
    expect(canTakeOverWriteLock({ clientId: "client-A" }, "client-A")).toBe(true);
  });

  it("keeps refusing a same-connector holder when the requester is anonymous", () => {
    const sessions = [session("old", "W01", lease("webapp", "full-write"), "client-A")];
    expect(() => assertWritable(sessions, "webapp", "webapp", "mine", now)).toThrow(DomainError);
  });

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

/**
 * REQ-SESS-001. Concurrent work on *different* projects already worked before
 * any of this; these pin it so the takeover and inheritance paths added later
 * cannot quietly widen the lock into something that serialises the whole
 * workspace.
 */
describe("different projects stay independent", () => {
  const now = 2_000_000;

  function lease(projectId: string, preset: Lease["preset"]): Lease {
    return {
      projectId,
      leaseId: `lease_${projectId}`,
      projectRoot: `/w/${projectId}`,
      preset,
      issuedAt: now - 1000,
      expiresAt: now + 600_000,
    };
  }

  function session(key: string, slot: string, l: Lease | null, clientId?: string): SessionSummary {
    return {
      sessionKey: key,
      slot,
      activeProjectId: l?.projectId ?? null,
      mode: "edit",
      lease: l,
      lastActiveAtMs: now,
      clientId,
    };
  }

  // ACCEPT-SESS-001
  it("lets two sessions hold write leases on two different projects", () => {
    const sessions = [session("s1", "W01", lease("webapp", "full-write"), "client-A")];
    expect(() =>
      assertWritable(sessions, "api", "api", "s2", now, "client-B"),
    ).not.toThrow();
    expect(findWriteLockHolder(sessions, "api", "s2", now)).toBeUndefined();
  });

  it("keeps them independent even for one connector working two projects", () => {
    // Same client id must not make an unrelated project look contended.
    const sessions = [session("s1", "W01", lease("webapp", "full-write"), "client-A")];
    expect(() =>
      assertWritable(sessions, "api", "api", "s2", now, "client-A"),
    ).not.toThrow();
  });

  // ACCEPT-SESS-002
  it("still refuses two different connectors on the same project", () => {
    const sessions = [session("s1", "W01", lease("webapp", "full-write"), "client-A")];
    let caught: unknown;
    try {
      assertWritable(sessions, "webapp", "webapp", "s2", now, "client-B");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(DomainError);
    // The holder has to be named, or the owner cannot tell which conversation
    // to close.
    expect((caught as DomainError).details).toMatchObject({ heldBySlot: "W01" });
  });

  it("does not let a read lease on one project block a write on another", () => {
    const sessions = [session("s1", "W01", lease("webapp", "read-only"), "client-A")];
    expect(() => assertWritable(sessions, "api", "api", "s2", now, "client-B")).not.toThrow();
  });
});
