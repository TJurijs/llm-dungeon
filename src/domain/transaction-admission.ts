import type { Entity, StateOperation, Thread } from "../schemas.js";
import { collectOperationDurableTextViolations } from "./durable-state-policy.js";
import { assertDeterministicConsistency } from "./operation-consistency.js";
import { newTagPolicyViolation } from "./tag-policy.js";
import { collectRepeatedAbstractInventoryCredits } from "./transaction-normalization.js";
import type { DomainViolationCollector } from "./violations.js";

/**
 * Campaign context an admission check needs beyond the operation list.
 *
 * `threads` present means this is a live gameplay turn rather than an appeal or
 * a replayed ledger, which is what gates the thread-lifecycle review signal.
 */
export interface TransactionDeclarations {
  readonly threads?: readonly Thread[];
  readonly playerId?: string;
}

export const RESERVED_TAG_CODE = "reserved_mutable_state_tag";
export const NON_MACHINE_TAG_CODE = "non_machine_tag";

function collectNewTagViolations(
  collector: DomainViolationCollector,
  subject: string,
  tag: string,
): void {
  const violation = newTagPolicyViolation(tag);
  if (violation === "mutable_state") {
    collector.add(
      RESERVED_TAG_CODE,
      `${subject} uses reserved mutable-state tag "${tag.trim().toLowerCase()}"; represent current state with status, conditions, location, inventory, or facts instead`,
    );
  }
  if (violation === "non_machine") {
    collector.add(
      NON_MACHINE_TAG_CODE,
      `${subject} uses non-machine tag "${tag}"; tags must be lowercase ASCII taxonomy tokens in kebab-case`,
    );
  }
}

/**
 * Admission-only policy for newly generated operations. Pending commits replay
 * through applyOperations directly so an older, already accepted ledger
 * remains crash-recoverable after an upgrade.
 */
function collectNewOperationTagViolations(
  operations: readonly StateOperation[],
  entities: ReadonlyMap<string, Entity>,
  collector: DomainViolationCollector,
): void {
  const baselineTags = new Map(
    [...entities].map(([id, entity]) => [id, new Set(entity.tags)] as const),
  );
  for (const operation of operations) {
    if (operation.type === "create_entity") {
      for (const tag of operation.entity.tags) {
        collectNewTagViolations(collector, `Created entity ${operation.entity.id}`, tag);
      }
      baselineTags.set(operation.entity.id, new Set(operation.entity.tags));
      continue;
    }
    if (operation.type !== "set_entity_state" || operation.tags === undefined) continue;
    const existing = baselineTags.get(operation.targetId) ?? new Set<string>();
    for (const tag of operation.tags) {
      if (!existing.has(tag))
        collectNewTagViolations(collector, `Entity ${operation.targetId}`, tag);
    }
  }
}

/**
 * An active campaign with no active thread is nearly always a closure bug: a
 * thread was resolved and the situation it left open was never represented.
 */
function collectThreadSuccessorViolations(
  operations: readonly StateOperation[],
  threads: readonly Thread[],
  collector: DomainViolationCollector,
): void {
  const closed = new Set(
    operations.flatMap((operation) =>
      operation.type === "resolve_thread" ? [operation.threadId] : [],
    ),
  );
  if (closed.size === 0) return;
  const created = operations.filter((operation) => operation.type === "create_thread").length;
  const remaining =
    threads.filter((thread) => thread.status === "active" && !closed.has(thread.id)).length +
    created;
  const ending = operations.some((operation) => operation.type === "end_campaign");
  if (remaining === 0 && !ending) {
    collector.add(
      "thread_successor_required",
      "This turn closed the last active thread without creating a successor; represent the danger, obligation, or question the ending leaves open",
    );
  }
}

/**
 * The admit stage: every invariant checkable from the normalized operation list
 * and the pre-transaction state, evaluated together.
 *
 * Collecting the complete set matters for recovery. A turn gets one bounded
 * domain correction, so reporting only the first fault means a response with
 * several problems can never be repaired, and every additional check would
 * make that worse rather than better.
 */
export function admitOperations(
  operations: readonly StateOperation[],
  entities: Map<string, Entity>,
  previousOperations: readonly StateOperation[],
  collector: DomainViolationCollector,
  declarations: TransactionDeclarations = {},
): void {
  for (const violation of collectOperationDurableTextViolations(operations)) {
    collector.add(violation.code, violation.message);
  }
  collectNewOperationTagViolations(operations, entities, collector);
  for (const violation of collectRepeatedAbstractInventoryCredits(operations, previousOperations)) {
    collector.add(violation.code, violation.message);
  }
  for (const operation of operations) {
    if (operation.type !== "add_fact") continue;
    if (operation.basis !== "reported" && operation.basis !== "inferred") continue;
    if (operation.sourceId !== undefined) continue;
    collector.add(
      "fact_source_required",
      `A ${operation.basis} fact on ${operation.targetId} must name the source record it came from`,
    );
  }
  // Gameplay turns only. Appeals and replayed ledgers pass no thread list and
  // are reconciled by their own rules.
  if (declarations.threads) {
    collectThreadSuccessorViolations(operations, declarations.threads, collector);
  }
  assertDeterministicConsistency([...operations], entities, collector);
}
