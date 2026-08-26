import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { requireProjectLease, verifyPeerWarnings } from "./lease-guard.js";
import { makeLease } from "./project-select.js";
import type { Lease, SessionSummary, ToolContext } from "../types.js";
import { Store } from "../state/store.js";
import {
  DomainError,
  ErrorCode,
  type ProjectRegistryEntry,
  type ToolContext,
} from "../types.js";

/**
 * End-to-end through the real Store: two contexts differing only by
 * sessionKey must see independent leases, and a write must be refused while
 * another live session holds the project.
 */
describe("requireProjectLease across sessions", () => {
  let dir: string;
  let store: Store;

  const webapp: ProjectRegistryEntry = {
    projectId: "webapp",
    name: "webapp",
    root: "/w/webapp",
    aliases: ["webapp"],
  };
  const api: ProjectRegistryEntry = {
    projectId: "api",
    name: "api",
    root: "/w/api",
    aliases: ["api"],
  };

  function ctxFor(sessionKey: string): ToolContext {
    return {
      workspaceRoot: "/w",
      workspaceRoots: ["/w"],
      stateDir: dir,
      registry: [webapp, api],
      ledger: { append: async () => undefined },
      store: {
        loadProjects: () => store.loadProjects(),
        saveProjects: (p) => store.saveProjects(p),
        getSession: (key) => store.getSession(key),
        setSession: (s, key) => store.setSession(s, key),
        listSessions: () => store.listSessions(),
        getDefaults: () => store.getDefaults(),
        setDefaults: (d) => store.setDefaults(d),
        sweepSessions: (keys) => store.sweepSessions(keys),
      },
      config: {
        workspaceRoot: "/w",
        workspaceRoots: ["/w"],
        stateDir: dir,
      } as ToolContext["config"],
      sessionKey,
    };
  }

  async function select(
    sessionKey: string,
    entry: ProjectRegistryEntry,
    preset: Parameters<typeof makeLease>[1],
  ): Promise<void> {
    await store.setSession(
      { activeProjectId: entry.projectId, mode: "edit", lease: makeLease(entry, preset) },
      sessionKey,
    );
  }

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "chatgpt2codex-guard-"));
    store = new Store(dir);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("lets two sessions write to different projects at the same time", async () => {
    await select("a", webapp, "full-write");
    await select("b", api, "full-write");

    await expect(requireProjectLease(ctxFor("a"), "webapp", "write")).resolves.toBeTruthy();
    await expect(requireProjectLease(ctxFor("b"), "api", "write")).resolves.toBeTruthy();
  });

  it("does not let one session use another session's lease", async () => {
    await select("a", webapp, "full-write");

    // Session b never selected anything; under the old server-wide lease it
    // would have inherited webapp and edited it without the user realising.
    await expect(requireProjectLease(ctxFor("b"), "webapp", "read")).rejects.toMatchObject({
      code: ErrorCode.LEASE_REQUIRED,
    });
  });

  it("refuses a write while another live session holds the project", async () => {
    await select("a", webapp, "full-write");
    await select("b", webapp, "full-write");

    // b's own lease is valid, so this is not a preset problem: the guard has
    // to notice the project is already spoken for.
    try {
      await requireProjectLease(ctxFor("b"), "webapp", "write");
      expect.unreachable("expected PROJECT_LOCKED");
    } catch (err) {
      expect((err as DomainError).code).toBe(ErrorCode.PROJECT_LOCKED);
    }
  });

  it("still allows reads on a project another session is editing", async () => {
    await select("a", webapp, "full-write");
    await select("b", webapp, "read-only");

    await expect(requireProjectLease(ctxFor("b"), "webapp", "read")).resolves.toBeTruthy();
  });

  it("frees the project as soon as the holding session is swept away", async () => {
    await select("a", webapp, "full-write");
    await select("b", webapp, "full-write");
    await expect(requireProjectLease(ctxFor("b"), "webapp", "write")).rejects.toBeInstanceOf(
      DomainError,
    );

    // Closing the other ChatGPT window drops its transport, and the sweep
    // releases the lease it was holding.
    await store.sweepSessions(["b"]);

    await expect(requireProjectLease(ctxFor("b"), "webapp", "write")).resolves.toBeTruthy();
  });

  it("warns, but does not block, when another session can also run tests", async () => {
    await select("a", webapp, "tests-only");
    await select("b", webapp, "tests-only");

    await expect(requireProjectLease(ctxFor("b"), "webapp", "verify")).resolves.toBeTruthy();

    const warnings = await verifyPeerWarnings(ctxFor("b"), "webapp");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("W01");
  });

  it("reports no verify warning when nobody else is on the project", async () => {
    await select("a", webapp, "full-write");
    expect(await verifyPeerWarnings(ctxFor("a"), "webapp")).toEqual([]);
  });

  it("keeps enforcing the preset ceiling for the caller's own lease", async () => {
    await select("a", webapp, "read-only");
    await expect(requireProjectLease(ctxFor("a"), "webapp", "write")).rejects.toMatchObject({
      code: ErrorCode.PERMISSION_DENIED,
    });
  });

  it("falls back to the stdio session when no key is set", async () => {
    await select("stdio", webapp, "full-write");
    const ctx = ctxFor("stdio");
    await expect(requireProjectLease(ctx, "webapp", "write")).resolves.toBeTruthy();
  });
});

describe("lease follows the connector, not the session id", () => {
  // ChatGPT opens a new MCP session per tool call, so a lease bound to the
  // session that took it is lost by the very next call.
  const now = Date.now();

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

  function ctxWith(
    sessions: SessionSummary[],
    sessionKey: string,
    clientId: string | undefined,
    onSet: (s: unknown, key?: string) => void = () => undefined,
    onRelease: (key: string) => void = () => undefined,
  ): ToolContext {
    return {
      workspaceRoot: "/w",
      workspaceRoots: ["/w"],
      stateDir: "/tmp",
      registry: [],
      ledger: { append: async () => undefined },
      clientId,
      sessionKey,
      store: {
        loadProjects: async () => [],
        saveProjects: async () => undefined,
        getSession: async (key?: string) => sessions.find((s) => s.sessionKey === key) ?? null,
        setSession: async (s: unknown, key?: string) => onSet(s, key),
        listSessions: async () => sessions,
        releaseSessionLease: async (key: string) => {
          onRelease(key);
          return true;
        },
      },
      config: {} as ToolContext["config"],
    } as unknown as ToolContext;
  }

  it("adopts a live lease held by another session of the same connector", async () => {
    const sessions: SessionSummary[] = [
      {
        sessionKey: "older",
        slot: "W01",
        activeProjectId: "webapp",
        mode: "edit",
        lease: lease("webapp", "full-write"),
        lastActiveAtMs: now,
        clientId: "client-A",
      },
    ];
    let released: string | undefined;
    const ctx = ctxWith(sessions, "newer", "client-A", () => undefined, (k) => {
      released = k;
    });

    const got = await requireProjectLease(ctx, "webapp", "write");
    expect(got.preset).toBe("full-write");
    // Moved, not copied: two holders would each pass the exclusivity check
    // against the other.
    expect(released).toBe("older");
  });

  it("refuses to adopt when the store cannot release the sibling's copy", async () => {
    // Adoption is a move. The release call was optional and simply absent from
    // the context wiring, so it was skipped in silence and both sessions kept
    // the same lease id — one connector reached thirty-four sessions all
    // holding one project. Refusing is the safe failure.
    const sessions: SessionSummary[] = [
      {
        sessionKey: "older",
        slot: "W01",
        activeProjectId: "webapp",
        mode: "edit",
        lease: lease("webapp", "full-write"),
        lastActiveAtMs: now,
        clientId: "client-A",
      },
    ];
    const ctx = ctxWith(sessions, "newer", "client-A");
    delete (ctx.store as { releaseSessionLease?: unknown }).releaseSessionLease;

    await expect(requireProjectLease(ctx, "webapp", "write")).rejects.toThrow();
  });

  it("leaves exactly one holder after adopting", async () => {
    const sessions: SessionSummary[] = [
      {
        sessionKey: "older",
        slot: "W01",
        activeProjectId: "webapp",
        mode: "edit",
        lease: lease("webapp", "full-write"),
        lastActiveAtMs: now,
        clientId: "client-A",
      },
    ];
    const written: Array<[unknown, string | undefined]> = [];
    const released: string[] = [];
    const ctx = ctxWith(
      sessions,
      "newer",
      "client-A",
      (s, key) => written.push([s, key]),
      (k) => released.push(k),
    );

    await requireProjectLease(ctx, "webapp", "write");

    expect(written.map(([, key]) => key)).toEqual(["newer"]);
    expect(released).toEqual(["older"]);
  });

  it("does not adopt a lease from a different connector", async () => {
    const sessions: SessionSummary[] = [
      {
        sessionKey: "other",
        slot: "W01",
        activeProjectId: "webapp",
        mode: "edit",
        lease: lease("webapp", "full-write"),
        lastActiveAtMs: now,
        clientId: "client-B",
      },
    ];
    const ctx = ctxWith(sessions, "mine", "client-A");
    await expect(requireProjectLease(ctx, "webapp", "write")).rejects.toThrow();
  });

  it("adopts nothing when the caller has no connector identity", async () => {
    const sessions: SessionSummary[] = [
      {
        sessionKey: "other",
        slot: "W01",
        activeProjectId: "webapp",
        mode: "edit",
        lease: lease("webapp", "full-write"),
        lastActiveAtMs: now,
        clientId: "client-A",
      },
    ];
    const ctx = ctxWith(sessions, "stdio", undefined);
    await expect(requireProjectLease(ctx, "webapp", "read")).rejects.toThrow();
  });

  it("does not adopt an expired sibling lease", async () => {
    const sessions: SessionSummary[] = [
      {
        sessionKey: "older",
        slot: "W01",
        activeProjectId: "webapp",
        mode: "edit",
        lease: { ...lease("webapp", "full-write"), expiresAt: now - 1 },
        lastActiveAtMs: now,
        clientId: "client-A",
      },
    ];
    const ctx = ctxWith(sessions, "newer", "client-A");
    await expect(requireProjectLease(ctx, "webapp", "read")).rejects.toThrow();
  });
});
