import { describe, expect, it } from "vitest";
import { LLM_PROVIDER_DEFINITIONS } from "../src/llm-model-catalog.js";
import { modelSpeedRating } from "../src/model-speed.js";

describe("model speed ratings", () => {
  it("rates every curated model", () => {
    for (const provider of LLM_PROVIDER_DEFINITIONS) {
      for (const model of provider.candidateModels) {
        expect(modelSpeedRating(provider.id, model), `${provider.id}:${model}`).toMatch(/^(fast|average|slow)$/);
      }
    }
  });

  it("uses the focused release-run responsiveness tiers", () => {
    expect(modelSpeedRating("gemini", "gemini-3.5-flash")).toBe("fast");
    expect(modelSpeedRating("openai", "gpt-5.4-mini")).toBe("fast");
    expect(modelSpeedRating("anthropic", "claude-haiku-4-5")).toBe("average");
    expect(modelSpeedRating("anthropic", "claude-opus-4-8")).toBe("slow");
    expect(modelSpeedRating("deepseek", "deepseek-v4-pro")).toBe("slow");
    expect(modelSpeedRating("openrouter", "unmeasured/custom-model")).toBeUndefined();
  });
});
