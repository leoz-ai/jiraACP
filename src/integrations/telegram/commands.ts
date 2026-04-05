import fs from "node:fs";
import path from "node:path";
import axios from "axios";
import type { Context } from "grammy";
import { getBot } from "./bot.js";
import { archiveTopic } from "./topic-manager.js";
import { setVerbosity, type Verbosity } from "./prefs.js";
import { listProjects, loadConfig, HOME_DIR } from "../../config/loader.js";
import { StateManager, getRunDir } from "../../pipeline/state.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function parseArgs(text: string, command: string): string[] {
  return text
    .replace(new RegExp(`^\\/${command}(?:@\\S+)?\\s*`), "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

/** Find project by matching jira.projectKey prefix against ticketKey (e.g. "PROJ" in "PROJ-123") */
function findProjectForTicket(ticketKey: string): string | null {
  const prefix = ticketKey.split("-")[0]?.toUpperCase();
  if (!prefix) return null;

  const projects = listProjects();
  for (const name of projects) {
    try {
      const cfg = loadConfig(name);
      if (cfg.jira.projectKey.toUpperCase() === prefix) return name;
    } catch {
      // skip misconfigured projects
    }
  }
  return projects.length === 1 ? (projects[0] ?? null) : null;
}

function jiraClientFrom(projectName: string) {
  const cfg = loadConfig(projectName);
  return {
    client: axios.create({
      baseURL: `${cfg.jira.url}/rest/api/3`,
      headers: {
        Authorization: `Basic ${Buffer.from(`${cfg.jira.email}:${cfg.jira.token}`).toString("base64")}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
    }),
    cfg,
  };
}

async function reply(ctx: Context, text: string): Promise<void> {
  await ctx.reply(text, { parse_mode: "HTML" });
}

// ── Command handlers ──────────────────────────────────────────────────────────

async function handleRun(ctx: Context): Promise<void> {
  const args = parseArgs(ctx.message?.text ?? "", "run");
  const ticketKey = args[0];
  const projectArg = args[1];

  if (!ticketKey) {
    await reply(ctx, "Usage: /run PROJ-123 [project]");
    return;
  }

  const projectName = projectArg ?? findProjectForTicket(ticketKey);
  if (!projectName) {
    await reply(
      ctx,
      `Cannot determine project for <b>${ticketKey}</b>. Specify: /run ${ticketKey} &lt;project&gt;`,
    );
    return;
  }

  await reply(
    ctx,
    `▶️ Starting pipeline for <b>${ticketKey}</b> (${projectName})…`,
  );

  setImmediate(async () => {
    try {
      const { runPipeline } = await import("../../pipeline/orchestrator.js");
      const config = loadConfig(projectName);
      await runPipeline(ticketKey, config);
    } catch {
      // errors are sent via notifier inside the pipeline
    }
  });
}

async function handleAbort(ctx: Context): Promise<void> {
  const args = parseArgs(ctx.message?.text ?? "", "abort");
  const ticketKey = args[0];
  const projectArg = args[1];

  if (!ticketKey) {
    await reply(ctx, "Usage: /abort PROJ-123 [project]");
    return;
  }

  const projectName = projectArg ?? findProjectForTicket(ticketKey);
  if (!projectName) {
    await reply(ctx, `Cannot determine project for <b>${ticketKey}</b>.`);
    return;
  }

  try {
    const { abortPipeline } = await import("../../commands/abort.js");
    await abortPipeline(ticketKey, projectName, "Aborted via Telegram");
    await reply(ctx, `🛑 Pipeline for <b>${ticketKey}</b> aborted.`);
  } catch (err) {
    await reply(
      ctx,
      `❌ Abort failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

async function handleResume(ctx: Context): Promise<void> {
  const args = parseArgs(ctx.message?.text ?? "", "resume");
  const ticketKey = args[0];
  const projectArg = args[1];

  if (!ticketKey) {
    await reply(ctx, "Usage: /resume PROJ-123 [project]");
    return;
  }

  const projectName = projectArg ?? findProjectForTicket(ticketKey);
  if (!projectName) {
    await reply(ctx, `Cannot determine project for <b>${ticketKey}</b>.`);
    return;
  }

  await reply(
    ctx,
    `🔁 Resuming pipeline for <b>${ticketKey}</b> (${projectName})…`,
  );

  setImmediate(async () => {
    try {
      const { resumePipeline } = await import("../../pipeline/orchestrator.js");
      const config = loadConfig(projectName);
      await resumePipeline(ticketKey, config);
    } catch {
      // errors sent via notifier
    }
  });
}

async function handleStatus(ctx: Context): Promise<void> {
  const args = parseArgs(ctx.message?.text ?? "", "status");
  const ticketKey = args[0];

  const projects = listProjects();
  if (projects.length === 0) {
    await reply(ctx, "No projects configured.");
    return;
  }

  const lines: string[] = ["<b>jiraACP status</b>\n"];

  for (const project of projects) {
    const runsDir = path.join(HOME_DIR, "runs", project);
    if (!fs.existsSync(runsDir)) continue;

    const tickets = ticketKey
      ? [ticketKey]
      : fs
          .readdirSync(runsDir)
          .filter((f) => fs.statSync(path.join(runsDir, f)).isDirectory());

    for (const key of tickets) {
      const runDir = getRunDir(project, key);
      if (!fs.existsSync(path.join(runDir, "state.json"))) continue;

      const state = new StateManager(runDir).current;
      const stage =
        state.currentStage ??
        (state.isCompleted ? "done" : (state.failedStage ?? "—"));

      const statusEmoji = state.isCompleted
        ? "✅"
        : state.isAborted
          ? "🛑"
          : state.pendingClarification
            ? "💬"
            : state.pendingHumanApproval
              ? "👀"
              : "🔄";

      lines.push(`${statusEmoji} <b>${key}</b> — ${stage} <i>(${project})</i>`);
    }
  }

  if (lines.length === 1) lines.push("No active runs.");
  await reply(ctx, lines.join("\n"));
}

async function handleLogs(ctx: Context): Promise<void> {
  const args = parseArgs(ctx.message?.text ?? "", "logs");
  const ticketKey = args[0];
  const projectArg = args[1];

  if (!ticketKey) {
    await reply(ctx, "Usage: /logs PROJ-123 [project]");
    return;
  }

  const projectName = projectArg ?? findProjectForTicket(ticketKey);
  if (!projectName) {
    await reply(ctx, `Cannot determine project for <b>${ticketKey}</b>.`);
    return;
  }

  const runDir = getRunDir(projectName, ticketKey);
  const statePath = path.join(runDir, "state.json");

  if (!fs.existsSync(statePath)) {
    await reply(ctx, `No run found for <b>${ticketKey}</b>.`);
    return;
  }

  const events = fs
    .readFileSync(statePath, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line) as {
          type: string;
          timestamp: string;
          stage?: string;
          error?: string;
          reason?: string;
        };
      } catch {
        return null;
      }
    })
    .filter((e): e is NonNullable<typeof e> => e !== null)
    .slice(-20); // last 20 events

  const lines = [`<b>Logs: ${ticketKey}</b>\n`];
  for (const e of events) {
    const time = new Date(e.timestamp).toLocaleTimeString();
    const detail = e.stage
      ? ` [${e.stage}]`
      : e.reason
        ? ` — ${e.reason.slice(0, 60)}`
        : "";
    lines.push(`<code>${time}</code> ${e.type}${detail}`);
  }

  await reply(ctx, lines.join("\n"));
}

async function handleProjects(ctx: Context): Promise<void> {
  const projects = listProjects();
  if (projects.length === 0) {
    await reply(ctx, "No projects configured.\nRun: <code>jiraACP init</code>");
    return;
  }

  const lines = ["<b>Configured projects</b>\n"];
  for (const name of projects) {
    try {
      const cfg = loadConfig(name);
      lines.push(`• <b>${name}</b> — ${cfg.jira.projectKey} @ ${cfg.jira.url}`);
    } catch {
      lines.push(`• <b>${name}</b> — <i>(config error)</i>`);
    }
  }
  await reply(ctx, lines.join("\n"));
}

async function handleTickets(ctx: Context): Promise<void> {
  const args = parseArgs(ctx.message?.text ?? "", "tickets");
  const projectArg = args[0];

  const projects = listProjects();
  const projectName =
    projectArg ?? (projects.length === 1 ? projects[0] : null);

  if (!projectName) {
    await reply(
      ctx,
      `Specify project: /tickets &lt;project&gt;\nAvailable: ${projects.join(", ")}`,
    );
    return;
  }

  await reply(ctx, `🔍 Fetching tickets for <b>${projectName}</b>…`);

  interface JiraIssue {
    key: string;
    fields: {
      summary: string;
      status: { name: string };
      priority?: { name: string };
      assignee?: { displayName: string } | null;
      fixVersions?: Array<{ name: string }>;
    };
  }

  const STATUS_ICON: Record<string, string> = {
    "In Progress": "🔄",
    "In Review": "👀",
    Done: "✅",
    "Spec Review": "📋",
  };

  try {
    const { client, cfg } = jiraClientFrom(projectName);

    const assigneeJql = cfg.jira.assignees
      .map((a) => `assignee = "${a}"`)
      .join(" OR ");

    // POST /search/jql — groups by fixVersion, same approach as jira_tickets.py
    const { data } = await client.post("/search/jql", {
      jql: `project = ${cfg.jira.projectKey} AND (${assigneeJql}) AND status != Done ORDER BY fixVersion ASC, created DESC`,
      fields: ["summary", "status", "priority", "assignee", "fixVersions"],
      maxResults: 50,
    });

    const issues = (data.issues ?? []) as JiraIssue[];
    if (issues.length === 0) {
      await reply(ctx, "No open tickets found.");
      return;
    }

    // Group by fixVersion
    const grouped = new Map<string, JiraIssue[]>();
    for (const issue of issues) {
      const version = issue.fields.fixVersions?.[0]?.name ?? "Unplanned";
      if (!grouped.has(version)) grouped.set(version, []);
      grouped.get(version)!.push(issue);
    }

    const lines: string[] = [
      `<b>${projectName}</b> — ${issues.length} open tickets\n`,
    ];
    for (const [version, vIssues] of grouped) {
      lines.push(`<b>📦 ${version}</b> (${vIssues.length})`);
      for (const issue of vIssues) {
        const status = issue.fields.status.name;
        const icon = STATUS_ICON[status] ?? "⬜";
        const prio = issue.fields.priority?.name ?? "";
        const assignee = issue.fields.assignee?.displayName ?? "Unassigned";
        lines.push(
          `${icon} <b>${issue.key}</b> ${issue.fields.summary.slice(0, 55)}\n   ${status} · ${prio} · ${assignee}`,
        );
      }
      lines.push("");
    }

    await reply(ctx, lines.join("\n"));
  } catch (err) {
    await reply(
      ctx,
      `❌ Jira error: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

async function handleTicket(ctx: Context): Promise<void> {
  const args = parseArgs(ctx.message?.text ?? "", "ticket");
  const ticketKey = args[0];

  if (!ticketKey) {
    await reply(ctx, "Usage: /ticket PROJ-123");
    return;
  }

  const projectName = findProjectForTicket(ticketKey);
  if (!projectName) {
    await reply(ctx, `Cannot determine project for <b>${ticketKey}</b>.`);
    return;
  }

  try {
    const { client, cfg } = jiraClientFrom(projectName);
    const { data } = await client.get(`/issue/${ticketKey}`);

    function extractText(node: unknown): string {
      if (!node) return "";
      if (typeof node === "string") return node;
      const n = node as { type?: string; text?: string; content?: unknown[] };
      if (n.type === "text") return n.text ?? "";
      if (n.content) return n.content.map(extractText).join(" ");
      return "";
    }

    const description = extractText(data.fields.description).slice(0, 400);
    const ac = extractText(
      data.fields[cfg.jira.acceptanceCriteriaField ?? "customfield_10016"],
    ).slice(0, 300);

    const lines = [
      `<b>${data.key}</b> — ${data.fields.summary}`,
      `Status: ${data.fields.status.name}`,
      `Priority: ${data.fields.priority?.name ?? "—"}`,
      `Assignee: ${data.fields.assignee?.displayName ?? "Unassigned"}`,
    ];

    if (description) lines.push(`\n<b>Description</b>\n${description}`);
    if (ac) lines.push(`\n<b>Acceptance Criteria</b>\n${ac}`);

    await reply(ctx, lines.join("\n"));
  } catch (err) {
    await reply(
      ctx,
      `❌ Jira error: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

async function handleArchive(ctx: Context): Promise<void> {
  const args = parseArgs(ctx.message?.text ?? "", "archive");
  const ticketKey = args[0];
  const projectArg = args[1];

  if (!ticketKey) {
    await reply(ctx, "Usage: /archive PROJ-123 [project]");
    return;
  }

  const projectName = projectArg ?? findProjectForTicket(ticketKey);
  if (!projectName) {
    await reply(ctx, `Cannot determine project for <b>${ticketKey}</b>.`);
    return;
  }

  const chatId = ctx.chat?.id;
  if (!chatId) return;

  try {
    const cfg = loadConfig(projectName);
    const bot = getBot(cfg.telegram.botToken);
    await archiveTopic(bot, chatId, ticketKey, projectName);
    await reply(ctx, `🗂 Topic for <b>${ticketKey}</b> archived.`);
  } catch (err) {
    await reply(
      ctx,
      `❌ Archive failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

async function handleVerbosity(ctx: Context): Promise<void> {
  const args = parseArgs(ctx.message?.text ?? "", "verbosity");
  const chatId = ctx.chat?.id;
  if (!chatId) return;

  const level = args[0] as Verbosity | undefined;
  const valid: Verbosity[] = ["low", "medium", "high"];

  if (!level || !valid.includes(level)) {
    await ctx.reply("Choose verbosity level:", {
      reply_markup: {
        inline_keyboard: [
          [
            { text: "🔕 low", callback_data: `verbosity:low` },
            { text: "🔔 medium", callback_data: `verbosity:medium` },
            { text: "📣 high", callback_data: `verbosity:high` },
          ],
        ],
      },
    });
    return;
  }

  setVerbosity(chatId, level);
  await reply(ctx, `✅ Verbosity set to <b>${level}</b>.`);
}

// ── Registration ──────────────────────────────────────────────────────────────

export function registerBotCommands(token: string): void {
  const bot = getBot(token);

  bot.command("run", (ctx) => handleRun(ctx).catch(() => undefined));
  bot.command("abort", (ctx) => handleAbort(ctx).catch(() => undefined));
  bot.command("resume", (ctx) => handleResume(ctx).catch(() => undefined));
  bot.command("status", (ctx) => handleStatus(ctx).catch(() => undefined));
  bot.command("logs", (ctx) => handleLogs(ctx).catch(() => undefined));
  bot.command("projects", (ctx) => handleProjects(ctx).catch(() => undefined));
  bot.command("tickets", (ctx) => handleTickets(ctx).catch(() => undefined));
  bot.command("ticket", (ctx) => handleTicket(ctx).catch(() => undefined));
  bot.command("archive", (ctx) => handleArchive(ctx).catch(() => undefined));
  bot.command("verbosity", (ctx) =>
    handleVerbosity(ctx).catch(() => undefined),
  );

  // Inline keyboard for verbosity
  bot.on("callback_query:data", async (ctx) => {
    const data = ctx.callbackQuery.data ?? "";
    if (!data.startsWith("verbosity:")) return;

    const level = data.slice("verbosity:".length) as Verbosity;
    const chatId = ctx.chat?.id;
    if (chatId) setVerbosity(chatId, level);

    await ctx.answerCallbackQuery({ text: `Verbosity set to ${level}` });
    await ctx.editMessageReplyMarkup({ reply_markup: { inline_keyboard: [] } });
  });
}
