import path from "node:path";
import os from "node:os";
import { Bot } from "grammy";
import { createLogger } from "../../utils/logger.js";

let _bot: Bot | null = null;
let _polling = false;

const STORE_DIR = path.join(os.homedir(), ".jira-acp");

export function getBot(token: string): Bot {
  if (!_bot) {
    _bot = new Bot(token);
  }
  return _bot;
}

export function resetBot(): void {
  _bot = null;
  _polling = false;
}

/**
 * One-time bot setup: registers all command handlers, pushes command menu to
 * Telegram, and starts long-polling in the background.
 * Safe to call multiple times — idempotent after first call.
 */
export async function initBot(token: string): Promise<void> {
  const logger = createLogger("telegram:bot");
  const bot = getBot(token);

  if (_polling) return;
  _polling = true;

  const { registerAnswerHandler, registerApprovalHandlers, loadPendingStore } =
    await import("./human-loop.js");
  const { registerBotCommands } = await import("./commands.js");

  loadPendingStore(STORE_DIR);
  registerAnswerHandler(token, STORE_DIR);
  registerApprovalHandlers(token);
  registerBotCommands(token);

  await bot.api.setMyCommands([
    // Pipeline control
    { command: "run", description: "Start pipeline: /run PROJ-123 [project]" },
    { command: "abort", description: "Abort pipeline: /abort PROJ-123" },
    { command: "resume", description: "Resume pipeline: /resume PROJ-123" },
    // Monitoring
    {
      command: "status",
      description: "Show pipeline status: /status [PROJ-123]",
    },
    { command: "logs", description: "Show recent events: /logs PROJ-123" },
    // Jira
    {
      command: "tickets",
      description: "List sprint tickets: /tickets [project]",
    },
    { command: "ticket", description: "View ticket detail: /ticket PROJ-123" },
    // Human-in-the-loop
    {
      command: "answer",
      description: "Reply to clarification: /answer PROJ-123\\n1. answer",
    },
    { command: "approve", description: "Approve PR review: /approve PROJ-123" },
    { command: "reject", description: "Reject PR review: /reject PROJ-123" },
    // Utility
    { command: "projects", description: "List configured projects" },
    { command: "archive", description: "Archive topic: /archive PROJ-123" },
    {
      command: "verbosity",
      description: "Set notification level: /verbosity low|medium|high",
    },
  ]);

  logger.info("Telegram commands registered");

  bot.start().catch((err: unknown) => {
    logger.error({ err }, "Telegram bot polling error");
  });

  logger.info("Telegram bot polling started");
}
