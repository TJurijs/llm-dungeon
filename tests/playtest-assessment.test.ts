import { describe, expect, it } from "vitest";
import { resolveCheck } from "../src/mechanics.js";
import { assessCoverage, buildMechanicalAudit } from "../tools/playtest/harness/audit.js";
import { assessPlaytest, buildCandidateTechnicalSnapshot } from "../tools/playtest/harness/assessment.js";
import {
  PlaytestCallRecordSchema,
  PlaytestTurnRecordSchema,
  type PlaytestCallRecord,
  type PlaytestTurnRecord,
} from "../tools/playtest/harness/contracts.js";
import {
  playtestJudgePrompt,
  playtestJudgeSystemPrompt,
  playtestJudgmentSchemaFor,
  renderPlaytestJudgment,
  type PlaytestJudgment,
} from "../tools/playtest/harness/judge.js";
import { CERTIFICATION_PACKAGE, CERTIFICATION_SCRIPT } from "../tools/playtest/harness/packages.js";

function check(turn: number, roll: number) {
  return resolveCheck({
    name: `Certification check ${turn}`,
    difficulty: 50,
    modifiers: [],
    successStakes: "The intended bounded result succeeds.",
    failureStakes: "The intended bounded result fails proportionally.",
    failureCampaignStatus: "none",
  }, roll);
}

function certificationTurns(): PlaytestTurnRecord[] {
  const operationsByTurn: Record<number, unknown[]> = {
    2: [
      { type: "transfer_item", fromId: "npc:mara-venn", toId: "player:hero", itemId: "item:moonleaf-tonic", quantity: 1 },
      { type: "transfer_item", fromId: "player:hero", toId: "npc:mara-venn", itemId: "item:silver-marks", quantity: 3 },
      { type: "set_relationship", sourceId: "npc:mara-venn", targetId: "player:hero", summary: "Trust strengthened by a fair purchase." },
      { type: "advance_time", minutes: 5, timeLabel: "Early evening" },
    ],
    5: [
      { type: "move_entity", targetId: "player:hero", locationId: "location:old-sluice" },
      { type: "advance_time", minutes: 20, timeLabel: "Rainy evening" },
    ],
    6: [{ type: "add_fact", targetId: "player:hero", section: "knowledge", factId: "generated:evidence", text: "The ledger bears Serik's violet ink." }],
    7: [{ type: "add_condition", targetId: "player:hero", condition: "Bruised shoulder from the counterweight" }],
    8: [{ type: "change_inventory", ownerId: "player:hero", itemId: "item:moonleaf-tonic", quantityDelta: -1 }],
    10: [{ type: "resolve_thread", threadId: "thread:missing-ledger-turn-0", outcome: "The ledger evidence settles Mara's promise.", status: "resolved" }],
  };
  return CERTIFICATION_SCRIPT.map((script) => PlaytestTurnRecordSchema.parse({
    turn: script.turn,
    scriptedTurnId: script.id,
    action: script.branches.at(-1)!.action.en,
    narration: `Resolved certification turn ${script.turn}.`,
    summary: `Turn ${script.turn} summary.`,
    playerVisibleDurationMs: 100,
    driver: "scripted",
    expectedCheckPolicy: script.checkPolicy,
    assignedNaturalRoll: script.naturalRoll,
    ...([3, 6, 7].includes(script.turn) ? { check: check(script.turn, script.naturalRoll) } : {}),
    operations: operationsByTurn[script.turn] ?? [],
    status: "completed",
    invariantStatus: "passed",
    ...(script.turn === 10 ? {
      contextObservation: {
        fullNarrationTurns: [9],
        summaryTurns: [2, 3, 4, 5, 6, 7, 8, 9],
        durableEntityIds: ["item:customs-ledger", "thread:missing-ledger-turn-0"],
      },
    } : {}),
  }));
}

function call(overrides: Partial<PlaytestCallRecord> = {}): PlaytestCallRecord {
  return PlaytestCallRecordSchema.parse({
    id: `call-${Math.random()}`,
    timestamp: new Date().toISOString(),
    jobId: "job-001",
    actor: "candidate",
    phase: "decision",
    sequence: 1,
    schemaName: "turn_decision_v1",
    provider: "fake",
    model: "candidate",
    route: "direct",
    executionProfileFingerprint: "profile",
    queueWaitMs: 0,
    providerDurationMs: 10,
    retryBackoffMs: 0,
    promptHash: "prompt",
    systemHash: "system",
    schemaHash: "schema",
    success: true,
    estimatedCostUsd: 0,
    ...(overrides.success === false ? { failureFingerprint: "f".repeat(64) } : {}),
    ...overrides,
  });
}

function validJudgment(turns: PlaytestTurnRecord[]): PlaytestJudgment {
  return {
    rubricVersion: 1,
    qualityStatus: "high",
    overallScore: 8,
    scores: {
      narrative: 8, agency: 8, persistence: 8, checks: 8, sandbox: 8,
      npcContinuity: 8, secrecy: 8, pacing: 8, language: 8,
    },
    executiveSummary: "The controlled game remained coherent and persistent.",
    strengths: ["The candidate maintained state authority."],
    issues: [],
    coverageJudgments: CERTIFICATION_PACKAGE.coverageRequirements
      .filter((requirement) => requirement.mode === "judge")
      .map((requirement) => ({ requirementId: requirement.id, passed: true, evidence: "Observed in the relevant turn." })),
    turnAudits: turns.map((turn) => ({
      turn: turn.turn,
      durableConsequences: turn.operations.map((_, operationIndex) => ({
        consequence: `Operation ${operationIndex} persisted.`,
        operationIndexes: [operationIndex],
        persistence: "persisted" as const,
      })),
    })),
    narrativeAssessment: "The narration followed causal order.",
    persistenceAssessment: "All durable consequences were committed.",
    checksAssessment: "Checks matched danger and opposition.",
    sandboxAndAgencyAssessment: "Unsupported claims were resisted while agency remained intact.",
    continuityAndSecrecyAssessment: "NPC promises and hidden facts remained consistent.",
    pacingAndLanguageAssessment: "Pacing and selected-language output were consistent.",
    recommendedChanges: [],
  };
}

describe("playtest deterministic assessment", () => {
  it("audits the complete certification script without narrative heuristics", () => {
    const turns = certificationTurns();
    const coverage = assessCoverage(CERTIFICATION_PACKAGE, turns);
    expect(coverage.deterministicPassed).toBe(true);
    expect(coverage.failed).toBe(0);
    expect(coverage.requiresJudge).toBeGreaterThan(0);
    const audit = buildMechanicalAudit(turns);
    expect(audit.committedTurns).toBe(10);
    expect(audit.checkedTurns).toEqual([3, 6, 7]);
    expect(audit.assignedRolls).toMatchObject({ "3": 100, "7": 1 });
    expect(audit.itemFlows).toHaveLength(3);
    expect(audit.invariantFailures).toEqual([]);
  });

  it("fails exact check, roll, state, and compaction coverage deterministically", () => {
    const turns = certificationTurns();
    turns[2] = PlaytestTurnRecordSchema.parse({ ...turns[2]!, check: undefined });
    turns[8] = PlaytestTurnRecordSchema.parse({ ...turns[8]!, operations: [{ type: "add_trait", targetId: "player:hero", trait: "teleportation" }] });
    turns[9] = PlaytestTurnRecordSchema.parse({ ...turns[9]!, contextObservation: undefined });
    const coverage = assessCoverage(CERTIFICATION_PACKAGE, turns);
    expect(coverage.deterministicPassed).toBe(false);
    expect(coverage.entries.find((entry) => entry.requirementId === "t3-check")?.status).toBe("failed");
    expect(coverage.entries.find((entry) => entry.requirementId === "t3-roll-100")?.status).toBe("failed");
    expect(coverage.entries.find((entry) => entry.requirementId === "t9-no-state")?.status).toBe("failed");
    expect(coverage.entries.find((entry) => entry.requirementId === "t10-compaction")?.status).toBe("failed");
  });

  it("separates valid terminal completion and missing coverage from candidate technical health", () => {
    const terminalTurns = certificationTurns().slice(0, 7);
    const terminalCoverage = assessCoverage(CERTIFICATION_PACKAGE, terminalTurns, {
      legitimateTerminalTurn: 7,
    });
    expect(terminalCoverage.deterministicPassed).toBe(true);
    expect(terminalCoverage.notExercised).toBeGreaterThan(0);
    expect(terminalCoverage.entries.find((entry) => entry.requirementId === "t8-consumption")?.status)
      .toBe("not_exercised");
    expect(buildCandidateTechnicalSnapshot({
      playtestPackage: CERTIFICATION_PACKAGE,
      adapterStatus: "calibrated",
      executionProfileCurrent: true,
      turns: terminalTurns,
      calls: [],
      coverage: terminalCoverage,
      evidenceComplete: true,
      legitimateTerminal: true,
    })).toMatchObject({
      status: "clean",
      turnsCompleted: 7,
      turnsRequired: 10,
      deterministicCoveragePassed: true,
    });

    const completedTurnsWithCoverageFailure = certificationTurns();
    completedTurnsWithCoverageFailure[8] = PlaytestTurnRecordSchema.parse({
      ...completedTurnsWithCoverageFailure[8]!,
      operations: [{ type: "add_trait", targetId: "player:hero", trait: "teleportation" }],
    });
    const failedCoverage = assessCoverage(CERTIFICATION_PACKAGE, completedTurnsWithCoverageFailure);
    expect(failedCoverage.deterministicPassed).toBe(false);
    expect(buildCandidateTechnicalSnapshot({
      playtestPackage: CERTIFICATION_PACKAGE,
      adapterStatus: "calibrated",
      executionProfileCurrent: true,
      turns: completedTurnsWithCoverageFailure,
      calls: [],
      coverage: failedCoverage,
      evidenceComplete: true,
    }).status).toBe("clean");
  });

  it("excludes judge, player, route, account, and application failures from candidate technical health", () => {
    const turns = certificationTurns();
    const coverage = assessCoverage(CERTIFICATION_PACKAGE, turns);
    const calls = [
      call(),
      call({ id: "route", success: false, failureKind: "network", failureOwner: "provider_route" }),
      call({ id: "retry", sequence: 2, repairKind: "transient" }),
      call({ id: "player", actor: "player_driver", phase: "player_action", success: false, failureKind: "provider", failureOwner: "player_driver" }),
      call({ id: "judge", actor: "judge", phase: "final_judge", success: false, failureKind: "provider", failureOwner: "judge" }),
      call({ id: "application", success: false, failureKind: "application", failureOwner: "application" }),
    ];
    const technical = buildCandidateTechnicalSnapshot({
      playtestPackage: CERTIFICATION_PACKAGE,
      adapterStatus: "calibrated",
      executionProfileCurrent: true,
      turns,
      calls,
      coverage,
      evidenceComplete: true,
    });
    expect(technical.status).toBe("clean");
    expect(technical.candidateOwnedFailures).toBe(0);
    expect(technical.transientRetries).toBe(1);
    expect(technical.excludedFailureCounts).toMatchObject({
      provider_route: 1,
      player_driver: 1,
      judge: 1,
      application: 1,
    });
  });

  it("marks candidate-owned failed turns unstable and external failed turns inconclusive", () => {
    const baseline = certificationTurns();
    const candidateTurns = [...baseline];
    candidateTurns[8] = PlaytestTurnRecordSchema.parse({
      ...candidateTurns[8]!, status: "failed", invariantStatus: "not_checked",
      failureOwner: "candidate_model", error: "invalid authoritative reference",
    });
    const candidate = buildCandidateTechnicalSnapshot({
      playtestPackage: CERTIFICATION_PACKAGE,
      adapterStatus: "calibrated",
      executionProfileCurrent: true,
      turns: candidateTurns,
      calls: [call()],
      coverage: assessCoverage(CERTIFICATION_PACKAGE, candidateTurns),
      evidenceComplete: true,
    });
    expect(candidate.status).toBe("unstable");
    expect(candidate.candidateOwnedFailedTurns).toBe(1);

    const externalTurns = [...baseline];
    externalTurns[8] = PlaytestTurnRecordSchema.parse({
      ...externalTurns[8]!, status: "failed", invariantStatus: "not_checked",
      failureOwner: "application", error: "filesystem failure",
    });
    const external = buildCandidateTechnicalSnapshot({
      playtestPackage: CERTIFICATION_PACKAGE,
      adapterStatus: "calibrated",
      executionProfileCurrent: true,
      turns: externalTurns,
      calls: [call()],
      coverage: assessCoverage(CERTIFICATION_PACKAGE, externalTurns),
      evidenceComplete: true,
    });
    expect(external.status).toBe("inconclusive");
    expect(external.externalFailedTurns).toBe(1);
  });

  it("keeps one bounded recovery passable while distinguishing it from a clean run", () => {
    const turns = certificationTurns();
    const technical = buildCandidateTechnicalSnapshot({
      playtestPackage: CERTIFICATION_PACKAGE,
      adapterStatus: "calibrated",
      executionProfileCurrent: true,
      turns,
      calls: [
        call({ id: "malformed", success: false, failureKind: "schema", failureOwner: "candidate_model" }),
        call({ id: "repaired", sequence: 2, repairKind: "schema" }),
      ],
      coverage: assessCoverage(CERTIFICATION_PACKAGE, turns),
      evidenceComplete: true,
    });

    expect(technical).toMatchObject({
      status: "playable_with_recovery",
      candidateOwnedFailures: 1,
      schemaRepairs: 1,
    });
  });

  it("keeps repeated successful bounded recoveries recoverable instead of unstable", () => {
    const turns = certificationTurns();
    const technical = buildCandidateTechnicalSnapshot({
      playtestPackage: CERTIFICATION_PACKAGE,
      adapterStatus: "calibrated",
      executionProfileCurrent: true,
      turns,
      calls: Array.from({ length: 5 }, (_, index) => call({
        id: `domain-repair-${index + 1}`,
        sequence: index + 1,
        repairKind: "domain",
      })),
      coverage: assessCoverage(CERTIFICATION_PACKAGE, turns),
      evidenceComplete: true,
    });

    expect(technical).toMatchObject({
      status: "playable_with_recovery",
      domainRepairs: 5,
      reasons: ["the candidate completed after 5 bounded recoveries"],
    });
  });

  it("freezes technical status across failed and rerun separate judgments", () => {
    const turns = certificationTurns();
    const coverage = assessCoverage(CERTIFICATION_PACKAGE, turns);
    const technical = buildCandidateTechnicalSnapshot({
      playtestPackage: CERTIFICATION_PACKAGE,
      adapterStatus: "calibrated",
      executionProfileCurrent: true,
      turns,
      calls: [call()],
      coverage,
      evidenceComplete: true,
    });
    const failedJudge = assessPlaytest("certification", technical, { status: "failed" });
    expect(failedJudge.technical).toEqual(technical);
    expect(failedJudge.qualityStatus).toBe("awaiting_judgment");

    const judgment = playtestJudgmentSchemaFor(CERTIFICATION_PACKAGE, turns).parse(validJudgment(turns));
    const completed = assessPlaytest("certification", technical, { status: "completed", judgment });
    expect(completed.technical).toEqual(technical);
    expect(completed.qualityStatus).toBe("high");
    const failedRerun = assessPlaytest("certification", technical, { status: "failed" }, completed.qualityStatus);
    expect(failedRerun.qualityStatus).toBe("awaiting_judgment");
    expect(assessPlaytest("stress", technical, { status: "completed", judgment }).qualityStatus).toBe("unrated");
  });

  it("uses the expanded blind rubric and complete operation/coverage audits", () => {
    const turns = certificationTurns();
    const coverage = assessCoverage(CERTIFICATION_PACKAGE, turns);
    const audit = buildMechanicalAudit(turns);
    const judgment = validJudgment(turns);
    expect(playtestJudgmentSchemaFor(CERTIFICATION_PACKAGE, turns).safeParse(judgment).success).toBe(true);
    expect(playtestJudgmentSchemaFor(CERTIFICATION_PACKAGE, turns).safeParse({
      ...judgment,
      coverageJudgments: judgment.coverageJudgments.slice(1),
    }).success).toBe(false);
    const system = playtestJudgeSystemPrompt("en");
    expect(system).toContain("technical status was frozen");
    expect(system).toContain("NPC continuity");
    const prompt = playtestJudgePrompt({
      playtestPackage: CERTIFICATION_PACKAGE,
      language: "en",
      transcript: "A blind candidate transcript.",
      turns,
      startingState: "Starting state",
      finalState: "Final state",
      mechanicalAudit: audit,
      coverage,
    });
    expect(prompt).not.toContain("gemini-3.5-flash");
    expect(prompt).toContain("DETERMINISTIC COVERAGE (AUTHORITATIVE)");
    expect(prompt).toContain("account for every committed operationIndex");
    expect(renderPlaytestJudgment("certification-v1", judgment, "fake-judge", "judge-model"))
      .toContain("NPC continuity");
  });
});
