import { describe, expect, it } from "vitest";
import { createServer } from "./mcp-server.js";
import { ErrorCode, type Lease, type SessionSummary, type ToolContext } from "../types.js";

/**
 * project_select mints a fresh lease every call. These pin the MOVE that
 * consolidates this connector's prior grants: every takeable sibling is
 * released, a missing release capability refuses rather than minting a
 * second chain, and a foreign or differently-named lease listed first does
 * not hide this connector's own grant.
 */

interface RegisteredToolLike {
  handler?: (input: Record<string, unknown>) => Promise<{
    structuredContent?: Record<string, unknown>;
    isError?: boolean;
  }>;
}

const now = Date.now();

function lease(preset: Lease["preset"], projectId = "webapp"): Lease {
  return {
    projectId,
    leaseId: `lease_${preset}_${projectId}`,
    projectRoot: `/w/${projectId}`,
    preset,
    issuedAt: now - 1000,
    expiresAt: now + 600_000,
  };
}

function session(
  sessionKey: string,
  l: Lease | null,
  clientId?: string,
  workerName?: string,
): SessionSummary {
  return {
    sessionKey,
    slot: sessionKey,
    activeProjectId: l?.projectId ?? null,
    mode: "edit",
    lease: l,
    lastActiveAtMs: now,
    clientId,
    workerName,
  };
}

function makeCtx(opts: {
  sessions: SessionSummary[];
  sessionKey: string;
  clientId?: string;
  release?: boolean;
}): {
  ctx: ToolContext;
  released: string[];
  written: Array<{ key: string | undefined; leaseId?: string }>;
} {
  const sessions = opts.sessions.map((s) => ({ ...s, lease: s.lease ? { ...s.lease } : null }));
  const released: string[] = [];
  const written: Array<{ key: string | undefined; leaseId?: string }> = [];
  const store: ToolContext["store"] = {
    loadProjects: async () => [],
    saveProjects: async () => undefined,
    getSession: async (key) => sessions.find((s) => s.sessionKey === (key ?? opts.sessionKey)) ?? null,
    setSession: async (next, key) => {
      written.push({
        key,
        leaseId: (next as { lease?: { leaseId?: string } } | null)?.lease?.leaseId,
      });
    },
    listSessions: async () => sessions,
  };
  if (opts.release !== false) {
    store.releaseSessionLease = async (key) => {
      released.push(key);
      const held = sessions.find((s) => s.sessionKey === key);
      if (held) held.lease = null;
      return true;
    };
  }
  const ctx: ToolContext = {
    workspaceRoot: "/w",
    workspaceRoots: ["/w"],
    stateDir: "/tmp",
    registry: [{ projectId: "webapp", name: "webapp", root: "/w/webapp", aliases: ["webapp"] }],
    ledger: { append: async () => undefined },
    clientId: opts.clientId,
    sessionKey: opts.sessionKey,
    store,
    config: {
      workspaceRoot: "/w",
      workspaceRoots: ["/w"],
      stateDir: "/tmp",
      maxReadBytes: 1024,
      maxPatchBytes: 1024,
      defaultCommandTimeoutSec: 30,
      defaultLeaseTtlMs: 30 * 60 * 1000,
    },
  };
  return { ctx, released, written };
}

async function select(
  ctx: ToolContext,
  input: Record<string, unknown> = { projectId: "webapp", reason: "test", preset: "tests-only" },
) {
  const server = await createServer(ctx);
  const tools = (server as unknown as { _registeredTools: Record<string, RegisteredToolLike> })
    ._registeredTools;
  return tools.project_select?.handler?.(input);
}

describe("project_select consolidates this connector's lease chain", () => {
  it("releases this connector's grant even when a foreign lease is listed first", async () => {
    const { ctx, released, written } = makeCtx({
      sessions: [
        session("foreign", lease("read-only"), "client-B"),
        session("own-old", lease("full-write"), "client-A"),
      ],
      sessionKey: "me",
      clientId: "client-A",
    });

    const result = await select(ctx);
    expect(result?.isError).toBeFalsy();
    expect(released).toEqual(["own-old"]);
    expect(written).toHaveLength(1);
    expect(written[0]?.key).toBe("me");
    expect(written[0]?.leaseId).toBeTruthy();
    expect(written[0]?.leaseId).not.toBe("lease_full-write_webapp");
  });

  it("drains every own chain, not just the first takeable sibling", async () => {
    const { ctx, released, written } = makeCtx({
      sessions: [
        session("own-a", lease("full-write"), "client-A"),
        session("own-b", lease("tests-only"), "client-A"),
      ],
      sessionKey: "me",
      clientId: "client-A",
    });

    const result = await select(ctx);
    expect(result?.isError).toBeFalsy();
    expect(released.sort()).toEqual(["own-a", "own-b"]);
    expect(written).toHaveLength(1);
    expect(written[0]?.key).toBe("me");
  });

  it("leaves a differently-named window of the same connector alone", async () => {
    const { ctx, released } = makeCtx({
      sessions: [
        session("w2", lease("full-write"), "client-A", "w2"),
        session("w1-old", lease("tests-only"), "client-A", "w1"),
      ],
      sessionKey: "me",
      clientId: "client-A",
    });

    const result = await select(ctx, {
      projectId: "webapp",
      reason: "test",
      preset: "tests-only",
      workerName: "w1",
    });
    expect(result?.isError).toBeFalsy();
    expect(released).toEqual(["w1-old"]);
  });

  it("refuses to mint when a takeable sibling exists but the store cannot release", async () => {
    const { ctx, written } = makeCtx({
      sessions: [session("own-old", lease("full-write"), "client-A")],
      sessionKey: "me",
      clientId: "client-A",
      release: false,
    });

    const result = await select(ctx);
    expect(result?.isError).toBe(true);
    expect(result?.structuredContent?.code).toBe(ErrorCode.LEASE_REQUIRED);
    expect(written).toEqual([]);
  });

  it("still mints when there is no takeable sibling, even without release", async () => {
    const { ctx, written } = makeCtx({
      sessions: [session("foreign", lease("read-only"), "client-B")],
      sessionKey: "me",
      clientId: "client-A",
      release: false,
    });

    const result = await select(ctx);
    expect(result?.isError).toBeFalsy();
    expect(written).toHaveLength(1);
    expect(written[0]?.key).toBe("me");
  });
});
