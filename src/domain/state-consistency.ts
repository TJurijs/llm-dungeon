import type { ChronicleEvent, Entity, GameState, Thread } from "../schemas.js";
import { canonicalEntityName } from "./ids.js";
import { rejectDomainChange } from "./validation-error.js";

function requireEntity(entities: Map<string, Entity>, id: string, context: string): Entity {
  const entity = entities.get(id);
  if (!entity) rejectDomainChange(`${context} references unknown entity ${id}`);
  return entity;
}

function inventoryEdge(ownerId: string, itemId: string): string {
  return `${ownerId}\u0000${itemId}`;
}

/**
 * Return every ownership edge that participates in a directed cycle. Comparing
 * these edge sets lets old campaigns retain their already-durable anomaly while
 * ensuring a new transaction cannot introduce another cyclic edge.
 */
export function inventoryCycleEdges(entities: Map<string, Entity>): Set<string> {
  const indexById = new Map<string, number>();
  const lowLinkById = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const components: string[][] = [];
  let nextIndex = 0;

  const visit = (entityId: string): void => {
    indexById.set(entityId, nextIndex);
    lowLinkById.set(entityId, nextIndex);
    nextIndex += 1;
    stack.push(entityId);
    onStack.add(entityId);

    for (const entry of entities.get(entityId)?.inventory ?? []) {
      if (!entities.has(entry.entityId)) continue;
      if (!indexById.has(entry.entityId)) {
        visit(entry.entityId);
        lowLinkById.set(
          entityId,
          Math.min(lowLinkById.get(entityId)!, lowLinkById.get(entry.entityId)!),
        );
      } else if (onStack.has(entry.entityId)) {
        lowLinkById.set(
          entityId,
          Math.min(lowLinkById.get(entityId)!, indexById.get(entry.entityId)!),
        );
      }
    }

    if (lowLinkById.get(entityId) !== indexById.get(entityId)) return;
    const component: string[] = [];
    while (stack.length) {
      const member = stack.pop()!;
      onStack.delete(member);
      component.push(member);
      if (member === entityId) break;
    }
    components.push(component);
  };

  for (const entityId of entities.keys()) {
    if (!indexById.has(entityId)) visit(entityId);
  }

  const cyclicEdges = new Set<string>();
  for (const component of components) {
    const members = new Set(component);
    for (const ownerId of component) {
      for (const entry of entities.get(ownerId)?.inventory ?? []) {
        if (members.has(entry.entityId) && (component.length > 1 || entry.entityId === ownerId)) {
          cyclicEdges.add(inventoryEdge(ownerId, entry.entityId));
        }
      }
    }
  }
  return cyclicEdges;
}

export interface CampaignStateConsistencyOptions {
  allowedInventoryCycleEdges?: ReadonlySet<string>;
}

function assertNoNewInventoryCycles(
  entities: Map<string, Entity>,
  allowedEdges: ReadonlySet<string>,
): void {
  const newCyclicEdges = [...inventoryCycleEdges(entities)]
    .filter((edge) => !allowedEdges.has(edge))
    .sort();
  if (!newCyclicEdges.length) return;
  const readable = newCyclicEdges.map((edge) => edge.replace("\u0000", " -> ")).join(", ");
  rejectDomainChange(`Inventory ownership contains a cycle: ${readable}`);
}

/**
 * Normalize the one historical physical representation that is unambiguous:
 * an otherwise-unowned item whose location points at a location entity. The
 * returned IDs identify documents that should be rewritten in canonical form
 * by the next successful turn commit.
 */
export function normalizeLegacyLooseItemOwnership(entities: Map<string, Entity>): Set<string> {
  const ownersByItem = new Map<string, Entity[]>();
  for (const owner of entities.values()) {
    for (const entry of owner.inventory) {
      const owners = ownersByItem.get(entry.entityId) ?? [];
      owners.push(owner);
      ownersByItem.set(entry.entityId, owners);
    }
  }

  const normalizedEntityIds = new Set<string>();
  for (const item of entities.values()) {
    if (item.kind !== "item" || !item.location) continue;
    const location = entities.get(item.location);
    if (location?.kind !== "location") continue;
    const owners = ownersByItem.get(item.id) ?? [];
    if (owners.length === 0) {
      location.inventory.push({ entityId: item.id, quantity: 1 });
      delete item.location;
      normalizedEntityIds.add(location.id);
      normalizedEntityIds.add(item.id);
      ownersByItem.set(item.id, [location]);
    } else if (owners.length === 1 && owners[0]!.id === location.id) {
      delete item.location;
      normalizedEntityIds.add(item.id);
    }
  }
  return normalizedEntityIds;
}

/** Validate referential and physical invariants for one complete campaign snapshot. */
export function assertCampaignStateConsistency(
  manifest: GameState,
  entities: Map<string, Entity>,
  threads: Thread[],
  chronicle: ChronicleEvent[],
  options: CampaignStateConsistencyOptions = {},
): void {
  const allowedInventoryCycleEdges = options.allowedInventoryCycleEdges ?? new Set<string>();
  const player = requireEntity(entities, manifest.playerId, "Campaign player");
  const currentLocation = requireEntity(entities, manifest.currentLocationId, "Current location");
  if (currentLocation.kind !== "location") {
    rejectDomainChange(`Current location ${currentLocation.id} is not a location entity`);
  }
  if (player.location !== currentLocation.id) {
    rejectDomainChange(
      `Player location ${player.location ?? "missing"} does not match manifest location ${currentLocation.id}`,
    );
  }
  if (manifest.status === "active" && (player.status === "dead" || player.status === "ended")) {
    rejectDomainChange(
      `Player terminal status ${player.status} requires a matching campaign ending`,
    );
  }
  if (manifest.status !== "active" && player.status !== manifest.status) {
    rejectDomainChange(
      `Player status ${player.status} does not match ended campaign status ${manifest.status}`,
    );
  }

  const inventoryOwners = new Map<string, string[]>();
  const factIds = new Set<string>();
  const locationsByName = new Map<string, string>();
  for (const entity of entities.values()) {
    if (entity.kind === "location") {
      const canonicalName = canonicalEntityName(entity.name);
      const duplicate = locationsByName.get(canonicalName);
      if (duplicate) {
        rejectDomainChange(
          `Location ${entity.id} duplicates established location ${duplicate} by canonical name`,
        );
      }
      locationsByName.set(canonicalName, entity.id);
    }
    if (entity.location) {
      if (entity.location === entity.id)
        rejectDomainChange(`${entity.id} cannot be located inside itself`);
      const location = requireEntity(entities, entity.location, `Entity ${entity.id}`);
      if (location.kind !== "location")
        rejectDomainChange(`${entity.id} has non-location parent ${location.id}`);
    }

    const inventoryIds = new Set<string>();
    for (const entry of entity.inventory) {
      if (inventoryIds.has(entry.entityId)) {
        rejectDomainChange(`${entity.id} has duplicate inventory entries for ${entry.entityId}`);
      }
      inventoryIds.add(entry.entityId);
      const item = requireEntity(entities, entry.entityId, `Inventory for ${entity.id}`);
      if (item.kind !== "item")
        rejectDomainChange(`${entry.entityId} in ${entity.id} inventory is not an item`);
      if (
        item.id === entity.id &&
        !allowedInventoryCycleEdges.has(inventoryEdge(entity.id, item.id))
      )
        rejectDomainChange(`${entity.id} cannot contain itself in inventory`);
      const owners = inventoryOwners.get(item.id) ?? [];
      owners.push(entity.id);
      inventoryOwners.set(item.id, owners);
    }

    const relationshipTargets = new Set<string>();
    for (const relationship of entity.relationships) {
      requireEntity(entities, relationship.targetId, `Relationship on ${entity.id}`);
      if (relationshipTargets.has(relationship.targetId)) {
        rejectDomainChange(`${entity.id} has duplicate relationships to ${relationship.targetId}`);
      }
      relationshipTargets.add(relationship.targetId);
    }

    for (const fact of entity.facts) {
      if (factIds.has(fact.id)) rejectDomainChange(`Duplicate fact ID ${fact.id}`);
      factIds.add(fact.id);
    }
  }

  assertNoNewInventoryCycles(entities, allowedInventoryCycleEdges);

  for (const [itemId, owners] of inventoryOwners) {
    const item = entities.get(itemId)!;
    if (item.location) {
      rejectDomainChange(
        `${itemId} is carried by ${owners.join(", ")} and also has world location ${item.location}`,
      );
    }
  }

  for (const location of entities.values()) {
    if (location.kind !== "location") continue;
    const visited = new Set<string>([location.id]);
    let parentId = location.location;
    while (parentId) {
      if (visited.has(parentId))
        rejectDomainChange(`Location hierarchy contains a cycle at ${parentId}`);
      visited.add(parentId);
      parentId = entities.get(parentId)?.location;
    }
  }

  const threadIds = new Set<string>();
  for (const thread of threads) {
    if (threadIds.has(thread.id)) rejectDomainChange(`Duplicate thread ID ${thread.id}`);
    threadIds.add(thread.id);
    for (const entityId of thread.relatedEntityIds) {
      requireEntity(entities, entityId, `Thread ${thread.id}`);
    }
  }

  const eventIds = new Set<string>();
  for (const event of chronicle) {
    if (eventIds.has(event.id)) rejectDomainChange(`Duplicate chronicle event ID ${event.id}`);
    eventIds.add(event.id);
    if (event.turn > manifest.turn)
      rejectDomainChange(`Chronicle event ${event.id} is from future turn ${event.turn}`);
  }
}
