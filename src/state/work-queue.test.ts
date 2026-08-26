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

  it("serialises takes across WorkQueue instances on the same file", async () => {
    await q.enqueue("webapp", "only once");
    const other = new WorkQueue(dir);
    const [a, b] = await Promise.all([q.takeNext("webapp"), other.takeNext("webapp")]);
    expect([a, b].filter(Boolean)).toHaveLength(1);
  });

  it("does not drop an enqueue that races another instance", async () => {
    const other = new WorkQueue(dir);
    await Promise.all([q.enqueue("webapp", "from a"), other.enqueue("webapp", "from b")]);
    const open = await q.openItems();
    expect(open).toHaveLength(2);
    expect(open.map((i) => i.instruction).sort()).toEqual(["from a", "from b"]);
  });

  it("does not deliver a second item while one is in flight", async () => {
    await q.enqueue("webapp", "first");
    await q.enqueue("webapp", "second");
    const first = await q.currentWork("webapp");
    const again = await q.currentWork("webapp");
    expect(first?.instruction).toBe("first");
    expect(again?.id).toBe(first?.id);
    expect((await q.openItems()).filter((i) => i.status === "delivered")).toHaveLength(1);
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
