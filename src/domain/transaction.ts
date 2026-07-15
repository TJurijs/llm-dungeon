import { assertDeterministicConsistency } from "./operation-consistency.js";
import { assertCampaignStateConsistency } from "./state-consistency.js";
import {
  EntitySchema,
  StateOperationSchema,
  type ChronicleEvent,
  type Entity,
  type Fact,
  type GameState,
  type StateOperation,
  type Thread,
} from "../schemas.js";
import { allocateGeneratedId, canonicalEntityName } from "./ids.js";

function assignGeneratedIds(
  input: StateOperation[],
  turn: number,
  entities: Map<string, Entity>,
  threads: Thread[],
  chronicle: ChronicleEvent[],
): StateOperation[] {
  const namespaceForKind: Record<Entity["kind"], string> = {
    person: "npc", location: "location", item: "item", faction: "faction",
    creature: "creature", event: "event", other: "entity",
  };
  const usedEntities = new Set(entities.keys());
  const entityHints = new Map<string, string>();
  for (const operation of input) {
    if (operation.type !== "create_entity") continue;
    if (entityHints.has(operation.entity.id)) throw new Error(`Duplicate new entity reference hint ${operation.entity.id}`);
    entityHints.set(
      operation.entity.id,
      allocateGeneratedId(namespaceForKind[operation.entity.kind], operation.entity.name, turn, usedEntities),
    );
  }
  const entityReference = (id: string): string => entityHints.get(id) ?? id;
  const operations = input.map((operation): StateOperation => {
    switch (operation.type) {
      case "create_entity": return {
        ...operation,
        entity: {
          ...operation.entity,
          id: entityReference(operation.entity.id),
          ...(operation.entity.location ? { location: entityReference(operation.entity.location) } : {}),
        },
      };
      case "add_fact":
      case "supersede_fact":
      case "set_entity_state":
      case "add_condition":
      case "remove_condition":
      case "add_trait":
        return { ...operation, targetId: entityReference(operation.targetId) };
      case "move_entity":
        return { ...operation, targetId: entityReference(operation.targetId), locationId: entityReference(operation.locationId) };
      case "change_inventory":
        return { ...operation, ownerId: entityReference(operation.ownerId), itemId: entityReference(operation.itemId) };
      case "transfer_item": return {
        ...operation,
        fromId: entityReference(operation.fromId),
        toId: entityReference(operation.toId),
        itemId: entityReference(operation.itemId),
      };
      case "set_relationship":
        return { ...operation, sourceId: entityReference(operation.sourceId), targetId: entityReference(operation.targetId) };
      case "create_thread":
        return { ...operation, relatedEntityIds: operation.relatedEntityIds.map(entityReference) };
      case "update_thread":
        return operation.relatedEntityIds === undefined
          ? operation
          : { ...operation, relatedEntityIds: operation.relatedEntityIds.map(entityReference) };
      default: return operation;
    }
  });

  const usedFacts = new Set([...entities.values()].flatMap((entity) => entity.facts.map((fact) => fact.id)));
  const usedThreads = new Set(threads.map((thread) => thread.id));
  const usedEvents = new Set(chronicle.map((event) => event.id));
  const factHints = new Map<string, string>();
  const threadHints = new Map<string, string>();
  const generated = operations.map((operation): StateOperation => {
    if (operation.type === "add_fact") {
      const factId = allocateGeneratedId("fact", operation.targetId, turn, usedFacts);
      if (operation.factId !== "generated:auto" && !factHints.has(operation.factId)) factHints.set(operation.factId, factId);
      return { ...operation, factId };
    }
    if (operation.type === "supersede_fact") {
      const replacementFactId = allocateGeneratedId("fact", operation.targetId, turn, usedFacts);
      if (operation.replacementFactId !== "generated:auto" && !factHints.has(operation.replacementFactId)) {
        factHints.set(operation.replacementFactId, replacementFactId);
      }
      return { ...operation, replacementFactId };
    }
    if (operation.type === "create_thread") {
      const threadId = allocateGeneratedId("thread", operation.title, turn, usedThreads);
      if (operation.threadId !== "generated:auto" && !threadHints.has(operation.threadId)) threadHints.set(operation.threadId, threadId);
      return { ...operation, threadId };
    }
    if (operation.type === "record_major_event") {
      return { ...operation, eventId: allocateGeneratedId("event", operation.text, turn, usedEvents) };
    }
    return structuredClone(operation);
  });

  return StateOperationSchema.array().parse(generated.map((operation): StateOperation => {
    if (operation.type === "supersede_fact") {
      return { ...operation, factId: factHints.get(operation.factId) ?? operation.factId };
    }
    if (operation.type === "update_thread" || operation.type === "resolve_thread") {
      return { ...operation, threadId: threadHints.get(operation.threadId) ?? operation.threadId };
    }
    return operation;
  }));
}

function remapEntityReferences(operation: StateOperation, references: Map<string, string>): StateOperation {
  const entity = (id: string): string => {
    let current = id;
    const visited = new Set<string>();
    while (references.has(current) && !visited.has(current)) {
      visited.add(current);
      current = references.get(current)!;
    }
    return current;
  };
  switch (operation.type) {
    case "create_entity": return {
      ...operation,
      entity: {
        ...operation.entity,
        ...(operation.entity.location ? { location: entity(operation.entity.location) } : {}),
      },
    };
    case "add_fact":
    case "supersede_fact":
    case "set_entity_state":
    case "add_condition":
    case "remove_condition":
    case "add_trait":
      return { ...operation, targetId: entity(operation.targetId) };
    case "move_entity":
      return { ...operation, targetId: entity(operation.targetId), locationId: entity(operation.locationId) };
    case "change_inventory":
      return { ...operation, ownerId: entity(operation.ownerId), itemId: entity(operation.itemId) };
    case "transfer_item": return {
      ...operation,
      fromId: entity(operation.fromId),
      toId: entity(operation.toId),
      itemId: entity(operation.itemId),
    };
    case "set_relationship":
      return { ...operation, sourceId: entity(operation.sourceId), targetId: entity(operation.targetId) };
    case "create_thread":
      return { ...operation, relatedEntityIds: operation.relatedEntityIds.map(entity) };
    case "update_thread":
      return operation.relatedEntityIds === undefined
        ? operation
        : { ...operation, relatedEntityIds: operation.relatedEntityIds.map(entity) };
    default:
      return operation;
  }
}

function normalizedReferenceText(value: string): string {
  return referenceSuffix(value).toLowerCase().replace(/[^a-z0-9]/g, "");
}

function editDistance(left: string, right: string): number {
  if (!left.length) return right.length;
  if (!right.length) return left.length;
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    const current = [leftIndex];
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      current[rightIndex] = Math.min(
        current[rightIndex - 1]! + 1,
        previous[rightIndex]! + 1,
        previous[rightIndex - 1]! + (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1),
      );
    }
    previous = current;
  }
  return previous[right.length]!;
}

/**
 * Repair only high-confidence spelling slips that point at an entity created in
 * this same transaction. This is intentionally narrower than fuzzy matching
 * the whole world: established IDs still require exact, authoritative matches.
 */
function normalizeNearMissCreatedEntityReferences(
  operations: StateOperation[],
  entities: Map<string, Entity>,
): StateOperation[] {
  const creations = operations.flatMap((operation) => operation.type === "create_entity" ? [operation.entity] : []);
  if (!creations.length) return operations;
  const exactIds = new Set([...entities.keys(), ...creations.map((entity) => entity.id)]);
  const references = new Map<string, string>();
  const consider = (raw: string, expectedKind?: Entity["kind"]): void => {
    if (!raw || exactIds.has(raw) || references.has(raw)) return;
    const normalized = normalizedReferenceText(raw);
    if (normalized.length < 5) return;
    const rawNamespace = raw.includes(":") ? raw.slice(0, raw.indexOf(":")) : undefined;
    const scored = creations
      .filter((entity) => !expectedKind || entity.kind === expectedKind)
      .filter((entity) => !rawNamespace || entity.id.startsWith(`${rawNamespace}:`))
      .map((entity) => {
        const candidates = [normalizedReferenceText(entity.id), normalizedReferenceText(entity.name)];
        const similarity = Math.max(...candidates.map((candidate) => {
          const longest = Math.max(normalized.length, candidate.length);
          return longest ? 1 - editDistance(normalized, candidate) / longest : 0;
        }));
        return { id: entity.id, similarity };
      })
      .sort((left, right) => right.similarity - left.similarity || left.id.localeCompare(right.id));
    const best = scored[0];
    const runnerUp = scored[1];
    if (best && best.similarity >= 0.8 && (!runnerUp || best.similarity - runnerUp.similarity >= 0.1)) {
      references.set(raw, best.id);
    }
  };
  for (const operation of operations) {
    switch (operation.type) {
      case "create_entity":
        if (operation.entity.location) consider(operation.entity.location, "location");
        break;
      case "add_fact":
      case "supersede_fact":
      case "set_entity_state":
      case "add_condition":
      case "remove_condition":
      case "add_trait":
        consider(operation.targetId);
        break;
      case "move_entity":
        consider(operation.targetId);
        consider(operation.locationId, "location");
        break;
      case "change_inventory":
        consider(operation.ownerId);
        consider(operation.itemId, "item");
        break;
      case "transfer_item":
        consider(operation.fromId);
        consider(operation.toId);
        consider(operation.itemId, "item");
        break;
      case "set_relationship":
        consider(operation.sourceId);
        consider(operation.targetId);
        break;
      case "create_thread":
        operation.relatedEntityIds.forEach((id) => consider(id));
        break;
      case "update_thread":
        operation.relatedEntityIds?.forEach((id) => consider(id));
        break;
      default:
        break;
    }
  }
  return StateOperationSchema.array().parse(operations.map((operation) => remapEntityReferences(operation, references)));
}

/**
 * A model may redundantly "create" a named location that already exists while
 * narrating travel. Exact canonical-name matches are references, not creative
 * mutations: reuse the authoritative entity and remap the entire transaction.
 */
function coalesceDuplicateLocationCreates(
  operations: StateOperation[],
  entities: Map<string, Entity>,
): StateOperation[] {
  const locationsByName = new Map(
    [...entities.values()]
      .filter((entity) => entity.kind === "location")
      .map((entity) => [canonicalEntityName(entity.name), entity.id]),
  );
  const references = new Map<string, string>();
  const retained: StateOperation[] = [];
  for (const operation of operations) {
    if (operation.type !== "create_entity" || operation.entity.kind !== "location") {
      retained.push(operation);
      continue;
    }
    const canonical = canonicalEntityName(operation.entity.name);
    const existingId = locationsByName.get(canonical);
    if (existingId) {
      references.set(operation.entity.id, existingId);
      continue;
    }
    locationsByName.set(canonical, operation.entity.id);
    retained.push(operation);
  }
  return StateOperationSchema.array().parse(retained.map((operation) => remapEntityReferences(operation, references)));
}

/**
 * A newly created item's model-supplied location expresses its first owner.
 * Inventory is authoritative for both carried and loose objects, so normalize
 * that exact reference into ownership instead of retaining a parallel location.
 */
function normalizeCreatedItemOwnership(
  operations: StateOperation[],
  entities: Map<string, Entity>,
): StateOperation[] {
  const inventoryOwners = new Map<string, Set<string>>();
  const entityKinds = new Map([...entities.values()].map((entity) => [entity.id, entity.kind]));
  for (const operation of operations) {
    if (operation.type === "create_entity") {
      entityKinds.set(operation.entity.id, operation.entity.kind);
    } else if (operation.type === "change_inventory" && operation.quantityDelta > 0) {
      const owners = inventoryOwners.get(operation.itemId) ?? new Set<string>();
      owners.add(operation.ownerId);
      inventoryOwners.set(operation.itemId, owners);
    } else if (operation.type === "transfer_item") {
      const owners = inventoryOwners.get(operation.itemId) ?? new Set<string>();
      owners.add(operation.toId);
      inventoryOwners.set(operation.itemId, owners);
    }
  }
  return StateOperationSchema.array().parse(operations.flatMap((operation): StateOperation[] => {
    if (operation.type !== "create_entity" || operation.entity.kind !== "item" || !operation.entity.location) return [operation];
    const owners = inventoryOwners.get(operation.entity.id);
    const suppliedOwnerKind = entityKinds.get(operation.entity.location);
    if (suppliedOwnerKind === undefined) return [operation];
    const { location: _location, ...entity } = operation.entity;
    if (owners?.size) return [{ ...operation, entity }];
    return [
      { ...operation, entity },
      { type: "change_inventory", ownerId: operation.entity.location, itemId: operation.entity.id, quantityDelta: 1 },
    ];
  }));
}

function referenceSuffix(id: string): string {
  const separator = id.indexOf(":");
  return separator === -1 ? id : id.slice(separator + 1);
}

function resolveReference(raw: string, candidates: Iterable<string>, type: string): string {
  const reference = raw.trim();
  const available = [...new Set(candidates)];
  if (available.includes(reference)) return reference;
  if (reference.includes(":")) throw new Error(`Unknown ${type} reference ${reference}`);
  const matches = available.filter((candidate) => referenceSuffix(candidate) === reference);
  if (matches.length === 1) return matches[0]!;
  if (!matches.length) throw new Error(`Unknown ${type} reference ${reference}`);
  throw new Error(`Ambiguous ${type} reference ${reference}: ${matches.sort().join(", ")}`);
}

function normalizeReferences(
  operations: StateOperation[],
  entities: Map<string, Entity>,
  threads: Thread[],
): StateOperation[] {
  const entityKinds = new Map([...entities.values()].map((entity) => [entity.id, entity.kind]));
  for (const operation of operations) {
    if (operation.type === "create_entity") entityKinds.set(operation.entity.id, operation.entity.kind);
  }
  const entityIds = [...entityKinds.keys()];
  const locationIds = entityIds.filter((id) => entityKinds.get(id) === "location");
  const itemIds = entityIds.filter((id) => entityKinds.get(id) === "item");
  const threadIds = [
    ...threads.map((thread) => thread.id),
    ...operations.filter((operation) => operation.type === "create_thread").map((operation) => operation.threadId),
  ];
  const entity = (value: string) => resolveReference(value, entityIds, "entity");
  const location = (value: string) => resolveReference(value, locationIds, "location");
  const item = (value: string) => resolveReference(value, itemIds, "item");
  const thread = (value: string) => resolveReference(value, threadIds, "thread");
  const normalized = operations.map((operation): StateOperation => {
    switch (operation.type) {
      case "create_entity":
        return operation.entity.location
          ? { ...operation, entity: { ...operation.entity, location: location(operation.entity.location) } }
          : operation;
      case "add_fact":
      case "supersede_fact":
      case "set_entity_state":
      case "add_condition":
      case "remove_condition":
      case "add_trait":
        return { ...operation, targetId: entity(operation.targetId) };
      case "move_entity": return { ...operation, targetId: entity(operation.targetId), locationId: location(operation.locationId) };
      case "change_inventory": return { ...operation, ownerId: entity(operation.ownerId), itemId: item(operation.itemId) };
      case "transfer_item": return {
        ...operation,
        fromId: entity(operation.fromId),
        toId: entity(operation.toId),
        itemId: item(operation.itemId),
      };
      case "set_relationship": return { ...operation, sourceId: entity(operation.sourceId), targetId: entity(operation.targetId) };
      case "create_thread": return { ...operation, relatedEntityIds: operation.relatedEntityIds.map(entity) };
      case "update_thread": return {
        ...operation,
        threadId: thread(operation.threadId),
        ...(operation.relatedEntityIds === undefined ? {} : { relatedEntityIds: operation.relatedEntityIds.map(entity) }),
      };
      case "resolve_thread": return { ...operation, threadId: thread(operation.threadId) };
      default: return operation;
    }
  });
  return StateOperationSchema.array().parse(normalized.map((operation): StateOperation => {
    if (operation.type !== "supersede_fact") return operation;
    const facts = [
      ...(entities.get(operation.targetId)?.facts.filter((fact) => fact.active).map((fact) => fact.id) ?? []),
      ...normalized.flatMap((candidate) =>
        candidate.type === "add_fact" && candidate.targetId === operation.targetId ? [candidate.factId] : []),
    ];
    return { ...operation, factId: resolveReference(operation.factId, facts, `active fact on ${operation.targetId}`) };
  }));
}

/** Convert an exact debit/credit pair into the atomic transfer it expresses. */
function normalizeAtomicItemTransfers(operations: StateOperation[]): StateOperation[] {
  const replacements = new Map<number, StateOperation>();
  const removed = new Set<number>();
  const itemChanges = new Map<string, Array<{ index: number; operation: Extract<StateOperation, { type: "change_inventory" }> }>>();
  const itemsWithOtherDestinations = new Set<string>();
  operations.forEach((operation, index) => {
    if (operation.type === "change_inventory") {
      const changes = itemChanges.get(operation.itemId) ?? [];
      changes.push({ index, operation });
      itemChanges.set(operation.itemId, changes);
    } else if (operation.type === "transfer_item") {
      itemsWithOtherDestinations.add(operation.itemId);
    } else if (operation.type === "move_entity") {
      itemsWithOtherDestinations.add(operation.targetId);
    }
  });
  for (const [itemId, changes] of itemChanges) {
    if (changes.length !== 2 || itemsWithOtherDestinations.has(itemId)) continue;
    const debit = changes.find(({ operation }) => operation.quantityDelta < 0);
    const credit = changes.find(({ operation }) => operation.quantityDelta > 0);
    if (!debit || !credit || -debit.operation.quantityDelta !== credit.operation.quantityDelta) continue;
    const first = Math.min(debit.index, credit.index);
    const second = Math.max(debit.index, credit.index);
    replacements.set(first, {
      type: "transfer_item",
      fromId: debit.operation.ownerId,
      toId: credit.operation.ownerId,
      itemId,
      quantity: credit.operation.quantityDelta,
    });
    removed.add(second);
  }
  return StateOperationSchema.array().parse(operations.flatMap((operation, index) => {
    if (removed.has(index)) return [];
    return [replacements.get(index) ?? operation];
  }));
}

/** A move to the entity's already-authoritative location is an idempotent no-op. */
function normalizeNoOpMovements(operations: StateOperation[], entities: Map<string, Entity>): StateOperation[] {
  const locations = new Map(
    [...entities.values()].flatMap((entity) => entity.location ? [[entity.id, entity.location] as const] : []),
  );
  for (const operation of operations) {
    if (operation.type === "create_entity" && operation.entity.location) {
      locations.set(operation.entity.id, operation.entity.location);
    }
  }
  const retained: StateOperation[] = [];
  for (const operation of operations) {
    if (operation.type === "move_entity") {
      if (locations.get(operation.targetId) === operation.locationId) continue;
      locations.set(operation.targetId, operation.locationId);
    }
    retained.push(operation);
  }
  return StateOperationSchema.array().parse(retained);
}

function assertNoRepeatedAbstractInventoryCredit(
  operations: StateOperation[],
  previousOperations: StateOperation[],
): void {
  const previousCredits = new Set(previousOperations.flatMap((operation) =>
    operation.type === "change_inventory" && operation.quantityDelta > 0
      ? [`${operation.ownerId}\u0000${operation.itemId}\u0000${operation.quantityDelta}`]
      : []));
  for (const operation of operations) {
    if (operation.type !== "change_inventory" || operation.quantityDelta <= 0) continue;
    const fingerprint = `${operation.ownerId}\u0000${operation.itemId}\u0000${operation.quantityDelta}`;
    if (previousCredits.has(fingerprint)) {
      throw new Error(
        `Repeated abstract inventory credit: ${operation.ownerId} already received +${operation.quantityDelta} ${operation.itemId} in the latest gameplay/appeal operation-ledger window. `
        + "If this turn only handles, pockets, counts, or stows that existing inventory, remove the operation. A genuinely new receipt must be represented by a distinct current-turn source, preferably transfer_item from its owner.",
      );
    }
  }
}

function prepareOperations(
  operations: StateOperation[],
  turn: number,
  entities: Map<string, Entity>,
  threads: Thread[],
  chronicle: ChronicleEvent[],
  previousOperations: StateOperation[] = [],
): StateOperation[] {
  const validated = StateOperationSchema.array().parse(operations);
  const nearMisses = normalizeNearMissCreatedEntityReferences(validated, entities);
  const coalesced = coalesceDuplicateLocationCreates(nearMisses, entities);
  const physical = normalizeCreatedItemOwnership(coalesced, entities);
  const referenced = normalizeReferences(
    assignGeneratedIds(physical, turn, entities, threads, chronicle),
    entities,
    threads,
  );
  const prepared = normalizeNoOpMovements(normalizeAtomicItemTransfers(referenced), entities);
  assertNoRepeatedAbstractInventoryCredit(prepared, previousOperations);
  assertDeterministicConsistency(prepared, entities);
  return prepared;
}

function adjustInventory(owner: Entity, item: Entity, delta: number): void {
  const existing = owner.inventory.find((entry) => entry.entityId === item.id);
  const next = (existing?.quantity ?? 0) + delta;
  if (next < 0) throw new Error(`Inventory for ${item.id} cannot become negative`);
  if (existing && next === 0) owner.inventory = owner.inventory.filter((entry) => entry.entityId !== item.id);
  else if (existing) existing.quantity = next;
  else if (next > 0) owner.inventory.push({ entityId: item.id, quantity: next });
}

function applyOperations(
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
    if (entities.has(operation.entity.id)) throw new Error(`Entity ${operation.entity.id} already exists`);
    if (operation.entity.kind === "location") {
      const duplicate = [...entities.values()].find((entity) =>
        entity.kind === "location" && canonicalEntityName(entity.name) === canonicalEntityName(operation.entity.name));
      if (duplicate) throw new Error(`Location ${operation.entity.name} duplicates existing location ${duplicate.id}; reuse that exact ID`);
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
    entities.set(operation.entity.id, EntitySchema.parse({
      ...operation.entity,
      updatedTurn: turn,
      traits: [], conditions: [], inventory: [], facts, relationships: [],
    }));
  }

  const requireEntity = (id: string): Entity => {
    const entity = entities.get(id);
    if (!entity) throw new Error(`Unknown entity ${id}`);
    return entity;
  };
  const touch = (entity: Entity) => { entity.updatedTurn = turn; };

  for (const operation of operations) {
    switch (operation.type) {
      case "create_entity": break;
      case "add_fact": {
        const target = requireEntity(operation.targetId);
        if (target.facts.some((fact) => fact.id === operation.factId)) throw new Error(`Fact ${operation.factId} already exists`);
        target.facts.push({ id: operation.factId, section: operation.section, text: operation.text, active: true });
        touch(target); break;
      }
      case "supersede_fact": {
        const target = requireEntity(operation.targetId);
        const fact = target.facts.find((item) => item.id === operation.factId && item.active);
        if (!fact) throw new Error(`Active fact ${operation.factId} does not exist on ${operation.targetId}`);
        if (target.facts.some((item) => item.id === operation.replacementFactId)) throw new Error(`Fact ${operation.replacementFactId} already exists`);
        fact.active = false;
        target.facts.push({ id: operation.replacementFactId, section: fact.section, text: operation.replacementText, active: true });
        touch(target); break;
      }
      case "set_entity_state": {
        const target = requireEntity(operation.targetId);
        if (operation.name === undefined && operation.status === undefined && operation.tags === undefined) throw new Error("set_entity_state must change at least one field");
        if (operation.name !== undefined) target.name = operation.name;
        if (operation.status !== undefined) target.status = operation.status;
        if (operation.tags !== undefined) target.tags = operation.tags;
        touch(target); break;
      }
      case "move_entity": {
        const target = requireEntity(operation.targetId);
        const destination = requireEntity(operation.locationId);
        if (destination.kind !== "location") throw new Error(`${operation.locationId} is not a location`);
        target.location = destination.id;
        if (target.id === manifest.playerId) manifest.currentLocationId = destination.id;
        touch(target); break;
      }
      case "change_inventory": {
        const owner = requireEntity(operation.ownerId);
        const item = requireEntity(operation.itemId);
        if (item.kind !== "item") throw new Error(`${item.id} is not an item`);
        adjustInventory(owner, item, operation.quantityDelta);
        if (operation.quantityDelta > 0) { delete item.location; touch(item); }
        touch(owner); break;
      }
      case "transfer_item": {
        if (operation.fromId === operation.toId) throw new Error("transfer_item requires different owners");
        const from = requireEntity(operation.fromId);
        const to = requireEntity(operation.toId);
        const item = requireEntity(operation.itemId);
        if (item.kind !== "item") throw new Error(`${item.id} is not an item`);
        const source = from.inventory.find((entry) => entry.entityId === item.id);
        if (!source || source.quantity < operation.quantity) throw new Error(`${operation.fromId} does not own ${operation.quantity} of ${operation.itemId}`);
        adjustInventory(from, item, -operation.quantity);
        adjustInventory(to, item, operation.quantity);
        delete item.location;
        touch(from); touch(to); touch(item); break;
      }
      case "add_condition": { const target = requireEntity(operation.targetId); if (!target.conditions.includes(operation.condition)) target.conditions.push(operation.condition); touch(target); break; }
      case "remove_condition": { const target = requireEntity(operation.targetId); if (!target.conditions.includes(operation.condition)) throw new Error(`${operation.targetId} does not have condition ${operation.condition}`); target.conditions = target.conditions.filter((condition) => condition !== operation.condition); touch(target); break; }
      case "add_trait": { const target = requireEntity(operation.targetId); if (!target.traits.includes(operation.trait)) target.traits.push(operation.trait); touch(target); break; }
      case "set_relationship": { const source = requireEntity(operation.sourceId); requireEntity(operation.targetId); const existing = source.relationships.find((relation) => relation.targetId === operation.targetId); if (existing) existing.summary = operation.summary; else source.relationships.push({ targetId: operation.targetId, summary: operation.summary }); touch(source); break; }
      case "create_thread": { if (threads.some((thread) => thread.id === operation.threadId)) throw new Error(`Thread ${operation.threadId} already exists`); threads.push({ id: operation.threadId, title: operation.title, summary: operation.summary, status: "active", relatedEntityIds: operation.relatedEntityIds }); break; }
      case "update_thread": { const thread = threads.find((item) => item.id === operation.threadId); if (!thread) throw new Error(`Unknown thread ${operation.threadId}`); if (thread.status !== "active") throw new Error(`Thread ${operation.threadId} is not active`); thread.summary = operation.summary; if (operation.relatedEntityIds !== undefined) thread.relatedEntityIds = operation.relatedEntityIds; break; }
      case "resolve_thread": { const thread = threads.find((item) => item.id === operation.threadId); if (!thread) throw new Error(`Unknown thread ${operation.threadId}`); if (thread.status !== "active") throw new Error(`Thread ${operation.threadId} is not active`); thread.status = operation.status; thread.summary = operation.outcome; break; }
      case "record_major_event": { if (chronicle.some((event) => event.id === operation.eventId)) throw new Error(`Chronicle event ${operation.eventId} already exists`); chronicle.push({ id: operation.eventId, text: operation.text, turn }); break; }
      case "advance_time": manifest.elapsedMinutes += operation.minutes; manifest.timeLabel = operation.timeLabel; break;
      case "end_campaign": { if (manifest.status !== "active") throw new Error("A campaign can end only once"); manifest.status = operation.status; const player = requireEntity(manifest.playerId); player.status = operation.status; touch(player); chronicle.push({ id: `event:campaign-end-${turn}`, text: operation.reason, turn }); break; }
    }
  }

  for (const entity of entities.values()) {
    if (entity.location) {
      const location = requireEntity(entity.location);
      if (location.kind !== "location") throw new Error(`${entity.id} has a non-location location reference`);
    }
    for (const inventory of entity.inventory) requireEntity(inventory.entityId);
    EntitySchema.parse(entity);
  }
  assertCampaignStateConsistency(manifest, entities, threads, chronicle);
}

export class TransactionValidationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "TransactionValidationError";
  }
}

interface AppliedTransaction {
  operations: StateOperation[];
  manifest: GameState;
  entities: Map<string, Entity>;
  threads: Thread[];
  chronicle: ChronicleEvent[];
}

/** Normalize, validate, and apply a complete turn against isolated state clones. */
export function applyTransaction(
  operations: StateOperation[],
  turn: number,
  manifestInput: GameState,
  entitiesInput: Map<string, Entity>,
  threadsInput: Thread[],
  chronicleInput: ChronicleEvent[],
  previousOperations: StateOperation[] = [],
): AppliedTransaction {
  try {
    const prepared = prepareOperations(
      operations,
      turn,
      entitiesInput,
      threadsInput,
      chronicleInput,
      previousOperations,
    );
    const manifest = structuredClone(manifestInput);
    const entities = new Map(
      [...entitiesInput.entries()].map(([id, entity]) => [id, structuredClone(entity)]),
    );
    const threads = structuredClone(threadsInput);
    const chronicle = structuredClone(chronicleInput);
    manifest.turn = turn;
    applyOperations(prepared, turn, manifest, entities, threads, chronicle);
    return { operations: prepared, manifest, entities, threads, chronicle };
  } catch (error) {
    if (error instanceof TransactionValidationError) throw error;
    throw new TransactionValidationError(
      error instanceof Error ? error.message : String(error),
      { cause: error },
    );
  }
}
