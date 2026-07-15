import type { SessionJudgment, TechnicalHealthStats } from "./judge.js";
import {
  PlayerApproachSchema,
  type CallRecord,
  type EvaluationTurnRecord,
  type PlayerProfile,
  type SessionMetrics,
} from "./contracts.js";
import { roundMoney } from "./cost.js";

export function technicalHealthStats(calls: CallRecord[]): TechnicalHealthStats {
  const gameplay = calls.filter((call) => !call.schemaName.endsWith("session_judgment"));
  const dm = gameplay.filter((call) => call.role === "dm");
  const player = gameplay.filter((call) => call.role === "player");
  const failedDmCalls = dm.filter((call) => !call.success).length;
  return {
    gameplayDmCalls: dm.length,
    gameplayPlayerCalls: player.length,
    failedDmCalls,
    failedPlayerCalls: player.filter((call) => !call.success).length,
    dmFailureRate: dm.length ? failedDmCalls / dm.length : 0,
    schemaRepairCalls: gameplay.filter((call) => call.schemaName.startsWith("repair_")).length,
    transientRetryCalls: gameplay.filter((call) => call.schemaName.startsWith("transient_retry_")).length,
    domainRepairCalls: gameplay.filter((call) => call.schemaName.includes("domain_repair_")).length,
    failedCallCostUsd: roundMoney(
      gameplay.filter((call) => !call.success).reduce((sum, call) => sum + call.estimatedCostUsd, 0),
    ),
  };
}

function emptyApproaches(): Record<string, number> {
  return Object.fromEntries(PlayerApproachSchema.options.map((approach) => [approach, 0]));
}

export function collectMetrics(
  sessionId: string,
  profile: PlayerProfile,
  status: SessionMetrics["status"],
  stopReason: SessionMetrics["stopReason"],
  calls: CallRecord[],
  turns: EvaluationTurnRecord[],
  entitiesAtEnd: number,
  factsAtEnd: number,
  campaignStatus: string,
  judgment: SessionJudgment | undefined,
  judgeStatus: SessionMetrics["judgeStatus"],
  error?: string,
): SessionMetrics {
  const checks = turns.flatMap((turn) => (turn.check ? [turn.check] : []));
  const completedTurns = turns.filter((turn) => turn.status === "completed").length;
  const successfulCalls = calls.filter((call) => call.success);
  const inputTokens = calls.reduce((sum, call) => sum + (call.usage?.inputTokens ?? 0), 0);
  const outputTokens = calls.reduce((sum, call) => sum + (call.usage?.outputTokens ?? 0), 0);
  const approachCounts = emptyApproaches();
  for (const turn of turns) approachCounts[turn.approach] = (approachCounts[turn.approach] ?? 0) + 1;
  const failedCalls = calls.filter((call) => !call.success);
  const repairCalls = calls.filter((call) => call.schemaName.startsWith("repair_"));
  const domainRepairCalls = calls.filter((call) => call.schemaName.includes("domain_repair_"));
  const failureFingerprints: Record<string, number> = {};
  for (const call of failedCalls) {
    const fingerprint = `${call.role}/${call.schemaName}/${call.failureKind ?? "unknown"}`;
    failureFingerprints[fingerprint] = (failureFingerprints[fingerprint] ?? 0) + 1;
  }
  const judgeHighIssues = judgment?.issues.filter((issue) => issue.severity === "high").length ?? 0;
  const qualityGatePassed = status === "completed"
    && failedCalls.length === 0
    && domainRepairCalls.length === 0
    && judgeStatus === "completed"
    && judgeHighIssues === 0;
  return {
    sessionId,
    profile: profile.id,
    status,
    stopReason,
    turnsCompleted: completedTurns,
    dmCalls: calls.filter((call) => call.role === "dm").length,
    playerCalls: calls.filter((call) => call.role === "player").length,
    failedCalls: failedCalls.length,
    schemaRepairCalls: repairCalls.length,
    transientRetryCalls: calls.filter((call) => call.schemaName.startsWith("transient_retry_")).length,
    domainRepairCalls: domainRepairCalls.length,
    domainRepairsExhausted: stopReason === "error" && domainRepairCalls.length ? 1 : 0,
    repairCallsSucceeded: repairCalls.filter((call) => call.success).length,
    repairCallsFailed: repairCalls.filter((call) => !call.success).length,
    failedCallCostUsd: roundMoney(failedCalls.reduce((sum, call) => sum + call.estimatedCostUsd, 0)),
    failureFingerprints,
    checks: checks.length,
    checkRate: completedTurns ? checks.length / completedTurns : 0,
    averageDifficulty: checks.length
      ? Math.round((checks.reduce((sum, check) => sum + check.spec.difficulty, 0) / checks.length) * 10) / 10
      : null,
    inputTokens,
    outputTokens,
    estimatedCostUsd: roundMoney(calls.reduce((sum, call) => sum + call.estimatedCostUsd, 0)),
    averageCallLatencyMs: successfulCalls.length
      ? Math.round(successfulCalls.reduce((sum, call) => sum + call.durationMs, 0) / successfulCalls.length)
      : 0,
    judgeStatus,
    ...(judgment ? { judgeScore: judgment.overallScore, judgeVerdict: judgment.verdict } : {}),
    judgeHighIssues,
    qualityGatePassed,
    approachCounts,
    entitiesAtEnd,
    factsAtEnd,
    campaignStatus,
    ...(error ? { error } : {}),
  };
}
