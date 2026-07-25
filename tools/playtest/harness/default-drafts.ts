import {
  defaultModelExecutionProfileDraftForKey,
  type ModelExecutionProfileDraft,
} from "../../../src/model-execution-profile.js";
import type { ProviderConfig } from "../../../src/schemas.js";

/** Exact starting draft for a model, or its provider's draft re-keyed to it. */
export function defaultDraftFor(config: ProviderConfig, route: string): ModelExecutionProfileDraft {
  return defaultModelExecutionProfileDraftForKey({
    provider: config.provider,
    model: config.model,
    route,
  });
}
