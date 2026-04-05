import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import pc from "picocolors";
import { StateManager } from "../pipeline/state.js";
import { listProjects } from "../config/loader.js";

const RUNS_DIR = path.join(os.homedir(), ".jira-acp", "runs");
const REFRESH_MS = 5_000;
const STALE_AFTER_MS = 24 * 60 * 60 * 1_000; // 24h

interface RunRow {
  project: string;
  ticketKey: string;
  stage: string;
  status: string;
  statusRaw: "running" | "waiting" | "completed" | "aborted" | "failed";
  elapsed: string;
  startedAt: string | null;
}

function collectRuns(): RunRow[] {
  const projects = listProjects();
  const rows: RunRow[] = [];
  const cutoff = Date.now() - STALE_AFTER_MS;

  for (const project of projects) {
    const projectRunsDir = path.join(RUNS_DIR, project);
    if (!fs.existsSync(projectRunsDir)) continue;

    const tickets = fs
      .readdirSync(projectRunsDir)
      .filter((f) => fs.statSync(path.join(projectRunsDir, f)).isDirectory())
      .filter((f) => f !== "__triage__");

    for (const ticketKey of tickets) {
      const runDir = path.join(projectRunsDir, ticketKey);
      const stateFile = path.join(runDir, "state.json");
      if (!fs.existsSync(stateFile)) continue;

      try {
        const state = new StateManager(runDir).current;

        // Skip stale completed/aborted runs older than 24h
        if ((state.isCompleted || state.isAborted) && state.startedAt) {
          if (new Date(state.startedAt).getTime() < cutoff) continue;
        }

        const stage =
          state.currentStage ??
          (state.isCompleted ? "done" : (state.failedStage ?? "—"));

        let statusRaw: RunRow["statusRaw"];
        let statusLabel: string;

        if (state.isCompleted) {
          statusRaw = "completed";
          statusLabel = pc.green("completed");
        } else if (state.isAborted) {
          statusRaw = "aborted";
          statusLabel = pc.red("aborted");
        } else if (state.failedStage) {
          statusRaw = "failed";
          statusLabel = pc.red("failed");
        } else if (state.pendingClarification || state.pendingHumanApproval) {
          statusRaw = "waiting";
          statusLabel = pc.yellow("waiting");
        } else {
          statusRaw = "running";
          statusLabel = pc.cyan("running");
        }

        const elapsed = state.startedAt ? formatElapsed(state.startedAt) : "—";

        rows.push({
          project,
          ticketKey,
          stage: String(stage),
          status: statusLabel,
          statusRaw,
          elapsed,
          startedAt: state.startedAt,
        });
      } catch {
        // Corrupted state file — skip
      }
    }
  }

  // Sort: running first, then by startedAt desc
  return rows.sort((a, b) => {
    const order: Record<RunRow["statusRaw"], number> = {
      running: 0,
      waiting: 1,
      failed: 2,
      aborted: 3,
      completed: 4,
    };
    const diff = order[a.statusRaw] - order[b.statusRaw];
    if (diff !== 0) return diff;
    return (b.startedAt ?? "").localeCompare(a.startedAt ?? "");
  });
}

function formatElapsed(startedAt: string): string {
  const ms = Date.now() - new Date(startedAt).getTime();
  const secs = Math.floor(ms / 1_000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ${secs % 60}s`;
  const hours = Math.floor(mins / 60);
  return `${hours}h ${mins % 60}m`;
}

function render(watch: boolean): void {
  if (watch) {
    process.stdout.write("\x1b[2J\x1b[H"); // clear screen + move cursor to top
  }

  const rows = collectRuns();
  const now = new Date().toLocaleTimeString();

  process.stdout.write(
    `\n${pc.bold("  jiraACP dashboard")}${watch ? `  ${pc.gray(`(refreshes every ${REFRESH_MS / 1000}s — updated ${now})`)}` : ""}\n\n`,
  );

  if (rows.length === 0) {
    process.stdout.write(
      pc.gray("  No active or recent pipeline runs found.\n"),
    );
    process.stdout.write(
      pc.gray("  Start one with: jiraACP run <ticketKey>\n\n"),
    );
    return;
  }

  const col = { project: 18, ticket: 14, stage: 12, elapsed: 10, status: 22 };
  process.stdout.write(
    pc.bold(
      `  ${"Project".padEnd(col.project)} ${"Ticket".padEnd(col.ticket)} ${"Stage".padEnd(col.stage)} ${"Elapsed".padEnd(col.elapsed)} Status`,
    ) + "\n",
  );
  process.stdout.write(
    "  " +
      "─".repeat(
        col.project + col.ticket + col.stage + col.elapsed + col.status + 4,
      ) +
      "\n",
  );

  for (const row of rows) {
    process.stdout.write(
      `  ${row.project.padEnd(col.project)} ${row.ticketKey.padEnd(col.ticket)} ${row.stage.padEnd(col.stage)} ${row.elapsed.padEnd(col.elapsed)} ${row.status}\n`,
    );
  }
  process.stdout.write("\n");
}

export function runDashboard(watch: boolean): void {
  render(watch);

  if (!watch) return;

  // Keep refreshing until Ctrl+C
  const interval = setInterval(() => render(true), REFRESH_MS);

  process.once("SIGINT", () => {
    clearInterval(interval);
    process.stdout.write("\n");
    process.exit(0);
  });
}
