import { randomBytes, timingSafeEqual, createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile, chmod } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

/**
 * Owner token lifecycle (PRD §11 SR-04): a single local-owner token that
 * gates the `/authorize` HTML form (see src/auth/oauth-provider.ts).
 *
 * Storage: only a SHA-256 hash of the token is ever written to disk, under
 * `<stateDir>/owner-token.json` (mode 0600). The plaintext token is shown to
 * the operator exactly once, at `chatgpt2codex init` time, and is never logged.
 */

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
const OWNER_TOKEN_FILE = "owner-token.json";
export const MIN_OWNER_TOKEN_LENGTH = 20;

const OwnerTokenFileSchema = z.object({
  version: z.number().int().nonnegative(),
  createdAt: z.number().int().nonnegative(),
  tokenHash: z.string().min(1),
});

type OwnerTokenFile = z.infer<typeof OwnerTokenFileSchema>;

function hash(token: string): string {
  return createHash("sha256").update(token).digest("base64url");
}

/** Generate a fresh random owner token (256 bits, base64url — well above
 * MIN_OWNER_TOKEN_LENGTH). Never persisted in plaintext by this function. */
export function generateOwnerToken(): string {
  return randomBytes(32).toString("base64url");
}

async function ensureDir(stateDir: string): Promise<void> {
  await mkdir(stateDir, { recursive: true, mode: DIR_MODE });
  try {
    await chmod(stateDir, DIR_MODE);
  } catch {
    // Non-fatal: filesystem may not support POSIX permission bits.
  }
}

/**
 * Persist the hash of `token` to `<stateDir>/owner-token.json`, overwriting
 * any prior value. Rejects tokens shorter than MIN_OWNER_TOKEN_LENGTH.
 * Returns nothing containing the plaintext token — callers must print it
 * themselves, exactly once, at generation time.
 */
export async function storeOwnerToken(stateDir: string, rawToken: string): Promise<void> {
  const token = rawToken.trim();
  if (token.length < MIN_OWNER_TOKEN_LENGTH) {
    throw new Error(`Owner token must be at least ${MIN_OWNER_TOKEN_LENGTH} characters`);
  }
  await ensureDir(stateDir);
  const doc: OwnerTokenFile = {
    version: 1,
    createdAt: Date.now(),
    tokenHash: hash(token),
  };
  const target = join(stateDir, OWNER_TOKEN_FILE);
  const tmp = join(stateDir, `.${OWNER_TOKEN_FILE}.${process.pid}.tmp`);
  await writeFile(tmp, JSON.stringify(doc, null, 2), { mode: FILE_MODE, encoding: "utf8" });
  await rename(tmp, target);
  try {
    await chmod(target, FILE_MODE);
  } catch {
    // Non-fatal.
  }
}

/** Load the stored owner-token hash record, or undefined if none exists yet. */
export async function loadOwnerTokenRecord(stateDir: string): Promise<OwnerTokenFile | undefined> {
  const target = join(stateDir, OWNER_TOKEN_FILE);
  try {
    const raw = await readFile(target, "utf8");
    const parsed = OwnerTokenFileSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/** Timing-safe verification of a candidate plaintext token against the
 * stored hash. Returns false (never throws) for any mismatch/missing file. */
export async function verifyOwnerToken(stateDir: string, candidate: string): Promise<boolean> {
  const record = await loadOwnerTokenRecord(stateDir);
  if (!record) return false;
  const candidateHash = hash(candidate);
  const left = Buffer.from(candidateHash);
  const right = Buffer.from(record.tokenHash);
  if (left.byteLength !== right.byteLength) return false;
  return timingSafeEqual(left, right);
}

export async function hasOwnerToken(stateDir: string): Promise<boolean> {
  return (await loadOwnerTokenRecord(stateDir)) !== undefined;
}
