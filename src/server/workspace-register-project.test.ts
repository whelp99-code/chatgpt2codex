import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer } from "./mcp-server.js";
import { Store } from "../state/store.js";
import type { ProjectRegistryEntry, ToolContext } from "../types.js";

const execFileAsync = promisify(execFile);

/**
 * Real incident: workspace root is `.../Playground`; the user's project
 * lives at `Playground/1b/signed_platform`. `1b` is a registered git repo
 * and `signed_platform` (only .md/.txt files, no marker, two levels below
 * the root) can never be indexed by a plain scan — workspace_get_project and
 * project_select both fail on it. workspace_register_project exists to let
 * that folder be registered explicitly, at any depth, without touching its
 * contents, and to have that registration survive a rescan/restart.
 */

interface RegisteredToolLike {
  handler?: (input: Record<string, unknown>) => Promise<{
    structuredContent?: Record<string, unknown>;
    content?: Array<{ type?: string; text?: string }>;
    isError?: boolean;
  }>;
}

async function initGitRepo(dir: string): Promise<void> {
  await execFileAsync("git", ["init", "-q"], { cwd: dir });
  await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
  await execFileAsync("git", ["config", "user.name", "Test"], { cwd: dir });
}

function makeCtx(stateDir: string, workspaceRoot: string): { ctx: ToolContext; store: Store } {
  const store = new Store(stateDir);
  const registry: ProjectRegistryEntry[] = [];
  const ctx: ToolContext = {
    workspaceRoot,
    workspaceRoots: [workspaceRoot],
    stateDir,
    registry,
    ledger: { append: async () => undefined },
    store: {
      loadProjects: () => store.loadProjects(),
      saveProjects: (p) => store.saveProjects(p),
      loadRegisteredProjectPaths: () => store.loadRegisteredProjectPaths(),
      saveRegisteredProjectPaths: (paths) => store.saveRegisteredProjectPaths(paths),
      getSession: (sessionKey) => store.getSession(sessionKey),
      setSession: (s, sessionKey) => store.setSession(s, sessionKey),
    },
    config: {
      workspaceRoot,
      workspaceRoots: [workspaceRoot],
      stateDir,
      maxReadBytes: 1024 * 1024,
      maxPatchBytes: 1024 * 1024,
      defaultCommandTimeoutSec: 30,
      defaultLeaseTtlMs: 30 * 60 * 1000,
    },
    sessionKey: "stdio",
  };
  return { ctx, store };
}

async function registeredTools(ctx: ToolContext): Promise<Record<string, RegisteredToolLike>> {
  const server = await createServer(ctx);
  return (server as unknown as { _registeredTools: Record<string, RegisteredToolLike> })
    ._registeredTools;
}

describe("workspace_register_project", () => {
  let stateDir: string;
  let workspaceRoot: string;
  let outerProject: string;
  let nested: string;

  beforeEach(async () => {
    stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "c2c-register-state-"));
    workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "c2c-register-ws-"));
    // Mirrors Playground/1b (registered git project) / signed_platform (nested, no marker).
    outerProject = path.join(workspaceRoot, "1b");
    await fs.mkdir(outerProject, { recursive: true });
    await initGitRepo(outerProject);
    nested = path.join(outerProject, "signed_platform");
    await fs.mkdir(nested, { recursive: true });
    await fs.writeFile(path.join(nested, "notes.md"), "keep me", "utf8");
  });

  afterEach(async () => {
    await fs.rm(stateDir, { recursive: true, force: true });
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  });

  it("registers a nested unmarked folder so project_select can find it", async () => {
    const { ctx } = makeCtx(stateDir, workspaceRoot);
    const tools = await registeredTools(ctx);

    const result = await tools.workspace_register_project?.handler?.({ path: nested });

    expect(result?.isError).toBeFalsy();
    const project = result?.structuredContent?.project as { projectId?: string; root?: string } | undefined;
    expect(project?.projectId).toBe("signed-platform");
    expect(project?.root).toBe(await fs.realpath(nested));

    const selectable = tools.project_select?.handler
      ? await tools.project_select.handler({ projectId: "signed-platform", preset: "read-only" })
      : undefined;
    expect(selectable?.isError).toBeFalsy();

    // Contents untouched.
    expect(await fs.readFile(path.join(nested, "notes.md"), "utf8")).toBe("keep me");
  });

  it("persists the registration so it survives a subsequent workspace_refresh_index", async () => {
    const { ctx } = makeCtx(stateDir, workspaceRoot);
    const tools = await registeredTools(ctx);

    await tools.workspace_register_project?.handler?.({ path: nested });
    const refreshed = await tools.workspace_refresh_index?.handler?.({});

    expect(refreshed?.isError).toBeFalsy();
    const got = await tools.workspace_get_project?.handler?.({ path: nested });
    expect(got?.isError).toBeFalsy();
    expect((got?.structuredContent?.project as { projectId?: string } | undefined)?.projectId).toBe(
      "signed-platform",
    );
  });

  it("survives a fresh ToolContext (simulated restart) reading the same state dir", async () => {
    const first = makeCtx(stateDir, workspaceRoot);
    const firstTools = await registeredTools(first.ctx);
    await firstTools.workspace_register_project?.handler?.({ path: nested });

    // A brand-new context/registry, as a server restart would build, but
    // backed by the same persisted state dir.
    const second = makeCtx(stateDir, workspaceRoot);
    const extraRoots = await second.store.loadRegisteredProjectPaths();
    expect(extraRoots).toContain(await fs.realpath(nested));

    const secondTools = await registeredTools(second.ctx);
    const refreshed = await secondTools.workspace_refresh_index?.handler?.({});
    expect(refreshed?.isError).toBeFalsy();
    const got = await secondTools.workspace_get_project?.handler?.({ path: nested });
    expect(got?.isError).toBeFalsy();
  });

  it("is idempotent: registering the same folder twice returns the same project without duplicating it", async () => {
    const { ctx, store } = makeCtx(stateDir, workspaceRoot);
    const tools = await registeredTools(ctx);

    const first = await tools.workspace_register_project?.handler?.({ path: nested });
    const second = await tools.workspace_register_project?.handler?.({ path: nested });

    expect(first?.isError).toBeFalsy();
    expect(second?.isError).toBeFalsy();
    expect(
      (second?.structuredContent?.project as { projectId?: string } | undefined)?.projectId,
    ).toBe("signed-platform");

    const extraRoots = await store.loadRegisteredProjectPaths();
    const realNested = await fs.realpath(nested);
    expect(extraRoots.filter((p) => p === realNested)).toHaveLength(1);
    expect(new Set(extraRoots).size).toBe(extraRoots.length);
  });

  it("rejects a path outside every workspace root", async () => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "c2c-register-outside-"));
    try {
      const { ctx } = makeCtx(stateDir, workspaceRoot);
      const tools = await registeredTools(ctx);

      const result = await tools.workspace_register_project?.handler?.({ path: outside });
      expect(result?.isError).toBe(true);
      expect(result?.structuredContent?.code).toBe("PATH_OUTSIDE_WORKSPACE");
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });

  it("rejects the workspace root itself", async () => {
    const { ctx } = makeCtx(stateDir, workspaceRoot);
    const tools = await registeredTools(ctx);

    const result = await tools.workspace_register_project?.handler?.({ path: workspaceRoot });
    expect(result?.isError).toBe(true);
    expect(result?.structuredContent?.code).toBe("PATH_OUTSIDE_WORKSPACE");
  });

  it("rejects a path with a hidden ('.'-prefixed) segment", async () => {
    const hidden = path.join(outerProject, ".hidden-dir");
    await fs.mkdir(hidden, { recursive: true });
    const { ctx } = makeCtx(stateDir, workspaceRoot);
    const tools = await registeredTools(ctx);

    const result = await tools.workspace_register_project?.handler?.({ path: hidden });
    expect(result?.isError).toBe(true);
    expect(result?.structuredContent?.code).toBe("INVALID_PROJECT_NAME");
  });

  it("rejects a non-existent path", async () => {
    const { ctx } = makeCtx(stateDir, workspaceRoot);
    const tools = await registeredTools(ctx);

    const result = await tools.workspace_register_project?.handler?.({
      path: path.join(outerProject, "does-not-exist"),
    });
    expect(result?.isError).toBe(true);
    expect(result?.structuredContent?.code).toBe("PATH_OUTSIDE_WORKSPACE");
  });

  it("workspace_get_project on the nested unregistered path names the enclosing project", async () => {
    const { ctx } = makeCtx(stateDir, workspaceRoot);
    const tools = await registeredTools(ctx);
    // Index 1b (and the root) first, without registering the nested folder.
    await tools.workspace_refresh_index?.handler?.({});

    const result = await tools.workspace_get_project?.handler?.({ path: nested });

    expect(result?.isError).toBe(true);
    expect(result?.structuredContent?.code).toBe("PROJECT_NOT_FOUND");
    const details = result?.structuredContent?.details as { enclosingProjectId?: string } | undefined;
    expect(details?.enclosingProjectId).toBe("1b");
    const text = result?.content?.[0]?.text ?? "";
    expect(text).toContain("1b");
    expect(text).toContain("workspace_register_project");
  });

  it("workspace_refresh_index still accepts the old {depth, includeHidden} shape", async () => {
    const { ctx } = makeCtx(stateDir, workspaceRoot);
    const tools = await registeredTools(ctx);

    const result = await tools.workspace_refresh_index?.handler?.({ depth: 5, includeHidden: true });

    expect(result?.isError).toBeFalsy();
  });
});
