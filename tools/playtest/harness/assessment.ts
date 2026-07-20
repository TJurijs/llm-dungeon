import { z } from "zod";
import type { ModelAdapterStatus } from "../../../src/model-status.js";
import {
  QualityStatusSchema,
  TechnicalGameplayStatusSchema,
  type PlaytestCallRecord,
  type PlaytestPackage,
  type PlaytestTurnRecord,
  type QualityStatus,
  type TechnicalGameplayStatus,
} from "./contracts.js";
import type { CoverageAssessment } from "./audit.js";
import type { PlaytestJudgment } from "./judge.js";

export const CandidateTechnicalSnapshotSchema = z.object({
  status: TechnicalGameplayStatusSchema,
  evidenceComplete: z.boolean(),
  turnsRequired: z.number().int().nonnegative(),
  turnsCompleted: z.number().int().nonnegative(),
  candidateCalls: z.number().int().nonnegative(),
  candidateOwnedFailures: z.number().int().nonnegative(),
  candidateOwnedFailedTurns: z.number().int().nonnegative(),
  externalFailedTurns: z.number().int().nonnegative(),
  schemaRepairs: z.number().int().nonnegative(),
  transientRetries: z.number().int().nonnegative(),
  domainRepairs: z.number().int().nonnegative(),
  invariantFailures: z.number().int().nonnegative(),
  deterministicCoveragePassed: z.boolean(),
  excludedFailureCounts: z.record(z.string(), z.number().int().nonnegative()),
  reasons: z.array(z.string().min(1)),
}).strict();

export type CandidateTechnicalSnapshot = z.infer<typeof CandidateTechnicalSnapshotSchema>;

export interface CandidateTechnicalAssessmentInput {
  playtestPackage: Pick<PlaytestPackage, "purpose" | "turns" | "technicalRequirements">;
  adapterStatus: ModelAdapterStatus;
  executionProfileCurrent: boolean;
  turns: readonly PlaytestTurnRecord[];
  calls: readonly PlaytestCallRecord[];
  coverage: CoverageAssessment;
  /** False when an external failure prevented the candidate from producing required evidence. */
  evidenceComplete: boolean;
  /** A committed application-valid terminal result completes the fixture even when later coverage was not exercised. */
  legitimateTerminal?: boolean;
}

function excludedFailures(calls: readonly PlaytestCallRecord[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const call of calls) {
    if (call.success || call.failureOwner === "candidate_model") continue;
    const owner = call.failureOwner ?? "inconclusive";
    counts[owner] = (counts[owner] ?? 0) + 1;
  }
  return counts;
}

/**
 * Derives candidate technical health from candidate-owned evidence only.
 * Judge and player calls are deliberately excluded, including their repairs,
 * latency, cost, and failures.
 */
export function buildCandidateTechnicalSnapshot(
  input: CandidateTechnicalAssessmentInput,
): CandidateTechnicalSnapshot {
  const candidateCalls = input.calls.filter((call) => call.actor === "candidate");
  const candidateOwnedFailures = candidateCalls.filter((call) =>
    !call.success && call.failureOwner === "candidate_model").length;
  const schemaRepairs = candidateCalls.filter((call) => call.repairKind === "schema").length;
  const transientRetries = candidateCalls.filter((call) => call.repairKind === "transient").length;
  const domainRepairs = candidateCalls.filter((call) => call.repairKind === "domain").length;
  const completedTurns = input.turns.filter((turn) => turn.status === "completed").length;
  const candidateOwnedFailedTurns = input.turns.filter((turn) =>
    turn.status === "failed" && turn.failureOwner === "candidate_model").length;
  const externalFailedTurns = input.turns.filter((turn) =>
    turn.status === "failed" && turn.failureOwner !== "candidate_model").length;
  const invariantFailures = input.turns.filter((turn) =>
    turn.status === "completed" && turn.invariantStatus === "failed").length;
  const turnsRequired = input.playtestPackage.technicalRequirements.requireAllTurns
    ? input.playtestPackage.turns.default
    : Math.min(input.playtestPackage.turns.default, input.turns.length);
  const reasons: string[] = [];
  let status: TechnicalGameplayStatus;
  const totalRecoveries = schemaRepairs + domainRepairs;

  if (input.adapterStatus === "no_compatible_profile") {
    status = "unsupported";
    reasons.push("no compatible calibrated execution profile");
  } else if (input.adapterStatus !== "calibrated" || !input.executionProfileCurrent) {
    status = "inconclusive";
    reasons.push(input.adapterStatus !== "calibrated"
      ? `adapter status is ${input.adapterStatus}`
      : "the certification execution profile fingerprint is stale");
  } else if (!input.evidenceComplete || externalFailedTurns > 0) {
    status = "inconclusive";
    reasons.push("external failure prevented complete candidate evidence");
  } else {
    const requirements = input.playtestPackage.technicalRequirements;
    const incomplete = requirements.requireAllTurns && completedTurns < turnsRequired && !input.legitimateTerminal;
    const invariantsFailed = requirements.requireInvariantPass && invariantFailures > 0;
    if (incomplete || candidateOwnedFailedTurns > 0 || invariantsFailed) {
      status = "unstable";
      if (incomplete) reasons.push(`completed ${completedTurns}/${turnsRequired} required turns`);
      if (candidateOwnedFailedTurns > 0) reasons.push("bounded recovery did not produce a committable turn");
      if (invariantsFailed) reasons.push("one or more committed turns failed invariant validation");
    } else if (candidateOwnedFailures > 0 || totalRecoveries > 0) {
      status = "playable_with_recovery";
      reasons.push(`the candidate completed after ${totalRecoveries} bounded ${totalRecoveries === 1 ? "recovery" : "recoveries"}`);
    } else {
      status = "clean";
      reasons.push(input.legitimateTerminal
        ? "the fixture reached a valid terminal outcome without technical recovery"
        : "all required candidate evidence completed without recovery");
    }
  }

  return CandidateTechnicalSnapshotSchema.parse({
    status,
    evidenceComplete: input.evidenceComplete,
    turnsRequired,
    turnsCompleted: completedTurns,
    candidateCalls: candidateCalls.length,
    candidateOwnedFailures,
    candidateOwnedFailedTurns,
    externalFailedTurns,
    schemaRepairs,
    transientRetries,
    domainRepairs,
    invariantFailures,
    deterministicCoveragePassed: input.coverage.deterministicPassed,
    excludedFailureCounts: excludedFailures(input.calls),
    reasons,
  });
}

export interface JudgmentAttemptResult {
  status: "completed" | "failed" | "not_run";
  judgment?: PlaytestJudgment;
}

export interface PlaytestAssessment {
  technical: CandidateTechnicalSnapshot;
  qualityStatus: QualityStatus;
  judgmentStatus: JudgmentAttemptResult["status"];
}

/** Independent judging can add quality evidence but can never rewrite technical evidence. */
export function assessPlaytest(
  purpose: PlaytestPackage["purpose"],
  technical: CandidateTechnicalSnapshot,
  judgmentAttempt: JudgmentAttemptResult,
  _priorQualityStatus?: QualityStatus,
): PlaytestAssessment {
  let qualityStatus: QualityStatus;
  if (purpose !== "certification") {
    qualityStatus = "unrated";
  } else if (judgmentAttempt.status === "completed" && judgmentAttempt.judgment) {
    qualityStatus = judgmentAttempt.judgment.qualityStatus;
  } else {
    qualityStatus = "awaiting_judgment";
  }
  return {
    technical: structuredClone(technical),
    qualityStatus: QualityStatusSchema.parse(qualityStatus),
    judgmentStatus: judgmentAttempt.status,
  };
}
