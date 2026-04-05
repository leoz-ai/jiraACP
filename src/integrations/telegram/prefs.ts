import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const PREFS_PATH = path.join(os.homedir(), ".jira-acp", "telegram-prefs.json");

export type Verbosity = "low" | "medium" | "high";

interface TelegramPrefs {
  verbosity: Record<string, Verbosity>;
}

function load(): TelegramPrefs {
  if (!fs.existsSync(PREFS_PATH)) return { verbosity: {} };
  try {
    return JSON.parse(fs.readFileSync(PREFS_PATH, "utf8")) as TelegramPrefs;
  } catch {
    return { verbosity: {} };
  }
}

function save(prefs: TelegramPrefs): void {
  fs.mkdirSync(path.dirname(PREFS_PATH), { recursive: true });
  fs.writeFileSync(PREFS_PATH, JSON.stringify(prefs, null, 2));
}

export function getVerbosity(chatId: number | string): Verbosity {
  const prefs = load();
  return prefs.verbosity[String(chatId)] ?? "medium";
}

export function setVerbosity(chatId: number | string, level: Verbosity): void {
  const prefs = load();
  prefs.verbosity[String(chatId)] = level;
  save(prefs);
}
