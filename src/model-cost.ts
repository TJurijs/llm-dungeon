import { openRouterModelId, type ModelPriceEstimate } from "./pricing.js";

export type ModelCostRating = "cheap" | "moderate" | "expensive" | "very-expensive";

/**
 * Hand-pinned cost tiers that override the price-only formula, keyed the same
 * way as the speed map (`openRouterModelId(provider, model)`).
 *
 * The shared 50-turn estimate applies one fixed token basis (480k in / 110k
 * out) to every model, so it captures price-per-token differences but not
 * differences in how many tokens a model actually burns per turn. A model can
 * therefore cost materially more in practice than its estimate implies.
 */
const MODEL_COST_OVERRIDE: Readonly<Record<string, ModelCostRating>> = {
  // Sonnet 5's real cost runs above its price-only estimate (~$3.09 at $3/$15
  // per M would land it in "expensive"): it is the only certified model that
  // overflowed the default output budgets (it is more verbose) AND it uses the
  // newer ~30%-heavier tokenizer, so it consumes materially more tokens per
  // turn than the shared 50-turn basis assumes. Pin it to the top tier.
  "anthropic/claude-sonnet-5": "very-expensive",
};

/** Stable tiers for the shared 50-turn estimate shown in model settings. */
export function modelCostRating(
  pricing: Pick<ModelPriceEstimate, "estimated50TurnsUsd"> | undefined,
  provider?: string,
  modelId?: string,
): ModelCostRating | undefined {
  if (provider !== undefined && modelId !== undefined) {
    const override = MODEL_COST_OVERRIDE[openRouterModelId(provider, modelId)];
    if (override !== undefined) return override;
  }
  const amount = pricing?.estimated50TurnsUsd;
  if (typeof amount !== "number" || !Number.isFinite(amount)) return undefined;
  if (amount < 1) return "cheap";
  if (amount <= 3) return "moderate";
  if (amount <= 6) return "expensive";
  return "very-expensive";
}
