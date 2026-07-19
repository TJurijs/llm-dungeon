import type { ModelPriceEstimate } from "./pricing.js";

export type ModelCostRating = "cheap" | "moderate" | "expensive" | "very-expensive";

/** Stable tiers for the shared 50-turn estimate shown in model settings. */
export function modelCostRating(
  pricing: Pick<ModelPriceEstimate, "estimated50TurnsUsd"> | undefined,
): ModelCostRating | undefined {
  const amount = pricing?.estimated50TurnsUsd;
  if (typeof amount !== "number" || !Number.isFinite(amount)) return undefined;
  if (amount < 1) return "cheap";
  if (amount <= 3) return "moderate";
  if (amount <= 6) return "expensive";
  return "very-expensive";
}
