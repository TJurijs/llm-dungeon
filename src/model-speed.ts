import { openRouterModelId } from "./pricing.js";

export type ModelSpeedRating = "fast" | "average" | "slow" | "very-slow";

/**
 * Throughput published by OpenRouter for its own routed endpoint.
 *
 * Speed used to come from completed acceptance runs, which tied every figure to
 * a paid run of a specific package on a specific route. Certification produced
 * those runs and certification is gone, so those numbers describe a process
 * that no longer exists and were removed rather than left to age.
 *
 * The replacement source is OpenRouter's public catalogue, carried with its
 * provenance the way `pricing.ts` already carries prices. **The table below is
 * deliberately empty.** The endpoint `pricing.ts` reads,
 * `https://openrouter.ai/api/v1/models`, publishes `pricing.prompt` and
 * `pricing.completion` and no throughput field, so there is nothing there to
 * import. Inventing plausible tokens-per-second values and stamping them with a
 * `checkedAt` date would read as verified evidence, which is the one thing this
 * project does not do with model data.
 *
 * To populate it: fetch a source that actually publishes per-endpoint
 * throughput, paste the figures below keyed by `openRouterModelId`, and move
 * `CHECKED_AT` to the date you read them. Until then every model reports an
 * unknown speed, which is true.
 *
 * `routeMismatch` exists for when it is populated: AGENTS.md separates direct
 * and aggregator routes deliberately because they differ, so a figure measured
 * on OpenRouter's endpoint describes a direct provider route only
 * approximately, and the presentation has to say so.
 */
export interface ModelSpeedEstimate {
  source: "openrouter_published";
  sourceUrl: string;
  checkedAt: string;
  outputTokensPerSecond: number;
  routeMismatch: boolean;
}

const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";

/** Date the throughput figures below were read. Move it whenever they change. */
const CHECKED_AT = "";

/** Published output throughput in tokens per second, keyed like pricing. */
const PUBLISHED_TOKENS_PER_SECOND: Readonly<Record<string, number>> = {};

/**
 * Coarse tiers over the published throughput.
 *
 * Thresholds rather than a hand-maintained table, so a refreshed snapshot moves
 * the tier with it instead of leaving a pinned label that contradicts the
 * number printed beside it.
 */
function ratingFor(tokensPerSecond: number): ModelSpeedRating {
  if (tokensPerSecond >= 130) return "fast";
  if (tokensPerSecond >= 60) return "average";
  if (tokensPerSecond >= 35) return "slow";
  return "very-slow";
}

export function modelSpeedRating(provider: string, modelId: string): ModelSpeedRating | undefined {
  const published = PUBLISHED_TOKENS_PER_SECOND[openRouterModelId(provider, modelId)];
  return published === undefined ? undefined : ratingFor(published);
}

export function modelSpeedEstimate(
  provider: string,
  modelId: string,
): ModelSpeedEstimate | undefined {
  const published = PUBLISHED_TOKENS_PER_SECOND[openRouterModelId(provider, modelId)];
  if (published === undefined) return undefined;
  return {
    source: "openrouter_published",
    sourceUrl: OPENROUTER_MODELS_URL,
    checkedAt: CHECKED_AT,
    outputTokensPerSecond: published,
    routeMismatch: provider !== "openrouter",
  };
}
