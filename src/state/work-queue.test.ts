import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WorkQueue } from "./work-queue.js";

/**
 * The queue is the only way a manager can reach a worker: MCP answers but
 * never calls, so an instruction has to survive until the worker asks for it.
 * Losing one is silent — nobody is waiting on a response that was never sent.
 */
describe("work queue", () => {
  let dir: string;
  let q: WorkQueue;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "c2c-queue-"));
    q = new WorkQueue(dir);
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("hands work to the project it was queued for and nobody else", async () => {
    await q.enqueue("webapp", "run the tests");
    expect(await q.takeNext("api")).toBeUndefined();
    expect((await q.takeNext("webapp"))?.instruction).toBe("run the tests");
  });

  it("delivers oldest first", async () => {
    await q.enqueue("webapp", "first");
    await q.enqueue("webapp", "second");
    expect((await q.takeNext("webapp"))?.instruction).toBe("first");
    expect((await q.takeNext("webapp"))?.instruction).toBe("second");
  });

  it("hands each item to exactly one worker", async () => {
    await q.enqueue("webapp", "only once");
    const [a, b] = await Promise.all([q.takeNext("webapp"), q.takeNext("webapp")]);
    // Two windows calling goal_loop at the same moment must not both act on it.
    expect([a, b].filter(Boolean)).toHaveLength(1);
  });

  it("keeps delivered work visible instead of dropping it", async () => {
    const item = await q.enqueue("webapp", "in flight");
    await q.takeNext("webapp");
    const open = await q.openItems();
    // Vanishing on handover would look identical to never having been sent.
    expect(open.map((i) => [i.id, i.status])).toEqual([[item.id, "delivered"]]);
  });

  it("records what the worker reported", async () => {
    const item = await q.enqueue("webapp", "do it");
    await q.takeNext("webapp");
    await q.report(item.id, "done", "tests green");

    const all = await q.list();
    expect(all[0]).toMatchObject({ status: "done", result: "tests green" });
    expect(await q.openItems()).toEqual([]);
  });

  it("ignores a report for an unknown item", async () => {
    // A stale report must not fail the goal_loop call that carried it.
    await expect(q.report("no-such-id", "done", "x")).resolves.toBeUndefined();
  });

  it("refuses empty instructions", async () => {
    await expect(q.enqueue("webapp", "   ")).rejects.toThrow();
  });

  it("bounds how much can pile up for one project", async () => {
    for (let i = 0; i < 50; i++) await q.enqueue("webapp", `task ${i}`);
    await expect(q.enqueue("webapp", "one too many")).rejects.toThrow(/full/u);
    // A full queue on one project must not block another.
    await expect(q.enqueue("api", "fine")).resolves.toBeTruthy();
  });

  it("survives a missing or unreadable queue file", async () => {
    expect(await new WorkQueue(join(dir, "nope")).list()).toEqual([]);
  });
});

describe("work that a worker never finished", () => {
  let dir: string;
  let q: WorkQueue;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "c2c-queue-abandon-"));
    q = new WorkQueue(dir);
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("requeues an item whose worker never came back", async () => {
    // A window closed mid-task leaves its item delivered forever, and delivery
    // is one-shot, so no other worker would ever see it again.
    await q.enqueue("webapp", "half-done work");
    const taken = await q.takeNext("webapp");
    expect(taken).toBeTruthy();

    const later = Date.now() + 60 * 60_000;
    const revived = await q.requeueAbandoned(30 * 60_000, later);

    expect(revived).toHaveLength(1);
    expect((await q.takeNext("webapp"))?.instruction).toBe("half-done work");
  });

  it("leaves recently delivered work alone", async () => {
    await q.enqueue("webapp", "still working on it");
    await q.takeNext("webapp");
    // A worker mid-task must not have its assignment pulled out from under it.
    expect(await q.requeueAbandoned(30 * 60_000)).toEqual([]);
  });

  it("does not requeue work that was reported", async () => {
    const item = await q.enqueue("webapp", "finished");
    await q.takeNext("webapp");
    await q.report(item.id, "done", "ok");
    const later = Date.now() + 60 * 60_000;
    expect(await q.requeueAbandoned(30 * 60_000, later)).toEqual([]);
  });

  it("does not requeue work whose project still has a live holder", async () => {
    await q.enqueue("webapp", "still being worked");
    await q.takeNext("webapp");
    const later = Date.now() + 60 * 60_000;
    // Age past the grace is not enough: a worker can keep calling tools long
    // after delivery, and an unrelated window closing must not steal this.
    expect(await q.requeueAbandoned(30 * 60_000, later, new Set(["webapp"]))).toEqual([]);
    expect((await q.openItems())[0]?.status).toBe("delivered");
  });

  it("requeues old work only for projects that no longer have a holder", async () => {
    await q.enqueue("webapp", "window closed");
    await q.takeNext("webapp");
    await q.enqueue("api", "other window still going");
    await q.takeNext("api");
    const later = Date.now() + 60 * 60_000;
    const revived = await q.requeueAbandoned(30 * 60_000, later, new Set(["api"]));
    expect(revived.map((i) => i.projectId)).toEqual(["webapp"]);
    expect((await q.openItems()).find((i) => i.projectId === "api")?.status).toBe("delivered");
  });

  it("keeps a failed report distinct from a successful one", async () => {
    const a = await q.enqueue("webapp", "will fail");
    await q.takeNext("webapp");
    await q.report(a.id, "failed", "could not run the tests");

    const [row] = await q.list();
    expect(row).toMatchObject({ status: "failed", result: "could not run the tests" });
  });

  it("shows finished work on the board, not just what is outstanding", async () => {
    const done = await q.enqueue("webapp", "done one");
    await q.takeNext("webapp");
    await q.report(done.id, "done", "green");
    await q.enqueue("webapp", "still pending");

    const board = await q.boardItems();
    // A manager who sees only open work cannot tell success from failure —
    // the board would empty either way.
    expect(board.map((i) => i.status).sort()).toEqual(["done", "pending"]);
  });

  it("shows whatever finished recently, not whatever was queued recently", async () => {
    const oldest = await q.enqueue("webapp", "queued first, finished last");
    const newer = [];
    for (let i = 0; i < 6; i++) newer.push(await q.enqueue("webapp", `newer ${i}`));

    for (let i = 0; i < 7; i++) await q.takeNext("webapp");
    for (const item of newer) await q.report(item.id, "done", "earlier");
    await q.report(oldest.id, "done", "just now");

    const board = await q.boardItems(6);
    // A glance at recent outcomes must include the item that actually just
    // landed, even if it was queued before the ones that finished earlier.
    expect(board.some((i) => i.id === oldest.id)).toBe(true);
    expect(board.find((i) => i.id === oldest.id)?.result).toBe("just now");
  });
});
