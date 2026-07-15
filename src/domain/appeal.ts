import { canonicalEntityName } from "./ids.js";
import type { Entity, StateOperation } from "../schemas.js";

const MAX_APPEAL_OPERATIONS = 12;
const TERMINAL_ENTITY_STATUSES = new Set(["dead", "ended"]);
const FORBIDDEN_OPERATION_TYPES = new Set<StateOperation["type"]>([
  "advance_time",
  "record_major_event",
  "end_campaign",
]);

export class AppealPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AppealPolicyError";
  }
}

/**
 * Appeals are append-only state corrections, not a second gameplay path.
 * This guard enforces the invariants application code can determine from the
 * structured transaction without attempting to interpret fictional prose.
 */
export function assertAppealOperations(
  operations: StateOperation[],
  existingEntities: Map<string, Entity>,
): void {
  if (operations.length > MAX_APPEAL_OPERATIONS) {
    throw new AppealPolicyError(`Appeal correction exceeds the ${MAX_APPEAL_OPERATIONS}-operation safety limit`);
  }
  for (const operation of operations) {
    if (FORBIDDEN_OPERATION_TYPES.has(operation.type)) {
      throw new AppealPolicyError(`Appeals cannot apply ${operation.type}`);
    }
    if (operation.type === "set_entity_state" && operation.status !== undefined) {
      const current = existingEntities.get(operation.targetId);
      if (current && TERMINAL_ENTITY_STATUSES.has(current.status) && operation.status !== current.status) {
        throw new AppealPolicyError(`Appeals cannot restore terminal entity ${current.id}`);
      }
    }
  }

  const itemIds = new Set(
    [...existingEntities.values()]
      .filter((entity) => entity.kind === "item")
      .map((entity) => entity.id),
  );
  const reservedExistingNames = new Map<string, Set<string>>();
  const currentNames = new Map<string, Set<string>>();
  const canonicalNameByItem = new Map<string, string>();
  const addName = (names: Map<string, Set<string>>, canonical: string, itemId: string): void => {
    const owners = names.get(canonical) ?? new Set<string>();
    owners.add(itemId);
    names.set(canonical, owners);
  };
  const removeName = (names: Map<string, Set<string>>, canonical: string, itemId: string): void => {
    const owners = names.get(canonical);
    owners?.delete(itemId);
    if (!owners?.size) names.delete(canonical);
  };
  const hasOtherOwner = (names: Map<string, Set<string>>, canonical: string, itemId: string): boolean =>
    [...(names.get(canonical) ?? [])].some((ownerId) => ownerId !== itemId);
  for (const entity of existingEntities.values()) {
    if (entity.kind !== "item") continue;
    const canonical = canonicalEntityName(entity.name);
    canonicalNameByItem.set(entity.id, canonical);
    addName(reservedExistingNames, canonical, entity.id);
    addName(currentNames, canonical, entity.id);
  }

  const createdItems = operations.flatMap((operation) => {
    if (operation.type !== "create_entity") return [];
    if (operation.entity.kind !== "item") {
      throw new AppealPolicyError("Appeals may create only a missing item explicitly supported by committed evidence");
    }
    if (operation.entity.location !== undefined) {
      throw new AppealPolicyError("An item created by an appeal must enter one authoritative inventory");
    }
    const canonicalName = canonicalEntityName(operation.entity.name);
    if (currentNames.has(canonicalName)) {
      throw new AppealPolicyError(`Appeal item ${operation.entity.name} duplicates an existing item`);
    }
    itemIds.add(operation.entity.id);
    canonicalNameByItem.set(operation.entity.id, canonicalName);
    addName(currentNames, canonicalName, operation.entity.id);
    return [operation.entity.id];
  });

  for (const operation of operations) {
    if (operation.type !== "set_entity_state" || operation.name === undefined || !itemIds.has(operation.targetId)) {
      continue;
    }
    const canonicalName = canonicalEntityName(operation.name);
    if (hasOtherOwner(reservedExistingNames, canonicalName, operation.targetId)
      || hasOtherOwner(currentNames, canonicalName, operation.targetId)) {
      throw new AppealPolicyError(`Appeal item rename ${operation.name} duplicates an existing item`);
    }
    const previousName = canonicalNameByItem.get(operation.targetId);
    if (previousName !== undefined) removeName(currentNames, previousName, operation.targetId);
    addName(currentNames, canonicalName, operation.targetId);
    canonicalNameByItem.set(operation.targetId, canonicalName);
  }

  for (const itemId of createdItems) {
    const credits = operations.filter((operation) =>
      operation.type === "change_inventory"
      && operation.itemId === itemId
      && operation.quantityDelta > 0);
    if (credits.length !== 1) {
      throw new AppealPolicyError("Each item created by an appeal must be credited to exactly one inventory");
    }
    if (operations.some((operation) => operation.type === "transfer_item" && operation.itemId === itemId)) {
      throw new AppealPolicyError("A newly created appeal item cannot be transferred from a prior owner");
    }
  }
}
