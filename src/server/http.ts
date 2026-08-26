import { createHash, randomUUID } from "node:crypto";
import type { Express, Request, Response } from "express";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import {
  createOAuthMetadata,
  getOAuthProtectedResourceMetadataUrl,
  mcpAuthRouter,
} from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { checkResourceAllowed, resourceUrlFromServerUrl } from "@modelcontextprotocol/sdk/shared/auth-utils.js";
import type { ToolContext } from "../types.js";
import { STDIO_SESSION_KEY } from "../types.js";
import { createServer as createMcpServer } from "./mcp-server.js";
import { SingleUserOAuthProvider, type OAuthConfig } from "../auth/oauth-provider.js";
import { verifyOwnerToken } from "../auth/owner-token.js";
import { registerActionRoutes } from "./actions.js";
import { registerAdminRoutes, durationFromEnv } from "./admin.js";
import { SessionHistory, DEFAULT_RETENTION_MS } from "../state/session-history.js";
import { WorkQueue } from "../state/work-queue.js";

/**
 * HTTP + OAuth 2.1 transport gateway (PRD §4 Transport Gateway, §5 CLI,
 * §7 auth, §11 SR-05/SR-12) exposing the SAME 15 tools that serve over
 * stdio (src/server/mcp-server.ts / registerTools) over a Streamable HTTP
 * `/mcp` endpoint, so ChatGPT (web) can connect over a public HTTPS tunnel.
 *
 * Does not alter or remove the stdio transport path in src/cli.ts.
 */

export interface HttpServerConfig {
  /** Bind host, default 127.0.0.1 (loopback only unless overridden). */
  host: string;
  /** Bind port, default 7979 (PRD §5). */
  port: number;
  /** Public origin ChatGPT/clients will reach this server at, e.g.
   * https://my-tunnel.example.com. Used as the OAuth issuer/resource base
   * and to derive the allowed Origin/Host for DNS-rebinding defense. */
  publicUrl: string;
  /** Extra hostnames to allow in the Host header allowlist (SR-12), beyond
   * the host derived from publicUrl and standard loopback aliases. */
  extraAllowedHosts?: string[];
  oauth: {
    accessTokenTtlSeconds: number;
    refreshTokenTtlSeconds: number;
    scopes: string[];
    allowedRedirectHosts: string[];
  };
  /** Idle TTL for a session transport before it is evicted (NFR-03). */
  sessionTtlMs: number;
  /** Hard cap on concurrently tracked session transports (SR-09/NFR-03). */
  maxSessions: number;
  /** Optional process-level idle shutdown when no MCP sessions are active. */
  idleShutdownMs?: number;
  /** Called once after idleShutdownMs elapses with no active MCP sessions. */
  onIdleTimeout?: () => void;
}

export function defaultHttpServerConfig(overrides: Partial<HttpServerConfig> = {}): HttpServerConfig {
  return {
    host: "127.0.0.1",
    port: 7979,
    publicUrl: "http://127.0.0.1:7979",
    oauth: {
      // An hour meant a connector left overnight — or over lunch — depended on
      // a refresh succeeding before it could do anything, which put every
      // rotation edge case directly in the owner's way. Twelve hours keeps the
      // credential short-lived while making refresh the exception.
      accessTokenTtlSeconds: 12 * 3600,
      refreshTokenTtlSeconds: 30 * 24 * 3600,
      scopes: ["chatgpt2codex"],
      allowedRedirectHosts: ["chatgpt.com", "chat.openai.com"],
    },
    sessionTtlMs: 30 * 60 * 1000,
    maxSessions: 100,
    ...overrides,
  };
}

interface TrackedSession {
  transport: StreamableHTTPServerTransport;
  lastActiveAtMs: number;
}

function sendJsonRpcError(res: Response, status: number, code: number, message: string): void {
  res.status(status).json({ jsonrpc: "2.0", error: { code, message }, id: null });
}

function hashAuditValue(value: string): string {
  return createHash("sha256").update(value).digest("base64url");
}

const TRUSTED_CHATGPT_ORIGINS = ["https://chatgpt.com", "https://chat.openai.com"] as const;

/** Native MCP clients (Codex CLI, desktop apps) register a loopback
 * redirect_uri per RFC 8252, so the approval form redirects to 127.0.0.1.
 * form-action is enforced across that redirect, and without these origins the
 * browser drops the submission with no visible error: the approve button
 * looks dead. */
const LOOPBACK_FORM_ACTION_ORIGINS = ["http://127.0.0.1:*", "http://localhost:*"] as const;
const OWNER_TOKEN_TOGGLE_SCRIPT = `
(() => {
  const input = document.getElementById("owner_token");
  const toggle = document.getElementById("owner_token_toggle");
  if (!(input instanceof HTMLInputElement) || !(toggle instanceof HTMLButtonElement)) return;

  const showLabel = toggle.dataset.labelShow || "Show owner token";
  const hideLabel = toggle.dataset.labelHide || "Hide owner token";
  const setVisible = (visible) => {
    input.type = visible ? "text" : "password";
    toggle.setAttribute("aria-pressed", String(visible));
    toggle.setAttribute("aria-label", visible ? hideLabel : showLabel);
  };

  toggle.addEventListener("click", () => setVisible(input.type === "password"));
  setVisible(false);
})();
`.trimStart();

/** SR-12: strict security headers applied to every response. The OAuth HTML
 * form is intentionally frameable by ChatGPT because connector authorization
 * may be shown inside ChatGPT's web UI. */
function securityHeaders(_req: Request, res: Response, next: () => void): void {
  res.setHeader(
    "Content-Security-Policy",
    [
      "default-src 'none'",
      "base-uri 'none'",
      "script-src 'self'",
      `form-action 'self' ${[...TRUSTED_CHATGPT_ORIGINS, ...LOOPBACK_FORM_ACTION_ORIGINS].join(" ")}`,
      `frame-ancestors 'self' ${TRUSTED_CHATGPT_ORIGINS.join(" ")}`,
      "style-src 'unsafe-inline'",
    ].join("; "),
  );
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  next();
}

/** SR-05/SR-12: reject cross-origin browser requests to /mcp and the OAuth
 * endpoints whose Origin header does not match the configured public origin
 * or a loopback origin. Non-browser clients (no Origin header, e.g. the
 * ChatGPT backend or curl) are unaffected — Origin is only ever sent by
 * browsers, so this only closes the browser/DNS-rebinding attack surface. */
function makeOriginAllowlist(allowedOrigins: Set<string>) {
  return function originAllowlist(req: Request, res: Response, next: () => void): void {
    if (isOAuthBrowserFlowPath(req.path)) {
      next();
      return;
    }
    const origin = req.header("origin");
    if (!origin) {
      next();
      return;
    }
    if (allowedOrigins.has(origin)) {
      next();
      return;
    }
    sendJsonRpcError(res, 403, -32000, "Origin not allowed");
  };
}

function isOAuthBrowserFlowPath(pathName: string): boolean {
  return (
    pathName === "/authorize" ||
    pathName.startsWith("/authorize/") ||
    pathName === "/token" ||
    pathName.startsWith("/token/") ||
    pathName === "/register" ||
    pathName.startsWith("/register/") ||
    pathName === "/revoke" ||
    pathName.startsWith("/revoke/") ||
    pathName.startsWith("/.well-known/")
  );
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Explains an unrecognized client_id in terms of the action that fixes it,
 * instead of the SDK's bare {"error":"invalid_client"} JSON. */
function unknownClientPage(clientId: string, origin: string): string {
  return `<!doctype html>
<html lang="en" dir="ltr">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Connector needs to be re-added</title>
    <style>
      :root { color-scheme: light dark; }
      body { margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center;
             padding:28px 16px; background:#eef3f8; color:#172033;
             font-family: Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
      main { width:min(620px,100%); }
      .panel { padding:clamp(22px,4vw,32px); border:1px solid #d7dee9; border-radius:14px; background:#fff; }
      h1 { margin:0 0 6px; font-size:20px; }
      p { line-height:1.6; margin:12px 0; }
      ol { line-height:1.8; padding-left:20px; }
      code { background:#f1f5f9; padding:2px 6px; border-radius:5px; font-size:13px; word-break:break-all; }
      .muted { color:#5b6779; font-size:13px; }
      @media (prefers-color-scheme: dark) {
        body { background:#0f172a; color:#e2e8f0; }
        .panel { background:#111c33; border-color:#25324a; }
        code { background:#1c2a44; }
        .muted { color:#94a3b8; }
      }
    </style>
  </head>
  <body>
    <main>
      <div class="panel">
        <h1>This connector needs to be re-added</h1>
        <p>
          The client this authorization came from is not registered on this
          chatgpt2codex server, so the request cannot be approved.
        </p>
        <p class="muted">Unrecognized client_id: <code>${escapeHtml(clientId)}</code></p>
        <p>
          This happens when the connector was registered against an earlier
          setup: the client id your MCP client cached no longer exists here.
          Registering again is the fix — it takes a few seconds.
        </p>
        <ol>
          <li>Open your MCP client's connector settings (in ChatGPT: Settings → Connectors).</li>
          <li><strong>Delete</strong> the existing chatgpt2codex connector.</li>
          <li>Add it again using <code>${escapeHtml(origin)}/mcp</code>.</li>
          <li>Approve with your Owner Token when prompted.</li>
        </ol>
        <p class="muted">
          Editing the existing connector is not enough — registration only
          happens when a connector is created, so it has to be removed and
          added back.
        </p>
      </div>
    </main>
  </body>
</html>`;
}

export interface RunningHttpServer {
  app: Express;
  config: HttpServerConfig;
  close(): void;
}

export function createHttpServer(ctx: ToolContext, config: HttpServerConfig): RunningHttpServer {
  const publicUrl = new URL(config.publicUrl);
  const mcpUrl = new URL("/mcp", publicUrl);
  const resourceServerUrl = resourceUrlFromServerUrl(mcpUrl);

  const loopbackHosts = ["127.0.0.1", "localhost", "[::1]", "::1"];
  const allowedHostnames = Array.from(
    new Set([publicUrl.hostname, ...loopbackHosts, ...(config.extraAllowedHosts ?? [])]),
  );
  // createMcpExpressApp's DNS-rebinding middleware matches Host headers
  // against this list; include host:port forms too since browsers/clients
  // typically send `Host: host:port`.
  const allowedHostHeaders = Array.from(
    new Set([
      ...allowedHostnames,
      `${publicUrl.hostname}:${publicUrl.port || (publicUrl.protocol === "https:" ? "443" : "80")}`,
      `127.0.0.1:${config.port}`,
      `localhost:${config.port}`,
    ]),
  );

  const app = createMcpExpressApp({
    host: config.host,
    allowedHosts: allowedHostHeaders,
  });
  // Cloudflare tunnels terminate on loopback and forward X-Forwarded-For; trust
  // only loopback proxies so express-rate-limit keys clients without warning.
  app.set("trust proxy", "loopback");
  app.use(securityHeaders);

  const allowedOrigins = new Set<string>([
    publicUrl.origin,
    `http://127.0.0.1:${config.port}`,
    `http://localhost:${config.port}`,
    ...TRUSTED_CHATGPT_ORIGINS,
  ]);
  app.use(makeOriginAllowlist(allowedOrigins));

  const oauthConfig: OAuthConfig = {
    verifyOwnerToken: (candidate) => verifyOwnerToken(ctx.stateDir, candidate),
    accessTokenTtlSeconds: config.oauth.accessTokenTtlSeconds,
    refreshTokenTtlSeconds: config.oauth.refreshTokenTtlSeconds,
    scopes: config.oauth.scopes,
    allowedRedirectHosts: config.oauth.allowedRedirectHosts,
    onOwnerTokenAttempt: (event) =>
      ctx.ledger.append({
        type: "oauth.owner_token_attempt",
        outcome: event.outcome,
        clientIpHash: hashAuditValue(event.clientIp),
        clientIdHash: hashAuditValue(event.clientId),
        hasClientName: event.clientName !== undefined,
      }),
    // client_id is recorded in the clear here, unlike the owner-token attempt
    // above. That one logs failures from unauthenticated callers, where the id
    // is attacker-supplied; these are grants against registered clients, and
    // the id is already sitting in oauth.json — hashing it would only stop the
    // owner from matching a rejection to the connector that caused it.
    onTokenEvent: (event) =>
      ctx.ledger.append({
        type: `oauth.token.${event.outcome}`,
        grant: event.grant,
        clientId: event.clientId,
        reason: event.reason,
        resource: event.resource,
        expiredForSeconds: event.expiredForSeconds,
        withinGrace: event.withinGrace,
      }),
  };
  const oauthProvider = new SingleUserOAuthProvider(oauthConfig, mcpUrl, ctx.stateDir);
  const oauthMetadata = createOAuthMetadata({
    provider: oauthProvider,
    issuerUrl: publicUrl,
    baseUrl: publicUrl,
    scopesSupported: config.oauth.scopes,
  });
  const bearerAuth = requireBearerAuth({
    verifier: oauthProvider,
    requiredScopes: [config.oauth.scopes[0] ?? "chatgpt2codex"],
    resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(resourceServerUrl),
  });

  // An MCP client performs dynamic registration once, when its connector is
  // created, and caches the client_id from then on. If that registration is
  // no longer on file — an older build wiped registrations whenever the owner
  // token was rotated, and state can also be reset or moved — every later
  // /authorize fails deep inside the SDK with a bare
  // {"error":"invalid_client"} JSON body. That tells the owner nothing about
  // the one thing that fixes it, so answer it here with a page that does.
  app.get("/authorize", (req, res, next) => {
    const clientId = typeof req.query.client_id === "string" ? req.query.client_id : undefined;
    if (!clientId) {
      next();
      return;
    }
    void Promise.resolve(oauthProvider.clientsStore.getClient(clientId))
      .then((client) => {
        if (client) {
          next();
          return;
        }
        res.status(400).type("html").send(unknownClientPage(clientId, publicUrl.origin));
      })
      .catch(() => next());
  });

  app.use(
    mcpAuthRouter({
      provider: oauthProvider,
      issuerUrl: publicUrl,
      baseUrl: publicUrl,
      resourceServerUrl,
      scopesSupported: config.oauth.scopes,
      resourceName: "chatgpt2codex",
    }),
  );

  app.get("/assets/owner-token-toggle.js", (_req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.type("application/javascript").send(OWNER_TOKEN_TOGGLE_SCRIPT);
  });

  app.get("/.well-known/openid-configuration", (_req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Cache-Control", "no-store");
    res.json(oauthMetadata);
  });

  app.get("/healthz", (_req, res) => {
    res.json({ ok: true, name: "chatgpt2codex" });
  });

  // Owner-only status surface. Registered here rather than behind the MCP
  // bearer middleware because the dashboard is opened by a browser, which
  // cannot set an Authorization header on a top-level navigation.
  registerAdminRoutes(app, ctx, {
    maxSlots: config.maxSessions,
    secureCookies: publicUrl.protocol === "https:",
    // Snapshot rather than the live map: the dashboard reads activity, it has
    // no business holding a handle to transport state it could mutate.
    activity: () => new Map([...sessions].map(([id, tracked]) => [id, tracked.lastActiveAtMs])),
    history: () => sessionHistory.list(),
    queue: () => new WorkQueue(ctx.stateDir).boardItems(),
  });

  app.get("/privacy", (_req, res) => {
    res
      .type("text/plain")
      .send(
        [
          "chatgpt2codex privacy notice",
          "",
          "chatgpt2codex is a local MCP/action bridge controlled by the owner of this server.",
          "Custom GPT Actions sent to this server are used only to select local projects, save/import ChatGPT images, list saved images, and check action status.",
          "The server stores operational audit entries and saved image files on the owner's local machine. It does not sell data, run advertising profiles, or call OpenAI Images/Codex APIs to generate images.",
          "Do not send secrets or unrelated personal data to this action bridge.",
        ].join("\n"),
      );
  });

  registerActionRoutes(app, ctx, publicUrl);

  // Per-session transport map with TTL + hard cap (NFR-03/SR-09): every
  // initialize request creates one transport, keyed by MCP session id.
  // Idle sessions are swept on a timer; the map never grows unbounded even
  // under a client that never sends a clean close.
  const sessions = new Map<string, TrackedSession>();
  let lastSessionActivityAtMs = Date.now();
  let idleShutdownQueued = false;

  function evictOldestSession(): void {
    let oldestId: string | undefined;
    let oldestAt = Infinity;
    for (const [id, session] of sessions) {
      if (session.lastActiveAtMs < oldestAt) {
        oldestAt = session.lastActiveAtMs;
        oldestId = id;
      }
    }
    if (oldestId) {
      sessions.get(oldestId)?.transport.close();
      sessions.delete(oldestId);
    }
  }

  // No transport from a previous process can still be live, so any session
  // left in sessions.json is stale. Clearing them at startup stops a write
  // lease that outlived a crash from locking the owner out of their own
  // project until it expired.
  const sessionHistory = new SessionHistory(
    ctx.stateDir,
    durationFromEnv("CHATGPT2CODEX_HISTORY_RETENTION_MS", DEFAULT_RETENTION_MS),
  );

  async function reclaimAbandonedWork(heldProjectIds?: ReadonlySet<string>): Promise<void> {
    const revived = await new WorkQueue(ctx.stateDir).requeueAbandoned(
      config.sessionTtlMs,
      Date.now(),
      heldProjectIds,
    );
    if (revived.length === 0) return;
    await ctx.ledger.append({
      type: "work.requeued",
      count: revived.length,
      projectIds: [...new Set(revived.map((i) => i.projectId))],
    });
  }

  // Startup clears whatever a previous process left behind. Those sessions did
  // not finish here, and recording them would file a batch of phantom entries
  // every time the server restarts. Work they were holding is also ownerless
  // now — no previous-process transport can still be live — so try to free it.
  void (async () => {
    await ctx.store.sweepSessions?.(null);
    await reclaimAbandonedWork();
  })().catch(() => undefined);

  const sweepInterval = setInterval(() => {
    const now = Date.now();
    for (const [id, session] of sessions) {
      if (now - session.lastActiveAtMs > config.sessionTtlMs) {
        session.transport.close();
        sessions.delete(id);
      }
    }
    // Keep persisted leases in step with live transports: a session that went
    // away without a clean close must not keep holding its project.
    void (async () => {
      // Read before sweeping: once the entries are gone their slot and project
      // are gone with them, and those are the only parts worth showing.
      const before = (await ctx.store.listSessions?.()) ?? [];
      const removed = (await ctx.store.sweepSessions?.([...sessions.keys()])) ?? [];
      const gone = new Set(removed);
      if (removed.length > 0) {
        await sessionHistory.record(
          before
            .filter((s) => gone.has(s.sessionKey))
            .map((s) => ({
              slot: s.slot,
              projectName: s.activeProjectId,
              lastActiveAtMs: s.lastActiveAtMs,
            })),
        );
        // Which sessions the sweep reclaimed, and therefore which leases were
        // released without anyone asking. Reconstructing that from timestamps
        // is what made the last lease incident an inference exercise.
        await ctx.ledger.append({ type: "session.swept", sessionKeys: removed, count: removed.length });
      }

      // Reclaim is not tied to this tick having removed a session. A window
      // that closed minutes ago already dropped its lease on the first sweep,
      // well before the delivery grace; later ticks must still try, or the
      // item stays delivered forever.
      const held = new Set(
        before
          .filter((s) => !gone.has(s.sessionKey))
          .map((s) => s.activeProjectId)
          .filter((id): id is string => id != null),
      );
      await reclaimAbandonedWork(held);
    })().catch(() => undefined);
    if (
      config.idleShutdownMs !== undefined &&
      config.idleShutdownMs > 0 &&
      sessions.size === 0 &&
      now - lastSessionActivityAtMs > config.idleShutdownMs &&
      !idleShutdownQueued
    ) {
      idleShutdownQueued = true;
      setImmediate(() => config.onIdleTimeout?.());
    }
  }, Math.min(config.sessionTtlMs, config.idleShutdownMs ?? 60_000, 60_000));
  sweepInterval.unref();

  app.all("/mcp", async (req, res) => {
    const sessionId = req.header("mcp-session-id");
    const initializeRequest = req.method === "POST" && isInitializeRequest(req.body);

    await new Promise<void>((resolve, reject) => {
      bearerAuth(req, res, (error?: unknown) => {
        if (error) reject(error);
        else resolve();
      });
    }).catch(() => undefined);
    if (res.headersSent) return;

    if (
      !req.auth?.resource ||
      !checkResourceAllowed({ requestedResource: req.auth.resource, configuredResource: resourceServerUrl })
    ) {
      sendJsonRpcError(res, 401, -32001, "Unauthorized");
      return;
    }

    try {
      let transport: StreamableHTTPServerTransport | undefined;

      if (sessionId) {
        const tracked = sessions.get(sessionId);
        if (!tracked) {
          sendJsonRpcError(res, 404, -32000, "Unknown MCP session");
          return;
        }
        tracked.lastActiveAtMs = Date.now();
        lastSessionActivityAtMs = tracked.lastActiveAtMs;
        transport = tracked.transport;
      } else if (initializeRequest) {
        if (sessions.size >= config.maxSessions) evictOldestSession();

        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (newSessionId) => {
            if (transport) {
              lastSessionActivityAtMs = Date.now();
              sessions.set(newSessionId, { transport, lastActiveAtMs: lastSessionActivityAtMs });
            }
            // The only point where the id exists and the session is new. It is
            // assigned during handleRequest, which runs after connect(), so
            // anything logged earlier names a session with no session id.
            void ctx.ledger
              .append({
                type: "session.opened",
                sessionKey: newSessionId,
                clientId: req.auth?.clientId,
                transport: "http",
              })
              .catch(() => undefined);
          },
        });

        transport.onclose = () => {
          const closedSessionId = transport?.sessionId;
          if (closedSessionId) sessions.delete(closedSessionId);
          void ctx.ledger
            .append({
              type: "session.closed",
              sessionKey: closedSessionId,
              clientId: req.auth?.clientId,
            })
            .catch(() => undefined);
        };

        // Mark this session remote: it's how ChatGPT (and any other network
        // MCP client) connects, so project_select preset=control must be
        // refused here even when the desktop-control tools are exposed to
        // ChatGPT (see src/server/tools.ts project_select handler /
        // isControlChatGptExposed) — lease arming stays local-only (stdio).
        //
        // sessionKey is a getter because the transport only receives its id
        // during initialize, which happens after connect() below. Every tool
        // call arrives later still, so by the time anything reads this the id
        // is populated; binding the value eagerly here would capture
        // undefined and collapse all sessions back onto one shared lease.
        // Captured at initialize, when the bearer has just been verified. The
        // session id can change under a reconnect; this does not, which is
        // what lets a returning connector reclaim its own lease.
        const authClientId = req.auth?.clientId;
        const sessionScopedCtx: ToolContext = {
          ...ctx,
          remote: true,
          clientId: authClientId,
          // Stamp every event this session emits with who emitted it. Done
          // here rather than at each of the thirty append sites so no future
          // event can forget, and so the identity cannot drift between them.
          ledger: {
            append: (event) =>
              ctx.ledger.append({
                ...event,
                sessionKey: transport?.sessionId,
                clientId: authClientId,
              }),
          },
          get sessionKey(): string {
            return transport?.sessionId ?? STDIO_SESSION_KEY;
          },
        };
        const mcpServer = await createMcpServer(sessionScopedCtx);
        await mcpServer.connect(transport);

      } else {
        sendJsonRpcError(res, 400, -32000, "No valid MCP session");
        return;
      }

      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      if (!res.headersSent) {
        sendJsonRpcError(res, 500, -32603, error instanceof Error ? error.message : "Internal server error");
      }
    }
  });

  let closed = false;
  return {
    app,
    config,
    close: () => {
      if (closed) return;
      closed = true;
      clearInterval(sweepInterval);
      for (const session of sessions.values()) session.transport.close();
      sessions.clear();
      oauthProvider.close();
    },
  };
}
