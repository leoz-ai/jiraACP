import type { Stage, PipelineContext, StageOutput } from "./types.js";
import { runAgent, detectComplexity } from "../runner.js";
import {
  getContextFilesForStage,
  readTicketContext,
} from "../../memory/context-builder.js";

export const codeStage: Stage = {
  id: "code",
  name: "Code",
  model: "sonnet",

  async run(ctx: PipelineContext): Promise<StageOutput> {
    const { config, ticketKey, memoryDir, projectDir } = ctx;

    const ticketCtx = readTicketContext(memoryDir);
    const contextFiles = getContextFilesForStage(projectDir, memoryDir, "code");

    const model = detectComplexity(ticketCtx);
    ctx.logger.info({ ticketKey, model }, "Starting code agent");

    const branchName = buildBranchName(
      config.github.branchPattern ?? "feature/{ticketKey}-{slug}",
      ticketKey,
      ticketCtx,
    );

    const prompt = `
Implement the following Jira ticket: ${ticketKey}

Read the ticket context from the provided context files.

Requirements:
1. Create branch: ${branchName}
2. Implement all acceptance criteria
3. Write tests for new functionality
4. Commit with message: "${ticketKey}: <short description>"
5. Do NOT push — pipeline will handle git operations

Branch naming: ${branchName}
Workspace: ${config.workspace.rootDir}
${config.workspace.buildCommand ? `Build command: ${config.workspace.buildCommand}` : ""}
`.trim();

    if (!ctx.dryRun) {
      await runAgent({
        prompt,
        workdir: config.workspace.rootDir,
        model,
        contextFiles,
        timeoutMs: config.pipeline?.stageTimeouts?.code ?? 1_800_000,
        stallTimeoutMs: config.pipeline?.agentStallTimeoutMs ?? 300_000,
      });
    }

    ctx.logger.info({ ticketKey, branchName }, "Code agent completed");
    return { branchName };
  },
};

function buildBranchName(
  pattern: string,
  ticketKey: string,
  ticketCtx: string,
): string {
  const summaryLine = ticketCtx
    .split("\n")
    .find((l) => l.startsWith("## Summary"));
  const nextLine = summaryLine
    ? (ticketCtx.split("\n")[ticketCtx.split("\n").indexOf(summaryLine) + 1] ??
      "")
    : "";
  const slug = nextLine
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .slice(0, 40);

  return pattern
    .replace("{ticketKey}", ticketKey)
    .replace("{prefix}", "feature")
    .replace("{slug}", slug || "implementation");
}
