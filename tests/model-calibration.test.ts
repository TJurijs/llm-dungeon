import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_MODEL_EXECUTION_PROFILE_DRAFTS,
  type ModelExecutionProfileDraft,
} from "../src/model-execution-profile.js";
import {
  CalibrationEvidenceStore,
  calibrationEvidenceId,
  calibrationFailureStatus,
  runCalibrationVariants,
  runModelCalibrationProbe,
  selectCalibrationProfile,
} from "../src/playtest/calibration.js";
import { GenerationFailure } from "../src/llm/failures.js";
import type {
  LlmProvider,
  ProviderAttemptMetadata,
  StructuredRequest,
  StructuredResult,
} from "../src/types.js";

function requestedObject(prompt: string): unknown {
  const setup = prompt.indexOf("{");
  const gameplay = prompt.lastIndexOf('{"decision"');
  const start = gameplay >= 0 ? gameplay : setup;
  if (start < 0) throw new Error("Calibration prompt omitted its exact fixture");
  return JSON.parse(prompt.slice(start));
}

class ExactCalibrationProvider implements LlmProvider {
  constructor(
    readonly id: string,
    readonly model: string,
    private readonly truncated = false,
  ) {}

  async generateStructured<T>(request: StructuredRequest<T>): Promise<StructuredResult<T>> {
    const wire = requestedObject(request.prompt);
    const value = request.decodeResponse ? request.decodeResponse(wire) : wire;
    const phase = request.generationPhase ?? "decision";
    const attemptMetadata: ProviderAttemptMetadata = {
      provider: this.id,
      model: this.model,
      route: this.id === "openrouter" ? "openrouter" : "direct",
      generationPhase: phase,
      attemptKind: request.attemptKind ?? "initial",
      structuredMode: this.id === "deepseek" ? "json_object_local_schema" : "exact_schema",
      schemaProjection: "identity_v1",
      outputTokenField: this.id === "gemini" ? "maxOutputTokens" : "max_tokens",
      outputTokenBudget: request.maxOutputTokens ?? 4_000,
      retryBackoffMs: request.retryBackoffMs ?? 0,
      truncated: this.truncated,
    };
    return {
      data: request.schema.parse(value),
      provider: this.id,
      model: this.model,
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15, billedCostUsd: 0.001 },
      attemptMetadata,
    };
  }
}

describe("model calibration", () => {
  it("exercises all eight required non-scored protocol cases sequentially", async () => {
    const result = await runModelCalibrationProbe(new ExactCalibrationProvider("fake", "fake-model"));
    expect(result.passed).toBe(true);
    expect(result.cases.map((item) => item.caseId)).toEqual([
      "representative_setup",
      "resolved_real_effects",
      "check_required",
      "locked_resolution",
      "schema_repair_effect_completeness",
      "inventory_transfer_and_references",
      "production_sized_context",
      "near_normal_output",
    ]);
    expect(result.cases.map((item) => item.phase)).toEqual([
      "setup",
      "decision",
      "decision",
      "locked_resolution",
      "repair",
      "decision",
      "decision",
      "decision",
    ]);
  });

  it("retains every variant and selects lexicographically without quality scores", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "llm-dungeon-calibration-"));
    const evidenceStore = new CalibrationEvidenceStore(root);
    const base = DEFAULT_MODEL_EXECUTION_PROFILE_DRAFTS[0]!;
    const variant: ModelExecutionProfileDraft = {
      ...base,
      temperature: { policy: "omitted" },
    };
    const results = await runCalibrationVariants(
      [base, variant],
      (profile) => new ExactCalibrationProvider(
        profile.key.provider,
        profile.key.model,
        profile.temperature.policy === "fixed",
      ),
      {
        evidenceId: "gemini-calibration",
        evidenceStore,
        now: () => new Date("2026-07-19T12:00:00.000Z"),
      },
    );

    expect(results).toHaveLength(2);
    expect(results[1]?.changedVariable).toBe("temperature");
    expect(selectCalibrationProfile(results)?.profile.temperature).toEqual({ policy: "omitted" });
    const attempts = await evidenceStore.readAttempts("gemini-calibration");
    expect(attempts).toHaveLength(2);
    expect(attempts.map((attempt) => attempt.variantIndex)).toEqual([0, 1]);
  });

  it("adds only truncation-proven bounded budget steps and keeps route failures inconclusive", async () => {
    const base = DEFAULT_MODEL_EXECUTION_PROFILE_DRAFTS[0]!;
    const results = await runCalibrationVariants([base], (profile) =>
      new ExactCalibrationProvider(
        profile.key.provider,
        profile.key.model,
        profile.outputBudgets.setup < 16_000,
      ));
    expect(results).toHaveLength(2);
    expect(results[1]?.changedVariable).toBe("outputBudgets.setup");
    expect(results[1]?.profile.outputBudgets.setup).toBe(16_000);
    expect(results[1]?.probe.passed).toBe(true);

    const blocked = await runCalibrationVariants([base], () => ({
      id: "gemini",
      model: "gemini-3.5-flash",
      async generateStructured() {
        throw new GenerationFailure("rate_limit", "busy", true, 429);
      },
    }), { autoEscalateTruncation: false });
    expect(calibrationFailureStatus(blocked)).toBe("calibration_inconclusive");
    expect(calibrationFailureStatus(results.filter((result) => !result.probe.passed)))
      .toBe("no_compatible_profile");
  });

  it("rejects unsafe evidence IDs and unbounded or multi-variable variants before any calls", async () => {
    expect(() => calibrationEvidenceId("../lost-evidence")).toThrow("safe filename");
    const base = DEFAULT_MODEL_EXECUTION_PROFILE_DRAFTS[0]!;
    let providersCreated = 0;
    await expect(runCalibrationVariants(
      Array.from({ length: 9 }, () => base),
      () => {
        providersCreated += 1;
        return new ExactCalibrationProvider("gemini", "gemini-3.5-flash");
      },
    )).rejects.toThrow("between one and 8");
    await expect(runCalibrationVariants([
      base,
      {
        ...base,
        temperature: { policy: "omitted" },
        reasoning: { policy: "omitted" },
      },
    ], () => {
      providersCreated += 1;
      return new ExactCalibrationProvider("gemini", "gemini-3.5-flash");
    })).rejects.toThrow("exactly one variable");
    expect(providersCreated).toBe(0);
  });

  it("permits an explicit budget step only after the preceding probe proves truncation", async () => {
    const base = DEFAULT_MODEL_EXECUTION_PROFILE_DRAFTS[0]!;
    const nextSetup: ModelExecutionProfileDraft = {
      ...base,
      outputBudgets: { ...base.outputBudgets, setup: 16_000 },
    };
    let providersCreated = 0;
    await expect(runCalibrationVariants([base, nextSetup], (profile) => {
      providersCreated += 1;
      return new ExactCalibrationProvider(profile.key.provider, profile.key.model, false);
    }, { autoEscalateTruncation: false })).rejects.toThrow("requires confirmed truncation");
    expect(providersCreated).toBe(1);

    const skippedSetup: ModelExecutionProfileDraft = {
      ...base,
      outputBudgets: { ...base.outputBudgets, setup: 32_000 },
    };
    await expect(runCalibrationVariants([base, skippedSetup], () => {
      providersCreated += 1;
      return new ExactCalibrationProvider("gemini", "gemini-3.5-flash", true);
    })).rejects.toThrow("next bounded truncation-escalation step");
    expect(providersCreated).toBe(1);
  });
});
