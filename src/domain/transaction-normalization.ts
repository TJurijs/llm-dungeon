import { assertDeterministicConsistency } from "./operation-consistency.js";
import {
  mapOperationReferences,
  visitOperationReferences,
} from "./operation-references.js";
import { rejectDomainChange } from "./validation-error.js";
import {
  StateOperationSchema,
  type ChronicleEvent,
  type Entity,
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
    if (entityHints.has(operation.entity.id)) {
      rejectDomainChange(`Duplicate new entity reference hint ${operation.entity.id}`);
    }
    entityHints.set(
      operation.entity.id,
      allocateGeneratedId(namespaceForKind[operation.entity.kind], operation.entity.name, turn, usedEntities),
    );
  }
  const entityReference = (id: string): string => entityHints.get(id) ?? id;
  const operations = input.map((operation): StateOperation => {
    const assigned = operation.type === "create_entity"
      ? {
        ...operation,
        entity: {
          ...operation.entity,
          id: entityReference(operation.entity.id),
        },
      } satisfies StateOperation
      : operation;
    return mapOperationReferences(assigned, (reference, role) =>
      role.kind === "entity" || role.kind === "location" || role.kind === "item"
        ? entityReference(reference)
        : reference);
  });

  const usedFacts = new Set([...entities.values()].flatMap((entity) => entity.facts.map((fact) => fact.id)));
  const usedThreads = new Set(threads.map((thread) => thread.id));
  const usedEvents = new Set(chronicle.map((event) => event.id));
  const factHints = new Map<string, string>();
  const threadHints = new Map<string, string>();
  const generated = operations.map((operation): StateOperation => {
    if (operation.type === "add_fact") {
      const factId = allocateGeneratedId("fact", operation.targetId, turn, usedFacts);
      if (operation.factId !== "generated:auto" && !factHints.has(operation.factId)) {
        factHints.set(operation.factId, factId);
      }
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
      if (operation.threadId !== "generated:auto" && !threadHints.has(operation.threadId)) {
        threadHints.set(operation.threadId, threadId);
      }
      return { ...operation, threadId };
    }
    if (operation.type === "record_major_event") {
      return { ...operation, eventId: allocateGeneratedId("event", operation.text, turn, usedEvents) };
    }
    return structuredClone(operation);
  });

  return StateOperationSchema.array().parse(generated.map((operation) =>
    mapOperationReferences(operation, (reference, role) => {
      if (role.kind === "active_fact") return factHints.get(reference) ?? reference;
      if (role.kind === "thread") return threadHints.get(reference) ?? reference;
      return reference;
    })));
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
  return mapOperationReferences(operation, (reference, role) =>
    role.kind === "entity" || role.kind === "location" || role.kind === "item"
      ? entity(reference)
      : reference);
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
    visitOperationReferences(operation, (reference, role) => {
      if (role.kind === "entity") consider(reference);
      if (role.kind === "location") consider(reference, "location");
      if (role.kind === "item") consider(reference, "item");
    });
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
    const suppliedReference = operation.entity.location;
    const suffixMatches = suppliedReference.includes(":")
      ? []
      : [...entityKinds.keys()].filter((candidate) => referenceSuffix(candidate) === suppliedReference);
    const suppliedOwnerId = entityKinds.has(suppliedReference)
      ? suppliedReference
      : suffixMatches.length === 1
        ? suffixMatches[0]!
        : undefined;
    if (suppliedOwnerId === undefined) return [operation];
    const { location: _location, ...entity } = operation.entity;
    if (owners?.size) return [{ ...operation, entity }];
    return [
      { ...operation, entity },
      { type: "change_inventory", ownerId: suppliedOwnerId, itemId: operation.entity.id, quantityDelta: 1 },
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
  if (reference.includes(":")) rejectDomainChange(`Unknown ${type} reference ${reference}`);
  const matches = available.filter((candidate) => referenceSuffix(candidate) === reference);
  if (matches.length === 1) return matches[0]!;
  if (!matches.length) rejectDomainChange(`Unknown ${type} reference ${reference}`);
  return rejectDomainChange(`Ambiguous ${type} reference ${reference}: ${matches.sort().join(", ")}`);
}

function unreachableReferenceRole(role: never): never {
  throw new Error(`Unsupported operation reference role: ${JSON.stringify(role)}`);
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
  const normalized = operations.map((operation) => mapOperationReferences(
    operation,
    (reference, role) => {
      switch (role.kind) {
        case "entity": return entity(reference);
        case "location": return location(reference);
        case "item": return item(reference);
        case "thread": return thread(reference);
        case "active_fact": return reference;
        default: return unreachableReferenceRole(role);
      }
    },
  ));
  return StateOperationSchema.array().parse(normalized.map((operation) =>
    mapOperationReferences(operation, (reference, role) => {
      if (role.kind !== "active_fact") return reference;
      const facts = [
        ...(entities.get(role.targetId)?.facts.filter((fact) => fact.active).map((fact) => fact.id) ?? []),
        ...normalized.flatMap((candidate) =>
          candidate.type === "add_fact" && candidate.targetId === role.targetId ? [candidate.factId] : []),
      ];
      return resolveReference(reference, facts, `active fact on ${role.targetId}`);
    })));
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
      rejectDomainChange(
        `Repeated abstract inventory credit: ${operation.ownerId} already received +${operation.quantityDelta} ${operation.itemId} in the latest gameplay/appeal operation-ledger window. `
        + "If this turn only handles, pockets, counts, or stows that existing inventory, remove the operation. A genuinely new receipt must be represented by a distinct current-turn source, preferably transfer_item from its owner.",
      );
    }
  }
}

export function prepareOperations(
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
