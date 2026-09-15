import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer } from "./mcp-server.js";
import type { ProjectRegistryEntry, ToolContext } from "../types.js";

/**
 * A folder created by hand under a workspace root stays invisible to
 * project_select until something gives it a marker: the scanner only descends
 * one level and skips dotted names. That gap reads as "the project does not
 * exist", so project_create has to finish the whole job — folder, marker, and
 * index — and refuse names that could never be indexed.
 */

interface RegisteredToolLike {
  handler?: (input: Record<string, unknown>) => Promise<{
    structuredContent?: Record<string, unknown>;
    content?: Array<{ type?: string; text?: string }>;
    isError?: boolean;
  }>;
}

function makeCtx(stateDir: string, workspaceRoot: string, extraRoots: string[] = []): ToolContext {
  const registry: ProjectRegistryEntry[] = [];
  const roots = [workspaceRoot, ...extraRoots];
  return {
    workspaceRoot,
    workspaceRoots: roots,
    stateDir,
    registry,
    ledger: { append: async () => undefined },
    store: {
      loadProjects: async () => registry,
      saveProjects: async () => undefined,
      getSession: async () => ({ activeProjectId: null, mode: "read", lease: null }),
      setSession: async () => undefined,
    },
    config: {
      workspaceRoot,
      stateDir,
      maxReadBytes: 1024 * 1024,
      maxPatchBytes: 1024 * 1024,
      defaultCommandTimeoutSec: 30,
      defaultLeaseTtlMs: 30 * 60 * 1000,
    },
  };
}

async function registeredTools(ctx: ToolContext): Promise<Record<string, RegisteredToolLike>> {
  const server = await createServer(ctx);
  return (server as unknown as { _registeredTools: Record<string, RegisteredToolLike> })
    ._registeredTools;
}

describe("project_create", () => {
  let stateDir: string;
  let workspaceRoot: string;

  beforeEach(async () => {
    stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "c2c-project-create-state-"));
    workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "c2c-project-create-ws-"));
  });

  afterEach(async () => {
    await fs.rm(stateDir, { recursive: true, force: true });
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  });

  it("creates the folder, marks it, and indexes it so project_select can find it", async () => {
    const ctx = makeCtx(stateDir, workspaceRoot);
    const tools = await registeredTools(ctx);

    const result = await tools.project_create?.handler?.({ name: "1a" });

    expect(result?.isError).toBeFalsy();
    expect(result?.structuredContent?.projectId).toBe("1a");
    expect(result?.structuredContent?.createdFolder).toBe(true);
    const stat = await fs.stat(path.join(workspaceRoot, "1a"));
    expect(stat.isDirectory()).toBe(true);
    // Indexed in the live registry, not just on disk.
    expect(ctx.registry.some((e) => e.projectId === "1a")).toBe(true);
  });

  it("adopts an existing unmarked folder without touching its contents", async () => {
    const existing = path.join(workspaceRoot, "already-here");
    await fs.mkdir(existing, { recursive: true });
    await fs.writeFile(path.join(existing, "notes.md"), "keep me", "utf8");
    const ctx = makeCtx(stateDir, workspaceRoot);
    const tools = await registeredTools(ctx);

    const result = await tools.project_create?.handler?.({ name: "already-here" });

    expect(result?.isError).toBeFalsy();
    expect(result?.structuredContent?.createdFolder).toBe(false);
    expect(await fs.readFile(path.join(existing, "notes.md"), "utf8")).toBe("keep me");
    expect(ctx.registry.some((e) => e.projectId === "already-here")).toBe(true);
  });

  it("leaves an already-marked project's marker alone", async () => {
    const existing = path.join(workspaceRoot, "marked");
    await fs.mkdir(existing, { recursive: true });
    await fs.writeFile(path.join(existing, "package.json"), "{}", "utf8");
    const ctx = makeCtx(stateDir, workspaceRoot);
    const tools = await registeredTools(ctx);

    const result = await tools.project_create?.handler?.({ name: "marked" });

    expect(result?.structuredContent?.marker).toBe("existing");
    // No repository was forced onto a folder that already qualified.
    await expect(fs.stat(path.join(existing, ".git"))).rejects.toThrow();
  });

  it("refuses a name with a path separator instead of creating a nested folder", async () => {
    const ctx = makeCtx(stateDir, workspaceRoot);
    const tools = await registeredTools(ctx);

    const result = await tools.project_create?.handler?.({ name: "a/b" });

    expect(result?.isError).toBe(true);
    await expect(fs.stat(path.join(workspaceRoot, "a"))).rejects.toThrow();
  });

  it("refuses to escape the workspace root with ..", async () => {
    const ctx = makeCtx(stateDir, workspaceRoot);
    const tools = await registeredTools(ctx);

    const result = await tools.project_create?.handler?.({ name: ".." });

    expect(result?.isError).toBe(true);
    const escaped = path.join(path.dirname(workspaceRoot), ".git");
    await expect(fs.stat(escaped)).rejects.toThrow();
  });

  it("refuses a dotted name the scanner would skip", async () => {
    const ctx = makeCtx(stateDir, workspaceRoot);
    const tools = await registeredTools(ctx);

    const result = await tools.project_create?.handler?.({ name: ".hidden" });

    expect(result?.isError).toBe(true);
    await expect(fs.stat(path.join(workspaceRoot, ".hidden"))).rejects.toThrow();
  });

  it("refuses an empty name", async () => {
    const ctx = makeCtx(stateDir, workspaceRoot);
    const tools = await registeredTools(ctx);

    expect((await tools.project_create?.handler?.({ name: "   " }))?.isError).toBe(true);
  });

  it("fails instead of overwriting when a file already occupies the name", async () => {
    await fs.writeFile(path.join(workspaceRoot, "taken"), "a file", "utf8");
    const ctx = makeCtx(stateDir, workspaceRoot);
    const tools = await registeredTools(ctx);

    const result = await tools.project_create?.handler?.({ name: "taken" });

    expect(result?.isError).toBe(true);
    expect(await fs.readFile(path.join(workspaceRoot, "taken"), "utf8")).toBe("a file");
  });

  it("creates under a requested root and refuses one that is not configured", async () => {
    const second = await fs.mkdtemp(path.join(os.tmpdir(), "c2c-project-create-ws2-"));
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "c2c-project-create-outside-"));
    try {
      const ctx = makeCtx(stateDir, workspaceRoot, [second]);
      const tools = await registeredTools(ctx);

      const ok = await tools.project_create?.handler?.({ name: "in-second", workspaceRoot: second });
      expect(ok?.isError).toBeFalsy();
      expect((await fs.stat(path.join(second, "in-second"))).isDirectory()).toBe(true);

      const denied = await tools.project_create?.handler?.({ name: "nope", workspaceRoot: outside });
      expect(denied?.isError).toBe(true);
      await expect(fs.stat(path.join(outside, "nope"))).rejects.toThrow();
    } finally {
      await fs.rm(second, { recursive: true, force: true });
      await fs.rm(outside, { recursive: true, force: true });
    }
  });

  it("does not follow a symlink out of the workspace root", async () => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "c2c-project-create-symlink-"));
    try {
      await fs.symlink(outside, path.join(workspaceRoot, "escape"), "dir");
      const ctx = makeCtx(stateDir, workspaceRoot);
      const tools = await registeredTools(ctx);

      const result = await tools.project_create?.handler?.({ name: "escape" });

      // Either refused outright, or resolved to a path still inside the root —
      // never a folder materialised in the symlink target.
      if (result?.isError !== true) {
        const root = String(result?.structuredContent?.root ?? "");
        expect(root.startsWith(await fs.realpath(workspaceRoot))).toBe(true);
      }
      expect(await fs.readdir(outside)).toEqual([]);
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });
});
