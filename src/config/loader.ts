import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  ProjectConfigSchema,
  GlobalConfigSchema,
  type ProjectConfig,
} from "./schema.js";

// ~/.jira-acp/
export const HOME_DIR = path.join(os.homedir(), ".jira-acp");
const PROJECTS_DIR = path.join(HOME_DIR, "projects");
const RUNS_DIR = path.join(HOME_DIR, "runs");

/** Detect project name from git remote origin URL, fallback to folder name */
export function detectProjectName(cwd: string = process.cwd()): string {
  const result = spawnSync("git", ["remote", "get-url", "origin"], {
    cwd,
    encoding: "utf8",
  });
  if (result.status === 0 && result.stdout) {
    const remote = result.stdout.trim();
    // https://github.com/owner/repo.git  or  git@github.com:owner/repo.git
    const match = remote.match(/[:/]([^/]+\/[^/]+?)(?:\.git)?$/);
    if (match) return match[1].replace("/", "-");
  }
  return path.basename(cwd);
}

const GLOBAL_CONFIG_FILE = path.join(HOME_DIR, "config.json");

function configPath(projectName: string): string {
  return path.join(PROJECTS_DIR, `${projectName}.json`);
}

function deepMerge(
  base: Record<string, unknown>,
  override: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (value === undefined) continue;
    const baseVal = base[key];
    if (
      typeof value === "object" &&
      value !== null &&
      !Array.isArray(value) &&
      typeof baseVal === "object" &&
      baseVal !== null &&
      !Array.isArray(baseVal)
    ) {
      result[key] = deepMerge(
        baseVal as Record<string, unknown>,
        value as Record<string, unknown>,
      );
    } else {
      result[key] = value;
    }
  }
  return result;
}

function loadGlobalConfig(): Record<string, unknown> {
  if (!fs.existsSync(GLOBAL_CONFIG_FILE)) return {};
  try {
    const raw = JSON.parse(
      fs.readFileSync(GLOBAL_CONFIG_FILE, "utf8"),
    ) as unknown;
    const parsed = GlobalConfigSchema.safeParse(raw);
    if (!parsed.success) return {};
    return parsed.data as Record<string, unknown>;
  } catch {
    return {};
  }
}

export function loadConfig(projectName: string): ProjectConfig {
  const filePath = configPath(projectName);

  if (!fs.existsSync(filePath)) {
    throw new Error(
      `No config found for project "${projectName}" at ${filePath}.\nRun: jiraACP init --name ${projectName}`,
    );
  }

  const projectRaw = JSON.parse(fs.readFileSync(filePath, "utf8")) as Record<
    string,
    unknown
  >;
  const globalRaw = loadGlobalConfig();
  const merged = deepMerge(globalRaw, projectRaw); // project overrides global
  return ProjectConfigSchema.parse(merged);
}

export function configExists(projectName: string): boolean {
  return fs.existsSync(configPath(projectName));
}

export function saveConfig(projectName: string, config: unknown): void {
  fs.mkdirSync(PROJECTS_DIR, { recursive: true });
  fs.writeFileSync(configPath(projectName), JSON.stringify(config, null, 2));
}

export function listProjects(): string[] {
  if (!fs.existsSync(PROJECTS_DIR)) return [];
  return fs
    .readdirSync(PROJECTS_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.replace(/\.json$/, ""));
}

export function getRunsDir(projectName: string): string {
  return path.join(RUNS_DIR, projectName);
}
