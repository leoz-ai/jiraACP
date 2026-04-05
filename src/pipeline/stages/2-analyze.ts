import type { Stage, PipelineContext, StageOutput } from "./types.js";
import { runAgent } from "../runner.js";
import { readTicketContext } from "../../memory/context-builder.js";

const CLARITY_PROMPT = (ticketCtx: string, requiredFields: string[]) =>
  `
Analyze this Jira ticket for clarity. Score from 0.0 to 1.0.

Required fields: ${requiredFields.join(", ")}

Ticket:
${ticketCtx}

Reply with JSON only:
{
  "score": 0.0-1.0,
  "missing": ["list of missing or ambiguous items"],
  "questions": ["specific questions to ask the team"]
}
`.trim();

export const analyzeStage: Stage = {
  id: "analyze",
  name: "Analyze Clarity",
  model: "sonnet",

  async run(ctx: PipelineContext): Promise<StageOutput> {
    const { config, memoryDir, ticketKey } = ctx;

    const ticketCtx = readTicketContext(memoryDir);
    if (!ticketCtx)
      throw new Error("ticket-context.md not found — run fetch stage first");

    ctx.logger.info({ ticketKey }, "Analyzing ticket clarity");

    const raw = await runAgent({
      prompt: CLARITY_PROMPT(
        ticketCtx,
        config.jira.requiredFields ?? ["description", "acceptanceCriteria"],
      ),
      workdir: config.workspace.rootDir,
      model: "haiku",
      timeoutMs: 60_000,
      stallTimeoutMs: 30_000,
    });

    // Extract JSON from agent output
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      ctx.logger.warn(
        { ticketKey },
        "Could not parse clarity JSON — defaulting to low score",
      );
      return { score: 0, missing: [], questions: [], needsClarification: true };
    }

    const result = JSON.parse(jsonMatch[0]) as {
      score: number;
      missing: string[];
      questions: string[];
    };

    const threshold = config.jira.clarityScoreThreshold ?? 0.7;
    const needsClarification = result.score < threshold;

    ctx.logger.info(
      { ticketKey, score: result.score, threshold, needsClarification },
      "Clarity analysis done",
    );

    return { ...result, needsClarification };
  },
};
