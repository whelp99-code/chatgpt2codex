import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import {
  DomainError,
  ErrorCode,
  STDIO_SESSION_KEY,
  type ExecutionMode,
  type Lease,
  type ProjectRegistryEntry,
  type SessionDefaults,
  type SessionSummary,
} from "../types.js";

/**
 * Central state store under `~/.local/share/chatgpt2codex/` (PRD §10):
 * projects.json (registry) and sessions.json (active project/mode/lease).
 *
 * Persistence rules (PRD §10, §11 SR-04/SR-08 adjacent hardening):
 *  - Directory created with mode 0700, files written with mode 0600.
 *  - Every write is atomic: write to a temp file in the same directory, then
 *    `rename()` over the target (rename is atomic on the same filesystem).
 *  - Every on-disk document is validated with zod before being handed back to
 *    callers; corrupt/foreign JSON never silently propagates.
 *  - Timestamps are integer epoch-ms.
 */

const ProjectRegistryEntrySchema = z.object({
  projectId: z.string(),
  name: z.string(),
  root: z.string(),
  aliases: z.array(z.string()),
  branch: z.string().optional(),
  dirty: z.boolean().optional(),
  hasAgentsMd: z.boolean().optional(),
  hasCodeBrain: z.boolean().optional(),
  packageHints: z.array(z.string()).optional(),
  lastSeenAt: z.string().optional(),
  // Which registered root this project was discovered under. Zod strips keys
  // the schema does not mention, so omitting this silently dropped it on save
  // and lost the only thing distinguishing two same-named projects.
  workspaceRoot: z.string().optional(),
}) satisfies z.ZodType<ProjectRegistryEntry>;

const ProjectsFileSchema = z.object({
  version: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
  projects: z.array(ProjectRegistryEntrySchema),
});

type ProjectsFile = z.infer<typeof ProjectsFileSchema>;

/** `control` was missing from this list while LeasePreset (src/types.ts) has
 * carried it since desktop control landed, so persisting a control lease
 * failed schema validation on write. */
const LeasePresetSchema = z.enum([
  "read-only",
  "tests-only",
  "full-write",
  "image-only",
  "control",
]);

const LeaseSchema = z.object({
  projectId: z.string(),
  leaseId: z.string(),
  projectRoot: z.string(),
  preset: LeasePresetSchema,
  issuedAt: z.number().int().nonnegative(),
  expiresAt: z.number().int().nonnegative(),
});

const ModeSchema = z.enum(["observe", "read", "edit", "verify", "danger"]);

/** Session document shape (active project, mode, lease) — PRD §6, §7.
 * This is the per-session view every caller still sees; only the on-disk
 * container around it became a map. */
const SessionSchema = z.object({
  version: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
  activeProjectId: z.string().nullable(),
  mode: ModeSchema,
  lease: LeaseSchema.nullable(),
  /** Which connector this session authenticated as, when it has one. */
  clientId: z.string().optional(),
});

export type SessionDocument = z.infer<typeof SessionSchema>;

/** One entry in the v2 session map. */
const SessionEntrySchema = z.object({
  activeProjectId: z.string().nullable(),
  mode: ModeSchema,
  lease: LeaseSchema.nullable(),
  slot: z.string(),
  lastActiveAtMs: z.number().int().nonnegative(),
  // Optional: absent in files written before takeover existed, and absent for
  // stdio sessions, which carry no OAuth identity.
  clientId: z.string().optional(),
});

const SessionDefaultsSchema = z.object({
  activeProjectId: z.string(),
  preset: LeasePresetSchema,
});

/**
 * v2 sessions.json: a map keyed by MCP session id instead of the single
 * server-wide document v1 used. v1 kept exactly one `lease`, so two ChatGPT
 * conversations overwrote each other's project selection.
 */
const SessionsFileV2Schema = z.object({
  version: z.literal(2),
  updatedAt: z.number().int().nonnegative(),
  sessions: z.record(z.string(), SessionEntrySchema),
  defaults: SessionDefaultsSchema.nullable(),
});

type SessionsFileV2 = z.infer<typeof SessionsFileV2Schema>;

/** v1 shape, still on disk for anyone upgrading in place. */
const SessionsFileV1Schema = z.object({
  version: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
  activeProjectId: z.string().nullable(),
  mode: ModeSchema,
  lease: LeaseSchema.nullable(),
});

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

const PROJECTS_FILE = "projects.json";
const SESSIONS_FILE = "sessions.json";

function emptyProjectsFile(): ProjectsFile {
  return { version: 1, updatedAt: Date.now(), projects: [] };
}

function emptySession(): SessionDocument {
  return {
    version: 2,
    updatedAt: Date.now(),
    activeProjectId: null,
    mode: "observe",
    lease: null,
  };
}

function emptySessionsFile(): SessionsFileV2 {
  return { version: 2, updatedAt: Date.now(), sessions: {}, defaults: null };
}

/**
 * Smallest unused `W##` label. Slots are display names for humans: session
 * keys are UUIDs, which are unusable in an error message like "held by
 * another session" or in a dashboard column.
 */
function assignSlot(taken: Iterable<string>): string {
  const used = new Set(taken);
  for (let i = 1; i <= 999; i += 1) {
    const candidate = `W${String(i).padStart(2, "0")}`;
    if (!used.has(candidate)) return candidate;
  }
  return `W${Date.now() % 1000}`;
}

export class Store {
  private readonly stateDir: string;
  /** Serialize session-file mutations so concurrent HTTP handlers cannot
   * interleave read-modify-write cycles on sessions.json. The file itself is
   * written atomically (temp + rename); this queue is the cross-key lock. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(stateDir: string) {
    this.stateDir = stateDir;
  }

  private locked<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    // Swallow rejections in the chain itself so one failed op doesn't wedge
    // the queue for subsequent callers; callers still see their own errors.
    this.queue = run.catch(() => undefined);
    return run;
  }

  /** Ensure the state directory exists with restrictive 0700 permissions. */
  private async ensureStateDir(): Promise<void> {
    await mkdir(this.stateDir, { recursive: true, mode: DIR_MODE });
    // mkdir with an existing dir does not retroactively chmod; best-effort
    // tighten permissions in case the directory pre-existed with a laxer mode.
    try {
      const { chmod } = await import("node:fs/promises");
      await chmod(this.stateDir, DIR_MODE);
    } catch {
      // Non-fatal: directory may be on a filesystem without POSIX perms.
    }
  }

  /**
   * Atomically write `data` (already JSON-stringified) to `filename` inside
   * the state dir: write to a sibling temp file, fsync-flush via the OS
   * write, then rename over the target. Rename is atomic within the same
   * directory/filesystem, so readers never observe a partial write.
   */
  private async atomicWriteJson(filename: string, data: unknown): Promise<void> {
    await this.ensureStateDir();
    const target = join(this.stateDir, filename);
    const tmp = join(
      this.stateDir,
      `.${filename}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`,
    );
    const json = JSON.stringify(data, null, 2);
    await writeFile(tmp, json, { mode: FILE_MODE, encoding: "utf8" });
    await rename(tmp, target);
  }

  private async readJson(filename: string): Promise<unknown | undefined> {
    const target = join(this.stateDir, filename);
    try {
      const raw = await readFile(target, "utf8");
      return JSON.parse(raw);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return undefined;
      throw new DomainError(
        ErrorCode.NOT_IMPLEMENTED,
        `Store: failed to read/parse ${filename}: ${(err as Error).message}`,
      );
    }
  }

  async loadProjects(): Promise<ProjectRegistryEntry[]> {
    const raw = await this.readJson(PROJECTS_FILE);
    if (raw === undefined) return [];
    const parsed = ProjectsFileSchema.safeParse(raw);
    if (!parsed.success) {
      throw new DomainError(
        ErrorCode.NOT_IMPLEMENTED,
        `Store: ${PROJECTS_FILE} failed validation: ${parsed.error.message}`,
      );
    }
    return parsed.data.projects;
  }

  async saveProjects(p: ProjectRegistryEntry[]): Promise<void> {
    const validated = z.array(ProjectRegistryEntrySchema).parse(p);
    const doc: ProjectsFile = {
      version: 1,
      updatedAt: Date.now(),
      projects: validated,
    };
    await this.atomicWriteJson(PROJECTS_FILE, doc);
  }

  /**
   * Read sessions.json, migrating a v1 document forward in memory.
   *
   * A v1 file carried one server-wide lease. That lease cannot belong to any
   * live MCP session (none had connected when it was written), so it is not
   * resurrected as a session; only its project survives, as the default a new
   * session inherits. That keeps single-project users on their existing
   * behaviour while removing the shared lease that made two windows fight.
   */
  private async loadSessionsFile(): Promise<{ file: SessionsFileV2; migrated: boolean }> {
    const raw = await this.readJson(SESSIONS_FILE);
    if (raw === undefined) return { file: emptySessionsFile(), migrated: false };

    const v2 = SessionsFileV2Schema.safeParse(raw);
    if (v2.success) return { file: v2.data, migrated: false };

    const v1 = SessionsFileV1Schema.safeParse(raw);
    if (v1.success) {
      return {
        migrated: true,
        file: {
          version: 2,
          updatedAt: Date.now(),
          sessions: {},
          defaults: v1.data.activeProjectId
            ? {
                activeProjectId: v1.data.activeProjectId,
                preset: v1.data.lease?.preset ?? "full-write",
              }
            : null,
        },
      };
    }

    throw new DomainError(
      ErrorCode.NOT_IMPLEMENTED,
      `Store: ${SESSIONS_FILE} failed validation: ${v2.error.message}`,
    );
  }

  private async writeSessionsFile(file: SessionsFileV2): Promise<void> {
    const validated = SessionsFileV2Schema.parse({ ...file, updatedAt: Date.now() });
    await this.atomicWriteJson(SESSIONS_FILE, validated);
  }

  /** This session's own lease view. Unknown keys read as an empty session
   * rather than inheriting whatever another conversation last selected. */
  async getSession(sessionKey: string = STDIO_SESSION_KEY): Promise<SessionDocument> {
    const { file } = await this.loadSessionsFile();
    const entry = file.sessions[sessionKey];
    if (!entry) return emptySession();
    return {
      version: 2,
      updatedAt: file.updatedAt,
      activeProjectId: entry.activeProjectId,
      mode: entry.mode,
      lease: entry.lease,
      clientId: entry.clientId,
    };
  }

  async setSession(s: unknown, sessionKey: string = STDIO_SESSION_KEY): Promise<void> {
    return this.locked(async () => {
      const incoming = typeof s === "object" && s !== null ? (s as Partial<SessionDocument>) : {};
      const { file } = await this.loadSessionsFile();
      const existing = file.sessions[sessionKey];
      const slot =
        existing?.slot ??
        assignSlot(Object.values(file.sessions).map((entry) => entry.slot));

      file.sessions[sessionKey] = SessionEntrySchema.parse({
        activeProjectId: incoming.activeProjectId ?? null,
        mode: incoming.mode ?? "observe",
        lease: incoming.lease ?? null,
        slot,
        lastActiveAtMs: Date.now(),
        // Keep a previously recorded client id when this write does not carry
        // one, so a stdio-shaped update cannot erase the connector identity.
        clientId: incoming.clientId ?? existing?.clientId,
      });
      await this.writeSessionsFile(file);
    });
  }

  /** Every persisted session, for cross-session conflict checks. */
  async listSessions(): Promise<SessionSummary[]> {
    const { file } = await this.loadSessionsFile();
    return Object.entries(file.sessions).map(([sessionKey, entry]) => ({
      sessionKey,
      slot: entry.slot,
      activeProjectId: entry.activeProjectId,
      mode: entry.mode,
      lease: entry.lease,
      lastActiveAtMs: entry.lastActiveAtMs,
      clientId: entry.clientId,
    }));
  }

  async getDefaults(): Promise<SessionDefaults | null> {
    const { file } = await this.loadSessionsFile();
    return file.defaults;
  }

  async setDefaults(d: SessionDefaults | null): Promise<void> {
    return this.locked(async () => {
      const { file } = await this.loadSessionsFile();
      file.defaults = d ? SessionDefaultsSchema.parse(d) : null;
      await this.writeSessionsFile(file);
    });
  }

  /**
   * Release one session's lease without deleting the session.
   *
   * Used when a connector reappears under a new MCP session id and reclaims
   * the project its previous session still holds. The stale session stays in
   * the map — it may still be attached to a live transport — but it stops
   * holding a project hostage.
   */
  async releaseSessionLease(sessionKey: string): Promise<boolean> {
    return this.locked(async () => {
      const { file } = await this.loadSessionsFile();
      const entry = file.sessions[sessionKey];
      if (!entry || !entry.lease) return false;
      entry.lease = null;
      entry.activeProjectId = null;
      entry.mode = "observe";
      await this.writeSessionsFile(file);
      return true;
    });
  }

  /**
   * Move a live lease held by another session of `clientId` onto `sessionKey`.
   *
   * Find and transfer happen in one locked write so two per-call sessions
   * from the same connector cannot both copy the sibling and leave two
   * holders. The second caller re-finds the first adopter and moves again,
   * so disk still has exactly one live lease.
   */
  async adoptConnectorLease(
    sessionKey: string,
    clientId: string,
    projectId: string,
  ): Promise<{ lease: Lease; fromSlot: string; mode: ExecutionMode } | undefined> {
    return this.locked(async () => {
      const { file } = await this.loadSessionsFile();
      const now = Date.now();
      const siblingEntry = Object.entries(file.sessions).find(
        ([key, entry]) =>
          key !== sessionKey &&
          entry.clientId !== undefined &&
          entry.clientId === clientId &&
          entry.lease !== null &&
          entry.lease.projectId === projectId &&
          entry.lease.expiresAt > now,
      );
      if (!siblingEntry) return undefined;
      const [, sibling] = siblingEntry;
      const lease = sibling.lease;
      if (!lease) return undefined;

      const fromSlot = sibling.slot;
      const mode = sibling.mode;
      const existing = file.sessions[sessionKey];
      const slot =
        existing?.slot ??
        assignSlot(Object.values(file.sessions).map((entry) => entry.slot));

      file.sessions[sessionKey] = SessionEntrySchema.parse({
        activeProjectId: projectId,
        mode,
        lease,
        slot,
        lastActiveAtMs: Date.now(),
        clientId,
      });
      sibling.lease = null;
      sibling.activeProjectId = null;
      sibling.mode = "observe";
      await this.writeSessionsFile(file);
      return { lease, fromSlot, mode };
    });
  }

  /**
   * Drop every session not in `liveKeys`, returning the keys removed.
   *
   * This is what keeps a closed ChatGPT window from holding a project
   * hostage: a stale write lease left on disk would otherwise lock the owner
   * out of their own project until it expired. Pass `null` to clear every
   * session, which is what a fresh server start does — no transport from a
   * previous process can still be live.
   */
  async sweepSessions(liveKeys: readonly string[] | null): Promise<string[]> {
    return this.locked(async () => {
      const { file, migrated } = await this.loadSessionsFile();
      const live = liveKeys === null ? null : new Set(liveKeys);
      const removed: string[] = [];
      for (const key of Object.keys(file.sessions)) {
        if (live === null || !live.has(key)) {
          removed.push(key);
          delete file.sessions[key];
        }
      }
      // Persist on migration too, even with nothing to remove: leaving a v1
      // document on disk means every later read re-derives the same defaults
      // and the file never reflects the format actually in use.
      if (removed.length > 0 || migrated) await this.writeSessionsFile(file);
      return removed;
    });
  }
}
