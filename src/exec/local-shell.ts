import { exec } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { DomainError, ErrorCode } from "../types.js";
import { redact } from "../policy/secrets.js";
import { resolveInProject } from "../policy/paths.js";
import { buildSafeChildEnv } from "./command-runner.js";

const DEFAULT_TIMEOUT_SEC = 60;
const MAX_TIMEOUT_SEC = 900;
const OUTPUT_HEAD_BYTES = 12_000;
const OUTPUT_TAIL_BYTES = 6_000;

const SECRET_COMMAND_PATTERNS = [
  /(^|[\s/"'])\.env([\s/"'.]|$)/i,
  /(^|[\s/"'])\.ssh([\s/"']|$)/i,
  /(^|[\s/"'])\.npmrc([\s/"']|$)/i,
  /id_rsa|id_ed25519|private[_-]?key/i,
  /security\s+find-(generic|internet)-password/i,
  /keychain/i,
  /(^|[\s/"'])\.netrc([\s/"'.]|$)/i,
  /(^|[\s/"'])\.git-credentials([\s/"']|$)/i,
  /(^|[\s/"'])\.aws([\s/"']|$)/i,
  /(^|[\s/"'])\.gnupg([\s/"']|$)/i,
  /(^|[\s/"'])\.docker([\s/"']|$)/i,
  /(^|[\s/"'])\.kube([\s/"']|$)/i,
  /(^|[\s/"'])\.config[/\\]gcloud([\s/"']|$)/i,
  /(^|[\s/"'])credentials([\s/"'.]|$)/i,
];

const OS_DESTRUCTIVE_PATTERNS = [
  /\bsudo\b/i,
  // `rm -rf` / `rm -fr` in either flag order, with or without a trailing
  // slash on the target — the previous pattern required a literal `/`
  // after the flags, so `rm -rf *`, `rm -rf .`, and `rm -rf $DIR` (no
  // trailing slash) all slipped through.
  /\brm\s+-\w*r\w*f\w*\b|\brm\s+-\w*f\w*r\w*\b/i,
  /\bfind\b[^\n]*-delete\b/i,
  /\bgit\s+clean\b/i,
  // Redirecting into a block/char device (disk overwrite risk) — but not
  // `> /dev/null`, which is a common, harmless "discard output" idiom.
  />\s*\/dev\/(?!null\b)\S+/i,
  /\bdd\b[^\n]*\bof=\/dev\//i,
  /\bdiskutil\s+erase/i,
  /\bmkfs\b/i,
  /\bshutdown\b|\breboot\b/i,
];

const NETWORK_COMMAND_PATTERNS = [
  /\b(curl|wget|nc|ncat|netcat|telnet|scp|sftp|ftp|ssh)\b/i,
  /\b(npm|pnpm|yarn|bun)\s+(install|add|update)\b/i,
  /\bgit\s+(pull|fetch|clone|push)\b/i,
  /\bgh\b/i,
];

export interface LocalShellPreparation { root: string; cwd: string; timeoutSec: number }
export interface NetworkApprovalEvidence { readonly approvalId: string }
const issuedNetworkApprovalEvidence = new WeakSet<object>();

/** Internal capability issued only after a matching approval record is consumed. */
export function issueNetworkApprovalEvidence(approvalId: string): NetworkApprovalEvidence {
  const evidence = { approvalId };
  issuedNetworkApprovalEvidence.add(evidence);
  return evidence;
}

export function inferNetworkCommand(command: string): boolean {
  return NETWORK_COMMAND_PATTERNS.some((pattern) => pattern.test(command));
}

function truncateOutput(buf: Buffer): { text: string; truncated: boolean } {
  const limit = OUTPUT_HEAD_BYTES + OUTPUT_TAIL_BYTES;
  if (buf.length <= limit) {
    return { text: buf.toString("utf8"), truncated: false };
  }
  const head = buf.subarray(0, OUTPUT_HEAD_BYTES).toString("utf8");
  const tail = buf.subarray(buf.length - OUTPUT_TAIL_BYTES).toString("utf8");
  return {
    text: `${head}\n...[truncated ${buf.length - limit} bytes]...\n${tail}`,
    truncated: true,
  };
}

export function guardShellSafety(command: string): void {
  for (const pattern of SECRET_COMMAND_PATTERNS) {
    if (pattern.test(command)) {
      throw new DomainError(
        ErrorCode.SECRET_BLOCKED,
        "local_shell_run blocked a command that appears to read secret-classified material",
      );
    }
  }
  for (const pattern of OS_DESTRUCTIVE_PATTERNS) {
    if (pattern.test(command)) {
      throw new DomainError(
        ErrorCode.APPROVAL_REQUIRED,
        "local_shell_run blocked an OS-level destructive command",
      );
    }
  }
  // The caller (src/server/tools.ts local_shell_run) only requires approval
  // when the model *self-declares* intent.needsNetwork/destructive — a
  // prompt-injected model can simply omit that flag. Make this guard, not
  // the declared intent, the actual authority for network/egress commands:
  // reject them here unconditionally, matching how a declared needsNetwork
  // is already always rejected by the caller.
}

export function guardShellCommand(command: string, evidence?: NetworkApprovalEvidence): void {
  guardShellSafety(command);
  for (const pattern of NETWORK_COMMAND_PATTERNS) {
    if (pattern.test(command) && (!evidence || !issuedNetworkApprovalEvidence.has(evidence as object))) {
      throw new DomainError(
        ErrorCode.APPROVAL_REQUIRED,
        "local_shell_run blocked a network/egress command that requires explicit approval",
      );
    }
  }
}

export async function prepareLocalShell(root: string, cwd?: string, timeoutSec?: number): Promise<LocalShellPreparation> {
  const baseRoot = await fs.realpath(root);
  const commandCwd = cwd ? await resolveInProject(baseRoot, cwd, { allowSymlink: false }) : baseRoot;
  const stat = await fs.stat(commandCwd).catch(() => null);
  if (!stat?.isDirectory()) throw new DomainError(ErrorCode.PATH_OUTSIDE_PROJECT, "cwd is not a project directory", { cwd });
  return { root: baseRoot, cwd: commandCwd, timeoutSec: Math.min(Math.max(timeoutSec ?? DEFAULT_TIMEOUT_SEC, 1), MAX_TIMEOUT_SEC) };
}

export async function runLocalShell(
  root: string,
  command: string,
  cwd?: string,
  timeoutSec?: number,
  evidence?: NetworkApprovalEvidence,
): Promise<{
  cwd: string;
  exitCode: number;
  stdoutSummary: string;
  stderrSummary: string;
  durationMs: number;
  outputTruncated: boolean;
}> {
  return runPreparedLocalShell(await prepareLocalShell(root, cwd, timeoutSec), command, evidence);
}

export async function runPreparedLocalShell(
  prepared: LocalShellPreparation, command: string, evidence?: NetworkApprovalEvidence,
): Promise<{ cwd: string; exitCode: number; stdoutSummary: string; stderrSummary: string; durationMs: number; outputTruncated: boolean }> {
  guardShellCommand(command, evidence);
  const baseRoot = prepared.root;
  const commandCwd = prepared.cwd;
  const effectiveTimeoutSec = prepared.timeoutSec;
  const start = Date.now();

  return await new Promise((resolve, reject) => {
    exec(
      command,
      {
        cwd: commandCwd,
        env: buildSafeChildEnv(),
        timeout: effectiveTimeoutSec * 1000,
        killSignal: "SIGKILL",
        maxBuffer: 64 * 1024 * 1024,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        const durationMs = Date.now() - start;
        const stdoutBuf = Buffer.from(stdout ?? "", "utf8");
        const stderrBuf = Buffer.from(stderr ?? "", "utf8");

        if (error && (error as NodeJS.ErrnoException & { killed?: boolean }).killed) {
          reject(
            new DomainError(ErrorCode.TIMEOUT, `local shell command timed out after ${effectiveTimeoutSec}s`, {
              timeoutSec: effectiveTimeoutSec,
            }),
          );
          return;
        }

        const outStd = truncateOutput(stdoutBuf);
        const outErr = truncateOutput(stderrBuf);
        const exitCode = typeof error?.code === "number" ? error.code : error ? 1 : 0;

        resolve({
          cwd: path.relative(baseRoot, commandCwd) || ".",
          exitCode,
          stdoutSummary: redact(outStd.text),
          stderrSummary: redact(outErr.text),
          durationMs,
          outputTruncated: outStd.truncated || outErr.truncated,
        });
      },
    );
  });
}
