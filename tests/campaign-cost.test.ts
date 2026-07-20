import { writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { replyGeneration, summarizeCampaignCost } from "../src/campaign-cost.js";
import { createTestStore } from "./helpers.js";

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

  it("projects safe exact or estimated per-reply costs", () => {
    expect(replyGeneration({
      provider: "openrouter",
      model: "moonshotai/kimi-k2.6",
      usage: { inputTokens: 100, outputTokens: 50, billedCostUsd: 0.0042 },
    })).toEqual({ provider: "openrouter", model: "moonshotai/kimi-k2.6", costUsd: 0.0042, costBasis: "exact" });
    expect(replyGeneration({
      provider: "gemini",
      model: "gemini-3.5-flash",
      usage: { inputTokens: 10_000, outputTokens: 1_000 },
    })).toEqual({ provider: "gemini", model: "gemini-3.5-flash", costUsd: 0.024, costBasis: "estimated" });
  });

  it("increments a cached committed-turn total without reopening immutable history", async () => {
    const store = await createTestStore();
    expect(await store.campaignCost()).toEqual({
      totalUsd: 0,
      basis: "estimated",
      pricedTurns: 0,
      unpricedTurns: 1,
    });
    await store.commitTurn({
      action: "Wait and watch.",
      resolved: { narration: "You wait.", turnSummary: "Time passes.", operations: [] },
      provider: "gemini",
      model: "gemini-3.5-flash",
      usage: { inputTokens: 10_000, outputTokens: 1_000 },
    });

    // A committed historical log is immutable. Making it unreadable here proves
    // the same store advanced its cached aggregate from the newly committed log.
    await writeFile(path.join(store.currentDir, "turns", "000000.md"), "invalid historical fixture", "utf8");
    expect(await store.campaignCost()).toEqual({
      totalUsd: 0.024,
      basis: "estimated",
      pricedTurns: 1,
      unpricedTurns: 1,
    });
  });
});
