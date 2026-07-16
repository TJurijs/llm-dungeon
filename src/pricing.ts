import type { Usage } from "./usage.js";

export interface TokenPrice {
  inputPerMillion: number;
  outputPerMillion: number;
}

export function roundUsd(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

export function estimateTokenCost(usage: Usage | undefined, price: TokenPrice): number {
  if (!usage) return 0;
  return roundUsd(
    ((usage.inputTokens ?? 0) * price.inputPerMillion
      + (usage.outputTokens ?? 0) * price.outputPerMillion)
      / 1_000_000,
  );
}

/** Built-in standard-tier prices used when a provider does not return billed cost. */
export function inferTokenPrice(provider: string, modelId: string): TokenPrice | undefined {
  const model = modelId.toLowerCase();
  if (provider === "gemini" && model === "gemini-3.5-flash") return { inputPerMillion: 1.5, outputPerMillion: 9 };
  if (model.includes("gemini-3.1-flash-lite")) return { inputPerMillion: 0.25, outputPerMillion: 1.5 };
  if (provider === "openrouter" && model.includes("gemini-3.5-flash")) return { inputPerMillion: 1.5, outputPerMillion: 9 };
  if (provider === "gemini" && model === "gemini-3-flash-preview") return { inputPerMillion: 0.5, outputPerMillion: 3 };
  return undefined;
}
