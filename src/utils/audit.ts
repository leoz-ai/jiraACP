import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const AUDIT_FILE = path.join(os.homedir(), ".jira-acp", "audit.log");

export type AuditAction =
  | "JIRA_STATUS_CHANGED"
  | "JIRA_COMMENT_ADDED"
  | "JIRA_REASSIGNED"
  | "GITHUB_PR_CREATED"
  | "GITHUB_PR_MERGED"
  | "TELEGRAM_MESSAGE_SENT";

export interface AuditEntry {
  timestamp: string;
  project: string;
  ticketKey: string;
  action: AuditAction;
  detail: Record<string, string | number | boolean>;
}

const SECRET_KEYS = new Set([
  "token",
  "botToken",
  "apiKey",
  "secret",
  "password",
  "authorization",
]);

function redactSecrets(
  detail: Record<string, string | number | boolean>,
): Record<string, string | number | boolean> {
  const result: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(detail)) {
    if (SECRET_KEYS.has(k) && typeof v === "string") {
      result[k] = "<redacted>";
    } else {
      result[k] = v;
    }
  }
  return result;
}

export function writeAuditEntry(entry: Omit<AuditEntry, "timestamp">): void {
  try {
    const dir = path.dirname(AUDIT_FILE);
    fs.mkdirSync(dir, { recursive: true });
    const line =
      JSON.stringify({
        timestamp: new Date().toISOString(),
        ...entry,
        detail: redactSecrets(entry.detail),
      }) + "\n";
    fs.appendFileSync(AUDIT_FILE, line);
  } catch {
    // Non-fatal: audit failure must never break the pipeline
  }
}
