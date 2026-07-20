import type { StateOperation } from "../../../src/schemas.js";
import type {
  CoverageRequirement,
  PlaytestPackage,
  PlaytestTurnRecord,
} from "./contracts.js";

export interface PlaytestMechanicalAudit {
  committedTurns: number;
  failedTurns: number[];
  checkedTurns: number[];
  assignedRolls: Record<string, number>;
  operationCounts: Record<string, number>;
  itemFlows: Array<{
    turn: number;
    kind: "transfer" | "inventory_delta";
    itemId: string;
    fromId?: string;
    toId?: string;
    ownerId?: string;
    quantity: number;
  }>;
  movements: Array<{ turn: number; targetId: string; locationId: string }>;
  timeAdvances: Array<{ turn: number; minutes: number; timeLabel: string }>;
  factWrites: Array<{ turn: number; targetId: string; section: string }>;
  relationshipWrites: Array<{ turn: number; sourceId: string; targetId: string }>;
  threadTransitions: Array<{ turn: number; threadId: string; status: "resolved" | "failed" }>;
  campaignEndings: Array<{ turn: number; status: "dead" | "ended"; reason: string }>;
  invariantFailures: number[];
}

export interface CoverageAssessmentEntry {
  requirementId: string;
  mode: CoverageRequirement["mode"];
  status: "passed" | "failed" | "requires_judge" | "not_exercised";
  evidence: string;
}

export interface CoverageAssessment {
  deterministicPassed: boolean;
  passed: number;
  failed: number;
  requiresJudge: number;
  notExercised: number;
  entries: CoverageAssessmentEntry[];
}

function completedOperations(turn: PlaytestTurnRecord | undefined): StateOperation[] {
  return turn?.status === "completed" ? turn.operations : [];
}

export function buildMechanicalAudit(turns: readonly PlaytestTurnRecord[]): PlaytestMechanicalAudit {
  const completed = turns.filter((turn) => turn.status === "completed");
  const operationCounts: Record<string, number> = {};
  const itemFlows: PlaytestMechanicalAudit["itemFlows"] = [];
  const movements: PlaytestMechanicalAudit["movements"] = [];
  const timeAdvances: PlaytestMechanicalAudit["timeAdvances"] = [];
  const factWrites: PlaytestMechanicalAudit["factWrites"] = [];
  const relationshipWrites: PlaytestMechanicalAudit["relationshipWrites"] = [];
  const threadTransitions: PlaytestMechanicalAudit["threadTransitions"] = [];
  const campaignEndings: PlaytestMechanicalAudit["campaignEndings"] = [];

  for (const turn of completed) {
    for (const operation of turn.operations) {
      operationCounts[operation.type] = (operationCounts[operation.type] ?? 0) + 1;
      switch (operation.type) {
        case "transfer_item":
          itemFlows.push({
            turn: turn.turn,
            kind: "transfer",
            itemId: operation.itemId,
            fromId: operation.fromId,
            toId: operation.toId,
            quantity: operation.quantity,
          });
          break;
        case "change_inventory":
          itemFlows.push({
            turn: turn.turn,
            kind: "inventory_delta",
            itemId: operation.itemId,
            ownerId: operation.ownerId,
            quantity: operation.quantityDelta,
          });
          break;
        case "move_entity":
          movements.push({ turn: turn.turn, targetId: operation.targetId, locationId: operation.locationId });
          break;
        case "advance_time":
          timeAdvances.push({ turn: turn.turn, minutes: operation.minutes, timeLabel: operation.timeLabel });
          break;
        case "add_fact":
          factWrites.push({ turn: turn.turn, targetId: operation.targetId, section: operation.section });
          break;
        case "set_relationship":
          relationshipWrites.push({ turn: turn.turn, sourceId: operation.sourceId, targetId: operation.targetId });
          break;
        case "resolve_thread":
          threadTransitions.push({ turn: turn.turn, threadId: operation.threadId, status: operation.status });
          break;
        case "end_campaign":
          campaignEndings.push({ turn: turn.turn, status: operation.status, reason: operation.reason });
          break;
        default:
          break;
      }
    }
  }

  return {
    committedTurns: completed.length,
    failedTurns: turns.filter((turn) => turn.status === "failed").map((turn) => turn.turn),
    checkedTurns: completed.filter((turn) => turn.check !== undefined).map((turn) => turn.turn),
    assignedRolls: Object.fromEntries(turns.map((turn) => [String(turn.turn), turn.assignedNaturalRoll])),
    operationCounts,
    itemFlows,
    movements,
    timeAdvances,
    factWrites,
    relationshipWrites,
    threadTransitions,
    campaignEndings,
    invariantFailures: completed
      .filter((turn) => turn.invariantStatus !== "passed")
      .map((turn) => turn.turn),
  };
}

function deterministicResult(
  requirement: Extract<CoverageRequirement, { mode: "deterministic" }>,
  turnsByNumber: ReadonlyMap<number, PlaytestTurnRecord>,
): { passed: boolean; evidence: string } {
  const rule = requirement.rule;
  const turn = "turn" in rule ? turnsByNumber.get(rule.turn) : undefined;
  const operations = completedOperations(turn);

  switch (rule.kind) {
    case "check_policy": {
      if (!turn || turn.status !== "completed") return { passed: false, evidence: `turn ${rule.turn} did not complete` };
      const checked = turn.check !== undefined;
      const passed = rule.policy === "context_dependent"
        || (rule.policy === "required" ? checked : !checked);
      return { passed, evidence: `turn ${rule.turn} check=${checked ? "present" : "absent"}; expected ${rule.policy}` };
    }
    case "natural_roll": {
      const actual = turn?.check?.roll;
      const passed = turn?.assignedNaturalRoll === rule.roll && actual === rule.roll;
      return { passed, evidence: `turn ${rule.turn} assigned=${turn?.assignedNaturalRoll ?? "missing"}, used=${actual ?? "missing"}, expected=${rule.roll}` };
    }
    case "failure_campaign_status": {
      const actual = turn?.check?.spec.failureCampaignStatus;
      return {
        passed: actual === rule.status,
        evidence: `turn ${rule.turn} failure campaign status=${actual ?? "missing"}; expected=${rule.status}`,
      };
    }
    case "operation_type": {
      const count = operations.filter((operation) => operation.type === rule.operationType).length;
      const passed = count >= rule.minimum && (rule.maximum === undefined || count <= rule.maximum);
      return { passed, evidence: `turn ${rule.turn} ${rule.operationType} count=${count}` };
    }
    case "operation_count": {
      const count = operations.length;
      return {
        passed: count >= rule.minimum && count <= rule.maximum,
        evidence: `turn ${rule.turn} operation count=${count}; expected ${rule.minimum}..${rule.maximum}`,
      };
    }
    case "transfer_item": {
      const transfer = operations.find((operation) =>
        operation.type === "transfer_item"
        && operation.itemId === rule.itemId
        && operation.fromId === rule.fromId
        && operation.toId === rule.toId
        && operation.quantity >= rule.minimumQuantity);
      return { passed: transfer !== undefined, evidence: transfer ? `turn ${rule.turn} contains the conserved transfer` : `turn ${rule.turn} is missing the conserved transfer` };
    }
    case "advance_time": {
      const minutes = operations.reduce((total, operation) =>
        total + (operation.type === "advance_time" ? operation.minutes : 0), 0);
      return { passed: minutes >= rule.minimumMinutes, evidence: `turn ${rule.turn} advances ${minutes} minutes` };
    }
    case "move_entity": {
      const move = operations.some((operation) =>
        operation.type === "move_entity"
        && operation.targetId === rule.targetId
        && operation.locationId === rule.locationId);
      return { passed: move, evidence: move ? `turn ${rule.turn} contains the required movement` : `turn ${rule.turn} is missing the required movement` };
    }
    case "fact_section": {
      const fact = operations.some((operation) =>
        operation.type === "add_fact"
        && operation.targetId === rule.targetId
        && operation.section === rule.section);
      return { passed: fact, evidence: fact ? `turn ${rule.turn} persists ${rule.section} on ${rule.targetId}` : `turn ${rule.turn} lacks required ${rule.section} fact` };
    }
    case "relationship_update": {
      const relationship = operations.some((operation) =>
        operation.type === "set_relationship"
        && operation.sourceId === rule.sourceId
        && operation.targetId === rule.targetId);
      return { passed: relationship, evidence: relationship ? `turn ${rule.turn} updates the relationship` : `turn ${rule.turn} lacks the relationship update` };
    }
    case "thread_transition": {
      const transition = operations.some((operation) =>
        operation.type === "resolve_thread"
        && operation.threadId === rule.threadId
        && operation.status === rule.status);
      return { passed: transition, evidence: transition ? `turn ${rule.turn} transitions ${rule.threadId} to ${rule.status}` : `turn ${rule.turn} lacks the required thread transition` };
    }
    case "context_compaction": {
      const observation = turn?.contextObservation;
      if (!observation) return { passed: false, evidence: `turn ${rule.turn} has no context observation` };
      const narrationCompacted = !observation.fullNarrationTurns.includes(rule.excludedFullNarrationTurn);
      const durablePresent = rule.requiredDurableEntityIds.every((id) => observation.durableEntityIds.includes(id));
      return {
        passed: narrationCompacted && durablePresent,
        evidence: `turn ${rule.turn} compacted=${narrationCompacted}, durable references=${durablePresent}`,
      };
    }
    case "invariants": {
      const relevant = [...turnsByNumber.values()].filter((candidate) => candidate.turn <= rule.throughTurn);
      const passed = relevant.length > 0
        && relevant.every((candidate) => candidate.status === "completed" && candidate.invariantStatus === "passed");
      return { passed, evidence: `${relevant.filter((candidate) => candidate.invariantStatus === "passed").length}/${relevant.length} turns passed invariant checks` };
    }
  }
}

/** Deterministic coverage is final; semantic requirements remain explicitly pending for the judge. */
export function assessCoverage(
  playtestPackage: Pick<PlaytestPackage, "coverageRequirements">,
  turns: readonly PlaytestTurnRecord[],
  options: { legitimateTerminalTurn?: number } = {},
): CoverageAssessment {
  const turnsByNumber = new Map(turns.map((turn) => [turn.turn, turn]));
  const entries: CoverageAssessmentEntry[] = playtestPackage.coverageRequirements.map((requirement) => {
    const requiredTurn = requirement.mode === "judge"
      ? requirement.turn
      : "turn" in requirement.rule ? requirement.rule.turn : requirement.rule.throughTurn;
    if (requiredTurn !== undefined
      && options.legitimateTerminalTurn !== undefined
      && requiredTurn > options.legitimateTerminalTurn
      && !turnsByNumber.has(requiredTurn)) {
      return {
        requirementId: requirement.id,
        mode: requirement.mode,
        status: "not_exercised",
        evidence: `not exercised because the fixture ended legitimately on turn ${options.legitimateTerminalTurn}`,
      };
    }
    if (requirement.mode === "judge") {
      return {
        requirementId: requirement.id,
        mode: requirement.mode,
        status: "requires_judge",
        evidence: `semantic ${requirement.dimension} assessment is reserved for the separate judge call`,
      };
    }
    const result = deterministicResult(requirement, turnsByNumber);
    return {
      requirementId: requirement.id,
      mode: requirement.mode,
      status: result.passed ? "passed" : "failed",
      evidence: result.evidence,
    };
  });
  const passed = entries.filter((entry) => entry.status === "passed").length;
  const failed = entries.filter((entry) => entry.status === "failed").length;
  const requiresJudge = entries.filter((entry) => entry.status === "requires_judge").length;
  const notExercised = entries.filter((entry) => entry.status === "not_exercised").length;
  return { deterministicPassed: failed === 0, passed, failed, requiresJudge, notExercised, entries };
}
