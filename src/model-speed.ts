import { openRouterModelId } from "./pricing.js";

export type ModelSpeedRating = "fast" | "average" | "slow";

/** Rough responsiveness tiers measured during focused release evaluation runs. */
const MODEL_SPEED: Readonly<Record<string, ModelSpeedRating>> = {
  "google/gemini-3.5-flash": "fast",
  "google/gemini-3.1-pro-preview": "average",
  "google/gemini-3.1-flash-lite": "fast",
  "openai/gpt-5.6-sol": "average",
  "openai/gpt-5.4": "average",
  "openai/gpt-5.4-mini": "fast",
  "openai/gpt-5-mini": "average",
  "openai/gpt-4.1": "fast",
  "anthropic/claude-sonnet-4.6": "average",
  "anthropic/claude-haiku-4.5": "average",
  "anthropic/claude-opus-4.8": "slow",
  "deepseek/deepseek-v4-flash": "average",
  "deepseek/deepseek-v4-pro": "slow",
  "moonshotai/kimi-k2.6": "average",
  "qwen/qwen3.7-plus": "slow",
  "x-ai/grok-4.5": "slow",
};

export function modelSpeedRating(provider: string, modelId: string): ModelSpeedRating | undefined {
  return MODEL_SPEED[openRouterModelId(provider, modelId)];
}
