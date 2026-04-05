export interface ModelPricing {
  inputPer1M: number;
  outputPer1M: number;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  model: string;
}

// Prices in USD per 1M tokens — https://www.anthropic.com/pricing (updated 2026-01)
export const MODEL_PRICING: Record<string, ModelPricing> = {
  "claude-haiku-4-5": { inputPer1M: 0.8, outputPer1M: 4.0 },
  "claude-sonnet-4-5": { inputPer1M: 3.0, outputPer1M: 15.0 },
  "claude-opus-4-5": { inputPer1M: 15.0, outputPer1M: 75.0 },
  "claude-haiku-4": { inputPer1M: 0.8, outputPer1M: 4.0 },
  "claude-sonnet-4": { inputPer1M: 3.0, outputPer1M: 15.0 },
  "claude-opus-4": { inputPer1M: 15.0, outputPer1M: 75.0 },
};

const DEFAULT_PRICING: ModelPricing = { inputPer1M: 3.0, outputPer1M: 15.0 };

/** Type-safe extractor for tokenUsage from a stage output. Returns null if not present or malformed. */
export function extractTokenUsage(output: unknown): TokenUsage | null {
  if (typeof output !== "object" || output === null) return null;
  const raw = (output as Record<string, unknown>)["tokenUsage"];
  if (typeof raw !== "object" || raw === null) return null;
  const tu = raw as Record<string, unknown>;
  if (
    typeof tu["inputTokens"] !== "number" ||
    typeof tu["outputTokens"] !== "number"
  )
    return null;
  return {
    inputTokens: tu["inputTokens"] as number,
    outputTokens: tu["outputTokens"] as number,
    model: typeof tu["model"] === "string" ? tu["model"] : "claude-sonnet-4",
  };
}

export function estimateCostUsd(
  inputTokens: number,
  outputTokens: number,
  model: string,
): number {
  const pricing = MODEL_PRICING[model] ?? DEFAULT_PRICING;
  return (
    (inputTokens / 1_000_000) * pricing.inputPer1M +
    (outputTokens / 1_000_000) * pricing.outputPer1M
  );
}
