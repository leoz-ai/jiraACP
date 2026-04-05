import type { Logger } from "pino";
import { spawnSafe, buildMinimalEnv } from "../utils/process.js";

export type HookName =
  | "beforePipeline"
  | "beforeCode"
  | "afterCode"
  | "afterDeploy"
  | "afterPipeline";

export class HookError extends Error {
  constructor(
    public readonly hookName: HookName,
    public readonly exitCode: number,
  ) {
    super(`Hook '${hookName}' failed with exit code ${exitCode}`);
    this.name = "HookError";
  }
}

export async function runHook(
  name: HookName,
  command: string | undefined,
  ctx: { ticketKey: string; logger: Logger },
): Promise<void> {
  if (!command?.trim()) return;

  // Simple whitespace split — quoted args (e.g. "my script.sh") are not supported.
  // Hook commands should avoid spaces in path; use a wrapper script if needed.
  const [bin, ...args] = command.trim().split(/\s+/);
  const { logger } = ctx;

  logger.info({ hookName: name, command }, "Running hook");

  const result = await spawnSafe(bin, args, {
    env: buildMinimalEnv({ JIRA_ACP_TICKET: ctx.ticketKey }),
  });

  if (result.exitCode !== 0) {
    logger.error(
      { hookName: name, exitCode: result.exitCode, stderr: result.stderr },
      "Hook failed",
    );
    throw new HookError(name, result.exitCode);
  }

  logger.info({ hookName: name }, "Hook completed");
}
