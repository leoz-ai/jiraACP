import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import pc from "picocolors";
import { createLogger } from "../utils/logger.js";

const SCHEDULES_PATH = path.join(os.homedir(), ".jira-acp", "schedules.json");

export interface ScheduleEntry {
  id: string;
  projectName: string;
  cron: string;
  createdAt: string;
  enabled: boolean;
}

// ── Storage ───────────────────────────────────────────────────────────────

export function loadSchedules(): ScheduleEntry[] {
  if (!fs.existsSync(SCHEDULES_PATH)) return [];
  try {
    return JSON.parse(
      fs.readFileSync(SCHEDULES_PATH, "utf8"),
    ) as ScheduleEntry[];
  } catch {
    return [];
  }
}

function saveSchedules(entries: ScheduleEntry[]): void {
  fs.mkdirSync(path.dirname(SCHEDULES_PATH), { recursive: true });
  fs.writeFileSync(SCHEDULES_PATH, JSON.stringify(entries, null, 2));
}

// ── Cron validation ───────────────────────────────────────────────────────

const CRON_REGEX =
  /^(\*|([0-5]?\d))(\/\d+)?(\s+(\*|([01]?\d|2[0-3]))(\/\d+)?){1}(\s+(\*|([12]?\d|3[01]))(\/\d+)?){1}(\s+(\*|(1[0-2]|[1-9]))(\/\d+)?){1}(\s+(\*|[0-7])(\/\d+)?){1}$/;

function isValidCron(expr: string): boolean {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return false;
  return CRON_REGEX.test(expr.trim());
}

// ── Commands ──────────────────────────────────────────────────────────────

export function scheduleAdd(projectName: string, cron: string): void {
  const logger = createLogger("schedule:add");

  if (!isValidCron(cron)) {
    process.stderr.write(
      `Invalid cron expression: "${cron}"\nExpected 5-field cron: "min hour day month weekday"\nExample: "0 9 * * 1-5"\n`,
    );
    process.exitCode = 2;
    return;
  }

  const entries = loadSchedules();
  const entry: ScheduleEntry = {
    id: randomUUID(),
    projectName,
    cron,
    createdAt: new Date().toISOString(),
    enabled: true,
  };

  entries.push(entry);
  saveSchedules(entries);
  logger.info({ id: entry.id, projectName, cron }, "Schedule added");
  process.stdout.write(
    `✓ Schedule added\n  ID:      ${entry.id}\n  Project: ${projectName}\n  Cron:    ${cron}\n`,
  );
}

export function scheduleList(): void {
  const entries = loadSchedules();

  if (entries.length === 0) {
    process.stdout.write(
      pc.gray("  No schedules configured. Run: jiraACP schedule add\n"),
    );
    return;
  }

  process.stdout.write(`\n${pc.bold("  Scheduled pipeline runs")}\n\n`);
  process.stdout.write(
    `  ${"ID".padEnd(38)} ${"Project".padEnd(20)} ${"Cron".padEnd(18)} Status\n`,
  );
  process.stdout.write("  " + "─".repeat(86) + "\n");

  for (const e of entries) {
    const status = e.enabled ? pc.green("enabled") : pc.gray("disabled");
    process.stdout.write(
      `  ${e.id.padEnd(38)} ${e.projectName.padEnd(20)} ${e.cron.padEnd(18)} ${status}\n`,
    );
  }
  process.stdout.write("\n");
}

export function scheduleRemove(id: string): void {
  const logger = createLogger("schedule:remove");
  const entries = loadSchedules();
  const idx = entries.findIndex((e) => e.id === id || e.id.startsWith(id));

  if (idx === -1) {
    process.stderr.write(`No schedule found with ID: ${id}\n`);
    process.exitCode = 1;
    return;
  }

  const [removed] = entries.splice(idx, 1);
  saveSchedules(entries);
  logger.info({ id: removed.id }, "Schedule removed");
  process.stdout.write(
    `✓ Schedule removed: ${removed.id} (${removed.projectName} — ${removed.cron})\n`,
  );
}

// ── Cron runtime (used by serve) ──────────────────────────────────────────

/** Parse a cron field value and return whether the given number matches. */
function matchField(field: string, value: number): boolean {
  if (field === "*") return true;
  if (field.includes("/")) {
    const [base, stepStr] = field.split("/");
    const step = Number(stepStr);
    if (!step) return false; // step=0 is invalid
    const start = base === "*" ? 0 : Number(base);
    return value >= start && (value - start) % step === 0;
  }
  if (field.includes("-")) {
    const [min, max] = field.split("-").map(Number);
    return value >= min && value <= max;
  }
  return Number(field) === value;
}

/** Returns true if a cron expression fires at the given Date (minute precision). */
export function cronMatchesNow(cron: string, now: Date = new Date()): boolean {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return false;
  const [minF, hourF, domF, monF, dowF] = parts;
  return (
    matchField(minF, now.getMinutes()) &&
    matchField(hourF, now.getHours()) &&
    matchField(domF, now.getDate()) &&
    matchField(monF, now.getMonth() + 1) &&
    matchField(dowF, now.getDay())
  );
}
