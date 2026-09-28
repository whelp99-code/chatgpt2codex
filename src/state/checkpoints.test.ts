import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getWorkingDiff } from "./checkpoints.js";

describe("getWorkingDiff — non-git project under a localized git", () => {
  let dir: string;
  const savedLang = process.env.LANG;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "chatgpt2codex-checkpoint-nongit-"));
    await writeFile(join(dir, "notes.txt"), "plain folder\n");
    process.env.LANG = "ko_KR.UTF-8";
  });

  afterEach(async () => {
    if (savedLang === undefined) delete process.env.LANG;
    else process.env.LANG = savedLang;
    await rm(dir, { recursive: true, force: true });
  });

  it("returns an empty diff instead of failing on a translated 'not a git repository'", async () => {
    await expect(getWorkingDiff(dir)).resolves.toBe("");
  });
});
