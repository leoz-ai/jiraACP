import type { ProjectConfig, StageId } from "../../config/schema.js";
import type { StateManager } from "../state.js";
import type { JiraClient } from "../../integrations/jira/client.js";
import type { GitHubClient } from "../../integrations/github/client.js";
import type { TelegramNotifier } from "../../integrations/telegram/notifier.js";
import type { Logger } from "pino";

export interface PipelineContext {
  config: ProjectConfig;
  ticketKey: string;
  projectDir: string;
  state: StateManager;
  jira: JiraClient;
  github: GitHubClient;
  telegram: TelegramNotifier;
  logger: Logger;
  dryRun: boolean;
  memoryDir: string;
}

export interface StageOutput {
  [key: string]: unknown;
}

export interface Stage {
  id: StageId;
  name: string;
  model: "haiku" | "sonnet" | "opus";
  run(ctx: PipelineContext): Promise<StageOutput>;
  shouldSkip?(ctx: PipelineContext): Promise<boolean>;
}
