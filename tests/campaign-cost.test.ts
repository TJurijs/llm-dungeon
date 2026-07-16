import { describe, expect, it } from "vitest";
import { summarizeCampaignCost } from "../src/campaign-cost.js";

describe("campaign cost", () => {
  it("prefers exact billed cost and estimates legacy Gemini usage", () => {
    expect(summarizeCampaignCost([
      {
        turn: 0,
        provider: "openrouter",
        model: "google/gemini-3.5-flash",
        usage: { inputTokens: 100, outputTokens: 50, billedCostUsd: 0.0042 },
      },
      {
        turn: 1,
        provider: "gemini",
        model: "gemini-3.5-flash",
        usage: { inputTokens: 10_000, outputTokens: 1_000 },
      },
      { turn: 2, provider: "setup", model: "setup" },
    ])).toEqual({
      totalUsd: 0.0282,
      basis: "mixed",
      pricedTurns: 2,
      unpricedTurns: 1,
    });
  });
});
