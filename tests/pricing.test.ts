import { describe, expect, it } from "vitest";
import {
  estimateModelPrice,
  FIFTY_TURN_ESTIMATE,
  openRouterModelId,
  parseOpenRouterPrices,
} from "../src/pricing.js";
import {
  modelQualityRating,
  modelQualityRatings,
} from "../src/model-quality.js";
import { modelCostRating } from "../src/model-cost.js";

describe("model price estimates", () => {
  it("maps direct-provider IDs to the matching OpenRouter catalog model", () => {
    expect(openRouterModelId("gemini", "gemini-3.5-flash")).toBe("google/gemini-3.5-flash");
    expect(openRouterModelId("openai", "gpt-5.6-terra")).toBe("openai/gpt-5.6-terra");
    expect(openRouterModelId("openai", "gpt-5.6-sol")).toBe("openai/gpt-5.6-sol");
    expect(openRouterModelId("anthropic", "claude-sonnet-4-6")).toBe("anthropic/claude-sonnet-4.6");
    expect(openRouterModelId("deepseek", "deepseek-v4-pro")).toBe("deepseek/deepseek-v4-pro");
    expect(openRouterModelId("openrouter", "vendor/model")).toBe("vendor/model");
    expect(openRouterModelId("xai", "grok-4.5")).toBe("x-ai/grok-4.5");
  });

  it("uses one documented 50-turn workload for every known model", () => {
    expect(FIFTY_TURN_ESTIMATE).toMatchObject({ turns: 50, inputTokens: 480_000, outputTokens: 110_000 });
    expect(estimateModelPrice("gemini", "gemini-3.5-flash")).toEqual({
      sourceModel: "google/gemini-3.5-flash",
      inputPerMillion: 1.5,
      outputPerMillion: 9,
      estimated50TurnsUsd: 1.71,
    });
    expect(estimateModelPrice("openrouter", "deepseek/deepseek-v4-flash")?.estimated50TurnsUsd)
      .toBe(0.0686);
    expect(estimateModelPrice("openrouter", "minimax/minimax-m3")?.estimated50TurnsUsd)
      .toBe(0.276);
    expect(estimateModelPrice("openrouter", "tencent/hy3")?.estimated50TurnsUsd)
      .toBe(0.184);
    expect(estimateModelPrice("openrouter", "deepseek/deepseek-v3.2")?.estimated50TurnsUsd)
      .toBe(0.138358);
    expect(estimateModelPrice("openai", "gpt-5.6-sol")?.estimated50TurnsUsd).toBe(5.7);
    expect(estimateModelPrice("openai", "gpt-5.6-terra")?.estimated50TurnsUsd).toBe(2.85);
    expect(estimateModelPrice("openai", "gpt-5.6-luna")?.estimated50TurnsUsd).toBe(1.14);
    expect(estimateModelPrice("xai", "grok-4.5")?.estimated50TurnsUsd).toBe(1.62);
    expect(estimateModelPrice("xai", "grok-4.3")?.estimated50TurnsUsd).toBe(0.875);
    expect(estimateModelPrice("openai", "unknown-model")).toBeUndefined();
  });

  it("accepts current OpenRouter prices for custom model IDs", () => {
    const prices = parseOpenRouterPrices({
      data: [{ id: "vendor/custom", pricing: { prompt: "0.000001", completion: "0.000004" } }],
    });
    expect(estimateModelPrice("openrouter", "vendor/custom", prices)).toMatchObject({
      inputPerMillion: 1,
      outputPerMillion: 4,
      estimated50TurnsUsd: 0.92,
    });
  });

  it("keeps uncertified quality explicitly unrated", () => {
    expect(modelQualityRating("gemini", "gemini-3.5-flash")).toBe("unrated");
    expect(modelQualityRating("openrouter", "qwen/qwen3.7-plus", "ru")).toBe("unrated");
    expect(modelQualityRating("deepseek", "deepseek-v4-pro")).toBe("unrated");
    expect(modelQualityRating("openai", "unknown-model")).toBe("unrated");
    expect(modelQualityRatings("gemini", "gemini-3.5-flash")).toEqual({ en: "unrated", ru: "unrated" });
  });

  it("maps exact estimates to compact cost categories", () => {
    expect(modelCostRating({ estimated50TurnsUsd: 0.5 })).toBe("cheap");
    expect(modelCostRating({ estimated50TurnsUsd: 1.71 })).toBe("moderate");
    expect(modelCostRating(estimateModelPrice("xai", "grok-4.5"))).toBe("moderate");
    expect(modelCostRating(estimateModelPrice("xai", "grok-4.3"))).toBe("cheap");
    expect(modelCostRating({ estimated50TurnsUsd: 5.7 })).toBe("expensive");
    expect(modelCostRating({ estimated50TurnsUsd: 6.01 })).toBe("very-expensive");
    expect(modelCostRating(undefined)).toBeUndefined();
  });
});
