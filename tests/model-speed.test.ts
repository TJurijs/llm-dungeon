import { describe, expect, it } from "vitest";
import { modelSpeedEstimate, modelSpeedRating } from "../src/model-speed.js";

describe("model speed ratings", () => {
  it("does not invent speed tiers for public models without measurement evidence", () => {
    expect(modelSpeedRating("gemini", "gemini-3.5-flash")).toBe("fast");
    expect(modelSpeedRating("gemini", "gemini-3.1-flash-lite")).toBe("fast");
    expect(modelSpeedRating("openrouter", "qwen/qwen3.7-plus")).toBe("average");
    expect(modelSpeedRating("xai", "grok-4.5")).toBe("slow");
    expect(modelSpeedRating("openai", "gpt-5.4")).toBe("fast");
    expect(modelSpeedRating("deepseek", "deepseek-v4-flash")).toBe("average");
    expect(modelSpeedRating("deepseek", "deepseek-v4-pro")).toBe("average");
    expect(modelSpeedRating("openrouter", "unmeasured/custom-model")).toBeUndefined();
  });

  it("retains measured retired-model history without making it a public-lineup claim", () => {
    expect(modelSpeedRating("anthropic", "claude-sonnet-4-6")).toBe("slow");
    expect(modelSpeedRating("xai", "grok-4.3")).toBe("fast");
  });

  it("marks concurrency-three acceptance latency as loaded legacy evidence", () => {
    expect(modelSpeedEstimate("gemini", "gemini-3.5-flash")).toMatchObject({
      ordinaryTurnSeconds: 12,
      checkedTurnSeconds: 24.6,
      sampleTurns: 45,
      measuredAt: "2026-07-18",
      latencyBasis: "loaded",
      concurrency: 3,
      evidence: {
        source: "legacy_evaluation",
        packageId: "evaluation-profile-matrix",
        packageVersion: "legacy-9x5",
        reference: "2026-07-18T10-07-08-899Z-66376c44-3cfa-46c2-a53b-b11745211c35",
      },
    });
    expect(modelSpeedEstimate("openrouter", "qwen/qwen3.7-plus")).toMatchObject({
      ordinaryTurnSeconds: 17.3,
      checkedTurnSeconds: 25.8,
      sampleTurns: 70,
      latencyBasis: "loaded",
      concurrency: 3,
      evidence: { source: "legacy_evaluation", reference: expect.any(String) },
    });
    expect(modelSpeedEstimate("xai", "grok-4.5")).toMatchObject({
      ordinaryTurnSeconds: 26.6,
      checkedTurnSeconds: 42.5,
      sampleTurns: 90,
      latencyBasis: "loaded",
      concurrency: 3,
      evidence: { source: "legacy_evaluation", reference: expect.any(String) },
    });
    expect(modelSpeedEstimate("deepseek", "deepseek-v4-flash")).toMatchObject({
      ordinaryTurnSeconds: 18.1,
      checkedTurnSeconds: 39.1,
      sampleTurns: 39,
      latencyBasis: "loaded",
      concurrency: 3,
      evidence: { source: "legacy_evaluation", reference: expect.any(String) },
    });
    expect(modelSpeedEstimate("gemini", "gemini-3.1-flash-lite")).toMatchObject({
      ordinaryTurnSeconds: 5.5,
      checkedTurnSeconds: 9.8,
      sampleTurns: 20,
      latencyBasis: "loaded",
      concurrency: 2,
      evidence: { source: "certification", packageVersion: "3" },
    });
  });

  it("keeps unmeasured estimates unknown", () => {
    expect(modelSpeedEstimate("openai", "gpt-5.4")).toMatchObject({
      ordinaryTurnSeconds: 8.5,
      checkedTurnSeconds: 19.3,
      sampleTurns: 20,
      concurrency: 2,
      evidence: { source: "certification", packageVersion: "3" },
    });
    expect(modelSpeedEstimate("deepseek", "deepseek-v4-pro")).toBeUndefined();
    expect(modelSpeedEstimate("openrouter", "unmeasured/custom-model")).toBeUndefined();
  });
});
