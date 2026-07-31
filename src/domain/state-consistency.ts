import type { ChronicleEvent, Entity, GameState, Thread } from "../schemas.js";
import { canonicalEntityName } from "./ids.js";
import { DomainValidationError, rejectDomainChange } from "./validation-error.js";
import type { DomainViolationCollector } from "./violations.js";

function requireEntity(entities: Map<string, Entity>, id: string, context: string): Entity {
  const entity = entities.get(id);
  if (!entity)
    rejectDomainChange(`${context} references unknown entity ${id}`, "state_unknown_entity");
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
  /**
   * Exact pre-transaction ownership quantities. Existing saves may contain an
   * older multi-owner anomaly, and a conserved partial transfer may split one
   * stack between owners. The resulting state may preserve or reduce that
   * baseline, but it may not add quantity or spread an existing anomaly to a
   * new owner.
   */
  baselineInventoryOwnership?: InventoryOwnershipSnapshot;
}

export type InventoryOwnershipSnapshot = ReadonlyMap<string, ReadonlyMap<string, number>>;

/** Capture inventory quantities by item and owner for compatibility checks. */
export function inventoryOwnershipSnapshot(
  entities: Map<string, Entity>,
): Map<string, Map<string, number>> {
  const ownership = new Map<string, Map<string, number>>();
  for (const owner of entities.values()) {
    for (const entry of owner.inventory) {
      const owners = ownership.get(entry.entityId) ?? new Map<string, number>();
      owners.set(owner.id, (owners.get(owner.id) ?? 0) + entry.quantity);
      ownership.set(entry.entityId, owners);
    }
  }
  return ownership;
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
  rejectDomainChange(`Inventory ownership contains a cycle: ${readable}`, "inventory_cycle");
}

function ownershipTotal(owners: ReadonlyMap<string, number>): number {
  return [...owners.values()].reduce((total, quantity) => total + quantity, 0);
}

/**
 * New snapshots cannot begin with ambiguous multi-owner custody. During a
 * transaction, a conserved partial transfer may split a pre-existing stack,
 * while a legacy split may remain in place or be reduced. Abstract inventory
 * credits cannot increase that split, and an existing legacy split cannot
 * expand to additional simultaneous owners. A conserved handoff may replace
 * one owner with another without increasing either quantity or owner count.
 */
function assertNoNewOrEnlargedDuplicateOwnership(
  current: InventoryOwnershipSnapshot,
  baseline: InventoryOwnershipSnapshot,
): void {
  for (const [itemId, owners] of current) {
    if (owners.size <= 1) continue;
    const previousOwners = baseline.get(itemId);
    const currentTotal = ownershipTotal(owners);
    const previousTotal = previousOwners ? ownershipTotal(previousOwners) : 0;
    const spreadLegacyDuplicate =
      previousOwners !== undefined &&
      previousOwners.size > 1 &&
      owners.size > previousOwners.size &&
      [...owners.keys()].some((ownerId) => !previousOwners.has(ownerId));
    if (
      previousOwners !== undefined &&
      previousOwners.size > 0 &&
      currentTotal <= previousTotal &&
      !spreadLegacyDuplicate
    ) {
      continue;
    }
    const ownerList = [...owners.keys()].sort().join(", ");
    const reason =
      previousOwners === undefined || previousOwners.size === 0
        ? "has no authoritative pre-state ownership to conserve"
        : currentTotal > previousTotal
          ? `increases total quantity from ${previousTotal} to ${currentTotal}`
          : "spreads a legacy duplicate to a new owner";
    rejectDomainChange(
      `Inventory ownership for ${itemId} is duplicated across ${ownerList} and ${reason}; use transfer_item to conserve known ownership`,
      "inventory_duplicate_ownership",
    );
  }
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
  collector?: DomainViolationCollector,
): void {
  if (collector) {
    // Whole-state verification runs only after admission is clean, so its
    // faults are reported through the same collected envelope as the rest of
    // the transaction rather than as a separate error path.
    try {
      verifyCampaignStateConsistency(manifest, entities, threads, chronicle, options);
    } catch (error) {
      if (!(error instanceof DomainValidationError)) throw error;
      if (error.violations.length === 0) collector.add("domain_rule", error.message);
      for (const violation of error.violations) collector.add(violation.code, violation.message);
    }
    return;
  }
  verifyCampaignStateConsistency(manifest, entities, threads, chronicle, options);
}

function verifyCampaignStateConsistency(
  manifest: GameState,
  entities: Map<string, Entity>,
  threads: Thread[],
  chronicle: ChronicleEvent[],
  options: CampaignStateConsistencyOptions = {},
): void {
  const allowedInventoryCycleEdges = options.allowedInventoryCycleEdges ?? new Set<string>();
  const baselineInventoryOwnership = options.baselineInventoryOwnership ?? new Map();
  const player = requireEntity(entities, manifest.playerId, "Campaign player");
  const currentLocation = requireEntity(entities, manifest.currentLocationId, "Current location");
  if (currentLocation.kind !== "location") {
    rejectDomainChange(
      `Current location ${currentLocation.id} is not a location entity`,
      "current_location_not_location",
    );
  }
  if (player.location !== currentLocation.id) {
    rejectDomainChange(
      `Player location ${player.location ?? "missing"} does not match manifest location ${currentLocation.id}`,
      "player_location_mismatch",
    );
  }
  if (manifest.status === "active" && (player.status === "dead" || player.status === "ended")) {
    rejectDomainChange(
      `Player terminal status ${player.status} requires a matching campaign ending`,
      "player_status_terminal_mismatch",
    );
  }
  if (manifest.status !== "active" && player.status !== manifest.status) {
    rejectDomainChange(
      `Player status ${player.status} does not match ended campaign status ${manifest.status}`,
      "player_status_mismatch",
    );
  }

  const inventoryOwners = new Map<string, Map<string, number>>();
  const factIds = new Set<string>();
  const locationsByName = new Map<string, string>();
  for (const entity of entities.values()) {
    if (entity.kind === "location") {
      const canonicalName = canonicalEntityName(entity.name);
      const duplicate = locationsByName.get(canonicalName);
      if (duplicate) {
        rejectDomainChange(
          `Location ${entity.id} duplicates established location ${duplicate} by canonical name`,
          "location_name_duplicate",
        );
      }
      locationsByName.set(canonicalName, entity.id);
    }
    if (entity.location) {
      if (entity.location === entity.id)
        rejectDomainChange(`${entity.id} cannot be located inside itself`, "self_containment");
      const location = requireEntity(entities, entity.location, `Entity ${entity.id}`);
      if (location.kind !== "location")
        rejectDomainChange(
          `${entity.id} has non-location parent ${location.id}`,
          "non_location_parent",
        );
    }

    const inventoryIds = new Set<string>();
    for (const entry of entity.inventory) {
      if (inventoryIds.has(entry.entityId)) {
        rejectDomainChange(
          `${entity.id} has duplicate inventory entries for ${entry.entityId}`,
          "inventory_duplicate_entry",
        );
      }
      inventoryIds.add(entry.entityId);
      const item = requireEntity(entities, entry.entityId, `Inventory for ${entity.id}`);
      if (item.kind !== "item")
        rejectDomainChange(
          `${entry.entityId} in ${entity.id} inventory is not an item`,
          "inventory_non_item",
        );
      if (
        item.id === entity.id &&
        !allowedInventoryCycleEdges.has(inventoryEdge(entity.id, item.id))
      )
        rejectDomainChange(
          `${entity.id} cannot contain itself in inventory`,
          "inventory_self_containment",
        );
      const owners = inventoryOwners.get(item.id) ?? new Map<string, number>();
      owners.set(entity.id, (owners.get(entity.id) ?? 0) + entry.quantity);
      inventoryOwners.set(item.id, owners);
    }

    const relationshipTargets = new Set<string>();
    for (const relationship of entity.relationships) {
      requireEntity(entities, relationship.targetId, `Relationship on ${entity.id}`);
      if (relationshipTargets.has(relationship.targetId)) {
        rejectDomainChange(
          `${entity.id} has duplicate relationships to ${relationship.targetId}`,
          "relationship_duplicate",
        );
      }
      relationshipTargets.add(relationship.targetId);
    }

    for (const fact of entity.facts) {
      if (factIds.has(fact.id))
        rejectDomainChange(`Duplicate fact ID ${fact.id}`, "fact_id_duplicate");
      factIds.add(fact.id);
    }
  }

  assertNoNewInventoryCycles(entities, allowedInventoryCycleEdges);
  assertNoNewOrEnlargedDuplicateOwnership(inventoryOwners, baselineInventoryOwnership);

  for (const [itemId, owners] of inventoryOwners) {
    const item = entities.get(itemId)!;
    if (item.location) {
      rejectDomainChange(
        `${itemId} is carried by ${[...owners.keys()].join(", ")} and also has world location ${item.location}`,
        "item_dual_placement",
      );
    }
  }

  for (const location of entities.values()) {
    if (location.kind !== "location") continue;
    const visited = new Set<string>([location.id]);
    let parentId = location.location;
    while (parentId) {
      if (visited.has(parentId))
        rejectDomainChange(
          `Location hierarchy contains a cycle at ${parentId}`,
          "location_hierarchy_cycle",
        );
      visited.add(parentId);
      parentId = entities.get(parentId)?.location;
    }
  }

  const threadIds = new Set<string>();
  for (const thread of threads) {
    if (threadIds.has(thread.id))
      rejectDomainChange(`Duplicate thread ID ${thread.id}`, "thread_id_duplicate");
    threadIds.add(thread.id);
    if (thread.createdTurn !== undefined && thread.createdTurn > manifest.turn) {
      rejectDomainChange(
        `Thread ${thread.id} was created in future turn ${thread.createdTurn}`,
        "thread_future_created",
      );
    }
    if (
      thread.createdTurn !== undefined &&
      thread.updatedTurn !== undefined &&
      thread.updatedTurn < thread.createdTurn
    ) {
      rejectDomainChange(
        `Thread ${thread.id} was updated before it was created`,
        "thread_updated_before_created",
      );
    }
    if (thread.updatedTurn !== undefined && thread.updatedTurn > manifest.turn) {
      rejectDomainChange(
        `Thread ${thread.id} was updated in future turn ${thread.updatedTurn}`,
        "thread_future_updated",
      );
    }
    if (thread.status === "active" && thread.closedTurn !== undefined) {
      rejectDomainChange(
        `Active thread ${thread.id} cannot have a closure turn`,
        "thread_active_with_closure",
      );
    }
    if (thread.closedTurn !== undefined) {
      if (thread.closedTurn > manifest.turn) {
        rejectDomainChange(
          `Thread ${thread.id} was closed in future turn ${thread.closedTurn}`,
          "thread_future_closed",
        );
      }
      if (thread.updatedTurn !== undefined && thread.closedTurn < thread.updatedTurn) {
        rejectDomainChange(
          `Thread ${thread.id} was closed before its latest update`,
          "thread_closed_before_update",
        );
      }
    }
    for (const entityId of thread.relatedEntityIds) {
      requireEntity(entities, entityId, `Thread ${thread.id}`);
    }
  }

  const eventIds = new Set<string>();
  for (const event of chronicle) {
    if (eventIds.has(event.id))
      rejectDomainChange(`Duplicate chronicle event ID ${event.id}`, "chronicle_id_duplicate");
    eventIds.add(event.id);
    if (event.turn > manifest.turn)
      rejectDomainChange(
        `Chronicle event ${event.id} is from future turn ${event.turn}`,
        "chronicle_future_turn",
      );
  }
}
