import type { Entity, StateOperation } from "../schemas.js";
import { inventoryOwnershipSnapshot } from "./state-consistency.js";
import { rejectDomainChange } from "./validation-error.js";
import type { DomainViolationCollector } from "./violations.js";

interface StateConsistencyIssue {
  code:
    | "conflicting_item_destination"
    | "item_move_requires_inventory_transfer"
    | "multiple_inventory_owners"
    | "non_atomic_item_transfer"
    | "owned_item_credit_requires_transfer";
  message: string;
}

function closesInventoryCycle(
  ownerId: string,
  itemId: string,
  ownership: ReadonlyMap<string, ReadonlyMap<string, number>>,
): boolean {
  const inventoryByOwner = new Map<string, string[]>();
  for (const [ownedItemId, owners] of ownership) {
    for (const [candidateOwnerId, quantity] of owners) {
      if (quantity <= 0) continue;
      const inventory = inventoryByOwner.get(candidateOwnerId) ?? [];
      inventory.push(ownedItemId);
      inventoryByOwner.set(candidateOwnerId, inventory);
    }
  }
  const pending = [itemId];
  const visited = new Set<string>();
  while (pending.length) {
    const current = pending.pop()!;
    if (current === ownerId) return true;
    if (visited.has(current)) continue;
    visited.add(current);
    pending.push(...(inventoryByOwner.get(current) ?? []));
  }
  return false;
}

function entityKind(
  operations: StateOperation[],
  entities: Map<string, Entity>,
  targetId: string,
): Entity["kind"] | undefined {
  const existing = entities.get(targetId)?.kind;
  if (existing) return existing;
  for (const operation of operations) {
    if (operation.type === "create_entity" && operation.entity.id === targetId)
      return operation.entity.kind;
  }
  return undefined;
}

function findDeterministicConsistencyIssues(
  operations: StateOperation[],
  entities: Map<string, Entity>,
): StateConsistencyIssue[] {
  const issues: StateConsistencyIssue[] = [];
  const simulatedOwnership = inventoryOwnershipSnapshot(entities);
  const ownedCreditCandidates: Array<{
    ownerId: string;
    itemId: string;
    issue: StateConsistencyIssue;
  }> = [];
  const itemDestinations = new Map<
    string,
    {
      moved: boolean;
      positiveOwners: Set<string>;
      negativeOwners: Set<string>;
      transferred: boolean;
    }
  >();
  for (const operation of operations) {
    if (
      operation.type === "move_entity" &&
      entityKind(operations, entities, operation.targetId) === "item"
    ) {
      const state = itemDestinations.get(operation.targetId) ?? {
        moved: false,
        positiveOwners: new Set<string>(),
        negativeOwners: new Set<string>(),
        transferred: false,
      };
      state.moved = true;
      itemDestinations.set(operation.targetId, state);
    }
    if (operation.type === "change_inventory") {
      const owners = simulatedOwnership.get(operation.itemId) ?? new Map<string, number>();
      if (
        operation.quantityDelta > 0 &&
        [...owners.entries()].some(
          ([ownerId, quantity]) => ownerId !== operation.ownerId && quantity > 0,
        )
      ) {
        const existingOwners = [...owners.entries()]
          .filter(([ownerId, quantity]) => ownerId !== operation.ownerId && quantity > 0)
          .map(([ownerId]) => ownerId)
          .sort()
          .join(", ");
        ownedCreditCandidates.push({
          ownerId: operation.ownerId,
          itemId: operation.itemId,
          issue: {
            code: "owned_item_credit_requires_transfer",
            message: `${operation.itemId} is already owned by ${existingOwners}; crediting ${operation.ownerId} with change_inventory would duplicate known ownership, so use transfer_item from the existing owner`,
          },
        });
      }
      const nextQuantity = (owners.get(operation.ownerId) ?? 0) + operation.quantityDelta;
      if (nextQuantity > 0) owners.set(operation.ownerId, nextQuantity);
      else owners.delete(operation.ownerId);
      simulatedOwnership.set(operation.itemId, owners);
      const state = itemDestinations.get(operation.itemId) ?? {
        moved: false,
        positiveOwners: new Set<string>(),
        negativeOwners: new Set<string>(),
        transferred: false,
      };
      if (operation.quantityDelta > 0) state.positiveOwners.add(operation.ownerId);
      if (operation.quantityDelta < 0) state.negativeOwners.add(operation.ownerId);
      itemDestinations.set(operation.itemId, state);
    }
    if (operation.type === "transfer_item") {
      const owners = simulatedOwnership.get(operation.itemId) ?? new Map<string, number>();
      const sourceQuantity = (owners.get(operation.fromId) ?? 0) - operation.quantity;
      if (sourceQuantity > 0) owners.set(operation.fromId, sourceQuantity);
      else owners.delete(operation.fromId);
      owners.set(operation.toId, (owners.get(operation.toId) ?? 0) + operation.quantity);
      simulatedOwnership.set(operation.itemId, owners);
      const state = itemDestinations.get(operation.itemId) ?? {
        moved: false,
        positiveOwners: new Set<string>(),
        negativeOwners: new Set<string>(),
        transferred: false,
      };
      state.positiveOwners.add(operation.toId);
      state.negativeOwners.add(operation.fromId);
      state.transferred = true;
      itemDestinations.set(operation.itemId, state);
    }
  }
  for (const candidate of ownedCreditCandidates) {
    // Preserve the more specific whole-state cycle diagnostic when this credit
    // closes a self-ownership or container cycle.
    if (!closesInventoryCycle(candidate.ownerId, candidate.itemId, simulatedOwnership)) {
      issues.push(candidate.issue);
    }
  }
  for (const [itemId, destination] of itemDestinations) {
    if (destination.moved) {
      issues.push({
        code: "item_move_requires_inventory_transfer",
        message: `${itemId} cannot use move_entity; items move only through inventory ownership, using transfer_item between known owners`,
      });
    }
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
    if (
      !destination.transferred &&
      destination.positiveOwners.size &&
      destination.negativeOwners.size
    ) {
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
  collector?: DomainViolationCollector,
): void {
  const issues = findDeterministicConsistencyIssues(operations, entities);
  if (!issues.length) return;
  if (collector) {
    for (const issue of issues) collector.add(issue.code, issue.message);
    return;
  }
  rejectDomainChange(
    `State consistency validation failed:\n${issues.map((issue) => `- [${issue.code}] ${issue.message}`).join("\n")}`,
    issues[0]!.code,
  );
}
