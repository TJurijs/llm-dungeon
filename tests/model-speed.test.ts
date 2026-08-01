import { describe, expect, it } from "vitest";
import { modelSpeedEstimate, modelSpeedRating } from "../src/model-speed.js";

describe("model speed ratings", () => {
  it("reports no speed at all while nothing has been imported", () => {
    // The measured per-route figures came from certification runs and went with
    // it. OpenRouter's public models endpoint publishes prices and no
    // throughput, so there is nothing to import from the named source yet.
    // Unknown is the honest answer; a plausible invented number stamped with a
    // checkedAt date would read as verified evidence.
    for (const [provider, model] of [
      ["gemini", "gemini-3.6-flash"],
      ["gemini", "gemini-3.5-flash"],
      ["openai", "gpt-5.4"],
      ["anthropic", "claude-sonnet-5"],
      ["deepseek", "deepseek-v4-flash"],
      ["openrouter", "qwen/qwen3.7-plus"],
      ["xai", "grok-4.5"],
      ["openrouter", "unmeasured/custom-model"],
    ] as const) {
      expect(modelSpeedRating(provider, model)).toBeUndefined();
      expect(modelSpeedEstimate(provider, model)).toBeUndefined();
    }
  });
});
