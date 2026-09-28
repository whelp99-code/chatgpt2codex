import { mkdtemp, rm, stat, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Store } from "./store.js";
import type { ProjectRegistryEntry } from "../types.js";

describe("Store", () => {
  let dir: string;
  let store: Store;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "chatgpt2codex-store-"));
    store = new Store(dir);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("returns an empty project list before anything is saved", async () => {
    const projects = await store.loadProjects();
    expect(projects).toEqual([]);
  });

  it("round-trips projects through save/load", async () => {
    const projects: ProjectRegistryEntry[] = [
      {
        projectId: "alpha-app",
        name: "alpha-app",
        root: "/workspace/alpha-app",
        aliases: ["alpha-app", "alpha"],
        branch: "develop",
        dirty: true,
        hasAgentsMd: true,
        hasCodeBrain: true,
        packageHints: ["flutter", "node"],
        lastSeenAt: "2026-07-03T00:00:00+09:00",
      },
      {
        projectId: "beta-app",
        name: "beta-app",
        root: "/workspace/beta-app",
        aliases: ["beta-app"],
      },
    ];

    await store.saveProjects(projects);
    const loaded = await store.loadProjects();
    expect(loaded).toEqual(projects);
  });

  it("overwrites the previous snapshot on subsequent saves", async () => {
    await store.saveProjects([
      { projectId: "a", name: "a", root: "/a", aliases: ["a"] },
    ]);
    await store.saveProjects([
      { projectId: "b", name: "b", root: "/b", aliases: ["b"] },
    ]);
    const loaded = await store.loadProjects();
    expect(loaded).toHaveLength(1);
    expect(loaded[0]?.projectId).toBe("b");
  });

  it("creates the state directory with 0700 permissions", async () => {
    if (process.platform === "win32") return;
    await store.saveProjects([]);
    const dirStat = await stat(dir);
    expect(dirStat.mode & 0o777).toBe(0o700);
  });

  it("writes projects.json with 0600 permissions", async () => {
    if (process.platform === "win32") return;
    await store.saveProjects([]);
    const fileStat = await stat(join(dir, "projects.json"));
    expect(fileStat.mode & 0o777).toBe(0o600);
  });

  it("leaves no leftover temp files after a save", async () => {
    await store.saveProjects([{ projectId: "x", name: "x", root: "/x", aliases: [] }]);
    const { readdir } = await import("node:fs/promises");
    const files = await readdir(dir);
    expect(files.every((f) => !f.endsWith(".tmp"))).toBe(true);
  });

  it("rejects a corrupt projects.json instead of silently coercing it", async () => {
    const { writeFile, mkdir } = await import("node:fs/promises");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "projects.json"), JSON.stringify({ not: "valid" }), "utf8");
    await expect(store.loadProjects()).rejects.toThrow();
  });

  it("defaults session to observe mode with no active project", async () => {
    const session = await store.getSession();
    expect(session.mode).toBe("observe");
    expect(session.activeProjectId).toBeNull();
    expect(session.lease).toBeNull();
  });

  it("round-trips a session with an active lease", async () => {
    await store.setSession({
      activeProjectId: "alpha-app",
      mode: "edit",
      lease: {
        projectId: "alpha-app",
        leaseId: "lease-1",
        projectRoot: "/workspace/alpha-app",
        preset: "full-write",
        issuedAt: 1000,
        expiresAt: 2000,
      },
    });
    const session = await store.getSession();
    expect(session.activeProjectId).toBe("alpha-app");
    expect(session.mode).toBe("edit");
    expect(session.lease?.leaseId).toBe("lease-1");
  });

  it("stamps setSession's updatedAt with an integer epoch-ms value, ignoring caller input", async () => {
    await store.setSession({ updatedAt: 1 });
    const raw = JSON.parse(await readFile(join(dir, "sessions.json"), "utf8"));
    expect(Number.isInteger(raw.updatedAt)).toBe(true);
    expect(raw.updatedAt).toBeGreaterThan(1000);
  });

  it("returns an empty registered-project path list before anything is saved", async () => {
    const paths = await store.loadRegisteredProjectPaths();
    expect(paths).toEqual([]);
  });

  it("round-trips registered project paths through save/load", async () => {
    await store.saveRegisteredProjectPaths(["/workspace/1b/signed_platform", "/workspace/other/nested"]);
    const loaded = await store.loadRegisteredProjectPaths();
    expect(loaded).toEqual(["/workspace/1b/signed_platform", "/workspace/other/nested"]);
  });

  it("overwrites the previous registered-project snapshot on subsequent saves", async () => {
    await store.saveRegisteredProjectPaths(["/a/b"]);
    await store.saveRegisteredProjectPaths(["/c/d"]);
    const loaded = await store.loadRegisteredProjectPaths();
    expect(loaded).toEqual(["/c/d"]);
  });

  it("writes registered-projects.json with 0600 permissions", async () => {
    if (process.platform === "win32") return;
    await store.saveRegisteredProjectPaths(["/a/b"]);
    const fileStat = await stat(join(dir, "registered-projects.json"));
    expect(fileStat.mode & 0o777).toBe(0o600);
  });

  it("rejects a corrupt registered-projects.json instead of silently coercing it", async () => {
    const { writeFile, mkdir } = await import("node:fs/promises");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "registered-projects.json"), JSON.stringify({ not: "valid" }), "utf8");
    await expect(store.loadRegisteredProjectPaths()).rejects.toThrow();
  });
});
