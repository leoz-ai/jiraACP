import fs from "node:fs";
import pc from "picocolors";
import { getRunDir, getEvents } from "../pipeline/state.js";
import type { PipelineEvent } from "../pipeline/state.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("replay");

function formatTime(iso: string): string {
  return iso.slice(11, 19);
}

function elapsedSeconds(from: string, to: string): string {
  const diff = new Date(to).getTime() - new Date(from).getTime();
  return `${(diff / 1000).toFixed(1)}s`;
}

function printEvent(event: PipelineEvent, startedAt: string | null): void {
  const ts = pc.gray(`[${formatTime(event.timestamp)}]`);

  switch (event.type) {
    case "STARTED":
      process.stdout.write(`${ts} ${pc.cyan("▶ STARTED")}\n`);
      break;

    case "STAGE_STARTED":
      process.stdout.write(
        `${ts} ${pc.blue(`  → stage:${event.stage} started`)}\n`,
      );
      break;

    case "STAGE_COMPLETED": {
      const elapsed = startedAt
        ? pc.gray(` (${elapsedSeconds(startedAt, event.timestamp)})`)
        : "";
      process.stdout.write(
        `${ts} ${pc.green(`  ✓ stage:${event.stage}`)}${elapsed}\n`,
      );
      break;
    }

    case "STAGE_FAILED":
      process.stdout.write(
        `${ts} ${pc.red(`  ✗ stage:${event.stage}  ${event.error}`)}\n`,
      );
      break;

    case "STAGE_SKIPPED":
      process.stdout.write(
        `${ts} ${pc.gray(`  ⊘ stage:${event.stage} skipped — ${event.reason}`)}\n`,
      );
      break;

    case "CLARIFICATION_REQUESTED": {
      process.stdout.write(
        `${ts} ${pc.yellow("  ⚠ CLARIFICATION REQUESTED")}\n`,
      );
      for (const q of event.questions) {
        process.stdout.write(`       ${pc.yellow("•")} ${q}\n`);
      }
      break;
    }

    case "CLARIFICATION_RECEIVED": {
      const preview = event.answers.slice(0, 80);
      process.stdout.write(
        `${ts} ${pc.green("  ✓ CLARIFICATION RECEIVED")} ${pc.gray(preview)}\n`,
      );
      break;
    }

    case "HUMAN_APPROVAL_REQUESTED":
      process.stdout.write(
        `${ts} ${pc.yellow("  ⚠ HUMAN APPROVAL REQUESTED")}\n`,
      );
      break;

    case "HUMAN_APPROVED":
      process.stdout.write(`${ts} ${pc.green("  ✓ HUMAN APPROVED")}\n`);
      break;

    case "HUMAN_REJECTED":
      process.stdout.write(
        `${ts} ${pc.red(`  ✗ HUMAN REJECTED  ${event.reason}`)}\n`,
      );
      break;

    case "PIPELINE_COMPLETED": {
      const elapsed = startedAt
        ? pc.gray(` (${elapsedSeconds(startedAt, event.timestamp)})`)
        : "";
      process.stdout.write(
        `${ts} ${pc.bold(pc.green("✓ PIPELINE COMPLETED"))}${elapsed}\n`,
      );
      break;
    }

    case "PIPELINE_ABORTED": {
      const reason = event.reason ? ` — ${event.reason}` : "";
      process.stdout.write(
        `${ts} ${pc.bold(pc.red(`✗ PIPELINE ABORTED${reason}`))}\n`,
      );
      break;
    }

    default: {
      // Compile error here if a new PipelineEvent type is added without handling it
      const _exhaustive: never = event;
      const fallback = _exhaustive as { type: string };
      process.stdout.write(`${ts} ${pc.gray(fallback.type)}\n`);
      break;
    }
  }
}

export async function replayRun(
  ticketKey: string,
  projectName: string,
): Promise<void> {
  log.debug({ ticketKey, projectName }, "replay started");

  const runDir = getRunDir(projectName, ticketKey);

  if (!fs.existsSync(runDir)) {
    process.stderr.write(
      `Error: no run directory found for ${ticketKey} (project: ${projectName})\n`,
    );
    process.exitCode = 1;
    return;
  }

  const events = getEvents(runDir);

  if (events.length === 0) {
    process.stderr.write(
      `Error: no events found for ${ticketKey} (project: ${projectName})\n`,
    );
    process.exitCode = 1;
    return;
  }

  const startEvent = events.find((e) => e.type === "STARTED");
  const startedAt = startEvent?.timestamp ?? null;

  const headerTimestamp = startedAt ? pc.gray(`  started ${startedAt}`) : "";
  process.stdout.write(
    `\n${pc.bold(pc.cyan(`⟳ Replay: ${ticketKey}`))}${headerTimestamp}\n\n`,
  );

  for (const event of events) {
    printEvent(event, startedAt);
  }

  process.stdout.write("\n");
}
