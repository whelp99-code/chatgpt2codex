import { describe, expect, it } from "vitest";
import { createServer } from "./mcp-server.js";
import type { Lease, SessionSummary, ToolContext } from "../types.js";

interface RegisteredToolLike {
  handler?: (input: Record<string, unknown>) => Promise<{
    structuredContent?: Record<string, unknown>;
    isError?: boolean;
  }>;
}

function lease(projectId: string): Lease {
  const issuedAt = Date.now();
  return {
    projectId,
    leaseId: `lease_${projectId}`,
    projectRoot: `/w/${projectId}`,
    preset: "full-write",
    issuedAt,
    expiresAt: issuedAt + 30 * 60_000,
  };
}

function session(
  sessionKey: string,
  held: Lease | null,
  clientId: string,
): SessionSummary {
  return {
    sessionKey,
    slot: sessionKey === "older" ? "W01" : "W02",
    activeProjectId: held?.projectId ?? null,
    mode: held ? "edit" : "observe",
    lease: held,
    lastActiveAtMs: Date.now(),
    clientId,
  };
}

async function releaseTool(
  sessions: SessionSummary[],
  opts: {
    sessionKey: string;
    clientId: string;
    release?: (key: string) => Promise<boolean>;
  },
) {
  const released: string[] = [];
  const ctx = {
    workspaceRoot: "/w",
    workspaceRoots: ["/w"],
    stateDir: "/tmp",
    registry: [],
    ledger: { append: async () => undefined },
    clientId: opts.clientId,
    sessionKey: opts.sessionKey,
    store: {
      loadProjects: async () => [],
      saveProjects: async () => undefined,
      getSession: async (key?: string) =>
        sessions.find((s) => s.sessionKey === (key ?? opts.sessionKey)) ?? null,
      setSession: async () => undefined,
      listSessions: async () => sessions,
      ...(opts.release
        ? {
            releaseSessionLease: async (key: string) => {
              released.push(key);
              return opts.release!(key);
            },
          }
        : {}),
    },
    config: {
      workspaceRoot: "/w",
      workspaceRoots: ["/w"],
      stateDir: "/tmp",
      maxReadBytes: 1024,
      maxPatchBytes: 1024,
      defaultCommandTimeoutSec: 30,
      defaultLeaseTtlMs: 30 * 60_000,
    },
  } as ToolContext;
  const server = await createServer(ctx);
  const tools = (server as unknown as { _registeredTools: Record<string, RegisteredToolLike> })
    ._registeredTools;
  const result = await tools.project_release?.handler?.({});
  return { result, released };
}

describe("project_release", () => {
  it("clears a sibling lease when the answering session is fresh", async () => {
    const held = lease("webapp");
    const sessions = [
      session("older", held, "client-A"),
      session("newer", null, "client-A"),
    ];
    const { result, released } = await releaseTool(sessions, {
      sessionKey: "newer",
      clientId: "client-A",
      release: async () => true,
    });

    expect(result?.isError).toBeFalsy();
    expect(result?.structuredContent).toMatchObject({
      released: true,
      projectId: "webapp",
      sessionsCleared: 1,
    });
    expect(released).toEqual(["older"]);
  });

  it("refuses to report a successful clear when the store cannot release", async () => {
    const sessions = [
      session("older", lease("webapp"), "client-A"),
      session("newer", null, "client-A"),
    ];
    const { result, released } = await releaseTool(sessions, {
      sessionKey: "newer",
      clientId: "client-A",
    });

    expect(result?.isError).toBe(true);
    expect(result?.structuredContent?.code).toBe("LEASE_REQUIRED");
    expect(released).toEqual([]);
  });
});
