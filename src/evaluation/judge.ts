import { z } from "zod";
import { languageInstruction, type LanguageCode } from "../language.js";
import { buildMechanicalAudit, type AuditedTurn } from "./audit.js";

export const SessionJudgmentSchema = z.object({
  verdict: z.enum(["excellent", "good", "mixed", "poor"]),
  overallScore: z.number().int().min(1).max(10),
  narrativeScore: z.number().int().min(1).max(10),
  agencyScore: z.number().int().min(1).max(10),
  persistenceScore: z.number().int().min(1).max(10),
  checksScore: z.number().int().min(1).max(10),
  technicalScore: z.number().int().min(1).max(10),
  turnAudits: z.array(z.object({
    turn: z.number().int().positive(),
    durableConsequences: z.array(z.object({
      consequence: z.string().min(1).max(1000),
      operationIndexes: z.array(z.number().int().nonnegative()).max(12),
      persistence: z.enum(["persisted", "missing", "contradicted"]),
    }).strict()).max(12),
  }).strict()).max(200),
  executiveSummary: z.string().min(1).max(4000),
  strengths: z.array(z.string().min(1).max(1000)).min(1).max(6),
  issues: z.array(z.object({
    severity: z.enum(["high", "medium", "low"]),
    category: z.enum(["persistence", "continuity", "agency", "checks", "pacing", "prose", "npcs", "sandbox", "secrets", "technical"]),
    evidence: z.string().min(1).max(2000),
    recommendation: z.string().min(1).max(2000),
  })).max(12),
  persistenceAssessment: z.string().min(1).max(3000),
  checkAssessment: z.string().min(1).max(3000),
  sandboxAssessment: z.string().min(1).max(3000),
  recommendedChanges: z.array(z.string().min(1).max(1000)).max(6),
});

export type SessionJudgment = z.infer<typeof SessionJudgmentSchema>;

export interface JudgeProfile {
  id: string;
  instruction: string;
}

export interface JudgeTurn extends AuditedTurn {
  action: string;
  approach: string;
  narration?: string | undefined;
  summary?: string | undefined;
  error?: string | undefined;
}

export interface TechnicalHealthStats {
  gameplayDmCalls: number;
  gameplayPlayerCalls: number;
  failedDmCalls: number;
  failedPlayerCalls: number;
  dmFailureRate: number;
  schemaRepairCalls: number;
  transientRetryCalls: number;
  domainRepairCalls: number;
  failedCallCostUsd: number;
}

export function judgmentSchemaFor(
  turns: JudgeTurn[],
  technicalHealth: TechnicalHealthStats,
): z.ZodType<SessionJudgment> {
  const completed = turns.filter((turn) => turn.status === "completed");
  const expected = completed.map((turn) => turn.turn).sort((left, right) => left - right);
  const operationsByTurn = new Map(completed.map((turn) => [turn.turn, turn.operations?.length ?? 0]));
  return SessionJudgmentSchema.superRefine((judgment, ctx) => {
    const actual = judgment.turnAudits.map((audit) => audit.turn).sort((left, right) => left - right);
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      ctx.addIssue({
        code: "custom",
        path: ["turnAudits"],
        message: `must contain exactly one audit for each completed turn: ${expected.join(", ") || "none"}`,
      });
    }
    for (const audit of judgment.turnAudits) {
      const operationCount = operationsByTurn.get(audit.turn);
      if (operationCount === undefined) continue;
      for (const [index, consequence] of audit.durableConsequences.entries()) {
        if (consequence.persistence === "persisted" && consequence.operationIndexes.length === 0) {
          ctx.addIssue({
            code: "custom",
            path: ["turnAudits", audit.turn, "durableConsequences", index, "operationIndexes"],
            message: "a persisted consequence must cite at least one committed operation index",
          });
        }
        if (consequence.operationIndexes.some((operationIndex) => operationIndex >= operationCount)) {
          ctx.addIssue({
            code: "custom",
            path: ["turnAudits", audit.turn, "durableConsequences", index, "operationIndexes"],
            message: `operation index must be between 0 and ${Math.max(operationCount - 1, 0)} for turn ${audit.turn}`,
          });
        }
      }
    }
    const hasPersistenceDefect = judgment.turnAudits.some((audit) =>
      audit.durableConsequences.some((consequence) => consequence.persistence !== "persisted"));
    if (hasPersistenceDefect && (judgment.persistenceScore > 8 || judgment.overallScore > 8 || judgment.verdict === "excellent")) {
      ctx.addIssue({
        code: "custom",
        path: ["persistenceScore"],
        message: "missing or contradicted durable consequences cap persistence and overall scores at 8 and forbid an excellent verdict",
      });
    }
    const highTechnicalFailure = technicalHealth.dmFailureRate >= 0.25 || technicalHealth.schemaRepairCalls >= 3;
    if (highTechnicalFailure && (judgment.overallScore > 8 || judgment.verdict === "excellent")) {
      ctx.addIssue({ code: "custom", path: ["overallScore"], message: "technical failures cap overall score at 8 and forbid an excellent verdict" });
    }
    if (technicalHealth.dmFailureRate >= 0.5 && judgment.overallScore > 6) {
      ctx.addIssue({ code: "custom", path: ["overallScore"], message: "a DM failure rate of at least 50% caps overall score at 6" });
    }
  });
}

export function judgeSystemPrompt(language: LanguageCode): string {
  return `You are an exacting quality judge for an LLM-driven persistent fantasy sandbox game.

Evaluate the completed game; do not continue its fiction. Inspect the entire transcript, every check and state operation,
and both the authoritative starting and final persistent states. Identify continuity errors, forgotten consequences, unsupported possessions, stale locations,
NPC inconsistencies, secret leaks, excessive or unfair checks, loss of player agency, weak sandbox behavior, pacing problems,
and repetitive prose. Cite concrete turn numbers in evidence. Distinguish actual defects from intentional setbacks or character death.
Routine movement, visible observation, ordinary unopposed conversation, and unsupported or unintelligible claims should normally resolve without checks.
A check rate above 50% is a warning, not an automatic defect: assess whether established danger or opposition justified each checked turn.
Helpful circumstances must have positive modifiers and hindering circumstances must have negative modifiers; report any reversal.
For adversarial profiles such as chaotic, do not penalize the player behavior itself. Judge whether the DM handles gibberish,
nonsensical actions, contradictions, and unsupported possessions gracefully without inventing intent, items, success, or arbitrary punishment.
Gibberish or unsupported claims alone must not manufacture danger, hostility, injury, time pressure, checks, or lethal escalation.
Committed transactions have already passed deterministic reference, conservation, and nonnegative-inventory validation.
Never claim that starting inventory was missing without checking the authoritative starting state and mechanical audit.
Compare every narrated outcome with that turn's committed operations. If an NPC's refusal, trust, hostility, ban, promise, cooperation, or durable intention would matter after restart but has no matching operation, report a persistence defect.
Audit every completed turn separately before scoring. Include even turns with no durable consequences. A bruise, chipped or broken teeth, bleeding, a fracture, poisoning, exhaustion, a swallowed harmful object, a lasting social response, movement, inventory change, or time passage is durable when the narration says it persists beyond the immediate sentence. Treat every end-of-turn location boundary crossing as durable even if the character returns on the following turn; verify that turn's operations, not only the final campaign location.
For every persisted consequence, cite the zero-based index of its matching operation in that turn. Mark it missing when no operation preserves it, and contradicted when the operations preserve a different outcome.
Technical retries and failed structured calls are part of product quality even when recovery succeeds. Always mention nonzero failures in a technical issue.
If at least 25% of gameplay DM calls failed or three or more repair/retry calls were required, the verdict cannot be excellent and the overall score cannot exceed 8. If at least 50% failed, the score cannot exceed 6.
Give actionable engineering or prompt recommendations, not advice to the fictional player.

${languageInstruction(language)}`;
}

function checkUsageStats(turns: JudgeTurn[]) {
  const completed = turns.filter((turn) => turn.status === "completed");
  const checkedTurns = completed.filter((turn) => turn.check).map((turn) => turn.turn);
  const uncheckedTurns = completed.filter((turn) => !turn.check).map((turn) => turn.turn);
  let longestConsecutiveCheckRun = 0;
  let currentRun = 0;
  for (const turn of completed) {
    currentRun = turn.check ? currentRun + 1 : 0;
    longestConsecutiveCheckRun = Math.max(longestConsecutiveCheckRun, currentRun);
  }
  return {
    completedTurns: completed.length,
    checks: checkedTurns.length,
    rate: completed.length ? checkedTurns.length / completed.length : 0,
    checkedTurns,
    uncheckedTurns,
    longestConsecutiveCheckRun,
  };
}

export function judgePrompt(
  profile: JudgeProfile,
  transcript: string,
  turns: JudgeTurn[],
  startingState: string,
  finalState: string,
  technicalHealth: TechnicalHealthStats,
): string {
  const mechanicalTurns = turns.map(({ narration: _narration, summary: _summary, ...turn }) => turn);
  const checkUsage = checkUsageStats(turns);
  const mechanicalAudit = buildMechanicalAudit(turns);
  return `PLAYER PROFILE
${profile.id}: ${profile.instruction}

DETERMINISTIC CHECK-USAGE SUMMARY
- Completed turns: ${checkUsage.completedTurns}
- Checks: ${checkUsage.checks}
- Check rate: ${(checkUsage.rate * 100).toFixed(1)}%
- Checked turns: ${checkUsage.checkedTurns.join(", ") || "none"}
- Unchecked turns: ${checkUsage.uncheckedTurns.join(", ") || "none"}
- Longest consecutive run of checked turns: ${checkUsage.longestConsecutiveCheckRun}

Use these exact counts. For each checked turn, verify that established danger or opposition made both outcomes consequential.

DETERMINISTIC TECHNICAL-HEALTH SUMMARY
- Gameplay DM calls: ${technicalHealth.gameplayDmCalls}
- Gameplay player calls: ${technicalHealth.gameplayPlayerCalls}
- Failed DM structured calls: ${technicalHealth.failedDmCalls} (${(technicalHealth.dmFailureRate * 100).toFixed(1)}%)
- Failed player structured calls: ${technicalHealth.failedPlayerCalls}
- Schema repair calls: ${technicalHealth.schemaRepairCalls}
- Transient provider retries: ${technicalHealth.transientRetryCalls}
- Domain transaction repair calls: ${technicalHealth.domainRepairCalls}
- Estimated cost of failed calls: $${technicalHealth.failedCallCostUsd.toFixed(4)}

FULL PLAYER-FACING TRANSCRIPT
${transcript}

TURN RECORDS WITH LOCKED CHECKS AND COMMITTED STATE OPERATIONS
${JSON.stringify(mechanicalTurns, null, 2)}

DETERMINISTIC MECHANICAL AUDIT
${JSON.stringify(mechanicalAudit, null, 2)}

AUTHORITATIVE STARTING DM STATE
${startingState}

FINAL PERSISTENT DM STATE
${finalState}

Compare starting state, committed operations, the mechanical audit, and final state before making continuity claims.
Return exactly one turnAudits entry for every completed turn, then a rigorous structured evaluation with separate 1–10 scores for narrative, agency, persistence, checks, and technical reliability, followed by an overall 1–10 score.`;
}

export function renderJudgment(
  sessionId: string,
  profile: JudgeProfile,
  judgment: SessionJudgment,
  provider: string,
  model: string,
  technicalHealth: TechnicalHealthStats,
): string {
  const strengths = judgment.strengths.map((strength) => `- ${strength}`).join("\n");
  const issues = judgment.issues.map((issue) =>
    `- **${issue.severity} / ${issue.category}:** ${issue.evidence}\n  - Recommendation: ${issue.recommendation}`,
  ).join("\n");
  const changes = judgment.recommendedChanges.map((change) => `- ${change}`).join("\n");
  const audits = judgment.turnAudits.map((audit) => {
    const consequences = audit.durableConsequences.map((consequence) =>
      `  - **${consequence.persistence}:** ${consequence.consequence}${consequence.operationIndexes.length ? ` (operations ${consequence.operationIndexes.join(", ")})` : ""}`,
    ).join("\n") || "  - _No durable consequences narrated._";
    return `- **Turn ${audit.turn}**\n${consequences}`;
  }).join("\n");
  return `# AI Game Evaluation: ${sessionId}

- Judge: **${provider}/${model}**
- Player profile: **${profile.id}**
- Verdict: **${judgment.verdict}**
- Overall score: **${judgment.overallScore}/10**

| Dimension | Score |
|---|---:|
| Narrative | ${judgment.narrativeScore}/10 |
| Agency | ${judgment.agencyScore}/10 |
| Persistence | ${judgment.persistenceScore}/10 |
| Checks | ${judgment.checksScore}/10 |
| Technical reliability | ${judgment.technicalScore}/10 |

## Technical reliability

- Gameplay DM calls: ${technicalHealth.gameplayDmCalls}
- Failed DM structured calls: ${technicalHealth.failedDmCalls} (${(technicalHealth.dmFailureRate * 100).toFixed(1)}%)
- Schema repair calls: ${technicalHealth.schemaRepairCalls}
- Transient provider retries: ${technicalHealth.transientRetryCalls}
- Domain transaction repair calls: ${technicalHealth.domainRepairCalls}
- Estimated cost of failed calls: $${technicalHealth.failedCallCostUsd.toFixed(4)}

## Executive summary

${judgment.executiveSummary}

## Strengths

${strengths}

## Issues

${issues || "_No material issues identified._"}

## Persistence and continuity

${judgment.persistenceAssessment}

### Turn-by-turn persistence audit

${audits || "_No committed turns._"}

## Checks and adjudication

${judgment.checkAssessment}

## Sandbox play and agency

${judgment.sandboxAssessment}

## Recommended changes

${changes || "_No changes recommended._"}
`;
}
