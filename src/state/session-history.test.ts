import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SessionHistory } from "./session-history.js";

/**
 * Finished sessions have to survive long enough to be read and then stop
 * existing on schedule — and none of that may ever cost a lease. A history
 * write that throws would leave the sweep half-done, holding projects that
 * nobody is using.
 */
describe("session history", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "c2c-hist-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  // ACCEPT-HIST-001
  it("records a finished session with the server's own timestamp", async () => {
    const h = new SessionHistory(dir);
    await h.record([{ slot: "W01", projectName: "webapp", lastActiveAtMs: 1_000 }], 5_000);

    const rows = await h.list(5_000);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ slot: "W01", projectName: "webapp", endedAt: 5_000 });
  });

  it("writes the file 0600 — it names projects on a tunnelled host", async () => {
    const h = new SessionHistory(dir);
    await h.record([{ slot: "W01", projectName: "webapp", lastActiveAtMs: 1 }]);
    const { mode } = await import("node:fs").then((fs) =>
      fs.promises.stat(join(dir, "sessions-history.jsonl")),
    );
    expect(mode & 0o777).toBe(0o600);
  });

  // ACCEPT-HIST-002: the sweep must finish even when history cannot be written.
  it("never throws when the file cannot be written", async () => {
    const h = new SessionHistory(dir);
    await chmod(dir, 0o500);
    await expect(
      h.record([{ slot: "W01", projectName: "webapp", lastActiveAtMs: 1 }]),
    ).resolves.toBeUndefined();
    await chmod(dir, 0o700);
  });

  // ACCEPT-HIST-003
  it("drops records past the retention window", async () => {
    const h = new SessionHistory(dir, 7 * 24 * 60 * 60 * 1000);
    const now = Date.now();
    await h.record([{ slot: "W01", projectName: "old", lastActiveAtMs: 0 }], now - 30 * 24 * 3600 * 1000);
    await h.record([{ slot: "W02", projectName: "recent", lastActiveAtMs: 0 }], now - 2 * 3600 * 1000);

    const rows = await h.list(now);
    expect(rows.map((r) => r.projectName)).toEqual(["recent"]);
  });

  it("returns most recent first", async () => {
    const h = new SessionHistory(dir);
    const now = Date.now();
    await h.record([{ slot: "W01", projectName: "first", lastActiveAtMs: 0 }], now - 3000);
    await h.record([{ slot: "W02", projectName: "second", lastActiveAtMs: 0 }], now - 1000);
    expect((await h.list(now)).map((r) => r.projectName)).toEqual(["second", "first"]);
  });

  // ACCEPT-HIST-004: a torn line from a crash mid-append must not discard the file.
  it("skips an unparsable line and keeps the rest", async () => {
    const h = new SessionHistory(dir);
    const now = Date.now();
    await h.record([{ slot: "W01", projectName: "good", lastActiveAtMs: 0 }], now - 1000);
    await writeFile(join(dir, "sessions-history.jsonl"),
      (await readFile(join(dir, "sessions-history.jsonl"), "utf8")) + "{ this is not json\n",
      "utf8");

    const rows = await h.list(now);
    expect(rows.map((r) => r.projectName)).toEqual(["good"]);
  });

  it("treats a missing file as no history rather than an error", async () => {
    expect(await new SessionHistory(dir).list()).toEqual([]);
  });

  it("records a session that never selected a project", async () => {
    const h = new SessionHistory(dir);
    await h.record([{ slot: "W03", projectName: null, lastActiveAtMs: 0 }], 1_000);
    expect((await h.list(1_000))[0]?.projectName).toBeNull();
  });
});
