import fs from "node:fs";
import path from "node:path";
import pc from "picocolors";
import { getRunDir } from "../pipeline/state.js";

export async function showLogs(
  projectName: string,
  ticketKey: string,
  stage?: string,
  follow?: boolean,
): Promise<void> {
  const runDir = getRunDir(projectName, ticketKey);
  const statePath = path.join(runDir, "state.json");

  if (!fs.existsSync(statePath)) {
    console.error(pc.red(`No runs found for ${projectName}/${ticketKey}`));
    process.exit(1);
  }

  const events = fs
    .readFileSync(statePath, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line) as {
          type: string;
          stage?: string;
          timestamp: string;
          [k: string]: unknown;
        };
      } catch {
        return null;
      }
    })
    .filter(Boolean);

  const filtered = stage ? events.filter((e) => e!.stage === stage) : events;

  console.log(
    pc.bold(
      `\n  Logs: ${projectName}/${ticketKey}${stage ? ` / ${stage}` : ""}\n`,
    ),
  );

  for (const event of filtered) {
    if (!event) continue;
    const time = pc.gray(new Date(event.timestamp).toLocaleTimeString());
    const type = formatEventType(event.type);
    const detail = event.stage ? pc.cyan(event.stage) : "";
    const extra = event.error ? pc.red(String(event.error)) : "";
    console.log(`  ${time}  ${type}  ${detail}  ${extra}`);
  }

  if (follow) {
    console.log(pc.gray("\n  Watching for new events... (Ctrl+C to stop)"));
    let size = fs.statSync(statePath).size;
    setInterval(() => {
      const newSize = fs.statSync(statePath).size;
      if (newSize > size) {
        const newContent = fs.readFileSync(statePath, "utf8").slice(size);
        size = newSize;
        for (const line of newContent.split("\n").filter(Boolean)) {
          try {
            const event = JSON.parse(line) as {
              type: string;
              stage?: string;
              timestamp: string;
            };
            const time = pc.gray(
              new Date(event.timestamp).toLocaleTimeString(),
            );
            console.log(
              `  ${time}  ${formatEventType(event.type)}  ${event.stage ? pc.cyan(event.stage) : ""}`,
            );
          } catch {
            /* ignore */
          }
        }
      }
    }, 500);
  } else {
    console.log();
  }
}

function formatEventType(type: string): string {
  switch (type) {
    case "STARTED":
      return pc.blue("STARTED");
    case "STAGE_STARTED":
      return pc.cyan("→ START");
    case "STAGE_COMPLETED":
      return pc.green("✓ DONE");
    case "STAGE_FAILED":
      return pc.red("✗ FAIL");
    case "STAGE_SKIPPED":
      return pc.gray("⊘ SKIP");
    case "CLARIFICATION_REQUESTED":
      return pc.yellow("? CLARIFY");
    case "CLARIFICATION_RECEIVED":
      return pc.green("✓ ANSWER");
    case "PIPELINE_COMPLETED":
      return pc.green("✅ COMPLETE");
    case "PIPELINE_ABORTED":
      return pc.red("❌ ABORTED");
    default:
      return pc.gray(type);
  }
}
