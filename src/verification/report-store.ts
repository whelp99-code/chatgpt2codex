import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { VerificationReport } from "./types.js";

export function verificationReportPath(projectRoot: string, runId: string): string {
  return path.join(projectRoot, ".chatgpt2codex", "verification", runId, "report.json");
}

export async function writeVerificationReport(projectRoot: string, report: VerificationReport): Promise<string> {
  const dir = path.join(projectRoot, ".chatgpt2codex", "verification", report.runId);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const target = verificationReportPath(projectRoot, report.runId);
  const temp = path.join(dir, `.report.${process.pid}.${Date.now()}.tmp`);
  await writeFile(temp, `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temp, target);
  return target;
}

export async function readVerificationReport(projectRoot: string, runId: string): Promise<VerificationReport> {
  if (!/^vr_[A-Za-z0-9_.-]+$/.test(runId)) throw new Error("Invalid verification run id");
  return JSON.parse(await readFile(verificationReportPath(projectRoot, runId), "utf8")) as VerificationReport;
}
