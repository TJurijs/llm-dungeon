import { z } from "zod";
import { languageInstruction, type LanguageCode } from "../language.js";
import { CHECK_DIFFICULTY_POLICY, CURRENT_STATE_RECONCILIATION } from "../prompts.js";
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
    for (const [auditIndex, audit] of judgment.turnAudits.entries()) {
      const operationCount = operationsByTurn.get(audit.turn);
      if (operationCount === undefined) continue;
      for (const [index, consequence] of audit.durableConsequences.entries()) {
        if (consequence.persistence !== "missing" && consequence.operationIndexes.length === 0) {
          ctx.addIssue({
            code: "custom",
            path: ["turnAudits", auditIndex, "durableConsequences", index, "operationIndexes"],
            message: `a ${consequence.persistence} consequence must cite at least one committed operation index`,
          });
        }
        if (consequence.persistence === "missing" && consequence.operationIndexes.length > 0) {
          ctx.addIssue({
            code: "custom",
            path: ["turnAudits", auditIndex, "durableConsequences", index, "operationIndexes"],
            message: "a missing consequence cannot cite a committed operation index",
          });
        }
        if (consequence.operationIndexes.some((operationIndex) => operationIndex >= operationCount)) {
          ctx.addIssue({
            code: "custom",
            path: ["turnAudits", auditIndex, "durableConsequences", index, "operationIndexes"],
            message: `operation index must be between 0 and ${Math.max(operationCount - 1, 0)} for turn ${audit.turn}`,
          });
        }
      }
      const coveredOperations = new Set(
        audit.durableConsequences.flatMap((consequence) =>
          consequence.persistence === "missing" ? [] : consequence.operationIndexes),
      );
      const omittedOperations = Array.from(
        { length: operationCount },
        (_, operationIndex) => operationIndex,
      ).filter((operationIndex) => !coveredOperations.has(operationIndex));
      if (omittedOperations.length > 0) {
        ctx.addIssue({
          code: "custom",
          path: ["turnAudits", auditIndex, "durableConsequences"],
          message: `must audit every committed operation index for turn ${audit.turn}; missing ${omittedOperations.join(", ")}`,
        });
      }
    }
    const hasPersistenceDefect = judgment.turnAudits.some((audit) =>
      audit.durableConsequences.some((consequence) => consequence.persistence !== "persisted"));
    const hasStateIssue = judgment.issues.some((issue) =>
      issue.category === "persistence" || issue.category === "continuity");
    const hasPersistenceIssue = judgment.issues.some((issue) => issue.category === "persistence");
    if (hasPersistenceDefect && (judgment.persistenceScore > 8 || judgment.overallScore > 8 || judgment.verdict === "excellent")) {
      ctx.addIssue({
        code: "custom",
        path: ["persistenceScore"],
        message: "missing or contradicted durable consequences cap persistence and overall scores at 8 and forbid an excellent verdict",
      });
    }
    if (hasPersistenceDefect && !hasStateIssue) {
      ctx.addIssue({
        code: "custom",
        path: ["issues"],
        message: "missing or contradicted durable consequences require a persistence or continuity issue",
      });
    }
    if (hasPersistenceIssue && !hasPersistenceDefect) {
      ctx.addIssue({
        code: "custom",
        path: ["turnAudits"],
        message: "every persistence issue must also appear as a missing or contradicted turn-audit consequence",
      });
    }
    const recoveryCalls = technicalHealth.schemaRepairCalls
      + technicalHealth.transientRetryCalls
      + technicalHealth.domainRepairCalls;
    const highTechnicalFailure = technicalHealth.dmFailureRate >= 0.25 || recoveryCalls >= 3;
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

Evaluate the completed game; do not continue its fiction.

AUDIT POLICY
- Compare the complete transcript and each turn's operations with the authoritative starting and final states.
- Identify continuity, persistence, ownership, location, NPC, secrecy, agency, sandbox, pacing, prose, check-calibration, and technical defects. Distinguish defects from intentional fictional setbacks.
- Player assertions and incoherent input do not establish facts or danger. For adversarial profiles, judge the DM's handling rather than penalizing the supplied player behavior.
- Preserve grammatical scope when auditing agency: asking whether a later action is possible, proposing a plan, or seeking advice does not authorize the DM to perform that later action for the player.
- For each completed turn, first perform a narration-to-state pass: enumerate every durable consequence in the action and narration even when no matching operation exists. Include movement or containment; item ownership, payments, losses, and loose objects; information recorded in durable items; statuses, conditions, facts, knowledge, relationships, commitments, thread progress, and time.
- Then perform an operations-to-narration pass: inspect every committed operation index, verify that narration caused it and final state reflects it, and cite that index in at least one turn-audit consequence. Never omit an operation from the audit.
- Operation indexes restart at 0 inside each turn. Use only the explicit operationIndex shown beside that turn's operation; never use a running index across the session.
- Finally perform a current-record pass: compare each affected entity's starting and final location, inventory, item state, status, conditions, current facts or intentions, relationships, and threads with the narrated end state. Flag mutually inconsistent fields and stale markers even when every emitted operation was valid.
- Treat descriptions as stable identity text. Flag a description that encodes mutable placement, ownership, activity, mood, or temporary condition and later contradicts authoritative state.
- Apply the restart test to every narrated consequence: if it should affect a future turn, require an appropriate committed operation in that same turn. Do not infer persistence from a summary or from a vaguely related operation; compare the material meaning.
- Require each consequence on its authoritative record: physical changes on the affected entity or location, ownership in inventory, learned information in player knowledge, and recorded content on the durable item. A player-knowledge fact does not persist objective world damage or item state.
- Compare persisted information at the same evidentiary strength: flag a clue, inference, rumor, or witness report rewritten as direct observation or proven causation.
- Check that new location parents represent actual physical containment, and that thread updates retain still-relevant objectives, participants, sources, places, objects, discoveries, constraints, and commitments instead of replacing history with only the newest event. Treat thread references as durable retrieval links rather than latest-scene cast lists.
- Inventory is conserved between known owners. If narration identifies both owners, require transfer_item; a one-sided change_inventory debit is not a persisted transfer. An owned item becoming loose must transfer to its location.
- Never invent an item's disposition to excuse an operation. If narration says an item is handed over, retained, damaged, consumed, held by someone, or left loose, require final ownership and item state to match exactly; absence of an explicit disposal is not consumption.
- An item explicitly put down, thrown, or left behind is loose at the containing location unless narration establishes another owner; it must not remain in the prior owner's inventory.
- If narration says a person takes, pockets, carries, or keeps an item, require that person—not the surrounding location—to own it at turn end. After any transfer, audit current facts, secrets, intentions, statuses, and relationships for stale claims that the former owner still carries or controls it.
- An offered or intended exchange is not a completed transfer. When an item is used, depleted, damaged, opened, or otherwise changed, audit its own final state as well as its quantity and owner.
- Reconstruct current state in turn order. When a resolved outcome explicitly changes or ends an existing state marker, require the corresponding reconciliation and flag stale current statuses, conditions, facts, relationships, or threads.
- Audit scene-wide state: if a fight, alarm, closure, restraint, pursuit, or other active situation ends, flag locations and entities whose status, condition, intention, secret, or current fact still says it is ongoing or expresses a now-contradicted motive.
- Compare narration and effects exactly for kind, severity, subject, and body location; a related but different wound, action, or participant is contradicted rather than persisted.
- Compare status with the entity's final narrated activity, major injuries or conditions, and social situation; flag stale interaction or activity labels, including healthy/intact/safe labels contradicted by current conditions. Require every time increment to be supported by narrated action, travel, recovery, or waiting.
- For every resolved or failed thread, inspect its related entities for current markers that still describe the former problem, and inspect the resulting scene for a new unresolved danger, custody, accusation, obligation, pursuit, or lead that requires an active thread.
- Before a thread resolves, require its final summary and references to include any new central participant, source, place, object, or conclusion established by the resolving turn; the lifecycle operation alone does not update retrieval links.
- Treat record_major_event as reserved for irreversible or campaign-shaping developments; flag routine tactical exchanges or incremental thread beats recorded as major events.
- Audit every completed turn, including turns with no durable changes. A persisted or contradicted consequence must cite at least one matching zero-based operation index; a missing consequence must cite none. Mark missing or contradicted effects explicitly.
- A turn with no committed operations and no narrated durable consequence still needs its turnAudits entry, but durableConsequences must be an empty array. Do not invent a "nothing changed" consequence and label it persisted with no operation index.
- Audit every starting active thread independently against the entire session. Do not let progress on one thread stand in for another, and flag a final thread that loses or replaces its original question, actionable discoveries, or still-relevant retrieval references without a narrated resolution.
- Committed transactions already passed deterministic structural checks. Verify claims against starting state and the mechanical audit before reporting a defect.
- A check-rate warning is evidence for review, not an automatic gameplay defect. Judge every action—not only emitted checks—against current resistance or danger and meaningful branching. Flag a directly resolved action when a consequential uncertain outcome such as an opposed physical attempt should have used the shared check. For emitted checks, also audit the calibration below, sign-correct and actually used modifiers, capability-bounded stakes, and proportionate consequences.
- Reject modifiers based on an irrelevant skill or on a circumstance contradicted by newer current state. Treat an outcome that only natural 100 can reach after modifiers as impossible rather than meaningfully uncertain.
- Technical retries and failed structured calls remain product-quality defects even when recovery succeeds. Always report nonzero technical failures.
- Before returning, make scores and verdict consistent with the audit: any missing or contradicted durable consequence requires a persistence or state-continuity issue, caps persistenceScore and overallScore at 8, and forbids verdict=excellent. A purely narrative or formatting continuity issue may coexist with correctly persisted operations; do not falsely mark an operation contradicted merely to report it.
- If at least 25% of gameplay DM calls failed or at least three repair/retry calls were required, the verdict cannot be excellent and overall score cannot exceed 8. At least 50% failure caps overall score at 6.
- Give actionable engineering or prompt recommendations, never advice to the fictional player.

${CURRENT_STATE_RECONCILIATION.title}
${CURRENT_STATE_RECONCILIATION.content}

${CHECK_DIFFICULTY_POLICY.title}
${CHECK_DIFFICULTY_POLICY.content}

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
  const mechanicalTurns = turns.map((turn) => ({
    ...turn,
    operations: turn.operations?.map((operation, operationIndex) => ({ operationIndex, operation })),
  }));
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

Compare each action and narration directly with its committed operations, then compare the reconstructed result with final state. The operationIndex values restart at 0 for every turn; cite only the explicit per-turn values shown above. Every committed operation index must appear in at least one turnAudits consequence. A narrated durable consequence with no matching operation must still appear and be marked missing; a conflicting operation or final record must be marked contradicted. Every persistence issue, and every continuity issue caused by a durable state mismatch, must also appear in the relevant turn audit as missing or contradicted. A prose or formatting continuity issue does not make an otherwise correct committed operation contradicted.
For a completed turn with zero operations and zero narrated durable consequences, return that turn's durableConsequences as []. A description that nothing changed is not a persisted consequence and must not be represented with an empty operationIndexes list.
Before emitting the response, run a final consistency pass: if any turn audit is missing or contradicted, include the matching issue, set persistenceScore and overallScore to at most 8, and do not return verdict=excellent.
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
