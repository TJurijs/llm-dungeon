import { mapOperationReferences, visitOperationReferences } from "./operation-references.js";
import { newTagPolicyViolation } from "./tag-policy.js";
import { rejectDomainChange } from "./validation-error.js";
import type {
  DomainViolation,
  DomainViolationCode,
  DomainViolationCollector,
  DomainViolationDetail,
} from "./violations.js";
import {
  StateOperationSchema,
  type ChronicleEvent,
  type Entity,
  type SceneState,
  type StateOperation,
  type Thread,
  type ThreadAuditEntry,
} from "../schemas.js";
import { allocateGeneratedId, allocateTurnScopedId, canonicalEntityName } from "./ids.js";

function assignGeneratedIds(
  input: StateOperation[],
  turn: number,
  entities: Map<string, Entity>,
  threads: Thread[],
  chronicle: ChronicleEvent[],
): StateOperation[] {
  const namespaceForKind: Record<Entity["kind"], string> = {
    person: "npc",
    location: "location",
    item: "item",
    faction: "faction",
    creature: "creature",
    event: "event",
    other: "entity",
  };
  const usedEntities = new Set(entities.keys());
  const entityHints = new Map<string, string>();
  for (const operation of input) {
    if (operation.type !== "create_entity") continue;
    if (entityHints.has(operation.entity.id)) {
      rejectDomainChange(
        `Duplicate new entity reference hint ${operation.entity.id}`,
        "duplicate_create_hint",
      );
    }
    entityHints.set(
      operation.entity.id,
      allocateGeneratedId(
        namespaceForKind[operation.entity.kind],
        operation.entity.name,
        usedEntities,
      ),
    );
  }
  const entityReference = (id: string): string => entityHints.get(id) ?? id;
  const operations = input.map((operation): StateOperation => {
    const assigned =
      operation.type === "create_entity"
        ? ({
            ...operation,
            entity: {
              ...operation.entity,
              id: entityReference(operation.entity.id),
            },
          } satisfies StateOperation)
        : operation;
    return mapOperationReferences(assigned, (reference, role) =>
      role.kind === "entity" || role.kind === "location" || role.kind === "item"
        ? entityReference(reference)
        : reference,
    );
  });

  const usedFacts = new Set(
    [...entities.values()].flatMap((entity) => entity.facts.map((fact) => fact.id)),
  );
  const usedThreads = new Set(threads.map((thread) => thread.id));
  const usedEvents = new Set(chronicle.map((event) => event.id));
  const factHints = new Map<string, string>();
  const threadHints = new Map<string, string>();
  const generated = operations.map((operation): StateOperation => {
    if (operation.type === "add_fact") {
      const factId = allocateTurnScopedId("fact", operation.targetId, turn, usedFacts);
      if (operation.factId !== "generated:auto" && !factHints.has(operation.factId)) {
        factHints.set(operation.factId, factId);
      }
      return { ...operation, factId };
    }
    if (operation.type === "supersede_fact") {
      const replacementFactId = allocateTurnScopedId("fact", operation.targetId, turn, usedFacts);
      if (
        operation.replacementFactId !== "generated:auto" &&
        !factHints.has(operation.replacementFactId)
      ) {
        factHints.set(operation.replacementFactId, replacementFactId);
      }
      return { ...operation, replacementFactId };
    }
    if (operation.type === "create_thread") {
      const threadId = allocateTurnScopedId("thread", operation.title, turn, usedThreads);
      if (operation.threadId !== "generated:auto" && !threadHints.has(operation.threadId)) {
        threadHints.set(operation.threadId, threadId);
      }
      return { ...operation, threadId };
    }
    if (operation.type === "record_major_event") {
      return {
        ...operation,
        eventId: allocateTurnScopedId("event", operation.text, turn, usedEvents),
      };
    }
    return structuredClone(operation);
  });

  return StateOperationSchema.array().parse(
    generated.map((operation) =>
      mapOperationReferences(operation, (reference, role) => {
        if (role.kind === "active_fact") return factHints.get(reference) ?? reference;
        if (role.kind === "thread") return threadHints.get(reference) ?? reference;
        return reference;
      }),
    ),
  );
}

function remapEntityReferences(
  operation: StateOperation,
  references: Map<string, string>,
): StateOperation {
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
      : reference,
  );
}

function normalizedReferenceText(value: string): string {
  return referenceSuffix(value)
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
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
  const creations = operations.flatMap((operation) =>
    operation.type === "create_entity" ? [operation.entity] : [],
  );
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
        const candidates = [
          normalizedReferenceText(entity.id),
          normalizedReferenceText(entity.name),
        ];
        const similarity = Math.max(
          ...candidates.map((candidate) => {
            const longest = Math.max(normalized.length, candidate.length);
            return longest ? 1 - editDistance(normalized, candidate) / longest : 0;
          }),
        );
        return { id: entity.id, similarity };
      })
      .sort((left, right) => right.similarity - left.similarity || left.id.localeCompare(right.id));
    const best = scored[0];
    const runnerUp = scored[1];
    if (
      best &&
      best.similarity >= 0.8 &&
      (!runnerUp || best.similarity - runnerUp.similarity >= 0.1)
    ) {
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
  return StateOperationSchema.array().parse(
    operations.map((operation) => remapEntityReferences(operation, references)),
  );
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
  return StateOperationSchema.array().parse(
    retained.map((operation) => remapEntityReferences(operation, references)),
  );
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
  return StateOperationSchema.array().parse(
    operations.flatMap((operation): StateOperation[] => {
      if (
        operation.type !== "create_entity" ||
        operation.entity.kind !== "item" ||
        !operation.entity.location
      )
        return [operation];
      const owners = inventoryOwners.get(operation.entity.id);
      const suppliedReference = operation.entity.location;
      const suffixMatches = suppliedReference.includes(":")
        ? []
        : [...entityKinds.keys()].filter(
            (candidate) => referenceSuffix(candidate) === suppliedReference,
          );
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
        {
          type: "change_inventory",
          ownerId: suppliedOwnerId,
          itemId: operation.entity.id,
          quantityDelta: 1,
        },
      ];
    }),
  );
}

function referenceSuffix(id: string): string {
  const separator = id.indexOf(":");
  return separator === -1 ? id : id.slice(separator + 1);
}

/**
 * Resolve one reference against the authoritative candidates.
 *
 * With a collector, an unresolvable reference is recorded and returned
 * unchanged so the rest of the transaction can still be checked. Reference
 * faults are the most common domain-correction cause, and a response naming
 * three unknown IDs is only repairable if the correction names all three.
 */
interface ReferenceCodes {
  readonly unknown: DomainViolationCode;
  readonly ambiguous: DomainViolationCode;
}

const REFERENCE_CODES = {
  entity: { unknown: "unknown_entity_reference", ambiguous: "ambiguous_entity_reference" },
  location: { unknown: "unknown_location_reference", ambiguous: "ambiguous_location_reference" },
  item: { unknown: "unknown_item_reference", ambiguous: "ambiguous_item_reference" },
  thread: { unknown: "unknown_thread_reference", ambiguous: "ambiguous_thread_reference" },
  fact: { unknown: "unknown_fact_reference", ambiguous: "ambiguous_fact_reference" },
} as const satisfies Record<string, ReferenceCodes>;

const GENERATED_ID_SUFFIX = /-turn-\d+$/u;

/** Remove the turn marker the application appends to fact, thread, and event IDs. */
function stripGeneratedSuffix(id: string): string {
  return id.replace(GENERATED_ID_SUFFIX, "");
}

/**
 * Describe how a reference missed, without repeating what it said.
 *
 * The rejected response is deliberately never persisted, so a redacted cause
 * naming only the rule leaves no way to tell an application-generated-suffix
 * slip apart from a wholly invented ID. The returned token comes from a closed
 * vocabulary and carries no campaign content, so it is safe in telemetry.
 */
function classifyUnresolvedReference(
  reference: string,
  candidates: readonly string[],
): DomainViolationDetail {
  const stem = referenceSuffix(reference);
  const namespace = reference.includes(":")
    ? reference.slice(0, reference.indexOf(":"))
    : undefined;
  const parsed = candidates.map((candidate) => ({
    namespace: candidate.slice(0, candidate.indexOf(":")),
    stem: referenceSuffix(candidate),
  }));

  // Durable IDs are allocated with a "-turn-N" suffix, so a reference that is
  // exactly one candidate minus that suffix is a recoverable near miss rather
  // than an invention.
  const suffixVariants = parsed.filter(
    (entry) => entry.stem.replace(GENERATED_ID_SUFFIX, "") === stem && entry.stem !== stem,
  );
  if (suffixVariants.length === 1) return "generated_suffix_variant";

  if (
    stem.length >= 4 &&
    parsed.some((entry) => entry.stem.startsWith(stem) || stem.startsWith(entry.stem))
  ) {
    return "stem_shared";
  }

  if (namespace !== undefined && !parsed.some((entry) => entry.namespace === namespace)) {
    return "namespace_mismatch";
  }
  return "unrecognized";
}

function resolveReference(
  raw: string,
  candidates: Iterable<string>,
  type: string,
  codes: ReferenceCodes,
  collector?: DomainViolationCollector,
): string {
  const reference = raw.trim();
  const available = [...new Set(candidates)];
  if (available.includes(reference)) return reference;

  // Undo the application's own generated suffix rather than reject it.
  //
  // This is not similarity matching across the world: the candidate is an
  // exact string match once a suffix this code appended is removed, so the
  // resolution is the inverse of a transformation the application performed.
  // The uniqueness guard keeps it deterministic — two records that collapse to
  // the same stem stay unresolved and are reported as ambiguous below.
  const suffixVariants = available.filter(
    (candidate) => candidate !== reference && stripGeneratedSuffix(candidate) === reference,
  );
  if (suffixVariants.length === 1) return suffixVariants[0]!;

  const unresolvable = (code: DomainViolationCode, message: string): string => {
    const detail = classifyUnresolvedReference(reference, available);
    if (!collector) rejectDomainChange(message, code, detail);
    // The same missing ID can be reached through several reference roles. One
    // report per ID keeps the correction about the record, not the roles.
    if (!collector.isFailedSubject(reference)) {
      collector.add(code, message, { subjects: [reference, raw], detail });
    }
    return raw;
  };
  if (reference.includes(":")) {
    return unresolvable(codes.unknown, `Unknown ${type} reference ${reference}`);
  }
  const matches = available.filter((candidate) => referenceSuffix(candidate) === reference);
  if (matches.length === 1) return matches[0]!;
  if (!matches.length) {
    // An unqualified reference gets the same suffix inverse as a namespaced one.
    const bareStemVariants = available.filter(
      (candidate) => stripGeneratedSuffix(referenceSuffix(candidate)) === reference,
    );
    if (bareStemVariants.length === 1) return bareStemVariants[0]!;
    return unresolvable(codes.unknown, `Unknown ${type} reference ${reference}`);
  }
  return unresolvable(
    codes.ambiguous,
    `Ambiguous ${type} reference ${reference}: ${matches.sort().join(", ")}`,
  );
}

function unreachableReferenceRole(role: never): never {
  throw new Error(`Unsupported operation reference role: ${JSON.stringify(role)}`);
}

function normalizeReferences(
  operations: StateOperation[],
  entities: Map<string, Entity>,
  threads: Thread[],
  collector?: DomainViolationCollector,
): StateOperation[] {
  const entityKinds = new Map([...entities.values()].map((entity) => [entity.id, entity.kind]));
  for (const operation of operations) {
    if (operation.type === "create_entity")
      entityKinds.set(operation.entity.id, operation.entity.kind);
  }
  const entityIds = [...entityKinds.keys()];
  const locationIds = entityIds.filter((id) => entityKinds.get(id) === "location");
  const itemIds = entityIds.filter((id) => entityKinds.get(id) === "item");
  const threadIds = [
    ...threads.map((thread) => thread.id),
    ...operations
      .filter((operation) => operation.type === "create_thread")
      .map((operation) => operation.threadId),
  ];
  const entity = (value: string) =>
    resolveReference(value, entityIds, "entity", REFERENCE_CODES.entity, collector);
  const location = (value: string) =>
    resolveReference(value, locationIds, "location", REFERENCE_CODES.location, collector);
  const item = (value: string) =>
    resolveReference(value, itemIds, "item", REFERENCE_CODES.item, collector);
  const thread = (value: string) =>
    resolveReference(value, threadIds, "thread", REFERENCE_CODES.thread, collector);
  const normalized = operations.map((operation) =>
    mapOperationReferences(operation, (reference, role) => {
      switch (role.kind) {
        case "entity":
          return entity(reference);
        case "location":
          return location(reference);
        case "item":
          return item(reference);
        case "thread":
          return thread(reference);
        case "active_fact":
          return reference;
        default:
          return unreachableReferenceRole(role);
      }
    }),
  );
  return StateOperationSchema.array().parse(
    normalized.map((operation) =>
      mapOperationReferences(operation, (reference, role) => {
        if (role.kind !== "active_fact") return reference;
        const facts = [
          ...(entities
            .get(role.targetId)
            ?.facts.filter((fact) => fact.active)
            .map((fact) => fact.id) ?? []),
          ...normalized.flatMap((candidate) =>
            candidate.type === "add_fact" && candidate.targetId === role.targetId
              ? [candidate.factId]
              : [],
          ),
        ];
        return resolveReference(
          reference,
          facts,
          `active fact on ${role.targetId}`,
          REFERENCE_CODES.fact,
          collector,
        );
      }),
    ),
  );
}

/** Convert an exact debit/credit pair into the atomic transfer it expresses. */
function normalizeAtomicItemTransfers(operations: StateOperation[]): StateOperation[] {
  const replacements = new Map<number, StateOperation>();
  const removed = new Set<number>();
  const itemChanges = new Map<
    string,
    Array<{ index: number; operation: Extract<StateOperation, { type: "change_inventory" }> }>
  >();
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
    if (!debit || !credit || -debit.operation.quantityDelta !== credit.operation.quantityDelta)
      continue;
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
  return StateOperationSchema.array().parse(
    operations.flatMap((operation, index) => {
      if (removed.has(index)) return [];
      return [replacements.get(index) ?? operation];
    }),
  );
}

/**
 * A model may express a drop as an inventory debit followed by moving the item
 * entity to a location. The debit and destination make that intent exact:
 * normalize the pair into the conserved owner-to-location transfer required by
 * the domain. Any less exact item movement remains invalid.
 */
function normalizeDroppedItemTransfers(operations: StateOperation[]): StateOperation[] {
  const replacements = new Map<number, StateOperation>();
  const removed = new Set<number>();
  const itemChanges = new Map<
    string,
    Array<{
      index: number;
      operation: Extract<StateOperation, { type: "change_inventory" }>;
    }>
  >();
  const itemMoves = new Map<
    string,
    Array<{
      index: number;
      operation: Extract<StateOperation, { type: "move_entity" }>;
    }>
  >();
  const transferredItems = new Set<string>();

  operations.forEach((operation, index) => {
    if (operation.type === "change_inventory") {
      const changes = itemChanges.get(operation.itemId) ?? [];
      changes.push({ index, operation });
      itemChanges.set(operation.itemId, changes);
    } else if (operation.type === "move_entity") {
      const moves = itemMoves.get(operation.targetId) ?? [];
      moves.push({ index, operation });
      itemMoves.set(operation.targetId, moves);
    } else if (operation.type === "transfer_item") {
      transferredItems.add(operation.itemId);
    }
  });

  for (const [itemId, moves] of itemMoves) {
    const changes = itemChanges.get(itemId) ?? [];
    if (moves.length !== 1 || changes.length !== 1 || transferredItems.has(itemId)) continue;
    const move = moves[0]!;
    const debit = changes[0]!;
    if (debit.operation.quantityDelta >= 0 || debit.operation.ownerId === move.operation.locationId)
      continue;
    const first = Math.min(move.index, debit.index);
    const second = Math.max(move.index, debit.index);
    replacements.set(first, {
      type: "transfer_item",
      fromId: debit.operation.ownerId,
      toId: move.operation.locationId,
      itemId,
      quantity: -debit.operation.quantityDelta,
    });
    removed.add(second);
  }

  return StateOperationSchema.array().parse(
    operations.flatMap((operation, index) => {
      if (removed.has(index)) return [];
      return [replacements.get(index) ?? operation];
    }),
  );
}

/** A move to the entity's already-authoritative location is an idempotent no-op. */
function normalizeNoOpMovements(
  operations: StateOperation[],
  entities: Map<string, Entity>,
): StateOperation[] {
  const locations = new Map(
    [...entities.values()].flatMap((entity) =>
      entity.location ? [[entity.id, entity.location] as const] : [],
    ),
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

export const REPEATED_ABSTRACT_CREDIT_CODE = "repeated_abstract_inventory_credit";

/**
 * An abstract credit that exactly repeats one already in the current ledger
 * window re-applies the same receipt rather than recording a new one.
 */
export function collectRepeatedAbstractInventoryCredits(
  operations: readonly StateOperation[],
  previousOperations: readonly StateOperation[],
): DomainViolation[] {
  const previousCredits = new Set(
    previousOperations.flatMap((operation) =>
      operation.type === "change_inventory" && operation.quantityDelta > 0
        ? [`${operation.ownerId}\u0000${operation.itemId}\u0000${operation.quantityDelta}`]
        : [],
    ),
  );
  const violations: DomainViolation[] = [];
  for (const operation of operations) {
    if (operation.type !== "change_inventory" || operation.quantityDelta <= 0) continue;
    const fingerprint = `${operation.ownerId}\u0000${operation.itemId}\u0000${operation.quantityDelta}`;
    if (previousCredits.has(fingerprint)) {
      violations.push({
        code: REPEATED_ABSTRACT_CREDIT_CODE,
        message:
          `Repeated abstract inventory credit: ${operation.ownerId} already received +${operation.quantityDelta} ${operation.itemId} in the latest gameplay/appeal operation-ledger window. ` +
          "If this turn only handles, pockets, counts, or stows that existing inventory, remove the operation. A genuinely new receipt must be represented by a distinct current-turn source, preferably transfer_item from its owner.",
      });
    }
  }
  return violations;
}

/**
 * Deterministic rewrites only. Admission checks live in the admit stage so one
 * bounded correction can address a complete violation set.
 */
/**
 * Turn the declared end-of-turn scene into movement.
 *
 * Narration routinely relocates actors while the effect list does not, and no
 * check can read narration. A declared scene is part of the same structured
 * transaction, so converting it into movement is deterministic normalization
 * of the kind already applied to a created item's supplied owner. Presence is
 * authoritative inbound only: an omitted actor states no destination, so their
 * placement is left alone.
 */
function synthesizeDeclaredScene(
  operations: StateOperation[],
  playerId: string,
  scene: SceneState,
  collector?: DomainViolationCollector,
): StateOperation[] {
  const declaredMovers = [playerId, ...scene.presentActorIds].filter(
    (id, index, all) => all.indexOf(id) === index,
  );
  const explicitDestinations = new Map(
    operations.flatMap((operation) =>
      operation.type === "move_entity" ? [[operation.targetId, operation.locationId] as const] : [],
    ),
  );
  const synthesized: StateOperation[] = [];
  for (const targetId of declaredMovers) {
    const explicit = explicitDestinations.get(targetId);
    if (explicit !== undefined) {
      if (explicit !== scene.locationId) {
        const message = `${targetId} is moved to ${explicit} but the declared end-of-turn scene places them at ${scene.locationId}`;
        if (!collector) rejectDomainChange(message, "scene_movement_conflict");
        collector.add("scene_movement_conflict", message, { subjects: [targetId] });
      }
      continue;
    }
    synthesized.push({ type: "move_entity", targetId, locationId: scene.locationId });
  }
  return synthesized;
}

/**
 * The active threads an audit ordinal refers to, in the order context lists
 * them. Both sides read the same array, so the numbering cannot drift.
 */
export function auditableThreads(threads: readonly Thread[]): Thread[] {
  return threads.filter((thread) => thread.status === "active");
}

/**
 * Turn declared verdicts into thread operations.
 *
 * Lifecycle is derived, never supplied, so a declaration and its operations
 * cannot disagree. Resolution is by ordinal: the model never reproduces a
 * generated ID, which removes the transcription errors that mandatory
 * per-thread auditing would otherwise multiply.
 */
export function threadAuditOperations(
  audit: readonly ThreadAuditEntry[],
  threads: readonly Thread[],
  collector?: DomainViolationCollector,
): StateOperation[] {
  const active = auditableThreads(threads);
  const operations: StateOperation[] = [];
  for (const entry of audit) {
    const thread = active[entry.threadIndex - 1];
    if (thread === undefined) {
      const message = `Audited thread number ${entry.threadIndex} is outside the ${active.length} active thread(s) supplied in context`;
      if (!collector) rejectDomainChange(message, "thread_audit_index_out_of_range");
      collector.add("thread_audit_index_out_of_range", message);
      continue;
    }
    if (entry.verdict === "unchanged") continue;
    operations.push(
      entry.verdict === "progressed"
        ? StateOperationSchema.parse({
            type: "update_thread",
            threadId: thread.id,
            summary: entry.text,
            ...(entry.relatedEntityIds === undefined
              ? {}
              : { relatedEntityIds: entry.relatedEntityIds }),
          })
        : StateOperationSchema.parse({
            type: "resolve_thread",
            threadId: thread.id,
            outcome: entry.text,
            status: entry.verdict,
          }),
    );
  }
  return operations;
}

/**
 * Drop tags that policy forbids, before admission ever sees them.
 *
 * A tag is enduring machine taxonomy: optional metadata, never state authority.
 * Removing a forbidden one produces exactly the intended record, so rejecting
 * the whole turn over it spent the single bounded correction on the one part of
 * the response that carried no meaning.
 *
 * Deliberately conservative in one respect: when pruning would empty a
 * `set_entity_state` tag list that arrived non-empty, the field is removed
 * instead of being sent as `[]`. Clearing every established tag is a real change
 * the model did not ask for, and normalization must never invent one.
 */
function pruneForbiddenNewTags(operations: StateOperation[]): StateOperation[] {
  const allowed = (tags: readonly string[]): string[] =>
    tags.filter((tag) => newTagPolicyViolation(tag) === undefined);
  return operations.flatMap((operation): StateOperation[] => {
    if (operation.type === "create_entity") {
      const tags = allowed(operation.entity.tags);
      if (tags.length === operation.entity.tags.length) return [operation];
      return [{ ...operation, entity: { ...operation.entity, tags } }];
    }
    if (operation.type !== "set_entity_state" || operation.tags === undefined) return [operation];
    const tags = allowed(operation.tags);
    if (tags.length === operation.tags.length) return [operation];
    if (tags.length === 0) {
      const { tags: _removed, ...withoutTags } = operation;
      // Nothing left to ask for once the only field is gone.
      if (withoutTags.name === undefined && withoutTags.status === undefined) return [];
      return [withoutTags];
    }
    return [{ ...operation, tags }];
  });
}

export function prepareOperations(
  operations: StateOperation[],
  turn: number,
  entities: Map<string, Entity>,
  threads: Thread[],
  chronicle: ChronicleEvent[],
  collector?: DomainViolationCollector,
  declarations: {
    readonly playerId?: string;
    readonly sceneState?: SceneState;
    readonly threadAudit?: readonly ThreadAuditEntry[];
  } = {},
): StateOperation[] {
  const supplied = [
    ...StateOperationSchema.array().parse(operations),
    ...(declarations.threadAudit === undefined
      ? []
      : threadAuditOperations(declarations.threadAudit, threads, collector)),
  ];
  const validated =
    declarations.sceneState && declarations.playerId
      ? [
          ...supplied,
          ...synthesizeDeclaredScene(
            supplied,
            declarations.playerId,
            declarations.sceneState,
            collector,
          ),
        ]
      : supplied;
  const nearMisses = normalizeNearMissCreatedEntityReferences(validated, entities);
  const coalesced = coalesceDuplicateLocationCreates(nearMisses, entities);
  const physical = normalizeCreatedItemOwnership(coalesced, entities);
  const referenced = normalizeReferences(
    assignGeneratedIds(physical, turn, entities, threads, chronicle),
    entities,
    threads,
    collector,
  );
  const dropped = normalizeDroppedItemTransfers(referenced);
  const tagged = pruneForbiddenNewTags(dropped);
  return normalizeNoOpMovements(normalizeAtomicItemTransfers(tagged), entities);
}
