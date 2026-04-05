import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import pc from "picocolors";
import { getEvents } from "../pipeline/state.js";
import { estimateCostUsd, extractTokenUsage } from "../utils/pricing.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("usage");

export interface UsageOptions {
  month?: string; // "YYYY-MM" format
  project?: string; // filter by project name
  verbose?: boolean; // show per-stage breakdown
}

interface ProjectStats {
  runs: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  stages: Record<string, StageStats>;
}

interface StageStats {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  count: number;
}

const RUNS_DIR = path.join(os.homedir(), ".jira-acp", "runs");

function formatNumber(n: number): string {
  return n.toLocaleString("en-US");
}

function formatCost(n: number): string {
  return `$${n.toFixed(2)}`;
}

function padEnd(s: string, len: number): string {
  return s.length >= len ? s : s + " ".repeat(len - s.length);
}

function padStart(s: string, len: number): string {
  return s.length >= len ? s : " ".repeat(len - s.length) + s;
}

export async function showUsage(opts: UsageOptions): Promise<void> {
  log.debug({ opts }, "showUsage called");

  if (!fs.existsSync(RUNS_DIR)) {
    process.stdout.write("No runs directory found at ~/.jira-acp/runs/\n");
    return;
  }

  const projectDirs = fs.readdirSync(RUNS_DIR).filter((entry) => {
    try {
      return fs.statSync(path.join(RUNS_DIR, entry)).isDirectory();
    } catch {
      return false;
    }
  });

  const stats: Record<string, ProjectStats> = {};
  let totalTokensFound = false;

  for (const projectName of projectDirs) {
    if (opts.project && projectName !== opts.project) continue;

    const projectRunsDir = path.join(RUNS_DIR, projectName);
    const ticketDirs = fs.readdirSync(projectRunsDir).filter((entry) => {
      if (entry === "__triage__") return false;
      try {
        return fs.statSync(path.join(projectRunsDir, entry)).isDirectory();
      } catch {
        return false;
      }
    });

    for (const ticketKey of ticketDirs) {
      const runDir = path.join(projectRunsDir, ticketKey);
      const events = getEvents(runDir);

      // Determine run month from STARTED event
      const startedEvent = events.find((e) => e.type === "STARTED");
      if (!startedEvent) continue;

      const runMonth = startedEvent.timestamp.slice(0, 7); // "YYYY-MM"
      if (opts.month && runMonth !== opts.month) continue;

      // Check if any STAGE_COMPLETED events have tokenUsage
      let runHasTokens = false;

      for (const event of events) {
        if (event.type !== "STAGE_COMPLETED") continue;

        const tu = extractTokenUsage(event.output);
        if (!tu) continue;

        const { inputTokens, outputTokens, model } = tu;
        const cost = estimateCostUsd(inputTokens, outputTokens, model);

        totalTokensFound = true;
        runHasTokens = true;

        if (!stats[projectName]) {
          stats[projectName] = {
            runs: 0,
            inputTokens: 0,
            outputTokens: 0,
            costUsd: 0,
            stages: {},
          };
        }

        stats[projectName].inputTokens += inputTokens;
        stats[projectName].outputTokens += outputTokens;
        stats[projectName].costUsd += cost;

        if (opts.verbose) {
          const stageName = event.stage;
          if (!stats[projectName].stages[stageName]) {
            stats[projectName].stages[stageName] = {
              inputTokens: 0,
              outputTokens: 0,
              costUsd: 0,
              count: 0,
            };
          }
          stats[projectName].stages[stageName].inputTokens += inputTokens;
          stats[projectName].stages[stageName].outputTokens += outputTokens;
          stats[projectName].stages[stageName].costUsd += cost;
          stats[projectName].stages[stageName].count += 1;
        }
      }

      if (runHasTokens) {
        stats[projectName].runs += 1;
      }
    }
  }

  if (!totalTokensFound) {
    process.stdout.write(
      "No token usage data found. Token tracking requires stage outputs to include tokenUsage field.\n",
    );
    return;
  }

  const monthLabel = opts.month ?? "all time";
  process.stdout.write(
    `\n  ${pc.bold("jiraACP usage report")} — ${pc.cyan(monthLabel)}\n\n`,
  );

  const COL_PROJECT = 24;
  const COL_RUNS = 6;
  const COL_INPUT = 15;
  const COL_OUTPUT = 15;
  const COL_COST = 11;
  const SEPARATOR_LEN =
    COL_PROJECT + COL_RUNS + COL_INPUT + COL_OUTPUT + COL_COST + 4;

  const header =
    "  " +
    padEnd("Project", COL_PROJECT) +
    padStart("Runs", COL_RUNS) +
    padStart("Input tokens", COL_INPUT) +
    padStart("Output tokens", COL_OUTPUT) +
    padStart("Est. cost", COL_COST);

  const separator = "  " + pc.dim("─".repeat(SEPARATOR_LEN));

  process.stdout.write(pc.bold(header) + "\n");
  process.stdout.write(separator + "\n");

  let totalRuns = 0;
  let totalInput = 0;
  let totalOutput = 0;
  let totalCost = 0;

  for (const [projectName, s] of Object.entries(stats)) {
    totalRuns += s.runs;
    totalInput += s.inputTokens;
    totalOutput += s.outputTokens;
    totalCost += s.costUsd;

    const row =
      "  " +
      padEnd(projectName, COL_PROJECT) +
      padStart(String(s.runs), COL_RUNS) +
      padStart(formatNumber(s.inputTokens), COL_INPUT) +
      padStart(formatNumber(s.outputTokens), COL_OUTPUT) +
      padStart(pc.green(formatCost(s.costUsd)), COL_COST);

    process.stdout.write(row + "\n");

    if (opts.verbose && Object.keys(s.stages).length > 0) {
      for (const [stageName, st] of Object.entries(s.stages)) {
        const stageRow =
          "    " +
          pc.dim(padEnd(`↳ ${stageName}`, COL_PROJECT - 2)) +
          padStart(String(st.count), COL_RUNS) +
          padStart(formatNumber(st.inputTokens), COL_INPUT) +
          padStart(formatNumber(st.outputTokens), COL_OUTPUT) +
          padStart(pc.dim(formatCost(st.costUsd)), COL_COST);
        process.stdout.write(stageRow + "\n");
      }
    }
  }

  process.stdout.write(separator + "\n");

  const totalRow =
    "  " +
    padEnd(pc.bold("TOTAL"), COL_PROJECT) +
    padStart(pc.bold(String(totalRuns)), COL_RUNS) +
    padStart(pc.bold(formatNumber(totalInput)), COL_INPUT) +
    padStart(pc.bold(formatNumber(totalOutput)), COL_OUTPUT) +
    padStart(pc.bold(pc.green(formatCost(totalCost))), COL_COST);

  process.stdout.write(totalRow + "\n\n");
}
