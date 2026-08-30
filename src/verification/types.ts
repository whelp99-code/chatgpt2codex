export interface VerificationProfile {
  version: 1;
  commands: Array<{
    commandId: string;
    timeoutSec?: number;
  }>;
  server?: {
    command: string;
    waitUrl: string;
    timeoutSec: number;
  };
  scenarios?: Array<
    | { kind: "http"; method: "GET" | "POST"; url: string; expectStatus: number }
    | { kind: "screenshot"; url?: string; appName?: string; label: string }
  >;
  limits: {
    maxAttempts: number;
    maxMinutes: number;
  };
}

export interface VerificationCheck {
  id: string;
  kind: "command" | "http" | "screenshot";
  status: "passed" | "failed" | "blocked";
  exitCode?: number;
  summary: string;
  evidencePaths: string[];
}

export interface VerificationReport {
  version: 1;
  runId: string;
  projectId: string;
  attempt: number;
  startedAt: string;
  finishedAt: string;
  diffHash: string;
  verdict: "passed" | "failed" | "blocked";
  failureFingerprint?: string;
  checks: VerificationCheck[];
  evidencePath: string;
}
