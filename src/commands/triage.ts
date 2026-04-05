import pc from "picocolors";
import { loadConfig } from "../config/loader.js";
import { createLogger } from "../utils/logger.js";
import { getClient as getJiraClient } from "../integrations/jira/client.js";
import { createTelegramNotifier } from "../integrations/telegram/notifier.js";
import { analyzeStage } from "../pipeline/stages/2-analyze.js";
import { fetchStage } from "../pipeline/stages/1-fetch.js";
import type { PipelineContext } from "../pipeline/stages/types.js";
import { StateManager, getRunDir, getMemoryDir } from "../pipeline/state.js";
import { createGitHubClient } from "../integrations/github/client.js";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

export interface TriageOptions {
  projectName: string;
  sprint?: string;
  dryRun?: boolean;
}

interface TriageResult {
  ticketKey: string;
  title: string;
  score: number;
  needsClarification: boolean;
  missing: string[];
  questions: string[];
  error?: string;
}

const MAX_PARALLEL = 5;

export async function runTriage(opts: TriageOptions): Promise<void> {
  const logger = createLogger("triage");
  const config = loadConfig(opts.projectName);
  const jiraClient = getJiraClient(config.jira.instance);

  logger.info({ project: opts.projectName }, "Starting triage");
  process.stdout.write(
    `\n${pc.bold("jiraACP triage")} — ${opts.projectName}\n\n`,
  );

  // Fetch all assigned tickets (reuse fetch stage logic)
  const tmpRunDir = path.join(
    os.homedir(),
    ".jira-acp",
    "runs",
    opts.projectName,
    "__triage__",
  );
  fs.mkdirSync(tmpRunDir, { recursive: true });

  const tmpState = new StateManager(tmpRunDir);
  const tmpMemoryDir = getMemoryDir(opts.projectName, "__triage__");
  fs.mkdirSync(tmpMemoryDir, { recursive: true });

  const baseCtx: PipelineContext = {
    config,
    ticketKey: "__triage__",
    projectDir: config.workspace.rootDir,
    state: tmpState,
    memoryDir: tmpMemoryDir,
    dryRun: opts.dryRun ?? false,
    logger,
    jira: jiraClient,
    github: createGitHubClient(
      config.github.token,
      config.github.owner,
      config.github.repo,
    ),
    telegram: createTelegramNotifier(
      config.telegram.botToken,
      config.telegram.chatId,
      config.telegram.topicId,
    ),
  };

  // Fetch tickets
  process.stdout.write("Fetching sprint tickets from Jira...\n");
  let fetchOutput: Record<string, unknown>;
  try {
    fetchOutput = (await fetchStage.run(baseCtx)) as Record<string, unknown>;
  } catch (err) {
    process.stderr.write(
      `Failed to fetch tickets: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exitCode = 1;
    return;
  }

  const tickets = fetchOutput["tickets"] as Array<{
    key: string;
    summary: string;
  }>;

  if (!tickets || tickets.length === 0) {
    process.stdout.write(
      pc.gray("  No assigned tickets found in current sprint.\n\n"),
    );
    return;
  }

  process.stdout.write(
    `Found ${pc.bold(String(tickets.length))} tickets — analyzing...\n\n`,
  );

  // Analyze tickets in parallel batches of MAX_PARALLEL
  const results: TriageResult[] = [];
  for (let i = 0; i < tickets.length; i += MAX_PARALLEL) {
    const batch = tickets.slice(i, i + MAX_PARALLEL);
    const batchResults = await Promise.allSettled(
      batch.map((ticket) =>
        analyzeTicket(ticket, opts, config, logger).catch(
          (err): TriageResult => ({
            ticketKey: ticket.key,
            title: ticket.summary,
            score: 0,
            needsClarification: true,
            missing: [],
            questions: [],
            error: err instanceof Error ? err.message : String(err),
          }),
        ),
      ),
    );
    for (const r of batchResults) {
      if (r.status === "fulfilled") {
        results.push(r.value);
      }
    }
  }

  // Print triage table
  printTriageTable(results);

  // Batch clarification digest to Telegram
  const needsClarification = results.filter(
    (r) => r.needsClarification && !r.error,
  );
  if (needsClarification.length > 0 && !opts.dryRun) {
    await sendClarificationDigest(config, needsClarification, logger);
  }

  // Summary
  const clear = results.filter((r) => !r.needsClarification && !r.error).length;
  const clarify = needsClarification.length;
  const errors = results.filter((r) => r.error).length;

  process.stdout.write(
    `\nSummary: ${pc.green(`${clear} clear`)}  ${pc.yellow(`${clarify} need clarification`)}  ${errors > 0 ? pc.red(`${errors} errors`) : ""}\n\n`,
  );
}

async function analyzeTicket(
  ticket: { key: string; summary: string },
  opts: TriageOptions,
  config: ReturnType<typeof loadConfig>,
  logger: ReturnType<typeof createLogger>,
): Promise<TriageResult> {
  const runDir = getRunDir(opts.projectName, ticket.key);
  fs.mkdirSync(runDir, { recursive: true });
  const memoryDir = getMemoryDir(opts.projectName, ticket.key);
  fs.mkdirSync(memoryDir, { recursive: true });

  const ctx: PipelineContext = {
    config,
    ticketKey: ticket.key,
    projectDir: config.workspace.rootDir,
    state: new StateManager(runDir),
    memoryDir,
    dryRun: opts.dryRun ?? false,
    logger,
    jira: getJiraClient(config.jira.instance),
    github: createGitHubClient(
      config.github.token,
      config.github.owner,
      config.github.repo,
    ),
    telegram: createTelegramNotifier(
      config.telegram.botToken,
      config.telegram.chatId,
      config.telegram.topicId,
    ),
  };

  try {
    const output = (await analyzeStage.run(ctx)) as Record<string, unknown>;
    return {
      ticketKey: ticket.key,
      title: ticket.summary,
      score: (output["score"] as number) ?? 0,
      needsClarification: (output["needsClarification"] as boolean) ?? false,
      missing: (output["missing"] as string[]) ?? [],
      questions: (output["questions"] as string[]) ?? [],
    };
  } catch (err) {
    return {
      ticketKey: ticket.key,
      title: ticket.summary,
      score: 0,
      needsClarification: true,
      missing: [],
      questions: [],
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function printTriageTable(results: TriageResult[]): void {
  const col = { key: 14, title: 40, score: 8, status: 22 };
  const header = `  ${"Ticket".padEnd(col.key)} ${"Title".padEnd(col.title)} ${"Score".padEnd(col.score)} Status`;
  process.stdout.write(pc.bold(header) + "\n");
  process.stdout.write(
    "  " + "─".repeat(col.key + col.title + col.score + 24) + "\n",
  );

  for (const r of results) {
    const key = r.ticketKey.padEnd(col.key);
    const title = r.title.slice(0, col.title - 1).padEnd(col.title);
    const scoreStr = r.error ? "err" : `${(r.score * 100).toFixed(0)}%`;
    const score = scoreStr.padEnd(col.score);
    const status = r.error
      ? pc.red("error")
      : r.needsClarification
        ? pc.yellow("needs clarification")
        : pc.green("clear");

    process.stdout.write(`  ${key} ${title} ${score} ${status}\n`);

    if (r.needsClarification && r.missing.length > 0) {
      for (const m of r.missing) {
        process.stdout.write(
          `  ${" ".repeat(col.key + 1)}${pc.gray(`  • ${m}`)}\n`,
        );
      }
    }
  }
}

async function sendClarificationDigest(
  config: ReturnType<typeof loadConfig>,
  tickets: TriageResult[],
  logger: ReturnType<typeof createLogger>,
): Promise<void> {
  const notifier = createTelegramNotifier(
    config.telegram.botToken,
    config.telegram.chatId,
    config.telegram.topicId,
  );

  const lines = [
    `📋 <b>Triage Digest</b> — ${tickets.length} ticket(s) need clarification`,
    "",
  ];

  for (const t of tickets) {
    lines.push(`<b>${t.ticketKey}</b>: ${t.title}`);
    for (const q of t.questions) {
      lines.push(`  • ${q}`);
    }
    lines.push("");
  }

  lines.push(
    "Use <code>/answer TICKET-KEY</code> to respond to individual tickets.",
  );

  try {
    await notifier.send(lines.join("\n"));
    logger.info(
      { count: tickets.length },
      "Clarification digest sent to Telegram",
    );
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "Failed to send Telegram digest",
    );
  }
}
