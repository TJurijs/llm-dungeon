import { z } from "zod";
import { languageInstruction, type LanguageCode } from "../../../src/language.js";
import { CURRENT_STATE_RECONCILIATION } from "../../../src/prompts/blocks.js";
import { CHECK_DIFFICULTY_POLICY } from "../../../src/prompts/difficulty.js";
import { QualityDimensionSchema, type PlaytestPackage, type PlaytestTurnRecord } from "./contracts.js";
import type { CoverageAssessment, PlaytestMechanicalAudit } from "./audit.js";

export const PLAYTEST_JUDGE_RUBRIC_VERSION = 1 as const;

const RubricScoresSchema = z.object({
  narrative: z.number().int().min(1).max(10),
  agency: z.number().int().min(1).max(10),
  persistence: z.number().int().min(1).max(10),
  checks: z.number().int().min(1).max(10),
  sandbox: z.number().int().min(1).max(10),
  npcContinuity: z.number().int().min(1).max(10),
  secrecy: z.number().int().min(1).max(10),
  pacing: z.number().int().min(1).max(10),
  language: z.number().int().min(1).max(10),
}).strict();

export const PlaytestJudgmentSchema = z.object({
  rubricVersion: z.literal(PLAYTEST_JUDGE_RUBRIC_VERSION),
  qualityStatus: z.enum(["high", "medium", "low"]),
  overallScore: z.number().int().min(1).max(10),
  scores: RubricScoresSchema,
  executiveSummary: z.string().min(1).max(4_000),
  strengths: z.array(z.string().min(1).max(1_000)).max(8),
  issues: z.array(z.object({
    severity: z.enum(["high", "medium", "low"]),
    dimension: QualityDimensionSchema,
    evidence: z.string().min(1).max(2_000),
    recommendation: z.string().min(1).max(2_000),
  }).strict()).max(20),
  coverageJudgments: z.array(z.object({
    requirementId: z.string().min(1),
    passed: z.boolean(),
    evidence: z.string().min(1).max(2_000),
  }).strict()),
  turnAudits: z.array(z.object({
    turn: z.number().int().positive(),
    durableConsequences: z.array(z.object({
      consequence: z.string().min(1).max(1_000),
      operationIndexes: z.array(z.number().int().nonnegative()).max(40),
      persistence: z.enum(["persisted", "missing", "contradicted"]),
    }).strict()).max(40),
  }).strict()).max(200),
  narrativeAssessment: z.string().min(1).max(3_000),
  persistenceAssessment: z.string().min(1).max(3_000),
  checksAssessment: z.string().min(1).max(3_000),
  sandboxAndAgencyAssessment: z.string().min(1).max(3_000),
  continuityAndSecrecyAssessment: z.string().min(1).max(3_000),
  pacingAndLanguageAssessment: z.string().min(1).max(3_000),
  recommendedChanges: z.array(z.string().min(1).max(1_000)).max(8),
}).strict().superRefine((judgment, context) => {
  const expectedStatus = judgment.overallScore >= 8 ? "high" : judgment.overallScore >= 5 ? "medium" : "low";
  if (judgment.qualityStatus !== expectedStatus) {
    context.addIssue({
      code: "custom",
      path: ["qualityStatus"],
      message: `overall score ${judgment.overallScore} requires qualityStatus=${expectedStatus}`,
    });
  }
  const hasPersistenceDefect = judgment.turnAudits.some((audit) =>
    audit.durableConsequences.some((consequence) => consequence.persistence !== "persisted"));
  if (hasPersistenceDefect && (judgment.scores.persistence > 8 || judgment.overallScore > 8)) {
    context.addIssue({
      code: "custom",
      path: ["scores", "persistence"],
      message: "missing or contradicted durable consequences cap persistence and overall scores at 8",
    });
  }
});

export type PlaytestJudgment = z.infer<typeof PlaytestJudgmentSchema>;

/** Adds run-specific completeness checks without giving the judge technical authority. */
export function playtestJudgmentSchemaFor(
  playtestPackage: Pick<PlaytestPackage, "coverageRequirements">,
  turns: readonly PlaytestTurnRecord[],
): z.ZodType<PlaytestJudgment> {
  const completed = turns.filter((turn) => turn.status === "completed");
  const expectedTurns = completed.map((turn) => turn.turn).sort((left, right) => left - right);
  const operationCounts = new Map(completed.map((turn) => [turn.turn, turn.operations.length]));
  const expectedCoverage = playtestPackage.coverageRequirements
    .filter((requirement) => requirement.mode === "judge")
    .map((requirement) => requirement.id)
    .sort();

  return PlaytestJudgmentSchema.superRefine((judgment, context) => {
    const actualTurns = judgment.turnAudits.map((audit) => audit.turn).sort((left, right) => left - right);
    if (JSON.stringify(actualTurns) !== JSON.stringify(expectedTurns)) {
      context.addIssue({
        code: "custom",
        path: ["turnAudits"],
        message: `must contain exactly one audit for each completed turn: ${expectedTurns.join(", ") || "none"}`,
      });
    }
    const actualCoverage = judgment.coverageJudgments.map((entry) => entry.requirementId).sort();
    if (JSON.stringify(actualCoverage) !== JSON.stringify(expectedCoverage)) {
      context.addIssue({
        code: "custom",
        path: ["coverageJudgments"],
        message: `must assess each semantic coverage requirement exactly once: ${expectedCoverage.join(", ") || "none"}`,
      });
    }

    for (const [auditIndex, audit] of judgment.turnAudits.entries()) {
      const operationCount = operationCounts.get(audit.turn);
      if (operationCount === undefined) continue;
      for (const [consequenceIndex, consequence] of audit.durableConsequences.entries()) {
        if (consequence.persistence === "missing" && consequence.operationIndexes.length > 0) {
          context.addIssue({
            code: "custom",
            path: ["turnAudits", auditIndex, "durableConsequences", consequenceIndex, "operationIndexes"],
            message: "a missing consequence cannot cite a committed operation",
          });
        }
        if (consequence.persistence !== "missing" && consequence.operationIndexes.length === 0) {
          context.addIssue({
            code: "custom",
            path: ["turnAudits", auditIndex, "durableConsequences", consequenceIndex, "operationIndexes"],
            message: `a ${consequence.persistence} consequence must cite a committed operation`,
          });
        }
        if (consequence.operationIndexes.some((index) => index >= operationCount)) {
          context.addIssue({
            code: "custom",
            path: ["turnAudits", auditIndex, "durableConsequences", consequenceIndex, "operationIndexes"],
            message: `operation indexes for turn ${audit.turn} must be between 0 and ${Math.max(0, operationCount - 1)}`,
          });
        }
      }
      const covered = new Set(audit.durableConsequences.flatMap((consequence) =>
        consequence.persistence === "missing" ? [] : consequence.operationIndexes));
      const omitted = Array.from({ length: operationCount }, (_, index) => index)
        .filter((index) => !covered.has(index));
      if (omitted.length > 0) {
        context.addIssue({
          code: "custom",
          path: ["turnAudits", auditIndex, "durableConsequences"],
          message: `turn ${audit.turn} omits committed operation indexes ${omitted.join(", ")}`,
        });
      }
    }
  });
}

export function playtestJudgeSystemPrompt(language: LanguageCode): string {
  return `You are a separate, non-mutating quality judge for a persistent, narrative-first fantasy sandbox.

RUBRIC VERSION: ${PLAYTEST_JUDGE_RUBRIC_VERSION}

BOUNDARY
- Assess the supplied completed playtest. Never continue, alter, or mutate its fiction.
- Candidate identity is intentionally omitted. Do not guess it or favor any recognizable writing style.
- Candidate technical status was frozen before judging. Do not pass, fail, downgrade, or recompute technical status.
- Judge failures, latency, cost, retries, and repairs are judge telemetry only.
- Use deterministic coverage and mechanical counts exactly as supplied. Do not replace them with prose heuristics.

QUALITY RUBRIC
- Narrative: coherence, clarity, causal narration, and engaging but controlled detail.
- Agency: preserve player choice and resolve only the authorized primary action under pressure.
- Persistence: every durable narrated consequence is committed and survives in authoritative state.
- Checks: require d100 only for meaningful danger or opposition; stakes and consequences remain proportional.
- Sandbox: resist unsupported assertions without inventing state, arbitrary punishment, or railroading.
- NPC continuity: identities, knowledge, motives, promises, relationships, and current records remain consistent.
- Secrecy: hidden state is not leaked without a causally earned revelation.
- Pacing: routine, investigative, dangerous, and resolving beats receive appropriate space.
- Language: all player-facing prose is fluent and consistently uses the requested language.

AUTHORITATIVE CURRENT-STATE RECONCILIATION POLICY
${CURRENT_STATE_RECONCILIATION.content}

AUTHORITATIVE CHECK-DIFFICULTY POLICY
${CHECK_DIFFICULTY_POLICY.content}

AUDIT METHOD
- Audit every completed turn and every committed operation index. Operation indexes restart at zero each turn.
- A persisted or contradicted consequence cites its operation indexes. A missing consequence cites none.
- A turn with no durable consequence and no operations has an empty durableConsequences array.
- Compare transcript, actions, checks, operations, starting state, and final state. Current authoritative state outranks recent prose.
- Score quality only. Provider outages, account access, player-driver failures, application failures, and judge behavior are not candidate-quality defects.

${languageInstruction(language)}`;
}

export interface PlaytestJudgePromptInput {
  playtestPackage: Pick<PlaytestPackage, "id" | "version" | "purpose" | "coverageRequirements">;
  language: LanguageCode;
  transcript: string;
  turns: readonly PlaytestTurnRecord[];
  startingState: string;
  finalState: string;
  mechanicalAudit: PlaytestMechanicalAudit;
  coverage: CoverageAssessment;
  interval?: { fromTurn: number; throughTurn: number };
}

export function playtestJudgePrompt(input: PlaytestJudgePromptInput): string {
  const semanticRequirements = input.playtestPackage.coverageRequirements.filter((requirement) => requirement.mode === "judge");
  const turns = input.turns.map((turn) => ({
    ...turn,
    operations: turn.operations.map((operation, operationIndex) => ({ operationIndex, operation })),
  }));
  const interval = input.interval
    ? `${input.interval.fromTurn} through ${input.interval.throughTurn}`
    : "the complete playtest";
  return `PLAYTEST PACKAGE
${input.playtestPackage.id} v${input.playtestPackage.version} (${input.playtestPackage.purpose})
Judgment interval: ${interval}
Requested output language: ${input.language}

SEMANTIC COVERAGE REQUIREMENTS
${JSON.stringify(semanticRequirements, null, 2)}

DETERMINISTIC COVERAGE (AUTHORITATIVE)
${JSON.stringify(input.coverage, null, 2)}

DETERMINISTIC MECHANICAL AUDIT (AUTHORITATIVE)
${JSON.stringify(input.mechanicalAudit, null, 2)}

PLAYER-FACING TRANSCRIPT
${input.transcript}

TURN RECORDS WITH LOCKED CHECKS AND COMMITTED OPERATIONS
${JSON.stringify(turns, null, 2)}

AUTHORITATIVE STARTING STATE
${input.startingState}

AUTHORITATIVE FINAL STATE
${input.finalState}

Return one coverageJudgments entry for every semantic requirement and one turnAudits entry for every completed turn. In each turn audit, account for every committed operationIndex shown for that turn exactly once across durableConsequences; group multiple indexes only when they implement the same consequence. A turn with no operations has an empty durableConsequences array. Assess narrative, agency, persistence, checks, sandbox behavior, NPC continuity, secrecy, pacing, and language separately. The overall score maps deterministically to qualityStatus: 8–10 high, 5–7 medium, 1–4 low.`;
}

export function renderPlaytestJudgment(
  packageId: string,
  judgment: PlaytestJudgment,
  judgeProvider: string,
  judgeModel: string,
): string {
  const scoreRows = [
    ["Narrative", judgment.scores.narrative],
    ["Agency", judgment.scores.agency],
    ["Persistence", judgment.scores.persistence],
    ["Checks", judgment.scores.checks],
    ["Sandbox", judgment.scores.sandbox],
    ["NPC continuity", judgment.scores.npcContinuity],
    ["Secrecy", judgment.scores.secrecy],
    ["Pacing", judgment.scores.pacing],
    ["Language", judgment.scores.language],
  ].map(([dimension, score]) => `| ${dimension} | ${score}/10 |`).join("\n");
  const issues = judgment.issues.map((issue) =>
    `- **${issue.severity} / ${issue.dimension}:** ${issue.evidence}\n  - ${issue.recommendation}`)
    .join("\n") || "_No material quality issues._";
  const coverage = judgment.coverageJudgments.map((entry) =>
    `- ${entry.passed ? "PASS" : "FAIL"} \`${entry.requirementId}\`: ${entry.evidence}`)
    .join("\n") || "_No semantic coverage requirements._";
  return `# Playtest Judgment: ${packageId}

- Rubric: **v${judgment.rubricVersion}**
- Separate judge call: **${judgeProvider}/${judgeModel}**
- Quality: **${judgment.qualityStatus}**
- Overall score: **${judgment.overallScore}/10**

| Dimension | Score |
|---|---:|
${scoreRows}

## Executive summary

${judgment.executiveSummary}

## Semantic coverage

${coverage}

## Issues

${issues}

## Persistence

${judgment.persistenceAssessment}

## Checks

${judgment.checksAssessment}

## Sandbox and agency

${judgment.sandboxAndAgencyAssessment}

## NPC continuity and secrecy

${judgment.continuityAndSecrecyAssessment}

## Pacing and language

${judgment.pacingAndLanguageAssessment}
`;
}
