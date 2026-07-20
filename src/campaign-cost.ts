import { estimateTokenCost, inferTokenPrice, roundUsd } from "./pricing.js";
import type { TurnGenerationMetadata } from "./persistence/markdown.js";
import type { ReplyGeneration } from "./types.js";

export interface CampaignCostSummary {
  totalUsd: number;
  basis: "exact" | "estimated" | "mixed";
  pricedTurns: number;
  unpricedTurns: number;
}

export function replyGeneration(metadata: Omit<TurnGenerationMetadata, "turn">): ReplyGeneration {
  const base = { provider: metadata.provider, model: metadata.model };
  if (metadata.usage?.billedCostUsd !== undefined) {
    return { ...base, costUsd: roundUsd(metadata.usage.billedCostUsd), costBasis: "exact" };
  }
  const price = inferTokenPrice(metadata.provider, metadata.model);
  if (!metadata.usage || !price) return base;
  return { ...base, costUsd: estimateTokenCost(metadata.usage, price), costBasis: "estimated" };
}

export function summarizeCampaignCost(turns: readonly TurnGenerationMetadata[]): CampaignCostSummary {
  let totalUsd = 0;
  let exactTurns = 0;
  let estimatedTurns = 0;
  let unpricedTurns = 0;

  for (const turn of turns) {
    if (turn.usage?.billedCostUsd !== undefined) {
      totalUsd += turn.usage.billedCostUsd;
      exactTurns += 1;
      continue;
    }
    const price = inferTokenPrice(turn.provider, turn.model);
    if (turn.usage && price) {
      totalUsd += estimateTokenCost(turn.usage, price);
      estimatedTurns += 1;
      continue;
    }
    unpricedTurns += 1;
  }

  const basis = exactTurns > 0 && estimatedTurns === 0
    ? "exact"
    : exactTurns > 0
      ? "mixed"
      : "estimated";
  return {
    totalUsd: roundUsd(totalUsd),
    basis,
    pricedTurns: exactTurns + estimatedTurns,
    unpricedTurns,
  };
}

/** Combines immutable committed-turn aggregates without reopening earlier logs. */
export function combineCampaignCostSummaries(
  left: CampaignCostSummary,
  right: CampaignCostSummary,
): CampaignCostSummary {
  const pricedBases = [left, right]
    .filter((summary) => summary.pricedTurns > 0)
    .map((summary) => summary.basis);
  const basis = pricedBases.includes("mixed") || new Set(pricedBases).size > 1
    ? "mixed" as const
    : pricedBases[0] ?? "estimated";
  return {
    totalUsd: roundUsd(left.totalUsd + right.totalUsd),
    basis,
    pricedTurns: left.pricedTurns + right.pricedTurns,
    unpricedTurns: left.unpricedTurns + right.unpricedTurns,
  };
}
