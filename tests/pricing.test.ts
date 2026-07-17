import { describe, expect, it } from "vitest";
import {
  estimateModelPrice,
  FIFTY_TURN_ESTIMATE,
  openRouterModelId,
  parseOpenRouterPrices,
} from "../src/pricing.js";
import { modelQualityRating } from "../src/model-quality.js";

describe("model price estimates", () => {
  it("maps direct-provider IDs to the matching OpenRouter catalog model", () => {
    expect(openRouterModelId("gemini", "gemini-3.5-flash")).toBe("google/gemini-3.5-flash");
    expect(openRouterModelId("openai", "gpt-5.4")).toBe("openai/gpt-5.4");
    expect(openRouterModelId("openai", "gpt-5.6-sol")).toBe("openai/gpt-5.6-sol");
    expect(openRouterModelId("anthropic", "claude-sonnet-4-6")).toBe("anthropic/claude-sonnet-4.6");
    expect(openRouterModelId("deepseek", "deepseek-v4-pro")).toBe("deepseek/deepseek-v4-pro");
    expect(openRouterModelId("openrouter", "vendor/model")).toBe("vendor/model");
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
    expect(estimateModelPrice("openai", "gpt-5.6-sol")?.estimated50TurnsUsd).toBe(5.7);
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

  it("assigns a three-level quality rating to every bundled model family", () => {
    expect(modelQualityRating("gemini", "gemini-3.5-flash")).toBe("high");
    expect(modelQualityRating("openrouter", "google/gemini-3.1-flash-lite")).toBe("low");
    expect(modelQualityRating("anthropic", "claude-haiku-4-5")).toBe("medium");
    expect(modelQualityRating("openai", "gpt-5.6-sol")).toBe("high");
    expect(modelQualityRating("anthropic", "claude-opus-4-8")).toBeUndefined();
    expect(modelQualityRating("deepseek", "deepseek-v4-pro")).toBeUndefined();
    expect(modelQualityRating("openai", "unknown-model")).toBeUndefined();
  });
});
