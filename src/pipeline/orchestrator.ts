import type { ProjectConfig, StageId } from "../config/schema.js";
import type { PipelineContext } from "./stages/types.js";
import type { JiraClient } from "../integrations/jira/client.js";
import { StateManager, getRunDir, getLockPath, getMemoryDir } from "./state.js";
import { acquireLock } from "../utils/lock.js";
import { createLogger } from "../utils/logger.js";
import { getClient as getJiraClient } from "../integrations/jira/client.js";
import { createGitHubClient } from "../integrations/github/client.js";
import { createTelegramNotifier } from "../integrations/telegram/notifier.js";
import { checkCostLimit } from "./cost-guard.js";
import { fetchStage } from "./stages/1-fetch.js";
import { analyzeStage } from "./stages/2-analyze.js";
import { clarifyStage } from "./stages/3-clarify.js";
import { codeStage } from "./stages/4-code.js";
import { gitStage } from "./stages/5-git.js";
import { reviewStage } from "./stages/6-review.js";
import { deployStage } from "./stages/7-deploy.js";
import { testStage } from "./stages/8-test.js";
import { notifyStage } from "./stages/9-notify.js";
import type { Stage } from "./stages/types.js";
import { runHook, HookError } from "./hooks.js";
import { initBot } from "../integrations/telegram/bot.js";

const ALL_STAGES: Stage[] = [
  fetchStage,
  analyzeStage,
  clarifyStage,
  codeStage,
  gitStage,
  reviewStage,
  deployStage,
  testStage,
  notifyStage,
];

export interface RunOptions {
  fromStage?: StageId;
  toStage?: StageId;
  dryRun?: boolean;
}

export async function runPipeline(
  ticketKey: string,
  config: ProjectConfig,
  opts: RunOptions = {},
): Promise<void> {
  const projectDir = config.workspace.rootDir;
  const runDir = getRunDir(config.name, ticketKey);
  const lockPath = getLockPath(config.name, ticketKey);
  const memoryDir = getMemoryDir(config.name, ticketKey);
  const logger = createLogger(`pipeline:${ticketKey}`);
  const state = new StateManager(runDir);

  // Ensure bot is polling so human-in-the-loop handlers work
  if (config.telegram?.botToken) {
    await initBot(config.telegram.botToken);
  }

  const lock = await acquireLock(lockPath);

  const ctx: PipelineContext = {
    config,
    ticketKey,
    projectDir,
    state,
    memoryDir,
    dryRun: opts.dryRun ?? false,
    logger,
    jira: getJiraClient(config.jira.instance) as JiraClient,
    github: createGitHubClient(
      config.github.token,
      config.github.owner,
      config.github.repo,
    ),
    telegram: createTelegramNotifier(
      config.telegram.botToken,
      config.telegram.chatId,
      ticketKey,
      config.name,
      config.telegram.topicId,
    ),
  };

  state.emit({ type: "STARTED", ticketKey });

  const stages = filterStages(ALL_STAGES, opts.fromStage, opts.toStage);
  const hooksConfig = config.pipeline?.hooks;

  try {
    await runHook("beforePipeline", hooksConfig?.beforePipeline, {
      ticketKey,
      logger,
    });

    for (const stage of stages) {
      if (await stage.shouldSkip?.(ctx)) {
        state.emit({
          type: "STAGE_SKIPPED",
          stage: stage.id,
          reason: "shouldSkip returned true",
        });
        logger.info({ stage: stage.id }, "Stage skipped");
        await ctx.telegram.notifyStageSkipped(stage.id).catch(() => undefined);
        continue;
      }

      if (stage.id === "code") {
        await runHook("beforeCode", hooksConfig?.beforeCode, {
          ticketKey,
          logger,
        });
      }

      state.emit({ type: "STAGE_STARTED", stage: stage.id });
      logger.info({ stage: stage.id }, `▶ ${stage.name}`);
      await ctx.telegram.notifyStageStarted(stage.id).catch(() => undefined);

      try {
        const timeout = config.pipeline?.stageTimeouts?.[stage.id];
        const output = timeout
          ? await withTimeout(stage.run(ctx), timeout)
          : await stage.run(ctx);

        state.emit({ type: "STAGE_COMPLETED", stage: stage.id, output });
        logger.info({ stage: stage.id }, `✓ ${stage.name}`);
        await ctx.telegram
          .notifyStageCompleted(stage.id)
          .catch(() => undefined);

        if (config.pipeline?.maxCostUsdPerRun) {
          const decision = await checkCostLimit({
            runDir,
            maxCostUsd: config.pipeline.maxCostUsdPerRun,
            telegram: ctx.telegram,
            ticketKey,
          });
          if (decision === "abort") {
            state.emit({
              type: "PIPELINE_ABORTED",
              reason: "Cost limit exceeded",
            });
            throw new Error("Cost limit exceeded");
          }
        }

        if (stage.id === "code") {
          await runHook("afterCode", hooksConfig?.afterCode, {
            ticketKey,
            logger,
          });
        }

        if (stage.id === "deploy") {
          await runHook("afterDeploy", hooksConfig?.afterDeploy, {
            ticketKey,
            logger,
          });
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);

        // SKIP signal from clarify stage
        if (message.startsWith("SKIP:")) {
          state.emit({
            type: "STAGE_SKIPPED",
            stage: stage.id,
            reason: message,
          });
          logger.warn({ stage: stage.id }, `Skipped: ${message}`);
          return;
        }

        if (err instanceof HookError) {
          state.emit({ type: "PIPELINE_ABORTED", reason: message });
          throw err;
        }

        state.emit({ type: "STAGE_FAILED", stage: stage.id, error: message });
        await ctx.telegram
          .notifyStageFailed(stage.id, message)
          .catch(() => undefined);
        throw err;
      }
    }

    state.emit({ type: "PIPELINE_COMPLETED" });
    logger.info({ ticketKey }, "Pipeline completed");
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    if (!(err instanceof HookError)) {
      state.emit({ type: "PIPELINE_ABORTED", reason });
    }
    await ctx.telegram.sendError(ticketKey, err);
    logger.error({ ticketKey, reason }, "Pipeline aborted");
    process.exitCode = 1;
  } finally {
    await runHook("afterPipeline", hooksConfig?.afterPipeline, {
      ticketKey,
      logger,
    });
    lock.release();
  }
}

export async function resumePipeline(
  ticketKey: string,
  config: ProjectConfig,
): Promise<void> {
  const logger = createLogger(`pipeline:${ticketKey}`);
  const state = new StateManager(getRunDir(config.name, ticketKey));
  const current = state.current;

  if (current.isCompleted) {
    logger.info({ ticketKey }, "Pipeline already completed");
    process.stdout.write(`Pipeline for ${ticketKey} already completed.\n`);
    return;
  }

  const fromStage = current.currentStage ?? current.failedStage ?? "fetch";
  logger.info({ ticketKey, fromStage }, "Resuming pipeline");

  await runPipeline(ticketKey, config, { fromStage: fromStage as StageId });
}

function filterStages(stages: Stage[], from?: StageId, to?: StageId): Stage[] {
  const fromIdx = from ? stages.findIndex((s) => s.id === from) : 0;
  const toIdx = to ? stages.findIndex((s) => s.id === to) : stages.length - 1;
  return stages.slice(
    fromIdx < 0 ? 0 : fromIdx,
    toIdx < 0 ? stages.length : toIdx + 1,
  );
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  const signal = AbortSignal.timeout(ms);
  const aborted = new Promise<never>((_, reject) => {
    signal.addEventListener("abort", () => {
      reject(new Error(`Stage timed out after ${ms}ms`));
    });
  });
  return Promise.race([promise, aborted]);
}
