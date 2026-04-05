import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createLogger } from "../utils/logger.js";
import { ProjectConfigSchema } from "../config/schema.js";

const PROJECTS_DIR = path.join(os.homedir(), ".jira-acp", "projects");

function setDotPath(
  obj: Record<string, unknown>,
  dotKey: string,
  value: unknown,
): void {
  const parts = dotKey.split(".");
  let current: Record<string, unknown> = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i];
    if (typeof current[part] !== "object" || current[part] === null) {
      current[part] = {};
    }
    current = current[part] as Record<string, unknown>;
  }
  current[parts[parts.length - 1]] = value;
}

export function configSet(
  projectName: string,
  key: string,
  rawValue: string,
): void {
  const logger = createLogger("config:set");
  const configPath = path.join(PROJECTS_DIR, `${projectName}.json`);

  if (!fs.existsSync(configPath)) {
    process.stderr.write(`Project not found: ${projectName}\n`);
    process.exitCode = 1;
    return;
  }

  const backup = fs.readFileSync(configPath, "utf8");
  const obj = JSON.parse(backup) as Record<string, unknown>;

  let value: unknown = rawValue;
  try {
    value = JSON.parse(rawValue);
  } catch {
    // treat as plain string
  }

  setDotPath(obj, key, value);

  const result = ProjectConfigSchema.safeParse(obj);
  if (!result.success) {
    const firstError = result.error.errors[0];
    process.stderr.write(
      `Invalid config: ${firstError?.path.join(".") ?? "unknown"} — ${firstError?.message ?? "validation failed"}\n`,
    );
    process.exitCode = 1;
    return;
  }

  fs.writeFileSync(configPath, JSON.stringify(obj, null, 2) + "\n");
  logger.info({ projectName, key }, "Config key updated");
  process.stdout.write(
    `✓ Set ${key} = ${JSON.stringify(value)} in project ${projectName}\n`,
  );
}
