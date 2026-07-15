import type { StateOperation } from "../schemas.js";

export type OperationReferenceRole =
  | { kind: "entity" }
  | { kind: "location" }
  | { kind: "item" }
  | { kind: "thread" }
  | { kind: "active_fact"; targetId: string };

export type OperationReferenceMapper = (
  reference: string,
  role: OperationReferenceRole,
) => string;

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
      return operation.entity.location === undefined
        ? operation
        : {
            ...operation,
            entity: {
              ...operation.entity,
              location: map(operation.entity.location, { kind: "location" }),
            },
          };
    case "add_fact":
    case "set_entity_state":
    case "add_condition":
    case "remove_condition":
    case "add_trait":
      return { ...operation, targetId: map(operation.targetId, { kind: "entity" }) };
    case "supersede_fact": {
      const targetId = map(operation.targetId, { kind: "entity" });
      return {
        ...operation,
        targetId,
        factId: map(operation.factId, { kind: "active_fact", targetId }),
      };
    }
    case "move_entity":
      return {
        ...operation,
        targetId: map(operation.targetId, { kind: "entity" }),
        locationId: map(operation.locationId, { kind: "location" }),
      };
    case "change_inventory":
      return {
        ...operation,
        ownerId: map(operation.ownerId, { kind: "entity" }),
        itemId: map(operation.itemId, { kind: "item" }),
      };
    case "transfer_item":
      return {
        ...operation,
        fromId: map(operation.fromId, { kind: "entity" }),
        toId: map(operation.toId, { kind: "entity" }),
        itemId: map(operation.itemId, { kind: "item" }),
      };
    case "set_relationship":
      return {
        ...operation,
        sourceId: map(operation.sourceId, { kind: "entity" }),
        targetId: map(operation.targetId, { kind: "entity" }),
      };
    case "create_thread":
      return {
        ...operation,
        relatedEntityIds: operation.relatedEntityIds.map((id) => map(id, { kind: "entity" })),
      };
    case "update_thread":
      return {
        ...operation,
        threadId: map(operation.threadId, { kind: "thread" }),
        ...(operation.relatedEntityIds === undefined
          ? {}
          : { relatedEntityIds: operation.relatedEntityIds.map((id) => map(id, { kind: "entity" })) }),
      };
    case "resolve_thread":
      return { ...operation, threadId: map(operation.threadId, { kind: "thread" }) };
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
