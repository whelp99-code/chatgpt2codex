#!/usr/bin/env node
/**
 * chatgpt2codex CLI entrypoint.
 *
 * Minimal hand-rolled argv parsing (no commander dependency) for the three
 * MVP subcommands defined in PRD §5:
 *
 *   chatgpt2codex serve  --workspace <path>
 *   chatgpt2codex init   --workspace <path>
 *   chatgpt2codex doctor
 */

import { execFile } from "node:child_process";
import { promises as fs, readFileSync } from "node:fs";
import type { Server as HttpListener } from "node:http";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { Express } from "express";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Config, LeasePreset, ProjectRegistryEntry, ToolContext } from "./types.js";
import { STDIO_SESSION_KEY } from "./types.js";
import { findProject, scanWorkspaces } from "./workspace/registry.js";
import { makeLease } from "./workspace/project-select.js";
import { Store } from "./state/store.js";
import { Ledger } from "./state/ledger.js";
import { createServer } from "./server/mcp-server.js";
import { createHttpServer, defaultHttpServerConfig } from "./server/http.js";
import { generateOwnerToken, hasOwnerToken, storeOwnerToken } from "./auth/owner-token.js";
import { JsonOAuthStore } from "./auth/oauth-store.js";
import { checkIntakeAvailability } from "./assets/image-intake.js";
import { controlAllowlist, isAppAllowed, isControlEnabled, isSensitiveApp } from "./control/policy.js";
import { startExecutor } from "./control/executor.js";
import { approveAction, isKilled, listActions, rejectAction, setKill, toSummary } from "./control/queue.js";
import { preflightPermissions } from "./control/mac-input.js";
import { clampMinutes, clearAuto, readAuto, setAuto, type AutoActionKind } from "./control/auto.js";

const execFileAsync = promisify(execFile);

interface ParsedArgs {
  command: string | undefined;
  /** Last value seen for each flag. Repeating a flag overwrites here. */
  flags: Record<string, string | boolean>;
  /** Every value seen for each flag, in order. `--workspace` is repeatable
   * so several workspace roots can be registered in one launch; `flags`
   * alone would silently keep only the last one. */
  repeated: Record<string, string[]>;
  /** Non-flag arguments after the command, e.g. `control approve <actionId>`. */
  positional: string[];
}

function parseArgs(argv: string[]): ParsedArgs {
  const [command, ...rest] = argv;
  const flags: Record<string, string | boolean> = {};
  const repeated: Record<string, string[]> = {};
  const positional: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg?.startsWith("--")) {
      const key = arg.slice(2);
      const next = rest[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags[key] = next;
        (repeated[key] ??= []).push(next);
        i++;
      } else {
        flags[key] = true;
      }
    } else if (arg !== undefined) {
      positional.push(arg);
    }
  }
  return { command, flags, repeated, positional };
}

/**
 * Resolve the workspace roots to index, in priority order:
 *   1. every `--workspace <path>` on the command line (repeatable)
 *   2. `CHATGPT2CODEX_WORKSPACES`, one path per line
 *   3. `<stateDir>/workspaces.txt`, one path per line
 *   4. the current directory
 *
 * The file in step 3 is the configuration surface that does not require
 * rebuilding the desktop app: edit it and restart the server.
 *
 * Blank entries and `#` comments are dropped, `~/` is expanded, paths are
 * resolved, and duplicates are removed while preserving the order the owner
 * listed them in — the first root is the primary one used in status messages.
 */
export const WORKSPACES_FILE = "workspaces.txt";

function readWorkspacesFile(stateDir: string): string[] {
  try {
    // Sync on purpose: root resolution happens before any async work, and
    // keeping it sync avoids threading a promise through every entry point.
    return readFileSync(path.join(stateDir, WORKSPACES_FILE), "utf8").split("\n");
  } catch {
    return [];
  }
}

function resolveWorkspaceRoots(args: Pick<ParsedArgs, "flags" | "repeated">): string[] {
  const hasContent = (lines: string[]): boolean => lines.some((line) => line.trim().length > 0);
  const fromFlags = args.repeated.workspace ?? [];
  const fromEnv = (process.env.CHATGPT2CODEX_WORKSPACES ?? "").split("\n");
  const candidates = fromFlags.length > 0 ? fromFlags : hasContent(fromEnv) ? fromEnv : readWorkspacesFile(defaultStateDir());

  const roots: string[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    const trimmed = candidate.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) continue;
    const expanded = trimmed.startsWith("~/") ? path.join(os.homedir(), trimmed.slice(2)) : trimmed;
    const resolved = path.resolve(expanded);
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    roots.push(resolved);
  }
  return roots.length > 0 ? roots : [path.resolve(process.cwd())];
}

/** Default state dir per PRD §10: `~/.local/share/chatgpt2codex/`. */
function defaultStateDir(): string {
  return path.join(os.homedir(), ".local", "share", "chatgpt2codex");
}

function defaultConfig(workspaceRoots: string[], stateDir: string): Config {
  return {
    workspaceRoot: workspaceRoots[0] ?? process.cwd(),
    workspaceRoots,
    stateDir,
    maxReadBytes: 10 * 1024 * 1024,
    maxPatchBytes: 10 * 1024 * 1024,
    defaultCommandTimeoutSec: 30,
    defaultLeaseTtlMs: 30 * 60 * 1000,
  };
}

/**
 * Build a ToolContext for `workspace`.
 *
 * `persistRegistry: false` makes this a read-only probe: the workspace is
 * still scanned so the caller sees an accurate registry, but the result is
 * NOT written to `<stateDir>/projects.json`. `doctor` uses that mode — it
 * runs from whatever directory it happens to be invoked in (the launcher
 * runs it from the app bundle's runtime folder), and persisting that scan
 * would replace the user's real project registry with a scan of the app
 * bundle.
 */
async function buildToolContext(workspaceRoots: string[], persistRegistry = true): Promise<ToolContext> {
  const roots = workspaceRoots.map((root) => path.resolve(root));
  const workspaceRoot = roots[0] ?? path.resolve(process.cwd());
  const stateDir = defaultStateDir();

  const store = new Store(stateDir);
  const ledger = new Ledger(stateDir);

  const { entries: registry, failedRoots } = await scanWorkspaces(roots);
  // One missing folder must not take the whole workspace down with it — say
  // which root failed and index the rest.
  for (const failure of failedRoots) {
    console.error(`chatgpt2codex: skipping unreadable workspace root ${failure.root} (${failure.reason})`);
  }
  if (persistRegistry) await store.saveProjects(registry);

  const config = defaultConfig(roots, stateDir);

  return {
    workspaceRoot,
    workspaceRoots: roots,
    stateDir,
    registry,
    ledger: { append: (event) => ledger.append(event) },
    store: {
      loadProjects: () => store.loadProjects(),
      saveProjects: (p) => store.saveProjects(p),
      getSession: (sessionKey) => store.getSession(sessionKey),
      setSession: (s, sessionKey) => store.setSession(s, sessionKey),
      listSessions: () => store.listSessions(),
      getDefaults: () => store.getDefaults(),
      setDefaults: (d) => store.setDefaults(d),
      sweepSessions: (liveKeys) => store.sweepSessions(liveKeys),
    },
    config,
    // Local/stdio callers share one key; src/server/http.ts overrides this
    // per connected MCP session.
    sessionKey: STDIO_SESSION_KEY,
  };
}

function parseLeasePreset(value: string | boolean | undefined): LeasePreset {
  if (
    value === "read-only" ||
    value === "tests-only" ||
    value === "full-write" ||
    value === "image-only" ||
    value === "control"
  ) {
    return value;
  }
  return "full-write";
}

async function applyStartupProjectSelection(ctx: ToolContext, flags: Record<string, string | boolean>): Promise<void> {
  const activeProject = typeof flags["active-project"] === "string" ? flags["active-project"] : undefined;
  const activeProjectRoot =
    typeof flags["active-project-root"] === "string" ? path.resolve(flags["active-project-root"]) : undefined;
  if (!activeProject && !activeProjectRoot) return;

  const entries = ctx.registry.length > 0 ? ctx.registry : await ctx.store.loadProjects();
  let entry: ProjectRegistryEntry | undefined;
  if (activeProjectRoot) {
    entry = entries.find((candidate) => path.resolve(candidate.root) === activeProjectRoot);
  } else if (activeProject) {
    const result = findProject(entries, { projectId: activeProject, name: activeProject });
    if (result.ok) entry = result.entry;
  }

  if (!entry) {
    throw new Error(
      `Startup active project not found: ${activeProjectRoot ?? activeProject}. ` +
        `Make sure --workspace points at that project folder or its workspace root.`,
    );
  }

  const preset = parseLeasePreset(flags["active-project-preset"]);
  // Record a default rather than minting a lease. A startup lease belonged to
  // no session — nothing had connected yet — but was visible to every session,
  // which is exactly the shared-lease problem per-session leases remove. Now a
  // new conversation inherits this project only until it selects its own.
  await ctx.store.setDefaults?.({ activeProjectId: entry.projectId, preset });
  await ctx.ledger.append({
    type: "project.default.set",
    projectId: entry.projectId,
    reason: "startup active project",
    preset,
  });
}

async function cmdServeStdio(args: ParsedArgs): Promise<void> {
  const flags = args.flags;
  const ctx = await buildToolContext(resolveWorkspaceRoots(args));
  await applyStartupProjectSelection(ctx, flags);
  if (isControlEnabled()) startExecutor(ctx);
  const server = await createServer(ctx);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  await ctx.ledger.append({
    type: "workspace.opened",
    workspaceRoot: ctx.workspaceRoot,
    workspaceRoots: ctx.workspaceRoots,
  });
  console.error(`chatgpt2codex serve: listening on stdio (workspaces=${ctx.workspaceRoots.join(", ")})`);
  console.error(`chatgpt2codex serve: indexed ${ctx.registry.length} project(s)`);
}

/**
 * HTTP mode (PRD §4 Transport Gateway, §5 CLI): `chatgpt2codex serve --http
 * [--port 7979] [--public-url <origin>]`. Exposes the SAME registerTools(ctx)
 * catalog as stdio mode over a Streamable HTTP `/mcp` endpoint, gated by
 * OAuth 2.1 (see src/server/http.ts, src/auth/oauth-provider.ts). Entry point
 * is cmdServeHttp() below; the helpers directly beneath this comment exist to
 * make its bind step survivable.
 */

/** How long to keep retrying a bind that fails with EADDRINUSE, and how
 * often. A restart (menu bar "Restart MCP", or the launcher's stale-runtime
 * cleanup) terminates the previous server and immediately starts a new one;
 * the old process can still hold the listening socket for a second or two
 * while it shuts down. Without this the new server used to die instantly and,
 * under any supervisor, crash-loop forever. */
const LISTEN_RETRY_INTERVAL_MS = 500;

function listenRetryTotalMs(): number {
  const raw = process.env.CHATGPT2CODEX_LISTEN_RETRY_MS;
  if (raw !== undefined) {
    const parsed = Number.parseInt(raw, 10);
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  }
  return 15_000;
}

interface ListenFailure {
  code: string;
  message: string;
}

/**
 * `app.listen()` reports bind failures by emitting an `error` event on the
 * returned server, NOT by throwing. With no `error` listener attached, Node
 * rethrows it as an unhandled `error` event and the process dies with a raw
 * stack trace — which is how a busy port turned into an endless
 * start/crash/restart loop that never served a single request.
 *
 * This wrapper always attaches the listener, retries EADDRINUSE for a bounded
 * window so a normal restart survives the old process letting go of the port,
 * and resolves with a typed failure instead of throwing so the caller can
 * print something a human can act on.
 */
async function listenOrExplain(
  app: Express,
  port: number,
  host: string,
): Promise<{ ok: true; server: HttpListener } | { ok: false; failure: ListenFailure }> {
  const retryWindowMs = listenRetryTotalMs();
  const deadline = Date.now() + retryWindowMs;
  let announcedWait = false;

  for (;;) {
    const attempt = await new Promise<{ ok: true; server: HttpListener } | { ok: false; failure: ListenFailure }>(
      (resolve) => {
        const server = app.listen(port, host);
        const onError = (err: NodeJS.ErrnoException) => {
          server.removeListener("listening", onListening);
          resolve({ ok: false, failure: { code: err.code ?? "UNKNOWN", message: err.message } });
        };
        const onListening = () => {
          server.removeListener("error", onError);
          resolve({ ok: true, server });
        };
        server.once("error", onError);
        server.once("listening", onListening);
      },
    );

    if (attempt.ok) return attempt;
    if (attempt.failure.code !== "EADDRINUSE" || Date.now() >= deadline) return attempt;

    if (!announcedWait) {
      announcedWait = true;
      console.error(
        `chatgpt2codex serve --http: port ${port} is still held by a previous instance; ` +
          `waiting up to ${Math.round(retryWindowMs / 1000)}s for it to shut down...`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, LISTEN_RETRY_INTERVAL_MS));
  }
}

function explainListenFailure(failure: ListenFailure, port: number, host: string): string {
  switch (failure.code) {
    case "EADDRINUSE":
      return [
        `chatgpt2codex serve --http: port ${port} is already in use and did not free up.`,
        `Another chatgpt2codex server (or another app) is listening on ${host}:${port}.`,
        `Fix: stop it, or start on a different port with PORT=<other> / --port <other>.`,
        `Find the process with:  lsof -nP -iTCP:${port} -sTCP:LISTEN`,
      ].join("\n");
    case "EACCES":
      return [
        `chatgpt2codex serve --http: not allowed to bind ${host}:${port}.`,
        `Ports below 1024 need elevated privileges — pick a port above 1024.`,
      ].join("\n");
    case "EADDRNOTAVAIL":
      return [
        `chatgpt2codex serve --http: the address ${host} does not exist on this machine.`,
        `Use --host 127.0.0.1 unless you specifically need another interface.`,
      ].join("\n");
    default:
      return `chatgpt2codex serve --http: could not listen on ${host}:${port} (${failure.code}): ${failure.message}`;
  }
}

async function cmdServeHttp(args: ParsedArgs): Promise<void> {
  const flags = args.flags;
  const ctx = await buildToolContext(resolveWorkspaceRoots(args));

  if (!(await hasOwnerToken(ctx.stateDir))) {
    console.error(
      "chatgpt2codex serve --http: no owner token found. Run `chatgpt2codex init` first to generate one.",
    );
    process.exitCode = 1;
    return;
  }

  const port = typeof flags.port === "string" ? Number.parseInt(flags.port, 10) : 7979;
  const host = typeof flags.host === "string" ? flags.host : "127.0.0.1";
  const publicUrl =
    typeof flags["public-url"] === "string" ? (flags["public-url"] as string) : `http://${host}:${port}`;
  ctx.config.publicUrl = publicUrl;
  const idleShutdownMinutes =
    typeof flags["idle-shutdown-minutes"] === "string" ? Number.parseFloat(flags["idle-shutdown-minutes"]) : 0;
  const idleShutdownMs =
    Number.isFinite(idleShutdownMinutes) && idleShutdownMinutes > 0 ? idleShutdownMinutes * 60 * 1000 : undefined;
  await applyStartupProjectSelection(ctx, flags);
  if (isControlEnabled()) startExecutor(ctx);

  let httpServer: HttpListener | undefined;
  let closeHttpServer: () => void = () => undefined;
  let shuttingDown = false;
  const shutdown = (exitCode = 0) => {
    if (shuttingDown) return;
    shuttingDown = true;
    const finish = () => {
      closeHttpServer();
      process.exit(exitCode);
    };
    if (httpServer) httpServer.close(finish);
    else finish();
  };

  const httpConfig = defaultHttpServerConfig({
    host,
    port,
    publicUrl,
    idleShutdownMs,
    onIdleTimeout: () => {
      console.error("chatgpt2codex serve --http: idle timeout reached; stopping.");
      shutdown(0);
    },
  });
  const running = createHttpServer(ctx, httpConfig);
  const { app } = running;
  closeHttpServer = running.close;

  const listened = await listenOrExplain(app, port, host);
  if (!listened.ok) {
    // The bind failed. Report why, record it as a distinct ledger event, and
    // exit non-zero WITHOUT logging workspace.opened — that event must only
    // ever mean "this server is actually accepting connections", otherwise
    // the audit trail fills up with phantom startups (one per crash) and
    // hides the real problem.
    console.error(explainListenFailure(listened.failure, port, host));
    closeHttpServer();
    await ctx.ledger
      .append({
        type: "server.listen_failed",
        transport: "http",
        host,
        port,
        code: listened.failure.code,
      })
      .catch(() => undefined);
    process.exitCode = 1;
    return;
  }

  httpServer = listened.server;
  // A socket that is already listening can still fail later (rare, but a
  // network interface going away will do it). Keep a handler attached so it
  // is reported rather than killing the process with a bare stack trace.
  httpServer.on("error", (err: NodeJS.ErrnoException) => {
    console.error(`chatgpt2codex serve --http: server error (${err.code ?? "UNKNOWN"}): ${err.message}`);
  });

  console.error(`chatgpt2codex serve --http: listening on http://${host}:${port}/mcp`);
  console.error(`chatgpt2codex serve --http: public URL ${publicUrl}/mcp`);
  console.error(`chatgpt2codex serve --http: workspaces=${ctx.workspaceRoots.join(", ")}`);
  console.error(`chatgpt2codex serve --http: indexed ${ctx.registry.length} project(s)`);
  if (idleShutdownMs !== undefined) {
    console.error(`chatgpt2codex serve --http: idle shutdown after ${idleShutdownMinutes} minute(s) without sessions`);
  }

  await ctx.ledger.append({
    type: "workspace.opened",
    workspaceRoot: ctx.workspaceRoot,
    workspaceRoots: ctx.workspaceRoots,
    transport: "http",
  });

  process.once("SIGINT", () => shutdown(130));
  process.once("SIGTERM", () => shutdown(143));

  // Keep the process alive; httpServer.listen already does this, but guard
  // against callers awaiting cmdServeHttp() expecting it to resolve only
  // once the server is asked to stop.
  await new Promise<void>(() => {});
}

async function cmdServe(args: ParsedArgs): Promise<void> {
  if (args.flags.http) {
    await cmdServeHttp(args);
    return;
  }
  await cmdServeStdio(args);
}

async function cmdInit(args: ParsedArgs): Promise<void> {
  const flags = args.flags;
  const workspaceRoots = resolveWorkspaceRoots(args);
  const stateDir = defaultStateDir();

  const store = new Store(stateDir);
  const ledger = new Ledger(stateDir);

  const { entries: registry, failedRoots } = await scanWorkspaces(workspaceRoots);
  for (const failure of failedRoots) {
    console.error(`chatgpt2codex init: skipping unreadable workspace root ${failure.root} (${failure.reason})`);
  }
  await store.saveProjects(registry);
  // Clear every persisted session: none can still be live across an init.
  await store.sweepSessions(null);
  for (const root of workspaceRoots) {
    await ledger.append({ type: "workspace.opened", workspaceRoot: root });
  }

  console.error(
    `chatgpt2codex init: initialized state dir ${stateDir} with ${registry.length} project(s) from ` +
      `${workspaceRoots.length} root(s): ${workspaceRoots.join(", ")}`,
  );

  // PRD §11 SR-04: owner secret lives only as a hash on disk; the plaintext
  // is generated here and shown to the operator exactly once. Re-running
  // `init` rotates it unless --keep-owner-token is passed.
  const alreadyHasToken = await hasOwnerToken(stateDir);
  if (alreadyHasToken && !flags["rotate-owner-token"]) {
    console.error(
      "chatgpt2codex init: owner token already set (pass --rotate-owner-token to generate a new one).",
    );
  } else {
    const ownerToken = generateOwnerToken();
    await storeOwnerToken(stateDir, ownerToken);
    console.error("");
    console.error("chatgpt2codex init: generated a new HTTP owner token (shown once, never logged again):");
    console.error("");
    console.error(`  ${ownerToken}`);
    console.error("");
    console.error(
      "Store this securely (e.g. a password manager). It is required to approve the OAuth /authorize prompt when a ChatGPT/MCP client connects over `chatgpt2codex serve --http`.",
    );
  }
}

async function readStdin(): Promise<string> {
  return await new Promise((resolve, reject) => {
    let value = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      value += chunk;
    });
    process.stdin.on("end", () => resolve(value));
    process.stdin.on("error", reject);
  });
}

async function cmdOwnerToken(flags: Record<string, string | boolean>): Promise<void> {
  const workspace = typeof flags.workspace === "string" ? flags.workspace : process.cwd();
  const stateDir = defaultStateDir();

  if (flags.status) {
    console.log(JSON.stringify({ configured: await hasOwnerToken(stateDir), stateDir }));
    return;
  }

  // Rotating the owner token revokes everything issued under the old secret.
  // It deliberately does NOT drop dynamic client registrations: a client like
  // ChatGPT registers once when the connector is created and caches the
  // client_id forever, so deleting the registration bricks that connector
  // permanently with an unexplained "Invalid client_id". See
  // JsonOAuthStore.clearTokens.
  if (flags["set-stdin"]) {
    const token = (await readStdin()).trim();
    await storeOwnerToken(stateDir, token);
    const store = new JsonOAuthStore(stateDir);
    await store.clearTokens();
    console.log(
      JSON.stringify({ configured: true, rotated: true, clientsKept: await store.countClients(), stateDir }),
    );
    return;
  }

  if (flags.generate || flags.rotate) {
    const ownerToken = generateOwnerToken();
    await storeOwnerToken(stateDir, ownerToken);
    const store = new JsonOAuthStore(stateDir);
    await store.clearTokens();
    console.log(
      JSON.stringify({
        configured: true,
        rotated: true,
        ownerToken,
        clientsKept: await store.countClients(),
        stateDir,
      }),
    );
    return;
  }

  console.error("usage: chatgpt2codex owner-token --status|--generate|--set-stdin [--workspace <path>]");
  console.error(`workspace: ${path.resolve(workspace)}`);
  process.exitCode = 1;
}

/**
 * `chatgpt2codex control <list|approve|approve-all|reject|kill|preflight|auto> [actionId]`
 *
 * The local-only human-approval surface for Option B desktop control
 * (src/control/queue.ts). This is the mechanism a local approver (today:
 * this CLI directly; eventually the macOS status-bar app via the same
 * runCli pattern it already uses) uses to move a queued click/type/key
 * request from `pending` to `approved`/`rejected`, kill the session
 * outright, or turn on a bounded auto-approve scope (src/control/auto.ts).
 * ChatGPT/MCP clients cannot reach any of this: there is no MCP tool or
 * HTTP route that calls approveAction, setKill, or setAuto.
 */
async function cmdControl(positional: string[], flags: Record<string, string | boolean> = {}): Promise<void> {
  const stateDir = defaultStateDir();
  const [sub, actionId] = positional;
  switch (sub) {
    case "list": {
      const actions = await listActions(stateDir);
      console.log(JSON.stringify(actions.map(toSummary), null, 2));
      return;
    }
    case "approve": {
      if (!actionId) {
        console.error("usage: chatgpt2codex control approve <actionId>");
        process.exitCode = 1;
        return;
      }
      const record = await approveAction(stateDir, actionId);
      console.log(JSON.stringify(toSummary(record), null, 2));
      return;
    }
    case "approve-all": {
      // Local human batch-approve: only pending actions targeting a
      // non-sensitive, allowlisted app are approved. Everything else is
      // reported back as skipped rather than silently approved, and a kill
      // mid-loop stops the whole batch immediately.
      const approved: string[] = [];
      const skipped: Array<{ id: string; reason: string }> = [];
      if (await isKilled(stateDir)) {
        console.log(JSON.stringify({ approved, skipped, killed: true }, null, 2));
        return;
      }
      const allowlist = controlAllowlist();
      const pending = (await listActions(stateDir)).filter((a) => a.status === "pending");
      for (const action of pending) {
        if (await isKilled(stateDir)) break;
        if (isSensitiveApp(action.appName) || !isAppAllowed(action.appName, allowlist)) {
          skipped.push({ id: action.actionId, reason: "blocked-not-eligible" });
          continue;
        }
        try {
          await approveAction(stateDir, action.actionId);
          approved.push(action.actionId);
        } catch (err) {
          skipped.push({ id: action.actionId, reason: err instanceof Error ? err.message : String(err) });
        }
      }
      console.log(JSON.stringify({ approved, skipped }, null, 2));
      return;
    }
    case "auto": {
      const mode = actionId;
      switch (mode) {
        case "on": {
          if (!isControlEnabled()) {
            console.error("Desktop control is not enabled (CHATGPT2CODEX_CONTROL); refusing to enable auto-approve.");
            process.exitCode = 1;
            return;
          }
          const apps =
            typeof flags.apps === "string"
              ? flags.apps
                  .split(",")
                  .map((entry) => entry.trim())
                  .filter((entry) => entry.length > 0)
              : [];
          if (apps.length === 0) {
            console.error(
              "usage: chatgpt2codex control auto on --apps <a,b,...> [--minutes N] [--kinds click,type,key] [--max N]",
            );
            process.exitCode = 1;
            return;
          }
          const minutes = typeof flags.minutes === "string" ? Number(flags.minutes) : undefined;
          const kinds =
            typeof flags.kinds === "string"
              ? (flags.kinds
                  .split(",")
                  .map((entry) => entry.trim())
                  .filter((entry): entry is AutoActionKind => entry === "click" || entry === "type" || entry === "key"))
              : undefined;
          const maxCountRaw = typeof flags.max === "string" ? Number(flags.max) : undefined;
          const maxCount = maxCountRaw !== undefined && !Number.isNaN(maxCountRaw) ? maxCountRaw : undefined;
          const scope = await setAuto(stateDir, {
            apps,
            minutes: clampMinutes(minutes),
            kinds: kinds && kinds.length > 0 ? kinds : undefined,
            maxCount,
          });
          if (scope.apps.length === 0) {
            console.error(
              "warning: none of the requested --apps are on the control allowlist (or all are sensitive apps); auto-approve is on but matches nothing.",
            );
          }
          console.log(JSON.stringify(scope, null, 2));
          return;
        }
        case "off": {
          await clearAuto(stateDir);
          console.log(JSON.stringify({ autoEnabled: false }));
          return;
        }
        case "status": {
          const scope = await readAuto(stateDir);
          if (!scope) {
            console.log(JSON.stringify({ autoEnabled: false }));
            return;
          }
          const now = Date.now();
          const active = now < scope.expiresAt;
          console.log(
            JSON.stringify({ autoEnabled: active, remainingMs: Math.max(0, scope.expiresAt - now), ...scope }, null, 2),
          );
          return;
        }
        default:
          console.error(
            "usage: chatgpt2codex control auto <on --apps a,b [--minutes N] [--kinds click,type,key] [--max N] | off | status>",
          );
          process.exitCode = 1;
          return;
      }
    }
    case "reject": {
      if (!actionId) {
        console.error("usage: chatgpt2codex control reject <actionId>");
        process.exitCode = 1;
        return;
      }
      const record = await rejectAction(stateDir, actionId, "rejected-by-local-approver");
      console.log(JSON.stringify(toSummary(record), null, 2));
      return;
    }
    case "kill": {
      await setKill(stateDir);
      console.log(JSON.stringify({ killed: true }));
      return;
    }
    case "preflight": {
      // Live Accessibility/Screen Recording trust check exposed for local
      // operators and doctor-style diagnosis (src/control/mac-input.ts
      // preflightPermissions). Reports a clear reason instead of a control
      // action failing silently partway through; never throws a raw
      // NOT_IMPLEMENTED stack trace off darwin, always structured JSON.
      try {
        const result = await preflightPermissions();
        console.log(JSON.stringify(result, null, 2));
        if (!result.accessibilityTrusted || !result.screenRecordingAllowed) {
          process.exitCode = 1;
        }
      } catch (err) {
        console.log(
          JSON.stringify(
            {
              accessibilityTrusted: false,
              screenRecordingAllowed: false,
              source: "unavailable",
              reason: err instanceof Error ? err.message : String(err),
            },
            null,
            2,
          ),
        );
        process.exitCode = 1;
      }
      return;
    }
    default:
      console.error("usage: chatgpt2codex control <list|approve|approve-all|reject|kill|preflight|auto> [actionId]");
      process.exitCode = 1;
  }
}

async function checkCommand(cmd: string, args: string[]): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync(cmd, args, { timeout: 5000 });
    return stdout.trim().split("\n")[0];
  } catch {
    return undefined;
  }
}

async function cmdDoctor(): Promise<void> {
  const nodeVersion = process.version;
  const rgVersion = await checkCommand("rg", ["--version"]);
  const gitVersion = await checkCommand("git", ["--version"]);
  const workspacePath = process.cwd();

  let toolCount = "unknown";
  try {
    // Import lazily so a broken registration path doesn't crash doctor.
    const { createServer } = await import("./server/mcp-server.js");
    // Read-only: doctor runs from whatever directory invoked it (the macOS
    // launcher runs it from inside the app bundle), so it must never write
    // that scan over the user's real projects.json.
    const ctx = await buildToolContext([workspacePath], false);
    const server = await createServer(ctx);
    const serverAny = server as unknown as {
      _registeredTools?: Record<string, unknown>;
    };
    const registered = serverAny._registeredTools;
    toolCount = registered ? String(Object.keys(registered).length) : "unknown";
  } catch (err) {
    toolCount = `error: ${(err as Error).message}`;
  }

  const stateDir = defaultStateDir();
  const ownerTokenReady = await hasOwnerToken(stateDir);
  const intake = await checkIntakeAvailability();

  // Show the configured roots and what they resolve to. Without this the
  // only way to tell whether workspaces.txt was picked up is to start the
  // server and read its log.
  const configuredRoots = resolveWorkspaceRoots({ flags: {}, repeated: {} });
  const { entries: doctorRegistry, failedRoots } = await scanWorkspaces(configuredRoots);

  console.log(`node: ${nodeVersion}`);
  console.log(`ripgrep: ${rgVersion ?? "not found"}`);
  console.log(`git: ${gitVersion ?? "not found"}`);
  console.log(`workspace roots file: ${path.join(stateDir, WORKSPACES_FILE)}`);
  console.log(`workspace roots (${configuredRoots.length}):`);
  for (const root of configuredRoots) {
    const count = doctorRegistry.filter((e) => e.workspaceRoot === root).length;
    const failure = failedRoots.find((f) => f.root === root);
    console.log(`  - ${root}${failure ? "  [UNREADABLE]" : `  (${count} project(s))`}`);
  }
  console.log(`projects indexed: ${doctorRegistry.length}`);
  console.log(`cwd: ${workspacePath}`);
  console.log(`state dir: ${stateDir}`);
  console.log(`registered tools: ${toolCount}`);
  console.log(
    `http/oauth: owner token ${ownerTokenReady ? "configured" : "NOT SET — run `chatgpt2codex init` to generate one"}`,
  );
  console.log(`http default endpoint: http://127.0.0.1:7979/mcp (start via \`chatgpt2codex serve --http\`)`);
  console.log(
    `image intake: pngpaste ${intake.pngpasteAvailable ? "found" : "not found — clipboard image intake unavailable"}, ` +
      `~/Downloads ${intake.downloadsDirExists ? "found" : "NOT FOUND — download intake unavailable"}`,
  );
  console.log(
    "ChatGPT image app flow: open_chatgpt_images_app opens/prepares the first-party Images app; save_chatgpt_image imports from passed URL, copied URL, clipboard image, latest download, or path; " +
      "URL fetches remain SSRF-hardened (blocks loopback/private/link-local/metadata targets, re-validates redirects, 50MB/15s caps).",
  );
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const { command, flags, positional } = args;
  switch (command) {
    case "serve":
      await cmdServe(args);
      break;
    case "init":
      await cmdInit(args);
      break;
    case "doctor":
      await cmdDoctor();
      break;
    case "owner-token":
      await cmdOwnerToken(flags);
      break;
    case "control":
      await cmdControl(positional, flags);
      break;
    default:
      console.error(
        "usage: chatgpt2codex <serve|init|doctor|owner-token|control> [--workspace <path> ...] [--active-project-root <path>] [--stdio | --http [--port 7979] [--public-url <origin>]]\n" +
          "  --workspace may be repeated to register several workspace roots; CHATGPT2CODEX_WORKSPACES (one path per line) does the same.",
      );
      process.exitCode = 1;
  }
}

/**
 * Last-resort guards. Anything that escapes to here would otherwise kill the
 * process with a bare stack trace and — under a supervisor that restarts it —
 * turn a single recoverable fault into an endless restart loop. Reporting the
 * cause is what makes such a loop diagnosable instead of silent.
 */
process.on("uncaughtException", (err: unknown) => {
  console.error("chatgpt2codex: uncaught exception —", err instanceof Error ? (err.stack ?? err.message) : String(err));
  process.exitCode = 1;
});
process.on("unhandledRejection", (reason: unknown) => {
  console.error(
    "chatgpt2codex: unhandled promise rejection —",
    reason instanceof Error ? (reason.stack ?? reason.message) : String(reason),
  );
  process.exitCode = 1;
});

main().catch((err: unknown) => {
  console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
  process.exitCode = 1;
});
