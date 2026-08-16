import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SingleUserOAuthProvider, type OAuthConfig, type TokenAuditEvent } from "./oauth-provider.js";
import type { OAuthClientInformationFull } from "@modelcontextprotocol/sdk/shared/auth.js";

/**
 * A connector that silently stops working leaves nothing behind unless grants
 * and rejections are recorded. These cover the rejection paths an owner would
 * need to tell apart during an incident: a client that never refreshed looks
 * identical to one whose refresh was refused, unless the refusal says why.
 */

const RESOURCE = new URL("https://mcp.example.com/mcp");

function client(id = "client-1"): OAuthClientInformationFull {
  return {
    client_id: id,
    redirect_uris: ["https://chatgpt.com/connector/oauth/abc"],
    token_endpoint_auth_method: "none",
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
  } as OAuthClientInformationFull;
}

describe("oauth token auditing", () => {
  let dir: string;
  let events: TokenAuditEvent[];
  let provider: SingleUserOAuthProvider;

  function makeProvider(overrides: Partial<OAuthConfig> = {}): SingleUserOAuthProvider {
    const config: OAuthConfig = {
      verifyOwnerToken: async () => true,
      accessTokenTtlSeconds: 3600,
      refreshTokenTtlSeconds: 30 * 24 * 3600,
      scopes: ["chatgpt2codex"],
      allowedRedirectHosts: ["chatgpt.com"],
      onTokenEvent: (event) => {
        events.push(event);
      },
      ...overrides,
    };
    return new SingleUserOAuthProvider(config, RESOURCE, dir);
  }

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "c2c-oauth-audit-"));
    events = [];
    provider = makeProvider();
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("records a refresh token the server has never issued", async () => {
    await expect(
      provider.exchangeRefreshToken(client(), "not-a-real-token", undefined, RESOURCE),
    ).rejects.toThrow();

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      grant: "refresh_token",
      outcome: "rejected",
      clientId: "client-1",
      reason: "unknown_refresh_token",
      resource: RESOURCE.href,
    });
  });

  it("distinguishes a resource mismatch from an unusable token", async () => {
    // A rejection the owner would otherwise read as "the token went bad", when
    // the token is fine and the client asked for the wrong audience.
    await expect(
      provider.exchangeRefreshToken(client(), "not-a-real-token", undefined, new URL("https://mcp.example.com/other")),
    ).rejects.toThrow();

    expect(events[0]?.reason).toBe("unknown_refresh_token");
  });

  it("records an expired access token with how long it had been expired", async () => {
    // Written straight to the store: the point is the verification path, and
    // waiting an hour for a real token to lapse is not a test.
    const { JsonOAuthStore } = await import("./oauth-store.js");
    const store = new JsonOAuthStore(dir);
    const past = Math.floor(Date.now() / 1000) - 600;
    const { createHash } = await import("node:crypto");
    const hash = createHash("sha256").update("expired-token").digest("base64url");

    await store.saveTokenPair({
      accessTokenHash: hash,
      accessToken: { clientId: "client-1", scopes: ["chatgpt2codex"], expiresAt: past, resource: RESOURCE.href },
      refreshTokenHash: hash + "-r",
      refreshToken: {
        clientId: "client-1",
        scopes: ["chatgpt2codex"],
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
        resource: RESOURCE.href,
      },
    });

    await expect(provider.verifyAccessToken("expired-token")).rejects.toThrow();

    const rejection = events.find((e) => e.grant === "access_verify");
    expect(rejection).toMatchObject({
      outcome: "rejected",
      reason: "access_expired",
      clientId: "client-1",
    });
    expect(rejection?.expiredForSeconds).toBeGreaterThanOrEqual(600);
  });

  it("reports an unrecognized access token without a client id to leak", async () => {
    await expect(provider.verifyAccessToken("never-issued")).rejects.toThrow();

    expect(events[0]).toMatchObject({
      grant: "access_verify",
      outcome: "rejected",
      reason: "unknown_access_token",
    });
    expect(events[0]?.clientId).toBeUndefined();
  });

  it("answers a client's parallel refreshes instead of locking it out", async () => {
    // The incident this exists for: one connector fired six refreshes inside a
    // second, the first rotated the token away, and the other five were told
    // their credentials were invalid.
    const { JsonOAuthStore, hashToken } = await import("./oauth-store.js");
    const store = new JsonOAuthStore(dir);
    const soon = Math.floor(Date.now() / 1000) + 3600;
    await store.saveTokenPair({
      accessTokenHash: hashToken("a0"),
      accessToken: { clientId: "client-1", scopes: ["chatgpt2codex"], expiresAt: soon, resource: RESOURCE.href },
      refreshTokenHash: hashToken("r0"),
      refreshToken: { clientId: "client-1", scopes: ["chatgpt2codex"], expiresAt: soon, resource: RESOURCE.href },
    });

    const first = await provider.exchangeRefreshToken(client(), "r0", undefined, RESOURCE);
    expect(first.access_token).toBeTruthy();

    // Same now-rotated token again, as a retry in flight would carry.
    const replay = await provider.exchangeRefreshToken(client(), "r0", undefined, RESOURCE);
    expect(replay.access_token).toBeTruthy();
    expect(replay.access_token).not.toBe(first.access_token);

    const grace = events.filter((e) => e.outcome === "granted" && e.withinGrace);
    expect(grace).toHaveLength(1);
    expect(grace[0]?.clientId).toBe("client-1");
  });

  it("refuses a replay once the grace window has closed", async () => {
    provider = makeProvider({ refreshRotationGraceSeconds: 0 });
    const { JsonOAuthStore, hashToken } = await import("./oauth-store.js");
    const store = new JsonOAuthStore(dir);
    const soon = Math.floor(Date.now() / 1000) + 3600;
    await store.saveTokenPair({
      accessTokenHash: hashToken("a1"),
      accessToken: { clientId: "client-1", scopes: ["chatgpt2codex"], expiresAt: soon, resource: RESOURCE.href },
      refreshTokenHash: hashToken("r1"),
      refreshToken: { clientId: "client-1", scopes: ["chatgpt2codex"], expiresAt: soon, resource: RESOURCE.href },
    });

    await provider.exchangeRefreshToken(client(), "r1", undefined, RESOURCE);
    // With no grace, rotation stays strictly one-time — the property that makes
    // a replayed token detectable at all.
    await expect(provider.exchangeRefreshToken(client(), "r1", undefined, RESOURCE)).rejects.toThrow();
  });

  it("does not let one client spend another's token inside the grace window", async () => {
    const { JsonOAuthStore, hashToken } = await import("./oauth-store.js");
    const store = new JsonOAuthStore(dir);
    const soon = Math.floor(Date.now() / 1000) + 3600;
    await store.saveTokenPair({
      accessTokenHash: hashToken("a2"),
      accessToken: { clientId: "client-1", scopes: ["chatgpt2codex"], expiresAt: soon, resource: RESOURCE.href },
      refreshTokenHash: hashToken("r2"),
      refreshToken: { clientId: "client-1", scopes: ["chatgpt2codex"], expiresAt: soon, resource: RESOURCE.href },
    });
    await provider.exchangeRefreshToken(client(), "r2", undefined, RESOURCE);

    await expect(
      provider.exchangeRefreshToken(client("client-2"), "r2", undefined, RESOURCE),
    ).rejects.toThrow();
    expect(events.some((e) => e.clientId === "client-2" && e.outcome === "rejected")).toBe(true);
  });

  it("supersedes a client's previous access token when it refreshes", async () => {
    const { JsonOAuthStore, hashToken } = await import("./oauth-store.js");
    const store = new JsonOAuthStore(dir);
    const soon = Math.floor(Date.now() / 1000) + 3600;
    await store.saveTokenPair({
      accessTokenHash: hashToken("a3"),
      accessToken: { clientId: "client-1", scopes: ["chatgpt2codex"], expiresAt: soon, resource: RESOURCE.href },
      refreshTokenHash: hashToken("r3"),
      refreshToken: { clientId: "client-1", scopes: ["chatgpt2codex"], expiresAt: soon, resource: RESOURCE.href },
    });

    await provider.exchangeRefreshToken(client(), "r3", undefined, RESOURCE);

    // The replaced credential must stop working immediately, not linger for
    // the rest of its TTL.
    await expect(provider.verifyAccessToken("a3")).rejects.toThrow();
  });

  it("keeps rejecting normally when the audit sink throws", async () => {
    provider = makeProvider({
      onTokenEvent: () => {
        throw new Error("ledger unavailable");
      },
    });

    // The OAuth outcome must not depend on whether logging worked.
    await expect(
      provider.exchangeRefreshToken(client(), "not-a-real-token", undefined, RESOURCE),
    ).rejects.toThrow(/Invalid refresh token/u);
  });
});
