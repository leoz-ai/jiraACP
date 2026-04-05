import http from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { createLogger } from "../utils/logger.js";
import { loadConfig, detectProjectName } from "../config/loader.js";
import { runPipeline } from "../pipeline/orchestrator.js";
import { loadSchedules, cronMatchesNow } from "./schedule.js";
import { initBot } from "../integrations/telegram/bot.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(
  readFileSync(path.join(__dirname, "..", "package.json"), "utf8"),
) as { version: string };

const logger = createLogger("serve");
const startedAt = Date.now();

interface JiraWebhookPayload {
  issue?: { key?: string };
  ticketKey?: string;
  projectName?: string;
}

function parseBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk: Buffer) => {
      body += chunk.toString();
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

function sendJson(
  res: http.ServerResponse,
  status: number,
  data: Record<string, unknown>,
): void {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

async function handleWebhook(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  secret: string | undefined,
): Promise<void> {
  // Validate secret header if configured
  if (secret) {
    const incoming = req.headers["x-jira-acp-secret"];
    if (incoming !== secret) {
      sendJson(res, 401, { error: "Unauthorized" });
      return;
    }
  }

  const rawBody = await parseBody(req);
  let payload: JiraWebhookPayload;
  try {
    payload = JSON.parse(rawBody) as JiraWebhookPayload;
  } catch {
    sendJson(res, 400, { error: "Invalid JSON body" });
    return;
  }

  const ticketKey = payload.ticketKey ?? payload.issue?.key;
  const projectName = payload.projectName ?? detectProjectName(process.cwd());

  if (!ticketKey) {
    sendJson(res, 400, { error: "Missing ticketKey or issue.key in payload" });
    return;
  }

  logger.info(
    { ticketKey, projectName },
    "Webhook received — triggering pipeline",
  );
  sendJson(res, 202, { accepted: true, ticketKey, projectName });

  // Fire pipeline asynchronously — do not await
  setImmediate(async () => {
    try {
      const config = loadConfig(projectName);
      await runPipeline(ticketKey, config);
    } catch (err) {
      logger.error(
        { ticketKey, err: err instanceof Error ? err.message : String(err) },
        "Pipeline failed via webhook",
      );
    }
  });
}

function startScheduleRunner(): void {
  // Check schedules every minute
  setInterval(async () => {
    const schedules = loadSchedules();
    const now = new Date();
    for (const entry of schedules) {
      if (!entry.enabled) continue;
      if (!cronMatchesNow(entry.cron, now)) continue;

      logger.info(
        { id: entry.id, project: entry.projectName, cron: entry.cron },
        "Scheduled run triggered",
      );

      setImmediate(async () => {
        try {
          const config = loadConfig(entry.projectName);
          await runPipeline("__scheduled__", config);
        } catch (err) {
          logger.error(
            {
              id: entry.id,
              err: err instanceof Error ? err.message : String(err),
            },
            "Scheduled pipeline failed",
          );
        }
      });
    }
  }, 60_000);
}

export async function startServe(port: number): Promise<void> {
  const secret = process.env["JIRA_ACP_WEBHOOK_SECRET"];

  const server = http.createServer(
    (req: http.IncomingMessage, res: http.ServerResponse) => {
      const url = req.url ?? "/";
      const method = req.method ?? "GET";

      logger.info({ method, url }, "Request received");

      if (method === "GET" && url === "/health") {
        sendJson(res, 200, {
          status: "ok",
          version: pkg.version,
          uptimeSeconds: Math.floor((Date.now() - startedAt) / 1_000),
        });
        return;
      }

      if (method === "POST" && url === "/webhook/jira") {
        handleWebhook(req, res, secret).catch((err: unknown) => {
          logger.error(
            { err: err instanceof Error ? err.message : String(err) },
            "Webhook handler error",
          );
          if (!res.headersSent) {
            sendJson(res, 500, { error: "Internal server error" });
          }
        });
        return;
      }

      sendJson(res, 404, { error: "Not found" });
    },
  );

  server.listen(port, () => {
    logger.info({ port }, "jiraACP serve started");
    process.stdout.write(
      `jiraACP serve listening on port ${port}\n` +
        `  POST /webhook/jira  — trigger pipeline via Jira automation\n` +
        `  GET  /health        — health check\n`,
    );
  });

  // Start cron schedule runner
  startScheduleRunner();

  // Start Telegram bot, create system notification topic, send startup message
  interface ProjectNotifier {
    chatId: number | string;
    systemTopicId: number | undefined;
    botToken: string;
  }
  const projectNotifiers: ProjectNotifier[] = [];

  try {
    const { listProjects, loadConfig } = await import("../config/loader.js");
    const { getBot } = await import("../integrations/telegram/bot.js");
    const { getOrCreateSystemTopic } =
      await import("../integrations/telegram/topic-manager.js");

    for (const name of listProjects()) {
      try {
        const cfg = loadConfig(name);
        if (!cfg.telegram?.botToken) continue;

        if (projectNotifiers.length === 0) {
          await initBot(cfg.telegram.botToken);
        }

        const bot = getBot(cfg.telegram.botToken);
        const systemTopicId = await getOrCreateSystemTopic(
          bot,
          cfg.telegram.chatId,
          name,
        ).catch(() => undefined);

        projectNotifiers.push({
          chatId: cfg.telegram.chatId,
          systemTopicId,
          botToken: cfg.telegram.botToken,
        });

        await bot.api
          .sendMessage(
            cfg.telegram.chatId,
            `🟢 <b>jiraACP</b> v${pkg.version} started\nPort: <code>${port}</code> · Project: <b>${name}</b>`,
            {
              parse_mode: "HTML",
              ...(systemTopicId ? { message_thread_id: systemTopicId } : {}),
            },
          )
          .catch(() => undefined);
      } catch {
        // skip misconfigured projects
      }
    }
  } catch (err) {
    logger.warn({ err }, "Failed to init Telegram bot");
  }

  // Graceful shutdown
  async function shutdown(): Promise<void> {
    logger.info("Shutting down serve");

    if (projectNotifiers.length > 0) {
      const { getBot } = await import("../integrations/telegram/bot.js");
      for (const { chatId, systemTopicId, botToken } of projectNotifiers) {
        const bot = getBot(botToken);
        await bot.api
          .sendMessage(chatId, "🔴 <b>jiraACP</b> server shutting down", {
            parse_mode: "HTML",
            ...(systemTopicId ? { message_thread_id: systemTopicId } : {}),
          })
          .catch(() => undefined);
      }
    }

    server.close(() => process.exit(0));
  }

  process.once("SIGINT", () => {
    shutdown().catch(() => process.exit(0));
  });
  process.once("SIGTERM", () => {
    shutdown().catch(() => process.exit(0));
  });

  // Keep process alive
  await new Promise<never>(() => {
    /* intentionally never resolves */
  });
}
