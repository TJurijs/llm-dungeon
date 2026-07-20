import { appendFile, mkdir, mkdtemp, readFile, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_MODEL_EXECUTION_PROFILE_DRAFTS,
  MODEL_EXECUTION_ADAPTER_REVISION,
  freezeModelExecutionProfile,
  type FrozenModelExecutionProfile,
} from "../src/model-execution-profile.js";
import {
  ModelAssessmentCatalog,
  type RecordCertificationInput,
} from "../src/model-assessment-catalog.js";
import {
  PlaytestCallRecordSchema,
  PlaytestTurnRecordSchema,
  type PlaytestModelTarget,
  type PlaytestRunConfig,
  type PlaytestTurnRecord,
} from "../tools/playtest/harness/contracts.js";
import {
  CERTIFICATION_CANONICAL_SETUPS,
  CERTIFICATION_PACKAGE,
  CERTIFICATION_PACKAGE_VERSION,
  CERTIFICATION_SCRIPT,
} from "../tools/playtest/harness/packages.js";
import { PlaytestRunner } from "../tools/playtest/harness/runner.js";
import { StateStore } from "../src/store.js";
import type { LlmProvider, StructuredRequest, StructuredResult } from "../src/types.js";

const CALIBRATED_AT = "2026-07-19T00:00:00.000Z";

function frozenProfile(provider: PlaytestModelTarget["config"]["provider"], model: string): FrozenModelExecutionProfile {
  const draft = DEFAULT_MODEL_EXECUTION_PROFILE_DRAFTS.find((candidate) =>
    candidate.key.provider === provider && candidate.key.model === model);
  if (!draft) throw new Error(`Missing test execution profile for ${provider}/${model}`);
  return freezeModelExecutionProfile({
    ...draft,
    calibratedAt: CALIBRATED_AT,
    evidenceRef: "calibrations/test-fixture",
  });
}

function target(profile: FrozenModelExecutionProfile): PlaytestModelTarget {
  return {
    config: {
      provider: profile.key.provider,
      model: profile.key.model,
      temperature: 0.8,
      maxOutputTokens: 4_000,
    },
    route: profile.key.route,
    executionProfileFingerprint: profile.fingerprint,
  };
}

const candidateProfile = frozenProfile("gemini", "gemini-3.5-flash");
const judgeProfile = frozenProfile("openai", "gpt-5.6-terra");
const playerProfile = frozenProfile("gemini", "gemini-3.1-flash-lite");
const candidateTarget = target(candidateProfile);
const judgeTarget = target(judgeProfile);
const playerTarget = target(playerProfile);

function certificationConfig(overrides: Partial<PlaytestRunConfig> = {}): PlaytestRunConfig {
  return {
    engineVersion: 1,
    package: { id: "certification-v1", version: CERTIFICATION_PACKAGE_VERSION },
    candidates: [candidateTarget],
    languages: ["en"],
    turns: 10,
    repetitions: 1,
    globalWorkerLimit: 1,
    latencyMode: "canonical",
    providerConcurrency: { gemini: 1, openai: 1 },
    maxCostUsd: 5,
    maxDurationMs: 600_000,
    judge: { policy: "final", rubricVersion: 1, target: judgeTarget },
    ...overrides,
  };
}

function resolved(turn: number) {
  return {
    kind: "resolved" as const,
    narration: `The controlled scene resolves turn ${turn} without adding unsupported state.`,
    turnSummary: `Controlled certification turn ${turn} completed.`,
    operations: [],
  };
}

function checkRequired(turn: number, failureCampaignStatus: "none" | "dead" | "ended" = "none") {
  return {
    kind: "check_required" as const,
    check: {
      name: `Certification check ${turn}`,
      difficulty: 50,
      modifiers: [],
      successStakes: "The bounded attempt succeeds.",
      failureStakes: "The bounded attempt fails proportionally.",
      failureCampaignStatus,
    },
  };
}

function judgment(turns = 10) {
  return {
    rubricVersion: 1 as const,
    qualityStatus: "high" as const,
    overallScore: 8,
    scores: {
      narrative: 8,
      agency: 8,
      persistence: 8,
      checks: 8,
      sandbox: 8,
      npcContinuity: 8,
      secrecy: 8,
      pacing: 8,
      language: 8,
    },
    executiveSummary: "The controlled transcript remains coherent.",
    strengths: ["The candidate preserves the application-owned state boundary."],
    issues: [],
    coverageJudgments: CERTIFICATION_PACKAGE.coverageRequirements
      .filter((requirement) => requirement.mode === "judge")
      .map((requirement) => ({
        requirementId: requirement.id,
        passed: true,
        evidence: "The persisted evidence supports this assessment.",
      })),
    turnAudits: Array.from({ length: turns }, (_, index) => ({
      turn: index + 1,
      durableConsequences: [],
    })),
    narrativeAssessment: "Narration follows the supplied actions.",
    persistenceAssessment: "No uncommitted durable consequence is claimed.",
    checksAssessment: "The controlled checks retain their locked rolls.",
    sandboxAndAgencyAssessment: "The sandbox boundary remains intact.",
    continuityAndSecrecyAssessment: "Continuity and secrets remain consistent.",
    pacingAndLanguageAssessment: "Pacing and language remain readable.",
    recommendedChanges: [],
  };
}

interface ActivityTracker {
  active: number;
  maxActive: number;
}

class RunnerFakeProvider implements LlmProvider {
  readonly id: string;
  readonly model: string;
  readonly requests: StructuredRequest<unknown>[] = [];
  readonly activity: ActivityTracker = { active: 0, maxActive: 0 };
  decisionCount = 0;
  failJudgment = false;
  judgmentFailuresRemaining = 0;
  delayMs = 0;
  cancelOnDecision: number | undefined;
  cancel: (() => void) | undefined;
  cancelledOnce = false;
  terminalOnDecision: number | undefined;

  constructor(
    profile: FrozenModelExecutionProfile,
    private readonly sharedActivity?: ActivityTracker,
  ) {
    this.id = profile.key.provider;
    this.model = profile.key.model;
  }

  async generateStructured<T>(request: StructuredRequest<T>): Promise<StructuredResult<T>> {
    this.requests.push(request as StructuredRequest<unknown>);
    this.activity.active += 1;
    this.activity.maxActive = Math.max(this.activity.maxActive, this.activity.active);
    if (this.sharedActivity) {
      this.sharedActivity.active += 1;
      this.sharedActivity.maxActive = Math.max(this.sharedActivity.maxActive, this.sharedActivity.active);
    }
    try {
      if (this.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.delayMs));
      let value: unknown;
      if (request.schemaName.includes("playtest_judgment")) {
        if (this.failJudgment || this.judgmentFailuresRemaining > 0) {
          if (this.judgmentFailuresRemaining > 0) this.judgmentFailuresRemaining -= 1;
          throw new Error("Independent judge fixture failed");
        }
        const requirementsText = request.prompt
          .split("SEMANTIC COVERAGE REQUIREMENTS\n")[1]
          ?.split("\n\nDETERMINISTIC COVERAGE")[0] ?? "[]";
        const requirements = JSON.parse(requirementsText) as Array<{ id: string }>;
        const turnMatch = /Judgment interval: (\d+) through (\d+)/u.exec(request.prompt);
        const throughTurn = Number(turnMatch?.[2] ?? 10);
        const turnsText = request.prompt
          .split("TURN RECORDS WITH LOCKED CHECKS AND COMMITTED OPERATIONS\n")[1]
          ?.split("\n\nAUTHORITATIVE STARTING STATE")[0] ?? "[]";
        const auditedTurns = JSON.parse(turnsText) as Array<{
          turn: number;
          operations: Array<{ operationIndex: number }>;
        }>;
        value = {
          ...judgment(throughTurn),
          coverageJudgments: requirements.map((requirement) => ({
            requirementId: requirement.id,
            passed: true,
            evidence: "The persisted interval supports this requirement.",
          })),
          turnAudits: auditedTurns.map((turn) => ({
            turn: turn.turn,
            durableConsequences: turn.operations.map((operation) => ({
              consequence: `Committed operation ${operation.operationIndex} persists.`,
              operationIndexes: [operation.operationIndex],
              persistence: "persisted",
            })),
          })),
        };
      } else if (request.schemaName.includes("playtest_player_action")) {
        value = {
          action: "I observe the scene and follow the most relevant established lead.",
          approach: "exploration",
        };
      } else if (request.schemaName.includes("campaign_setup")) {
        value = CERTIFICATION_CANONICAL_SETUPS.en;
      } else if (request.schemaName.includes("turn_resolution_v1")) {
        value = {
          narration: `The locked outcome resolves decision ${this.decisionCount}.`,
          turnSummary: `Locked outcome ${this.decisionCount} completed.`,
          operations: this.terminalOnDecision === this.decisionCount
            ? [{ type: "end_campaign", status: "dead", reason: "The locked severe failure is fatal." }]
            : [],
        };
      } else if (request.schemaName.includes("turn_decision_v1")) {
        this.decisionCount += 1;
        const checked = [3, 6, 7].includes(this.decisionCount);
        value = checked
          ? checkRequired(this.decisionCount, this.terminalOnDecision === this.decisionCount ? "dead" : "none")
          : resolved(this.decisionCount);
        if (!this.cancelledOnce && this.cancelOnDecision === this.decisionCount) {
          this.cancelledOnce = true;
          this.cancel?.();
        }
      } else {
        throw new Error(`Unexpected runner fixture schema ${request.schemaName}`);
      }
      return {
        data: request.schema.parse(value),
        provider: this.id,
        model: this.model,
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
        rawText: JSON.stringify(value),
      };
    } finally {
      this.activity.active -= 1;
      if (this.sharedActivity) this.sharedActivity.active -= 1;
    }
  }
}

class FirstCallGateProvider extends RunnerFakeProvider {
  private releaseGate: () => void = () => undefined;
  private signalStarted: () => void = () => undefined;
  private gated = false;
  readonly firstCallStarted = new Promise<void>((resolve) => {
    this.signalStarted = resolve;
  });
  private readonly firstCallGate = new Promise<void>((resolve) => {
    this.releaseGate = resolve;
  });

  releaseFirstCall(): void {
    this.releaseGate();
  }

  override async generateStructured<T>(request: StructuredRequest<T>): Promise<StructuredResult<T>> {
    if (!this.gated) {
      this.gated = true;
      this.signalStarted();
      await this.firstCallGate;
    }
    return super.generateStructured(request);
  }
}

class RecordingAssessmentCatalog extends ModelAssessmentCatalog {
  readonly certificationRecords: RecordCertificationInput[] = [];
  certificationAttempts = 0;
  failOnCertificationAttempt: number | undefined;

  override async recordCertification(input: RecordCertificationInput): Promise<void> {
    this.certificationAttempts += 1;
    if (this.certificationAttempts === this.failOnCertificationAttempt) {
      throw new Error("Temporary assessment commit failure");
    }
    this.certificationRecords.push(structuredClone(input));
    await super.recordCertification(input);
  }
}

async function readTurns(runDir: string, jobId = "job-001"): Promise<PlaytestTurnRecord[]> {
  const text = await readFile(path.join(runDir, "jobs", jobId, "turns.jsonl"), "utf8");
  return PlaytestTurnRecordSchema.array().parse(
    text.trim().split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line)),
  );
}

async function fixtureCatalog(root: string): Promise<RecordingAssessmentCatalog> {
  const catalog = new RecordingAssessmentCatalog(root, () => new Date(CALIBRATED_AT));
  await catalog.recordCalibration({
    provider: candidateProfile.key.provider,
    model: candidateProfile.key.model,
    route: candidateProfile.key.route,
    status: "calibrated",
    adapterRevision: MODEL_EXECUTION_ADAPTER_REVISION,
    profileFingerprint: candidateProfile.fingerprint,
    evidence: { source: "calibration", reference: "calibrations/test-fixture" },
  });
  return catalog;
}

function dependencies(
  candidate: LlmProvider,
  judge: LlmProvider,
  catalog?: ModelAssessmentCatalog,
) {
  return {
    profileFor: async (input: PlaytestModelTarget) => {
      if (input.config.provider === candidateProfile.key.provider
        && input.config.model === candidateProfile.key.model) return candidateProfile;
      if (input.config.provider === judgeProfile.key.provider
        && input.config.model === judgeProfile.key.model) return judgeProfile;
      throw new Error(`Unexpected target ${input.config.provider}/${input.config.model}`);
    },
    providerFor: (input: PlaytestModelTarget) =>
      input.config.provider === candidateProfile.key.provider ? candidate : judge,
    costFor: () => ({ inputPerMillion: 1, outputPerMillion: 1 }),
    worldRulesFor: async () => "Deterministic runner test rules.",
    ...(catalog ? { assessmentCatalog: catalog } : {}),
  };
}

describe("playtest runner", () => {
  it("preflights every target-language pair and rejects before creating providers", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "llm-dungeon-playtest-preflight-"));
    const preflights: string[] = [];
    let providerCreations = 0;
    const runner = new PlaytestRunner(root, path.join(root, "playtests"), {
      profileFor: async (input) => input.config.provider === "gemini" ? candidateProfile : judgeProfile,
      preflightTarget: async (input, language) => {
        preflights.push(`${input.config.provider}:${language}`);
        if (input.config.provider === "openai" && language === "ru") {
          throw new Error("Russian judge compatibility is unavailable");
        }
      },
      providerFor: () => {
        providerCreations += 1;
        return new RunnerFakeProvider(candidateProfile);
      },
      costFor: () => ({ inputPerMillion: 1, outputPerMillion: 1 }),
    });

    await expect(runner.run(certificationConfig({ languages: ["en", "ru"] }), "runner-preflight"))
      .rejects.toThrow("Russian judge compatibility is unavailable");
    expect(preflights).toEqual([
      "gemini:en",
      "gemini:ru",
      "openai:en",
      "openai:ru",
    ]);
    expect(providerCreations).toBe(0);
  });

  it("rejects duplicate certification candidates and repeated certification before any preflight or call", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "llm-dungeon-playtest-certification-controls-"));
    const candidate = new RunnerFakeProvider(candidateProfile);
    let profileReads = 0;
    let preflights = 0;
    let providerCreations = 0;
    const runner = new PlaytestRunner(root, path.join(root, "playtests"), {
      profileFor: async () => {
        profileReads += 1;
        return candidateProfile;
      },
      preflightTarget: async () => {
        preflights += 1;
      },
      providerFor: () => {
        providerCreations += 1;
        return candidate;
      },
      costFor: () => ({ inputPerMillion: 1, outputPerMillion: 1 }),
    });

    await expect(runner.run(certificationConfig({
      candidates: [candidateTarget, candidateTarget],
    }), "runner-duplicate-certification"))
      .rejects.toThrow("Candidate provider/model/routes must be unique");
    await expect(runner.run(certificationConfig({ repetitions: 2 }), "runner-repeated-certification"))
      .rejects.toThrow("certification-v1 requires exactly one authoritative repetition");
    expect({ profileReads, preflights, providerCreations }).toEqual({
      profileReads: 0,
      preflights: 0,
      providerCreations: 0,
    });
    expect(candidate.requests).toEqual([]);
  });

  it("allows the fixed judge model to match the candidate when the call lane is separate", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "llm-dungeon-playtest-same-judge-"));
    const runner = new PlaytestRunner(root, path.join(root, "playtests"), {
      profileFor: async () => candidateProfile,
      preflightTarget: async () => { throw new Error("same-model judge reached preflight"); },
      providerFor: () => new RunnerFakeProvider(candidateProfile),
      costFor: () => ({ inputPerMillion: 1, outputPerMillion: 1 }),
    });

    await expect(runner.run(certificationConfig({
      judge: { policy: "final", rubricVersion: 1, target: candidateTarget },
    }), "runner-same-model-judge")).rejects.toThrow("same-model judge reached preflight");
  });

  it("executes all ten certification actions and rolls, then reruns a separate judge without gameplay commits", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "llm-dungeon-playtest-runner-"));
    const candidate = new RunnerFakeProvider(candidateProfile);
    const judge = new RunnerFakeProvider(judgeProfile);
    judge.failJudgment = true;
    const catalog = await fixtureCatalog(root);
    const runner = new PlaytestRunner(root, path.join(root, "playtests"), dependencies(candidate, judge, catalog));

    const failedJudgment = await runner.run(certificationConfig(), "runner-certification");
    const jobDir = path.join(failedJudgment.runDir, "jobs", "job-001");
    const turns = await readTurns(failedJudgment.runDir);
    expect(turns).toHaveLength(10);
    expect(turns.map((turn) => turn.scriptedTurnId)).toEqual(CERTIFICATION_SCRIPT.map((turn) => turn.id));
    expect(turns.map((turn) => turn.assignedNaturalRoll)).toEqual([42, 55, 100, 64, 71, 82, 1, 36, 49, 93]);
    expect(turns.every((turn) => turn.driver === "scripted")).toBe(true);
    for (const [index, turn] of turns.entries()) {
      expect(CERTIFICATION_SCRIPT[index]!.branches.map((branch) => branch.action.en)).toContain(turn.action);
    }
    expect(turns.filter((turn) => turn.check).map((turn) => [turn.turn, turn.check!.roll]))
      .toEqual([[3, 100], [6, 82], [7, 1]]);
    expect(failedJudgment.manifest.jobs[0]).toMatchObject({
      status: "awaiting_judgment",
      completedTurns: 10,
      qualityStatus: "awaiting_judgment",
    });

    const technicalBefore = await readFile(path.join(jobDir, "technical.json"), "utf8");
    const turnsBefore = await readFile(path.join(jobDir, "turns.jsonl"), "utf8");
    const candidateCallsBefore = await readFile(path.join(jobDir, "calls", "candidate.jsonl"), "utf8");
    const campaignStore = new StateStore(path.join(jobDir, "campaign"));
    expect((await campaignStore.load()).manifest.turn).toBe(10);

    judge.failJudgment = false;
    let currentProfileReads = 0;
    let currentPreflights = 0;
    const retryRunner = new PlaytestRunner(root, path.join(root, "playtests"), {
      ...dependencies(candidate, judge, catalog),
      profileFor: async () => {
        currentProfileReads += 1;
        throw new Error("Current calibration changed after gameplay");
      },
      preflightTarget: async () => {
        currentPreflights += 1;
        throw new Error("Historical judging must not rerun current preflight");
      },
    });
    const judged = await retryRunner.judge("runner-certification");
    expect(judged.manifest.jobs[0]).toMatchObject({
      status: "completed",
      completedTurns: 10,
      qualityStatus: "high",
    });
    expect(await readFile(path.join(jobDir, "technical.json"), "utf8")).toBe(technicalBefore);
    expect(await readFile(path.join(jobDir, "turns.jsonl"), "utf8")).toBe(turnsBefore);
    expect(await readFile(path.join(jobDir, "calls", "candidate.jsonl"), "utf8")).toBe(candidateCallsBefore);
    expect((await campaignStore.load()).manifest.turn).toBe(10);
    expect(currentProfileReads).toBe(0);
    expect(currentPreflights).toBe(0);
    expect(catalog.certificationRecords).toHaveLength(2);
    expect(catalog.certificationRecords.every((record) => record.packageId === "certification-v1")).toBe(true);
    expect(await catalog.effective({
      provider: candidateTarget.config.provider,
      model: candidateTarget.config.model,
      route: candidateTarget.route,
    }, "en")).toMatchObject({ certificationCurrent: true, qualityStatus: "high" });
  });

  it("preserves a valid death and finishes later coverage in a fresh isolated fixture", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "llm-dungeon-playtest-terminal-continuation-"));
    const candidate = new RunnerFakeProvider(candidateProfile);
    candidate.terminalOnDecision = 7;
    const judge = new RunnerFakeProvider(judgeProfile);
    const catalog = await fixtureCatalog(root);
    const runner = new PlaytestRunner(root, path.join(root, "playtests"), dependencies(candidate, judge, catalog));

    const result = await runner.run(certificationConfig(), "runner-terminal-continuation");
    const jobDir = path.join(result.runDir, "jobs", "job-001");
    const turns = await readTurns(result.runDir);
    expect(turns).toHaveLength(10);
    expect(turns.slice(0, 7).every((turn) => turn.fixtureId === "primary")).toBe(true);
    expect(turns.slice(7).every((turn) => turn.fixtureId === "coverage-after-007")).toBe(true);
    expect((await new StateStore(path.join(jobDir, "campaign")).load()).manifest).toMatchObject({
      turn: 7,
      status: "dead",
    });
    expect((await new StateStore(path.join(jobDir, "fixtures", "coverage-after-007", "campaign")).load()).manifest)
      .toMatchObject({ turn: 10, status: "active" });
    const warmupText = await readFile(
      path.join(jobDir, "fixtures", "coverage-after-007", "warmup-turns.jsonl"),
      "utf8",
    );
    const warmupTurns = PlaytestTurnRecordSchema.array().parse(
      warmupText.trim().split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line)),
    );
    expect(warmupTurns).toHaveLength(7);
    expect(result.manifest.jobs[0]).toMatchObject({
      status: "completed",
      completedTurns: 10,
      stopReason: "turn_limit",
      technicalStatus: "clean",
    });
    expect(await readFile(path.join(jobDir, "transcript.md"), "utf8"))
      .toContain("Fresh isolated coverage fixture");
  });

  it("reconciles a completed immutable judgment after its assessment commit was interrupted", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "llm-dungeon-playtest-judgment-commit-"));
    const candidate = new RunnerFakeProvider(candidateProfile);
    const judge = new RunnerFakeProvider(judgeProfile);
    const catalog = await fixtureCatalog(root);
    catalog.failOnCertificationAttempt = 2;
    const runner = new PlaytestRunner(root, path.join(root, "playtests"), dependencies(candidate, judge, catalog));

    const interrupted = await runner.run(certificationConfig(), "runner-judgment-commit");
    expect(interrupted.manifest.jobs[0]).toMatchObject({
      status: "awaiting_judgment",
      failureOwner: "judge",
      qualityStatus: "awaiting_judgment",
    });
    const judgeCallsBefore = judge.requests.filter((request) =>
      request.schemaName.includes("playtest_judgment")).length;
    expect(judgeCallsBefore).toBe(1);

    catalog.failOnCertificationAttempt = undefined;
    const reconciled = await runner.judge("runner-judgment-commit");
    expect(reconciled.manifest.jobs[0]).toMatchObject({
      status: "completed",
      qualityStatus: "high",
    });
    expect(judge.requests.filter((request) =>
      request.schemaName.includes("playtest_judgment"))).toHaveLength(judgeCallsBefore);
    expect(catalog.certificationRecords).toHaveLength(2);
  });

  it("resumes a prepared checked turn from its persisted pending roll without duplicating a commit", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "llm-dungeon-playtest-resume-"));
    const candidate = new RunnerFakeProvider(candidateProfile);
    const judge = new RunnerFakeProvider(judgeProfile);
    const catalog = await fixtureCatalog(root);
    let runner: PlaytestRunner;
    runner = new PlaytestRunner(root, path.join(root, "playtests"), dependencies(candidate, judge, catalog));
    candidate.cancelOnDecision = 3;
    candidate.cancel = () => runner.cancel();

    const interrupted = await runner.run(certificationConfig(), "runner-resume");
    const jobDir = path.join(interrupted.runDir, "jobs", "job-001");
    expect(interrupted.manifest.jobs[0]).toMatchObject({ status: "cancelled", completedTurns: 2 });
    const prepared = JSON.parse(await readFile(path.join(jobDir, "prepared-turn.json"), "utf8")) as {
      turn: number;
      assignedNaturalRoll: number;
    };
    expect(prepared).toMatchObject({ turn: 3, assignedNaturalRoll: 100 });
    const campaignStore = new StateStore(path.join(jobDir, "campaign"));
    expect(await campaignStore.getPending()).toMatchObject({
      kind: "action",
      phase: "rolled",
      checkResult: { roll: 100 },
    });

    const resumed = await runner.resume("runner-resume");
    const turns = await readTurns(resumed.runDir);
    expect(turns).toHaveLength(10);
    expect(turns.map((turn) => turn.turn)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(turns[2]?.check?.roll).toBe(100);
    expect((await campaignStore.load()).manifest.turn).toBe(10);
    expect(await campaignStore.getPending()).toBeUndefined();
  });

  it("runs autoplay checkpoint judgments separately and retries only the failed interval", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "llm-dungeon-playtest-autoplay-"));
    const candidate = new RunnerFakeProvider(candidateProfile);
    const player = new RunnerFakeProvider(playerProfile);
    const judge = new RunnerFakeProvider(judgeProfile);
    judge.judgmentFailuresRemaining = 1;
    const runner = new PlaytestRunner(root, path.join(root, "playtests"), {
      profileFor: async (input) => {
        if (input.config.model === candidateProfile.key.model) return candidateProfile;
        if (input.config.model === playerProfile.key.model) return playerProfile;
        if (input.config.model === judgeProfile.key.model) return judgeProfile;
        throw new Error(`Unexpected target ${input.config.model}`);
      },
      providerFor: (input) => {
        if (input.config.model === candidateProfile.key.model) return candidate;
        if (input.config.model === playerProfile.key.model) return player;
        return judge;
      },
      costFor: () => ({ inputPerMillion: 1, outputPerMillion: 1 }),
      worldRulesFor: async () => "Deterministic autoplay test rules.",
    });
    const config: PlaytestRunConfig = {
      engineVersion: 1,
      package: { id: "campaign-autoplay-v1", version: 1 },
      candidates: [candidateTarget],
      languages: ["en"],
      turns: 25,
      seed: "autoplay-checkpoints",
      repetitions: 1,
      globalWorkerLimit: 1,
      latencyMode: "canonical",
      providerConcurrency: { gemini: 1, openai: 1 },
      maxCostUsd: 5,
      maxDurationMs: 600_000,
      player: { target: playerTarget, profile: "curious-explorer" },
      judge: {
        policy: "checkpoints_and_final",
        rubricVersion: 1,
        target: judgeTarget,
        checkpointEvery: 10,
      },
    };

    const first = await runner.run(config, "runner-autoplay-checkpoints");
    const jobDir = path.join(first.runDir, "jobs", "job-001");
    expect(first.manifest.jobs[0]).toMatchObject({
      status: "awaiting_judgment",
      completedTurns: 25,
    });
    const candidateBefore = await readFile(path.join(jobDir, "calls", "candidate.jsonl"), "utf8");
    const playerBefore = await readFile(path.join(jobDir, "calls", "player-driver.jsonl"), "utf8");
    const initialTasks = JSON.parse(await readFile(path.join(jobDir, "judge-tasks.json"), "utf8")) as Array<{
      id: string;
      status: string;
      attempts: number;
    }>;
    expect(initialTasks.map((task) => [task.id, task.status, task.attempts])).toEqual([
      ["checkpoint-010", "failed", 1],
      ["checkpoint-020", "completed", 1],
      ["final", "completed", 1],
    ]);

    const retried = await runner.judge("runner-autoplay-checkpoints");
    expect(retried.manifest.jobs[0]).toMatchObject({ status: "completed", completedTurns: 25 });
    expect(await readFile(path.join(jobDir, "calls", "candidate.jsonl"), "utf8")).toBe(candidateBefore);
    expect(await readFile(path.join(jobDir, "calls", "player-driver.jsonl"), "utf8")).toBe(playerBefore);
    const retriedTasks = JSON.parse(await readFile(path.join(jobDir, "judge-tasks.json"), "utf8")) as Array<{
      id: string;
      status: string;
      attempts: number;
    }>;
    expect(retriedTasks.map((task) => [task.id, task.status, task.attempts])).toEqual([
      ["checkpoint-010", "completed", 2],
      ["checkpoint-020", "completed", 1],
      ["final", "completed", 1],
    ]);
    const judgeCalls = PlaytestCallRecordSchema.array().parse(
      (await readFile(path.join(jobDir, "calls", "judge.jsonl"), "utf8"))
        .trim().split(/\r?\n/u).map((line) => JSON.parse(line)),
    );
    expect(judgeCalls.map((call) => call.phase)).toEqual([
      "checkpoint_judge",
      "checkpoint_judge",
      "final_judge",
      "checkpoint_judge",
    ]);
  });

  it("keeps the run lock until sibling workers settle when one provider fails during initialization", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "llm-dungeon-playtest-worker-lock-"));
    const candidate = new FirstCallGateProvider(candidateProfile);
    const judge = new RunnerFakeProvider(judgeProfile);
    const catalog = await fixtureCatalog(root);
    let candidateInitializations = 0;
    const runnerDependencies = {
      profileFor: async (input: PlaytestModelTarget) =>
        input.config.provider === "gemini" ? candidateProfile : judgeProfile,
      providerFor: (input: PlaytestModelTarget) => {
        if (input.config.provider !== "gemini") return judge;
        candidateInitializations += 1;
        if (candidateInitializations === 1) {
          throw new Error("Candidate provider initialization failed without typed evidence");
        }
        return candidate;
      },
      costFor: () => ({ inputPerMillion: 1, outputPerMillion: 1 }),
      assessmentCatalog: catalog,
    };
    const runner = new PlaytestRunner(root, path.join(root, "playtests"), runnerDependencies);
    const config = certificationConfig({
      languages: ["en", "ru"],
      globalWorkerLimit: 2,
      latencyMode: "loaded",
      providerConcurrency: { gemini: 2, openai: 2 },
    });
    const running = runner.run(config, "runner-worker-lock");

    await candidate.firstCallStarted;
    const competingRunner = new PlaytestRunner(root, path.join(root, "playtests"), runnerDependencies);
    try {
      await expect(competingRunner.resume("runner-worker-lock"))
        .rejects.toThrow("Playtest run runner-worker-lock is locked by another running process");
    } finally {
      candidate.releaseFirstCall();
    }

    const result = await running;
    expect(result.manifest.jobs).toHaveLength(2);
    expect(result.manifest.jobs.filter((job) => job.status === "inconclusive")).toEqual([
      expect.objectContaining({
        stopReason: "error",
        failureOwner: "inconclusive",
        error: "Candidate provider initialization failed without typed evidence",
      }),
    ]);
    expect(result.manifest.jobs.filter((job) => job.status === "completed")).toHaveLength(1);
    expect(candidateInitializations).toBe(2);
  });

  it("does not attribute a later application failure to a recovered historical failed call", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "llm-dungeon-playtest-attribution-resume-"));
    const candidate = new RunnerFakeProvider(candidateProfile);
    const judge = new RunnerFakeProvider(judgeProfile);
    const catalog = await fixtureCatalog(root);
    let runner: PlaytestRunner;
    runner = new PlaytestRunner(root, path.join(root, "playtests"), dependencies(candidate, judge, catalog));
    candidate.cancelOnDecision = 3;
    candidate.cancel = () => runner.cancel();

    const interrupted = await runner.run(certificationConfig(), "runner-attribution-resume");
    expect(interrupted.manifest.jobs[0]).toMatchObject({ status: "cancelled", completedTurns: 2 });
    const jobDir = path.join(interrupted.runDir, "jobs", "job-001");
    const candidateCallsPath = path.join(jobDir, "calls", "candidate.jsonl");
    const existingCalls = PlaytestCallRecordSchema.array().parse(
      (await readFile(candidateCallsPath, "utf8"))
        .trim()
        .split(/\r?\n/u)
        .filter(Boolean)
        .map((line) => JSON.parse(line)),
    );
    const historicalFailure = PlaytestCallRecordSchema.parse({
      id: "historical-failed-call",
      timestamp: "2026-07-19T00:01:00.000Z",
      jobId: "job-001",
      actor: "candidate",
      phase: "decision",
      sequence: existingCalls.length + 1,
      schemaName: "turn_decision_v1",
      provider: candidateProfile.key.provider,
      model: candidateProfile.key.model,
      route: candidateProfile.key.route,
      executionProfileFingerprint: candidateProfile.fingerprint,
      providerDurationMs: 1,
      promptHash: "historical-prompt",
      systemHash: "historical-system",
      schemaHash: "historical-schema",
      success: false,
      estimatedCostUsd: 0,
      failureKind: "wire_schema_violation",
      failureOwner: "candidate_model",
      failureFingerprint: "a".repeat(64),
      error: "Historical failure already recovered before interruption",
    });
    await appendFile(candidateCallsPath, `${JSON.stringify(historicalFailure)}\n`, "utf8");

    const campaignManifest = path.join(jobDir, "campaign", "current", "manifest.json");
    await rename(campaignManifest, `${campaignManifest}.fixture-backup`);
    await mkdir(campaignManifest);

    const resumed = await runner.resume("runner-attribution-resume");
    expect(resumed.manifest.jobs[0]).toMatchObject({
      status: "inconclusive",
      stopReason: "error",
      failureOwner: "application",
    });
    const turns = await readTurns(resumed.runDir);
    expect(turns.at(-1)).toMatchObject({
      turn: 3,
      status: "failed",
      failureOwner: "application",
    });
    const persistedCalls = PlaytestCallRecordSchema.array().parse(
      (await readFile(candidateCallsPath, "utf8"))
        .trim()
        .split(/\r?\n/u)
        .filter(Boolean)
        .map((line) => JSON.parse(line)),
    );
    expect(persistedCalls.at(-1)).toMatchObject({
      id: "historical-failed-call",
      failureOwner: "candidate_model",
    });
  });

  it("bounds cross-job concurrency while keeping each campaign sequential and never certifies tuning evidence", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "llm-dungeon-playtest-concurrency-"));
    const shared: ActivityTracker = { active: 0, maxActive: 0 };
    const candidates: RunnerFakeProvider[] = [];
    const judge = new RunnerFakeProvider(judgeProfile);
    const catalog = await fixtureCatalog(root);
    const runner = new PlaytestRunner(root, path.join(root, "playtests"), {
      profileFor: async (input) => input.config.provider === "gemini" ? candidateProfile : judgeProfile,
      providerFor: (input) => {
        if (input.config.provider !== "gemini") return judge;
        const candidate = new RunnerFakeProvider(candidateProfile, shared);
        candidate.delayMs = 3;
        candidates.push(candidate);
        return candidate;
      },
      costFor: () => ({ inputPerMillion: 1, outputPerMillion: 1 }),
      worldRulesFor: async () => "Deterministic runner test rules.",
      assessmentCatalog: catalog,
    });
    const config: PlaytestRunConfig = {
      ...certificationConfig(),
      package: { id: "tuning-v1", version: 1 },
      tuningVariable: "model: one-controlled-test-variable",
      repetitions: 2,
      globalWorkerLimit: 2,
      latencyMode: "loaded",
      providerConcurrency: { gemini: 2 },
    };

    const result = await runner.run(config, "runner-concurrency");
    expect(result.manifest.jobs).toHaveLength(2);
    expect(result.manifest.jobs.every((job) => job.status === "completed" && job.completedTurns === 10)).toBe(true);
    expect(shared.maxActive).toBe(2);
    expect(shared.maxActive).toBeLessThanOrEqual(2);
    expect(candidates).toHaveLength(2);
    expect(candidates.every((candidate) => candidate.activity.maxActive === 1)).toBe(true);
    expect(catalog.certificationRecords).toEqual([]);
  });
});
