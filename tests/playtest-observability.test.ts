import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { GenerationFailure } from "../src/llm/failures.js";
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
  PlaytestManifestSchema,
  PlaytestRunConfigSchema,
  PlaytestTurnRecordSchema,
  type PlaytestCallRecord,
} from "../tools/playtest/harness/contracts.js";
import { PlaytestCostManager } from "../tools/playtest/harness/cost.js";
import { appendPlaytestJsonLine, readPlaytestJsonLines } from "../tools/playtest/harness/files.js";
import { TUNING_PACKAGE } from "../tools/playtest/harness/packages.js";
import {
  collectPlaytestReport,
  comparePlaytestRuns,
  renderPlaytestReport,
} from "../tools/playtest/harness/report.js";
import { readDiagnosticBundle } from "../tools/playtest/harness/replay.js";
import { PlaytestProviderScheduler } from "../tools/playtest/harness/scheduler.js";
import { PlaytestTelemetryProvider } from "../tools/playtest/harness/telemetry.js";

const AnswerSchema = z.object({ answer: z.string() }).strict();

function executionProfile(): FrozenModelExecutionProfile {
  const draft = DEFAULT_MODEL_EXECUTION_PROFILE_DRAFTS.find((candidate) =>
    candidate.key.provider === "openai" && candidate.key.model === "gpt-5.6-terra");
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
      onRecord: (record) => { records.push(record); },
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

    await expect(provider.generateStructured({
      ...request(),
      system: `Judge without exposing ${secret}.`,
    })).rejects.toThrow("malformed judge response");

    const callsPath = path.join(root, "calls", "judge.jsonl");
    const callsText = await readFile(callsPath, "utf8");
    expect(callsText).not.toContain(secret);
    const calls = PlaytestCallRecordSchema.array().parse(await readPlaytestJsonLines(callsPath));
    expect(calls).toMatchObject([{
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
    }]);

    const diagnosticPath = path.join(
      root,
      "diagnostics",
      "job-observability-judge-00001.json",
    );
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
  actor: "candidate" | "player_driver" | "judge";
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
  repairKind?: "schema" | "transient" | "domain";
}): PlaytestCallRecord {
  return PlaytestCallRecordSchema.parse({
    id: input.id,
    timestamp: "2026-07-19T12:00:00.000Z",
    jobId: "job-001",
    actor: input.actor,
    phase: input.actor === "candidate"
      ? "decision"
      : input.actor === "player_driver" ? "player_action" : "final_judge",
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
    ...(input.failureOwner ? {
      failureKind: "malformed_json",
      failureOwner: input.failureOwner,
      failureFingerprint: "f".repeat(64),
      error: `${input.actor} fixture failure`,
    } : {}),
  });
}

describe("playtest reporting", () => {
  it("reports candidate, player-driver, and judge costs, failures, and latency separately", async () => {
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
      totalEstimatedCostUsd: 1.375,
      jobs: [{
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
      }],
    });
    await writeFile(path.join(runDir, "manifest.json"), `${JSON.stringify(manifest)}\n`, "utf8");

    await appendPlaytestJsonLine(path.join(jobDir, "calls", "candidate.jsonl"), callRecord({
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
    }));
    await appendPlaytestJsonLine(path.join(jobDir, "calls", "player-driver.jsonl"), callRecord({
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
    }));
    await appendPlaytestJsonLine(path.join(jobDir, "calls", "judge.jsonl"), callRecord({
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
    }));
    await appendPlaytestJsonLine(path.join(jobDir, "turns.jsonl"), PlaytestTurnRecordSchema.parse({
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
    }));
    await writeFile(path.join(jobDir, "technical.json"), `${JSON.stringify(
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
    )}\n`, "utf8");
    await writeFile(path.join(jobDir, "coverage.json"), `${JSON.stringify({
      deterministicPassed: false,
      passed: 1,
      failed: 1,
      requiresJudge: 1,
      entries: [
        { requirementId: "passed-fixture", mode: "deterministic", status: "passed", evidence: "present" },
        { requirementId: "failed-fixture", mode: "deterministic", status: "failed", evidence: "missing" },
        { requirementId: "judge-fixture", mode: "judge", status: "requires_judge", evidence: "judge only" },
      ],
    })}\n`, "utf8");

    const report = await collectPlaytestReport(runDir);
    expect(report.jobs).toHaveLength(1);
    expect(report.jobs[0]).toMatchObject({
      candidateLabel: "openai/gpt-5.6-terra via direct",
      technicalStatus: "unstable",
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
      },
      playerDriver: {
        calls: 1,
        failures: 1,
        costUsd: 0.5,
        failedCallCostUsd: 0.5,
        failureOwners: { player_driver: 1 },
        repairs: { schema: 0, transient: 1, domain: 0 },
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
        averageCostWaitMs: 70,
        averageProviderDurationMs: 1_900,
      },
    });
    expect(report.jobs[0]!.candidate.costUsd).not.toBe(1.375);

    const markdown = renderPlaytestReport(report);
    expect(markdown).toContain("Judge and player-driver behavior is excluded from candidate technical status.");
    expect(markdown).toContain("openai/gpt-5.6-terra via direct");
    expect(markdown).toContain("Candidate: 1 calls, 0 failures, $0.125000");
    expect(markdown).toContain("Player driver: 1 calls, 1 failures, $0.500000");
    expect(markdown).toContain("Independent judge: 1 calls, 1 failures, $0.750000");
    expect(markdown).toContain("Failed coverage requirements: failed-fixture");
    expect(markdown).toContain("Player driver failure owners: player_driver=1");
    expect(markdown).toContain(`${"f".repeat(64)} (1)`);
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
        jobs: [{
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
        }],
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

    const changedSeed = await writeRun("changed-seed", "candidate-c", { seed: "other-seed" });
    await expect(comparePlaytestRuns(left, changedSeed)).rejects.toThrow("same package fingerprint");
    const changedPackage = await writeRun("changed-package", "candidate-c", { packageHash: "other-package-hash" });
    await expect(comparePlaytestRuns(left, changedPackage)).rejects.toThrow("same package fingerprint");
  });
});
