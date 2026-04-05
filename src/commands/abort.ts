import fs from "node:fs";
import { loadConfig } from "../config/loader.js";
import { getRunDir, getLockPath, StateManager } from "../pipeline/state.js";
import { readLockData } from "../utils/lock.js";
import { createLogger } from "../utils/logger.js";
import { createTelegramNotifier } from "../integrations/telegram/notifier.js";

export async function abortPipeline(
  ticketKey: string,
  projectName: string,
  reason?: string,
): Promise<void> {
  const logger = createLogger("abort");
  const config = loadConfig(projectName);

  const runDir = getRunDir(projectName, ticketKey);
  const lockPath = getLockPath(projectName, ticketKey);

  // Check state first
  const stateFile = `${runDir}/state.json`;
  if (!fs.existsSync(stateFile)) {
    logger.error({ ticketKey }, "No pipeline run found for ticket");
    process.stderr.write(`No pipeline run found for ${ticketKey}\n`);
    process.exitCode = 1;
    return;
  }

  const state = new StateManager(runDir).current;
  if (state.isCompleted || state.isAborted) {
    process.stdout.write(
      `Pipeline for ${ticketKey} is already ${state.isCompleted ? "completed" : "aborted"}\n`,
    );
    return;
  }

  // Read lock to get PID
  const lockData = readLockData(lockPath);
  const abortReason = reason ?? "Manually aborted by user";

  if (lockData) {
    try {
      process.kill(lockData.pid, "SIGTERM");
      logger.info(
        { ticketKey, pid: lockData.pid },
        "SIGTERM sent to pipeline process",
      );
    } catch (err: unknown) {
      // ESRCH = process not found — already dead
      const isESRCH =
        err instanceof Error &&
        "code" in err &&
        (err as NodeJS.ErrnoException).code === "ESRCH";
      if (!isESRCH) throw err;
      logger.warn(
        { ticketKey, pid: lockData.pid },
        "Process already dead — recording abort",
      );
    }
  } else {
    logger.warn(
      { ticketKey },
      "No lock file found — recording abort event only",
    );
  }

  // Emit abort event directly to state file (the killed process may not have time to)
  const stateManager = new StateManager(runDir);
  const currentState = stateManager.current;
  if (!currentState.isAborted) {
    stateManager.emit({ type: "PIPELINE_ABORTED", reason: abortReason });
    logger.info(
      { ticketKey, reason: abortReason },
      "PIPELINE_ABORTED event recorded",
    );
  }

  // Notify Telegram
  try {
    const notifier = createTelegramNotifier(
      config.telegram.botToken,
      config.telegram.chatId,
      ticketKey,
      projectName,
      config.telegram.topicId,
    );
    await notifier.sendError(
      ticketKey,
      new Error(`Pipeline aborted: ${abortReason}`),
    );
  } catch {
    logger.warn(
      { ticketKey },
      "Telegram notification failed during abort — continuing",
    );
  }

  process.stdout.write(`✓ Pipeline for ${ticketKey} aborted: ${abortReason}\n`);
}
