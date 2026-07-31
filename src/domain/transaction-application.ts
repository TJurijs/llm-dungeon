import {
  assertCampaignStateConsistency,
  type CampaignStateConsistencyOptions,
} from "./state-consistency.js";
import { DomainValidationError, rejectDomainChange } from "./validation-error.js";
import { DomainViolationCollector } from "./violations.js";
import {
  EntitySchema,
  type ChronicleEvent,
  type Entity,
  type Fact,
  type GameState,
  type StateOperation,
  type Thread,
} from "../schemas.js";
import { allocateTurnScopedId, canonicalEntityName } from "./ids.js";

function unreachableOperation(operation: never): never {
  throw new Error(`Unsupported state operation: ${JSON.stringify(operation)}`);
}

/**
 * An operation either changes durable state or its complete effect already
 * holds. A satisfied operation is dropped from the committed ledger rather
 * than rejected: the desired end state is identical either way, and rejecting
 * it would spend the turn's bounded correction budget on a no-op.
 */
type OperationOutcome = "applied" | "satisfied";

export interface AppliedOperations {
  /** Operations that changed durable state; this is the committed ledger. */
  readonly applied: StateOperation[];
  /** Operations dropped because their complete effect already held. */
  readonly satisfied: StateOperation[];
}

function adjustInventory(owner: Entity, item: Entity, delta: number): void {
  const existing = owner.inventory.find((entry) => entry.entityId === item.id);
  const next = (existing?.quantity ?? 0) + delta;
  if (next < 0)
    rejectDomainChange(`Inventory for ${item.id} cannot become negative`, "inventory_negative");
  if (existing && next === 0) {
    owner.inventory = owner.inventory.filter((entry) => entry.entityId !== item.id);
  } else if (existing) {
    existing.quantity = next;
  } else if (next > 0) {
    owner.inventory.push({ entityId: item.id, quantity: next });
  }
}

export function applyOperations(
  operations: StateOperation[],
  turn: number,
  manifest: GameState,
  entities: Map<string, Entity>,
  threads: Thread[],
  chronicle: ChronicleEvent[],
  consistencyOptions: CampaignStateConsistencyOptions = {},
  collector?: DomainViolationCollector,
): AppliedOperations {
  /**
   * Without a collector this keeps throw-on-first behavior, which the
   * pending-commit replay path relies on for an already-accepted ledger.
   */
  const record = (error: unknown, operation: StateOperation): void => {
    if (!collector || !(error instanceof DomainValidationError)) throw error;
    if (collector.cascadesFromFailedSubject(operation)) return;
    if (error.violations.length === 0) {
      collector.add("domain_rule", error.message);
      return;
    }
    for (const violation of error.violations) collector.add(violation.code, violation.message);
  };

  const usedFactIds = new Set([
    ...[...entities.values()].flatMap((entity) => entity.facts.map((fact) => fact.id)),
    ...operations.flatMap((operation) => {
      if (operation.type === "add_fact") return [operation.factId];
      if (operation.type === "supersede_fact") return [operation.replacementFactId];
      return [];
    }),
  ]);
  for (const operation of operations.filter((item) => item.type === "create_entity")) {
    try {
      if (entities.has(operation.entity.id)) {
        rejectDomainChange(`Entity ${operation.entity.id} already exists`, "entity_already_exists");
      }
      if (operation.entity.kind === "location") {
        const duplicate = [...entities.values()].find(
          (entity) =>
            entity.kind === "location" &&
            canonicalEntityName(entity.name) === canonicalEntityName(operation.entity.name),
        );
        if (duplicate) {
          rejectDomainChange(
            `Location ${operation.entity.name} duplicates existing location ${duplicate.id}; reuse that exact ID`,
            "location_name_duplicate",
          );
        }
      }
      const facts: Fact[] = [];
      for (const [section, values] of [
        ["established", operation.entity.establishedFacts],
        ["secrets", operation.entity.secrets],
        ["knowledge", operation.entity.playerKnowledge],
      ] as const) {
        for (const text of values) {
          facts.push({
            id: allocateTurnScopedId("fact", operation.entity.id, turn, usedFactIds),
            section,
            text,
            active: true,
            createdTurn: turn,
          });
        }
      }
      entities.set(
        operation.entity.id,
        EntitySchema.parse({
          ...operation.entity,
          updatedTurn: turn,
          traits: [],
          conditions: [],
          inventory: [],
          facts,
          relationships: [],
        }),
      );
    } catch (error) {
      // A record that never existed makes every later reference to it fail for
      // the same root cause; report the creation once and stay quiet after.
      collector?.markFailedSubject(operation.entity.id);
      record(error, operation);
    }
  }

  const requireEntity = (id: string): Entity => {
    const entity = entities.get(id);
    if (!entity) rejectDomainChange(`Unknown entity ${id}`, "unknown_entity");
    return entity;
  };
  const touch = (entity: Entity) => {
    entity.updatedTurn = turn;
  };

  const applyOne = (operation: StateOperation): OperationOutcome => {
    switch (operation.type) {
      case "create_entity":
        return "applied";
      case "add_fact": {
        const target = requireEntity(operation.targetId);
        if (target.facts.some((fact) => fact.id === operation.factId)) {
          rejectDomainChange(`Fact ${operation.factId} already exists`, "fact_id_conflict");
        }
        if (
          target.facts.some(
            (fact) =>
              fact.active && fact.section === operation.section && fact.text === operation.text,
          )
        ) {
          // The proposition is already durable in the same section; recording
          // it again would only duplicate knowledge.
          return "satisfied";
        }
        target.facts.push({
          id: operation.factId,
          section: operation.section,
          text: operation.text,
          active: true,
          createdTurn: turn,
          ...(operation.basis === undefined ? {} : { basis: operation.basis }),
          ...(operation.sourceId === undefined ? {} : { sourceId: operation.sourceId }),
        });
        touch(target);
        return "applied";
      }
      case "supersede_fact": {
        const target = requireEntity(operation.targetId);
        const fact = target.facts.find((item) => item.id === operation.factId && item.active);
        if (!fact)
          rejectDomainChange(
            `Active fact ${operation.factId} does not exist on ${operation.targetId}`,
            "unknown_active_fact",
          );
        if (target.facts.some((item) => item.id === operation.replacementFactId)) {
          rejectDomainChange(
            `Fact ${operation.replacementFactId} already exists`,
            "fact_id_conflict",
          );
        }
        // Replacing a fact with its own wording leaves the record unchanged.
        if (fact.text === operation.replacementText) return "satisfied";
        if (
          target.facts.some(
            (item) =>
              item.active &&
              item.id !== fact.id &&
              item.section === fact.section &&
              item.text === operation.replacementText,
          )
        ) {
          rejectDomainChange(
            `Replacement fact ${operation.replacementFactId} duplicates another active fact on ${operation.targetId}`,
            "fact_duplicate_replacement",
          );
        }
        fact.active = false;
        fact.supersededTurn = turn;
        target.facts.push({
          id: operation.replacementFactId,
          section: fact.section,
          text: operation.replacementText,
          active: true,
          createdTurn: turn,
        });
        touch(target);
        return "applied";
      }
      case "set_entity_state": {
        const target = requireEntity(operation.targetId);
        if (
          operation.name === undefined &&
          operation.status === undefined &&
          operation.tags === undefined
        ) {
          rejectDomainChange(
            "set_entity_state must change at least one field",
            "set_entity_state_empty",
          );
        }
        const unchanged =
          (operation.name === undefined || operation.name === target.name) &&
          (operation.status === undefined || operation.status === target.status) &&
          (operation.tags === undefined ||
            (operation.tags.length === target.tags.length &&
              operation.tags.every((tag, index) => tag === target.tags[index])));
        if (unchanged) return "satisfied";
        if (operation.name !== undefined) target.name = operation.name;
        if (operation.status !== undefined) target.status = operation.status;
        if (operation.tags !== undefined) target.tags = operation.tags;
        touch(target);
        return "applied";
      }
      case "move_entity": {
        const target = requireEntity(operation.targetId);
        const destination = requireEntity(operation.locationId);
        if (destination.kind !== "location")
          rejectDomainChange(`${operation.locationId} is not a location`, "not_a_location");
        if (target.kind === "item") {
          rejectDomainChange(
            `${target.id} cannot use move_entity; transfer it between inventory owners`,
            "item_move_requires_inventory_transfer",
          );
        }
        if (target.location === destination.id) return "satisfied";
        target.location = destination.id;
        if (target.id === manifest.playerId) manifest.currentLocationId = destination.id;
        touch(target);
        return "applied";
      }
      case "change_inventory": {
        const owner = requireEntity(operation.ownerId);
        const item = requireEntity(operation.itemId);
        if (item.kind !== "item") rejectDomainChange(`${item.id} is not an item`, "not_an_item");
        adjustInventory(owner, item, operation.quantityDelta);
        if (operation.quantityDelta > 0) {
          delete item.location;
          touch(item);
        }
        touch(owner);
        return "applied";
      }
      case "transfer_item": {
        if (operation.fromId === operation.toId)
          rejectDomainChange("transfer_item requires different owners", "transfer_same_owner");
        const from = requireEntity(operation.fromId);
        const to = requireEntity(operation.toId);
        const item = requireEntity(operation.itemId);
        if (item.kind !== "item") rejectDomainChange(`${item.id} is not an item`, "not_an_item");
        const source = from.inventory.find((entry) => entry.entityId === item.id);
        if (!source || source.quantity < operation.quantity) {
          rejectDomainChange(
            `${operation.fromId} does not own ${operation.quantity} of ${operation.itemId}`,
            "transfer_insufficient_quantity",
          );
        }
        adjustInventory(from, item, -operation.quantity);
        adjustInventory(to, item, operation.quantity);
        delete item.location;
        touch(from);
        touch(to);
        touch(item);
        return "applied";
      }
      case "add_condition": {
        const target = requireEntity(operation.targetId);
        if (target.conditions.includes(operation.condition)) return "satisfied";
        target.conditions.push(operation.condition);
        touch(target);
        return "applied";
      }
      case "remove_condition": {
        const target = requireEntity(operation.targetId);
        // The intended end state is that the condition is gone. It already is.
        if (!target.conditions.includes(operation.condition)) return "satisfied";
        target.conditions = target.conditions.filter(
          (condition) => condition !== operation.condition,
        );
        touch(target);
        return "applied";
      }
      case "add_trait": {
        const target = requireEntity(operation.targetId);
        if (target.traits.includes(operation.trait)) return "satisfied";
        target.traits.push(operation.trait);
        touch(target);
        return "applied";
      }
      case "set_relationship": {
        const source = requireEntity(operation.sourceId);
        requireEntity(operation.targetId);
        const existing = source.relationships.find(
          (relation) => relation.targetId === operation.targetId,
        );
        if (existing) {
          if (existing.summary === operation.summary) return "satisfied";
          existing.summary = operation.summary;
        } else {
          source.relationships.push({ targetId: operation.targetId, summary: operation.summary });
        }
        touch(source);
        return "applied";
      }
      case "create_thread": {
        if (threads.some((thread) => thread.id === operation.threadId)) {
          rejectDomainChange(`Thread ${operation.threadId} already exists`, "thread_id_conflict");
        }
        threads.push({
          id: operation.threadId,
          title: operation.title,
          objective: operation.summary,
          createdTurn: turn,
          updatedTurn: turn,
          summary: operation.summary,
          status: "active",
          relatedEntityIds: operation.relatedEntityIds,
        });
        return "applied";
      }
      case "update_thread": {
        const thread = threads.find((item) => item.id === operation.threadId);
        if (!thread) rejectDomainChange(`Unknown thread ${operation.threadId}`, "unknown_thread");
        if (thread.status !== "active")
          rejectDomainChange(`Thread ${operation.threadId} is not active`, "thread_not_active");
        const unchangedReferences =
          operation.relatedEntityIds === undefined ||
          (operation.relatedEntityIds.length === thread.relatedEntityIds.length &&
            operation.relatedEntityIds.every((id, index) => id === thread.relatedEntityIds[index]));
        // Rewriting a thread with its current brief records nothing new.
        if (thread.summary === operation.summary && unchangedReferences) return "satisfied";
        thread.summary = operation.summary;
        thread.updatedTurn = turn;
        if (operation.relatedEntityIds !== undefined) {
          thread.relatedEntityIds = operation.relatedEntityIds;
        }
        return "applied";
      }
      case "resolve_thread": {
        const thread = threads.find((item) => item.id === operation.threadId);
        if (!thread) rejectDomainChange(`Unknown thread ${operation.threadId}`, "unknown_thread");
        if (thread.status !== "active")
          rejectDomainChange(`Thread ${operation.threadId} is not active`, "thread_not_active");
        thread.status = operation.status;
        thread.summary = operation.outcome;
        thread.updatedTurn = turn;
        thread.closedTurn = turn;
        return "applied";
      }
      case "record_major_event": {
        if (chronicle.some((event) => event.id === operation.eventId)) {
          rejectDomainChange(
            `Chronicle event ${operation.eventId} already exists`,
            "chronicle_id_conflict",
          );
        }
        chronicle.push({ id: operation.eventId, text: operation.text, turn });
        return "applied";
      }
      case "advance_time":
        if (operation.minutes === 0 && manifest.timeLabel === operation.timeLabel)
          return "satisfied";
        manifest.elapsedMinutes += operation.minutes;
        manifest.timeLabel = operation.timeLabel;
        return "applied";
      case "end_campaign": {
        if (manifest.status !== "active")
          rejectDomainChange("A campaign can end only once", "campaign_already_ended");
        const player = requireEntity(manifest.playerId);
        manifest.status = operation.status;
        player.status = operation.status;
        touch(player);
        chronicle.push({ id: `event:campaign-end-${turn}`, text: operation.reason, turn });
        return "applied";
      }
      default:
        return unreachableOperation(operation);
    }
  };

  const applied: StateOperation[] = [];
  const satisfied: StateOperation[] = [];
  for (const operation of operations) {
    try {
      if (applyOne(operation) === "applied") applied.push(operation);
      else satisfied.push(operation);
    } catch (error) {
      record(error, operation);
    }
  }

  // Whole-state verification needs coherent state, so it only runs when every
  // operation was admitted.
  if (collector && collector.size > 0) return { applied, satisfied };

  for (const entity of entities.values()) {
    try {
      if (entity.location) {
        const location = requireEntity(entity.location);
        if (location.kind !== "location")
          rejectDomainChange(
            `${entity.id} has a non-location location reference`,
            "non_location_parent",
          );
      }
      for (const inventory of entity.inventory) requireEntity(inventory.entityId);
      EntitySchema.parse(entity);
    } catch (error) {
      if (!collector || !(error instanceof DomainValidationError)) throw error;
      collector.add("domain_rule", error.message);
    }
  }
  assertCampaignStateConsistency(
    manifest,
    entities,
    threads,
    chronicle,
    consistencyOptions,
    collector,
  );
  return { applied, satisfied };
}
