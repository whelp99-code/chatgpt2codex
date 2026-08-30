import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { DomainError, ErrorCode } from "../types.js";
import type { VerificationProfile } from "./types.js";

const localUrl = z.string().url().refine((value) => {
  const hostname = new URL(value).hostname.toLowerCase();
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}, "URL must use localhost, 127.0.0.1, or [::1]");

const profileSchema = z.object({
  version: z.literal(1),
  commands: z.array(z.object({
    commandId: z.string().min(1),
    timeoutSec: z.number().int().min(1).max(300).optional(),
  })).min(1),
  server: z.object({
    command: z.string().min(1),
    waitUrl: localUrl,
    timeoutSec: z.number().int().min(1).max(300),
  }).optional(),
  scenarios: z.array(z.union([
    z.object({
      kind: z.literal("http"),
      method: z.enum(["GET", "POST"]),
      url: localUrl,
      expectStatus: z.number().int().min(100).max(599),
    }),
    z.object({
      kind: z.literal("screenshot"),
      url: localUrl.optional(),
      appName: z.string().min(1).optional(),
      label: z.string().min(1).max(120),
    }).refine((value) => Boolean(value.url || value.appName), "url or appName is required"),
  ])).optional(),
  limits: z.object({
    maxAttempts: z.number().int().min(1).max(5),
    maxMinutes: z.number().int().min(1).max(120),
  }),
});

function defaultCommands(discoveredCommandIds: readonly string[]): string[] {
  const priorities = ["typecheck", "type-check", "build", "test", "tests"];
  const selected: string[] = [];
  for (const name of priorities) {
    const found = discoveredCommandIds.find((id) => id === `npm:${name}` || id === `make:${name}` || id === `flutter:${name}`);
    if (found && !selected.includes(found)) selected.push(found);
  }
  if (selected.length > 0) return selected;
  return discoveredCommandIds.slice(0, 1);
}

function invalid(message: string, details?: Record<string, unknown>): DomainError {
  return new DomainError(ErrorCode.VERIFICATION_PROFILE_INVALID, message, details);
}

export async function loadVerificationProfile(
  projectRoot: string,
  discoveredCommandIds: readonly string[],
): Promise<VerificationProfile> {
  const profilePath = path.join(projectRoot, ".chatgpt2codex", "verification.json");
  let input: unknown;
  try {
    input = JSON.parse(await readFile(profilePath, "utf8"));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") throw invalid("Verification profile could not be read");
    const commands = defaultCommands(discoveredCommandIds);
    if (commands.length === 0) throw invalid("No safe verification commands were discovered");
    input = {
      version: 1,
      commands: commands.map((commandId) => ({ commandId })),
      limits: { maxAttempts: 3, maxMinutes: 30 },
    };
  }

  const parsed = profileSchema.safeParse(input);
  if (!parsed.success) {
    throw invalid("Verification profile is invalid", { issues: parsed.error.issues.map((issue) => issue.message) });
  }
  const unknown = parsed.data.commands
    .map((command) => command.commandId)
    .filter((commandId) => !discoveredCommandIds.includes(commandId));
  if (unknown.length > 0) throw invalid("Verification profile contains undiscovered commands", { commandIds: unknown });
  return parsed.data;
}
