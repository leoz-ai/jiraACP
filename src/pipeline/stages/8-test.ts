import type { Stage, PipelineContext, StageOutput } from "./types.js";
import { runAgent } from "../runner.js";
import { getContextFilesForStage } from "../../memory/context-builder.js";

const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

export const testStage: Stage = {
  id: "test",
  name: "UI Test",
  model: "sonnet",

  async shouldSkip(ctx: PipelineContext): Promise<boolean> {
    return !ctx.config.test?.enabled;
  },

  async run(ctx: PipelineContext): Promise<StageOutput> {
    const { config, ticketKey, memoryDir, projectDir } = ctx;
    const testConfig = config.test;

    if (!testConfig?.baseUrl) throw new Error("test.baseUrl not configured");

    // Wait before testing (let deploy settle)
    const waitMs = testConfig.waitBeforeTestMs ?? 5_000;
    ctx.logger.info({ ticketKey, waitMs }, "Waiting before UI tests");
    await sleep(waitMs);

    const contextFiles = getContextFilesForStage(projectDir, memoryDir, "test");
    const retries = testConfig.retries ?? 2;

    const prompt = `
Run Playwright UI tests for ticket ${ticketKey} on ${testConfig.baseUrl}.

Test the acceptance criteria from the ticket context.
Spec pattern: ${testConfig.specPattern ?? "e2e/**/*.spec.ts"}

Report results as JSON: { "passed": boolean, "summary": "...", "failures": ["..."] }
`.trim();

    let lastError: Error | undefined;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        ctx.logger.info(
          { ticketKey, attempt: attempt + 1 },
          "Running UI tests",
        );

        const raw = ctx.dryRun
          ? '{"passed":true,"summary":"dry-run","failures":[]}'
          : await runAgent({
              prompt,
              workdir: config.workspace.rootDir,
              model: "sonnet",
              contextFiles,
              timeoutMs: testConfig.timeoutMs ?? 300_000,
              stallTimeoutMs: 60_000,
            });

        const match = raw.match(/\{[\s\S]*\}/);
        if (!match) throw new Error("Could not parse test results JSON");

        const result = JSON.parse(match[0]) as {
          passed: boolean;
          summary: string;
          failures: string[];
        };

        if (result.passed) {
          ctx.logger.info({ ticketKey }, "UI tests passed");
          return { passed: true, summary: result.summary };
        }

        lastError = new Error(`Tests failed: ${result.failures.join(", ")}`);
        ctx.logger.warn(
          { ticketKey, attempt: attempt + 1, failures: result.failures },
          "Tests failed, retrying",
        );
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
      }
    }

    const failOnTest = config.pipeline?.failOnTestFailure ?? false;
    if (failOnTest)
      throw lastError ?? new Error("Tests failed after all retries");

    await ctx.telegram.send(
      `⚠️ <b>${ticketKey}</b> UI tests failed after ${retries + 1} attempts. Continuing pipeline.\n${lastError?.message}`,
    );
    return { passed: false, summary: lastError?.message ?? "Tests failed" };
  },
};
