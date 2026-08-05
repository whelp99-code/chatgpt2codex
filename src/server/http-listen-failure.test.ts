import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * Regression coverage for the crash-loop that made `serve --http` unusable.
 *
 * `app.listen()` reports bind failures by emitting an `error` event on the
 * returned server rather than throwing. The original code passed only a
 * success callback and attached no `error` listener, so a busy port killed
 * the process with an unhandled `error` event and a raw stack trace. Under
 * any supervisor that restarts the server (the macOS menu bar app, launchd,
 * the launcher script) that turned a recoverable "port still held by the
 * previous instance" into an endless start/crash/restart loop.
 *
 * Worse, `workspace.opened` was appended to the audit ledger immediately
 * after *calling* listen — before the bind was known to have succeeded — so
 * every crashed start left a ledger entry claiming the server had opened.
 * A real user's ledger accumulated 11,759 `workspace.opened` events and not
 * one request event, which hid the actual fault completely.
 *
 * These tests run the built CLI as a real subprocess, because the bug lived
 * entirely in process-level event wiring that an in-process test would miss.
 */
describe("serve --http bind failure handling", () => {
  let stateDir: string;
  let workspace: string;
  let blocker: net.Server;
  let port: number;

  async function readLedgerTypes(): Promise<string[]> {
    const target = path.join(stateDir, "audit.jsonl");
    let raw: string;
    try {
      raw = await fs.readFile(target, "utf8");
    } catch {
      return [];
    }
    return raw
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line).type as string);
  }

  /** Run the CLI with HOME redirected so it uses an isolated state dir. */
  async function runServe(extraArgs: string[] = []): Promise<{ code: number; stderr: string }> {
    try {
      const { stderr } = await execFileAsync(
        process.execPath,
        [
          path.join(repoRoot, "dist", "cli.js"),
          "serve",
          "--http",
          "--workspace",
          workspace,
          "--port",
          String(port),
          ...extraArgs,
        ],
        { env: { ...process.env, HOME: homeDir, CHATGPT2CODEX_LISTEN_RETRY_MS: "1500" }, timeout: 60_000 },
      );
      return { code: 0, stderr };
    } catch (err) {
      const failure = err as { code?: number; stderr?: string };
      return { code: failure.code ?? -1, stderr: failure.stderr ?? "" };
    }
  }

  let homeDir: string;

  beforeEach(async () => {
    homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "chatgpt2codex-listen-home-"));
    stateDir = path.join(homeDir, ".local", "share", "chatgpt2codex");
    workspace = await fs.mkdtemp(path.join(os.tmpdir(), "chatgpt2codex-listen-ws-"));

    // An owner token must exist or serve --http bails out before ever binding.
    const { storeOwnerToken } = await import("../auth/owner-token.js");
    await storeOwnerToken(stateDir, "a".repeat(40));

    blocker = net.createServer();
    port = await new Promise<number>((resolve, reject) => {
      blocker.once("error", reject);
      blocker.listen(0, "127.0.0.1", () => {
        const address = blocker.address();
        if (address && typeof address === "object") resolve(address.port);
        else reject(new Error("could not determine blocker port"));
      });
    });
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => blocker.close(() => resolve()));
    await fs.rm(homeDir, { recursive: true, force: true });
    await fs.rm(workspace, { recursive: true, force: true });
  });

  it("exits non-zero with an actionable message instead of crashing on an unhandled 'error' event", async () => {
    const result = await runServe();

    expect(result.code).toBe(1);
    // The old behavior: a raw "Unhandled 'error' event" stack trace.
    expect(result.stderr).not.toContain("Unhandled 'error' event");
    expect(result.stderr).toContain("already in use");
    // The message has to name the port and tell the operator how to find the
    // holder — otherwise a crash loop is undiagnosable from the log alone.
    expect(result.stderr).toContain(String(port));
    expect(result.stderr).toContain("lsof");
  }, 90_000);

  it("never records workspace.opened for a start that failed to bind", async () => {
    await runServe();

    const types = await readLedgerTypes();
    expect(types).not.toContain("workspace.opened");
    expect(types).toContain("server.listen_failed");
  }, 90_000);

  it("does not print a false success line claiming the server is up when the bind failed", async () => {
    const result = await runServe();

    // The success banner is `... serve --http: listening on http://host:port/mcp`.
    // It used to be printed from listen()'s callback with no error path, so a
    // failed start still looked successful in the log.
    expect(result.stderr).not.toMatch(/serve --http: listening on http/);
    expect(result.stderr).not.toContain("public URL");
  }, 90_000);

  it("retries a busy port so a normal restart survives the old process letting go", async () => {
    // Release the port shortly after the server starts trying: it must
    // recover rather than dying on the first EADDRINUSE.
    setTimeout(() => blocker.close(), 2000);

    const child = execFile(
      process.execPath,
      [
        path.join(repoRoot, "dist", "cli.js"),
        "serve",
        "--http",
        "--workspace",
        workspace,
        "--port",
        String(port),
      ],
      { env: { ...process.env, HOME: homeDir } },
    );

    let stderr = "";
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });

    try {
      await new Promise<void>((resolve, reject) => {
        const deadline = setTimeout(() => reject(new Error(`never bound. stderr:\n${stderr}`)), 30_000);
        const poll = setInterval(() => {
          if (stderr.includes("listening on")) {
            clearInterval(poll);
            clearTimeout(deadline);
            resolve();
          }
        }, 200);
        child.once("exit", () => {
          clearInterval(poll);
          clearTimeout(deadline);
          reject(new Error(`exited before binding. stderr:\n${stderr}`));
        });
      });

      expect(stderr).toContain("waiting up to");

      // The ledger append happens just after the banner is printed, so poll
      // briefly rather than racing it.
      let types: string[] = [];
      for (let attempt = 0; attempt < 50; attempt++) {
        types = await readLedgerTypes();
        if (types.includes("workspace.opened")) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      expect(types).toContain("workspace.opened");
      expect(types).not.toContain("server.listen_failed");
    } finally {
      child.kill("SIGTERM");
    }
  }, 90_000);
});
