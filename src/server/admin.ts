import { hostname, platform } from "node:os";
import { readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { urlencoded, type Express, type Request, type Response } from "express";
import type { SessionSummary, ToolContext } from "../types.js";
import { verifyOwnerToken } from "../auth/owner-token.js";
import type { SessionHistoryRecord } from "../state/session-history.js";
import { WorkQueue, type WorkItem } from "../state/work-queue.js";

/**
 * Owner-facing status surface: `/status.json` for machines and `/admin` for a
 * browser. Both are gated on the owner token — they expose the project list
 * and what each session is working on, and the server is normally published
 * through a public tunnel.
 *
 * `/admin` aggregates peers server-side rather than letting the page fetch
 * them: the browser never holds a peer's token, and there is no cross-origin
 * request to arrange.
 */

const PEERS_FILE = "peers.txt";
const ADMIN_COOKIE = "c2c_admin";
const PEER_TIMEOUT_MS = 4000;
const INSTANCE_NAME_FILE = "instance-name.txt";

/** How long after its last tool call a session still counts as working. A
 * model calling tools in sequence pauses for seconds; a person reading the
 * answer before typing again pauses for minutes. 90s sits between the two. */
const DEFAULT_ACTIVE_WINDOW_MS = 90_000;

/**
 * Read a duration from the environment, falling back on anything unusable.
 *
 * Both values this configures were picked from reasoning about how people and
 * models pause, not from measurement, so they are the settings most likely to
 * need adjusting on a machine that behaves differently. A typo in one of them
 * must not be able to switch the dashboard off — `ACTIVE_WINDOW_MS=abc` is a
 * mistake to ignore, not an instruction to treat every session as idle
 * forever.
 */
export function durationFromEnv(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed <= 0) return fallback;
  return parsed;
}

/** Refresh cadence for the dashboard. Shorter than the active window so a
 * session cannot cross from working to quiet without a redraw in between. */
const DASHBOARD_REFRESH_SECONDS = 30;

export type SessionActivityStatus = "active" | "idle";

/**
 * Values `localStatus` cannot derive from the store alone.
 *
 * `activity` is the important one. The `lastActiveAtMs` persisted in
 * sessions.json is written by `setSession`, whose only caller is
 * `project_select` — so a conversation that has spent an hour reading and
 * editing files still carries the timestamp of its first select. The
 * transport layer keeps an accurate one per request in memory; passing it in
 * here is what makes "working" mean working rather than "selected a project
 * recently". Injected rather than imported so admin does not reach into the
 * transport layer, and so tests can supply a fixed map.
 */
export interface AdminDeps {
  /** sessionKey -> last activity, epoch ms. */
  activity?: () => ReadonlyMap<string, number>;
  activeWindowMs?: number;
  now?: () => number;
  /** Sessions that have finished, most recent first. Injected like `activity`
   * so admin does not have to know where history is kept. */
  history?: () => Promise<SessionHistoryRecord[]>;
  /** Work waiting for, or in flight with, each project's worker. */
  queue?: () => Promise<WorkItem[]>;
}

export interface SlotView {
  slot: string;
  projectId: string | null;
  projectName: string | null;
  preset: string | null;
  mode: string;
  expiresAt: number | null;
  lastActiveAtMs: number;
  status: SessionActivityStatus;
}

export interface RootView {
  root: string;
  projectCount: number;
}

export interface InstanceStatus {
  instance: string;
  ok: true;
  platform: string;
  workspaceRoots: RootView[];
  projects: { projectId: string; name: string; root: string; workspaceRoot?: string }[];
  slots: SlotView[];
  maxSlots: number;
  generatedAt: number;
  /** Absent from peers running an older build; treated as empty. */
  history?: SessionHistoryRecord[];
  /** Pending and in-flight work per project. Absent on older peers. */
  queue?: WorkItem[];
}

export interface InstanceError {
  instance: string;
  ok: false;
  url: string;
  reason: string;
}

export interface Peer {
  name: string;
  url: string;
  tokenPath: string;
}

/**
 * Name shown for this server in the dashboard. Two machines otherwise expose
 * identically named tools and identically shaped project lists, so the label
 * is the only thing telling "the Mac" from "the Ubuntu box".
 *
 * The file is checked before the environment because the macOS build is
 * launched by a GUI app, which has no convenient place to set a variable. A
 * file in the state dir is edited the same way on both platforms; the env var
 * stays for systemd units, which set one naturally.
 */
export function instanceName(stateDir?: string): string {
  if (stateDir) {
    try {
      const fromFile = readFileSync(join(stateDir, INSTANCE_NAME_FILE), "utf8").trim();
      if (fromFile.length > 0) return fromFile.split("\n")[0]!.trim();
    } catch {
      // Not configured; fall through to the environment and then the hostname.
    }
  }
  const configured = process.env.CHATGPT2CODEX_INSTANCE_NAME?.trim();
  return configured && configured.length > 0 ? configured : hostname();
}

/**
 * Parse peers.txt. One peer per line:
 *
 *     name  https://host  /path/to/token
 *
 * Blank lines and `#` comments are ignored, matching workspaces.txt so there
 * is one config idiom to learn rather than two.
 */
export function parsePeers(text: string): Peer[] {
  const peers: Peer[] = [];
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    const parts = line.split(/\s+/);
    if (parts.length < 3) continue;
    const [name, url, tokenPath] = parts as [string, string, string];
    peers.push({ name, url: url.replace(/\/+$/, ""), tokenPath });
  }
  return peers;
}

export async function loadPeers(stateDir: string): Promise<Peer[]> {
  try {
    return parsePeers(await readFile(join(stateDir, PEERS_FILE), "utf8"));
  } catch {
    return [];
  }
}

function expandHome(p: string): string {
  if (!p.startsWith("~/")) return p;
  return join(process.env.HOME ?? "", p.slice(2));
}

/** Build this instance's own status. */
export async function localStatus(
  ctx: ToolContext,
  maxSlots: number,
  deps: AdminDeps = {},
): Promise<InstanceStatus> {
  const projects = ctx.registry.length > 0 ? ctx.registry : await ctx.store.loadProjects();
  const sessions: SessionSummary[] = (await ctx.store.listSessions?.()) ?? [];
  const now = deps.now?.() ?? Date.now();
  const activeWindowMs =
    deps.activeWindowMs ??
    durationFromEnv("CHATGPT2CODEX_ACTIVE_WINDOW_MS", DEFAULT_ACTIVE_WINDOW_MS);

  // A provider that throws must not take the dashboard down with it; falling
  // back to the stored timestamps degrades accuracy, not availability.
  let liveActivity: ReadonlyMap<string, number> | undefined;
  try {
    liveActivity = deps.activity?.();
  } catch {
    liveActivity = undefined;
  }

  const byId = new Map(projects.map((p) => [p.projectId, p]));
  const slots: SlotView[] = sessions
    .map((session) => {
      const lease = session.lease && session.lease.expiresAt >= now ? session.lease : null;
      // Sessions the transport layer does not track — stdio callers, or any
      // session at all right after a restart — fall back to the stored value
      // and read as idle until their next tool call.
      const lastActive = liveActivity?.get(session.sessionKey) ?? session.lastActiveAtMs;
      return {
        slot: session.slot,
        projectId: session.activeProjectId,
        projectName: session.activeProjectId
          ? (byId.get(session.activeProjectId)?.name ?? session.activeProjectId)
          : null,
        preset: lease?.preset ?? null,
        mode: session.mode,
        expiresAt: lease?.expiresAt ?? null,
        lastActiveAtMs: session.lastActiveAtMs,
        status: (now - lastActive < activeWindowMs ? "active" : "idle") as SessionActivityStatus,
      };
    })
    .sort((a, b) => a.slot.localeCompare(b.slot));

  const workspaceRoots: RootView[] = ctx.workspaceRoots.map((root) => ({
    root,
    projectCount: projects.filter((p) => p.workspaceRoot === root).length,
  }));

  // A history provider that fails must not take the dashboard with it: the
  // live half of the page is the half that matters.
  let history: SessionHistoryRecord[] = [];
  try {
    history = (await deps.history?.()) ?? [];
  } catch {
    history = [];
  }

  let queue: WorkItem[] = [];
  try {
    queue = (await deps.queue?.()) ?? [];
  } catch {
    queue = [];
  }

  return {
    instance: instanceName(ctx.stateDir),
    ok: true,
    platform: platform(),
    history,
    queue,
    workspaceRoots,
    projects: projects.map((p) => ({
      projectId: p.projectId,
      name: p.name,
      root: p.root,
      workspaceRoot: p.workspaceRoot,
    })),
    slots,
    maxSlots,
    generatedAt: now,
  };
}

/**
 * Fetch one peer's status.
 *
 * Never throws: a peer that is off, unreachable, or misconfigured must show
 * as one broken tile, not take the whole dashboard down with it.
 */
export async function fetchPeerStatus(peer: Peer): Promise<InstanceStatus | InstanceError> {
  const fail = (reason: string): InstanceError => ({
    instance: peer.name,
    ok: false,
    url: peer.url,
    reason,
  });

  let token: string;
  try {
    token = (await readFile(expandHome(peer.tokenPath), "utf8")).trim();
  } catch {
    return fail(`token file unreadable: ${peer.tokenPath}`);
  }
  if (token.length === 0) return fail("token file is empty");

  try {
    const response = await fetch(`${peer.url}/status.json`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(PEER_TIMEOUT_MS),
    });
    if (!response.ok) return fail(`HTTP ${response.status}`);
    const body = (await response.json()) as InstanceStatus;
    // Trust the peer for its own name but never for its reachability claim.
    return { ...body, ok: true, instance: body.instance || peer.name };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("timeout") || message.includes("abort")) return fail("timed out");
    // undici reports every connection-level failure as a bare "fetch failed",
    // which tells the owner nothing about what to check.
    if (message.includes("fetch failed")) return fail("unreachable — is it running?");
    return fail(message);
  }
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (key.length > 0) out[key] = decodeURIComponent(value);
  }
  return out;
}

/** Small fixed delay after a failed attempt. The owner token has plenty of
 * entropy, so this is only to make scripted guessing unattractive rather than
 * to carry the security argument. */
async function penalize(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 400));
}

function presentedToken(req: Request): string | undefined {
  const header = req.header("authorization");
  if (header?.startsWith("Bearer ")) return header.slice(7).trim();
  const cookie = parseCookies(req.header("cookie"))[ADMIN_COOKIE];
  if (cookie) return cookie;
  const query = req.query?.token;
  return typeof query === "string" ? query : undefined;
}

/**
 * Short-lived tokens tying a queue form to the browser session that was shown
 * it.
 *
 * The JSON endpoint takes a bearer header, which a cross-site page cannot set.
 * A form cannot send headers, so it authenticates with the dashboard cookie —
 * and a cookie is attached by any page that can make the browser navigate.
 * Without a token in the form body, a page the owner merely visited could
 * queue work on their behalf. Held in memory: they expire in minutes and
 * losing them on restart costs one refresh.
 */
const formTokens = new Map<string, number>();
const FORM_TOKEN_TTL_MS = 30 * 60 * 1000;
const MAX_FORM_TOKENS = 200;

function issueFormToken(): string {
  const now = Date.now();
  for (const [token, expiry] of formTokens) {
    if (expiry < now) formTokens.delete(token);
  }
  // Bounded so a page that is reloaded endlessly cannot grow this forever.
  while (formTokens.size >= MAX_FORM_TOKENS) {
    const oldest = formTokens.keys().next().value;
    if (oldest === undefined) break;
    formTokens.delete(oldest);
  }
  const token = randomUUID();
  formTokens.set(token, now + FORM_TOKEN_TTL_MS);
  return token;
}

function consumeFormToken(token: unknown): boolean {
  if (typeof token !== "string") return false;
  const expiry = formTokens.get(token);
  if (expiry === undefined) return false;
  formTokens.delete(token);
  return expiry >= Date.now();
}

export function registerAdminRoutes(
  app: Express,
  ctx: ToolContext,
  options: { maxSlots: number; secureCookies: boolean } & AdminDeps,
): void {
  async function requireOwner(req: Request, res: Response): Promise<boolean> {
    const candidate = presentedToken(req);
    if (candidate && (await verifyOwnerToken(ctx.stateDir, candidate))) return true;
    await penalize();
    res.status(401).json({ error: "unauthorized", error_description: "owner token required" });
    return false;
  }

  app.get("/status.json", async (req, res) => {
    if (!(await requireOwner(req, res))) return;
    res.json(await localStatus(ctx, options.maxSlots, options));
  });

  /**
   * Queue work for a project's worker.
   *
   * The only write surface on this server that is not a tool call. It exists
   * because a manager — a person at the dashboard or an agent holding the
   * owner token — has no other way to reach a ChatGPT conversation: MCP only
   * answers, so an instruction has to wait somewhere until a worker asks.
   *
   * Bearer-only, deliberately. The dashboard cookie is set by a top-level
   * navigation and would make this reachable from a page the owner merely
   * visited; requiring the header means a browser cannot be tricked into
   * queueing work on the owner's behalf.
   */
  /**
   * Same queueing action, reached from the dashboard form.
   *
   * Separate from the JSON endpoint because it authenticates differently: a
   * form cannot set an Authorization header, so this accepts the dashboard
   * cookie and demands a one-time token that only a page this server rendered
   * could carry. The JSON route stays bearer-only precisely so that it cannot
   * be reached by a browser at all.
   */
  // Only this route parses form bodies. The MCP app ships a JSON parser and
  // nothing else, and widening that globally would start accepting form posts
  // on endpoints that were never written to expect them.
  app.post("/admin/queue-form", urlencoded({ extended: false, limit: "16kb" }), async (req, res) => {
    const candidate = presentedToken(req);
    if (!candidate || !(await verifyOwnerToken(ctx.stateDir, candidate))) {
      await penalize();
      res.status(401).type("html").send(loginHtml());
      return;
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (!consumeFormToken(body.form_token)) {
      res.status(403).type("html").send(noticePage("이 양식은 만료되었습니다. 새로고침 후 다시 시도하세요."));
      return;
    }
    const projectId = typeof body.projectId === "string" ? body.projectId.trim() : "";
    const instruction = typeof body.instruction === "string" ? body.instruction.trim() : "";
    if (!projectId || !instruction) {
      res.status(400).type("html").send(noticePage("프로젝트와 지시 내용을 모두 입력하세요."));
      return;
    }
    const projects = ctx.registry.length > 0 ? ctx.registry : await ctx.store.loadProjects();
    if (!projects.some((p) => p.projectId === projectId)) {
      res.status(404).type("html").send(noticePage(`알 수 없는 프로젝트: ${projectId}`));
      return;
    }
    try {
      const item = await new WorkQueue(ctx.stateDir).enqueue(projectId, instruction);
      await ctx.ledger.append({ type: "work.queued", projectId, itemId: item.id }).catch(() => undefined);
    } catch (err) {
      res
        .status(409)
        .type("html")
        .send(noticePage(err instanceof Error ? err.message : "작업을 넣지 못했습니다."));
      return;
    }
    // Redirect after POST so a refresh does not resubmit the instruction.
    res.redirect(303, "/admin");
  });

  app.post("/admin/queue", async (req, res) => {
    const header = req.header("authorization");
    const bearer = header?.startsWith("Bearer ") ? header.slice(7).trim() : undefined;
    if (!bearer || !(await verifyOwnerToken(ctx.stateDir, bearer))) {
      await penalize();
      res.status(401).json({ error: "unauthorized", error_description: "owner token required" });
      return;
    }
    const body = (req.body ?? {}) as { projectId?: unknown; instruction?: unknown };
    const projectId = typeof body.projectId === "string" ? body.projectId.trim() : "";
    const instruction = typeof body.instruction === "string" ? body.instruction.trim() : "";
    if (!projectId || !instruction) {
      res.status(400).json({ error: "invalid_request", error_description: "projectId and instruction are required" });
      return;
    }
    // Refuse unknown projects here rather than letting the work sit in a queue
    // no worker will ever read.
    const projects = ctx.registry.length > 0 ? ctx.registry : await ctx.store.loadProjects();
    if (!projects.some((p) => p.projectId === projectId)) {
      res.status(404).json({ error: "unknown_project", error_description: `no project ${projectId}` });
      return;
    }
    try {
      const item = await new WorkQueue(ctx.stateDir).enqueue(projectId, instruction);
      await ctx.ledger
        .append({ type: "work.queued", projectId, itemId: item.id })
        .catch(() => undefined);
      res.status(201).json({ id: item.id, projectId: item.projectId, status: item.status });
    } catch (err) {
      res.status(409).json({
        error: "queue_rejected",
        error_description: err instanceof Error ? err.message : "could not queue work",
      });
    }
  });

  app.get("/admin", async (req, res) => {
    const candidate = presentedToken(req);
    if (!candidate || !(await verifyOwnerToken(ctx.stateDir, candidate))) {
      await penalize();
      res.status(401).type("html").send(loginHtml());
      return;
    }

    // Move the token out of the URL as soon as it is known good: a query
    // string lands in shell history, browser history, and any proxy log.
    if (typeof req.query?.token === "string") {
      res.cookie?.(ADMIN_COOKIE, candidate, {
        httpOnly: true,
        sameSite: "strict",
        secure: options.secureCookies,
        maxAge: 12 * 3600 * 1000,
      });
      res.redirect("/admin");
      return;
    }

    const peers = await loadPeers(ctx.stateDir);
    const peerResults = await Promise.all(peers.map((peer) => fetchPeerStatus(peer)));
    const instances = [await localStatus(ctx, options.maxSlots, options), ...peerResults];
    const projects = ctx.registry.length > 0 ? ctx.registry : await ctx.store.loadProjects();
    res.type("html").send(
      renderDashboard(instances, {
        formToken: issueFormToken(),
        projects: projects.map((p) => ({ projectId: p.projectId, name: p.name })),
      }),
    );
  });
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function esc(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const STYLE = `
:root{color-scheme:dark;--bg:#0d1117;--panel:#161b22;--line:#30363d;--fg:#e6edf3;--dim:#8b949e;--accent:#2f81f7;--ok:#3fb950;--warn:#d29922;--err:#f85149}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.5 ui-sans-serif,-apple-system,"Segoe UI",sans-serif}
header{padding:16px 24px;border-bottom:1px solid var(--line);display:flex;align-items:baseline;gap:16px}
h1{font-size:15px;margin:0;font-weight:600}
.sub{color:var(--dim);font-size:12px}
main{padding:24px;display:flex;flex-direction:column;gap:24px}
.inst{border:1px solid var(--line);border-radius:10px;background:var(--panel);overflow:hidden}
.inst>h2{margin:0;padding:12px 16px;font-size:13px;font-weight:600;border-bottom:1px solid var(--line);display:flex;gap:10px;align-items:center}
.badge{font-size:11px;padding:1px 7px;border-radius:999px;border:1px solid var(--line);color:var(--dim);font-weight:400}
.tiles{display:flex;gap:0;border-bottom:1px solid var(--line);flex-wrap:wrap}
.tile{padding:12px 16px;border-right:1px solid var(--line);min-width:130px}
.tile .k{color:var(--dim);font-size:11px;text-transform:uppercase;letter-spacing:.04em}
.tile .v{font-size:20px;font-weight:600;margin-top:2px}
table{width:100%;border-collapse:collapse;font-size:13px}
th{text-align:left;color:var(--dim);font-weight:500;font-size:11px;text-transform:uppercase;letter-spacing:.04em;padding:8px 16px;border-bottom:1px solid var(--line)}
td{padding:8px 16px;border-bottom:1px solid #21262d}
tr:last-child td{border-bottom:0}
.slot{font-family:ui-monospace,monospace;color:var(--accent)}
.pill{font-size:11px;padding:1px 7px;border-radius:999px;border:1px solid var(--line)}
.pill.w{color:var(--warn);border-color:#5c4813}
.pill.r{color:var(--dim)}
.pill.a{color:var(--ok);border-color:#1f6f34}
.done{color:var(--dim);font-size:12px;white-space:nowrap}
.qform{display:flex;gap:8px;padding:12px 16px;flex-wrap:wrap}
.qform select,.qform input{background:var(--bg);color:var(--fg);border:1px solid var(--line);border-radius:6px;padding:6px 10px;font:13px/1.4 inherit}
.qform input{flex:1;min-width:220px}
.qform button{background:var(--accent);color:#fff;border:0;border-radius:6px;padding:6px 14px;font:13px/1.4 inherit;cursor:pointer}
.empty{padding:16px;color:var(--dim);font-size:13px}
.err{border-color:#5c1e1c}
.err>h2{color:var(--err)}
code{font-family:ui-monospace,monospace;color:var(--dim);font-size:12px}
`;

/**
 * How a session is named in the table: the project it holds, with its slot
 * kept alongside.
 *
 * The slot alone (`W01`) says nothing about what the conversation is doing,
 * and the project alone cannot separate two windows open on the same one.
 * Keeping both also preserves the thread to error messages, which cite the
 * slot when refusing a write — PROJECT_LOCKED names the holder that way.
 */
export function sessionLabel(slot: SlotView): string {
  return slot.projectName ? `${slot.projectName} (${slot.slot})` : `(${slot.slot})`;
}

function slotRows(status: InstanceStatus): string {
  if (status.slots.length === 0) {
    return `<div class="empty">연결된 세션이 없습니다. ChatGPT 대화창을 열면 여기에 슬롯이 나타납니다.</div>`;
  }
  const rows = status.slots
    .map((slot) => {
      const writing = slot.preset === "full-write";
      const preset = slot.preset
        ? `<span class="pill ${writing ? "w" : "r"}">${esc(slot.preset)}</span>`
        : `<span class="pill r">no lease</span>`;
      const until = slot.expiresAt
        ? new Date(slot.expiresAt).toISOString().slice(11, 16) + " UTC"
        : "—";
      // Carries the word, not just the colour: the two states have to be
      // distinguishable without seeing the difference between green and grey.
      const activity =
        slot.status === "active"
          ? `<span class="pill a">진행중</span>`
          : `<span class="pill r">대기</span>`;
      return `<tr>
        <td class="slot">${esc(sessionLabel(slot))}</td>
        <td>${activity}</td>
        <td>${preset}</td>
        <td><code>${esc(slot.mode)}</code></td>
        <td><code>${esc(until)}</code></td>
      </tr>`;
    })
    .join("");
  return `<table><thead><tr><th>세션</th><th>상태</th><th>권한</th><th>모드</th><th>만료</th></tr></thead><tbody>${rows}</tbody></table>`;
}

/**
 * Recently finished sessions.
 *
 * The delay is stated rather than hidden: a closed conversation is only swept
 * once its transport is gone, so an entry can take up to the session TTL to
 * appear. Without that line the area reads as broken for half an hour.
 */
function historyRow(status: InstanceStatus): string {
  const history = status.history ?? [];
  if (history.length === 0) {
    return `<div class="empty">최근 완료된 작업이 없습니다.</div>`;
  }
  const items = history
    .slice(0, 8)
    .map((rec) => {
      const at = new Date(rec.endedAt).toISOString().slice(11, 16);
      const label = rec.projectName ? `${rec.projectName} (${rec.slot})` : `(${rec.slot})`;
      return `<span class="done">${esc(label)} <code>${esc(at)} UTC</code></span>`;
    })
    .join(" &nbsp;·&nbsp; ");
  return `<div class="empty">최근 완료 &nbsp; ${items}</div>`;
}

/**
 * Work the manager has queued for each project's worker.
 *
 * Delivered items stay visible rather than disappearing on handover: an
 * instruction that vanished the moment a worker picked it up would look
 * identical to one that was never sent.
 */
function queueRow(status: InstanceStatus): string {
  const queue = status.queue ?? [];
  if (queue.length === 0) return "";
  const items = queue
    .slice(0, 8)
    .map((item) => {
      const cls = item.status === "delivered" ? "pill w" : "pill r";
      const label = item.status === "delivered" ? "진행 지시됨" : "대기";
      return `<span class="done"><span class="${cls}">${label}</span> ${esc(item.projectId)} — ${esc(
        item.instruction.slice(0, 60),
      )}</span>`;
    })
    .join(" &nbsp;·&nbsp; ");
  return `<div class="empty">작업 지시 &nbsp; ${items}</div>`;
}

function instanceCard(status: InstanceStatus | InstanceError): string {
  if (!status.ok) {
    return `<section class="inst err">
      <h2>${esc(status.instance)} <span class="badge">연결 안 됨</span></h2>
      <div class="empty">${esc(status.reason)} · <code>${esc(status.url)}</code></div>
    </section>`;
  }

  const active = status.slots.filter((s) => s.preset !== null).length;
  const writing = status.slots.filter((s) => s.preset === "full-write").length;
  const roots = status.workspaceRoots
    .map((root) => `<code>${esc(root.root)}</code> (${root.projectCount})`)
    .join(" &nbsp;·&nbsp; ");

  return `<section class="inst">
    <h2>${esc(status.instance)} <span class="badge">${esc(status.platform)}</span></h2>
    <div class="tiles">
      <div class="tile"><div class="k">활성 슬롯</div><div class="v">${active}/${status.maxSlots}</div></div>
      <div class="tile"><div class="k">편집 중</div><div class="v">${writing}</div></div>
      <div class="tile"><div class="k">전체 프로젝트</div><div class="v">${status.projects.length}</div></div>
      <div class="tile"><div class="k">워크스페이스</div><div class="v">${status.workspaceRoots.length}</div></div>
    </div>
    ${slotRows(status)}
    ${queueRow(status)}
    ${historyRow(status)}
    <div class="empty">${roots || "등록된 워크스페이스 루트가 없습니다."}</div>
  </section>`;
}

/** Form for queueing work, shown only when the page can supply a token. */
/** Small page for a rejected form submission, with a way back. */
function noticePage(message: string): string {
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>chatgpt2codex</title><style>${STYLE}</style></head>
<body><main><section class="inst">
  <h2>작업 지시</h2>
  <div class="empty">${esc(message)}</div>
  <div class="empty"><a href="/admin" style="color:var(--accent)">대시보드로 돌아가기</a></div>
</section></main></body></html>`;
}

function queueForm(projects: { projectId: string; name: string }[], formToken?: string): string {
  if (!formToken || projects.length === 0) return "";
  const options = projects
    .map((p) => `<option value="${esc(p.projectId)}">${esc(p.name)}</option>`)
    .join("");
  return `<section class="inst">
    <h2>작업 지시</h2>
    <form method="post" action="/admin/queue-form" class="qform">
      <input type="hidden" name="form_token" value="${esc(formToken)}" />
      <select name="projectId" aria-label="프로젝트">${options}</select>
      <input name="instruction" placeholder="이 프로젝트의 담당 창에 보낼 지시" maxlength="4000" required />
      <button type="submit">보내기</button>
    </form>
  </section>`;
}

export function renderDashboard(
  instances: (InstanceStatus | InstanceError)[],
  options: { formToken?: string; projects?: { projectId: string; name: string }[] } = {},
): string {
  const generated = new Date().toISOString().slice(0, 19).replace("T", " ");
  // Refresh through a meta tag rather than a script. The page is served under
  // `script-src 'self'`, which blocks inline scripts outright — the setTimeout
  // this replaces never ran once, so the "30초마다 갱신" in the header was a
  // claim the page could not keep.
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="${DASHBOARD_REFRESH_SECONDS}">
<title>chatgpt2codex</title><style>${STYLE}</style></head>
<body>
<header><h1>chatgpt2codex</h1><span class="sub">${esc(generated)} UTC · ${DASHBOARD_REFRESH_SECONDS}초마다 갱신</span></header>
<main>${queueForm(options.projects ?? [], options.formToken)}${instances.map(instanceCard).join("")}</main>
</body></html>`;
}

function loginHtml(): string {
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8">
<title>chatgpt2codex</title><style>${STYLE}</style></head>
<body><header><h1>chatgpt2codex</h1></header>
<main><section class="inst"><h2>인증 필요</h2>
<div class="empty">오너 토큰이 필요합니다. <code>/admin?token=&lt;owner token&gt;</code> 로 여시면
토큰은 쿠키로 옮겨지고 주소창에서 지워집니다.</div></section></main></body></html>`;
}
