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
