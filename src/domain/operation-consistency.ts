import type { Entity, StateOperation } from "../schemas.js";

interface StateConsistencyIssue {
  code: "no_op_movement" | "conflicting_item_destination" | "multiple_inventory_owners" | "non_atomic_item_transfer";
  message: string;
}

function createdEntityLocation(operation: StateOperation, targetId: string): string | undefined {
  return operation.type === "create_entity" && operation.entity.id === targetId
    ? operation.entity.location
    : undefined;
}

function entityKind(operations: StateOperation[], entities: Map<string, Entity>, targetId: string): Entity["kind"] | undefined {
  const existing = entities.get(targetId)?.kind;
  if (existing) return existing;
  for (const operation of operations) {
    if (operation.type === "create_entity" && operation.entity.id === targetId) return operation.entity.kind;
  }
  return undefined;
}

function findDeterministicConsistencyIssues(
  operations: StateOperation[],
  entities: Map<string, Entity>,
): StateConsistencyIssue[] {
  const issues: StateConsistencyIssue[] = [];
  for (const operation of operations) {
    if (operation.type !== "move_entity") continue;
    const currentLocation = entities.get(operation.targetId)?.location
      ?? operations.map((candidate) => createdEntityLocation(candidate, operation.targetId)).find(Boolean);
    if (currentLocation === operation.locationId) {
      issues.push({
        code: "no_op_movement",
        message: `move_entity for ${operation.targetId} targets its current location ${operation.locationId}; create or reference the actual destination`,
      });
    }
  }
  const itemDestinations = new Map<string, { moved: boolean; positiveOwners: Set<string>; negativeOwners: Set<string>; transferred: boolean }>();
  for (const operation of operations) {
    if (operation.type === "move_entity" && entityKind(operations, entities, operation.targetId) === "item") {
      const state = itemDestinations.get(operation.targetId) ?? { moved: false, positiveOwners: new Set<string>(), negativeOwners: new Set<string>(), transferred: false };
      state.moved = true;
      itemDestinations.set(operation.targetId, state);
    }
    if (operation.type === "change_inventory") {
      const state = itemDestinations.get(operation.itemId) ?? { moved: false, positiveOwners: new Set<string>(), negativeOwners: new Set<string>(), transferred: false };
      if (operation.quantityDelta > 0) state.positiveOwners.add(operation.ownerId);
      if (operation.quantityDelta < 0) state.negativeOwners.add(operation.ownerId);
      itemDestinations.set(operation.itemId, state);
    }
    if (operation.type === "transfer_item") {
      const state = itemDestinations.get(operation.itemId) ?? { moved: false, positiveOwners: new Set<string>(), negativeOwners: new Set<string>(), transferred: false };
      state.positiveOwners.add(operation.toId);
      state.negativeOwners.add(operation.fromId);
      state.transferred = true;
      itemDestinations.set(operation.itemId, state);
    }
  }
  for (const [itemId, destination] of itemDestinations) {
    if (destination.moved && destination.positiveOwners.size) {
      issues.push({
        code: "conflicting_item_destination",
        message: `${itemId} is both moved to a location and added to inventory; choose exactly one physical destination`,
      });
    }
    if (destination.positiveOwners.size > 1) {
      issues.push({
        code: "multiple_inventory_owners",
        message: `${itemId} is added to multiple inventories in one turn; choose the entity that actually takes possession`,
      });
    }
    if (!destination.transferred && destination.positiveOwners.size && destination.negativeOwners.size) {
      issues.push({
        code: "non_atomic_item_transfer",
        message: `${itemId} is removed from one inventory and added to another with separate changes; use one transfer_item operation`,
      });
    }
  }
  return issues;
}

export function assertDeterministicConsistency(
  operations: StateOperation[],
  entities: Map<string, Entity>,
): void {
  const issues = findDeterministicConsistencyIssues(operations, entities);
  if (issues.length) {
    throw new Error(`State consistency validation failed:\n${issues.map((issue) => `- [${issue.code}] ${issue.message}`).join("\n")}`);
  }
}
