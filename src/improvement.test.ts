import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DomainError, ErrorCode } from "./types.js";
import {
  createSkillImprovementProposal,
  recordFeedback,
} from "./improvement.js";

async function fixture(): Promise<{ root: string; stateDir: string; skillPath: string; baseHash: string }> {
  const root = await mkdtemp(path.join(tmpdir(), "chatgpt2codex-improvement-"));
  const stateDir = path.join(root, "state");
  const skillPath = ".agents/skills/testing/SKILL.md";
  await mkdir(path.join(root, path.dirname(skillPath)), { recursive: true });
  const content = "# Testing\n\nRun project tests.\n";
  await writeFile(path.join(root, skillPath), content);
  return {
    root,
    stateDir,
    skillPath,
    baseHash: createHash("sha256").update(content).digest("hex"),
  };
}

describe("feedback and skill improvement proposals", () => {
  it("requires a user-confirmed reason", async () => {
    const { stateDir, skillPath } = await fixture();

    await expect(recordFeedback(stateDir, {
      projectId: "project-1",
      loopId: "loop-1",
      skillPath,
      whatWentWrong: "Tests passed but the CLI was not exercised",
      whyItWasWrong: "",
      evidenceIds: ["vr-1"],
      confirmedByUser: true,
    })).rejects.toMatchObject<Partial<DomainError>>({ code: ErrorCode.FEEDBACK_INVALID });
  });

  it("creates a proposal from three confirmed records without changing the skill", async () => {
    const { root, stateDir, skillPath, baseHash } = await fixture();
    const before = await readFile(path.join(root, skillPath), "utf8");
    const records = [];
    for (let index = 1; index <= 3; index += 1) {
      records.push(await recordFeedback(stateDir, {
        projectId: "project-1",
        loopId: `loop-${index}`,
        skillPath,
        whatWentWrong: "The user-facing command was not run",
        whyItWasWrong: "Automated tests do not prove the CLI surface works",
        evidenceIds: [`vr-${index}`],
        confirmedByUser: true,
      }));
    }

    const proposal = await createSkillImprovementProposal(stateDir, root, {
      targetProjectId: "project-1",
      skillPath,
      baseHash,
      supportingFeedbackIds: records.map((record) => record.feedbackId),
      contradictingFeedbackIds: [],
      summary: "Require direct CLI usage after automated checks",
      unifiedDiff: [
        `--- a/${skillPath}`,
        `+++ b/${skillPath}`,
        "@@ -1,3 +1,5 @@",
        " # Testing",
        " ",
        " Run project tests.",
        "+",
        "+For CLI changes, run the real command surface before completion.",
      ].join("\n"),
    });

    expect(proposal.status).toBe("proposed");
    expect(await readFile(path.join(root, skillPath), "utf8")).toBe(before);
  });

  it("blocks proposals with fewer than three supporting records", async () => {
    const { root, stateDir, skillPath, baseHash } = await fixture();
    const record = await recordFeedback(stateDir, {
      projectId: "project-1",
      loopId: "loop-1",
      skillPath,
      whatWentWrong: "No CLI smoke test",
      whyItWasWrong: "The shipped surface was not exercised",
      evidenceIds: ["vr-1"],
      confirmedByUser: true,
    });

    await expect(createSkillImprovementProposal(stateDir, root, {
      targetProjectId: "project-1",
      skillPath,
      baseHash,
      supportingFeedbackIds: [record.feedbackId],
      contradictingFeedbackIds: [],
      summary: "Require a CLI smoke test",
      unifiedDiff: `--- a/${skillPath}\n+++ b/${skillPath}\n@@ -1 +1 @@\n-old\n+new`,
    })).rejects.toMatchObject<Partial<DomainError>>({ code: ErrorCode.SKILL_IMPROVEMENT_BLOCKED });
  });
});
