import { mkdir, appendFile, chmod, readFile, writeFile } from "node:fs/promises";
import { open } from "node:fs/promises";
import { join } from "node:path";

/**
 * Finished sessions, kept for a few days so the dashboard can show what was
 * worked on rather than only what is running now.
 *
 * Deliberately not the audit ledger. That file is append-only and never
 * rewritten, which is the right policy for evidence and the wrong one for a
 * display surface that has to forget things on a schedule. It also carries
 * every tool call, so filtering session events out of it on each page load
 * would cost more the longer the server runs. One line per finished session
 * stays small enough to read whole.
 */

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
const HISTORY_FILE = "sessions-history.jsonl";

/** ASSUMED-002: a week is the top of the "a day or a few" the owner asked for. */
export const DEFAULT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/** ASSUMED-003: one line per finished session, so normal use never reaches
 * this. It bounds the pathological case — a client that connects and drops in
 * a loop — rather than the expected one. */
const COMPACT_THRESHOLD_LINES = 5000;

export interface SessionHistoryRecord {
  slot: string;
  projectName: string | null;
  /** Epoch ms, stamped by the server rather than trusted from the caller. */
  endedAt: number;
  lastActiveAtMs: number;
}

export interface SessionHistoryEntry {
  slot: string;
  projectName: string | null;
  lastActiveAtMs: number;
}

export class SessionHistory {
  private readonly stateDir: string;
  private readonly retentionMs: number;

  constructor(stateDir: string, retentionMs: number = DEFAULT_RETENTION_MS) {
    this.stateDir = stateDir;
    this.retentionMs = retentionMs;
  }

  private path(): string {
    return join(this.stateDir, HISTORY_FILE);
  }

  private async ensureReady(): Promise<string> {
    await mkdir(this.stateDir, { recursive: true, mode: DIR_MODE });
    const target = this.path();
    const fh = await open(target, "a", FILE_MODE);
    await fh.close();
    try {
      await chmod(target, FILE_MODE);
    } catch {
      // Non-fatal: the filesystem may not support POSIX permission bits.
    }
    return target;
  }

  /**
   * Append finished sessions.
   *
   * Never throws. A session sweep that fails to write history must still have
   * released its leases — the alternative is a logging fault holding a project
   * hostage, which is worse than losing a line of display data.
   */
  async record(entries: readonly SessionHistoryEntry[], now: number = Date.now()): Promise<void> {
    if (entries.length === 0) return;
    try {
      const target = await this.ensureReady();
      const lines = entries
        .map((e) =>
          JSON.stringify({
            slot: e.slot,
            projectName: e.projectName,
            endedAt: now,
            lastActiveAtMs: e.lastActiveAtMs,
          } satisfies SessionHistoryRecord),
        )
        .join("\n");
      await appendFile(target, lines + "\n", { encoding: "utf8", mode: FILE_MODE });
      await this.compactIfLarge(now);
    } catch {
      // Intentionally swallowed — see the doc comment.
    }
  }

  /** Records inside the retention window, most recent first. */
  async list(now: number = Date.now()): Promise<SessionHistoryRecord[]> {
    let raw: string;
    try {
      raw = await readFile(this.path(), "utf8");
    } catch {
      return [];
    }
    const cutoff = now - this.retentionMs;
    const out: SessionHistoryRecord[] = [];
    for (const line of raw.split("\n")) {
      if (line.trim().length === 0) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        // One torn line — a crash mid-append — must not discard the file.
        continue;
      }
      const rec = parsed as Partial<SessionHistoryRecord>;
      if (typeof rec.endedAt !== "number" || typeof rec.slot !== "string") continue;
      if (rec.endedAt < cutoff) continue;
      out.push({
        slot: rec.slot,
        projectName: typeof rec.projectName === "string" ? rec.projectName : null,
        endedAt: rec.endedAt,
        lastActiveAtMs: typeof rec.lastActiveAtMs === "number" ? rec.lastActiveAtMs : rec.endedAt,
      });
    }
    return out.sort((a, b) => b.endedAt - a.endedAt);
  }

  /**
   * Rewrite the file with only what is still in the window.
   *
   * Sessions finish rarely, so this runs on an already-infrequent path instead
   * of needing a timer of its own. Losing the tail to a crash mid-rewrite costs
   * display data only; the audit ledger keeps the durable record.
   */
  private async compactIfLarge(now: number): Promise<void> {
    let raw: string;
    try {
      raw = await readFile(this.path(), "utf8");
    } catch {
      return;
    }
    const lines = raw.split("\n").filter((l) => l.trim().length > 0);
    if (lines.length <= COMPACT_THRESHOLD_LINES) return;
    const kept = await this.list(now);
    await writeFile(
      this.path(),
      kept
        .slice()
        .reverse()
        .map((r) => JSON.stringify(r))
        .join("\n") + "\n",
      { encoding: "utf8", mode: FILE_MODE },
    );
  }
}
