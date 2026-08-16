import { randomUUID, createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile, chmod } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import { InvalidRequestError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type { OAuthClientInformationFull } from "@modelcontextprotocol/sdk/shared/auth.js";

/**
 * Simple JSON-file backed OAuth persistence (PRD §11 SR-08/SR-09) using the
 * MCP SDK OAuth store interfaces without a sqlite dependency.
 *
 * Persisted under `<stateDir>/oauth.json`:
 *  - registered clients (dynamic client registration)
 *  - access token records, keyed by SHA-256 hash of the raw token
 *  - refresh token records, keyed by SHA-256 hash of the raw token
 *
 * Hardening:
 *  - Raw tokens are never persisted — only their SHA-256 hash (base64url).
 *  - Refresh token rotation is one-time: `saveTokenPair` atomically deletes
 *    the consumed refresh token hash and inserts the new pair, or fails the
 *    whole operation if the consumed hash is already gone (replay defense).
 *  - Expired access/refresh tokens are swept on every load (SR-09 bounded
 *    growth) and file writes are atomic (temp file + rename).
 *  - Directory/file permissions are tightened to 0700/0600.
 */

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
const OAUTH_FILE = "oauth.json";

export interface PersistedAccessTokenRecord {
  clientId: string;
  scopes: string[];
  expiresAt: number; // epoch seconds
  resource?: string;
}

export interface PersistedRefreshTokenRecord {
  clientId: string;
  scopes: string[];
  expiresAt: number; // epoch seconds
  resource?: string;
}

export interface PersistedTokenPair {
  accessTokenHash: string;
  accessToken: PersistedAccessTokenRecord;
  refreshTokenHash: string;
  refreshToken: PersistedRefreshTokenRecord;
}

const ClientSchema = z.object({
  clientId: z.string(),
  clientJson: z.record(z.string(), z.unknown()),
  issuedAt: z.number(),
});

const AccessTokenSchema = z.object({
  tokenHash: z.string(),
  clientId: z.string(),
  scopes: z.array(z.string()),
  expiresAt: z.number(),
  resource: z.string().optional(),
});

const RefreshTokenSchema = z.object({
  tokenHash: z.string(),
  clientId: z.string(),
  scopes: z.array(z.string()),
  expiresAt: z.number(),
  resource: z.string().optional(),
});

const OAuthFileSchema = z.object({
  version: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
  clients: z.array(ClientSchema),
  accessTokens: z.array(AccessTokenSchema),
  refreshTokens: z.array(RefreshTokenSchema),
});

type OAuthFile = z.infer<typeof OAuthFileSchema>;

function emptyFile(): OAuthFile {
  return { version: 1, updatedAt: Date.now(), clients: [], accessTokens: [], refreshTokens: [] };
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("base64url");
}

function redirectHostAllowed(redirectUri: string, allowedHosts: string[]): boolean {
  let parsed: URL;
  try {
    parsed = new URL(redirectUri);
  } catch {
    return false;
  }
  if (["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname)) return true;
  return allowedHosts.includes(parsed.hostname);
}

/**
 * JSON-file backed OAuth store: registered clients + access/refresh tokens.
 * All mutating operations are serialized through an in-process mutex so
 * concurrent tool/HTTP handlers never interleave a read-modify-write cycle
 * (the file itself is written atomically via temp-file + rename).
 */
export class JsonOAuthStore {
  private readonly stateDir: string;
  private readonly filePath: string;
  private queue: Promise<unknown> = Promise.resolve();
  private cache: OAuthFile | undefined;

  constructor(stateDir: string) {
    this.stateDir = stateDir;
    this.filePath = join(stateDir, OAUTH_FILE);
  }

  /** Serialize all read-modify-write operations on the backing file. */
  private locked<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    // Swallow rejections in the chain itself so one failed op doesn't wedge
    // the queue for subsequent callers; callers still see their own errors.
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async ensureDir(): Promise<void> {
    await mkdir(this.stateDir, { recursive: true, mode: DIR_MODE });
    try {
      await chmod(this.stateDir, DIR_MODE);
    } catch {
      // Non-fatal: filesystem may not support POSIX permission bits.
    }
  }

  private async load(): Promise<OAuthFile> {
    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed = OAuthFileSchema.safeParse(JSON.parse(raw));
      this.cache = parsed.success ? parsed.data : emptyFile();
    } catch {
      this.cache = emptyFile();
    }
    return this.cache;
  }

  private async persist(doc: OAuthFile): Promise<void> {
    await this.ensureDir();
    doc.updatedAt = Date.now();
    const tmp = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(tmp, JSON.stringify(doc, null, 2), { mode: FILE_MODE, encoding: "utf8" });
    await rename(tmp, this.filePath);
    try {
      await chmod(this.filePath, FILE_MODE);
    } catch {
      // Non-fatal.
    }
    this.cache = doc;
  }

  private sweepExpired(doc: OAuthFile, nowSeconds: number): void {
    doc.accessTokens = doc.accessTokens.filter((t) => t.expiresAt >= nowSeconds);
    doc.refreshTokens = doc.refreshTokens.filter((t) => t.expiresAt >= nowSeconds);
  }

  async getClient(clientId: string): Promise<OAuthClientInformationFull | undefined> {
    return this.locked(async () => {
      const doc = await this.load();
      const found = doc.clients.find((c) => c.clientId === clientId);
      return found ? (found.clientJson as unknown as OAuthClientInformationFull) : undefined;
    });
  }

  async registerClient(
    client: Omit<OAuthClientInformationFull, "client_id" | "client_id_issued_at">,
    allowedRedirectHosts: string[],
  ): Promise<OAuthClientInformationFull> {
    return this.locked(async () => {
      if (!client.redirect_uris.every((uri) => redirectHostAllowed(String(uri), allowedRedirectHosts))) {
        throw new InvalidRequestError("Client redirect_uri is not allowed for this chatgpt2codex server");
      }
      const doc = await this.load();
      const now = Math.floor(Date.now() / 1000);
      const registered: OAuthClientInformationFull = {
        ...client,
        client_id: `chatgpt2codex-${randomUUID()}`,
        client_id_issued_at: now,
        token_endpoint_auth_method: client.token_endpoint_auth_method ?? "none",
        grant_types: client.grant_types ?? ["authorization_code", "refresh_token"],
        response_types: client.response_types ?? ["code"],
      };
      doc.clients.push({
        clientId: registered.client_id,
        clientJson: registered as unknown as Record<string, unknown>,
        issuedAt: now,
      });
      await this.persist(doc);
      return registered;
    });
  }

  /**
   * Returns the record whether or not it has expired; the caller decides.
   *
   * Filtering expired tokens out here made the two failures indistinguishable:
   * a token that lapsed an hour ago and one that was never issued both came
   * back as `undefined`. During an incident that is the single most useful
   * distinction there is — it separates a client that stopped refreshing from
   * one presenting garbage — so expiry is judged one level up, where the
   * reason can be recorded. Both callers already compare `expiresAt`, so
   * nothing expired is ever accepted.
   */
  async getAccessToken(tokenHash: string): Promise<PersistedAccessTokenRecord | undefined> {
    return this.locked(async () => {
      const doc = await this.load();
      const found = doc.accessTokens.find((t) => t.tokenHash === tokenHash);
      return found
        ? { clientId: found.clientId, scopes: found.scopes, expiresAt: found.expiresAt, resource: found.resource }
        : undefined;
    });
  }

  /** Expiry is judged by the caller — see `getAccessToken` for why. */
  async getRefreshToken(tokenHash: string): Promise<PersistedRefreshTokenRecord | undefined> {
    return this.locked(async () => {
      const doc = await this.load();
      const found = doc.refreshTokens.find((t) => t.tokenHash === tokenHash);
      return found
        ? { clientId: found.clientId, scopes: found.scopes, expiresAt: found.expiresAt, resource: found.resource }
        : undefined;
    });
  }

  /**
   * Atomically persist a fresh access/refresh token pair, optionally
   * consuming (one-time-rotating) a prior refresh token hash. Returns false
   * (and persists nothing) if `consumedRefreshTokenHash` was provided but not
   * found — signals a replayed/already-rotated refresh token to the caller.
   */
  async saveTokenPair(pair: PersistedTokenPair, consumedRefreshTokenHash?: string): Promise<boolean> {
    return this.locked(async () => {
      const doc = await this.load();
      const now = Math.floor(Date.now() / 1000);
      this.sweepExpired(doc, now);

      if (consumedRefreshTokenHash) {
        const idx = doc.refreshTokens.findIndex((t) => t.tokenHash === consumedRefreshTokenHash);
        if (idx === -1) return false;
        doc.refreshTokens.splice(idx, 1);
      }

      doc.accessTokens = doc.accessTokens.filter((t) => t.tokenHash !== pair.accessTokenHash);
      doc.accessTokens.push({ tokenHash: pair.accessTokenHash, ...pair.accessToken });
      doc.refreshTokens = doc.refreshTokens.filter((t) => t.tokenHash !== pair.refreshTokenHash);
      doc.refreshTokens.push({ tokenHash: pair.refreshTokenHash, ...pair.refreshToken });

      await this.persist(doc);
      return true;
    });
  }

  async deleteAccessToken(tokenHash: string): Promise<void> {
    await this.locked(async () => {
      const doc = await this.load();
      const before = doc.accessTokens.length;
      doc.accessTokens = doc.accessTokens.filter((t) => t.tokenHash !== tokenHash);
      if (doc.accessTokens.length !== before) await this.persist(doc);
    });
  }

  async deleteRefreshToken(tokenHash: string): Promise<void> {
    await this.locked(async () => {
      const doc = await this.load();
      const before = doc.refreshTokens.length;
      doc.refreshTokens = doc.refreshTokens.filter((t) => t.tokenHash !== tokenHash);
      if (doc.refreshTokens.length !== before) await this.persist(doc);
    });
  }

  async clearAll(): Promise<void> {
    await this.locked(async () => {
      await this.persist(emptyFile());
    });
  }

  /**
   * Revoke every issued access/refresh token while KEEPING dynamic client
   * registrations.
   *
   * Rotating the owner token must invalidate anything already issued under
   * the old secret — that is the tokens. Dropping the client registrations
   * too is both unnecessary and actively harmful: a registration on its own
   * grants nothing (every authorization still has to pass the owner-token
   * form), but an MCP client like ChatGPT performs dynamic registration only
   * once, when the connector is created, and caches the client_id forever
   * after. Delete the registration and that cached id can never be honored
   * again, so every later /authorize fails with a bare "Invalid client_id"
   * and the only cure — remove and re-add the connector — is undiscoverable.
   */
  async clearTokens(): Promise<void> {
    await this.locked(async () => {
      const doc = await this.load();
      doc.accessTokens = [];
      doc.refreshTokens = [];
      await this.persist(doc);
    });
  }

  /** Number of currently registered clients (for diagnostics/CLI output). */
  async countClients(): Promise<number> {
    return this.locked(async () => (await this.load()).clients.length);
  }

  close(): void {
    // No open handles to release for the JSON-file backend; kept for
    // interface parity with a future sqlite/worker-backed store.
  }
}

/** Adapts JsonOAuthStore's client methods to the SDK's synchronous-looking
 * but actually-async-capable `OAuthRegisteredClientsStore` interface (the
 * SDK accepts either sync or Promise-returning implementations). */
export class JsonOAuthClientsStore implements OAuthRegisteredClientsStore {
  constructor(
    private readonly store: JsonOAuthStore,
    private readonly allowedRedirectHosts: string[],
  ) {}

  getClient(clientId: string): Promise<OAuthClientInformationFull | undefined> {
    return this.store.getClient(clientId);
  }

  registerClient(
    client: Omit<OAuthClientInformationFull, "client_id" | "client_id_issued_at">,
  ): Promise<OAuthClientInformationFull> {
    return this.store.registerClient(client, this.allowedRedirectHosts);
  }
}
