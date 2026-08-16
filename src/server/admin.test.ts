import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  fetchPeerStatus,
  loadPeers,
  localStatus,
  parsePeers,
  renderDashboard,
  type InstanceStatus,
} from "./admin.js";
import { Store } from "../state/store.js";
import type { Lease, ProjectRegistryEntry, ToolContext } from "../types.js";

describe("admin peers.txt", () => {
  it("parses name/url/token triples and ignores comments and blanks", () => {
    const peers = parsePeers(
      ["# peers", "", "mac  https://mcp.example.com  ~/.c2c/mac.token", "   ", "box https://b.example.com /t"].join(
        "\n",
      ),
    );
    expect(peers).toEqual([
      { name: "mac", url: "https://mcp.example.com", tokenPath: "~/.c2c/mac.token" },
      { name: "box", url: "https://b.example.com", tokenPath: "/t" },
    ]);
  });

  it("strips trailing slashes so the status path is not doubled", () => {
    expect(parsePeers("mac https://x.example.com/// /t")[0]?.url).toBe("https://x.example.com");
  });

  it("skips incomplete lines rather than half-configuring a peer", () => {
    expect(parsePeers("mac https://x.example.com")).toEqual([]);
  });

  it("treats a missing peers.txt as no peers", async () => {
    const dir = await mkdtemp(join(tmpdir(), "c2c-peers-"));
    expect(await loadPeers(dir)).toEqual([]);
    await rm(dir, { recursive: true, force: true });
  });
});

describe("admin peer failure isolation", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "c2c-peer-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("reports an unreadable token file instead of throwing", async () => {
    const result = await fetchPeerStatus({
      name: "mac",
      url: "http://127.0.0.1:9",
      tokenPath: join(dir, "nope.token"),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("token file unreadable");
  });

  it("reports an empty token file", async () => {
    const tokenPath = join(dir, "empty.token");
    await writeFile(tokenPath, "   \n", "utf8");
    const result = await fetchPeerStatus({ name: "mac", url: "http://127.0.0.1:9", tokenPath });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("token file is empty");
  });

  it("reports an unreachable peer in plain terms", async () => {
    const tokenPath = join(dir, "t.token");
    await writeFile(tokenPath, "token-value", "utf8");
    // Port 9 (discard) refuses connections, standing in for a machine that is
    // simply off. One dead peer must not take the dashboard down.
    const result = await fetchPeerStatus({ name: "mac", url: "http://127.0.0.1:9", tokenPath });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).not.toContain("fetch failed");
  });
});

describe("localStatus", () => {
  let dir: string;
  let store: Store;

  const projects: ProjectRegistryEntry[] = [
    { projectId: "webapp", name: "webapp", root: "/w/webapp", aliases: [], workspaceRoot: "/w" },
    { projectId: "api", name: "api", root: "/w/api", aliases: [], workspaceRoot: "/w" },
    { projectId: "legacy", name: "legacy", root: "/d/legacy", aliases: [], workspaceRoot: "/d" },
  ];

  function ctx(): ToolContext {
    return {
      workspaceRoot: "/w",
      workspaceRoots: ["/w", "/d"],
      stateDir: dir,
      registry: projects,
      ledger: { append: async () => undefined },
      store: {
        loadProjects: () => store.loadProjects(),
        saveProjects: (p) => store.saveProjects(p),
        getSession: (k) => store.getSession(k),
        setSession: (s, k) => store.setSession(s, k),
        listSessions: () => store.listSessions(),
        getDefaults: () => store.getDefaults(),
        setDefaults: (d) => store.setDefaults(d),
        sweepSessions: (k) => store.sweepSessions(k),
      },
      config: {} as ToolContext["config"],
      sessionKey: "stdio",
    };
  }

  function lease(projectId: string, preset: Lease["preset"], ttlMs = 60_000): Lease {
    return {
      projectId,
      leaseId: `l_${projectId}`,
      projectRoot: `/w/${projectId}`,
      preset,
      issuedAt: Date.now(),
      expiresAt: Date.now() + ttlMs,
    };
  }

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "c2c-status-"));
    store = new Store(dir);
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("counts projects per workspace root", async () => {
    const status = await localStatus(ctx(), 16);
    expect(status.workspaceRoots).toEqual([
      { root: "/w", projectCount: 2 },
      { root: "/d", projectCount: 1 },
    ]);
    expect(status.maxSlots).toBe(16);
  });

  // ACCEPT-STAT-003: a session that called a tool moments ago is working; one
  // that has been quiet past the window is not.
  it("separates working sessions from quiet ones using the injected activity map", async () => {
    await store.setSession(
      { activeProjectId: "webapp", mode: "edit", lease: lease("webapp", "full-write") },
      "s1",
    );
    await store.setSession(
      { activeProjectId: "api", mode: "read", lease: lease("api", "read-only") },
      "s2",
    );

    const now = 1_800_000_000_000;
    const status = await localStatus(ctx(), 16, {
      now: () => now,
      activeWindowMs: 90_000,
      activity: () =>
        new Map([
          ["s1", now - 5_000],
          ["s2", now - 600_000],
        ]),
    });

    expect(status.slots.map((s) => [s.slot, s.status])).toEqual([
      ["W01", "active"],
      ["W02", "idle"],
    ]);

    const html = renderDashboard([status]);
    expect(html).toContain("진행중");
    expect(html).toContain("대기");
  });

  // ACCEPT-STAT-004: the stored timestamp is the fallback, and it has to be a
  // fallback rather than a crash — stdio sessions never appear in the map, and
  // after a restart no session does.
  it("falls back to the stored timestamp when the activity map lacks the session", async () => {
    await store.setSession(
      { activeProjectId: "webapp", mode: "edit", lease: lease("webapp", "full-write") },
      "s1",
    );

    const stored = (await store.listSessions())[0]?.lastActiveAtMs ?? 0;
    const status = await localStatus(ctx(), 16, {
      now: () => stored + 10 * 60_000,
      activeWindowMs: 90_000,
      activity: () => new Map(),
    });

    expect(status.slots[0]?.status).toBe("idle");
  });

  it("keeps serving status when the activity provider throws", async () => {
    await store.setSession(
      { activeProjectId: "webapp", mode: "edit", lease: lease("webapp", "full-write") },
      "s1",
    );

    const stored = (await store.listSessions())[0]?.lastActiveAtMs ?? 0;
    const status = await localStatus(ctx(), 16, {
      now: () => stored + 10 * 60_000,
      activeWindowMs: 90_000,
      activity: () => {
        throw new Error("transport gone");
      },
    });

    // Still answers, and answers from the stored timestamp — the throw is
    // swallowed rather than propagated to the route handler.
    expect(status.slots).toHaveLength(1);
    expect(status.slots[0]?.status).toBe("idle");
  });

  it("lists occupied slots with their project and preset", async () => {
    await store.setSession(
      { activeProjectId: "webapp", mode: "edit", lease: lease("webapp", "full-write") },
      "s1",
    );
    await store.setSession(
      { activeProjectId: "api", mode: "verify", lease: lease("api", "tests-only") },
      "s2",
    );

    const status = await localStatus(ctx(), 16);
    expect(status.slots.map((s) => [s.slot, s.projectName, s.preset])).toEqual([
      ["W01", "webapp", "full-write"],
      ["W02", "api", "tests-only"],
    ]);
  });

  it("shows an expired lease as an unleased slot rather than an active one", async () => {
    await store.setSession(
      { activeProjectId: "webapp", mode: "edit", lease: lease("webapp", "full-write", -1) },
      "s1",
    );
    const status = await localStatus(ctx(), 16);
    // Counting it as active would overstate occupancy and imply the project
    // is locked when it is not.
    expect(status.slots[0]?.preset).toBeNull();
  });
});

describe("renderDashboard", () => {
  function status(overrides: Partial<InstanceStatus> = {}): InstanceStatus {
    return {
      instance: "ubuntu-server",
      ok: true,
      platform: "linux",
      workspaceRoots: [{ root: "/w", projectCount: 2 }],
      projects: [{ projectId: "webapp", name: "webapp", root: "/w/webapp" }],
      slots: [],
      maxSlots: 16,
      generatedAt: Date.now(),
      ...overrides,
    };
  }

  it("renders one card per instance", () => {
    const html = renderDashboard([
      status(),
      status({ instance: "mac-studio", platform: "darwin" }),
    ]);
    expect(html).toContain("ubuntu-server");
    expect(html).toContain("mac-studio");
  });

  it("shows a failed peer as a card with its reason, keeping healthy ones", () => {
    const html = renderDashboard([
      status(),
      { instance: "offline-box", ok: false, url: "http://x", reason: "timed out" },
    ]);
    expect(html).toContain("ubuntu-server");
    expect(html).toContain("offline-box");
    expect(html).toContain("timed out");
  });

  it("counts only leased slots as active", () => {
    const html = renderDashboard([
      status({
        maxSlots: 16,
        slots: [
          {
            slot: "W01",
            projectId: "webapp",
            projectName: "webapp",
            preset: "full-write",
            mode: "edit",
            expiresAt: Date.now() + 1000,
            lastActiveAtMs: Date.now(),
          },
          {
            slot: "W02",
            projectId: null,
            projectName: null,
            preset: null,
            mode: "observe",
            expiresAt: null,
            lastActiveAtMs: Date.now(),
          },
        ],
      }),
    ]);
    expect(html).toContain("1/16");
  });

  it("escapes project names so a repository cannot inject markup", () => {
    const html = renderDashboard([
      status({
        slots: [
          {
            slot: "W01",
            projectId: "x",
            projectName: "<img src=x onerror=alert(1)>",
            preset: "read-only",
            mode: "read",
            expiresAt: null,
            lastActiveAtMs: Date.now(),
          },
        ],
      }),
    ]);
    // Project names come from directory names on disk, which the owner does
    // not necessarily control for a cloned repository.
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img");
  });
});
