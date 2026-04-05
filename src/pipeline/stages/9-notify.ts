import type { Stage, PipelineContext, StageOutput } from "./types.js";
import {
  transitionTicket,
  addComment,
  reassign,
} from "../../integrations/jira/tools.js";

export const notifyStage: Stage = {
  id: "notify",
  name: "Notify",
  model: "haiku",

  async run(ctx: PipelineContext): Promise<StageOutput> {
    const { config, ticketKey, state } = ctx;
    const current = state.current;

    ctx.logger.info({ ticketKey }, "Notifying: Jira + Telegram");

    if (!ctx.dryRun) {
      // Transition to Done
      await transitionTicket({
        instance: config.jira.instance,
        ticket_key: ticketKey,
        transition_name: config.jira.doneTransition ?? "Done",
      });

      // Add completion comment
      const prInfo = current.prNumber ? `\nPR: #${current.prNumber}` : "";
      const branchInfo = current.branchName
        ? `\nBranch: ${current.branchName}`
        : "";
      await addComment({
        instance: config.jira.instance,
        ticket_key: ticketKey,
        comment: `✅ Implemented via jiraACP automated pipeline.${prInfo}${branchInfo}\n\nAll stages completed: fetch → analyze → code → review → deploy → test`,
      });

      // Reassign if configured
      if (config.jira.reassignTo) {
        await reassign({
          instance: config.jira.instance,
          ticket_key: ticketKey,
          account_id: config.jira.reassignTo,
        });
      }

      // Telegram notification
      await ctx.telegram.sendDone(ticketKey, {
        summary: "Pipeline completed successfully",
        prNumber: current.prNumber ?? undefined,
      });
    }

    ctx.logger.info({ ticketKey }, "Notifications sent");
    return { notified: true };
  },
};
