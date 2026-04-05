import { spawnSafe, buildMinimalEnv } from "../utils/process.js";

export type AgentModel = "haiku" | "sonnet" | "opus";

const MODEL_IDS: Record<AgentModel, string> = {
  haiku: "claude-haiku-4-5-20251001",
  sonnet: "claude-sonnet-4-6",
  opus: "claude-opus-4-6",
};

export interface RunAgentOptions {
  prompt: string;
  workdir: string;
  model: AgentModel;
  contextFiles?: string[];
  timeoutMs?: number;
  stallTimeoutMs?: number;
  extraEnv?: Record<string, string>;
}

export async function runAgent(opts: RunAgentOptions): Promise<string> {
  const args = [
    "--model",
    MODEL_IDS[opts.model],
    "--print",
    "--output-format",
    "text",
  ];

  for (const f of opts.contextFiles ?? []) {
    args.push("--context", f);
  }

  args.push(opts.prompt);

  const result = await spawnSafe("claude", args, {
    cwd: opts.workdir,
    env: buildMinimalEnv(opts.extraEnv),
    timeoutMs: opts.timeoutMs ?? 1_800_000,
    stallTimeoutMs: opts.stallTimeoutMs ?? 300_000,
  });

  if (result.exitCode !== 0) {
    throw new Error(
      `Agent exited with code ${result.exitCode}:\n${result.stderr}`,
    );
  }

  return result.stdout.trim();
}

/** Run two agents in parallel and return both outputs */
export async function runAgentsParallel(
  a: RunAgentOptions,
  b: RunAgentOptions,
): Promise<[string, string]> {
  return Promise.all([runAgent(a), runAgent(b)]);
}

/** Detect if a task is complex enough to warrant Opus */
export function detectComplexity(description: string): AgentModel {
  const complexKeywords = [
    "auth",
    "payment",
    "stripe",
    "oauth",
    "jwt",
    "migration",
    "schema",
    "database",
    "refactor",
    "cross-module",
    "multi-service",
    "security",
    "encryption",
    "permission",
  ];
  const lower = description.toLowerCase();
  const matches = complexKeywords.filter((k) => lower.includes(k));
  return matches.length >= 2 ? "opus" : "sonnet";
}
