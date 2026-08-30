import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DomainError, ErrorCode } from "../types.js";
import { loadVerificationProfile } from "./profile.js";

describe("loadVerificationProfile", () => {
  it("builds a safe default from discovered package commands", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "chatgpt2codex-profile-"));

    const profile = await loadVerificationProfile(root, [
      "npm:test",
      "npm:dev",
      "npm:build",
      "npm:typecheck",
    ]);

    expect(profile.commands.map((command) => command.commandId)).toEqual([
      "npm:typecheck",
      "npm:build",
      "npm:test",
    ]);
    expect(profile.limits).toEqual({ maxAttempts: 3, maxMinutes: 30 });
  });

  it("rejects non-loopback scenario URLs before execution", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "chatgpt2codex-profile-"));
    await mkdir(path.join(root, ".chatgpt2codex"));
    await writeFile(
      path.join(root, ".chatgpt2codex", "verification.json"),
      JSON.stringify({
        version: 1,
        commands: [{ commandId: "npm:test" }],
        scenarios: [{ kind: "http", method: "GET", url: "https://example.com", expectStatus: 200 }],
        limits: { maxAttempts: 3, maxMinutes: 30 },
      }),
    );

    await expect(loadVerificationProfile(root, ["npm:test"])).rejects.toMatchObject<Partial<DomainError>>({
      code: ErrorCode.VERIFICATION_PROFILE_INVALID,
    });
  });

  it("rejects command ids that discovery did not allow", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "chatgpt2codex-profile-"));
    await mkdir(path.join(root, ".chatgpt2codex"));
    await writeFile(
      path.join(root, ".chatgpt2codex", "verification.json"),
      JSON.stringify({
        version: 1,
        commands: [{ commandId: "npm:deploy" }],
        limits: { maxAttempts: 3, maxMinutes: 30 },
      }),
    );

    await expect(loadVerificationProfile(root, ["npm:test"])).rejects.toMatchObject<Partial<DomainError>>({
      code: ErrorCode.VERIFICATION_PROFILE_INVALID,
    });
  });
});
