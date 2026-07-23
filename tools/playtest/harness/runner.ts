import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { TransactionValidationError } from "../../../src/domain/transaction.js";
import { DungeonEngine } from "../../../src/engine.js";
import { generateStructured } from "../../../src/llm/structured-generation.js";
import { ModelAssessmentCatalog } from "../../../src/model-assessment-catalog.js";
import {
  FrozenModelExecutionProfileSchema,
  type FrozenModelExecutionProfile,
} from "../../../src/model-execution-profile.js";
import { atomicWriteJson, atomicWriteText } from "../../../src/persistence/files.js";
import { acquireFileLock } from "../../../src/persistence/lock.js";
import {
  parsePlayerVisibleTurn,
  parseTurnCheck,
  parseTurnOperations,
} from "../../../src/persistence/markdown.js";
import { playtestPlayerPrompt, playtestPlayerSystemPrompt } from "../prompts/playtest-player.js";
import { inferTokenPrice } from "../../../src/pricing.js";
import { StateStore } from "../../../src/store.js";
import type { LlmProvider, TurnResult } from "../../../src/types.js";
import { loadScenarioSeed } from "../../../src/scenario-seeds.js";
import { resolveWorldProfile } from "../../../src/world-profile.js";
import {
  CandidateTechnicalSnapshotSchema,
  assessPlaytest,
  buildCandidateTechnicalSnapshot,
  type CandidateTechnicalSnapshot,
} from "./assessment.js";
import { assessCoverage, buildMechanicalAudit } from "./audit.js";
import {
  PLAYTEST_ENGINE_VERSION,
  PLAYER_PROFILES,
  PlaytestCallRecordSchema,
  PlaytestManifestSchema,
  PlaytestRunConfigSchema,
  PlaytestRunIdSchema,
  PlaytestTurnRecordSchema,
  SimulatedPlayerActionSchema,
  type FailureOwner,
  type PlaytestCallRecord,
  type PlaytestJob,
  type PlaytestManifest,
  type PlaytestModelTarget,
  type PlaytestPackage,
  type PlaytestRunConfig,
  type PlaytestTurnRecord,
  type ScriptedTurn,
} from "./contracts.js";
import {
  PlaytestCostLimitError,
  PlaytestCostManager,
  type PlaytestModelCost,
} from "./cost.js";
import {
  reservationLedgerPathForCalls,
  unsettledPlaytestCallCost,
} from "./cost-ledger.js";
import { attributePlaytestFailure } from "./failure-attribution.js";
import { appendPlaytestJsonLine, hashPlaytestValue, readPlaytestJsonLines } from "./files.js";
import {
  playtestJudgePrompt,
  playtestJudgeSystemPrompt,
  playtestJudgmentSchemaFor,
  PlaytestJudgmentSchema,
  renderPlaytestJudgment,
  type PlaytestJudgePromptInput,
  type PlaytestJudgment,
} from "./judge.js";
import { playtestCodeVersion, readOptionalPlaytestManifest, readPlaytestManifest } from "./manifest.js";
import { getPlaytestPackage } from "./packages.js";
import { rollPolicy } from "./random.js";
import { generatePlaytestReport } from "./report.js";
import { CampaignTurnScheduler, PlaytestProviderScheduler } from "./scheduler.js";
import {
  PlaytestDurationLimitError,
  PlaytestTelemetryProvider,
} from "./telemetry.js";

export interface PlaytestRunnerDependencies {
  profileFor(target: PlaytestModelTarget): Promise<FrozenModelExecutionProfile>;
  preflightTarget?(target: PlaytestModelTarget, language: PlaytestJob["language"]): Promise<void>;
  providerFor(target: PlaytestModelTarget, profile: FrozenModelExecutionProfile): LlmProvider;
  costFor?(target: PlaytestModelTarget): PlaytestModelCost;
  worldRulesFor?(language: PlaytestJob["language"]): Promise<string>;
  assessmentCatalog?: ModelAssessmentCatalog | undefined;
  secrets?: readonly string[] | undefined;
  now?: (() => Date) | undefined;
}

export interface PlaytestProgressEvent {
  runId: string;
  jobId: string;
  phase: "queued" | "setup" | "playing" | "assessing" | "judging" | "completed" | "failed";
  completedTurns: number;
  totalTurns: number;
  estimatedCostUsd: number;
  message: string;
}

export interface PlaytestRunResult {
  manifest: PlaytestManifest;
  runDir: string;
  reportPath: string;
}

const PreparedTurnSchema = z.object({
  schemaVersion: z.literal(1),
  turn: z.number().int().positive(),
  fixtureId: z.string().regex(/^[a-z][a-z0-9-]*$/).optional(),
  action: z.string().min(1),
  scriptedTurnId: z.string().optional(),
  driver: PlaytestTurnRecordSchema.shape.driver,
  profile: PlaytestTurnRecordSchema.shape.profile.optional(),
  expectedCheckPolicy: PlaytestTurnRecordSchema.shape.expectedCheckPolicy,
  assignedNaturalRoll: z.number().int().min(1).max(100),
  contextObservation: PlaytestTurnRecordSchema.shape.contextObservation,
  preparedAt: z.string().datetime(),
}).strict();
type PreparedTurn = z.infer<typeof PreparedTurnSchema>;

const TerminalContinuationStateSchema = z.object({
  schemaVersion: z.literal(1),
  fixtureId: z.string().regex(/^[a-z][a-z0-9-]*$/),
  afterTurn: z.number().int().positive(),
  priorCampaignStatus: z.enum(["dead", "ended"]),
  status: z.enum(["preparing", "active", "terminal"]),
  openingNarration: z.string().min(1),
}).strict();
type TerminalContinuationState = z.infer<typeof TerminalContinuationStateSchema>;

const JudgeTaskSchema = z.object({
  id: z.string().regex(/^(checkpoint-[0-9]{3}|final)$/),
  kind: z.enum(["checkpoint", "final"]),
  fromTurn: z.number().int().positive(),
  throughTurn: z.number().int().positive(),
  status: z.enum(["pending", "running", "completed", "failed"]),
  attempts: z.number().int().nonnegative(),
  error: z.string().optional(),
}).strict();
const JudgeTasksSchema = z.array(JudgeTaskSchema);
type JudgeTask = z.infer<typeof JudgeTaskSchema>;

const ExecutionProfileSnapshotsSchema = z.object({
  schemaVersion: z.literal(1),
  profiles: z.array(FrozenModelExecutionProfileSchema).min(1),
}).strict().superRefine((value, context) => {
  const keys = new Set<string>();
  for (const [index, profile] of value.profiles.entries()) {
    const key = `${profile.key.provider}\u0000${profile.key.model}\u0000${profile.key.route}`;
    if (keys.has(key)) {
      context.addIssue({
        code: "custom",
        path: ["profiles", index],
        message: "duplicate provider/model/route execution profile snapshot",
      });
    }
    keys.add(key);
  }
});
type ExecutionProfileSnapshots = z.infer<typeof ExecutionProfileSnapshotsSchema>;

function safeRunId(now: Date): string {
  return `${now.toISOString().replace(/[:.]/g, "-")}-${randomUUID()}`;
}

function targetKey(target: PlaytestModelTarget): string {
  return `${target.config.provider}\u0000${target.config.model}\u0000${target.route}`;
}

function underlyingModel(model: string): string {
  return model.toLowerCase().replace(/^(google|openai|anthropic|deepseek|x-ai)\//, "");
}

function sameUnderlyingModel(left: PlaytestModelTarget, right: PlaytestModelTarget): boolean {
  return underlyingModel(left.config.model) === underlyingModel(right.config.model);
}

function jobId(index: number): string {
  return `job-${String(index + 1).padStart(3, "0")}`;
}

function configuredTurns(config: PlaytestRunConfig, playtestPackage: PlaytestPackage): number {
  const turns = config.turns ?? playtestPackage.turns.default;
  if (turns < playtestPackage.turns.minimum || turns > playtestPackage.turns.maximum) {
    throw new Error(`${playtestPackage.id} permits ${playtestPackage.turns.minimum}–${playtestPackage.turns.maximum} turns, received ${turns}`);
  }
  return turns;
}

function defaultCost(target: PlaytestModelTarget): PlaytestModelCost {
  const cost = target.cost ?? inferTokenPrice(target.config.provider, target.config.model);
  if (!cost) throw new Error(`No built-in token price for ${target.config.provider}/${target.config.model}`);
  return cost;
}

function stateFile(jobDir: string, turn: number): string {
  return path.join(jobDir, "states", `turn-${String(turn).padStart(3, "0")}.txt`);
}

async function readOptionalText(target: string): Promise<string | undefined> {
  try {
    return await readFile(target, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function readPreparedTurn(target: string): Promise<PreparedTurn | undefined> {
  try {
    return PreparedTurnSchema.parse(JSON.parse(await readFile(target, "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function readTerminalContinuationState(target: string): Promise<TerminalContinuationState | undefined> {
  try {
    return TerminalContinuationStateSchema.parse(JSON.parse(await readFile(target, "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function callsAt(target: string): Promise<PlaytestCallRecord[]> {
  return PlaytestCallRecordSchema.array().parse(await readPlaytestJsonLines(target));
}

function transcriptText(opening: string, turns: readonly PlaytestTurnRecord[]): string {
  const sections = ["# Player-facing playtest transcript", "", "## Opening", "", opening];
  let fixtureId = turns[0]?.fixtureId ?? "primary";
  for (const turn of turns.filter((candidate) => candidate.status === "completed")) {
    const nextFixtureId = turn.fixtureId ?? "primary";
    if (nextFixtureId !== fixtureId) {
      sections.push(
        "",
        "## Fresh isolated coverage fixture",
        "",
        "The prior campaign reached a valid terminal outcome. Remaining scripted coverage continues in a fresh fixture; the terminal campaign was not resumed or rewritten.",
      );
      fixtureId = nextFixtureId;
    }
    sections.push(
      "",
      `## Turn ${turn.turn}`,
      "",
      `Player: ${turn.action}`,
      ...(turn.check
        ? ["", `Check: ${turn.check.spec.name}; d100 ${turn.check.roll}; total ${turn.check.total} vs ${turn.check.spec.difficulty}; ${turn.check.outcome}`]
        : []),
      "",
      turn.narration ?? "",
      "",
      `Summary: ${turn.summary ?? ""}`,
    );
  }
  return `${sections.join("\n")}\n`;
}

function actionBranchMatches(
  branch: ScriptedTurn["branches"][number],
  loaded: Awaited<ReturnType<StateStore["load"]>>,
  turns: readonly PlaytestTurnRecord[],
): boolean {
  const condition = branch.when;
  if (condition.kind === "always") return true;
  if (condition.kind === "at_location") return loaded.manifest.currentLocationId === condition.locationId;
  if (condition.kind === "thread_status") {
    return loaded.threads.some((thread) => thread.id === condition.threadId && thread.status === condition.status);
  }
  if (condition.kind === "prior_check_outcome") {
    return turns.find((turn) => turn.turn === condition.turn)?.check !== undefined
      && condition.outcomes.includes(turns.find((turn) => turn.turn === condition.turn)!.check!.outcome);
  }
  const quantity = loaded.entities.get(condition.ownerId)?.inventory
    .find((entry) => entry.entityId === condition.itemId)?.quantity ?? 0;
  if (condition.kind === "inventory_contains") return quantity >= condition.minimumQuantity;
  return quantity === 0;
}

function isCancellation(error: unknown, signal: AbortSignal): boolean {
  return signal.aborted || (error instanceof Error && error.message === "Playtest operation cancelled");
}

function nodeApplicationError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return typeof code === "string" || (error instanceof Error && /filesystem|commit|lock|manifest|campaign store/i.test(error.message));
}

async function allRecordedCost(runDir: string): Promise<number> {
  let total = 0;
  const jobsDir = path.join(runDir, "jobs");
  let jobs: string[];
  try {
    jobs = await readdir(jobsDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw error;
  }
  for (const job of jobs) {
    for (const lane of ["candidate", "player-driver", "judge"] as const) {
      const callsPath = path.join(jobsDir, job, "calls", `${lane}.jsonl`);
      const calls = await callsAt(callsPath);
      total += calls.reduce((sum, call) => sum + call.estimatedCostUsd, 0);
      total += await unsettledPlaytestCallCost(
        reservationLedgerPathForCalls(callsPath),
        calls,
      );
    }
  }
  return Math.round(total * 1_000_000) / 1_000_000;
}

export class PlaytestRunner {
  private controller = new AbortController();
  private readonly turnScheduler = new CampaignTurnScheduler();
  private manifestWrites = Promise.resolve();

  constructor(
    private readonly projectRoot: string,
    private readonly playtestsRoot: string,
    private readonly dependencies: PlaytestRunnerDependencies,
    private readonly onProgress: (event: PlaytestProgressEvent) => void = () => undefined,
  ) {}

  cancel(): void {
    this.controller.abort();
  }

  async run(
    rawConfig: PlaytestRunConfig,
    requestedRunId?: string,
  ): Promise<PlaytestRunResult> {
    this.controller = new AbortController();
    const config = PlaytestRunConfigSchema.parse(rawConfig);
    const playtestPackage = getPlaytestPackage(config.package.id, config.package.version);
    this.validateConfig(config, playtestPackage);
    const profiles = await this.preflightProfiles(config);
    const runId = PlaytestRunIdSchema.parse(requestedRunId ?? safeRunId(this.now()));
    return this.withRunLock(runId, () => this.runLocked(runId, config, playtestPackage, profiles));
  }

  async resume(runId: string): Promise<PlaytestRunResult> {
    this.controller = new AbortController();
    runId = PlaytestRunIdSchema.parse(runId);
    return this.withRunLock(runId, async () => {
      const runDir = path.join(this.playtestsRoot, "runs", runId);
      const manifest = await readPlaytestManifest(path.join(runDir, "manifest.json"));
      this.validateConfig(manifest.config, manifest.packageSnapshot);
      const profiles = await this.loadProfileSnapshots(runDir, manifest.config);
      return this.runLocked(runId, manifest.config, manifest.packageSnapshot, profiles);
    });
  }

  async judge(runId: string): Promise<PlaytestRunResult> {
    this.controller = new AbortController();
    runId = PlaytestRunIdSchema.parse(runId);
    return this.withRunLock(runId, async () => {
      const runDir = path.join(this.playtestsRoot, "runs", runId);
      const manifest = await readPlaytestManifest(path.join(runDir, "manifest.json"));
      const profiles = await this.loadProfileSnapshots(runDir, manifest.config);
      const scheduler = new PlaytestProviderScheduler(
        manifest.config.globalWorkerLimit,
        manifest.config.providerConcurrency,
      );
      const cost = new PlaytestCostManager(
        Math.min(manifest.config.maxCostUsd, manifest.packageSnapshot.limits.maxCostUsd),
        await allRecordedCost(runDir),
      );
      const startedAt = Date.now();
      const durationLimit = Math.min(
        manifest.config.maxDurationMs ?? Number.MAX_SAFE_INTEGER,
        manifest.packageSnapshot.limits.maxDurationMs,
      );
      const activeDurationBefore = manifest.activeDurationMs;
      const deadlineAt = startedAt + Math.max(0, durationLimit - activeDurationBefore);
      for (const job of manifest.jobs) {
        if (job.status !== "awaiting_judgment" && job.judge?.policy === "none") continue;
        if (Date.now() >= deadlineAt) break;
        await this.runJudgments(manifest, job, runDir, scheduler, cost, true, profiles, deadlineAt);
        this.updateActiveDuration(manifest, activeDurationBefore, startedAt, durationLimit);
        await this.persistManifest(runDir, manifest);
      }
      this.updateActiveDuration(manifest, activeDurationBefore, startedAt, durationLimit);
      this.finishManifest(manifest, cost.spentUsd);
      await this.persistManifest(runDir, manifest);
      const reportPath = await generatePlaytestReport(runDir);
      return { manifest, runDir, reportPath };
    });
  }

  private async withRunLock<T>(runId: string, operation: () => Promise<T>): Promise<T> {
    const runDir = path.join(this.playtestsRoot, "runs", runId);
    const release = await acquireFileLock(path.join(runDir, ".run.lock"), `Playtest run ${runId}`);
    try {
      return await operation();
    } finally {
      await release();
    }
  }

  private validateConfig(config: PlaytestRunConfig, playtestPackage: PlaytestPackage): void {
    configuredTurns(config, playtestPackage);
    const candidateKeys = config.candidates.map((candidate) => targetKey(candidate));
    if (new Set(candidateKeys).size !== candidateKeys.length) {
      throw new Error("Candidate provider/model/routes must be unique within one playtest run");
    }
    if (config.latencyMode === "canonical" && config.globalWorkerLimit !== 1) {
      throw new Error("Canonical speed evidence requires global concurrency 1");
    }
    if (playtestPackage.purpose === "tuning" && !config.tuningVariable) {
      throw new Error("tuning-v1 requires one declared tuning variable");
    }
    if (playtestPackage.purpose !== "tuning" && config.tuningVariable) {
      throw new Error("A tuning variable may be declared only for a tuning package");
    }
    if (playtestPackage.turnDriver.kind === "scripted" && config.player) {
      throw new Error("Scripted playtests do not use a player model");
    }
    if (playtestPackage.turnDriver.kind !== "scripted" && !config.player) {
      throw new Error(`${playtestPackage.id} requires one explicit fixed player model and profile`);
    }
    if (config.player && !playtestPackage.playerProfiles.includes(config.player.profile)) {
      throw new Error(`Player profile ${config.player.profile} is not available in ${playtestPackage.id}`);
    }
    if (config.scenarioSeed && playtestPackage.startingState.kind !== "generated") {
      throw new Error(`--scenario-seed requires a package with a generated starting state; ${playtestPackage.id} uses a canonical one`);
    }
    if (playtestPackage.purpose === "certification" && config.judge.policy !== "final") {
      throw new Error("certification-v1 requires one separate final judge call");
    }
    if (playtestPackage.purpose === "certification" && config.repetitions !== 1) {
      throw new Error("certification-v1 requires exactly one authoritative repetition per candidate and language");
    }
    if (config.judge.policy !== playtestPackage.judgePolicy.kind) {
      throw new Error(
        `${playtestPackage.id} requires ${playtestPackage.judgePolicy.kind} judging`,
      );
    }
    if (playtestPackage.judgePolicy.kind !== "none"
      && config.judge.rubricVersion !== playtestPackage.judgePolicy.rubricVersion) {
      throw new Error(`Judge rubric must remain fixed at v${playtestPackage.judgePolicy.rubricVersion} for ${playtestPackage.id}`);
    }
    if (config.player) {
      for (const candidate of config.candidates) {
        if (sameUnderlyingModel(candidate, config.player.target)) {
          throw new Error("The fixed player model must be separate from the candidate model");
        }
      }
    }
  }

  private async preflightProfiles(
    config: PlaytestRunConfig,
  ): Promise<Map<string, FrozenModelExecutionProfile>> {
    const targets = [
      ...config.candidates,
      ...(config.player ? [config.player.target] : []),
      ...(config.judge.target ? [config.judge.target] : []),
    ];
    const unique = new Map(targets.map((target) => [targetKey(target), target]));
    const profiles = new Map<string, FrozenModelExecutionProfile>();
    for (const target of unique.values()) {
      const profile = await this.requireProfile(target);
      for (const language of config.languages) {
        await this.dependencies.preflightTarget?.(target, language);
      }
      profiles.set(targetKey(target), profile);
    }
    return profiles;
  }

  private profileFromSnapshots(
    target: PlaytestModelTarget,
    profiles: ReadonlyMap<string, FrozenModelExecutionProfile>,
  ): FrozenModelExecutionProfile {
    const profile = profiles.get(targetKey(target));
    if (!profile || profile.fingerprint !== target.executionProfileFingerprint) {
      throw new Error(
        `Saved playtest execution profile is unavailable for ${target.config.provider}/${target.config.model} via ${target.route}`,
      );
    }
    return profile;
  }

  private async loadProfileSnapshots(
    runDir: string,
    config: PlaytestRunConfig,
  ): Promise<Map<string, FrozenModelExecutionProfile>> {
    const target = path.join(runDir, "execution-profiles.json");
    let saved: ExecutionProfileSnapshots;
    try {
      saved = ExecutionProfileSnapshotsSchema.parse(JSON.parse(await readFile(target, "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const current = await this.preflightProfiles(config);
      saved = ExecutionProfileSnapshotsSchema.parse({
        schemaVersion: 1,
        profiles: [...current.values()],
      });
      await atomicWriteJson(target, saved);
    }
    const profiles = new Map(saved.profiles.map((profile) => [
      `${profile.key.provider}\u0000${profile.key.model}\u0000${profile.key.route}`,
      profile,
    ]));
    const targets = [
      ...config.candidates,
      ...(config.player ? [config.player.target] : []),
      ...(config.judge.target ? [config.judge.target] : []),
    ];
    for (const playtestTarget of targets) this.profileFromSnapshots(playtestTarget, profiles);
    return profiles;
  }

  private async requireProfile(target: PlaytestModelTarget): Promise<FrozenModelExecutionProfile> {
    const profile = await this.dependencies.profileFor(target);
    if (!profile.frozen || profile.fingerprint !== target.executionProfileFingerprint) {
      throw new Error(`Playtest target ${target.config.provider}/${target.config.model} does not match its frozen execution profile fingerprint`);
    }
    if (targetKey(target) !== targetKey({
      config: { ...target.config, provider: profile.key.provider, model: profile.key.model },
      route: profile.key.route,
      executionProfileFingerprint: profile.fingerprint,
    })) {
      throw new Error("Frozen execution profile targets a different provider/model/route");
    }
    return profile;
  }

  private async runLocked(
    runId: string,
    config: PlaytestRunConfig,
    playtestPackage: PlaytestPackage,
    profiles: ReadonlyMap<string, FrozenModelExecutionProfile>,
  ): Promise<PlaytestRunResult> {
    const runDir = path.join(this.playtestsRoot, "runs", runId);
    await mkdir(runDir, { recursive: true });
    const profileSnapshotPath = path.join(runDir, "execution-profiles.json");
    const savedProfiles = await readOptionalText(profileSnapshotPath);
    const profileSnapshot = ExecutionProfileSnapshotsSchema.parse({
      schemaVersion: 1,
      profiles: [...profiles.values()],
    });
    if (savedProfiles === undefined) {
      await atomicWriteJson(profileSnapshotPath, profileSnapshot);
    } else if (JSON.stringify(ExecutionProfileSnapshotsSchema.parse(JSON.parse(savedProfiles)))
      !== JSON.stringify(profileSnapshot)) {
      throw new Error("Resume execution profile snapshots do not match the saved playtest run");
    }
    const manifestPath = path.join(runDir, "manifest.json");
    const existing = await readOptionalPlaytestManifest(manifestPath);
    const now = this.now().toISOString();
    const manifest: PlaytestManifest = existing ?? PlaytestManifestSchema.parse({
      schemaVersion: 2,
      kind: "playtest",
      engineVersion: PLAYTEST_ENGINE_VERSION,
      runId,
      startedAt: now,
      updatedAt: now,
      status: "running",
      codeVersion: playtestCodeVersion(this.projectRoot),
      config,
      packageSnapshot: playtestPackage,
      packageHash: hashPlaytestValue(playtestPackage),
      totalEstimatedCostUsd: 0,
      jobs: this.jobsFor(config, playtestPackage),
    });
    if (JSON.stringify(manifest.config) !== JSON.stringify(config)
      || manifest.packageHash !== hashPlaytestValue(playtestPackage)) {
      throw new Error("Resume configuration or package snapshot does not match the saved playtest run");
    }
    for (const job of manifest.jobs) {
      if (job.status === "running" || job.status === "cancelled") {
        job.status = "pending";
        delete job.stopReason;
        delete job.failureOwner;
        delete job.error;
      }
    }
    manifest.status = "running";
    delete manifest.completedAt;
    await this.persistManifest(runDir, manifest);

    const historicalCost = await allRecordedCost(runDir);
    const cost = new PlaytestCostManager(
      Math.min(config.maxCostUsd, playtestPackage.limits.maxCostUsd),
      historicalCost,
    );
    const scheduler = new PlaytestProviderScheduler(config.globalWorkerLimit, config.providerConcurrency);
    // Resume downtime does not consume the active execution-time ceiling.
    const startedAt = Date.now();
    const durationLimit = Math.min(
      config.maxDurationMs ?? Number.MAX_SAFE_INTEGER,
      playtestPackage.limits.maxDurationMs,
    );
    const activeDurationBefore = manifest.activeDurationMs;
    const deadlineAt = startedAt + Math.max(0, durationLimit - activeDurationBefore);
    const queue = manifest.jobs.filter((job) => job.status === "pending");
    let cursor = 0;
    const worker = async (): Promise<void> => {
      for (;;) {
        const job = queue[cursor];
        cursor += 1;
        if (!job || this.controller.signal.aborted) return;
        if (Date.now() >= deadlineAt) {
          job.status = "inconclusive";
          job.stopReason = "duration_limit";
          job.failureOwner = "inconclusive";
          continue;
        }
        try {
          await this.runJob(manifest, job, runDir, scheduler, cost, deadlineAt, profiles);
        } catch (error) {
          await this.markUnexpectedJobFailure(manifest, job, runDir, error);
        }
        this.updateActiveDuration(manifest, activeDurationBefore, startedAt, durationLimit);
        manifest.totalEstimatedCostUsd = cost.spentUsd;
        manifest.updatedAt = this.now().toISOString();
        await this.persistManifest(runDir, manifest);
      }
    };
    const workerResults = await Promise.allSettled(Array.from(
      { length: Math.min(config.globalWorkerLimit, Math.max(queue.length, 1)) },
      () => worker(),
    ));
    const workerRejection = workerResults.find((result) => result.status === "rejected");
    if (workerRejection?.status === "rejected") throw workerRejection.reason;

    if (!this.controller.signal.aborted && cost.canCall() && Date.now() < deadlineAt) {
      const judgmentJobs = manifest.jobs.filter((job) => job.status === "awaiting_judgment");
      let judgmentCursor = 0;
      const judgeWorker = async (): Promise<void> => {
        for (;;) {
          const job = judgmentJobs[judgmentCursor];
          judgmentCursor += 1;
          if (!job || this.controller.signal.aborted) return;
          try {
            await this.runJudgments(manifest, job, runDir, scheduler, cost, false, profiles, deadlineAt);
          } catch (error) {
            await this.markUnexpectedJudgmentFailure(manifest, job, runDir, error);
          }
          this.updateActiveDuration(manifest, activeDurationBefore, startedAt, durationLimit);
          manifest.totalEstimatedCostUsd = cost.spentUsd;
          manifest.updatedAt = this.now().toISOString();
          await this.persistManifest(runDir, manifest);
        }
      };
      const judgeResults = await Promise.allSettled(Array.from(
        { length: Math.min(config.globalWorkerLimit, Math.max(judgmentJobs.length, 1)) },
        () => judgeWorker(),
      ));
      const judgeRejection = judgeResults.find((result) => result.status === "rejected");
      if (judgeRejection?.status === "rejected") throw judgeRejection.reason;
    }

    this.updateActiveDuration(manifest, activeDurationBefore, startedAt, durationLimit);
    this.finishManifest(manifest, cost.spentUsd);
    await this.persistManifest(runDir, manifest);
    const reportPath = await generatePlaytestReport(runDir);
    return { manifest, runDir, reportPath };
  }

  private jobsFor(config: PlaytestRunConfig, playtestPackage: PlaytestPackage): PlaytestJob[] {
    const jobs: PlaytestJob[] = [];
    for (const candidate of config.candidates) {
      for (const language of config.languages) {
        for (let repetition = 1; repetition <= config.repetitions; repetition += 1) {
          jobs.push({
            id: jobId(jobs.length),
            package: { id: playtestPackage.id, version: playtestPackage.version },
            candidate,
            language,
            repetition,
            latencyMode: config.latencyMode,
            status: "pending",
            completedTurns: 0,
            ...(config.player ? { player: config.player } : {}),
            judge: config.judge,
            qualityStatus: playtestPackage.purpose === "certification" ? "awaiting_judgment" : "unrated",
          });
        }
      }
    }
    return jobs;
  }

  private async markUnexpectedJobFailure(
    manifest: PlaytestManifest,
    job: PlaytestJob,
    runDir: string,
    error: unknown,
  ): Promise<void> {
    const attribution = attributePlaytestFailure(error, {
      lane: "candidate",
      stage: nodeApplicationError(error) ? "application" : "provider_call",
    });
    job.status = attribution.owner === "candidate_model" ? "failed" : "inconclusive";
    job.stopReason = "error";
    job.failureOwner = attribution.owner;
    job.error = (error instanceof Error ? error.message : String(error)).slice(0, 2_000);
    job.qualityStatus = manifest.packageSnapshot.purpose === "certification"
      ? "awaiting_judgment"
      : "unrated";
    const coverage = assessCoverage(manifest.packageSnapshot, []);
    const technical = buildCandidateTechnicalSnapshot({
      playtestPackage: manifest.packageSnapshot,
      adapterStatus: "calibrated",
      executionProfileCurrent: true,
      turns: [],
      calls: [],
      coverage,
      evidenceComplete: false,
    });
    job.technicalStatus = technical.status;
    const jobDir = path.join(runDir, "jobs", job.id);
    await mkdir(jobDir, { recursive: true });
    await atomicWriteJson(path.join(jobDir, "coverage.json"), coverage);
    await atomicWriteJson(path.join(jobDir, "mechanical-audit.json"), buildMechanicalAudit([]));
    await atomicWriteJson(path.join(jobDir, "technical.json"), technical);
    await this.recordCertificationIfCurrent(manifest, job, technical);
  }

  private async markUnexpectedJudgmentFailure(
    manifest: PlaytestManifest,
    job: PlaytestJob,
    runDir: string,
    error: unknown,
  ): Promise<void> {
    const jobDir = path.join(runDir, "jobs", job.id);
    const tasksPath = path.join(jobDir, "judge-tasks.json");
    const message = (error instanceof Error ? error.message : String(error)).slice(0, 2_000);
    try {
      const tasks = JudgeTasksSchema.parse(JSON.parse(await readFile(tasksPath, "utf8")));
      for (const task of tasks) {
        if (task.status === "running") {
          task.status = "failed";
          task.error = message;
        }
      }
      await atomicWriteJson(tasksPath, tasks);
    } catch (taskError) {
      if ((taskError as NodeJS.ErrnoException).code !== "ENOENT") throw taskError;
    }
    job.status = "awaiting_judgment";
    job.qualityStatus = manifest.packageSnapshot.purpose === "certification"
      ? "awaiting_judgment"
      : "unrated";
    job.failureOwner = "judge";
    job.error = message;
    CandidateTechnicalSnapshotSchema.parse(JSON.parse(
      await readFile(path.join(jobDir, "technical.json"), "utf8"),
    ));
  }

  private async runJob(
    manifest: PlaytestManifest,
    job: PlaytestJob,
    runDir: string,
    scheduler: PlaytestProviderScheduler,
    cost: PlaytestCostManager,
    deadlineAt: number,
    profiles: ReadonlyMap<string, FrozenModelExecutionProfile>,
  ): Promise<void> {
    const playtestPackage = manifest.packageSnapshot;
    const totalTurns = configuredTurns(manifest.config, playtestPackage);
    const jobDir = path.join(runDir, "jobs", job.id);
    const candidateCallsPath = path.join(jobDir, "calls", "candidate.jsonl");
    const playerCallsPath = path.join(jobDir, "calls", "player-driver.jsonl");
    const turnsPath = path.join(jobDir, "turns.jsonl");
    const progressPath = path.join(jobDir, "prepared-turn.json");
    const continuationStatePath = path.join(jobDir, "terminal-continuation.json");
    const openingPath = path.join(jobDir, "opening.txt");
    await mkdir(jobDir, { recursive: true });
    job.status = "running";
    this.progress(manifest, job, "setup", totalTurns, "Preparing isolated campaign");

    const profile = this.profileFromSnapshots(job.candidate, profiles);
    const baseCandidate = this.dependencies.providerFor(job.candidate, profile);
    const candidatePriorCalls = await callsAt(candidateCallsPath);
    const playerPriorCalls = await callsAt(playerCallsPath);
    let activeCallFloor = {
      candidate: candidatePriorCalls.length,
      player: playerPriorCalls.length,
    };
    const candidate = new PlaytestTelemetryProvider({
      actor: "candidate",
      lane: "candidate",
      jobId: job.id,
      route: job.candidate.route,
      profile,
      base: baseCandidate,
      price: (this.dependencies.costFor ?? defaultCost)(job.candidate),
      costManager: cost,
      scheduler,
      callsPath: candidateCallsPath,
      diagnosticsDir: path.join(jobDir, "diagnostics"),
      signal: this.controller.signal,
      secrets: this.dependencies.secrets,
      initialSequence: candidatePriorCalls.length,
      deadlineAt,
    });

    let continuationState = await readTerminalContinuationState(continuationStatePath);
    let fixtureId = continuationState?.fixtureId ?? "primary";
    let gameRoot = continuationState
      ? path.join(jobDir, "fixtures", continuationState.fixtureId, "campaign")
      : path.join(jobDir, "campaign");
    let store = new StateStore(gameRoot);
    let assignedRoll = 1;
    let engine = new DungeonEngine(store, candidate, () => assignedRoll);
    let opening = "";
    let evidenceComplete = true;
    let terminalOwner: FailureOwner | undefined;
    try {
      if (continuationState) {
        const continuation = playtestPackage.terminalContinuation;
        if (!continuation || continuation.afterTurn !== continuationState.afterTurn) {
          throw new Error("Persisted terminal continuation no longer matches the frozen package");
        }
        const setup = continuation.startingState.setups[job.language];
        const worldRules = continuation.startingState.worldRules[job.language];
        if (!setup || !worldRules) throw new Error(`Terminal continuation has no ${job.language} fixture`);
        opening = continuationState.openingNarration;
        if (!(await engine.hasCurrentGame())) {
          await engine.createGame({ setup, worldRules, language: job.language });
        }
        const warmupTurnsPath = path.join(jobDir, "fixtures", fixtureId, "warmup-turns.jsonl");
        const warmupRecords = PlaytestTurnRecordSchema.array().parse(await readPlaytestJsonLines(warmupTurnsPath));
        for (let warmupTurn = warmupRecords.length + 1; warmupTurn <= continuation.afterTurn; warmupTurn += 1) {
          const loadedWarmup = await store.load();
          if (loadedWarmup.manifest.status !== "active") {
            continuationState.status = "terminal";
            await atomicWriteJson(continuationStatePath, TerminalContinuationStateSchema.parse(continuationState));
            break;
          }
          const action = continuation.warmupActions[warmupTurn - 1]?.[job.language];
          if (!action) throw new Error(`Terminal continuation warmup ${warmupTurn} has no ${job.language} action`);
          assignedRoll = playtestPackage.scriptedTurns?.[warmupTurn - 1]?.naturalRoll ?? 50;
          const observation = await store.buildContextObservation();
          if (loadedWarmup.manifest.turn >= warmupTurn) {
            const recovered = await this.reconstructCommittedTurn(store, PreparedTurnSchema.parse({
              schemaVersion: 1,
              turn: warmupTurn,
              fixtureId,
              action,
              driver: "scripted",
              expectedCheckPolicy: "context_dependent",
              assignedNaturalRoll: assignedRoll,
              contextObservation: observation,
              preparedAt: this.now().toISOString(),
            }), 0);
            warmupRecords.push(recovered);
            await appendPlaytestJsonLine(warmupTurnsPath, recovered);
            continue;
          }
          candidate.setPreCallStateSnapshot(await store.buildCanonicalStateContext());
          const started = Date.now();
          const pending = await engine.getPendingTurn();
          const result = pending
            ? await engine.resumePendingTurn()
            : await this.turnScheduler.run(job.id, () => engine.play(action));
          const record = PlaytestTurnRecordSchema.parse({
            turn: result.turn,
            fixtureId,
            action,
            narration: result.narration,
            summary: result.summary,
            playerVisibleDurationMs: Date.now() - started,
            driver: "scripted",
            expectedCheckPolicy: "context_dependent",
            assignedNaturalRoll: assignedRoll,
            ...(result.check ? { check: result.check } : {}),
            operations: result.operations,
            status: "completed",
            invariantStatus: "passed",
            contextObservation: observation,
          });
          warmupRecords.push(record);
          await appendPlaytestJsonLine(warmupTurnsPath, record);
          if (result.state.status !== "active") {
            continuationState.status = "terminal";
            await atomicWriteJson(continuationStatePath, TerminalContinuationStateSchema.parse(continuationState));
            break;
          }
        }
        if (continuationState.status !== "terminal") {
          continuationState.status = "active";
          await atomicWriteJson(continuationStatePath, TerminalContinuationStateSchema.parse(continuationState));
        }
      } else if (!(await engine.hasCurrentGame())) {
        const seed = manifest.config.scenarioSeed
          ? await loadScenarioSeed(this.projectRoot, manifest.config.scenarioSeed, job.language)
          : undefined;
        const worldRules = playtestPackage.startingState.kind === "canonical"
          ? playtestPackage.startingState.worldRules[job.language]
          : (seed?.worldRules ?? await this.worldRules(job.language));
        if (!worldRules) throw new Error(`Playtest package has no ${job.language} world rules`);
        if (playtestPackage.startingState.kind === "canonical") {
          const setup = playtestPackage.startingState.setups[job.language];
          if (!setup) throw new Error(`Canonical package has no ${job.language} setup`);
          opening = setup.openingNarration;
          await engine.createGame({ setup, worldRules, language: job.language });
        } else {
          const premise = seed?.premise ?? playtestPackage.startingState.premise[job.language];
          const baseCharacter = seed?.character ?? playtestPackage.startingState.character[job.language];
          if (!premise || !baseCharacter) throw new Error(`Generated package has no ${job.language} setup text`);
          const selectedProfile = job.player?.profile
            ? PLAYER_PROFILES.find((item) => item.id === job.player?.profile)
            : undefined;
          candidate.setPreCallStateSnapshot(JSON.stringify({ premise, character: baseCharacter, language: job.language }));
          const generated = await engine.generateSetupWithMetadata({
            worldRules,
            premise,
            character: selectedProfile ? `${baseCharacter}\nPlayer behavior: ${selectedProfile.instruction}` : baseCharacter,
            language: job.language,
          });
          opening = generated.setup.openingNarration;
          await engine.createGame({
            setup: generated.setup,
            openingGeneration: generated.generation,
            worldRules,
            language: job.language,
            setupInput: { premise, character: baseCharacter },
          });
        }
      } else {
        opening = (await engine.campaignLogSnapshot()).turns.find((turn) => turn.turn === 0)?.narration ?? "Opening unavailable";
      }
      const persistedOpening = await readOptionalText(openingPath);
      if (persistedOpening) opening = persistedOpening;
      else await atomicWriteText(openingPath, opening);
      if (!(await readOptionalText(stateFile(jobDir, 0)))) {
        await atomicWriteText(stateFile(jobDir, 0), await store.buildCanonicalStateContext());
      }

      const turnRecords = PlaytestTurnRecordSchema.array().parse(await readPlaytestJsonLines(turnsPath));
      const priorFailure = turnRecords.findLast((turn) => turn.status === "failed");
      if (priorFailure) {
        terminalOwner = priorFailure.failureOwner ?? "inconclusive";
        evidenceComplete = terminalOwner === "candidate_model";
        job.status = terminalOwner === "candidate_model" ? "failed" : "inconclusive";
        job.stopReason = "error";
        job.failureOwner = terminalOwner;
        job.error = priorFailure.error ?? "A previously recorded turn failure ended this job";
      }
      const recoveredPrepared = await readPreparedTurn(progressPath);
      const preparedConsumesSeededRoll = playtestPackage.rollPolicy.kind !== "scripted"
        && recoveredPrepared?.turn === turnRecords.length + 1;
      const randomRoll = this.rollForJob(
        manifest,
        job,
        playtestPackage,
        turnRecords.length + (preparedConsumesSeededRoll ? 1 : 0),
      );
      for (let turn = turnRecords.length + 1; !priorFailure && turn <= totalTurns; turn += 1) {
        if (this.controller.signal.aborted) throw new Error("Playtest operation cancelled");
        if (Date.now() >= deadlineAt) throw new PlaytestDurationLimitError();
        if (!cost.canCall()) throw new PlaytestCostLimitError();
        const failedCalls = (await callsAt(candidateCallsPath)).filter((call) => !call.success).length;
        if (failedCalls > playtestPackage.limits.maxFailures) {
          throw new Error("Playtest package candidate failure limit reached");
        }
        activeCallFloor = {
          candidate: (await callsAt(candidateCallsPath)).length,
          player: (await callsAt(playerCallsPath)).length,
        };
        const loadedBefore = await store.load();
        if (loadedBefore.manifest.status !== "active") {
          job.stopReason = "legitimate_terminal";
          break;
        }
        const contextObservation = await store.buildContextObservation();
        const existingPrepared = await readPreparedTurn(progressPath);
        let prepared: PreparedTurn;
        if (existingPrepared?.turn === turn) {
          prepared = existingPrepared;
        } else {
          assignedRoll = this.assignedRoll(playtestPackage, turn, randomRoll);
          prepared = await this.prepareTurn(
            job,
            playtestPackage,
            turn,
            turnRecords,
            loadedBefore,
            contextObservation,
            store,
            scheduler,
            cost,
            playerCallsPath,
            assignedRoll,
            fixtureId,
            profiles,
            deadlineAt,
          );
          await atomicWriteJson(progressPath, prepared);
        }
        assignedRoll = prepared.assignedNaturalRoll;
        if (loadedBefore.manifest.turn === prepared.turn) {
          const recovered = await this.reconstructCommittedTurn(store, prepared, 0);
          turnRecords.push(recovered);
          await appendPlaytestJsonLine(turnsPath, recovered);
          await this.afterTurn(job, jobDir, opening, turnRecords, store, manifest, totalTurns);
          continue;
        }
        if (loadedBefore.manifest.turn > prepared.turn) {
          throw new Error(`Campaign advanced to turn ${loadedBefore.manifest.turn} beyond prepared turn ${prepared.turn}`);
        }
        candidate.setPreCallStateSnapshot(await store.buildCanonicalStateContext());
        this.progress(manifest, job, "playing", totalTurns, `Submitting turn ${turn}`);
        const visibleStarted = Date.now();
        let result: TurnResult;
        const pending = await engine.getPendingTurn();
        if (pending?.kind === "commit") {
          await engine.recoverPendingCommit();
          const recovered = await this.reconstructCommittedTurn(store, prepared, Date.now() - visibleStarted);
          turnRecords.push(recovered);
          await appendPlaytestJsonLine(turnsPath, recovered);
          await this.afterTurn(job, jobDir, opening, turnRecords, store, manifest, totalTurns);
          continue;
        }
        if (pending) result = await engine.resumePendingTurn();
        else {
          result = await this.turnScheduler.run(job.id, () => engine.play(prepared.action));
        }
        const record = await this.completedTurnRecord(prepared, result, Date.now() - visibleStarted, store);
        turnRecords.push(record);
        await appendPlaytestJsonLine(turnsPath, record);
        await this.afterTurn(job, jobDir, opening, turnRecords, store, manifest, totalTurns);
        if (result.state.status !== "active") {
          job.stopReason = "legitimate_terminal";
          const continuation = playtestPackage.terminalContinuation;
          if (!continuationState && continuation?.afterTurn === turn && turn < totalTurns) {
            const setup = continuation.startingState.setups[job.language];
            const worldRules = continuation.startingState.worldRules[job.language];
            if (!setup || !worldRules) throw new Error(`Terminal continuation has no ${job.language} fixture`);
            fixtureId = `coverage-after-${String(turn).padStart(3, "0")}`;
            continuationState = TerminalContinuationStateSchema.parse({
              schemaVersion: 1,
              fixtureId,
              afterTurn: turn,
              priorCampaignStatus: result.state.status,
              status: "preparing",
              openingNarration: setup.openingNarration,
            });
            await atomicWriteJson(continuationStatePath, continuationState);
            gameRoot = path.join(jobDir, "fixtures", fixtureId, "campaign");
            store = new StateStore(gameRoot);
            engine = new DungeonEngine(store, candidate, () => assignedRoll);
            await engine.createGame({ setup, worldRules, language: job.language });
            const warmupTurnsPath = path.join(jobDir, "fixtures", fixtureId, "warmup-turns.jsonl");
            const warmupRecords: PlaytestTurnRecord[] = [];
            for (let warmupTurn = 1; warmupTurn <= continuation.afterTurn; warmupTurn += 1) {
              const action = continuation.warmupActions[warmupTurn - 1]?.[job.language];
              if (!action) throw new Error(`Terminal continuation warmup ${warmupTurn} has no ${job.language} action`);
              assignedRoll = playtestPackage.scriptedTurns?.[warmupTurn - 1]?.naturalRoll ?? 50;
              const observation = await store.buildContextObservation();
              candidate.setPreCallStateSnapshot(await store.buildCanonicalStateContext());
              const started = Date.now();
              const warmupResult = await this.turnScheduler.run(job.id, () => engine.play(action));
              const warmupRecord = PlaytestTurnRecordSchema.parse({
                turn: warmupResult.turn,
                fixtureId,
                action,
                narration: warmupResult.narration,
                summary: warmupResult.summary,
                playerVisibleDurationMs: Date.now() - started,
                driver: "scripted",
                expectedCheckPolicy: "context_dependent",
                assignedNaturalRoll: assignedRoll,
                ...(warmupResult.check ? { check: warmupResult.check } : {}),
                operations: warmupResult.operations,
                status: "completed",
                invariantStatus: "passed",
                contextObservation: observation,
              });
              warmupRecords.push(warmupRecord);
              await appendPlaytestJsonLine(warmupTurnsPath, warmupRecord);
              if (warmupResult.state.status !== "active") {
                continuationState.status = "terminal";
                break;
              }
            }
            await atomicWriteJson(continuationStatePath, TerminalContinuationStateSchema.parse({
              ...continuationState,
              status: continuationState.status === "terminal" ? "terminal" : "active",
            }));
            if (continuationState.status !== "terminal") {
              continuationState.status = "active";
              delete job.stopReason;
              continue;
            }
          }
          break;
        }
      }
      job.stopReason ??= "turn_limit";
    } catch (error) {
      if (isCancellation(error, this.controller.signal)) {
        job.status = "cancelled";
        job.stopReason = "cancelled";
        terminalOwner = "inconclusive";
        evidenceComplete = false;
      } else if (error instanceof PlaytestCostLimitError) {
        job.status = "inconclusive";
        job.stopReason = "cost_limit";
        terminalOwner = "inconclusive";
        evidenceComplete = false;
      } else if (error instanceof PlaytestDurationLimitError) {
        job.status = "inconclusive";
        job.stopReason = "duration_limit";
        terminalOwner = "inconclusive";
        evidenceComplete = false;
      } else {
        const newCandidateCalls = (await callsAt(candidateCallsPath)).slice(activeCallFloor.candidate);
        const newPlayerCalls = (await callsAt(playerCallsPath)).slice(activeCallFloor.player);
        const lastCall = [...newCandidateCalls, ...newPlayerCalls]
          .sort((left, right) => left.timestamp.localeCompare(right.timestamp)).at(-1);
        terminalOwner = (!lastCall?.success ? lastCall?.failureOwner : undefined)
          ?? (error instanceof TransactionValidationError
            ? "candidate_model"
            : attributePlaytestFailure(error, {
              lane: "candidate",
              stage: nodeApplicationError(error) ? "application" : "domain_validation",
            }).owner);
        evidenceComplete = terminalOwner === "candidate_model";
        job.status = terminalOwner === "candidate_model" ? "failed" : "inconclusive";
        job.stopReason = "error";
        job.error = (error instanceof Error ? error.message : String(error)).slice(0, 2_000);
        job.failureOwner = terminalOwner;
        const prepared = await readPreparedTurn(progressPath);
        if (prepared) {
          const failedTurn = PlaytestTurnRecordSchema.parse({
            turn: prepared.turn,
            ...(prepared.fixtureId ? { fixtureId: prepared.fixtureId } : {}),
            ...(prepared.scriptedTurnId ? { scriptedTurnId: prepared.scriptedTurnId } : {}),
            action: prepared.action,
            driver: prepared.driver,
            ...(prepared.profile ? { profile: prepared.profile } : {}),
            expectedCheckPolicy: prepared.expectedCheckPolicy,
            assignedNaturalRoll: prepared.assignedNaturalRoll,
            operations: [],
            status: "failed",
            invariantStatus: "not_checked",
            failureOwner: terminalOwner,
            error: job.error,
            contextObservation: prepared.contextObservation,
          });
          const existingTurns = await readPlaytestJsonLines<PlaytestTurnRecord>(turnsPath);
          if (!existingTurns.some((turn) => turn.turn === failedTurn.turn)) {
            await appendPlaytestJsonLine(turnsPath, failedTurn);
          }
        }
      }
    }

    const turns = PlaytestTurnRecordSchema.array().parse(await readPlaytestJsonLines(turnsPath));
    const calls = [
      ...await callsAt(candidateCallsPath),
      ...await callsAt(playerCallsPath),
    ];
    const legitimateTerminal = job.stopReason === "legitimate_terminal";
    const coverage = assessCoverage(playtestPackage, turns, {
      ...(legitimateTerminal && turns.length > 0 ? { legitimateTerminalTurn: turns.at(-1)!.turn } : {}),
    });
    await atomicWriteJson(path.join(jobDir, "coverage.json"), coverage);
    await atomicWriteJson(path.join(jobDir, "mechanical-audit.json"), buildMechanicalAudit(turns));
    const technical = buildCandidateTechnicalSnapshot({
      playtestPackage,
      adapterStatus: "calibrated",
      executionProfileCurrent: profile.fingerprint === job.candidate.executionProfileFingerprint,
      turns,
      calls,
      coverage,
      evidenceComplete,
      legitimateTerminal,
    });
    await atomicWriteJson(path.join(jobDir, "technical.json"), technical);
    job.technicalStatus = technical.status;
    job.completedTurns = turns.filter((turn) => turn.status === "completed").length;
    if (playtestPackage.purpose === "certification") {
      job.qualityStatus = "awaiting_judgment";
      await this.recordCertificationIfCurrent(manifest, job, technical);
    }
    this.progress(manifest, job, "assessing", totalTurns, `Technical status frozen: ${technical.status}`);

    const gameplayFinished = job.stopReason === "turn_limit"
      || job.stopReason === "legitimate_terminal"
      || job.stopReason === "campaign_ended";
    if (gameplayFinished && manifest.config.judge.policy !== "none") {
      await this.ensureJudgeTasks(jobDir, manifest.config, job.completedTurns);
      job.status = "awaiting_judgment";
      if (playtestPackage.purpose === "certification") job.qualityStatus = "awaiting_judgment";
    } else if (gameplayFinished) {
      job.status = "completed";
      job.qualityStatus = "unrated";
    }
    if (terminalOwner && !job.failureOwner) job.failureOwner = terminalOwner;
  }

  private rollForJob(
    manifest: PlaytestManifest,
    job: PlaytestJob,
    playtestPackage: PlaytestPackage,
    usedTurns: number,
  ): () => number {
    if (playtestPackage.rollPolicy.kind === "secure_random") {
      return rollPolicy({ kind: "secure_random" }, usedTurns);
    }
    if (playtestPackage.rollPolicy.kind === "seeded_random") {
      const baseSeed = manifest.config.seed
        ?? `${playtestPackage.rollPolicy.seedNamespace}:${manifest.runId}`;
      const seed = [
        baseSeed,
        job.id,
        job.language,
        job.repetition,
      ].join(":");
      return rollPolicy({ kind: "seeded_random", seed }, usedTurns);
    }
    return () => { throw new Error("Scripted turns use their declared per-turn roll"); };
  }

  private assignedRoll(playtestPackage: PlaytestPackage, turn: number, randomRoll: () => number): number {
    if (playtestPackage.rollPolicy.kind !== "scripted") return randomRoll();
    const scripted = playtestPackage.scriptedTurns?.find((candidate) => candidate.turn === turn);
    if (!scripted) throw new Error(`Scripted package is missing turn ${turn}`);
    return scripted.naturalRoll;
  }

  private async prepareTurn(
    job: PlaytestJob,
    playtestPackage: PlaytestPackage,
    turn: number,
    turns: readonly PlaytestTurnRecord[],
    loaded: Awaited<ReturnType<StateStore["load"]>>,
    contextObservation: PreparedTurn["contextObservation"],
    store: StateStore,
    scheduler: PlaytestProviderScheduler,
    cost: PlaytestCostManager,
    callsPath: string,
    assignedNaturalRoll: number,
    fixtureId: string,
    profiles: ReadonlyMap<string, FrozenModelExecutionProfile>,
    deadlineAt: number,
  ): Promise<PreparedTurn> {
    let action: string;
    let driver: PreparedTurn["driver"];
    let scriptedTurnId: string | undefined;
    let expectedCheckPolicy: PreparedTurn["expectedCheckPolicy"] = "context_dependent";
    if (playtestPackage.turnDriver.kind === "scripted") {
      const scripted = playtestPackage.scriptedTurns?.find((candidate) => candidate.turn === turn);
      if (!scripted) throw new Error(`Scripted package is missing turn ${turn}`);
      const branch = scripted.branches.find((candidate) => actionBranchMatches(candidate, loaded, turns));
      action = branch?.action[job.language] ?? "";
      if (!action) throw new Error(`Scripted turn ${turn} has no applicable ${job.language} action`);
      driver = "scripted";
      scriptedTurnId = scripted.id;
      expectedCheckPolicy = scripted.checkPolicy;
    } else {
      const injection = playtestPackage.turnDriver.kind === "hybrid"
        && playtestPackage.turnDriver.injectMissingCoverageAtCheckpoints
        ? playtestPackage.checkpointInjections?.find((candidate) => {
          if (candidate.checkpointTurn !== turn) return false;
          const coverageById = new Map(
            assessCoverage(playtestPackage, turns).entries.map((entry) => [entry.requirementId, entry.status]),
          );
          return candidate.coverageRequirementIds.some((id) => coverageById.get(id) !== "passed");
        })
        : undefined;
      if (injection) {
        action = injection.action[job.language] ?? "";
        driver = "hybrid_injected";
      } else {
        if (!job.player) throw new Error("Model-driven playtest is missing its fixed player configuration");
        const profileDefinition = PLAYER_PROFILES.find((candidate) => candidate.id === job.player?.profile);
        if (!profileDefinition) throw new Error(`Unknown player profile ${job.player.profile}`);
        const playerProfile = this.profileFromSnapshots(job.player.target, profiles);
        const priorCalls = await callsAt(callsPath);
        const player = new PlaytestTelemetryProvider({
          actor: "player_driver",
          lane: "player_driver",
          jobId: job.id,
          route: job.player.target.route,
          profile: playerProfile,
          phase: "player_action",
          base: this.dependencies.providerFor(job.player.target, playerProfile),
          price: (this.dependencies.costFor ?? defaultCost)(job.player.target),
          costManager: cost,
          scheduler,
          callsPath,
          diagnosticsDir: path.join(path.dirname(path.dirname(callsPath)), "diagnostics"),
          signal: this.controller.signal,
          secrets: this.dependencies.secrets,
          initialSequence: priorCalls.length,
          deadlineAt,
        });
        player.setPreCallStateSnapshot(await store.buildPlayerContext());
        const generated = await generateStructured(player, {
          schemaName: "playtest_player_action_v1",
          schema: SimulatedPlayerActionSchema,
          system: playtestPlayerSystemPrompt(profileDefinition, job.language),
          prompt: playtestPlayerPrompt(await store.buildPlayerContext()),
          temperature: 0.9,
          maxOutputTokens: 1_500,
          outputTokenCeiling: 1_500,
          generationPhase: "decision",
        });
        action = generated.data.action;
        driver = playtestPackage.turnDriver.kind === "hybrid" ? "hybrid_model" : "model";
      }
    }
    return PreparedTurnSchema.parse({
      schemaVersion: 1,
      turn,
      fixtureId,
      action,
      ...(scriptedTurnId ? { scriptedTurnId } : {}),
      driver,
      ...(job.player ? { profile: job.player.profile } : {}),
      expectedCheckPolicy,
      assignedNaturalRoll,
      contextObservation,
      preparedAt: this.now().toISOString(),
    });
  }

  private async completedTurnRecord(
    prepared: PreparedTurn,
    result: TurnResult,
    playerVisibleDurationMs: number,
    store: StateStore,
  ): Promise<PlaytestTurnRecord> {
    await store.load();
    return PlaytestTurnRecordSchema.parse({
      turn: prepared.turn,
      ...(prepared.fixtureId ? { fixtureId: prepared.fixtureId } : {}),
      ...(prepared.scriptedTurnId ? { scriptedTurnId: prepared.scriptedTurnId } : {}),
      action: prepared.action,
      narration: result.narration,
      summary: result.summary,
      playerVisibleDurationMs,
      driver: prepared.driver,
      ...(prepared.profile ? { profile: prepared.profile } : {}),
      expectedCheckPolicy: prepared.expectedCheckPolicy,
      assignedNaturalRoll: prepared.assignedNaturalRoll,
      ...(result.check ? { check: result.check } : {}),
      operations: result.operations,
      status: "completed",
      invariantStatus: "passed",
      contextObservation: prepared.contextObservation,
    });
  }

  private async reconstructCommittedTurn(
    store: StateStore,
    prepared: PreparedTurn,
    durationMs: number,
  ): Promise<PlaytestTurnRecord> {
    const loaded = await store.load();
    if (loaded.manifest.turn !== prepared.turn) {
      throw new Error(`Recovered campaign is at turn ${loaded.manifest.turn}, expected ${prepared.turn}`);
    }
    const log = await readFile(
      path.join(store.currentDir, "turns", `${String(prepared.turn).padStart(6, "0")}.md`),
      "utf8",
    );
    const visible = parsePlayerVisibleTurn(log, loaded.manifest.language);
    return PlaytestTurnRecordSchema.parse({
      turn: prepared.turn,
      ...(prepared.fixtureId ? { fixtureId: prepared.fixtureId } : {}),
      ...(prepared.scriptedTurnId ? { scriptedTurnId: prepared.scriptedTurnId } : {}),
      action: visible.action,
      narration: visible.narration,
      summary: visible.summary,
      playerVisibleDurationMs: durationMs,
      driver: prepared.driver,
      ...(prepared.profile ? { profile: prepared.profile } : {}),
      expectedCheckPolicy: prepared.expectedCheckPolicy,
      assignedNaturalRoll: prepared.assignedNaturalRoll,
      ...(parseTurnCheck(log) ? { check: parseTurnCheck(log) } : {}),
      operations: parseTurnOperations(log),
      status: "completed",
      invariantStatus: "passed",
      contextObservation: prepared.contextObservation,
    });
  }

  private async afterTurn(
    job: PlaytestJob,
    jobDir: string,
    opening: string,
    turns: readonly PlaytestTurnRecord[],
    store: StateStore,
    manifest: PlaytestManifest,
    totalTurns: number,
  ): Promise<void> {
    const latest = turns.at(-1)!;
    job.completedTurns = turns.filter((turn) => turn.status === "completed").length;
    await atomicWriteText(stateFile(jobDir, latest.turn), await store.buildCanonicalStateContext());
    await atomicWriteText(path.join(jobDir, "transcript.md"), transcriptText(opening, turns));
    this.progress(manifest, job, "playing", totalTurns, `Committed turn ${latest.turn}`);
  }

  private async ensureJudgeTasks(jobDir: string, config: PlaytestRunConfig, completedTurns: number): Promise<void> {
    const target = path.join(jobDir, "judge-tasks.json");
    let tasks: JudgeTask[] = [];
    try {
      tasks = JudgeTasksSchema.parse(JSON.parse(await readFile(target, "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (tasks.length === 0) {
      if (config.judge.policy === "checkpoints_and_final") {
        const every = config.judge.checkpointEvery!;
        for (let throughTurn = every; throughTurn <= completedTurns; throughTurn += every) {
          tasks.push({
            id: `checkpoint-${String(throughTurn).padStart(3, "0")}`,
            kind: "checkpoint",
            fromTurn: Math.max(1, throughTurn - every + 1),
            throughTurn,
            status: "pending",
            attempts: 0,
          });
        }
      }
      if (config.judge.policy !== "none" && completedTurns > 0) {
        tasks.push({ id: "final", kind: "final", fromTurn: 1, throughTurn: completedTurns, status: "pending", attempts: 0 });
      }
      await atomicWriteJson(target, JudgeTasksSchema.parse(tasks));
    }
  }

  private async runJudgments(
    manifest: PlaytestManifest,
    job: PlaytestJob,
    runDir: string,
    scheduler: PlaytestProviderScheduler,
    cost: PlaytestCostManager,
    rerunFailures: boolean,
    profiles: ReadonlyMap<string, FrozenModelExecutionProfile>,
    deadlineAt: number,
  ): Promise<void> {
    if (job.judge?.policy === "none" || !job.judge?.target) return;
    const jobDir = path.join(runDir, "jobs", job.id);
    const tasksPath = path.join(jobDir, "judge-tasks.json");
    const allTurns = PlaytestTurnRecordSchema.array().parse(await readPlaytestJsonLines(path.join(jobDir, "turns.jsonl")));
    const completedTurns = allTurns.filter((turn) => turn.status === "completed").length;
    if (completedTurns > 0) {
      await this.ensureJudgeTasks(jobDir, manifest.config, completedTurns);
    }
    let tasks: JudgeTask[];
    try {
      tasks = JudgeTasksSchema.parse(JSON.parse(await readFile(tasksPath, "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    if (rerunFailures) {
      // Explicit judging retries only incomplete attempts from persisted evidence;
      // completed intervals remain immutable and gameplay is never replayed.
      for (const task of tasks) {
        if (task.status === "failed" || task.status === "running") task.status = "pending";
      }
    } else {
      for (const task of tasks) if (task.status === "running") task.status = "pending";
    }
    // Completed judgments may still need their assessment/catalog commit
    // reconciled after an interrupted or temporarily blocked atomic write.
    // Reuse the immutable judgment files without making another provider call.
    let technical = CandidateTechnicalSnapshotSchema.parse(JSON.parse(
      await readFile(path.join(jobDir, "technical.json"), "utf8"),
    ));
    const requiredTurns = configuredTurns(manifest.config, manifest.packageSnapshot);
    if (completedTurns >= requiredTurns
      && allTurns.every((turn) => turn.status === "completed")) {
      const coverage = assessCoverage(manifest.packageSnapshot, allTurns);
      const calls = [
        ...await callsAt(path.join(jobDir, "calls", "candidate.jsonl")),
        ...await callsAt(path.join(jobDir, "calls", "player-driver.jsonl")),
      ];
      const candidateProfile = this.profileFromSnapshots(job.candidate, profiles);
      technical = buildCandidateTechnicalSnapshot({
        playtestPackage: manifest.packageSnapshot,
        adapterStatus: "calibrated",
        executionProfileCurrent: candidateProfile.fingerprint === job.candidate.executionProfileFingerprint,
        turns: allTurns,
        calls,
        coverage,
        evidenceComplete: true,
      });
      await atomicWriteJson(path.join(jobDir, "coverage.json"), coverage);
      await atomicWriteJson(path.join(jobDir, "mechanical-audit.json"), buildMechanicalAudit(allTurns));
      await atomicWriteJson(path.join(jobDir, "technical.json"), technical);
      job.technicalStatus = technical.status;
      job.completedTurns = completedTurns;
      job.stopReason = "turn_limit";
      job.status = "awaiting_judgment";
      delete job.failureOwner;
      delete job.error;
    }
    const judgeProfile = this.profileFromSnapshots(job.judge.target, profiles);
    for (const task of tasks.filter((candidate) => candidate.status === "pending")) {
      if (this.controller.signal.aborted || !cost.canCall() || Date.now() >= deadlineAt) break;
      task.status = "running";
      task.attempts += 1;
      delete task.error;
      await atomicWriteJson(tasksPath, JudgeTasksSchema.parse(tasks));
      const intervalTurns = allTurns.filter((turn) => turn.turn >= task.fromTurn && turn.turn <= task.throughTurn);
      const intervalRequirements = manifest.packageSnapshot.coverageRequirements.filter((requirement) => {
          if (requirement.mode === "judge") {
            return requirement.turn === undefined
              || (requirement.turn >= task.fromTurn && requirement.turn <= task.throughTurn);
          }
          const rule = requirement.rule;
          return "turn" in rule
            ? rule.turn >= task.fromTurn && rule.turn <= task.throughTurn
            : true;
        });
      const judgePackage = {
        ...manifest.packageSnapshot,
        coverageRequirements: intervalRequirements,
      };
      const intervalCoverage = assessCoverage(judgePackage, intervalTurns);
      const input: PlaytestJudgePromptInput = {
        playtestPackage: judgePackage,
        language: job.language,
        transcript: transcriptText("See authoritative starting state.", intervalTurns),
        turns: intervalTurns,
        startingState: await readFile(stateFile(jobDir, Math.max(0, task.fromTurn - 1)), "utf8"),
        finalState: await readFile(stateFile(jobDir, task.throughTurn), "utf8"),
        mechanicalAudit: buildMechanicalAudit(intervalTurns),
        coverage: intervalCoverage,
        interval: { fromTurn: task.fromTurn, throughTurn: task.throughTurn },
      };
      const judge = new PlaytestTelemetryProvider({
        actor: "judge",
        lane: "judge",
        jobId: job.id,
        route: job.judge.target.route,
        profile: judgeProfile,
        phase: task.kind === "final" ? "final_judge" : "checkpoint_judge",
        callNamespace: `${task.id}-attempt-${task.attempts}`,
        base: this.dependencies.providerFor(job.judge.target, judgeProfile),
        price: (this.dependencies.costFor ?? defaultCost)(job.judge.target),
        costManager: cost,
        scheduler,
        callsPath: path.join(jobDir, "calls", "judge.jsonl"),
        diagnosticsDir: path.join(jobDir, "diagnostics"),
        signal: this.controller.signal,
        secrets: this.dependencies.secrets,
        deadlineAt,
      });
      judge.setPreCallStateSnapshot(input.finalState);
      this.progress(manifest, job, "judging", configuredTurns(manifest.config, manifest.packageSnapshot), `Independent ${task.kind} judgment ${task.id}`);
      let durationBlocked = false;
      try {
        const result = await generateStructured(judge, {
          schemaName: `playtest_judgment_v1_${task.id}`,
          schema: playtestJudgmentSchemaFor(judgePackage, intervalTurns),
          system: playtestJudgeSystemPrompt(job.language),
          prompt: playtestJudgePrompt(input),
          temperature: 0.2,
          maxOutputTokens: 8_000,
          generationPhase: "decision",
        });
        task.status = "completed";
        await atomicWriteJson(path.join(jobDir, "judgments", `${task.id}.json`), result.data);
        await atomicWriteText(
          path.join(jobDir, "judgments", `${task.id}.md`),
          renderPlaytestJudgment(manifest.packageSnapshot.id, result.data, result.provider, result.model),
        );
      } catch (error) {
        if (error instanceof PlaytestDurationLimitError) {
          task.status = "pending";
          task.attempts -= 1;
          delete task.error;
          durationBlocked = true;
        } else {
          task.status = "failed";
          task.error = (error instanceof Error ? error.message : String(error)).slice(0, 2_000);
        }
      }
      await atomicWriteJson(tasksPath, JudgeTasksSchema.parse(tasks));
      if (durationBlocked || Date.now() >= deadlineAt) break;
    }

    const finalTask = tasks.find((task) => task.kind === "final");
    let finalJudgment: PlaytestJudgment | undefined;
    if (finalTask?.status === "completed") {
      finalJudgment = PlaytestJudgmentSchema.parse(JSON.parse(
        await readFile(path.join(jobDir, "judgments", "final.json"), "utf8"),
      ));
    }
    const assessment = assessPlaytest(
      manifest.packageSnapshot.purpose,
      technical,
      finalJudgment
        ? { status: "completed", judgment: finalJudgment }
        : finalTask?.status === "failed" ? { status: "failed" } : { status: "not_run" },
      job.qualityStatus,
    );
    job.technicalStatus = technical.status;
    job.qualityStatus = assessment.qualityStatus;
    const allTasksCompleted = tasks.every((task) => task.status === "completed");
    job.status = finalTask?.status === "completed" && allTasksCompleted
      ? "completed"
      : "awaiting_judgment";
    if (allTasksCompleted) {
      if (job.failureOwner === "judge") delete job.failureOwner;
      delete job.error;
    }
    await atomicWriteJson(path.join(jobDir, "assessment.json"), assessment);
    if (finalTask?.status === "completed") {
      await this.recordCertificationIfCurrent(manifest, job, technical);
    }
  }

  private async recordCertificationIfCurrent(
    manifest: PlaytestManifest,
    job: PlaytestJob,
    technical: CandidateTechnicalSnapshot,
  ): Promise<void> {
    try {
      await this.recordCertification(manifest, job, technical);
    } catch (error) {
      if (error instanceof Error
        && error.message === "Certification requires the currently frozen calibrated execution profile") {
        return;
      }
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EPERM" || code === "EBUSY" || code === "EACCES") return;
      throw error;
    }
  }

  private async recordCertification(
    manifest: PlaytestManifest,
    job: PlaytestJob,
    technical: CandidateTechnicalSnapshot,
  ): Promise<void> {
    if (manifest.packageSnapshot.id !== "certification-v1") return;
    const catalog = this.dependencies.assessmentCatalog ?? new ModelAssessmentCatalog(this.projectRoot);
    await catalog.recordCertification({
      provider: job.candidate.config.provider,
      model: job.candidate.config.model,
      route: job.candidate.route,
      language: job.language,
      packageId: manifest.packageSnapshot.id,
      packageVersion: String(manifest.packageSnapshot.version),
      profileFingerprint: job.candidate.executionProfileFingerprint,
      technicalStatus: technical.status,
      recoveryCount: technical.schemaRepairs + technical.domainRepairs,
      qualityStatus: job.qualityStatus,
      candidateMetricsHash: hashPlaytestValue(technical),
      evidence: {
        source: "certification",
        reference: path.join("playtests", "runs", manifest.runId, "jobs", job.id).replaceAll("\\", "/"),
        packageId: manifest.packageSnapshot.id,
        packageVersion: String(manifest.packageSnapshot.version),
        executionProfileFingerprint: job.candidate.executionProfileFingerprint,
        recordedAt: this.now().toISOString(),
      },
    });
  }

  private updateActiveDuration(
    manifest: PlaytestManifest,
    activeDurationBefore: number,
    startedAt: number,
    durationLimit: number,
  ): void {
    manifest.activeDurationMs = Math.min(
      durationLimit,
      activeDurationBefore + Math.max(0, Date.now() - startedAt),
    );
  }

  private finishManifest(manifest: PlaytestManifest, cost: number): void {
    const cancelled = this.controller.signal.aborted || manifest.jobs.some((job) => job.status === "cancelled");
    manifest.status = cancelled
      ? "cancelled"
      : manifest.jobs.some((job) => job.stopReason === "cost_limit")
        ? "cost_limit"
        : manifest.jobs.some((job) => job.status !== "completed")
          ? "completed_with_failures"
          : "completed";
    manifest.totalEstimatedCostUsd = cost;
    manifest.completedAt = this.now().toISOString();
    manifest.updatedAt = manifest.completedAt;
  }

  private async persistManifest(runDir: string, manifest: PlaytestManifest): Promise<void> {
    const snapshot = PlaytestManifestSchema.parse(structuredClone(manifest));
    this.manifestWrites = this.manifestWrites.then(() =>
      atomicWriteJson(path.join(runDir, "manifest.json"), snapshot));
    await this.manifestWrites;
  }

  private progress(
    manifest: PlaytestManifest,
    job: PlaytestJob,
    phase: PlaytestProgressEvent["phase"],
    totalTurns: number,
    message: string,
  ): void {
    try {
      this.onProgress({
        runId: manifest.runId,
        jobId: job.id,
        phase,
        completedTurns: job.completedTurns,
        totalTurns,
        estimatedCostUsd: manifest.totalEstimatedCostUsd,
        message,
      });
    } catch {
      // Presentation observers cannot interrupt a run.
    }
  }

  private now(): Date {
    return this.dependencies.now?.() ?? new Date();
  }

  private async worldRules(language: PlaytestJob["language"]): Promise<string> {
    if (this.dependencies.worldRulesFor) return this.dependencies.worldRulesFor(language);
    return (await resolveWorldProfile(this.projectRoot, language)).markdown;
  }
}
