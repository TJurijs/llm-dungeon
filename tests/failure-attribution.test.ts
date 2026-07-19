import { describe, expect, it } from "vitest";
import { GenerationFailure } from "../src/llm/failures.js";
import { attributePlaytestFailure } from "../src/playtest/failure-attribution.js";
import type { ProviderAttemptMetadata } from "../src/types.js";

const metadata: ProviderAttemptMetadata = {
  provider: "openai",
  model: "gpt-5.6-terra",
  route: "direct",
  generationPhase: "decision",
  attemptKind: "initial",
  structuredMode: "exact_schema",
  schemaProjection: "openai_strict_v1",
  outputTokenField: "max_completion_tokens",
  outputTokenBudget: 4_000,
  retryBackoffMs: 0,
  truncated: false,
};

describe("playtest failure attribution", () => {
  it("attributes account, route, adapter, and candidate failures independently", () => {
    expect(attributePlaytestFailure(
      new GenerationFailure("provider", "forbidden", false, 403),
      { lane: "candidate" },
    )).toMatchObject({ owner: "account_access", candidateStatusImpact: "inconclusive" });
    expect(attributePlaytestFailure(
      new GenerationFailure("rate_limit", "busy", true, 429),
      { lane: "candidate" },
    )).toMatchObject({ owner: "provider_route", candidateStatusImpact: "inconclusive" });
    expect(attributePlaytestFailure(
      new GenerationFailure("schema_rejected", "unsupported field", false, 400),
      { lane: "candidate" },
    )).toMatchObject({ owner: "adapter_configuration", candidateStatusImpact: "inconclusive" });
    expect(attributePlaytestFailure(
      new GenerationFailure("malformed_json", "bad output", true),
      { lane: "candidate", attemptMetadata: metadata },
    )).toMatchObject({ owner: "candidate_model", candidateStatusImpact: "counts" });
  });

  it("keeps truncation, judge, player, and application ownership out of candidate scoring", () => {
    expect(attributePlaytestFailure(
      new GenerationFailure("malformed_json", "truncated", true),
      { lane: "candidate", attemptMetadata: { ...metadata, truncated: true } },
    ).owner).toBe("adapter_configuration");
    expect(attributePlaytestFailure(
      new GenerationFailure("wire_schema_violation", "bad judge", true),
      { lane: "judge" },
    )).toMatchObject({ owner: "judge", candidateStatusImpact: "excluded" });
    expect(attributePlaytestFailure(new Error("judge provider failed"), {
      lane: "judge",
      stage: "provider_call",
    })).toMatchObject({ owner: "judge", candidateStatusImpact: "excluded" });
    expect(attributePlaytestFailure(
      new GenerationFailure("malformed_json", "bad player", true),
      { lane: "player_driver" },
    )).toMatchObject({ owner: "player_driver", candidateStatusImpact: "excluded" });
    expect(attributePlaytestFailure(new Error("disk"), {
      lane: "candidate",
      stage: "persistence",
    })).toMatchObject({ owner: "application", candidateStatusImpact: "inconclusive" });
  });
});
