import type { Stage, PipelineContext, StageOutput } from "./types.js";
import { requestClarification } from "../../integrations/telegram/human-loop.js";
import { appendClarifications } from "../../memory/context-builder.js";
import path from "node:path";

export const clarifyStage: Stage = {
  id: "clarify",
  name: "Clarify",
  model: "haiku",

  async shouldSkip(ctx: PipelineContext): Promise<boolean> {
    const lastAnalyze = ctx.state.current.completedStages.includes("analyze");
    if (!lastAnalyze) return true;
    // Read analysis output from event log
    const events = (
      ctx.state as unknown as {
        events: Array<{ type: string; stage?: string; output?: unknown }>;
      }
    ).events;
    const analyzeEvent = events.findLast(
      (e) => e.type === "STAGE_COMPLETED" && e.stage === "analyze",
    );
    const output = analyzeEvent?.output as
      | { needsClarification?: boolean }
      | undefined;
    return !output?.needsClarification;
  },

  async run(ctx: PipelineContext): Promise<StageOutput> {
    const { config, ticketKey, memoryDir } = ctx;
    const storeDir = path.join(config.workspace.rootDir, ".jira-acp");

    // Get questions from analyze stage output
    const events = (
      ctx.state as unknown as {
        events: Array<{ type: string; stage?: string; output?: unknown }>;
      }
    ).events;
    const analyzeEvent = events.findLast(
      (e) => e.type === "STAGE_COMPLETED" && e.stage === "analyze",
    );
    const questions = (analyzeEvent?.output as { questions?: string[] })
      ?.questions ?? ["Please clarify the ticket requirements."];

    ctx.logger.info(
      { ticketKey, questions },
      "Requesting clarification via Telegram",
    );

    const hil = config.telegram.humanInTheLoop;
    const answers = await requestClarification(
      config.telegram.botToken,
      config.telegram.chatId,
      ticketKey,
      questions,
      storeDir,
      {
        timeoutMs: hil?.clarificationTimeoutMs ?? 3_600_000,
        onTimeout: hil?.clarificationTimeoutAction ?? "skip",
      },
    );

    appendClarifications(memoryDir, answers);
    ctx.logger.info({ ticketKey }, "Clarifications received and saved");

    return { clarified: true, answers };
  },
};
