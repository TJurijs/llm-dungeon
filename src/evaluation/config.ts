import type { LanguageCode } from "../language.js";
import { ProviderConfigSchema, type ProviderConfig } from "../schemas.js";
import {
  EvaluationConfigSchema,
  type EvaluationConfig,
} from "./contracts.js";
import { configuredModelCost } from "./cost.js";

export function defaultPlayerConfig(dmConfig: ProviderConfig): ProviderConfig {
  const model = dmConfig.provider === "gemini"
    ? "gemini-3.1-flash-lite"
    : dmConfig.provider === "openrouter"
      ? "google/gemini-3.1-flash-lite"
      : dmConfig.model;
  return ProviderConfigSchema.parse({
    ...dmConfig,
    model,
    temperature: 0.9,
    maxOutputTokens: 1_500,
  });
}

export interface BuildEvaluationConfigInput {
  dmConfig: ProviderConfig;
  language?: LanguageCode | undefined;
  sessions?: number | undefined;
  turns?: number | undefined;
  concurrency?: number | undefined;
  maxCostUsd: number;
  playerProfiles?: EvaluationConfig["playerProfiles"] | undefined;
  playerModel?: string | undefined;
}

/** Builds the shared CLI/Web self-play configuration after surface-specific validation. */
export function buildEvaluationConfig(input: BuildEvaluationConfigInput): EvaluationConfig {
  const basePlayerConfig = defaultPlayerConfig(input.dmConfig);
  const playerConfig = ProviderConfigSchema.parse({
    ...basePlayerConfig,
    ...(input.playerModel ? { model: input.playerModel } : {}),
  });
  return EvaluationConfigSchema.parse({
    language: input.language,
    sessions: input.sessions ?? 1,
    turns: input.turns ?? 20,
    concurrency: input.concurrency,
    maxCostUsd: input.maxCostUsd,
    ...(input.playerProfiles ? { playerProfiles: input.playerProfiles } : {}),
    dm: {
      config: input.dmConfig,
      cost: configuredModelCost(input.dmConfig, "DM"),
    },
    player: {
      config: playerConfig,
      cost: configuredModelCost(playerConfig, "player"),
    },
  });
}
