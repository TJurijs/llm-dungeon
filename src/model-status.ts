import { z } from "zod";
import type { LanguageCode } from "./language.js";

export const ModelAdapterStatusSchema = z.enum([
  "uncalibrated",
  "calibrated",
  "calibration_inconclusive",
  "no_compatible_profile",
]);
export type ModelAdapterStatus = z.infer<typeof ModelAdapterStatusSchema>;

export const ModelTechnicalGameplayStatusSchema = z.enum([
  "clean",
  "playable_with_recovery",
  "unstable",
  "unsupported",
  "inconclusive",
]);
export type ModelTechnicalGameplayStatus = z.infer<typeof ModelTechnicalGameplayStatusSchema>;

export const ModelQualityStatusSchema = z.enum([
  "high",
  "medium",
  "low",
  "unrated",
  "awaiting_judgment",
]);
export type ModelQualityStatus = z.infer<typeof ModelQualityStatusSchema>;

export type ModelLanguageTechnicalStatuses = Partial<
  Record<LanguageCode, ModelTechnicalGameplayStatus>
>;
export type ModelLanguageQualityStatuses = Partial<Record<LanguageCode, ModelQualityStatus>>;

export const ModelEvidenceReferenceSchema = z.object({
  source: z.enum(["calibration", "certification", "legacy_evaluation"]),
  reference: z.string().trim().min(1).max(500),
  packageId: z.string().trim().min(1).max(100).optional(),
  packageVersion: z.string().trim().min(1).max(100).optional(),
  executionProfileFingerprint: z.string().trim().min(1).max(500).optional(),
  recordedAt: z.string().datetime({ offset: true }).optional(),
}).strict();
export type ModelEvidenceReference = z.infer<typeof ModelEvidenceReferenceSchema>;

export const ModelRecommendationEligibilitySchema = z.object({
  eligible: z.boolean(),
  reasons: z.array(z.string().trim().min(1).max(200)).max(20),
  evidence: ModelEvidenceReferenceSchema.optional(),
}).strict();
export type ModelRecommendationEligibility = z.infer<
  typeof ModelRecommendationEligibilitySchema
>;
