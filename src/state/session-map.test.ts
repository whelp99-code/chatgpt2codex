import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Store } from "./store.js";
import type { Lease } from "../types.js";

/**
 * sessions.json v2: one lease per MCP session instead of one per server.
 *
 * v1 kept a single `lease`, so a second ChatGPT conversation calling
 * project_select overwrote the first one's selection and the first window
 * started failing with "Active lease is for a different project" without
 * having done anything.
 */
describe("Store session map (v2)", () => {
  let dir: string;
  let store: Store;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "chatgpt2codex-sessions-"));
    store = new Store(dir);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function lease(projectId: string, preset: Lease["preset"] = "full-write", ttlMs = 60_000): Lease {
    const issuedAt = Date.now();
    return {
      projectId,
      leaseId: `lease_${projectId}`,
      projectRoot: `/w/${projectId}`,
      preset,
      issuedAt,
      expiresAt: issuedAt + ttlMs,
    };
  }

  it("keeps two sessions' leases independent instead of overwriting", async () => {
    await store.setSession(
      { activeProjectId: "webapp", mode: "edit", lease: lease("webapp") },
      "session-a",
    );
    await store.setSession(
      { activeProjectId: "api", mode: "edit", lease: lease("api") },
      "session-b",
    );

    const a = await store.getSession("session-a");
    const b = await store.getSession("session-b");

    expect(a.activeProjectId).toBe("webapp");
    expect(b.activeProjectId).toBe("api");
    expect(a.lease?.projectId).toBe("webapp");
    expect(b.lease?.projectId).toBe("api");
  });

  it("returns an empty session for a key that never selected a project", async () => {
    await store.setSession(
      { activeProjectId: "webapp", mode: "edit", lease: lease("webapp") },
      "session-a",
    );

    // The bug this guards: a fresh conversation must not silently inherit
    // whatever another window last selected and then act on it.
    const fresh = await store.getSession("session-new");
    expect(fresh.activeProjectId).toBeNull();
    expect(fresh.lease).toBeNull();
  });

  it("assigns each session a distinct short slot label and reuses it on update", async () => {
    await store.setSession({ activeProjectId: "a", mode: "read", lease: null }, "s1");
    await store.setSession({ activeProjectId: "b", mode: "read", lease: null }, "s2");

    const first = await store.listSessions();
    const slot1 = first.find((s) => s.sessionKey === "s1")?.slot;
    const slot2 = first.find((s) => s.sessionKey === "s2")?.slot;
    expect(slot1).toBe("W01");
    expect(slot2).toBe("W02");

    await store.setSession({ activeProjectId: "a2", mode: "edit", lease: null }, "s1");
    const after = await store.listSessions();
    expect(after.find((s) => s.sessionKey === "s1")?.slot).toBe("W01");
  });

  it("reuses a slot freed by a swept session", async () => {
    await store.setSession({ activeProjectId: "a", mode: "read", lease: null }, "s1");
    await store.setSession({ activeProjectId: "b", mode: "read", lease: null }, "s2");
    await store.sweepSessions(["s2"]);

    await store.setSession({ activeProjectId: "c", mode: "read", lease: null }, "s3");
    const sessions = await store.listSessions();
    expect(sessions.find((s) => s.sessionKey === "s3")?.slot).toBe("W01");
  });

  it("sweepSessions drops sessions whose transport is gone and reports them", async () => {
    await store.setSession({ activeProjectId: "a", mode: "edit", lease: lease("a") }, "live");
    await store.setSession({ activeProjectId: "b", mode: "edit", lease: lease("b") }, "dead");

    const removed = await store.sweepSessions(["live"]);

    expect(removed).toEqual(["dead"]);
    expect((await store.listSessions()).map((s) => s.sessionKey)).toEqual(["live"]);
  });

  it("sweepSessions(null) clears everything, as a fresh server start requires", async () => {
    await store.setSession({ activeProjectId: "a", mode: "edit", lease: lease("a") }, "s1");
    await store.setSession({ activeProjectId: "b", mode: "edit", lease: lease("b") }, "s2");

    // No transport from a previous process survives a restart, so a lease left
    // on disk would lock the owner out of their own project for its full TTL.
    await store.sweepSessions(null);

    expect(await store.listSessions()).toEqual([]);
  });

  it("migrates a v1 document to defaults without resurrecting its lease", async () => {
    const issuedAt = Date.now();
    await writeFile(
      join(dir, "sessions.json"),
      JSON.stringify({
        version: 1,
        updatedAt: issuedAt,
        activeProjectId: "legacy-app",
        mode: "edit",
        lease: {
          projectId: "legacy-app",
          leaseId: "lease_legacy",
          projectRoot: "/w/legacy-app",
          preset: "full-write",
          issuedAt,
          expiresAt: issuedAt + 60_000,
        },
      }),
      "utf8",
    );

    const defaults = await store.getDefaults();
    expect(defaults).toEqual({ activeProjectId: "legacy-app", preset: "full-write" });

    // The v1 lease belonged to no live session, so it must not appear as one
    // and must not lock the project against the next conversation.
    expect(await store.listSessions()).toEqual([]);
  });

  it("persists a control lease, which the v1 schema rejected", async () => {
    // LeasePreset carried "control" but the persisted enum did not, so saving
    // a control lease threw on validation.
    await store.setSession(
      { activeProjectId: "webapp", mode: "read", lease: lease("webapp", "control") },
      "ctl",
    );
    const session = await store.getSession("ctl");
    expect(session.lease?.preset).toBe("control");
  });

  it("round-trips defaults and clears them on null", async () => {
    await store.setDefaults({ activeProjectId: "webapp", preset: "full-write" });
    expect(await store.getDefaults()).toEqual({ activeProjectId: "webapp", preset: "full-write" });

    await store.setDefaults(null);
    expect(await store.getDefaults()).toBeNull();
  });

  it("writes sessions.json at version 2 with a session map", async () => {
    await store.setSession({ activeProjectId: "a", mode: "read", lease: null }, "s1");
    const raw = JSON.parse(await readFile(join(dir, "sessions.json"), "utf8"));
    expect(raw.version).toBe(2);
    expect(Object.keys(raw.sessions)).toEqual(["s1"]);
  });

  it("adoptConnectorLease moves a sibling lease in one write", async () => {
    await store.setSession(
      { activeProjectId: "webapp", mode: "edit", lease: lease("webapp"), clientId: "client-A" },
      "older",
    );

    const moved = await store.adoptConnectorLease("newer", "client-A", "webapp");
    expect(moved?.lease.projectId).toBe("webapp");
    expect(moved?.fromSlot).toBe("W01");
    expect(moved?.mode).toBe("edit");

    const sessions = await store.listSessions();
    expect(sessions.find((s) => s.sessionKey === "older")?.lease).toBeNull();
    expect(sessions.find((s) => s.sessionKey === "newer")?.lease?.projectId).toBe("webapp");
    expect(sessions.find((s) => s.sessionKey === "newer")?.clientId).toBe("client-A");
  });

  it("adoptConnectorLease leaves one holder when two adopters race", async () => {
    await store.setSession(
      { activeProjectId: "webapp", mode: "edit", lease: lease("webapp"), clientId: "client-A" },
      "older",
    );

    await Promise.all([
      store.adoptConnectorLease("a", "client-A", "webapp"),
      store.adoptConnectorLease("b", "client-A", "webapp"),
    ]);

    const holders = (await store.listSessions()).filter((s) => s.lease?.projectId === "webapp");
    expect(holders).toHaveLength(1);
    expect(["a", "b"]).toContain(holders[0]?.sessionKey);
    expect((await store.listSessions()).find((s) => s.sessionKey === "older")?.lease).toBeNull();
  });
});
