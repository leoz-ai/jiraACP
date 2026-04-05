import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { loadConfig } from "../config/loader.js";
import { getRunDir, StateManager } from "../pipeline/state.js";
import { createLogger } from "../utils/logger.js";

const PENDING_FILE = path.join(
  os.homedir(),
  ".jira-acp",
  "pending-clarifications.json",
);

export async function cancelClarification(
  ticketKey: string,
  projectName: string,
): Promise<void> {
  const logger = createLogger("cancel-clarification");
  loadConfig(projectName);

  let removed = false;
  if (fs.existsSync(PENDING_FILE)) {
    const raw = JSON.parse(fs.readFileSync(PENDING_FILE, "utf8")) as Array<{
      ticketKey: string;
    }>;
    const filtered = raw.filter((e) => e.ticketKey !== ticketKey);
    if (filtered.length < raw.length) {
      // Atomic write: write to temp file then rename to avoid race conditions
      const tmpPath = PENDING_FILE + ".tmp";
      fs.writeFileSync(tmpPath, JSON.stringify(filtered, null, 2));
      fs.renameSync(tmpPath, PENDING_FILE);
      removed = true;
      logger.info({ ticketKey }, "Removed from pending-clarifications");
    }
  }

  if (!removed) {
    process.stdout.write(`No pending clarification found for ${ticketKey}\n`);
    return;
  }

  // Emit CLARIFICATION_RECEIVED into state if run dir exists
  const runDir = getRunDir(projectName, ticketKey);
  if (fs.existsSync(runDir)) {
    try {
      new StateManager(runDir).emit({
        type: "CLARIFICATION_RECEIVED",
        answers: "CANCELLED",
      });
      logger.info({ ticketKey }, "CLARIFICATION_RECEIVED(CANCELLED) emitted");
    } catch (err) {
      logger.warn(
        { ticketKey, err },
        "Failed to emit CLARIFICATION_RECEIVED — non-fatal",
      );
    }
  }

  process.stdout.write(`✓ Clarification for ${ticketKey} cancelled\n`);
}
