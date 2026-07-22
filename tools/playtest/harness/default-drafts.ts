import {
  DEFAULT_MODEL_EXECUTION_PROFILE_DRAFTS,
  ModelExecutionProfileDraftSchema,
  type ModelExecutionProfileDraft,
} from "../../../src/model-execution-profile.js";
import type { ProviderConfig } from "../../../src/schemas.js";

/** Exact starting draft for a model, or its provider's draft re-keyed to it. */
export function defaultDraftFor(config: ProviderConfig, route: string): ModelExecutionProfileDraft {
  const exact = DEFAULT_MODEL_EXECUTION_PROFILE_DRAFTS.find((profile) =>
    profile.key.provider === config.provider
    && profile.key.model === config.model
    && profile.key.route === route);
  if (exact) return structuredClone(exact);
  const providerDefault = DEFAULT_MODEL_EXECUTION_PROFILE_DRAFTS.find((profile) =>
    profile.key.provider === config.provider && profile.key.route === route);
  if (!providerDefault) {
    throw new Error(
      `No starting calibration profile exists for ${config.provider} via ${route}; provide --variant <file>`,
    );
  }
  return ModelExecutionProfileDraftSchema.parse({
    ...structuredClone(providerDefault),
    key: { provider: config.provider, model: config.model, route },
  });
}
