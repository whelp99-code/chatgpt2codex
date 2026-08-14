import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { requireProjectLease, verifyPeerWarnings } from "./lease-guard.js";
import { makeLease } from "./project-select.js";
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
