import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { atomicWriteText } from "../../../src/persistence/files.js";
import type { ModelTechnicalGameplayStatus } from "../../../src/model-status.js";
import { CandidateTechnicalSnapshotSchema, type CandidateTechnicalSnapshot } from "./assessment.js";
import {
  FailureOwnerSchema,
  PlaytestCallRecordSchema,
  PlaytestTurnRecordSchema,
  type FailureOwner,
  type PlaytestCallRecord,
  type PlaytestCompletedStory,
  type PlaytestDomainRepairCause,
  type PlaytestManifest,
  type PlaytestTurnRecord,
} from "./contracts.js";
import { readPlaytestJsonLines } from "./files.js";
import { readPlaytestManifest } from "./manifest.js";

const CoverageAssessmentArtifactSchema = z
  .object({
    deterministicPassed: z.boolean(),
    passed: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    requiresJudge: z.number().int().nonnegative(),
    notExercised: z.number().int().nonnegative().default(0),
    entries: z.array(
      z
        .object({
          requirementId: z.string().min(1),
          mode: z.enum(["deterministic", "judge"]),
          status: z.enum(["passed", "failed", "requires_judge", "not_exercised"]),
          evidence: z.string(),
        })
        .strict(),
    ),
  })
  .strict();

type CoverageAssessmentArtifact = z.infer<typeof CoverageAssessmentArtifactSchema>;

export interface LaneMetrics {
  calls: number;
  failures: number;
  costUsd: number;
  failedCallCostUsd: number;
  inputTokens: number;
  outputTokens: number;
  averageCostWaitMs: number;
  averageQueueWaitMs: number;
  averageProviderDurationMs: number;
  retryBackoffMs: number;
  repairs: {
    schema: number;
    content: number;
    transient: number;
    domain: number;
  };
  failureOwners: Partial<Record<FailureOwner, number>>;
  failureFingerprints: Array<{ fingerprint: string; count: number }>;
  domainRepairCauses: Array<{ callId: string; cause: PlaytestDomainRepairCause }>;
  domainRepairsWithoutCause: number;
  costBasisCounts: {
    reportedUsage: number;
    reservedEstimate: number;
  };
}

export interface PlaytestJobReport {
  jobId: string;
  candidateIndex: number;
  candidateLabel: string;
  executionProfileFingerprint: string;
  language: string;
  repetition: number;
  latencyMode: "canonical" | "loaded";
  technicalStatus: ModelTechnicalGameplayStatus | "unassessed";
  qualityStatus: string;
  jobStatus: PlaytestManifest["jobs"][number]["status"];
  stopReason?: PlaytestManifest["jobs"][number]["stopReason"];
  failureOwner?: FailureOwner;
  turnsRequested: number;
  turnsRequired?: number;
  turnsCompleted: number;
  /** Uncommittable turns an exploratory run recorded and stepped over. */
  turnsSkipped: number;
  checks: number;
  checkRate: number;
  invariantFailures: number;
  deterministicCoveragePassed?: boolean;
  coveragePassed?: number;
  coverageFailed?: number;
  coverageRequiresJudge?: number;
  coverageNotExercised?: number;
  failedCoverageRequirementIds: string[];
  scenarioSignals: Array<{ code: string; count: number; example: string }>;
  domainSignals: Array<{ code: string; count: number }>;
  threadAudit: {
    unchanged: number;
    progressed: number;
    closed: number;
    omitted: number;
    invented: number;
  };
  /**
   * Durable operations the committed turns actually wrote, by kind.
   *
   * Every other acceptance criterion improves when the model emits fewer
   * operations, so without this nothing watches whether a turn recorded
   * anything at all. A run that repairs less because it writes less is not a
   * better run, and that is invisible from repair counts.
   */
  operationCounts: Record<string, number>;
  operationsPerTurn: number;
  technicalReasons: string[];
  playerVisibleAverageMs: number;
  completedStory?: PlaytestCompletedStory;
  candidate: LaneMetrics;
  playerDriver: LaneMetrics;
  judge: LaneMetrics;
  artifact: LaneMetrics;
}

export interface PlaytestReportData {
  manifest: PlaytestManifest;
  jobs: PlaytestJobReport[];
}

export interface DomainRepairCauseRanking {
  /** Violated rule code, or the redacted rule text when a cause predates codes. */
  key: string;
  count: number;
  jobs: number;
  /**
   * Distinct logical gameplay turns this rule fired on.
   *
   * Retries for one turn share a durable pending operation ID, so counting
   * distinct IDs counts turns rather than calls. This is the number that
   * separates a rule firing once in twenty-five turns from a rule firing on
   * every one of them; the raw repair count cannot, because a checked turn
   * spends two calls and an unchecked turn spends one.
   */
  turns: number;
  /** Repairs during setup, which is one phase per run rather than per turn. */
  setupRepairs: number;
  example: string;
}

/** Turns this rule fired on as a share of the turns actually played. */
export function ruleShareOfTurns(entry: DomainRepairCauseRanking, turnsCompleted: number): number {
  if (turnsCompleted <= 0) return 0;
  return entry.turns / turnsCompleted;
}

function formatShare(share: number): string {
  return `${(share * 100).toFixed(1)}%`;
}

/**
 * One rejected transaction can violate several rules, and the redacted cause
 * carries each rule's code. Extract them so causes group by rule rather than
 * by opaque fingerprint.
 */
function violationKeys(message: string): string[] {
  const classified = [...message.matchAll(/\[([a-z_]{1,64})\][^\n]*?\(([a-z_]{1,64})\)/gu)].map(
    (match) => `${match[1]}:${match[2]}`,
  );
  if (classified.length > 0) return [...new Set(classified)];
  const codes = [...message.matchAll(/^\s*(?:-\s*)?\[([a-z_]{1,64})\]/gmu)].map(
    (match) => match[1]!,
  );
  if (codes.length > 0) return [...new Set(codes)];
  return [message.split("\n")[0]?.trim() || "unclassified"];
}

/**
 * Rank domain-repair causes across the whole run.
 *
 * Per-call listings show that recovery happened; they do not show which rule
 * keeps forcing it. Ranking turns bounded recovery from a vague residual into
 * an ordered worklist of rules to fix structurally.
 */
export function rankDomainRepairCauses(
  jobs: readonly PlaytestJobReport[],
): DomainRepairCauseRanking[] {
  const totals = new Map<
    string,
    {
      count: number;
      jobs: Set<string>;
      turnOperations: Set<string>;
      setupRepairs: number;
      example: string;
    }
  >();
  for (const job of jobs) {
    for (const lane of [job.candidate, job.playerDriver, job.judge, job.artifact]) {
      for (const { cause } of lane.domainRepairCauses) {
        const message = cause.errorMessage.replace(/\s+/gu, " ").trim();
        const setupPhase = cause.sourcePhase === "setup";
        for (const key of violationKeys(cause.errorMessage)) {
          const entry = totals.get(key) ?? {
            count: 0,
            jobs: new Set<string>(),
            turnOperations: new Set<string>(),
            setupRepairs: 0,
            example: message,
          };
          entry.count += 1;
          entry.jobs.add(job.jobId);
          if (setupPhase) entry.setupRepairs += 1;
          // Scope the operation ID by job so two jobs cannot collide, and count
          // it only for gameplay phases: setup happens once per run, so folding
          // it into a per-turn share would overstate it.
          else entry.turnOperations.add(`${job.jobId}\u0000${cause.logicalOperationId}`);
          totals.set(key, entry);
        }
      }
    }
  }
  return [...totals]
    .map(([key, entry]) => ({
      key,
      count: entry.count,
      jobs: entry.jobs.size,
      turns: entry.turnOperations.size,
      setupRepairs: entry.setupRepairs,
      example: entry.example,
    }))
    .sort(
      (left, right) =>
        right.turns - left.turns || right.count - left.count || left.key.localeCompare(right.key),
    );
}

/**
 * Ongoing scenario-contract signals grouped by rule. They are seed-authored
 * review evidence, never a pass/fail gate.
 */
export function summarizeScenarioSignals(
  turns: readonly PlaytestTurnRecord[],
): Array<{ code: string; count: number; example: string }> {
  const totals = new Map<string, { count: number; example: string }>();
  for (const turn of turns) {
    for (const signal of turn.scenarioSignals ?? []) {
      const entry = totals.get(signal.code) ?? { count: 0, example: signal.message };
      entry.count += 1;
      totals.set(signal.code, entry);
    }
  }
  return [...totals]
    .map(([code, entry]) => ({ code, count: entry.count, example: entry.example }))
    .sort((left, right) => right.count - left.count || left.code.localeCompare(right.code));
}

/**
 * Domain rules declared review-only, grouped by code. A high count is a
 * worklist entry — either the DM keeps getting a judgment call wrong, or the
 * rule's predicate is too broad to mean anything.
 */
export function summarizeDomainSignals(
  turns: readonly PlaytestTurnRecord[],
): Array<{ code: string; count: number }> {
  const totals = new Map<string, number>();
  for (const turn of turns) {
    for (const signal of turn.domainSignals ?? []) {
      totals.set(signal.code, (totals.get(signal.code) ?? 0) + 1);
    }
  }
  return [...totals]
    .map(([code, count]) => ({ code, count }))
    .sort((left, right) => right.count - left.count || left.code.localeCompare(right.code));
}

function round(value: number): number {
  return Math.round(value * 1_000) / 1_000;
}

function increment<K extends string>(counts: Partial<Record<K, number>>, key: K): void {
  counts[key] = (counts[key] ?? 0) + 1;
}

function laneMetrics(calls: readonly PlaytestCallRecord[]): LaneMetrics {
  const count = calls.length;
  const failed = calls.filter((call) => !call.success);
  const repairs = { schema: 0, content: 0, transient: 0, domain: 0 };
  const failureOwners: Partial<Record<FailureOwner, number>> = {};
  const fingerprints = new Map<string, number>();
  for (const call of calls) {
    if (call.repairKind) repairs[call.repairKind] += 1;
  }
  for (const call of failed) {
    increment(failureOwners, call.failureOwner ?? FailureOwnerSchema.parse("inconclusive"));
    if (call.failureFingerprint) {
      fingerprints.set(
        call.failureFingerprint,
        (fingerprints.get(call.failureFingerprint) ?? 0) + 1,
      );
    }
  }
  return {
    calls: count,
    failures: failed.length,
    costUsd: round(calls.reduce((sum, call) => sum + call.estimatedCostUsd, 0)),
    failedCallCostUsd: round(failed.reduce((sum, call) => sum + call.estimatedCostUsd, 0)),
    inputTokens: calls.reduce((sum, call) => sum + (call.inputTokens ?? 0), 0),
    outputTokens: calls.reduce((sum, call) => sum + (call.outputTokens ?? 0), 0),
    averageCostWaitMs: round(
      count === 0 ? 0 : calls.reduce((sum, call) => sum + call.costWaitMs, 0) / count,
    ),
    averageQueueWaitMs: round(
      count === 0 ? 0 : calls.reduce((sum, call) => sum + call.queueWaitMs, 0) / count,
    ),
    averageProviderDurationMs: round(
      count === 0 ? 0 : calls.reduce((sum, call) => sum + call.providerDurationMs, 0) / count,
    ),
    retryBackoffMs: calls.reduce((sum, call) => sum + call.retryBackoffMs, 0),
    repairs,
    failureOwners,
    failureFingerprints: [...fingerprints]
      .map(([fingerprint, fingerprintCount]) => ({ fingerprint, count: fingerprintCount }))
      .sort((left, right) => left.fingerprint.localeCompare(right.fingerprint)),
    domainRepairCauses: calls.flatMap((call) =>
      call.domainRepairCause ? [{ callId: call.id, cause: call.domainRepairCause }] : [],
    ),
    domainRepairsWithoutCause: calls.filter(
      (call) => call.repairKind === "domain" && call.domainRepairCause === undefined,
    ).length,
    costBasisCounts: {
      reportedUsage: calls.filter((call) => call.costBasis === "reported_usage").length,
      reservedEstimate: calls.filter((call) => call.costBasis === "reserved_estimate").length,
    },
  };
}

async function optionalTechnical(target: string): Promise<CandidateTechnicalSnapshot | undefined> {
  try {
    return CandidateTechnicalSnapshotSchema.parse(JSON.parse(await readFile(target, "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function optionalCoverage(target: string): Promise<CoverageAssessmentArtifact | undefined> {
  try {
    return CoverageAssessmentArtifactSchema.parse(JSON.parse(await readFile(target, "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function callsAt(target: string): Promise<PlaytestCallRecord[]> {
  return PlaytestCallRecordSchema.array().parse(await readPlaytestJsonLines(target));
}

function sameValue(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (left === null || right === null || typeof left !== "object" || typeof right !== "object")
    return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => sameValue(value, right[index]))
    );
  }
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord).sort();
  const rightKeys = Object.keys(rightRecord).sort();
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key, index) => key === rightKeys[index] && sameValue(leftRecord[key], rightRecord[key]),
    )
  );
}

function candidateIndex(manifest: PlaytestManifest, job: PlaytestManifest["jobs"][number]): number {
  const index = manifest.config.candidates.findIndex((candidate) =>
    sameValue(candidate, job.candidate),
  );
  if (index < 0)
    throw new Error(`Playtest job ${job.id} references a candidate outside its run configuration`);
  return index;
}

export async function collectPlaytestReport(runDir: string): Promise<PlaytestReportData> {
  const manifest = await readPlaytestManifest(path.join(runDir, "manifest.json"));
  const jobs: PlaytestJobReport[] = [];
  for (const job of manifest.jobs) {
    const jobDir = path.join(runDir, "jobs", job.id);
    const [candidateCalls, playerCalls, judgeCalls, artifactCalls, turns, technical, coverage] =
      await Promise.all([
        callsAt(path.join(jobDir, "calls", "candidate.jsonl")),
        callsAt(path.join(jobDir, "calls", "player-driver.jsonl")),
        callsAt(path.join(jobDir, "calls", "judge.jsonl")),
        callsAt(path.join(jobDir, "calls", "artifact.jsonl")),
        readPlaytestJsonLines<PlaytestTurnRecord>(path.join(jobDir, "turns.jsonl")).then(
          (records) => PlaytestTurnRecordSchema.array().parse(records),
        ),
        optionalTechnical(path.join(jobDir, "technical.json")),
        optionalCoverage(path.join(jobDir, "coverage.json")),
      ]);
    const completedTurns = turns.filter((turn) => turn.status === "completed");
    const checks = completedTurns.filter((turn) => turn.check !== undefined).length;
    const visible = turns.flatMap((turn) =>
      turn.playerVisibleDurationMs === undefined ? [] : [turn.playerVisibleDurationMs],
    );
    jobs.push({
      jobId: job.id,
      candidateIndex: candidateIndex(manifest, job),
      candidateLabel: `${job.candidate.config.provider}/${job.candidate.config.model} via ${job.candidate.route}`,
      executionProfileFingerprint: job.candidate.executionProfileFingerprint,
      language: job.language,
      repetition: job.repetition,
      latencyMode: job.latencyMode,
      technicalStatus: technical?.status ?? job.technicalStatus ?? "unassessed",
      qualityStatus: job.qualityStatus,
      jobStatus: job.status,
      ...(job.stopReason ? { stopReason: job.stopReason } : {}),
      ...(job.failureOwner ? { failureOwner: job.failureOwner } : {}),
      turnsRequested: manifest.config.turns ?? manifest.packageSnapshot.turns.default,
      ...(technical ? { turnsRequired: technical.turnsRequired } : {}),
      turnsCompleted: completedTurns.length,
      turnsSkipped: turns.filter((turn) => turn.status === "skipped").length,
      checks,
      checkRate: round(completedTurns.length === 0 ? 0 : checks / completedTurns.length),
      invariantFailures:
        technical?.invariantFailures ??
        completedTurns.filter((turn) => turn.invariantStatus !== "passed").length,
      ...(coverage
        ? {
            deterministicCoveragePassed: coverage.deterministicPassed,
            coveragePassed: coverage.passed,
            coverageFailed: coverage.failed,
            coverageRequiresJudge: coverage.requiresJudge,
            coverageNotExercised: coverage.notExercised,
          }
        : {}),
      failedCoverageRequirementIds:
        coverage?.entries
          .filter((entry) => entry.status === "failed")
          .map((entry) => entry.requirementId) ?? [],
      scenarioSignals: summarizeScenarioSignals(turns),
      domainSignals: summarizeDomainSignals(turns),
      threadAudit: turns.reduce(
        (total, turn) => ({
          unchanged: total.unchanged + (turn.threadAudit?.unchanged ?? 0),
          progressed: total.progressed + (turn.threadAudit?.progressed ?? 0),
          closed: total.closed + (turn.threadAudit?.closed ?? 0),
          omitted: total.omitted + (turn.threadAudit?.omitted ?? 0),
          invented: total.invented + (turn.threadAudit?.invented ?? 0),
        }),
        { unchanged: 0, progressed: 0, closed: 0, omitted: 0, invented: 0 },
      ),
      operationCounts: countOperations(turns),
      operationsPerTurn: round(
        turns.length === 0
          ? 0
          : turns.reduce((sum, turn) => sum + (turn.operations?.length ?? 0), 0) / turns.length,
      ),
      technicalReasons: technical?.reasons ?? [],
      playerVisibleAverageMs: round(
        visible.length === 0 ? 0 : visible.reduce((sum, value) => sum + value, 0) / visible.length,
      ),
      ...(job.completedStory ? { completedStory: job.completedStory } : {}),
      candidate: laneMetrics(candidateCalls),
      playerDriver: laneMetrics(playerCalls),
      judge: laneMetrics(judgeCalls),
      artifact: laneMetrics(artifactCalls),
    });
  }
  return { manifest, jobs };
}

/** Committed durable operations by kind, over the turns this job committed. */
function countOperations(turns: readonly PlaytestTurnRecord[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const turn of turns) {
    for (const operation of turn.operations ?? []) {
      counts[operation.type] = (counts[operation.type] ?? 0) + 1;
    }
  }
  return counts;
}

function countLine(counts: Readonly<Record<string, number>>): string {
  const entries = Object.entries(counts)
    .filter(([, count]) => count > 0)
    .sort(([left], [right]) => left.localeCompare(right));
  return entries.length === 0
    ? "none"
    : entries.map(([key, count]) => `${key}=${count}`).join(", ");
}

function laneLine(label: string, lane: LaneMetrics): string {
  return `${label}: ${lane.calls} calls, ${lane.failures} failures, $${lane.costUsd.toFixed(6)} total / $${lane.failedCallCostUsd.toFixed(6)} failed, ${lane.inputTokens} input / ${lane.outputTokens} output tokens, cost wait ${lane.averageCostWaitMs.toFixed(1)} ms, scheduler queue ${lane.averageQueueWaitMs.toFixed(1)} ms, provider ${lane.averageProviderDurationMs.toFixed(1)} ms, backoff ${lane.retryBackoffMs} ms`;
}

function laneDetails(label: string, lane: LaneMetrics): string[] {
  const domainRepairCauses = lane.domainRepairCauses.map(({ callId, cause }) =>
    [
      `${callId} after ${cause.priorCallId}`,
      `operation ${cause.logicalOperationId}`,
      `${cause.validationStage}/${cause.sourcePhase}`,
      `${cause.errorName}: ${cause.errorMessage.replace(/\s+/gu, " ")}`,
      `fingerprint ${cause.errorFingerprint}`,
    ].join("; "),
  );
  return [
    `  - ${label} repairs: schema=${lane.repairs.schema}, content=${lane.repairs.content}, transient=${lane.repairs.transient}, domain=${lane.repairs.domain}`,
    `  - ${label} failure owners: ${countLine(lane.failureOwners)}`,
    `  - ${label} failure fingerprints: ${lane.failureFingerprints.length === 0 ? "none" : lane.failureFingerprints.map((entry) => `${entry.fingerprint} (${entry.count})`).join(", ")}`,
    `  - ${label} domain-repair causes: ${domainRepairCauses.length === 0 ? "none" : domainRepairCauses.join(" | ")}${lane.domainRepairsWithoutCause === 0 ? "" : `${domainRepairCauses.length === 0 ? "" : "; "}legacy/unavailable=${lane.domainRepairsWithoutCause}`}`,
    `  - ${label} cost basis: reported usage=${lane.costBasisCounts.reportedUsage}, reserved estimate=${lane.costBasisCounts.reservedEstimate}`,
  ];
}

/**
 * How a criterion came out. `hard` criteria decide acceptance; `advisory` is a
 * cost signal that never fails a run; `measured` is reported precisely because
 * it must not be tuned against.
 */
export type AcceptanceVerdict = "pass" | "fail" | "advisory" | "measured";

export interface PlaytestAcceptanceCriterion {
  id: string;
  label: string;
  bar: string;
  observed: string;
  verdict: AcceptanceVerdict;
}

export interface PlaytestAcceptanceScore {
  criteria: PlaytestAcceptanceCriterion[];
  /** True when every hard criterion passed. Advisory and measured rows never decide this. */
  accepted: boolean;
}

/** Turns played across every job, used as the denominator for per-turn rates. */
function totalTurnsCompleted(jobs: readonly PlaytestJobReport[]): number {
  return jobs.reduce((total, job) => total + job.turnsCompleted, 0);
}

/**
 * Score a run against the acceptance criteria rather than against the absence
 * of incidents.
 *
 * A repaired turn is a working recovery path, so counting repairs cannot say
 * whether a run is good enough. What decides it is whether the run finished,
 * whether any single rule fired often enough to be a defect rather than noise,
 * and whether state integrity held.
 */
export function scorePlaytestAcceptance(
  jobs: readonly PlaytestJobReport[],
): PlaytestAcceptanceScore {
  const turns = totalTurnsCompleted(jobs);
  // A valid in-fiction death completes its fixture; only a technical abort is a
  // completion failure.
  const aborted = jobs.filter((job) => job.stopReason === "error");
  const short = jobs.filter((job) => job.turnsCompleted < job.turnsRequested);
  const skipped = jobs.reduce((total, job) => total + job.turnsSkipped, 0);
  const ranked = rankDomainRepairCauses(jobs);
  const worst = ranked.reduce<{ key: string; share: number }>(
    (top, entry) => {
      const share = ruleShareOfTurns(entry, turns);
      return share > top.share ? { key: entry.key, share } : top;
    },
    { key: "none", share: 0 },
  );
  const invariantFailures = jobs.reduce((total, job) => total + job.invariantFailures, 0);
  const domainRepairs = jobs.reduce((total, job) => total + job.candidate.repairs.domain, 0);
  const repairsPerTurn = turns === 0 ? 0 : domainRepairs / turns;
  const closed = jobs.reduce((total, job) => total + job.threadAudit.closed, 0);
  // Tolerant of an absent field so a report can still be scored over a run
  // recorded before operation yield was tracked.
  const operations = jobs.reduce(
    (total, job) => total + Object.values(job.operationCounts ?? {}).reduce((sum, n) => sum + n, 0),
    0,
  );
  const operationsPerTurn = turns === 0 ? 0 : operations / turns;
  const operationKinds = jobs.reduce<Record<string, number>>((total, job) => {
    for (const [kind, count] of Object.entries(job.operationCounts ?? {})) {
      total[kind] = (total[kind] ?? 0) + count;
    }
    return total;
  }, {});
  const criteria: PlaytestAcceptanceCriterion[] = [
    {
      id: "run_completion",
      label: "Run completion",
      bar: "every job plays its requested turns, zero fatal aborts",
      observed:
        aborted.length === 0 && short.length === 0
          ? `${turns} turns, no aborts`
          : `${turns} turns; ${aborted.length} fatal abort(s); ${short.length} job(s) short of the requested turns${skipped === 0 ? "" : `; ${skipped} turn(s) skipped as uncommittable`}`,
      verdict: aborted.length === 0 && short.length === 0 ? "pass" : "fail",
    },
    {
      id: "top_rule_share",
      label: "Largest single rule's share of turns",
      bar: "< 20%",
      observed: turns === 0 ? "no turns played" : `${formatShare(worst.share)} (\`${worst.key}\`)`,
      verdict: turns > 0 && worst.share < 0.2 ? "pass" : "fail",
    },
    {
      id: "invariant_failures",
      label: "Invariant failures",
      bar: "0",
      observed: String(invariantFailures),
      verdict: invariantFailures === 0 ? "pass" : "fail",
    },
    {
      id: "domain_repairs_per_turn",
      label: "Aggregate candidate domain repairs per turn",
      bar: "<= 0.3 (cost signal, not a gate)",
      observed: `${repairsPerTurn.toFixed(3)} (${domainRepairs} repairs / ${turns} turns)`,
      verdict: "advisory",
    },
    {
      id: "check_rate",
      label: "Check rate",
      bar: "not a criterion; do not tune against it",
      observed: jobs.map((job) => `${job.jobId} ${(job.checkRate * 100).toFixed(1)}%`).join(", "),
      verdict: "measured",
    },
    {
      // Per 100 turns rather than per verdict, so it is comparable between a
      // 15-turn run and a 100-turn one. Reported, never tuned against.
      id: "thread_closures_per_100_turns",
      label: "Thread closures per 100 turns",
      bar: "measure and report only",
      observed:
        turns === 0
          ? "no turns played"
          : `${((closed / turns) * 100).toFixed(1)} (${closed} closed / ${turns} turns)`,
      verdict: "measured",
    },
    {
      // The yield side of the ledger. Every criterion above improves when the
      // model records less, so a run that repairs less because it wrote less
      // would otherwise read as an improvement.
      id: "durable_operations_per_turn",
      label: "Durable operations per turn",
      bar: "measure and report only; a fall here cancels a fall in repairs",
      observed:
        turns === 0
          ? "no turns played"
          : `${operationsPerTurn.toFixed(2)} (${operations} operations / ${turns} turns) — ${countLine(operationKinds)}`,
      verdict: "measured",
    },
  ];
  return {
    criteria,
    accepted: criteria.every((criterion) => criterion.verdict !== "fail"),
  };
}

function acceptanceSection(jobs: readonly PlaytestJobReport[]): string[] {
  const score = scorePlaytestAcceptance(jobs);
  return [
    "## Acceptance",
    "",
    `Verdict: **${score.accepted ? "meets the acceptance criteria" : "does not meet the acceptance criteria"}**. Advisory and measured rows never decide this.`,
    "",
    "| Criterion | Bar | Observed | Verdict |",
    "| --- | --- | --- | --- |",
    ...score.criteria.map(
      (criterion) =>
        `| ${criterion.label} | ${criterion.bar} | ${criterion.observed} | ${criterion.verdict} |`,
    ),
    "",
  ];
}

function domainRepairRankingSection(jobs: readonly PlaytestJobReport[]): string[] {
  const ranked = rankDomainRepairCauses(jobs);
  if (ranked.length === 0) return [];
  const turns = totalTurnsCompleted(jobs);
  return [
    "## Domain-repair causes (ranked)",
    "",
    "Each row is one deterministic rule that forced a bounded correction. Rank order is the worklist: a rule near the top is a candidate for normalization, a clearer contract, or removal as a false invariant.",
    "",
    "Rank is by share of turns, not by repair count: a rule firing once in twenty-five turns is noise, and a rule firing on every turn is a defect, however few calls each one cost.",
    "",
    `| Rule | Turns | Share of ${turns} turns | Repairs | Setup repairs | Jobs | Example |`,
    "| --- | ---: | ---: | ---: | ---: | ---: | --- |",
    ...ranked.map(
      (entry) =>
        `| \`${entry.key}\` | ${entry.turns} | ${formatShare(ruleShareOfTurns(entry, turns))} | ${entry.count} | ${entry.setupRepairs} | ${entry.jobs} | ${entry.example.slice(0, 160)} |`,
    ),
    "",
  ];
}

export function renderPlaytestReport(data: PlaytestReportData): string {
  const { manifest } = data;
  const sections = data.jobs.map((job) =>
    [
      `## ${job.jobId} - ${job.candidateLabel} - ${job.language} - repetition ${job.repetition}`,
      "",
      `- Result: job **${job.jobStatus}**; technical **${job.technicalStatus}**; quality **${job.qualityStatus}**`,
      `- Frozen execution profile: \`${job.executionProfileFingerprint}\``,
      `- Turns: ${job.turnsCompleted}/${job.turnsRequested} requested${job.turnsRequired === undefined ? "" : `; technical requirement: ${job.turnsRequired}`}${job.turnsSkipped === 0 ? "" : `; skipped as uncommittable: ${job.turnsSkipped}`}; checks: ${job.checks} (${(job.checkRate * 100).toFixed(1)}%); player-visible mean: ${job.playerVisibleAverageMs.toFixed(1)} ms`,
      `- Invariant failures: ${job.invariantFailures}`,
      `- Coverage: ${job.deterministicCoveragePassed === undefined ? "unavailable" : job.deterministicCoveragePassed ? "no deterministic failures" : "deterministic failures present"}${job.coveragePassed === undefined ? "" : ` (passed=${job.coveragePassed}, failed=${job.coverageFailed}, judge-only=${job.coverageRequiresJudge}, not-exercised=${job.coverageNotExercised ?? 0})`}`,
      ...(job.failedCoverageRequirementIds.length === 0
        ? []
        : [`- Failed coverage requirements: ${job.failedCoverageRequirementIds.join(", ")}`]),
      ...(job.technicalReasons.length === 0
        ? []
        : [`- Technical reasons: ${job.technicalReasons.join("; ")}`]),
      // unaudited/named-but-absent are V2-only and stay in the line only while
      // a run recorded under that contract can still be reported.
      `- Thread lifecycle: unchanged=${job.threadAudit.unchanged}, progressed=${job.threadAudit.progressed}, closed=${job.threadAudit.closed}` +
        (job.threadAudit.omitted || job.threadAudit.invented
          ? `, unaudited=${job.threadAudit.omitted}, named-but-absent=${job.threadAudit.invented}`
          : ""),
      ...(job.scenarioSignals.length === 0
        ? []
        : [
            `- Scenario continuity signals (review only): ${job.scenarioSignals
              .map((entry) => `${entry.code} x${entry.count} (${entry.example})`)
              .join("; ")}`,
          ]),
      ...(job.domainSignals.length === 0
        ? []
        : [
            `- Domain judgment signals (review only): ${job.domainSignals
              .map((entry) => `${entry.code} x${entry.count}`)
              .join("; ")}`,
          ]),
      ...(job.stopReason
        ? [
            `- Stop reason: ${job.stopReason}${job.failureOwner ? `; failure owner: ${job.failureOwner}` : ""}`,
          ]
        : []),
      ...(job.completedStory
        ? [
            `- Completed-story artifact: **${job.completedStory.status}**; finalization attempts: ${job.completedStory.attempts}${job.completedStory.error ? `; ${job.completedStory.error}` : ""}`,
          ]
        : []),
      `- Latency evidence: **${job.latencyMode}**${job.latencyMode === "loaded" ? " (not canonical speed evidence)" : ""}`,
      `- ${laneLine("Candidate", job.candidate)}`,
      ...laneDetails("Candidate", job.candidate),
      `- ${laneLine("Player driver", job.playerDriver)}`,
      ...laneDetails("Player driver", job.playerDriver),
      `- ${laneLine("Independent judge", job.judge)}`,
      ...laneDetails("Independent judge", job.judge),
      `- ${laneLine("Post-completion artifact", job.artifact)}`,
      ...laneDetails("Post-completion artifact", job.artifact),
    ].join("\n"),
  );
  return [
    `# Playtest ${manifest.runId}`,
    "",
    `Package: **${manifest.packageSnapshot.id} v${manifest.packageSnapshot.version}** (${manifest.packageSnapshot.purpose})`,
    `Package fingerprint: \`${manifest.packageHash}\``,
    `Status: **${manifest.status}**`,
    `Started: ${manifest.startedAt}`,
    ...(manifest.completedAt ? [`Completed: ${manifest.completedAt}`] : []),
    `Total recorded cost: $${manifest.totalEstimatedCostUsd.toFixed(6)}`,
    `Code source hash: \`${manifest.codeVersion.sourceHash}\``,
    "",
    "Candidate, player-driver, judge, and post-completion artifact lanes are intentionally reported separately. Judge and player-driver behavior is excluded from candidate technical status. Post-completion artifact behavior is excluded as well.",
    "",
    ...acceptanceSection(data.jobs),
    ...domainRepairRankingSection(data.jobs),
    ...sections,
    "",
  ].join("\n");
}

export async function generatePlaytestReport(runDir: string): Promise<string> {
  const reportPath = path.join(runDir, "report.md");
  await atomicWriteText(reportPath, renderPlaytestReport(await collectPlaytestReport(runDir)));
  return reportPath;
}

export interface PlaytestComparison {
  left: PlaytestReportData;
  right: PlaytestReportData;
  markdown: string;
}

/**
 * Every input that can move a run's numbers without any code change.
 *
 * `scenarioSeed` belongs here and was missing: two runs on different seeds
 * differ in entity count, thread links, and continuity contracts, so comparing
 * them credits or blames code for the scenario's own difficulty. That omission
 * is how a scenario change reads as a regression.
 */
function comparisonControls(manifest: PlaytestManifest): Record<string, unknown> {
  const config = manifest.config;
  return {
    packageSnapshot: manifest.packageSnapshot,
    languages: config.languages,
    turns: config.turns,
    scenarioSeed: config.scenarioSeed,
    seed: config.seed,
    tuningVariable: config.tuningVariable,
    repetitions: config.repetitions,
    globalWorkerLimit: config.globalWorkerLimit,
    latencyMode: config.latencyMode,
    providerConcurrency: config.providerConcurrency,
    maxCostUsd: config.maxCostUsd,
    maxDurationMs: config.maxDurationMs,
    player: config.player,
    judge: config.judge,
    candidateSlots: config.candidates.length,
  };
}

/** Control variables that differ between two runs, in declaration order. */
function uncontrolledVariables(left: PlaytestManifest, right: PlaytestManifest): string[] {
  const leftControls = comparisonControls(left);
  const rightControls = comparisonControls(right);
  return Object.keys(leftControls).filter(
    (key) => !sameValue(leftControls[key], rightControls[key]),
  );
}

function comparisonKey(job: PlaytestJobReport): string {
  return `${String(job.candidateIndex).padStart(3, "0")}\u0000${job.language}\u0000${String(job.repetition).padStart(3, "0")}`;
}

function comparisonJobs(data: PlaytestReportData): Map<string, PlaytestJobReport> {
  const jobs = new Map<string, PlaytestJobReport>();
  for (const job of data.jobs) {
    const key = comparisonKey(job);
    if (jobs.has(key))
      throw new Error(`Playtest comparison found duplicate job coordinates for ${job.jobId}`);
    jobs.set(key, job);
  }
  return jobs;
}

function assertControlledTuningVariable(left: PlaytestManifest, right: PlaytestManifest): void {
  if (left.packageSnapshot.purpose !== "tuning") return;
  const declaration = left.config.tuningVariable;
  if (!declaration) throw new Error("Tuning comparison requires one declared variable");
  const kind = declaration.slice(0, declaration.indexOf(":"));
  const sameSource = left.codeVersion.sourceHash === right.codeVersion.sourceHash;
  for (const [index, leftTarget] of left.config.candidates.entries()) {
    const rightTarget = right.config.candidates[index]!;
    if (kind === "model") {
      if (!sameSource)
        throw new Error("A model tuning comparison requires the same code/prompt source revision");
      if (
        leftTarget.config.provider === rightTarget.config.provider &&
        leftTarget.config.model === rightTarget.config.model &&
        leftTarget.route === rightTarget.route &&
        leftTarget.executionProfileFingerprint === rightTarget.executionProfileFingerprint
      ) {
        throw new Error("A model tuning comparison must change the candidate model selection");
      }
    } else if (kind === "adapter") {
      if (!sameSource)
        throw new Error(
          "An adapter tuning comparison requires the same code/prompt source revision",
        );
      if (
        leftTarget.config.provider !== rightTarget.config.provider ||
        leftTarget.config.model !== rightTarget.config.model
      ) {
        throw new Error(
          "An adapter tuning comparison must keep the underlying provider/model fixed",
        );
      }
      if (
        leftTarget.route === rightTarget.route &&
        leftTarget.executionProfileFingerprint === rightTarget.executionProfileFingerprint
      ) {
        throw new Error(
          "An adapter tuning comparison must change the route or frozen execution profile",
        );
      }
    } else if (kind === "prompt") {
      if (!sameValue(leftTarget, rightTarget)) {
        throw new Error(
          "A prompt tuning comparison must keep the candidate model and execution profile fixed",
        );
      }
      if (sameSource)
        throw new Error("A prompt tuning comparison requires distinct recorded source revisions");
    }
  }
}

export async function comparePlaytestRuns(
  leftRunDir: string,
  rightRunDir: string,
): Promise<PlaytestComparison> {
  const [left, right] = await Promise.all([
    collectPlaytestReport(leftRunDir),
    collectPlaytestReport(rightRunDir),
  ]);
  // Two runs of different packages measure different experiments; there is no
  // meaningful delta to render.
  if (left.manifest.packageHash !== right.manifest.packageHash) {
    throw new Error(
      "Playtest comparison requires the same package fingerprint; the runs measure different experiments",
    );
  }
  assertControlledTuningVariable(left.manifest, right.manifest);
  // Anything else that differs is reported rather than refused. Every run on
  // disk predates this tool, so a comparison that refuses uncontrolled inputs
  // can never look at the history it exists to explain. Naming the uncontrolled
  // variable keeps the delta honest without discarding it.
  const uncontrolled = uncontrolledVariables(left.manifest, right.manifest);
  // A tuning run is a declared one-variable experiment, so a second uncontrolled
  // input invalidates it outright instead of merely weakening the reading.
  if (left.manifest.packageSnapshot.purpose === "tuning" && uncontrolled.length > 0) {
    throw new Error(
      `Tuning comparison requires every control except the declared variable to match; ${uncontrolled.join(", ")} differ`,
    );
  }
  const leftJobs = comparisonJobs(left);
  const rightJobs = comparisonJobs(right);
  const keys = [...new Set([...leftJobs.keys(), ...rightJobs.keys()])].sort();
  if (keys.some((key) => !leftJobs.has(key) || !rightJobs.has(key))) {
    throw new Error(
      "Playtest comparison requires matching candidate-slot, language, and repetition job coordinates",
    );
  }
  const lines = [
    `# Playtest comparison: ${left.manifest.runId} vs ${right.manifest.runId}`,
    "",
    `Package fingerprint: \`${left.manifest.packageHash}\``,
    `Code source hashes: \`${left.manifest.codeVersion.sourceHash}\` -> \`${right.manifest.codeVersion.sourceHash}\`${left.manifest.codeVersion.sourceHash === right.manifest.codeVersion.sourceHash ? "" : " (different source revisions)"}`,
    "",
    ...(uncontrolled.length === 0
      ? [
          "Comparison is **controlled**: every run input except the code revision matches, so the deltas below are attributable to the code change.",
        ]
      : [
          `Comparison is **uncontrolled**: ${uncontrolled.map((key) => `\`${key}\``).join(", ")} differ between these runs, so the deltas below are observations, not attributions. A scenario, player profile, or roll-seed change moves these numbers on its own.`,
        ]),
    "",
    "| Candidate slot / language / repetition | Left candidate | Right candidate | Left technical / quality | Right technical / quality | Candidate cost | Candidate provider latency |",
    "|---|---|---|---|---|---:|---:|",
  ];
  for (const key of keys) {
    const a = leftJobs.get(key)!;
    const b = rightJobs.get(key)!;
    const coordinate = `${a.candidateIndex + 1} / ${a.language} / ${a.repetition}`;
    lines.push(
      `| ${coordinate} | ${a.candidateLabel} | ${b.candidateLabel} | ${a.technicalStatus} / ${a.qualityStatus} | ${b.technicalStatus} / ${b.qualityStatus} | $${a.candidate.costUsd.toFixed(6)} -> $${b.candidate.costUsd.toFixed(6)} | ${a.candidate.averageProviderDurationMs.toFixed(1)} ms -> ${b.candidate.averageProviderDurationMs.toFixed(1)} ms |`,
    );
  }

  // Whether a structural fix actually removed a repair cause is only visible
  // across runs, so the delta per rule belongs in the comparison.
  const leftRanked = new Map(rankDomainRepairCauses(left.jobs).map((entry) => [entry.key, entry]));
  const rightRanked = new Map(
    rankDomainRepairCauses(right.jobs).map((entry) => [entry.key, entry]),
  );
  const ruleKeys = [...new Set([...leftRanked.keys(), ...rightRanked.keys()])].sort();
  const leftTurns = totalTurnsCompleted(left.jobs);
  const rightTurns = totalTurnsCompleted(right.jobs);
  if (ruleKeys.length > 0) {
    // Share of turns is the regression signal. Absolute repair counts move with
    // run length and with how many turns were checked, so a rule that went from
    // silent to firing every turn can look like an unremarkable increase.
    const rows = ruleKeys
      .map((key) => {
        const leftEntry = leftRanked.get(key);
        const rightEntry = rightRanked.get(key);
        const leftShare = leftEntry ? ruleShareOfTurns(leftEntry, leftTurns) : 0;
        const rightShare = rightEntry ? ruleShareOfTurns(rightEntry, rightTurns) : 0;
        return { key, leftEntry, rightEntry, leftShare, rightShare };
      })
      .sort(
        (a, b) =>
          b.rightShare - b.leftShare - (a.rightShare - a.leftShare) || a.key.localeCompare(b.key),
      );
    lines.push(
      "",
      "## Domain-repair causes by share of turns",
      "",
      `Ranked by the change in share of turns, worst regression first. Left played ${leftTurns} turns, right played ${rightTurns}.`,
      "",
      "| Rule | Left turns | Left share | Right turns | Right share | Share delta | Repairs |",
      "| --- | ---: | ---: | ---: | ---: | ---: | ---: |",
      ...rows.map((row) => {
        const shareDelta = row.rightShare - row.leftShare;
        const leftCount = row.leftEntry?.count ?? 0;
        const rightCount = row.rightEntry?.count ?? 0;
        return `| \`${row.key}\` | ${row.leftEntry?.turns ?? 0} | ${formatShare(row.leftShare)} | ${row.rightEntry?.turns ?? 0} | ${formatShare(row.rightShare)} | ${shareDelta >= 0 ? "+" : ""}${formatShare(shareDelta)} | ${leftCount} -> ${rightCount} |`;
      }),
    );
  }

  // Scoring both sides against the same criteria is what makes a run reviewable
  // on its own terms instead of only relative to the previous one.
  const leftScore = scorePlaytestAcceptance(left.jobs);
  const rightScore = scorePlaytestAcceptance(right.jobs);
  lines.push(
    "",
    "## Acceptance",
    "",
    `Left: **${leftScore.accepted ? "meets" : "does not meet"}** the criteria. Right: **${rightScore.accepted ? "meets" : "does not meet"}** the criteria.`,
    "",
    "| Criterion | Bar | Left | Right |",
    "| --- | --- | --- | --- |",
    ...leftScore.criteria.map((criterion, index) => {
      const other = rightScore.criteria[index]!;
      return `| ${criterion.label} | ${criterion.bar} | ${criterion.observed} (${criterion.verdict}) | ${other.observed} (${other.verdict}) |`;
    }),
  );
  return { left, right, markdown: `${lines.join("\n")}\n` };
}
