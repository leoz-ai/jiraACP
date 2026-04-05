import { z } from "zod";

export const StageId = z.enum([
  "fetch",
  "analyze",
  "clarify",
  "code",
  "git",
  "review",
  "deploy",
  "test",
  "notify",
]);
export type StageId = z.infer<typeof StageId>;

export const ProjectConfigSchema = z.object({
  name: z.string(),
  extends: z.string().optional(),

  jira: z.object({
    instance: z.string(),
    url: z.string(),
    email: z.string(),
    token: z.string(),
    projectKey: z.string(),
    assignees: z.array(z.string()).min(1),
    reassignTo: z.string().optional(),
    acceptanceCriteriaField: z.string().default("customfield_10016"),
    inProgressTransition: z.string().default("In Progress"),
    inReviewTransition: z.string().default("In Review"),
    doneTransition: z.string().default("Done"),
    blockedTransition: z.string().optional(),
    clarityScoreThreshold: z.number().min(0).max(1).default(0.7),
    requiredFields: z
      .array(
        z.enum([
          "description",
          "acceptanceCriteria",
          "storyPoints",
          "designLink",
        ]),
      )
      .default(["description", "acceptanceCriteria"]),
  }),

  github: z.object({
    owner: z.string(),
    repo: z.string(),
    token: z.string(),
    defaultBranch: z.string().default("main"),
    branchPattern: z.string().default("{prefix}/{ticketKey}-{slug}"),
    branchPrefix: z.string().default("feature"),
    autoMergeStrategy: z.enum(["squash", "merge", "rebase"]).default("squash"),
    reviewers: z.array(z.string()).default([]),
    prDraftByDefault: z.boolean().default(false),
    majorIssueThreshold: z.number().default(1),
    ciWaitTimeoutMs: z.number().default(600_000),
  }),

  workspace: z.object({
    rootDir: z.string(),
    buildCommand: z.string().optional(),
    testCommand: z.string().optional(),
    allowedPaths: z.array(z.string()).default([]),
  }),

  deploy: z
    .object({
      enabled: z.boolean().default(false),
      command: z.string().optional(),
      rollbackCommand: z.string().optional(),
      timeoutMs: z.number().default(1_200_000),
      healthCheckUrl: z.string().optional(),
      healthCheckTimeoutMs: z.number().default(30_000),
      env: z.record(z.string()).default({}),
    })
    .default({}),

  test: z
    .object({
      enabled: z.boolean().default(false),
      baseUrl: z.string().optional(),
      retries: z.number().default(2),
      waitBeforeTestMs: z.number().default(5_000),
      timeoutMs: z.number().default(300_000),
      specPattern: z.string().default("e2e/**/*.spec.ts"),
    })
    .default({}),

  telegram: z.object({
    botToken: z.string(),
    chatId: z.union([z.string(), z.number()]),
    topicId: z.number().optional(),
    notifyOnStages: z
      .array(
        z.enum([
          "start",
          "clarification",
          "code-done",
          "pr-created",
          "review-pass",
          "review-fail",
          "deployed",
          "test-pass",
          "test-fail",
          "done",
          "error",
        ]),
      )
      .default(["clarification", "review-fail", "test-fail", "error", "done"]),
    humanInTheLoop: z
      .object({
        clarificationTimeoutMs: z.number().default(3_600_000),
        clarificationTimeoutAction: z
          .enum(["skip", "abort", "proceed-with-warning"])
          .default("skip"),
        reviewApprovalTimeoutMs: z.number().default(86_400_000),
        reviewApprovalTimeoutAction: z
          .enum(["abort", "merge-anyway"])
          .default("abort"),
      })
      .default({}),
  }),

  pipeline: z
    .object({
      maxConcurrentRuns: z.number().default(2),
      stageTimeouts: z
        .object({
          fetch: z.number().default(30_000),
          analyze: z.number().default(60_000),
          clarify: z.number().default(3_600_000),
          code: z.number().default(1_800_000),
          git: z.number().default(60_000),
          review: z.number().default(600_000),
          deploy: z.number().default(1_200_000),
          test: z.number().default(300_000),
          notify: z.number().default(30_000),
        })
        .default({}),
      agentStallTimeoutMs: z.number().default(300_000),
      skipClarificationIfClear: z.boolean().default(true),
      failOnTestFailure: z.boolean().default(false),
      failOnDeployFailure: z.boolean().default(true),
      maxCostUsdPerRun: z.number().optional(),
      hooks: z
        .object({
          beforePipeline: z.string().optional(),
          beforeCode: z.string().optional(),
          afterCode: z.string().optional(),
          afterDeploy: z.string().optional(),
          afterPipeline: z.string().optional(),
        })
        .default({}),
    })
    .default({}),
});

export type ProjectConfig = z.infer<typeof ProjectConfigSchema>;

// Global config: all fields optional, no required `name`
export const GlobalConfigSchema = ProjectConfigSchema.deepPartial().omit({
  name: true,
});
export type GlobalConfig = z.infer<typeof GlobalConfigSchema>;
