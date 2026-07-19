import type { LanguageCode } from "./language.js";
import type {
  ModelLanguageQualityStatuses,
  ModelQualityStatus,
} from "./model-status.js";

export type ModelQualityRating = ModelQualityStatus;
export type ModelLanguageQualityRatings = ModelLanguageQualityStatuses;

/** Uncertified models have an explicit quality status rather than an implied label. */
export function modelQualityRatings(_provider: string, _modelId: string): ModelLanguageQualityRatings {
  return { en: "unrated", ru: "unrated" };
}

export function modelQualityRating(
  _provider: string,
  _modelId: string,
  _language: LanguageCode = "en",
): ModelQualityRating {
  return "unrated";
}
