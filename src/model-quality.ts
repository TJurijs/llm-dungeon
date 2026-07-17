import { openRouterModelId } from "./pricing.js";

export type ModelQualityRating = "low" | "medium" | "high";

const MODEL_QUALITY: Readonly<Record<string, ModelQualityRating>> = {
  "google/gemini-3.5-flash": "high",
  "google/gemini-3.1-pro-preview": "high",
  "google/gemini-3.1-flash-lite": "low",
  "openai/gpt-5.6-sol": "high",
  "openai/gpt-5.4": "high",
  "openai/gpt-5.4-mini": "medium",
  "openai/gpt-5-mini": "medium",
  "openai/gpt-4.1": "medium",
  "anthropic/claude-sonnet-4.6": "high",
  "anthropic/claude-haiku-4.5": "medium",
  "anthropic/claude-opus-4.8": "high",
  "deepseek/deepseek-v4-flash": "medium",
  "deepseek/deepseek-v4-pro": "high",
  "moonshotai/kimi-k2.6": "high",
  "qwen/qwen3.7-plus": "medium",
  "x-ai/grok-4.5": "high",
};

export function modelQualityRating(provider: string, modelId: string): ModelQualityRating | undefined {
  return MODEL_QUALITY[openRouterModelId(provider, modelId)];
}
