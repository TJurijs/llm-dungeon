import type { StateOperation } from "../schemas.js";
import type { CheckResult } from "../types.js";

export interface AuditedTurn {
  turn: number;
  status: "completed" | "failed";
  check?: CheckResult | undefined;
  operations?: StateOperation[] | undefined;
}

export interface MechanicalAudit {
  committedTurns: number;
  checkedTurns: number[];
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
  campaignEndings: Array<{ turn: number; status: "dead" | "ended"; reason: string }>;
  invariantStatus: "all_committed_transactions_validated";
}

export function buildMechanicalAudit(turns: AuditedTurn[]): MechanicalAudit {
  const completed = turns.filter((turn) => turn.status === "completed");
  const operationCounts: Record<string, number> = {};
  const itemFlows: MechanicalAudit["itemFlows"] = [];
  const campaignEndings: MechanicalAudit["campaignEndings"] = [];
  for (const turn of completed) {
    for (const operation of turn.operations ?? []) {
      operationCounts[operation.type] = (operationCounts[operation.type] ?? 0) + 1;
      if (operation.type === "transfer_item") {
        itemFlows.push({
          turn: turn.turn,
          kind: "transfer",
          itemId: operation.itemId,
          fromId: operation.fromId,
          toId: operation.toId,
          quantity: operation.quantity,
        });
      } else if (operation.type === "change_inventory") {
        itemFlows.push({
          turn: turn.turn,
          kind: "inventory_delta",
          itemId: operation.itemId,
          ownerId: operation.ownerId,
          quantity: operation.quantityDelta,
        });
      } else if (operation.type === "end_campaign") {
        campaignEndings.push({ turn: turn.turn, status: operation.status, reason: operation.reason });
      }
    }
  }
  return {
    committedTurns: completed.length,
    checkedTurns: completed.filter((turn) => turn.check).map((turn) => turn.turn),
    operationCounts,
    itemFlows,
    campaignEndings,
    invariantStatus: "all_committed_transactions_validated",
  };
}
