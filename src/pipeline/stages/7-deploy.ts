import type { Stage, PipelineContext, StageOutput } from "./types.js";
import { spawnSafe, buildMinimalEnv } from "../../utils/process.js";

export const deployStage: Stage = {
  id: "deploy",
  name: "Deploy",
  model: "haiku",

  async shouldSkip(ctx: PipelineContext): Promise<boolean> {
    return !ctx.config.deploy?.enabled;
  },

  async run(ctx: PipelineContext): Promise<StageOutput> {
    const { config, ticketKey } = ctx;
    const deploy = config.deploy;

    if (!deploy?.command) throw new Error("deploy.command not configured");

    ctx.logger.info({ ticketKey }, "Deploying to dev server");

    if (ctx.dryRun) return { deployed: false, dryRun: true };

    const result = await spawnSafe(deploy.command, [], {
      cwd: config.workspace.rootDir,
      env: buildMinimalEnv(deploy.env ?? {}),
      timeoutMs: deploy.timeoutMs ?? 1_200_000,
    });

    if (result.exitCode !== 0) {
      throw new Error(
        `Deploy failed (exit ${result.exitCode}):\n${result.stderr}`,
      );
    }

    // Health check
    if (deploy.healthCheckUrl) {
      await healthCheck(
        deploy.healthCheckUrl,
        deploy.healthCheckTimeoutMs ?? 30_000,
      );
    }

    ctx.logger.info({ ticketKey }, "Deploy successful");
    return { deployed: true, deployUrl: deploy.healthCheckUrl };
  },
};

async function healthCheck(url: string, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(5_000) });
      if (res.ok) return;
    } catch {
      /* keep retrying */
    }
    await sleep(2_000);
  }
  throw new Error(`Health check timed out after ${timeoutMs}ms: ${url}`);
}

const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));
