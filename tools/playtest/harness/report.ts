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
  example: string;
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
  const totals = new Map<string, { count: number; jobs: Set<string>; example: string }>();
  for (const job of jobs) {
    for (const lane of [job.candidate, job.playerDriver, job.judge, job.artifact]) {
      for (const { cause } of lane.domainRepairCauses) {
        const message = cause.errorMessage.replace(/\s+/gu, " ").trim();
        for (const key of violationKeys(cause.errorMessage)) {
          const entry = totals.get(key) ?? { count: 0, jobs: new Set<string>(), example: message };
          entry.count += 1;
          entry.jobs.add(job.jobId);
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
      example: entry.example,
    }))
    .sort((left, right) => right.count - left.count || left.key.localeCompare(right.key));
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

function domainRepairRankingSection(jobs: readonly PlaytestJobReport[]): string[] {
  const ranked = rankDomainRepairCauses(jobs);
  if (ranked.length === 0) return [];
  return [
    "## Domain-repair causes (ranked)",
    "",
    "Each row is one deterministic rule that forced a bounded correction. Rank order is the worklist: a rule near the top is a candidate for normalization, a clearer contract, or removal as a false invariant.",
    "",
    "| Rule | Repairs | Jobs | Example |",
    "| --- | ---: | ---: | --- |",
    ...ranked.map(
      (entry) =>
        `| \`${entry.key}\` | ${entry.count} | ${entry.jobs} | ${entry.example.slice(0, 160)} |`,
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
      `- Turns: ${job.turnsCompleted}/${job.turnsRequested} requested${job.turnsRequired === undefined ? "" : `; technical requirement: ${job.turnsRequired}`}; checks: ${job.checks} (${(job.checkRate * 100).toFixed(1)}%); player-visible mean: ${job.playerVisibleAverageMs.toFixed(1)} ms`,
      `- Invariant failures: ${job.invariantFailures}`,
      `- Coverage: ${job.deterministicCoveragePassed === undefined ? "unavailable" : job.deterministicCoveragePassed ? "no deterministic failures" : "deterministic failures present"}${job.coveragePassed === undefined ? "" : ` (passed=${job.coveragePassed}, failed=${job.coverageFailed}, judge-only=${job.coverageRequiresJudge}, not-exercised=${job.coverageNotExercised ?? 0})`}`,
      ...(job.failedCoverageRequirementIds.length === 0
        ? []
        : [`- Failed coverage requirements: ${job.failedCoverageRequirementIds.join(", ")}`]),
      ...(job.technicalReasons.length === 0
        ? []
        : [`- Technical reasons: ${job.technicalReasons.join("; ")}`]),
      `- Thread verdicts: unchanged=${job.threadAudit.unchanged}, progressed=${job.threadAudit.progressed}, closed=${job.threadAudit.closed}, unaudited=${job.threadAudit.omitted}, named-but-absent=${job.threadAudit.invented}`,
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

function comparisonControls(manifest: PlaytestManifest): unknown {
  const config = manifest.config;
  return {
    packageSnapshot: manifest.packageSnapshot,
    packageHash: manifest.packageHash,
    languages: config.languages,
    turns: config.turns,
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
  if (!sameValue(comparisonControls(left.manifest), comparisonControls(right.manifest))) {
    throw new Error(
      "Playtest comparison requires the same package fingerprint, languages, rolls/seed, repetitions, player, judge, limits, and concurrency controls",
    );
  }
  assertControlledTuningVariable(left.manifest, right.manifest);
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
  if (ruleKeys.length > 0) {
    lines.push(
      "",
      "## Domain-repair causes",
      "",
      "| Rule | Left repairs | Right repairs | Delta |",
      "| --- | ---: | ---: | ---: |",
      ...ruleKeys.map((key) => {
        const leftCount = leftRanked.get(key)?.count ?? 0;
        const rightCount = rightRanked.get(key)?.count ?? 0;
        const delta = rightCount - leftCount;
        return `| \`${key}\` | ${leftCount} | ${rightCount} | ${delta > 0 ? `+${delta}` : delta} |`;
      }),
    );
  }
  return { left, right, markdown: `${lines.join("\n")}\n` };
}
