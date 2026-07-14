import type { ChronicleEvent, Entity, GameState, Thread } from "../schemas.js";
import { canonicalEntityName } from "./ids.js";

function requireEntity(entities: Map<string, Entity>, id: string, context: string): Entity {
  const entity = entities.get(id);
  if (!entity) throw new Error(`${context} references unknown entity ${id}`);
  return entity;
}

/** Validate referential and physical invariants for one complete campaign snapshot. */
export function assertCampaignStateConsistency(
  manifest: GameState,
  entities: Map<string, Entity>,
  threads: Thread[],
  chronicle: ChronicleEvent[],
): void {
  const player = requireEntity(entities, manifest.playerId, "Campaign player");
  const currentLocation = requireEntity(entities, manifest.currentLocationId, "Current location");
  if (currentLocation.kind !== "location") {
    throw new Error(`Current location ${currentLocation.id} is not a location entity`);
  }
  if (player.location !== currentLocation.id) {
    throw new Error(`Player location ${player.location ?? "missing"} does not match manifest location ${currentLocation.id}`);
  }
  if (manifest.status === "active" && (player.status === "dead" || player.status === "ended")) {
    throw new Error(`Player terminal status ${player.status} requires a matching campaign ending`);
  }
  if (manifest.status !== "active" && player.status !== manifest.status) {
    throw new Error(`Player status ${player.status} does not match ended campaign status ${manifest.status}`);
  }

  const inventoryOwners = new Map<string, string[]>();
  const factIds = new Set<string>();
  const locationsByName = new Map<string, string>();
  for (const entity of entities.values()) {
    if (entity.kind === "location") {
      const canonicalName = canonicalEntityName(entity.name);
      const duplicate = locationsByName.get(canonicalName);
      if (duplicate) {
        throw new Error(`Location ${entity.id} duplicates established location ${duplicate} by canonical name`);
      }
      locationsByName.set(canonicalName, entity.id);
    }
    if (entity.location) {
      if (entity.location === entity.id) throw new Error(`${entity.id} cannot be located inside itself`);
      const location = requireEntity(entities, entity.location, `Entity ${entity.id}`);
      if (location.kind !== "location") throw new Error(`${entity.id} has non-location parent ${location.id}`);
    }

    const inventoryIds = new Set<string>();
    for (const entry of entity.inventory) {
      if (inventoryIds.has(entry.entityId)) {
        throw new Error(`${entity.id} has duplicate inventory entries for ${entry.entityId}`);
      }
      inventoryIds.add(entry.entityId);
      const item = requireEntity(entities, entry.entityId, `Inventory for ${entity.id}`);
      if (item.kind !== "item") throw new Error(`${entry.entityId} in ${entity.id} inventory is not an item`);
      const owners = inventoryOwners.get(item.id) ?? [];
      owners.push(entity.id);
      inventoryOwners.set(item.id, owners);
    }

    const relationshipTargets = new Set<string>();
    for (const relationship of entity.relationships) {
      requireEntity(entities, relationship.targetId, `Relationship on ${entity.id}`);
      if (relationshipTargets.has(relationship.targetId)) {
        throw new Error(`${entity.id} has duplicate relationships to ${relationship.targetId}`);
      }
      relationshipTargets.add(relationship.targetId);
    }

    for (const fact of entity.facts) {
      if (factIds.has(fact.id)) throw new Error(`Duplicate fact ID ${fact.id}`);
      factIds.add(fact.id);
    }
  }

  for (const [itemId, owners] of inventoryOwners) {
    const item = entities.get(itemId)!;
    if (item.location) {
      throw new Error(`${itemId} is carried by ${owners.join(", ")} and also has world location ${item.location}`);
    }
  }

  for (const location of entities.values()) {
    if (location.kind !== "location") continue;
    const visited = new Set<string>([location.id]);
    let parentId = location.location;
    while (parentId) {
      if (visited.has(parentId)) throw new Error(`Location hierarchy contains a cycle at ${parentId}`);
      visited.add(parentId);
      parentId = entities.get(parentId)?.location;
    }
  }

  const threadIds = new Set<string>();
  for (const thread of threads) {
    if (threadIds.has(thread.id)) throw new Error(`Duplicate thread ID ${thread.id}`);
    threadIds.add(thread.id);
    for (const entityId of thread.relatedEntityIds) {
      requireEntity(entities, entityId, `Thread ${thread.id}`);
    }
  }

  const eventIds = new Set<string>();
  for (const event of chronicle) {
    if (eventIds.has(event.id)) throw new Error(`Duplicate chronicle event ID ${event.id}`);
    eventIds.add(event.id);
    if (event.turn > manifest.turn) throw new Error(`Chronicle event ${event.id} is from future turn ${event.turn}`);
  }
}
