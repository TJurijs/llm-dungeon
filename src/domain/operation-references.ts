import type { StateOperation } from "../schemas.js";

/**
 * Whether the operation changes the referenced record or merely names it.
 *
 * A move's destination and a thread's related-entity links are references to
 * records the operation leaves untouched. Conflating those with the records it
 * actually writes makes "this turn changed X" true for most of the world, so
 * any rule built on that question loses its meaning.
 */
export type OperationReferenceEffect = "mutates" | "names";

export type OperationReferenceRole = { effect: OperationReferenceEffect } & (
  | { kind: "entity" }
  | { kind: "location" }
  | { kind: "item" }
  | { kind: "thread" }
  | { kind: "active_fact"; targetId: string }
);

export type OperationReferenceMapper = (reference: string, role: OperationReferenceRole) => string;

function unreachableOperation(operation: never): never {
  throw new Error(`Unsupported state operation: ${JSON.stringify(operation)}`);
}

/**
 * Map every reference to an existing domain record in one operation.
 *
 * Definition IDs on create operations and generated replacement IDs are not
 * references, so they deliberately remain untouched. The exhaustive switch is
 * the single place that must be updated when the operation union grows.
 */
export function mapOperationReferences(
  operation: StateOperation,
  map: OperationReferenceMapper,
): StateOperation {
  switch (operation.type) {
    case "create_entity":
      // The containing location gains a child but is not itself rewritten.
      return operation.entity.location === undefined
        ? operation
        : {
            ...operation,
            entity: {
              ...operation.entity,
              location: map(operation.entity.location, { kind: "location", effect: "names" }),
            },
          };
    case "add_fact":
    case "set_entity_state":
    case "add_condition":
    case "remove_condition":
    case "add_trait":
      return {
        ...operation,
        targetId: map(operation.targetId, { kind: "entity", effect: "mutates" }),
      };
    case "supersede_fact": {
      const targetId = map(operation.targetId, { kind: "entity", effect: "mutates" });
      return {
        ...operation,
        targetId,
        factId: map(operation.factId, { kind: "active_fact", targetId, effect: "mutates" }),
      };
    }
    case "move_entity":
      return {
        ...operation,
        targetId: map(operation.targetId, { kind: "entity", effect: "mutates" }),
        // The destination is where the entity ends up, not a record this
        // operation writes.
        locationId: map(operation.locationId, { kind: "location", effect: "names" }),
      };
    case "change_inventory":
      return {
        ...operation,
        ownerId: map(operation.ownerId, { kind: "entity", effect: "mutates" }),
        itemId: map(operation.itemId, { kind: "item", effect: "mutates" }),
      };
    case "transfer_item":
      return {
        ...operation,
        fromId: map(operation.fromId, { kind: "entity", effect: "mutates" }),
        toId: map(operation.toId, { kind: "entity", effect: "mutates" }),
        itemId: map(operation.itemId, { kind: "item", effect: "mutates" }),
      };
    case "set_relationship":
      return {
        ...operation,
        sourceId: map(operation.sourceId, { kind: "entity", effect: "mutates" }),
        targetId: map(operation.targetId, { kind: "entity", effect: "mutates" }),
      };
    case "create_thread":
      // Related entities are the thread's retrieval links. Linking a record does
      // not change it.
      return {
        ...operation,
        relatedEntityIds: operation.relatedEntityIds.map((id) =>
          map(id, { kind: "entity", effect: "names" }),
        ),
      };
    case "update_thread":
      return {
        ...operation,
        threadId: map(operation.threadId, { kind: "thread", effect: "mutates" }),
        ...(operation.relatedEntityIds === undefined
          ? {}
          : {
              relatedEntityIds: operation.relatedEntityIds.map((id) =>
                map(id, { kind: "entity", effect: "names" }),
              ),
            }),
      };
    case "resolve_thread":
      return {
        ...operation,
        threadId: map(operation.threadId, { kind: "thread", effect: "mutates" }),
      };
    case "record_major_event":
    case "advance_time":
    case "end_campaign":
      return operation;
    default:
      return unreachableOperation(operation);
  }
}

export function visitOperationReferences(
  operation: StateOperation,
  visit: (reference: string, role: OperationReferenceRole) => void,
): void {
  mapOperationReferences(operation, (reference, role) => {
    visit(reference, role);
    return reference;
  });
}

/**
 * The records an operation list actually writes, including entities it creates.
 *
 * Use this for any rule phrased as "this turn changed X". Reaching for the full
 * reference set instead makes such a rule fire whenever the turn merely walked
 * into a linked room, which is how a check on thread bookkeeping came to fire on
 * nearly every turn of a scenario whose seed links its threads to the rooms the
 * player occupies.
 */
export function collectMutatedSubjects(operations: readonly StateOperation[]): Set<string> {
  const mutated = new Set<string>();
  for (const operation of operations) {
    if (operation.type === "create_entity") mutated.add(operation.entity.id);
    visitOperationReferences(operation, (reference, role) => {
      if (role.effect === "mutates") mutated.add(reference);
    });
  }
  return mutated;
}
