import type { Stage, PipelineContext, StageOutput } from "./types.js";
import { getTasks, getTicket } from "../../integrations/jira/tools.js";
import { writeTicketContext } from "../../memory/context-builder.js";

export const fetchStage: Stage = {
  id: "fetch",
  name: "Fetch Ticket",
  model: "haiku",

  async run(ctx: PipelineContext): Promise<StageOutput> {
    const { config, ticketKey, memoryDir } = ctx;

    ctx.logger.info({ ticketKey }, "Fetching ticket from Jira");

    const raw = await getTicket({
      instance: config.jira.instance,
      ticket_key: ticketKey,
    });
    const ticket = JSON.parse(raw) as {
      key: string;
      summary: string;
      status: string;
      assignee: string;
      priority: string;
      description: string;
      acceptance_criteria: string;
    };

    writeTicketContext(memoryDir, {
      key: ticket.key,
      summary: ticket.summary,
      description: ticket.description ?? "",
      acceptanceCriteria: ticket.acceptance_criteria ?? "",
      priority: ticket.priority ?? "Medium",
    });

    ctx.logger.info({ ticketKey, summary: ticket.summary }, "Ticket fetched");

    return {
      summary: ticket.summary,
      description: ticket.description,
      acceptanceCriteria: ticket.acceptance_criteria,
      status: ticket.status,
    };
  },
};
