import { loadConfig } from "../config/loader.js";
import { getLockPath } from "../pipeline/state.js";
import { readLockData } from "../utils/lock.js";
import { createLogger } from "../utils/logger.js";

export async function pausePipeline(
  ticketKey: string,
  projectName: string,
): Promise<void> {
  const logger = createLogger("pause");
  loadConfig(projectName);

  const lockPath = getLockPath(projectName, ticketKey);
  const lockData = readLockData(lockPath);

  if (!lockData) {
    process.stderr.write(`No running pipeline found for ${ticketKey}\n`);
    process.exitCode = 1;
    return;
  }

  // Check process is alive
  try {
    process.kill(lockData.pid, 0);
  } catch (err: unknown) {
    const code =
      err instanceof Error && "code" in err
        ? (err as NodeJS.ErrnoException).code
        : undefined;
    if (code === "ESRCH") {
      process.stderr.write(
        `Pipeline process (PID ${lockData.pid}) is no longer running\n`,
      );
      process.exitCode = 1;
      return;
    }
    throw err;
  }

  // Send SIGSTOP
  try {
    process.kill(lockData.pid, "SIGSTOP");
    logger.info({ ticketKey, pid: lockData.pid }, "SIGSTOP sent");
    process.stdout.write(
      `✓ Pipeline ${ticketKey} paused (PID ${lockData.pid}). Resume with: jiraACP resume ${ticketKey}\n`,
    );
  } catch (err: unknown) {
    const code =
      err instanceof Error && "code" in err
        ? (err as NodeJS.ErrnoException).code
        : undefined;
    if (code === "ESRCH") {
      process.stdout.write(`Pipeline ${ticketKey} already stopped.\n`);
      return;
    }
    throw err;
  }
}
