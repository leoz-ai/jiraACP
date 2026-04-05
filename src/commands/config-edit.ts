import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { createLogger } from "../utils/logger.js";
import { ProjectConfigSchema } from "../config/schema.js";

const PROJECTS_DIR = path.join(os.homedir(), ".jira-acp", "projects");

export async function configEdit(projectName: string): Promise<void> {
  const logger = createLogger("config:edit");
  const configPath = path.join(PROJECTS_DIR, `${projectName}.json`);

  if (!fs.existsSync(configPath)) {
    process.stderr.write(`Project not found: ${projectName}\n`);
    process.exitCode = 1;
    return;
  }

  const editor = process.env["EDITOR"] ?? process.env["VISUAL"] ?? "nano";

  // spawnSafe not used here: interactive editors require stdio:inherit which
  // blocks the event loop intentionally. This is a CLI-only user-facing action,
  // never called from the pipeline.
  spawnSync(editor, [configPath], { stdio: "inherit" });

  // Validate after edit
  try {
    const raw = JSON.parse(fs.readFileSync(configPath, "utf8")) as unknown;
    const result = ProjectConfigSchema.safeParse(raw);
    if (!result.success) {
      const errors = result.error.errors
        .map((e) => `  ${e.path.join(".")} — ${e.message}`)
        .join("\n");
      logger.warn({ projectName }, "Config invalid after edit");
      process.stdout.write(
        `Warning: config may be invalid:\n${errors}\nRun: jiraACP doctor\n`,
      );
    } else {
      process.stdout.write(`✓ Config saved\n`);
    }
  } catch {
    process.stdout.write(`Warning: could not parse JSON — check the file\n`);
  }
}
