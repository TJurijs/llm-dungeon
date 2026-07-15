import { assertCampaignStateConsistency } from "./state-consistency.js";
import { rejectDomainChange } from "./validation-error.js";
import {
  EntitySchema,
  type ChronicleEvent,
  type Entity,
  type Fact,
  type GameState,
  type StateOperation,
  type Thread,
} from "../schemas.js";
import { allocateGeneratedId, canonicalEntityName } from "./ids.js";

function unreachableOperation(operation: never): never {
  throw new Error(`Unsupported state operation: ${JSON.stringify(operation)}`);
}

function adjustInventory(owner: Entity, item: Entity, delta: number): void {
  const existing = owner.inventory.find((entry) => entry.entityId === item.id);
  const next = (existing?.quantity ?? 0) + delta;
  if (next < 0) rejectDomainChange(`Inventory for ${item.id} cannot become negative`);
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
): void {
  const usedFactIds = new Set([
    ...[...entities.values()].flatMap((entity) => entity.facts.map((fact) => fact.id)),
    ...operations.flatMap((operation) => {
      if (operation.type === "add_fact") return [operation.factId];
      if (operation.type === "supersede_fact") return [operation.replacementFactId];
      return [];
    }),
  ]);
  for (const operation of operations.filter((item) => item.type === "create_entity")) {
    if (entities.has(operation.entity.id)) {
      rejectDomainChange(`Entity ${operation.entity.id} already exists`);
    }
    if (operation.entity.kind === "location") {
      const duplicate = [...entities.values()].find((entity) =>
        entity.kind === "location"
        && canonicalEntityName(entity.name) === canonicalEntityName(operation.entity.name));
      if (duplicate) {
        rejectDomainChange(
          `Location ${operation.entity.name} duplicates existing location ${duplicate.id}; reuse that exact ID`,
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
          id: allocateGeneratedId("fact", operation.entity.id, turn, usedFactIds),
          section,
          text,
          active: true,
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
  }

  const requireEntity = (id: string): Entity => {
    const entity = entities.get(id);
    if (!entity) rejectDomainChange(`Unknown entity ${id}`);
    return entity;
  };
  const touch = (entity: Entity) => {
    entity.updatedTurn = turn;
  };

  for (const operation of operations) {
    switch (operation.type) {
      case "create_entity":
        break;
      case "add_fact": {
        const target = requireEntity(operation.targetId);
        if (target.facts.some((fact) => fact.id === operation.factId)) {
          rejectDomainChange(`Fact ${operation.factId} already exists`);
        }
        target.facts.push({
          id: operation.factId,
          section: operation.section,
          text: operation.text,
          active: true,
        });
        touch(target);
        break;
      }
      case "supersede_fact": {
        const target = requireEntity(operation.targetId);
        const fact = target.facts.find((item) => item.id === operation.factId && item.active);
        if (!fact) rejectDomainChange(`Active fact ${operation.factId} does not exist on ${operation.targetId}`);
        if (target.facts.some((item) => item.id === operation.replacementFactId)) {
          rejectDomainChange(`Fact ${operation.replacementFactId} already exists`);
        }
        fact.active = false;
        target.facts.push({
          id: operation.replacementFactId,
          section: fact.section,
          text: operation.replacementText,
          active: true,
        });
        touch(target);
        break;
      }
      case "set_entity_state": {
        const target = requireEntity(operation.targetId);
        if (operation.name === undefined && operation.status === undefined && operation.tags === undefined) {
          rejectDomainChange("set_entity_state must change at least one field");
        }
        if (operation.name !== undefined) target.name = operation.name;
        if (operation.status !== undefined) target.status = operation.status;
        if (operation.tags !== undefined) target.tags = operation.tags;
        touch(target);
        break;
      }
      case "move_entity": {
        const target = requireEntity(operation.targetId);
        const destination = requireEntity(operation.locationId);
        if (destination.kind !== "location") rejectDomainChange(`${operation.locationId} is not a location`);
        target.location = destination.id;
        if (target.id === manifest.playerId) manifest.currentLocationId = destination.id;
        touch(target);
        break;
      }
      case "change_inventory": {
        const owner = requireEntity(operation.ownerId);
        const item = requireEntity(operation.itemId);
        if (item.kind !== "item") rejectDomainChange(`${item.id} is not an item`);
        adjustInventory(owner, item, operation.quantityDelta);
        if (operation.quantityDelta > 0) {
          delete item.location;
          touch(item);
        }
        touch(owner);
        break;
      }
      case "transfer_item": {
        if (operation.fromId === operation.toId) rejectDomainChange("transfer_item requires different owners");
        const from = requireEntity(operation.fromId);
        const to = requireEntity(operation.toId);
        const item = requireEntity(operation.itemId);
        if (item.kind !== "item") rejectDomainChange(`${item.id} is not an item`);
        const source = from.inventory.find((entry) => entry.entityId === item.id);
        if (!source || source.quantity < operation.quantity) {
          rejectDomainChange(`${operation.fromId} does not own ${operation.quantity} of ${operation.itemId}`);
        }
        adjustInventory(from, item, -operation.quantity);
        adjustInventory(to, item, operation.quantity);
        delete item.location;
        touch(from);
        touch(to);
        touch(item);
        break;
      }
      case "add_condition": {
        const target = requireEntity(operation.targetId);
        if (!target.conditions.includes(operation.condition)) {
          target.conditions.push(operation.condition);
        }
        touch(target);
        break;
      }
      case "remove_condition": {
        const target = requireEntity(operation.targetId);
        if (!target.conditions.includes(operation.condition)) {
          rejectDomainChange(`${operation.targetId} does not have condition ${operation.condition}`);
        }
        target.conditions = target.conditions.filter((condition) => condition !== operation.condition);
        touch(target);
        break;
      }
      case "add_trait": {
        const target = requireEntity(operation.targetId);
        if (!target.traits.includes(operation.trait)) target.traits.push(operation.trait);
        touch(target);
        break;
      }
      case "set_relationship": {
        const source = requireEntity(operation.sourceId);
        requireEntity(operation.targetId);
        const existing = source.relationships.find((relation) => relation.targetId === operation.targetId);
        if (existing) {
          existing.summary = operation.summary;
        } else {
          source.relationships.push({ targetId: operation.targetId, summary: operation.summary });
        }
        touch(source);
        break;
      }
      case "create_thread": {
        if (threads.some((thread) => thread.id === operation.threadId)) {
          rejectDomainChange(`Thread ${operation.threadId} already exists`);
        }
        threads.push({
          id: operation.threadId,
          title: operation.title,
          summary: operation.summary,
          status: "active",
          relatedEntityIds: operation.relatedEntityIds,
        });
        break;
      }
      case "update_thread": {
        const thread = threads.find((item) => item.id === operation.threadId);
        if (!thread) rejectDomainChange(`Unknown thread ${operation.threadId}`);
        if (thread.status !== "active") rejectDomainChange(`Thread ${operation.threadId} is not active`);
        thread.summary = operation.summary;
        if (operation.relatedEntityIds !== undefined) {
          thread.relatedEntityIds = operation.relatedEntityIds;
        }
        break;
      }
      case "resolve_thread": {
        const thread = threads.find((item) => item.id === operation.threadId);
        if (!thread) rejectDomainChange(`Unknown thread ${operation.threadId}`);
        if (thread.status !== "active") rejectDomainChange(`Thread ${operation.threadId} is not active`);
        thread.status = operation.status;
        thread.summary = operation.outcome;
        break;
      }
      case "record_major_event": {
        if (chronicle.some((event) => event.id === operation.eventId)) {
          rejectDomainChange(`Chronicle event ${operation.eventId} already exists`);
        }
        chronicle.push({ id: operation.eventId, text: operation.text, turn });
        break;
      }
      case "advance_time":
        manifest.elapsedMinutes += operation.minutes;
        manifest.timeLabel = operation.timeLabel;
        break;
      case "end_campaign": {
        if (manifest.status !== "active") rejectDomainChange("A campaign can end only once");
        manifest.status = operation.status;
        const player = requireEntity(manifest.playerId);
        player.status = operation.status;
        touch(player);
        chronicle.push({ id: `event:campaign-end-${turn}`, text: operation.reason, turn });
        break;
      }
      default:
        unreachableOperation(operation);
    }
  }

  for (const entity of entities.values()) {
    if (entity.location) {
      const location = requireEntity(entity.location);
      if (location.kind !== "location") rejectDomainChange(`${entity.id} has a non-location location reference`);
    }
    for (const inventory of entity.inventory) requireEntity(inventory.entityId);
    EntitySchema.parse(entity);
  }
  assertCampaignStateConsistency(manifest, entities, threads, chronicle);
}
