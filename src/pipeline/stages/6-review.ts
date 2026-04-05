import type { Stage, PipelineContext, StageOutput } from "./types.js";
import { runAgentsParallel } from "../runner.js";
import {
  getContextFilesForStage,
  writeReviewFeedback,
} from "../../memory/context-builder.js";
import { requestApproval } from "../../integrations/telegram/human-loop.js";

export const reviewStage: Stage = {
  id: "review",
  name: "Review",
  model: "sonnet",

  async run(ctx: PipelineContext): Promise<StageOutput> {
    const { config, ticketKey, state, memoryDir, projectDir } = ctx;
    const prNumber = state.current.prNumber;
    if (!prNumber)
      throw new Error("No PR number in state — git stage must run first");

    const contextFiles = getContextFilesForStage(
      projectDir,
      memoryDir,
      "review",
    );
    ctx.logger.info({ ticketKey, prNumber }, "Running parallel review agents");

    const logicPrompt = `Review PR #${prNumber} for ticket ${ticketKey}.
Focus on: Does the implementation correctly satisfy the acceptance criteria?
List issues as JSON: { "issues": [{ "severity": "minor"|"major", "message": "..." }] }`;

    const qualityPrompt = `Review PR #${prNumber} for ticket ${ticketKey}.
Focus on: Missing tests, security issues, type safety, performance red flags.
List issues as JSON: { "issues": [{ "severity": "minor"|"major", "message": "..." }] }`;

    const agentOpts = {
      workdir: config.workspace.rootDir,
      model: "sonnet" as const,
      contextFiles,
      timeoutMs: (config.pipeline?.stageTimeouts?.review ?? 600_000) / 2,
      stallTimeoutMs: 120_000,
    };

    const [logicRaw, qualityRaw] = ctx.dryRun
      ? ['{"issues":[]}', '{"issues":[]}']
      : await runAgentsParallel(
          { ...agentOpts, prompt: logicPrompt },
          { ...agentOpts, prompt: qualityPrompt },
        );

    const issues = [...parseIssues(logicRaw), ...parseIssues(qualityRaw)];

    const majorCount = issues.filter((i) => i.severity === "major").length;
    const threshold = config.github.majorIssueThreshold ?? 1;
    const needsHumanApproval = majorCount >= threshold;

    writeReviewFeedback(memoryDir, {
      prNumber,
      issues,
      autoResolved: !needsHumanApproval,
    });

    if (needsHumanApproval) {
      ctx.logger.warn(
        { ticketKey, majorCount },
        "Major issues found — requesting human approval via Telegram",
      );

      ctx.state.emit({
        type: "HUMAN_APPROVAL_REQUESTED",
        context: { prNumber, majorCount },
      });

      const hil = config.telegram.humanInTheLoop;
      const approved = ctx.dryRun
        ? true
        : await requestApproval(
            config.telegram.botToken,
            config.telegram.chatId,
            ticketKey,
            issues,
            {
              timeoutMs: hil?.reviewApprovalTimeoutMs ?? 86_400_000,
              onTimeout: hil?.reviewApprovalTimeoutAction ?? "abort",
              topicId: config.telegram.topicId,
            },
          );

      if (approved) {
        ctx.state.emit({ type: "HUMAN_APPROVED" });
        ctx.logger.info(
          { ticketKey, prNumber },
          "Human approved — proceeding to merge",
        );
      } else {
        ctx.state.emit({
          type: "HUMAN_REJECTED",
          reason: "Reviewer rejected PR",
        });
        throw new Error(`REVIEW_REJECTED:PR #${prNumber} rejected by reviewer`);
      }
    }

    // Auto-merge (or post-approval merge)
    if (!ctx.dryRun) {
      await ctx.github.mergePR(
        prNumber,
        config.github.autoMergeStrategy ?? "squash",
      );
      ctx.logger.info({ ticketKey, prNumber }, "PR merged");
    }

    return { prNumber, issues, merged: true };
  },
};

function parseIssues(
  raw: string,
): Array<{ severity: "minor" | "major"; message: string }> {
  try {
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) return [];
    const parsed = JSON.parse(match[0]) as {
      issues?: Array<{ severity: string; message: string }>;
    };
    return (parsed.issues ?? []).map((i) => ({
      severity: i.severity === "major" ? "major" : "minor",
      message: i.message,
    }));
  } catch {
    return [];
  }
}
