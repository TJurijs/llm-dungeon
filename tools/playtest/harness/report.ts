import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { atomicWriteText } from "../../../src/persistence/files.js";
import type { ModelTechnicalGameplayStatus } from "../../../src/model-status.js";
import {
  CandidateTechnicalSnapshotSchema,
  type CandidateTechnicalSnapshot,
} from "./assessment.js";
import {
  FailureOwnerSchema,
  PlaytestCallRecordSchema,
  PlaytestTurnRecordSchema,
  type FailureOwner,
  type PlaytestCallRecord,
  type PlaytestManifest,
  type PlaytestTurnRecord,
} from "./contracts.js";
import { readPlaytestJsonLines } from "./files.js";
import { readPlaytestManifest } from "./manifest.js";

const CoverageAssessmentArtifactSchema = z.object({
  deterministicPassed: z.boolean(),
  passed: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  requiresJudge: z.number().int().nonnegative(),
  notExercised: z.number().int().nonnegative().default(0),
  entries: z.array(z.object({
    requirementId: z.string().min(1),
    mode: z.enum(["deterministic", "judge"]),
    status: z.enum(["passed", "failed", "requires_judge", "not_exercised"]),
    evidence: z.string(),
  }).strict()),
}).strict();

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
    transient: number;
    domain: number;
  };
  failureOwners: Partial<Record<FailureOwner, number>>;
  failureFingerprints: Array<{ fingerprint: string; count: number }>;
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
  technicalReasons: string[];
  playerVisibleAverageMs: number;
  candidate: LaneMetrics;
  playerDriver: LaneMetrics;
  judge: LaneMetrics;
}

export interface PlaytestReportData {
  manifest: PlaytestManifest;
  jobs: PlaytestJobReport[];
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
  const repairs = { schema: 0, transient: 0, domain: 0 };
  const failureOwners: Partial<Record<FailureOwner, number>> = {};
  const fingerprints = new Map<string, number>();
  for (const call of calls) {
    if (call.repairKind) repairs[call.repairKind] += 1;
  }
  for (const call of failed) {
    increment(failureOwners, call.failureOwner ?? FailureOwnerSchema.parse("inconclusive"));
    if (call.failureFingerprint) {
      fingerprints.set(call.failureFingerprint, (fingerprints.get(call.failureFingerprint) ?? 0) + 1);
    }
  }
  return {
    calls: count,
    failures: failed.length,
    costUsd: round(calls.reduce((sum, call) => sum + call.estimatedCostUsd, 0)),
    failedCallCostUsd: round(failed.reduce((sum, call) => sum + call.estimatedCostUsd, 0)),
    inputTokens: calls.reduce((sum, call) => sum + (call.inputTokens ?? 0), 0),
    outputTokens: calls.reduce((sum, call) => sum + (call.outputTokens ?? 0), 0),
    averageCostWaitMs: round(count === 0 ? 0 : calls.reduce((sum, call) => sum + call.costWaitMs, 0) / count),
    averageQueueWaitMs: round(count === 0 ? 0 : calls.reduce((sum, call) => sum + call.queueWaitMs, 0) / count),
    averageProviderDurationMs: round(count === 0 ? 0 : calls.reduce((sum, call) => sum + call.providerDurationMs, 0) / count),
    retryBackoffMs: calls.reduce((sum, call) => sum + call.retryBackoffMs, 0),
    repairs,
    failureOwners,
    failureFingerprints: [...fingerprints]
      .map(([fingerprint, fingerprintCount]) => ({ fingerprint, count: fingerprintCount }))
      .sort((left, right) => left.fingerprint.localeCompare(right.fingerprint)),
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
  if (left === null || right === null || typeof left !== "object" || typeof right !== "object") return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left)
      && Array.isArray(right)
      && left.length === right.length
      && left.every((value, index) => sameValue(value, right[index]));
  }
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord).sort();
  const rightKeys = Object.keys(rightRecord).sort();
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key, index) => key === rightKeys[index] && sameValue(leftRecord[key], rightRecord[key]));
}

function candidateIndex(manifest: PlaytestManifest, job: PlaytestManifest["jobs"][number]): number {
  const index = manifest.config.candidates.findIndex((candidate) => sameValue(candidate, job.candidate));
  if (index < 0) throw new Error(`Playtest job ${job.id} references a candidate outside its run configuration`);
  return index;
}

export async function collectPlaytestReport(runDir: string): Promise<PlaytestReportData> {
  const manifest = await readPlaytestManifest(path.join(runDir, "manifest.json"));
  const jobs: PlaytestJobReport[] = [];
  for (const job of manifest.jobs) {
    const jobDir = path.join(runDir, "jobs", job.id);
    const [candidateCalls, playerCalls, judgeCalls, turns, technical, coverage] = await Promise.all([
      callsAt(path.join(jobDir, "calls", "candidate.jsonl")),
      callsAt(path.join(jobDir, "calls", "player-driver.jsonl")),
      callsAt(path.join(jobDir, "calls", "judge.jsonl")),
      readPlaytestJsonLines<PlaytestTurnRecord>(path.join(jobDir, "turns.jsonl"))
        .then((records) => PlaytestTurnRecordSchema.array().parse(records)),
      optionalTechnical(path.join(jobDir, "technical.json")),
      optionalCoverage(path.join(jobDir, "coverage.json")),
    ]);
    const completedTurns = turns.filter((turn) => turn.status === "completed");
    const checks = completedTurns.filter((turn) => turn.check !== undefined).length;
    const visible = turns.flatMap((turn) => turn.playerVisibleDurationMs === undefined
      ? []
      : [turn.playerVisibleDurationMs]);
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
      ...(technical ? { turnsRequired: technical.turnsRequired } : {}),
      turnsCompleted: completedTurns.length,
      checks,
      checkRate: round(completedTurns.length === 0 ? 0 : checks / completedTurns.length),
      invariantFailures: technical?.invariantFailures
        ?? completedTurns.filter((turn) => turn.invariantStatus !== "passed").length,
      ...(coverage ? {
        deterministicCoveragePassed: coverage.deterministicPassed,
        coveragePassed: coverage.passed,
        coverageFailed: coverage.failed,
        coverageRequiresJudge: coverage.requiresJudge,
        coverageNotExercised: coverage.notExercised,
      } : {}),
      failedCoverageRequirementIds: coverage?.entries
        .filter((entry) => entry.status === "failed")
        .map((entry) => entry.requirementId) ?? [],
      technicalReasons: technical?.reasons ?? [],
      playerVisibleAverageMs: round(visible.length === 0 ? 0 : visible.reduce((sum, value) => sum + value, 0) / visible.length),
      candidate: laneMetrics(candidateCalls),
      playerDriver: laneMetrics(playerCalls),
      judge: laneMetrics(judgeCalls),
    });
  }
  return { manifest, jobs };
}

function countLine(counts: Readonly<Record<string, number>>): string {
  const entries = Object.entries(counts).filter(([, count]) => count > 0).sort(([left], [right]) => left.localeCompare(right));
  return entries.length === 0 ? "none" : entries.map(([key, count]) => `${key}=${count}`).join(", ");
}

function laneLine(label: string, lane: LaneMetrics): string {
  return `${label}: ${lane.calls} calls, ${lane.failures} failures, $${lane.costUsd.toFixed(6)} total / $${lane.failedCallCostUsd.toFixed(6)} failed, ${lane.inputTokens} input / ${lane.outputTokens} output tokens, cost wait ${lane.averageCostWaitMs.toFixed(1)} ms, scheduler queue ${lane.averageQueueWaitMs.toFixed(1)} ms, provider ${lane.averageProviderDurationMs.toFixed(1)} ms, backoff ${lane.retryBackoffMs} ms`;
}

function laneDetails(label: string, lane: LaneMetrics): string[] {
  return [
    `  - ${label} repairs: schema=${lane.repairs.schema}, transient=${lane.repairs.transient}, domain=${lane.repairs.domain}`,
    `  - ${label} failure owners: ${countLine(lane.failureOwners)}`,
    `  - ${label} failure fingerprints: ${lane.failureFingerprints.length === 0 ? "none" : lane.failureFingerprints.map((entry) => `${entry.fingerprint} (${entry.count})`).join(", ")}`,
    `  - ${label} cost basis: reported usage=${lane.costBasisCounts.reportedUsage}, reserved estimate=${lane.costBasisCounts.reservedEstimate}`,
  ];
}

export function renderPlaytestReport(data: PlaytestReportData): string {
  const { manifest } = data;
  const sections = data.jobs.map((job) => [
    `## ${job.jobId} - ${job.candidateLabel} - ${job.language} - repetition ${job.repetition}`,
    "",
    `- Result: job **${job.jobStatus}**; technical **${job.technicalStatus}**; quality **${job.qualityStatus}**`,
    `- Frozen execution profile: \`${job.executionProfileFingerprint}\``,
    `- Turns: ${job.turnsCompleted}${job.turnsRequired === undefined ? "" : `/${job.turnsRequired}`}; checks: ${job.checks} (${(job.checkRate * 100).toFixed(1)}%); player-visible mean: ${job.playerVisibleAverageMs.toFixed(1)} ms`,
    `- Invariant failures: ${job.invariantFailures}`,
    `- Coverage: ${job.deterministicCoveragePassed === undefined ? "unavailable" : job.deterministicCoveragePassed ? "no deterministic failures" : "deterministic failures present"}${job.coveragePassed === undefined ? "" : ` (passed=${job.coveragePassed}, failed=${job.coverageFailed}, judge-only=${job.coverageRequiresJudge}, not-exercised=${job.coverageNotExercised ?? 0})`}`,
    ...(job.failedCoverageRequirementIds.length === 0 ? [] : [`- Failed coverage requirements: ${job.failedCoverageRequirementIds.join(", ")}`]),
    ...(job.technicalReasons.length === 0 ? [] : [`- Technical reasons: ${job.technicalReasons.join("; ")}`]),
    ...(job.stopReason ? [`- Stop reason: ${job.stopReason}${job.failureOwner ? `; failure owner: ${job.failureOwner}` : ""}`] : []),
    `- Latency evidence: **${job.latencyMode}**${job.latencyMode === "loaded" ? " (not canonical speed evidence)" : ""}`,
    `- ${laneLine("Candidate", job.candidate)}`,
    ...laneDetails("Candidate", job.candidate),
    `- ${laneLine("Player driver", job.playerDriver)}`,
    ...laneDetails("Player driver", job.playerDriver),
    `- ${laneLine("Independent judge", job.judge)}`,
    ...laneDetails("Independent judge", job.judge),
  ].join("\n"));
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
    "Candidate, player-driver, and judge lanes are intentionally reported separately. Judge and player-driver behavior is excluded from candidate technical status.",
    "",
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
    if (jobs.has(key)) throw new Error(`Playtest comparison found duplicate job coordinates for ${job.jobId}`);
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
      if (!sameSource) throw new Error("A model tuning comparison requires the same code/prompt source revision");
      if (leftTarget.config.provider === rightTarget.config.provider
        && leftTarget.config.model === rightTarget.config.model
        && leftTarget.route === rightTarget.route
        && leftTarget.executionProfileFingerprint === rightTarget.executionProfileFingerprint) {
        throw new Error("A model tuning comparison must change the candidate model selection");
      }
    } else if (kind === "adapter") {
      if (!sameSource) throw new Error("An adapter tuning comparison requires the same code/prompt source revision");
      if (leftTarget.config.provider !== rightTarget.config.provider
        || leftTarget.config.model !== rightTarget.config.model) {
        throw new Error("An adapter tuning comparison must keep the underlying provider/model fixed");
      }
      if (leftTarget.route === rightTarget.route
        && leftTarget.executionProfileFingerprint === rightTarget.executionProfileFingerprint) {
        throw new Error("An adapter tuning comparison must change the route or frozen execution profile");
      }
    } else if (kind === "prompt") {
      if (!sameValue(leftTarget, rightTarget)) {
        throw new Error("A prompt tuning comparison must keep the candidate model and execution profile fixed");
      }
      if (sameSource) throw new Error("A prompt tuning comparison requires distinct recorded source revisions");
    }
  }
}

export async function comparePlaytestRuns(leftRunDir: string, rightRunDir: string): Promise<PlaytestComparison> {
  const [left, right] = await Promise.all([
    collectPlaytestReport(leftRunDir),
    collectPlaytestReport(rightRunDir),
  ]);
  if (!sameValue(comparisonControls(left.manifest), comparisonControls(right.manifest))) {
    throw new Error("Playtest comparison requires the same package fingerprint, languages, rolls/seed, repetitions, player, judge, limits, and concurrency controls");
  }
  assertControlledTuningVariable(left.manifest, right.manifest);
  const leftJobs = comparisonJobs(left);
  const rightJobs = comparisonJobs(right);
  const keys = [...new Set([...leftJobs.keys(), ...rightJobs.keys()])].sort();
  if (keys.some((key) => !leftJobs.has(key) || !rightJobs.has(key))) {
    throw new Error("Playtest comparison requires matching candidate-slot, language, and repetition job coordinates");
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
    lines.push(`| ${coordinate} | ${a.candidateLabel} | ${b.candidateLabel} | ${a.technicalStatus} / ${a.qualityStatus} | ${b.technicalStatus} / ${b.qualityStatus} | $${a.candidate.costUsd.toFixed(6)} -> $${b.candidate.costUsd.toFixed(6)} | ${a.candidate.averageProviderDurationMs.toFixed(1)} ms -> ${b.candidate.averageProviderDurationMs.toFixed(1)} ms |`);
  }
  return { left, right, markdown: `${lines.join("\n")}\n` };
}
