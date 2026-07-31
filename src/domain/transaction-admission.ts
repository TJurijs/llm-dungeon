import type { Entity, SceneState, StateOperation, Thread, ThreadAuditEntry } from "../schemas.js";
import { collectOperationDurableTextViolations } from "./durable-state-policy.js";
import { assertDeterministicConsistency } from "./operation-consistency.js";
import { visitOperationReferences } from "./operation-references.js";
import { newTagPolicyViolation } from "./tag-policy.js";
import { collectRepeatedAbstractInventoryCredits } from "./transaction-normalization.js";
import type { DomainViolationCollector } from "./violations.js";

/**
 * Reconciliation the model declared for this turn.
 *
 * These are not state operations: they are the closed-form claims the
 * application reconciles against authoritative state. Absent for appeals and
 * for replayed ledgers committed before the V2 contract.
 */
export interface TransactionDeclarations {
  readonly threadAudit?: readonly ThreadAuditEntry[];
  readonly sceneState?: SceneState;
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
 * The one thread-audit claim worth rejecting here.
 *
 * Ordinal addressing removed the misnamed-thread class entirely, and an
 * out-of-range number is caught during derivation. An omitted thread already
 * behaves as "unchanged" and is counted rather than failed. What remains is a
 * claim the turn itself contradicts: declaring a thread unchanged with no
 * reason while this same turn changed a record that thread links.
 */
function collectThreadAuditViolations(
  audit: readonly ThreadAuditEntry[],
  operations: readonly StateOperation[],
  threads: readonly Thread[],
  collector: DomainViolationCollector,
): void {
  const active = threads.filter((thread) => thread.status === "active");
  if (active.length === 0) return;
  const changedSubjects = new Set(
    operations.flatMap((operation) => {
      const subjects: string[] = [];
      visitOperationReferences(operation, (reference, role) => {
        if (role.kind !== "active_fact") subjects.push(reference);
      });
      if (operation.type === "create_entity") subjects.push(operation.entity.id);
      return subjects;
    }),
  );
  for (const entry of audit) {
    if (entry.verdict !== "unchanged" || entry.text.trim() !== "") continue;
    const thread = active[entry.threadIndex - 1];
    const touched = thread?.relatedEntityIds.filter((id) => changedSubjects.has(id)) ?? [];
    if (touched.length === 0) continue;
    collector.add(
      "thread_audit_unjustified_unchanged",
      `Thread number ${entry.threadIndex} is declared unchanged although this turn changed ${touched.sort().join(", ")}; state the reason in that audit entry`,
    );
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
  // A present audit means the turn was produced under the V2 contract, which
  // always supplies one. Appeals and pre-V2 replayed ledgers declare nothing
  // and are reconciled by their own rules.
  if (declarations.threadAudit !== undefined && declarations.threads) {
    collectThreadAuditViolations(
      declarations.threadAudit,
      operations,
      declarations.threads,
      collector,
    );
    collectThreadSuccessorViolations(operations, declarations.threads, collector);
    if (declarations.sceneState === undefined) {
      collector.add(
        "scene_state_required",
        "A resolved turn must declare the end-of-turn location containing the player character",
      );
    }
  }
  assertDeterministicConsistency([...operations], entities, collector);
}
