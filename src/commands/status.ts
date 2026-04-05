import fs from "node:fs";
import path from "node:path";
import pc from "picocolors";
import { StateManager, getRunDir } from "../pipeline/state.js";
import { listProjects, HOME_DIR } from "../config/loader.js";

export async function showStatus(
  projectName?: string,
  ticketKey?: string,
): Promise<void> {
  const projects = projectName ? [projectName] : listProjects();

  if (projects.length === 0) {
    console.log(pc.gray("  No projects configured. Run: jiraACP init"));
    return;
  }

  console.log(pc.bold("\n  jiraACP status\n"));
  console.log(
    `  ${"Project".padEnd(20)} ${"Ticket".padEnd(15)} ${"Stage".padEnd(12)} ${"Status".padEnd(12)} Started`,
  );
  console.log("  " + "─".repeat(72));

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
      const status = state.isCompleted
        ? pc.green("completed")
        : state.isAborted
          ? pc.red("aborted")
          : state.pendingClarification
            ? pc.yellow("waiting")
            : pc.cyan("running");

      const started = state.startedAt
        ? new Date(state.startedAt).toLocaleTimeString()
        : "—";

      console.log(
        `  ${project.padEnd(20)} ${key.padEnd(15)} ${String(stage).padEnd(12)} ${status.padEnd(20)} ${started}`,
      );
    }
  }

  console.log();
}
