import { estimateTokenCost, inferTokenPrice, roundUsd } from "./pricing.js";
import type { TurnGenerationMetadata } from "./persistence/markdown.js";

export interface CampaignCostSummary {
  totalUsd: number;
  basis: "exact" | "estimated" | "mixed";
  pricedTurns: number;
  unpricedTurns: number;
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
