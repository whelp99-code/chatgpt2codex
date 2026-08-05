import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { scanWorkspaces } from "./registry.js";

/**
 * Several workspace roots are registered independently, so merging them has
 * to survive the three ways real folders overlap: the same project reachable
 * from two roots, two different projects that slugify to the same id, and a
 * root that no longer exists.
 */
describe("scanWorkspaces — merging several roots", () => {
  let base: string;

  async function makeProject(relative: string, marker = "package.json"): Promise<string> {
    const dir = path.join(base, relative);
    await fs.mkdir(dir, { recursive: true });
    if (marker === ".git") await fs.mkdir(path.join(dir, ".git"), { recursive: true });
    else await fs.writeFile(path.join(dir, marker), "{}", "utf8");
    return dir;
  }

  beforeEach(async () => {
    base = await fs.mkdtemp(path.join(os.tmpdir(), "chatgpt2codex-multiroot-"));
  });

  afterEach(async () => {
    await fs.rm(base, { recursive: true, force: true });
  });

  it("indexes projects from every root", async () => {
    await makeProject("rootA/api");
    await makeProject("rootA/web", ".git");
    await makeProject("rootB/tools", "go.mod");

    const { entries, failedRoots } = await scanWorkspaces([path.join(base, "rootA"), path.join(base, "rootB")]);

    expect(failedRoots).toEqual([]);
    expect(entries.map((e) => e.projectId).sort()).toEqual(["api", "tools", "web"]);
  });

  it("disambiguates projects from different roots that share a name", async () => {
    await makeProject("rootA/api");
    await makeProject("rootB/api");

    const { entries } = await scanWorkspaces([path.join(base, "rootA"), path.join(base, "rootB")]);

    const ids = entries.map((e) => e.projectId);
    // Ids must stay unique, or project_select silently resolves to the wrong
    // project — the failure this guards against.
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain("api");
    expect(ids).toContain("rootb-api");

    const shadowed = entries.find((e) => e.projectId === "rootb-api");
    expect(shadowed?.root).toBe(path.join(base, "rootB", "api"));
    // The original id stays reachable as an alias.
    expect(shadowed?.aliases).toContain("api");
  });

  it("records which root each project came from", async () => {
    await makeProject("rootA/api");
    await makeProject("rootB/tools", "go.mod");

    const { entries } = await scanWorkspaces([path.join(base, "rootA"), path.join(base, "rootB")]);

    expect(entries.find((e) => e.projectId === "api")?.workspaceRoot).toBe(path.join(base, "rootA"));
    expect(entries.find((e) => e.projectId === "tools")?.workspaceRoot).toBe(path.join(base, "rootB"));
  });

  it("lists a project once when two roots overlap", async () => {
    await makeProject("outer/inner/api");

    // `outer` finds inner/api's parent chain and `outer/inner` finds api
    // directly — the same directory reached from two registered roots.
    const { entries } = await scanWorkspaces([path.join(base, "outer", "inner"), path.join(base, "outer")]);

    const apiEntries = entries.filter((e) => path.basename(e.root) === "api");
    expect(apiEntries).toHaveLength(1);
  });

  it("ignores a repeated root instead of double-counting it", async () => {
    await makeProject("rootA/api");
    const root = path.join(base, "rootA");

    const { entries } = await scanWorkspaces([root, root]);

    expect(entries.filter((e) => e.projectId === "api")).toHaveLength(1);
  });

  it("skips an unreadable root and still indexes the others", async () => {
    await makeProject("rootA/api");
    const missing = path.join(base, "gone");

    const { entries, failedRoots } = await scanWorkspaces([missing, path.join(base, "rootA")]);

    // One deleted or unmounted folder must not take the whole workspace down.
    expect(entries.map((e) => e.projectId)).toContain("api");
    expect(failedRoots).toHaveLength(1);
    expect(failedRoots[0]?.root).toBe(missing);
    expect(failedRoots[0]?.reason).toMatch(/Cannot read workspace root/);
  });

  it("returns nothing rather than throwing when every root is missing", async () => {
    const { entries, failedRoots } = await scanWorkspaces([path.join(base, "nope-a"), path.join(base, "nope-b")]);

    expect(entries).toEqual([]);
    expect(failedRoots).toHaveLength(2);
  });
});
