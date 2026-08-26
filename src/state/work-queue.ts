import { mkdir, chmod, readFile, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

/**
 * Work handed to a project's worker by whoever is managing them.
 *
 * The manager cannot call a ChatGPT conversation. MCP is a pull protocol: the
 * server only ever answers, so a queue is the only way an instruction can wait
 * for a worker instead of chasing it. Workers already ask for their next step
 * through `goal_loop`, so that is where queued work is handed over — no new
 * polling loop, and no change to how a conversation is driven.
 *
 * Scoped per project because a project is the only stable identity a worker
 * has: MCP sessions are recreated per tool call and every ChatGPT window
 * authenticates as the same OAuth client, so "the worker on project X" is the
 * finest distinction the server can actually make.
 */

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
const QUEUE_FILE = "work-queue.json";

/** Long enough to describe a task, short enough that the file stays readable. */
const MAX_INSTRUCTION_CHARS = 4000;
const MAX_PENDING_PER_PROJECT = 50;

export type WorkItemStatus = "pending" | "delivered" | "done" | "failed";

export interface WorkItem {
  id: string;
  projectId: string;
  instruction: string;
  status: WorkItemStatus;
  createdAt: number;
  /** When a worker picked it up through goal_loop. */
  deliveredAt?: number;
  /** When the worker reported back, and what it said. */
  completedAt?: number;
  result?: string;
}

interface QueueFile {
  version: 1;
  updatedAt: number;
  items: WorkItem[];
}

function emptyFile(): QueueFile {
  return { version: 1, updatedAt: Date.now(), items: [] };
}

export class WorkQueue {
  private readonly stateDir: string;
  private writing: Promise<unknown> = Promise.resolve();

  constructor(stateDir: string) {
    this.stateDir = stateDir;
  }

  private path(): string {
    return join(this.stateDir, QUEUE_FILE);
  }

  private async load(): Promise<QueueFile> {
    try {
      const parsed = JSON.parse(await readFile(this.path(), "utf8")) as Partial<QueueFile>;
      if (!Array.isArray(parsed.items)) return emptyFile();
      return { version: 1, updatedAt: parsed.updatedAt ?? Date.now(), items: parsed.items as WorkItem[] };
    } catch {
      return emptyFile();
    }
  }

  private async persist(file: QueueFile): Promise<void> {
    await mkdir(this.stateDir, { recursive: true, mode: DIR_MODE });
    file.updatedAt = Date.now();
    await writeFile(this.path(), JSON.stringify(file, null, 2), { encoding: "utf8", mode: FILE_MODE });
    try {
      await chmod(this.path(), FILE_MODE);
    } catch {
      // Non-fatal: the filesystem may not support POSIX permission bits.
    }
  }

  /** Serialise writes: a manager adding work and a worker taking it are
   * concurrent, and a lost update here silently drops an instruction. */
  private locked<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.writing.then(fn, fn);
    this.writing = next.catch(() => undefined);
    return next;
  }

  async enqueue(projectId: string, instruction: string): Promise<WorkItem> {
    const trimmed = instruction.trim();
    if (trimmed.length === 0) throw new Error("instruction is empty");
    return this.locked(async () => {
      const file = await this.load();
      const pending = file.items.filter((i) => i.projectId === projectId && i.status === "pending");
      if (pending.length >= MAX_PENDING_PER_PROJECT) {
        throw new Error(`queue for ${projectId} is full (${MAX_PENDING_PER_PROJECT} pending)`);
      }
      const item: WorkItem = {
        id: randomUUID(),
        projectId,
        instruction: trimmed.slice(0, MAX_INSTRUCTION_CHARS),
        status: "pending",
        createdAt: Date.now(),
      };
      file.items.push(item);
      await this.persist(file);
      return item;
    });
  }

  /**
   * Hand the oldest pending item to a worker, marking it delivered.
   *
   * Delivery is recorded rather than the item removed, so the manager can see
   * that work was picked up and is now in flight — an instruction that vanished
   * on handover would be indistinguishable from one never sent.
   */
  async takeNext(projectId: string): Promise<WorkItem | undefined> {
    return this.locked(async () => {
      const file = await this.load();
      const item = file.items
        .filter((i) => i.projectId === projectId && i.status === "pending")
        .sort((a, b) => a.createdAt - b.createdAt)[0];
      if (!item) return undefined;
      item.status = "delivered";
      item.deliveredAt = Date.now();
      await this.persist(file);
      return item;
    });
  }

  /** Record what the worker reported. Unknown ids are ignored rather than
   * throwing: a stale report must not fail the call that carried it. */
  async report(id: string, status: "done" | "failed", result?: string): Promise<WorkItem | undefined> {
    return this.locked(async () => {
      const file = await this.load();
      const item = file.items.find((i) => i.id === id);
      if (!item) return undefined;
      item.status = status;
      item.completedAt = Date.now();
      if (result) item.result = result.slice(0, MAX_INSTRUCTION_CHARS);
      await this.persist(file);
      return item;
    });
  }

  async list(): Promise<WorkItem[]> {
    const file = await this.load();
    return file.items.slice().sort((a, b) => b.createdAt - a.createdAt);
  }

  /** In-flight work, which is what a manager watching the board cares about. */
  async openItems(): Promise<WorkItem[]> {
    return (await this.list()).filter((i) => i.status === "pending" || i.status === "delivered");
  }
}
