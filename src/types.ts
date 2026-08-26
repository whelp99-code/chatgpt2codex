/**
 * chatgpt2codex shared contract.
 *
 * This module is the single source of truth for cross-module types used by
 * every tool implementation. Per PRD (docs/UNIFIED-PRD.md §8, §10) and
 * docs/CHATGPT2CODEX-PRD.md §8.
 *
 * Public signatures frozen here MUST NOT change without updating every
 * dependent module. Implementers fill in *other* modules' bodies, not this
 * file's shape.
 */

// ---------------------------------------------------------------------------
// Domain data model (PRD §10)
// ---------------------------------------------------------------------------

/** Canonical project metadata as tracked in the central registry. */
export interface Project {
  projectId: string;
  name: string;
  root: string;
  aliases: string[];
  branch?: string;
  dirty?: boolean;
  hasAgentsMd?: boolean;
  hasCodeBrain?: boolean;
  packageHints?: string[];
  lastSeenAt?: string;
  /** Which registered workspace root this project was discovered under. Set
   * once several roots can be configured, so two same-named projects from
   * different folders can be told apart. */
  workspaceRoot?: string;
}

/**
 * Registry entry as persisted in `~/.local/share/chatgpt2codex/projects.json`.
 * Currently identical in shape to `Project`; kept as a distinct alias so the
 * on-disk contract can diverge from the in-memory/API contract later without
 * a breaking rename.
 */
export type ProjectRegistryEntry = Project;

/**
 * Lease preset controlling the ceiling of permitted mutating operations.
 * `control` is the Option B human-confirmed desktop-control preset: it grants
 * only `read` + `control` capabilities (never write/image/remote) and is
 * only reachable when the install-time `CHATGPT2CODEX_CONTROL` feature flag
 * is enabled (src/control/policy.ts isControlEnabled).
 */
export type LeasePreset = "read-only" | "tests-only" | "full-write" | "image-only" | "control";

/** Active project lease granted by `project_select`. */
export interface Lease {
  projectId: string;
  leaseId: string;
  projectRoot: string;
  preset: LeasePreset;
  issuedAt: number; // epoch ms
  expiresAt: number; // epoch ms
}

/** Execution mode ladder (PRD §6 / CHATGPT2CODEX-PRD §13). */
export type ExecutionMode = "observe" | "read" | "edit" | "verify" | "danger";

/** Fixed session key for local stdio callers, which have no transport-level
 * session id of their own (Codex CLI, the status bar, `serve --stdio`). */
export const STDIO_SESSION_KEY = "stdio";

/** One persisted MCP session's lease state, as returned by `listSessions`. */
export interface SessionSummary {
  sessionKey: string;
  /** OAuth client the session authenticated as, when it arrived over HTTP.
   * Two MCP sessions sharing one client id are the same connector — which is
   * how a conversation that silently rotated its session id is recognised. */
  clientId?: string;
  /** Name the conversation gave itself when it took the project. Every
   * ChatGPT window authenticates as one OAuth client, so this is the only
   * thing that can tell two windows of the same connector apart. */
  workerName?: string;
  /** Short human-facing label (`W01`, `W02`, ...). Session keys are UUIDs and
   * are unreadable in error messages and dashboards. */
  slot: string;
  activeProjectId: string | null;
  mode: ExecutionMode;
  lease: Lease | null;
  lastActiveAtMs: number;
}

/** Project a new session inherits when it has not run project_select yet.
 * Replaces the old behaviour where `--active-project-root` minted a real
 * server-wide lease before any client had even connected. */
export interface SessionDefaults {
  activeProjectId: string;
  preset: LeasePreset;
}

// ---------------------------------------------------------------------------
// Runtime config
// ---------------------------------------------------------------------------

export interface Config {
  /** Primary workspace root — always `workspaceRoots[0]`. Kept as its own
   * field so existing messages and callers that only need one root do not
   * have to reach into the array. */
  workspaceRoot: string;
  /** Every folder the owner registered as a workspace root. Projects are
   * discovered under all of them and merged into one registry. */
  workspaceRoots: string[];
  stateDir: string;
  /** Max bytes returned/read for a single file_read_slice call. */
  maxReadBytes: number;
  /** Max bytes accepted for a single file_apply_patch payload. */
  maxPatchBytes: number;
  /** Default command timeout in seconds. */
  defaultCommandTimeoutSec: number;
  /** Default lease TTL in ms. */
  defaultLeaseTtlMs: number;
  /** Public HTTP origin used for short-lived inline screenshot links. */
  publicUrl?: string;
}

// ---------------------------------------------------------------------------
// Tool context — dependency bag threaded through every tool handler.
// ---------------------------------------------------------------------------

export interface ToolContext {
  /** Primary workspace root — always `workspaceRoots[0]`. */
  workspaceRoot: string;
  /** Every registered workspace root, in the order the owner listed them. */
  workspaceRoots: string[];
  stateDir: string;
  /** Loaded/loadable project registry entries. */
  registry: ProjectRegistryEntry[];
  /** Append-only audit ledger sink. */
  ledger: {
    append(event: { type: string; [k: string]: unknown }): Promise<void>;
  };
  /** Central state store (registry + session persistence).
   *
   * Session reads and writes are keyed: callers pass `ctx.sessionKey` so each
   * ChatGPT conversation only ever sees its own lease. Omitting the key falls
   * back to the stdio session, which is what local callers want. */
  store: {
    loadProjects(): Promise<ProjectRegistryEntry[]>;
    saveProjects(p: ProjectRegistryEntry[]): Promise<void>;
    getSession(sessionKey?: string): Promise<unknown>;
    setSession(s: unknown, sessionKey?: string): Promise<void>;
    /** Every persisted session, used to detect cross-session lease conflicts.
     * Expired entries are filtered out by the caller, not here. */
    listSessions?(): Promise<SessionSummary[]>;
    /** Project a brand-new session inherits when it has not selected one. */
    getDefaults?(): Promise<SessionDefaults | null>;
    setDefaults?(d: SessionDefaults | null): Promise<void>;
    /** Release one session's lease, keeping the session itself. Returns false
     * when the session is unknown or already holds nothing. */
    releaseSessionLease?(sessionKey: string): Promise<boolean>;
    /** Drop every session not listed in `liveKeys` (pass `null` to drop all),
     * returning the keys removed. Releases leases held by transports that are
     * gone so a closed conversation cannot keep a project locked. */
    sweepSessions?(liveKeys: readonly string[] | null): Promise<string[]>;
  };
  /** OAuth client id of the connector this context serves, when known.
   * Absent for stdio callers, which have no OAuth identity. */
  clientId?: string;
  /** Which MCP session this context serves. One ChatGPT conversation maps to
   * one key; local stdio callers share the fixed `STDIO_SESSION_KEY`. */
  sessionKey: string;
  config: Config;
  /** True for an MCP server instance handed a remote/network transport
   * session (currently: src/server/http.ts's /mcp endpoint, which is how
   * ChatGPT connects). Absent/false for local stdio sessions (Codex CLI,
   * status bar). Used to refuse arming a `control` lease or resuming a
   * killed control session (project_select preset=control) from a remote
   * caller — lease arming and kill resumption stay local-only even when the
   * desktop-control tools are exposed to ChatGPT
   * (src/control/policy.ts isControlChatGptExposed). */
  remote?: boolean;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Domain error codes — never throw raw strings across a tool boundary. */
export enum ErrorCode {
  PROJECT_NOT_FOUND = "PROJECT_NOT_FOUND",
  PATH_OUTSIDE_PROJECT = "PATH_OUTSIDE_PROJECT",
  PATH_OUTSIDE_WORKSPACE = "PATH_OUTSIDE_WORKSPACE",
  HASH_MISMATCH = "HASH_MISMATCH",
  LEASE_REQUIRED = "LEASE_REQUIRED",
  /** Another live MCP session already holds a write lease on this project.
   * Distinct from PERMISSION_DENIED, which means the caller's own preset is
   * too weak — here the preset is fine and the project is simply occupied. */
  PROJECT_LOCKED = "PROJECT_LOCKED",
  COMMAND_NOT_ALLOWED = "COMMAND_NOT_ALLOWED",
  ARBITRARY_SHELL_DENIED = "ARBITRARY_SHELL_DENIED",
  APPROVAL_REQUIRED = "APPROVAL_REQUIRED",
  FILE_EXISTS = "FILE_EXISTS",
  FILE_TOO_LARGE = "FILE_TOO_LARGE",
  SECRET_BLOCKED = "SECRET_BLOCKED",
  TIMEOUT = "TIMEOUT",
  AMBIGUOUS_PROJECT = "AMBIGUOUS_PROJECT",
  WORKSPACE_NOT_READY = "WORKSPACE_NOT_READY",
  // Additional codes referenced by the PRD tool catalog (§8) that stub
  // implementations may also raise; kept here so every module shares one
  // enum instead of inventing ad-hoc strings.
  NOT_A_FILE = "NOT_A_FILE",
  PATCH_TOO_LARGE = "PATCH_TOO_LARGE",
  NULLBYTE_REJECTED = "NULLBYTE_REJECTED",
  PENDING_WORK_IN_ACTIVE = "PENDING_WORK_IN_ACTIVE",
  SCAN_DENIED = "SCAN_DENIED",
  PROJECT_NOT_SELECTED = "PROJECT_NOT_SELECTED",
  NOT_IMPLEMENTED = "NOT_IMPLEMENTED",
  CHECKPOINT_NOT_FOUND = "CHECKPOINT_NOT_FOUND",
  INVALID_IMAGE_DATA = "INVALID_IMAGE_DATA",
  UNSUPPORTED_MEDIA_TYPE = "UNSUPPORTED_MEDIA_TYPE",
  QUOTA_EXCEEDED = "QUOTA_EXCEEDED",
  PERMISSION_DENIED = "PERMISSION_DENIED",
  // Option B desktop-control codes (src/control/**).
  CONTROL_DISABLED = "CONTROL_DISABLED",
  CONFIRMATION_PENDING = "CONFIRMATION_PENDING",
  SENSITIVE_TARGET_BLOCKED = "SENSITIVE_TARGET_BLOCKED",
  CONTROL_KILLED = "CONTROL_KILLED",
}

/** Thrown by any domain-level failure. Tool boundary must catch and map. */
export class DomainError extends Error {
  readonly code: ErrorCode;
  readonly details?: Record<string, unknown>;

  constructor(code: ErrorCode, message?: string, details?: Record<string, unknown>) {
    super(message ?? code);
    this.name = "DomainError";
    this.code = code;
    this.details = details;
  }
}

// ---------------------------------------------------------------------------
// Tool result helper
// ---------------------------------------------------------------------------

/**
 * Shape every MCP tool handler resolves to: structured content for
 * programmatic consumers plus a short human-readable text summary, matching
 * MCP's `structuredContent` + text content block convention.
 */
export type ToolContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: "image/png" | "image/jpeg" };

export interface ToolResult<T = Record<string, unknown>> {
  structuredContent: T;
  content: ToolContent[];
  isError?: boolean;
  /** Result-level metadata (e.g. ChatGPT Apps SDK widget payloads); not shown to the model. */
  _meta?: Record<string, unknown>;
}

export function makeResult<T extends Record<string, unknown>>(
  structured: T,
  text: string,
  isError?: boolean,
): ToolResult<T> {
  return {
    structuredContent: structured,
    content: [{ type: "text", text }],
    ...(isError ? { isError: true } : {}),
  };
}
