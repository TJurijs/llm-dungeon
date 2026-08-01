import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { GenerationFailure } from "../src/llm/failures.js";
import { createDomainRepairCause } from "../src/llm/domain-repair-cause.js";
import { DomainValidationError } from "../src/domain/validation-error.js";
import { attachStructuredFailure } from "../src/llm/structured-error.js";
import {
  DEFAULT_MODEL_EXECUTION_PROFILE_DRAFTS,
  freezeModelExecutionProfile,
  type FrozenModelExecutionProfile,
} from "../src/model-execution-profile.js";
import type {
  LlmProvider,
  ProviderAttemptMetadata,
  StructuredRequest,
  StructuredResult,
} from "../src/types.js";
import { CandidateTechnicalSnapshotSchema } from "../tools/playtest/harness/assessment.js";
import {
  PlaytestCallRecordSchema,
  PlaytestDomainRepairDiagnosticSchema,
  PlaytestManifestSchema,
  PlaytestRunConfigSchema,
  PlaytestTurnRecordSchema,
  type PlaytestCallRecord,
  type PlaytestDomainRepairCause,
} from "../tools/playtest/harness/contracts.js";
import { PlaytestCostManager } from "../tools/playtest/harness/cost.js";
import { appendPlaytestJsonLine, readPlaytestJsonLines } from "../tools/playtest/harness/files.js";
import {
  CAMPAIGN_AUTOPLAY_PACKAGE,
  TUNING_PACKAGE,
} from "../tools/playtest/harness/packages.js";
import {
  collectPlaytestReport,
  comparePlaytestRuns,
  rankDomainRepairCauses,
  renderPlaytestReport,
  ruleShareOfTurns,
  scorePlaytestAcceptance,
} from "../tools/playtest/harness/report.js";
import { readDiagnosticBundle } from "../tools/playtest/harness/replay.js";
import { PlaytestProviderScheduler } from "../tools/playtest/harness/scheduler.js";
import { PlaytestTelemetryProvider } from "../tools/playtest/harness/telemetry.js";

const AnswerSchema = z.object({ answer: z.string() }).strict();

function executionProfile(): FrozenModelExecutionProfile {
  const draft = DEFAULT_MODEL_EXECUTION_PROFILE_DRAFTS.find(
    (candidate) => candidate.key.provider === "openai" && candidate.key.model === "gpt-5.6-terra",
  );
  if (!draft) throw new Error("Missing OpenAI execution profile fixture");
  return freezeModelExecutionProfile({
    ...draft,
    calibratedAt: "2026-07-19T12:00:00.000Z",
    evidenceRef: "playtests/calibration-observability/attempts.jsonl",
  });
}

function attemptMetadata(
  profile: FrozenModelExecutionProfile,
  overrides: Partial<ProviderAttemptMetadata> = {},
): ProviderAttemptMetadata {
  return {
    provider: profile.key.provider,
    model: profile.key.model,
    route: profile.key.route,
    generationPhase: "decision",
    attemptKind: "initial",
    profileFingerprint: profile.fingerprint,
    structuredMode: "exact_schema",
    schemaProjection: profile.structuredOutput.projection,
    outputTokenField: profile.outputTokenField,
    outputTokenBudget: 4_321,
    timeoutMs: 8_765,
    retryBackoffMs: 37,
    finishReason: "stop",
    truncated: false,
    ...overrides,
  };
}

class SuccessfulProvider implements LlmProvider {
  readonly id = "openai";
  readonly model = "gpt-5.6-terra";

  constructor(private readonly profile: FrozenModelExecutionProfile) {}

  async generateStructured<T>(request: StructuredRequest<T>): Promise<StructuredResult<T>> {
    return {
      data: request.schema.parse({ answer: "recorded" }),
      provider: this.id,
      model: this.model,
      usage: {
        inputTokens: 101,
        outputTokens: 202,
        billedCostUsd: 0.012345,
      },
      structuredMode: "exact_schema",
      attemptMetadata: attemptMetadata(this.profile),
    };
  }
}

class FailingProvider implements LlmProvider {
  readonly id = "openai";
  readonly model = "gpt-5.6-terra";

  constructor(
    private readonly profile: FrozenModelExecutionProfile,
    private readonly echoedSecret: string,
  ) {}

  async generateStructured<T>(_request: StructuredRequest<T>): Promise<StructuredResult<T>> {
    const error = new GenerationFailure(
      "malformed_json",
      `malformed judge response near credential ${this.echoedSecret}`,
      true,
    );
    attachStructuredFailure(error, {
      rawText: "not-json",
      parsedResponse: undefined,
      usage: {
        inputTokens: 303,
        outputTokens: 404,
        billedCostUsd: 0.023456,
      },
      structuredMode: "exact_schema",
      attemptMetadata: attemptMetadata(this.profile, {
        generationPhase: "repair",
        attemptKind: "schema_repair",
        retryBackoffMs: 91,
        finishReason: "length",
      }),
    });
    throw error;
  }
}

function request(): StructuredRequest<{ answer: string }> {
  return {
    schemaName: "observability_answer",
    schema: AnswerSchema,
    system: "Return one structured answer.",
    prompt: "Answer the deterministic fixture.",
    maxOutputTokens: 4_000,
    generationPhase: "decision",
    attemptKind: "initial",
  };
}

describe("playtest call observability", () => {
  it("exposes the frozen phase output budget through the telemetry wrapper", () => {
    const profile = executionProfile();
    const provider = new PlaytestTelemetryProvider({
      actor: "candidate",
      lane: "candidate",
      jobId: "job-budget-delegation",
      route: "direct",
      profile,
      base: {
        id: profile.key.provider,
        model: profile.key.model,
        async generateStructured<T>(_request: StructuredRequest<T>): Promise<StructuredResult<T>> {
          throw new Error("not called");
        },
      },
      price: { inputPerMillion: 2.5, outputPerMillion: 15 },
      costManager: new PlaytestCostManager(5),
      scheduler: new PlaytestProviderScheduler(1, { openai: 1 }),
      callsPath: "/tmp/unused-playtest-budget-delegation.jsonl",
      diagnosticsDir: "/tmp/unused-playtest-budget-delegation-diagnostics",
    });

    expect(provider.effectiveOutputTokenBudget({ generationPhase: "decision" })).toBe(
      profile.outputBudgets.decision,
    );
    expect(
      provider.effectiveOutputTokenBudget({
        generationPhase: "decision",
        outputTokenCeiling: 321,
      }),
    ).toBe(321);
  });

  it("refuses a paid call when its calibrated timeout cannot fit the remaining active duration", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "llm-dungeon-telemetry-deadline-"));
    const profile = executionProfile();
    let calls = 0;
    const cost = new PlaytestCostManager(5);
    const provider = new PlaytestTelemetryProvider({
      actor: "candidate",
      lane: "candidate",
      jobId: "job-deadline",
      route: "direct",
      profile,
      base: {
        id: profile.key.provider,
        model: profile.key.model,
        async generateStructured<T>(_request: StructuredRequest<T>): Promise<StructuredResult<T>> {
          calls += 1;
          throw new Error("should not be called");
        },
      },
      price: { inputPerMillion: 2.5, outputPerMillion: 15 },
      costManager: cost,
      scheduler: new PlaytestProviderScheduler(1, { openai: 1 }),
      callsPath: path.join(root, "calls", "candidate.jsonl"),
      diagnosticsDir: path.join(root, "diagnostics"),
      deadlineAt: Date.now() + 1_000,
    });

    await expect(provider.generateStructured(request())).rejects.toThrow("duration limit");
    expect(calls).toBe(0);
    expect(cost.spentUsd).toBe(0);
    expect(await readPlaytestJsonLines(path.join(root, "calls", "candidate.jsonl"))).toEqual([]);
  });

  it("records candidate cost, token, timing, and frozen-profile fields in its own lane", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "llm-dungeon-telemetry-success-"));
    const profile = executionProfile();
    const records: PlaytestCallRecord[] = [];
    const costManager = new PlaytestCostManager(5);
    const provider = new PlaytestTelemetryProvider({
      actor: "candidate",
      lane: "candidate",
      jobId: "job-observability",
      route: "direct",
      profile,
      base: new SuccessfulProvider(profile),
      price: { inputPerMillion: 2.5, outputPerMillion: 15 },
      costManager,
      scheduler: new PlaytestProviderScheduler(1, { openai: 1 }),
      callsPath: path.join(root, "calls", "candidate.jsonl"),
      diagnosticsDir: path.join(root, "diagnostics"),
      onRecord: (record) => {
        records.push(record);
      },
    });

    await expect(provider.generateStructured(request())).resolves.toMatchObject({
      data: { answer: "recorded" },
    });

    const persisted = PlaytestCallRecordSchema.array().parse(
      await readPlaytestJsonLines(path.join(root, "calls", "candidate.jsonl")),
    );
    expect(persisted).toHaveLength(1);
    expect(persisted[0]).toMatchObject({
      actor: "candidate",
      phase: "decision",
      provider: "openai",
      model: "gpt-5.6-terra",
      route: "direct",
      executionProfileFingerprint: profile.fingerprint,
      retryBackoffMs: 37,
      structuredMode: "exact_schema",
      schemaProjection: "openai_strict_v1",
      outputTokenField: "max_completion_tokens",
      outputTokenBudget: 4_321,
      timeoutMs: 8_765,
      finishReason: "stop",
      truncated: false,
      success: true,
      estimatedCostUsd: 0.012345,
      inputTokens: 101,
      outputTokens: 202,
    });
    expect(persisted[0]!.queueWaitMs).toBeGreaterThanOrEqual(0);
    expect(persisted[0]!.providerDurationMs).toBeGreaterThanOrEqual(0);
    expect(persisted[0]!.promptHash).toMatch(/^[a-f0-9]{64}$/);
    expect(persisted[0]!.systemHash).toMatch(/^[a-f0-9]{64}$/);
    expect(persisted[0]!.schemaHash).toMatch(/^[a-f0-9]{64}$/);
    expect(records).toEqual(persisted);
    expect(costManager.spentUsd).toBe(0.012345);
  });

  it("records content repair independently from schema and transient repair", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "llm-dungeon-telemetry-content-repair-"));
    const profile = executionProfile();
    const callsPath = path.join(root, "calls", "candidate.jsonl");
    const provider = new PlaytestTelemetryProvider({
      actor: "candidate",
      lane: "candidate",
      jobId: "job-content-repair",
      route: "direct",
      profile,
      base: new SuccessfulProvider(profile),
      price: { inputPerMillion: 2.5, outputPerMillion: 15 },
      costManager: new PlaytestCostManager(5),
      scheduler: new PlaytestProviderScheduler(1, { openai: 1 }),
      callsPath,
      diagnosticsDir: path.join(root, "diagnostics"),
    });

    await provider.generateStructured({
      ...request(),
      schemaName: "content_repair_observability_answer",
      attemptKind: "content_repair",
    });

    const calls = PlaytestCallRecordSchema.array().parse(await readPlaytestJsonLines(callsPath));
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      schemaName: "content_repair_observability_answer",
      repairKind: "content",
      success: true,
    });
  });

  it("records a bounded local cause and prior call for a successful domain repair", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "llm-dungeon-telemetry-domain-repair-"));
    const profile = executionProfile();
    const campaignSecret = "thread:hidden-campaign-revelation";
    const freeformCampaignSecret = "the quiet violet password";
    const credential = "fixture-domain-repair-secret";
    const provider = new PlaytestTelemetryProvider({
      actor: "candidate",
      lane: "candidate",
      jobId: "job-domain-repair",
      route: "direct",
      profile,
      base: new SuccessfulProvider(profile),
      price: { inputPerMillion: 2.5, outputPerMillion: 15 },
      costManager: new PlaytestCostManager(5),
      scheduler: new PlaytestProviderScheduler(1, { openai: 1 }),
      callsPath: path.join(root, "calls", "candidate.jsonl"),
      diagnosticsDir: path.join(root, "diagnostics"),
      secrets: [credential],
    });

    await provider.generateStructured(request());
    await provider.generateStructured({
      ...request(),
      schemaName: "domain_repair_observability_answer",
      generationPhase: "repair",
      repairOfPhase: "decision",
      attemptKind: "domain_repair",
      // The real path carries declared rule codes, so redaction never depends
      // on pattern-matching a message that embeds campaign text.
      domainRepairCause: createDomainRepairCause(
        new DomainValidationError(
          `Unknown thread reference ${campaignSecret} near ${credential}\nplayer:hero does not have condition ${freeformCampaignSecret}`,
          {
            violations: [
              {
                code: "unknown_thread_reference",
                message: `Unknown thread reference ${campaignSecret}`,
              },
              {
                code: "durable_text_limit",
                message: `Fact on player:hero mentions ${freeformCampaignSecret}`,
              },
            ],
          },
        ),
        {
          logicalOperationId: "11111111-1111-4111-8111-111111111111",
          validationStage: "turn_commit",
        },
      ),
    });

    const callsPath = path.join(root, "calls", "candidate.jsonl");
    const callsText = await readFile(callsPath, "utf8");
    expect(callsText).not.toContain(campaignSecret);
    expect(callsText).not.toContain(freeformCampaignSecret);
    expect(callsText).not.toContain(credential);
    const calls = PlaytestCallRecordSchema.array().parse(await readPlaytestJsonLines(callsPath));
    expect(calls[1]).toMatchObject({
      id: "job-domain-repair-candidate-00002",
      phase: "repair",
      repairKind: "domain",
      success: true,
      domainRepairCause: {
        logicalOperationId: "11111111-1111-4111-8111-111111111111",
        priorCallId: "job-domain-repair-candidate-00001",
        sourcePhase: "decision",
        validationStage: "turn_commit",
        errorName: "Error",
        errorMessage:
          "Transaction validation failed:\n- [unknown_thread_reference] An effect referenced a thread that does not exist\n- [durable_text_limit] A generated durable record exceeded its new-write character limit",
      },
    });
    expect(calls[1]?.domainRepairCause?.errorFingerprint).toMatch(/^[a-f0-9]{64}$/u);
    // The same rules with different campaign text must group identically.
    const sameRulesWithDifferentSecrets = createDomainRepairCause(
      new DomainValidationError("a different rendering entirely", {
        violations: [
          { code: "unknown_thread_reference", message: "Unknown thread reference thread:other" },
          { code: "durable_text_limit", message: "Fact on npc:other mentions another tiny secret" },
        ],
      }),
      {
        logicalOperationId: "11111111-1111-4111-8111-111111111111",
        validationStage: "turn_commit",
      },
    );
    expect(calls[1]?.domainRepairCause?.errorFingerprint).toBe(
      sameRulesWithDifferentSecrets.errorFingerprint,
    );

    const diagnosticPath = path.join(
      root,
      "diagnostics",
      "job-domain-repair-candidate-00002-domain-repair.json",
    );
    const diagnosticText = await readFile(diagnosticPath, "utf8");
    expect(diagnosticText).not.toContain(campaignSecret);
    expect(diagnosticText).not.toContain(freeformCampaignSecret);
    expect(diagnosticText).not.toContain(credential);
    const diagnostic = PlaytestDomainRepairDiagnosticSchema.parse(JSON.parse(diagnosticText));
    expect(diagnostic).toMatchObject({
      kind: "domain_repair",
      callId: "job-domain-repair-candidate-00002",
      schemaName: "domain_repair_observability_answer",
      cause: calls[1]!.domainRepairCause,
    });
    expect(Object.keys(diagnostic).sort()).toEqual(
      [
        "actor",
        "callId",
        "cause",
        "createdAt",
        "executionProfileFingerprint",
        "jobId",
        "kind",
        "model",
        "provider",
        "route",
        "schemaName",
        "schemaVersion",
      ].sort(),
    );
  });

  it("attributes a failed judge call outside candidate evidence and writes a redacted replay bundle", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "llm-dungeon-telemetry-failure-"));
    const profile = executionProfile();
    const secret = "fixture-secret-key";
    const provider = new PlaytestTelemetryProvider({
      actor: "judge",
      lane: "judge",
      jobId: "job-observability",
      route: "direct",
      profile,
      phase: "final_judge",
      base: new FailingProvider(profile, secret),
      price: { inputPerMillion: 2.5, outputPerMillion: 15 },
      costManager: new PlaytestCostManager(5),
      scheduler: new PlaytestProviderScheduler(1, { openai: 1 }),
      callsPath: path.join(root, "calls", "judge.jsonl"),
      diagnosticsDir: path.join(root, "diagnostics"),
      secrets: [secret],
    });
    provider.setPreCallStateSnapshot(`authoritative state containing ${secret}`);

    await expect(
      provider.generateStructured({
        ...request(),
        system: `Judge without exposing ${secret}.`,
      }),
    ).rejects.toThrow("malformed judge response");

    const callsPath = path.join(root, "calls", "judge.jsonl");
    const callsText = await readFile(callsPath, "utf8");
    expect(callsText).not.toContain(secret);
    const calls = PlaytestCallRecordSchema.array().parse(await readPlaytestJsonLines(callsPath));
    expect(calls).toMatchObject([
      {
        id: "job-observability-judge-00001",
        actor: "judge",
        phase: "final_judge",
        success: false,
        failureKind: "malformed_json",
        failureOwner: "judge",
        estimatedCostUsd: 0.023456,
        inputTokens: 303,
        outputTokens: 404,
        retryBackoffMs: 91,
        finishReason: "length",
        error: "malformed judge response near credential [redacted]",
      },
    ]);

    const diagnosticPath = path.join(root, "diagnostics", "job-observability-judge-00001.json");
    const diagnosticText = await readFile(diagnosticPath, "utf8");
    expect(diagnosticText).not.toContain(secret);
    const diagnostic = await readDiagnosticBundle(diagnosticPath);
    expect(diagnostic).toMatchObject({
      expectedPhase: "decision",
      provider: "openai",
      model: "gpt-5.6-terra",
      route: "direct",
      preCallStateSnapshot: "authoritative state containing [redacted]",
      failure: {
        attribution: {
          owner: "judge",
          lane: "judge",
          candidateStatusImpact: "excluded",
        },
        kind: "malformed_json",
      },
    });
  });
});

function callRecord(input: {
  id: string;
  actor: "candidate" | "player_driver" | "judge" | "artifact";
  success: boolean;
  failureOwner?: "player_driver" | "judge";
  cost: number;
  inputTokens: number;
  outputTokens: number;
  costWaitMs?: number;
  queueWaitMs: number;
  providerDurationMs: number;
  retryBackoffMs: number;
  costBasis?: "reported_usage" | "reserved_estimate";
  repairKind?: "schema" | "content" | "transient" | "domain";
  domainRepairCause?: PlaytestDomainRepairCause;
}): PlaytestCallRecord {
  return PlaytestCallRecordSchema.parse({
    id: input.id,
    timestamp: "2026-07-19T12:00:00.000Z",
    jobId: "job-001",
    actor: input.actor,
    phase:
      input.actor === "candidate"
        ? "decision"
        : input.actor === "player_driver"
          ? "player_action"
          : input.actor === "judge"
            ? "final_judge"
            : "completed_story",
    sequence: 1,
    schemaName: `${input.actor}_schema`,
    provider: "openai",
    model: "gpt-5.6-terra",
    route: "direct",
    executionProfileFingerprint: "profile-fingerprint",
    costWaitMs: input.costWaitMs ?? 0,
    queueWaitMs: input.queueWaitMs,
    providerDurationMs: input.providerDurationMs,
    retryBackoffMs: input.retryBackoffMs,
    promptHash: "prompt-hash",
    systemHash: "system-hash",
    schemaHash: "schema-hash",
    success: input.success,
    estimatedCostUsd: input.cost,
    costBasis: input.costBasis ?? "reported_usage",
    inputTokens: input.inputTokens,
    outputTokens: input.outputTokens,
    ...(input.repairKind ? { repairKind: input.repairKind } : {}),
    ...(input.domainRepairCause ? { domainRepairCause: input.domainRepairCause } : {}),
    ...(input.failureOwner
      ? {
          failureKind: "malformed_json",
          failureOwner: input.failureOwner,
          failureFingerprint: "f".repeat(64),
          error: `${input.actor} fixture failure`,
        }
      : {}),
  });
}

describe("playtest reporting", () => {
  it("reports candidate, player-driver, judge, and artifact costs separately", async () => {
    const runDir = await mkdtemp(path.join(tmpdir(), "llm-dungeon-report-"));
    const jobDir = path.join(runDir, "jobs", "job-001");
    await mkdir(jobDir, { recursive: true });
    const candidate = {
      config: {
        provider: "openai" as const,
        model: "gpt-5.6-terra",
        temperature: 0.8,
        maxOutputTokens: 4_000,
      },
      route: "direct",
      executionProfileFingerprint: "profile-fingerprint",
    };
    const config = PlaytestRunConfigSchema.parse({
      package: { id: TUNING_PACKAGE.id, version: TUNING_PACKAGE.version },
      candidates: [candidate],
      languages: ["en"],
      turns: 50,
      repetitions: 1,
      globalWorkerLimit: 1,
      latencyMode: "canonical",
      providerConcurrency: { openai: 1 },
      maxCostUsd: 5,
      judge: {
        policy: "final",
        rubricVersion: 1,
        target: candidate,
      },
    });
    const manifest = PlaytestManifestSchema.parse({
      schemaVersion: 2,
      kind: "playtest",
      engineVersion: 1,
      runId: "observability-report",
      startedAt: "2026-07-19T12:00:00.000Z",
      updatedAt: "2026-07-19T12:01:00.000Z",
      completedAt: "2026-07-19T12:01:00.000Z",
      status: "completed",
      codeVersion: { commit: null, dirty: null, sourceHash: "source-hash" },
      config,
      packageSnapshot: TUNING_PACKAGE,
      packageHash: "package-hash",
      totalEstimatedCostUsd: 1.625,
      jobs: [
        {
          id: "job-001",
          package: config.package,
          candidate,
          language: "en",
          repetition: 1,
          latencyMode: "canonical",
          status: "completed",
          completedTurns: 1,
          judge: config.judge,
          technicalStatus: "clean",
          qualityStatus: "unrated",
          stopReason: "turn_limit",
          completedStory: { status: "completed", attempts: 1 },
        },
      ],
    });
    await writeFile(path.join(runDir, "manifest.json"), `${JSON.stringify(manifest)}\n`, "utf8");

    await appendPlaytestJsonLine(
      path.join(jobDir, "calls", "candidate.jsonl"),
      callRecord({
        id: "candidate-1",
        actor: "candidate",
        success: true,
        cost: 0.125,
        inputTokens: 10,
        outputTokens: 20,
        costWaitMs: 2,
        queueWaitMs: 5,
        providerDurationMs: 100,
        retryBackoffMs: 7,
        repairKind: "domain",
        domainRepairCause: {
          logicalOperationId: "11111111-1111-4111-8111-111111111111",
          priorCallId: "candidate-original",
          sourcePhase: "decision",
          validationStage: "turn_commit",
          errorName: "TransactionValidationError",
          errorMessage: "Unknown item reference [redacted]",
          errorFingerprint: "d".repeat(64),
        },
      }),
    );
    await appendPlaytestJsonLine(
      path.join(jobDir, "calls", "player-driver.jsonl"),
      callRecord({
        id: "player-1",
        actor: "player_driver",
        success: false,
        failureOwner: "player_driver",
        cost: 0.5,
        inputTokens: 30,
        outputTokens: 40,
        costWaitMs: 50,
        queueWaitMs: 500,
        providerDurationMs: 900,
        retryBackoffMs: 1_000,
        costBasis: "reserved_estimate",
        repairKind: "transient",
      }),
    );
    await appendPlaytestJsonLine(
      path.join(jobDir, "calls", "judge.jsonl"),
      callRecord({
        id: "judge-1",
        actor: "judge",
        success: false,
        failureOwner: "judge",
        cost: 0.75,
        inputTokens: 50,
        outputTokens: 60,
        costWaitMs: 70,
        queueWaitMs: 700,
        providerDurationMs: 1_900,
        retryBackoffMs: 2_000,
        repairKind: "content",
      }),
    );
    await appendPlaytestJsonLine(
      path.join(jobDir, "calls", "artifact.jsonl"),
      callRecord({
        id: "artifact-1",
        actor: "artifact",
        success: true,
        cost: 0.25,
        inputTokens: 70,
        outputTokens: 80,
        queueWaitMs: 9,
        providerDurationMs: 400,
        retryBackoffMs: 0,
      }),
    );
    await appendPlaytestJsonLine(
      path.join(jobDir, "turns.jsonl"),
      PlaytestTurnRecordSchema.parse({
        turn: 1,
        action: "Inspect the fixture.",
        narration: "The fixture remains stable.",
        summary: "The fixture was inspected.",
        playerVisibleDurationMs: 321,
        driver: "scripted",
        expectedCheckPolicy: "forbidden",
        assignedNaturalRoll: 42,
        operations: [],
        status: "completed",
        invariantStatus: "passed",
      }),
    );
    await writeFile(
      path.join(jobDir, "technical.json"),
      `${JSON.stringify(
        CandidateTechnicalSnapshotSchema.parse({
          status: "unstable",
          evidenceComplete: true,
          turnsRequired: 1,
          turnsCompleted: 1,
          candidateCalls: 1,
          candidateOwnedFailures: 0,
          candidateOwnedFailedTurns: 0,
          externalFailedTurns: 0,
          schemaRepairs: 0,
          transientRetries: 0,
          domainRepairs: 0,
          invariantFailures: 0,
          deterministicCoveragePassed: false,
          excludedFailureCounts: { player_driver: 1, judge: 1 },
          reasons: ["coverage fixture failed"],
        }),
      )}\n`,
      "utf8",
    );
    await writeFile(
      path.join(jobDir, "coverage.json"),
      `${JSON.stringify({
        deterministicPassed: false,
        passed: 1,
        failed: 1,
        requiresJudge: 1,
        entries: [
          {
            requirementId: "passed-fixture",
            mode: "deterministic",
            status: "passed",
            evidence: "present",
          },
          {
            requirementId: "failed-fixture",
            mode: "deterministic",
            status: "failed",
            evidence: "missing",
          },
          {
            requirementId: "judge-fixture",
            mode: "judge",
            status: "requires_judge",
            evidence: "judge only",
          },
        ],
      })}\n`,
      "utf8",
    );

    const report = await collectPlaytestReport(runDir);
    expect(report.jobs).toHaveLength(1);
    expect(report.jobs[0]).toMatchObject({
      candidateLabel: "openai/gpt-5.6-terra via direct",
      technicalStatus: "unstable",
      turnsRequested: 50,
      turnsRequired: 1,
      turnsCompleted: 1,
      checks: 0,
      checkRate: 0,
      invariantFailures: 0,
      deterministicCoveragePassed: false,
      coveragePassed: 1,
      coverageFailed: 1,
      coverageRequiresJudge: 1,
      failedCoverageRequirementIds: ["failed-fixture"],
      playerVisibleAverageMs: 321,
      candidate: {
        calls: 1,
        failures: 0,
        costUsd: 0.125,
        failedCallCostUsd: 0,
        inputTokens: 10,
        outputTokens: 20,
        averageCostWaitMs: 2,
        averageQueueWaitMs: 5,
        averageProviderDurationMs: 100,
        retryBackoffMs: 7,
        repairs: { schema: 0, content: 0, transient: 0, domain: 1 },
        domainRepairsWithoutCause: 0,
        domainRepairCauses: [
          {
            callId: "candidate-1",
            cause: {
              priorCallId: "candidate-original",
              errorMessage: "Unknown item reference [redacted]",
            },
          },
        ],
      },
      playerDriver: {
        calls: 1,
        failures: 1,
        costUsd: 0.5,
        failedCallCostUsd: 0.5,
        failureOwners: { player_driver: 1 },
        repairs: { schema: 0, content: 0, transient: 1, domain: 0 },
        costBasisCounts: { reportedUsage: 0, reservedEstimate: 1 },
        averageCostWaitMs: 50,
        averageProviderDurationMs: 900,
      },
      judge: {
        calls: 1,
        failures: 1,
        costUsd: 0.75,
        failedCallCostUsd: 0.75,
        failureOwners: { judge: 1 },
        repairs: { schema: 0, content: 1, transient: 0, domain: 0 },
        averageCostWaitMs: 70,
        averageProviderDurationMs: 1_900,
      },
      completedStory: { status: "completed", attempts: 1 },
      artifact: {
        calls: 1,
        failures: 0,
        costUsd: 0.25,
        inputTokens: 70,
        outputTokens: 80,
        averageQueueWaitMs: 9,
        averageProviderDurationMs: 400,
      },
    });
    expect(report.jobs[0]!.candidate.costUsd).not.toBe(1.375);

    const markdown = renderPlaytestReport(report);
    expect(markdown).toContain(
      "Judge and player-driver behavior is excluded from candidate technical status.",
    );
    expect(markdown).toContain("openai/gpt-5.6-terra via direct");
    expect(markdown).toContain("Turns: 1/50 requested; technical requirement: 1");
    expect(markdown).not.toContain("Turns: 1/1;");
    expect(markdown).toContain("Candidate: 1 calls, 0 failures, $0.125000");
    expect(markdown).toContain("Player driver: 1 calls, 1 failures, $0.500000");
    expect(markdown).toContain("Independent judge: 1 calls, 1 failures, $0.750000");
    expect(markdown).toContain("Completed-story artifact: **completed**");
    expect(markdown).toContain("Post-completion artifact: 1 calls, 0 failures, $0.250000");
    expect(markdown).toContain("Failed coverage requirements: failed-fixture");
    expect(markdown).toContain("Player driver failure owners: player_driver=1");
    expect(markdown).toContain(
      "Independent judge repairs: schema=0, content=1, transient=0, domain=0",
    );
    expect(markdown).toContain(
      "Candidate domain-repair causes: candidate-1 after candidate-original",
    );
    expect(markdown).toContain("TransactionValidationError: Unknown item reference [redacted]");
    expect(markdown).toContain(`${"f".repeat(64)} (1)`);

    // Per-call listings show that recovery happened; the ranking shows which
    // rule keeps forcing it, which is what makes repairs a fixable worklist.
    expect(markdown).toContain("## Domain-repair causes (ranked)");
    expect(markdown).toContain("| Rule | Turns | Share of");
    expect(markdown).toContain("| `Unknown item reference [redacted]` |");
  });

  it("ranks a batched domain-repair cause by every rule it violated", () => {
    const ranked = rankDomainRepairCauses([
      {
        jobId: "job-1",
        candidate: {
          domainRepairCauses: [
            {
              callId: "call-1",
              cause: {
                sourcePhase: "decision",
                logicalOperationId: "operation-1",
                errorMessage:
                  "Transaction validation failed:\n- [unknown_reference] Unknown entity reference [redacted]\n- [durable_text_limit] Generated durable record exceeds the 800-character durable-state limit",
              },
            },
            {
              callId: "call-2",
              cause: {
                sourcePhase: "decision",
                logicalOperationId: "operation-2",
                errorMessage: "Transaction validation failed:\n- [unknown_reference] x",
              },
            },
          ],
        },
        playerDriver: { domainRepairCauses: [] },
        judge: { domainRepairCauses: [] },
        artifact: { domainRepairCauses: [] },
      },
    ] as unknown as Parameters<typeof rankDomainRepairCauses>[0]);

    expect(ranked.map((entry) => [entry.key, entry.count])).toEqual([
      ["unknown_reference", 2],
      ["durable_text_limit", 1],
    ]);
  });

  it("counts one turn per rule however many calls its retries spent", () => {
    const cause = (
      logicalOperationId: string,
      sourcePhase: "setup" | "decision" | "locked_resolution",
      code: string,
    ) => ({
      callId: `call-${logicalOperationId}-${sourcePhase}`,
      cause: {
        sourcePhase,
        logicalOperationId,
        errorMessage: `[${code}] redacted`,
      },
    });
    const [ranked] = rankDomainRepairCauses([
      {
        jobId: "job-1",
        candidate: {
          // One checked turn: adjudication and locked resolution are two calls
          // that share the turn's durable pending operation ID.
          domainRepairCauses: [
            cause("operation-1", "decision", "scene_state_required"),
            cause("operation-1", "locked_resolution", "scene_state_required"),
            cause("operation-2", "decision", "scene_state_required"),
          ],
        },
        playerDriver: { domainRepairCauses: [] },
        judge: { domainRepairCauses: [] },
        artifact: { domainRepairCauses: [] },
      },
    ] as unknown as Parameters<typeof rankDomainRepairCauses>[0]);

    expect(ranked).toMatchObject({ key: "scene_state_required", count: 3, turns: 2 });
    expect(ruleShareOfTurns(ranked!, 10)).toBeCloseTo(0.2);
  });

  it("keeps a setup repair out of the per-turn share", () => {
    const [ranked] = rankDomainRepairCauses([
      {
        jobId: "job-1",
        candidate: {
          domainRepairCauses: [
            {
              callId: "call-1",
              cause: {
                sourcePhase: "setup",
                logicalOperationId: "operation-setup",
                errorMessage: "[setup_thread_unknown_entity] redacted",
              },
            },
          ],
        },
        playerDriver: { domainRepairCauses: [] },
        judge: { domainRepairCauses: [] },
        artifact: { domainRepairCauses: [] },
      },
    ] as unknown as Parameters<typeof rankDomainRepairCauses>[0]);

    // Setup runs once per run, so folding it into a per-turn share would make a
    // single setup rejection look like a rule firing on a fifteenth of the run.
    expect(ranked).toMatchObject({ count: 1, turns: 0, setupRepairs: 1 });
    expect(ruleShareOfTurns(ranked!, 15)).toBe(0);
  });

  it("fails acceptance on a rule that fires on a fifth of the turns and passes it on noise", () => {
    const job = (turns: number, ruleTurns: number) =>
      ({
        jobId: "job-1",
        turnsRequested: turns,
        turnsCompleted: turns,
        stopReason: "turn_limit",
        checkRate: 0,
        invariantFailures: 0,
        threadAudit: { unchanged: 0, progressed: 0, closed: 0, omitted: 0, invented: 0 },
        candidate: {
          repairs: { schema: 0, content: 0, transient: 0, domain: ruleTurns },
          domainRepairCauses: Array.from({ length: ruleTurns }, (_unused, index) => ({
            callId: `call-${index}`,
            cause: {
              sourcePhase: "decision",
              logicalOperationId: `operation-${index}`,
              errorMessage: "[thread_successor_required] redacted",
            },
          })),
        },
        playerDriver: { domainRepairCauses: [] },
        judge: { domainRepairCauses: [] },
        artifact: { domainRepairCauses: [] },
      }) as unknown as Parameters<typeof scorePlaytestAcceptance>[0][number];

    const spiral = scorePlaytestAcceptance([job(40, 8)]);
    expect(spiral.accepted).toBe(false);
    expect(spiral.criteria).toContainEqual(
      expect.objectContaining({
        id: "top_rule_share",
        observed: "20.0% (`thread_successor_required`)",
        verdict: "fail",
      }),
    );

    // The same rule firing once in forty turns is the recovery path working.
    const noise = scorePlaytestAcceptance([job(40, 1)]);
    expect(noise.accepted).toBe(true);
    expect(noise.criteria).toContainEqual(
      expect.objectContaining({ id: "top_rule_share", verdict: "pass" }),
    );
  });

  it("shows the yield a run bought, not only what it cost", () => {
    // Every hard criterion improves when the model emits fewer operations, so
    // a quieter run reads as a better one unless something watches the yield.
    // These two score identically on repairs and differ only in what they
    // actually recorded.
    const job = (operationCounts: Record<string, number>, domain: number) =>
      ({
        jobId: "job-1",
        turnsRequested: 40,
        turnsCompleted: 40,
        turnsSkipped: 0,
        stopReason: "turn_limit",
        checkRate: 0.1,
        invariantFailures: 0,
        threadAudit: { unchanged: 4, progressed: 5, closed: 1, omitted: 0, invented: 0 },
        operationCounts,
        candidate: {
          repairs: { schema: 0, content: 0, transient: 0, domain },
          domainRepairCauses: [],
        },
        playerDriver: { domainRepairCauses: [] },
        judge: { domainRepairCauses: [] },
        artifact: { domainRepairCauses: [] },
      }) as unknown as Parameters<typeof scorePlaytestAcceptance>[0][number];

    const rich = scorePlaytestAcceptance([
      job({ advance_time: 40, add_fact: 35, set_entity_state: 34, update_thread: 32 }, 1),
    ]);
    const hollow = scorePlaytestAcceptance([job({ advance_time: 40, add_fact: 2 }, 1)]);

    // Both are accepted: yield is reported, never a gate. The point is that
    // the difference is now visible at all.
    expect(rich.accepted).toBe(true);
    expect(hollow.accepted).toBe(true);
    expect(rich.criteria).toContainEqual(
      expect.objectContaining({
        id: "durable_operations_per_turn",
        observed: expect.stringContaining("3.52 (141 operations / 40 turns)"),
      }),
    );
    expect(hollow.criteria).toContainEqual(
      expect.objectContaining({
        id: "durable_operations_per_turn",
        observed: expect.stringContaining("1.05 (42 operations / 40 turns)"),
      }),
    );
    // And the kind breakdown names what stopped being written.
    expect(
      rich.criteria.find((c) => c.id === "durable_operations_per_turn")?.observed,
    ).toContain("set_entity_state=34");
    expect(
      hollow.criteria.find((c) => c.id === "durable_operations_per_turn")?.observed,
    ).not.toContain("set_entity_state");
  });

  it("scores a repaired run as acceptable and an aborted run as not", () => {
    const base = {
      jobId: "job-1",
      turnsRequested: 40,
      turnsCompleted: 40,
      checkRate: 0.1,
      invariantFailures: 0,
      threadAudit: { unchanged: 4, progressed: 5, closed: 1, omitted: 0, invented: 0 },
      candidate: {
        repairs: { schema: 0, content: 0, transient: 0, domain: 2 },
        domainRepairCauses: [],
      },
      playerDriver: { domainRepairCauses: [] },
      judge: { domainRepairCauses: [] },
      artifact: { domainRepairCauses: [] },
    };
    const repaired = scorePlaytestAcceptance([
      { ...base, stopReason: "turn_limit" },
    ] as unknown as Parameters<typeof scorePlaytestAcceptance>[0]);
    expect(repaired.accepted).toBe(true);
    expect(repaired.criteria).toContainEqual(
      expect.objectContaining({
        id: "thread_closures_per_100_turns",
        observed: "2.5 (1 closed / 40 turns)",
      }),
    );

    // A valid in-fiction death completes its fixture; only a technical abort fails.
    const died = scorePlaytestAcceptance([
      { ...base, stopReason: "legitimate_terminal" },
    ] as unknown as Parameters<typeof scorePlaytestAcceptance>[0]);
    expect(died.accepted).toBe(true);

    const aborted = scorePlaytestAcceptance([
      { ...base, turnsCompleted: 13, stopReason: "error" },
    ] as unknown as Parameters<typeof scorePlaytestAcceptance>[0]);
    expect(aborted.accepted).toBe(false);
    expect(aborted.criteria).toContainEqual(
      expect.objectContaining({ id: "run_completion", verdict: "fail" }),
    );
  });

  it("compares aligned jobs only when persisted experiment controls match", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "llm-dungeon-report-compare-"));
    const judge = {
      config: {
        provider: "openai" as const,
        model: "judge-model",
        temperature: 0.8,
        maxOutputTokens: 4_000,
      },
      route: "direct",
      executionProfileFingerprint: "judge-profile",
    };
    const writeRun = async (
      runId: string,
      candidateModel: string,
      overrides: { seed?: string; packageHash?: string } = {},
    ): Promise<string> => {
      const runDir = path.join(root, runId);
      const candidate = {
        config: {
          provider: "openai" as const,
          model: candidateModel,
          temperature: 0.8,
          maxOutputTokens: 4_000,
        },
        route: "direct",
        executionProfileFingerprint: `${candidateModel}-profile`,
      };
      const config = PlaytestRunConfigSchema.parse({
        package: { id: TUNING_PACKAGE.id, version: TUNING_PACKAGE.version },
        candidates: [candidate],
        languages: ["en"],
        seed: overrides.seed ?? "fixed-seed",
        tuningVariable: "model: candidate model",
        repetitions: 1,
        globalWorkerLimit: 1,
        latencyMode: "canonical",
        providerConcurrency: { openai: 1 },
        maxCostUsd: 5,
        judge: { policy: "final", rubricVersion: 1, target: judge },
      });
      const manifest = PlaytestManifestSchema.parse({
        schemaVersion: 2,
        kind: "playtest",
        engineVersion: 1,
        runId,
        startedAt: "2026-07-19T12:00:00.000Z",
        updatedAt: "2026-07-19T12:01:00.000Z",
        completedAt: "2026-07-19T12:01:00.000Z",
        status: "completed",
        codeVersion: { commit: null, dirty: null, sourceHash: "controlled-source" },
        config,
        packageSnapshot: TUNING_PACKAGE,
        packageHash: overrides.packageHash ?? "same-package-hash",
        totalEstimatedCostUsd: 0,
        jobs: [
          {
            id: `job-${runId}`,
            package: config.package,
            candidate,
            language: "en",
            repetition: 1,
            latencyMode: "canonical",
            status: "completed",
            completedTurns: 0,
            judge: config.judge,
            technicalStatus: "clean",
            qualityStatus: "unrated",
            stopReason: "turn_limit",
          },
        ],
      });
      await mkdir(path.join(runDir, "jobs", `job-${runId}`), { recursive: true });
      await writeFile(path.join(runDir, "manifest.json"), `${JSON.stringify(manifest)}\n`, "utf8");
      return runDir;
    };

    const left = await writeRun("left-run", "candidate-a");
    const right = await writeRun("right-run", "candidate-b");
    const comparison = await comparePlaytestRuns(left, right);
    expect(comparison.markdown).toContain("candidate-a");
    expect(comparison.markdown).toContain("candidate-b");
    expect(comparison.markdown).not.toContain("different source revisions");

    expect(comparison.markdown).toContain("Comparison is **controlled**");

    // A tuning run declares exactly one variable, so a second uncontrolled input
    // invalidates the experiment instead of merely weakening the reading.
    const changedSeed = await writeRun("changed-seed", "candidate-c", { seed: "other-seed" });
    await expect(comparePlaytestRuns(left, changedSeed)).rejects.toThrow(
      "Tuning comparison requires every control except the declared variable to match; seed differ",
    );
    const changedPackage = await writeRun("changed-package", "candidate-c", {
      packageHash: "other-package-hash",
    });
    await expect(comparePlaytestRuns(left, changedPackage)).rejects.toThrow(
      "same package fingerprint",
    );
  });

  it("labels a diagnostic comparison uncontrolled and names the scenario seed", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "llm-dungeon-report-uncontrolled-"));
    const candidate = {
      config: {
        provider: "openai" as const,
        model: "candidate-model",
        temperature: 0.8,
        maxOutputTokens: 4_000,
      },
      route: "direct",
      executionProfileFingerprint: "candidate-profile",
    };
    const writeRun = async (runId: string, scenarioSeed: string): Promise<string> => {
      const runDir = path.join(root, runId);
      const config = PlaytestRunConfigSchema.parse({
        package: { id: CAMPAIGN_AUTOPLAY_PACKAGE.id, version: CAMPAIGN_AUTOPLAY_PACKAGE.version },
        candidates: [candidate],
        languages: ["en"],
        turns: 15,
        scenarioSeed,
        repetitions: 1,
        globalWorkerLimit: 1,
        latencyMode: "canonical",
        providerConcurrency: { openai: 1 },
        maxCostUsd: 5,
        judge: { policy: "none", rubricVersion: 1 },
      });
      const manifest = PlaytestManifestSchema.parse({
        schemaVersion: 2,
        kind: "playtest",
        engineVersion: 1,
        runId,
        startedAt: "2026-07-19T12:00:00.000Z",
        updatedAt: "2026-07-19T12:01:00.000Z",
        completedAt: "2026-07-19T12:01:00.000Z",
        status: "completed",
        codeVersion: { commit: null, dirty: null, sourceHash: `source-${runId}` },
        config,
        packageSnapshot: CAMPAIGN_AUTOPLAY_PACKAGE,
        packageHash: "same-package-hash",
        totalEstimatedCostUsd: 0,
        jobs: [
          {
            id: `job-${runId}`,
            package: config.package,
            candidate,
            language: "en",
            repetition: 1,
            latencyMode: "canonical",
            status: "completed",
            completedTurns: 15,
            judge: config.judge,
            technicalStatus: "clean",
            qualityStatus: "unrated",
            stopReason: "turn_limit",
          },
        ],
      });
      await mkdir(path.join(runDir, "jobs", `job-${runId}`), { recursive: true });
      await writeFile(path.join(runDir, "manifest.json"), `${JSON.stringify(manifest)}\n`, "utf8");
      return runDir;
    };

    // Comparing two scenarios credits or blames the code for the scenario's own
    // difficulty. The tool must say so rather than print an attributable delta.
    const comparison = await comparePlaytestRuns(
      await writeRun("left-run", "dark-sun-sealed-oasis"),
      await writeRun("right-run", "far-meridian-dead-signal"),
    );
    expect(comparison.markdown).toContain("Comparison is **uncontrolled**");
    expect(comparison.markdown).toContain("`scenarioSeed`");
    expect(comparison.markdown).toContain("observations, not attributions");
  });
});
