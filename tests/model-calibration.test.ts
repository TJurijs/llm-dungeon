import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  DEFAULT_MODEL_EXECUTION_PROFILE_DRAFTS,
  freezeModelExecutionProfile,
  outputBudgetForPhase,
  type ModelExecutionProfileDraft,
  type ModelGenerationPhase,
} from "../src/model-execution-profile.js";
import {
  CalibrationEvidenceStore,
  calibrationEvidenceId,
  calibrationFailureStatus,
  runCalibrationVariants,
  runModelCalibrationProbe,
  selectCalibrationProfile,
  validateCalibrationTruncationEvidence,
} from "../tools/playtest/harness/calibration.js";
import { GenerationFailure } from "../src/llm/failures.js";
import { createDiagnosticBundle } from "../tools/playtest/harness/replay.js";
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
    const wire =
      request.schemaName === "calibration_campaign_setup_v1" &&
      !request.prompt.startsWith("Return exactly this representative campaign setup:")
        ? {
            campaignTitle: "Production Seed Calibration",
            scenarioMarkdown: "A production-sized scenario seed.",
            openingNarration: "The campaign begins with an actionable situation.",
            timeLabel: "Evening",
            player: {
              id: "player:hero",
              kind: "person",
              name: "Ilya",
              status: "active",
              location: "location:start",
              tags: [],
              description: "A careful traveler.",
              establishedFacts: [],
              secrets: [],
              playerKnowledge: [],
              traits: [],
              conditions: [],
              inventory: [],
            },
            entities: [
              {
                id: "location:start",
                kind: "location",
                name: "Starting Point",
                status: "quiet",
                tags: [],
                description: "A durable starting location.",
                establishedFacts: [],
                secrets: [],
                playerKnowledge: [],
                traits: [],
                conditions: [],
                inventory: [],
              },
            ],
            threads: [],
          }
        : requestedObject(request.prompt);
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

const EvidenceSchema = z.object({ answer: z.string() }).strict();

function truncationEvidence(
  baseline: ModelExecutionProfileDraft,
  phase: ModelGenerationPhase,
  reference = `diagnostics/${phase}.json`,
) {
  const profile = freezeModelExecutionProfile({
    ...baseline,
    calibratedAt: "2026-07-19T00:00:00.000Z",
    evidenceRef: "calibration:baseline",
  });
  const repairOfPhase = phase === "repair" ? ("setup" as const) : undefined;
  const budget = outputBudgetForPhase(profile, phase, repairOfPhase);
  return {
    reference,
    bundle: createDiagnosticBundle({
      expectedPhase: phase,
      profile,
      stateSnapshot: "safe diagnostic state",
      request: {
        schemaName: `${phase}_truncation`,
        schema: EvidenceSchema,
        system: "Return JSON.",
        prompt: "Return the exact object.",
        maxOutputTokens: budget,
        generationPhase: phase,
        ...(repairOfPhase ? { repairOfPhase } : {}),
        attemptKind: "initial",
      },
      responseMetadata: {
        attemptMetadata: {
          provider: profile.key.provider,
          model: profile.key.model,
          route: profile.key.route,
          generationPhase: phase,
          attemptKind: "initial",
          profileFingerprint: profile.fingerprint,
          structuredMode: "exact_schema",
          schemaProjection: profile.structuredOutput.projection,
          outputTokenField: profile.outputTokenField,
          outputTokenBudget: budget,
          retryBackoffMs: 0,
          finishReason: "MAX_TOKENS",
          truncated: true,
        },
      },
      attribution: {
        owner: "adapter_configuration",
        lane: "candidate",
        failureKind: "malformed_json",
        reason: "output_budget_truncation",
        candidateStatusImpact: "inconclusive",
      },
      failureKind: "malformed_json",
      failureMessage: "Provider response was truncated before the root JSON value completed",
      now: new Date("2026-07-20T00:00:00.000Z"),
    }),
  };
}

describe("model calibration", () => {
  it("exercises all eight required non-scored protocol cases sequentially", async () => {
    const result = await runModelCalibrationProbe(
      new ExactCalibrationProvider("fake", "fake-model"),
    );
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
      (profile) =>
        new ExactCalibrationProvider(
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
    const results = await runCalibrationVariants(
      [base],
      (profile) =>
        new ExactCalibrationProvider(
          profile.key.provider,
          profile.key.model,
          profile.outputBudgets.setup < 16_000,
        ),
    );
    expect(results).toHaveLength(2);
    expect(results[1]?.changedVariable).toBe("outputBudgets.setup");
    expect(results[1]?.profile.outputBudgets.setup).toBe(16_000);
    expect(results[1]?.probe.passed).toBe(true);

    const blocked = await runCalibrationVariants(
      [base],
      () => ({
        id: "gemini",
        model: "gemini-3.5-flash",
        async generateStructured() {
          throw new GenerationFailure("rate_limit", "busy", true, 429);
        },
      }),
      { autoEscalateTruncation: false },
    );
    expect(calibrationFailureStatus(blocked)).toBe("calibration_inconclusive");
    expect(calibrationFailureStatus(results.filter((result) => !result.probe.passed))).toBe(
      "no_compatible_profile",
    );
  });

  it("uses a production scenario seed to prove setup truncation before escalating", async () => {
    const base = DEFAULT_MODEL_EXECUTION_PROFILE_DRAFTS[0]!;
    const results = await runCalibrationVariants(
      [base],
      (profile) =>
        new ExactCalibrationProvider(
          profile.key.provider,
          profile.key.model,
          profile.outputBudgets.setup < 16_000,
        ),
      {
        probeOptions: {
          setupInput: {
            worldRules: "Grounded frontier rules.",
            premise: "A detailed production-sized mystery.",
            character: "A courier captain with a small crew.",
            language: "ru",
          },
        },
      },
    );

    expect(results).toHaveLength(2);
    expect(results[0]?.probe.cases[0]).toMatchObject({
      caseId: "representative_setup",
      success: true,
      attemptMetadata: { truncated: true },
    });
    expect(results[1]?.profile.outputBudgets.setup).toBe(16_000);
    expect(results[1]?.probe.passed).toBe(true);
  });

  it("validates exact-baseline truncation diagnostics and rejects mismatched evidence", () => {
    const base = DEFAULT_MODEL_EXECUTION_PROFILE_DRAFTS[0]!;
    const valid = truncationEvidence(base, "setup");
    expect(validateCalibrationTruncationEvidence(base, [valid])).toEqual([
      {
        reference: "diagnostics/setup.json",
        phase: "setup",
        baselineProfileFingerprint: valid.bundle.executionProfile.fingerprint,
        observedOutputTokenBudget: 8_000,
        requiredOutputTokenBudget: 16_000,
      },
    ]);

    const wrongTarget = structuredClone(valid);
    wrongTarget.bundle.model = "another-model";
    expect(() => validateCalibrationTruncationEvidence(base, [wrongTarget])).toThrow(
      "expected gemini/gemini-3.5-flash via direct",
    );

    const wrongBudget = structuredClone(valid);
    (
      wrongBudget.bundle.responseMetadata.attemptMetadata as Record<string, unknown>
    ).outputTokenBudget = 4_000;
    expect(() => validateCalibrationTruncationEvidence(base, [wrongBudget])).toThrow(
      "expected the full baseline phase budget 8000",
    );

    const wrongReason = structuredClone(valid);
    wrongReason.bundle.failure.attribution.reason = "lane_model_output_failure";
    expect(() => validateCalibrationTruncationEvidence(base, [wrongReason])).toThrow(
      "not attributed to output-budget truncation",
    );
  });

  it("applies multiple same-baseline evidence minima one variable at a time", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "llm-dungeon-evidence-calibration-"));
    const store = new CalibrationEvidenceStore(root);
    const base = DEFAULT_MODEL_EXECUTION_PROFILE_DRAFTS[0]!;
    const refs = validateCalibrationTruncationEvidence(base, [
      truncationEvidence(base, "setup"),
      truncationEvidence(base, "decision"),
    ]);
    const results = await runCalibrationVariants(
      [base],
      (profile) => new ExactCalibrationProvider(profile.key.provider, profile.key.model),
      {
        evidenceId: "production-truncations",
        evidenceStore: store,
        now: () => new Date("2026-07-21T00:00:00.000Z"),
        truncationEvidenceRefs: refs,
      },
    );

    expect(results.map((result) => result.changedVariable)).toEqual([
      undefined,
      "outputBudgets.setup",
      "outputBudgets.decision",
    ]);
    expect(results.map((result) => result.profile.outputBudgets)).toEqual([
      expect.objectContaining({ setup: 8_000, decision: 4_000 }),
      expect.objectContaining({ setup: 16_000, decision: 4_000 }),
      expect.objectContaining({ setup: 16_000, decision: 8_000 }),
    ]);
    expect(
      selectCalibrationProfile(results, { truncationEvidenceRefs: refs })?.profile.outputBudgets,
    ).toMatchObject({ setup: 16_000, decision: 8_000 });
    const attempts = await store.readAttempts("production-truncations");
    expect(attempts).toHaveLength(3);
    expect(attempts.every((attempt) => attempt.truncationEvidenceRefs?.length === 2)).toBe(true);
    const selection = JSON.parse(
      await readFile(path.join(root, "production-truncations", "selection.json"), "utf8"),
    ) as { truncationEvidenceRefs?: unknown[] };
    expect(selection.truncationEvidenceRefs).toHaveLength(2);
  });

  it("does not select an evidence-escalated profile unless its full suite passes", async () => {
    const base = DEFAULT_MODEL_EXECUTION_PROFILE_DRAFTS[0]!;
    const refs = validateCalibrationTruncationEvidence(base, [truncationEvidence(base, "setup")]);
    const results = await runCalibrationVariants(
      [base],
      (profile) =>
        profile.outputBudgets.setup === 8_000
          ? new ExactCalibrationProvider(profile.key.provider, profile.key.model)
          : {
              id: profile.key.provider,
              model: profile.key.model,
              async generateStructured() {
                throw new GenerationFailure("provider", "escalated probe failed", false);
              },
            },
      { truncationEvidenceRefs: refs },
    );

    expect(results).toHaveLength(2);
    expect(results[0]?.probe.passed).toBe(true);
    expect(results[1]?.probe.passed).toBe(false);
    expect(selectCalibrationProfile(results, { truncationEvidenceRefs: refs })).toBeUndefined();
  });

  it("rejects unsafe evidence IDs and unbounded or multi-variable variants before any calls", async () => {
    expect(() => calibrationEvidenceId("../lost-evidence")).toThrow("safe filename");
    const base = DEFAULT_MODEL_EXECUTION_PROFILE_DRAFTS[0]!;
    let providersCreated = 0;
    await expect(
      runCalibrationVariants(
        Array.from({ length: 9 }, () => base),
        () => {
          providersCreated += 1;
          return new ExactCalibrationProvider("gemini", "gemini-3.5-flash");
        },
      ),
    ).rejects.toThrow("between one and 8");
    await expect(
      runCalibrationVariants(
        [
          base,
          {
            ...base,
            temperature: { policy: "omitted" },
            reasoning: { policy: "omitted" },
          },
        ],
        () => {
          providersCreated += 1;
          return new ExactCalibrationProvider("gemini", "gemini-3.5-flash");
        },
      ),
    ).rejects.toThrow("exactly one variable");
    expect(providersCreated).toBe(0);
  });

  it("permits an explicit budget step only after the preceding probe proves truncation", async () => {
    const base = DEFAULT_MODEL_EXECUTION_PROFILE_DRAFTS[0]!;
    const nextSetup: ModelExecutionProfileDraft = {
      ...base,
      outputBudgets: { ...base.outputBudgets, setup: 16_000 },
    };
    let providersCreated = 0;
    await expect(
      runCalibrationVariants(
        [base, nextSetup],
        (profile) => {
          providersCreated += 1;
          return new ExactCalibrationProvider(profile.key.provider, profile.key.model, false);
        },
        { autoEscalateTruncation: false },
      ),
    ).rejects.toThrow("requires confirmed truncation");
    expect(providersCreated).toBe(1);

    const skippedSetup: ModelExecutionProfileDraft = {
      ...base,
      outputBudgets: { ...base.outputBudgets, setup: 32_000 },
    };
    await expect(
      runCalibrationVariants([base, skippedSetup], () => {
        providersCreated += 1;
        return new ExactCalibrationProvider("gemini", "gemini-3.5-flash", true);
      }),
    ).rejects.toThrow("next bounded truncation-escalation step");
    expect(providersCreated).toBe(1);
  });
});
