import type { TelegramNotifier } from "../integrations/telegram/notifier.js";
import { getEvents } from "./state.js";
import { estimateCostUsd, extractTokenUsage } from "../utils/pricing.js";

export async function checkCostLimit(opts: {
  runDir: string;
  maxCostUsd: number;
  telegram: TelegramNotifier;
  ticketKey: string;
}): Promise<"continue" | "abort"> {
  const events = getEvents(opts.runDir);

  let totalCost = 0;

  for (const event of events) {
    if (event.type !== "STAGE_COMPLETED") continue;
    const tu = extractTokenUsage(event.output);
    if (!tu) continue;
    totalCost += estimateCostUsd(tu.inputTokens, tu.outputTokens, tu.model);
  }

  if (totalCost >= opts.maxCostUsd) {
    await opts.telegram.send(
      `⛔ <b>${opts.ticketKey}</b> — Cost limit reached ($${totalCost.toFixed(4)} / $${opts.maxCostUsd}). Aborting pipeline.`,
    );
    return "abort";
  }

  if (totalCost >= 0.8 * opts.maxCostUsd) {
    await opts.telegram.send(
      `⚠️ <b>${opts.ticketKey}</b> — Cost at 80% of limit ($${totalCost.toFixed(4)} / $${opts.maxCostUsd}).`,
    );
  }

  return "continue";
}
