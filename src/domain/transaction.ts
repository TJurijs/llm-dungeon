import type { ChronicleEvent, Entity, GameState, StateOperation, Thread } from "../schemas.js";
import { applyOperations } from "./transaction-application.js";
import { prepareOperations } from "./transaction-normalization.js";
import { admitOperations, type TransactionDeclarations } from "./transaction-admission.js";
import { inventoryCycleEdges, inventoryOwnershipSnapshot } from "./state-consistency.js";
import { DomainValidationError } from "./validation-error.js";
import { DomainViolationCollector, type DomainViolation } from "./violations.js";

export class TransactionValidationError extends Error {
  /**
   * The rules this transaction violated. Repair telemetry redacts from these
   * declarations rather than re-parsing the rendered message.
   */
  readonly violations: readonly DomainViolation[];

  constructor(
    message: string,
    options?: ErrorOptions & { readonly violations?: readonly DomainViolation[] },
  ) {
    super(message, options);
    this.name = "TransactionValidationError";
    this.violations = options?.violations ?? [];
  }
}

interface AppliedTransaction {
  operations: StateOperation[];
  manifest: GameState;
  entities: Map<string, Entity>;
  threads: Thread[];
  chronicle: ChronicleEvent[];
  /**
   * Rules the transaction tripped that are declared review-only. The turn
   * committed regardless; these exist so a judgment-quality observation can be
   * measured over a run instead of being enforced against a single turn.
   */
  signals: readonly DomainViolation[];
}

/**
 * Normalize, validate, and apply a complete turn against isolated state clones.
 *
 * The turn moves through named stages with distinct ownership:
 *
 * 1. `normalize` — deterministic rewrites over the structured transaction. It
 *    never rejects; an ambiguous input is left for admission to explain.
 * 2. `admit` — every invariant checkable from the operation list plus the
 *    pre-transaction state, collected rather than thrown one at a time.
 * 3. `apply` — mutation of clones. Operations whose complete effect already
 *    holds are dropped from the committed ledger instead of failing the turn.
 * 4. `verify` — whole-campaign referential and physical invariants.
 *
 * Stages 2 through 4 share one collector so a single bounded correction can
 * address the complete violation set.
 */
export function applyTransaction(
  operations: StateOperation[],
  turn: number,
  manifestInput: GameState,
  entitiesInput: Map<string, Entity>,
  threadsInput: Thread[],
  chronicleInput: ChronicleEvent[],
  previousOperations: StateOperation[] = [],
  declarations: TransactionDeclarations = {},
): AppliedTransaction {
  try {
    const collector = new DomainViolationCollector();
    // Reference resolution belongs to normalization but can fail. It records
    // unresolvable IDs and leaves them in place so admission still sees the
    // whole transaction instead of stopping at the first bad reference.
    const prepared = prepareOperations(
      operations,
      turn,
      entitiesInput,
      threadsInput,
      chronicleInput,
      collector,
      declarations,
    );
    admitOperations(prepared, entitiesInput, previousOperations, collector, {
      ...declarations,
      threads: declarations.threads ?? threadsInput,
    });

    const manifest = structuredClone(manifestInput);
    const entities = new Map(
      [...entitiesInput.entries()].map(([id, entity]) => [id, structuredClone(entity)]),
    );
    const threads = structuredClone(threadsInput);
    const chronicle = structuredClone(chronicleInput);
    manifest.turn = turn;
    // Applying against clones even after an admission fault costs nothing and
    // surfaces the rest of the transaction's problems in the same correction.
    const { applied } = applyOperations(
      prepared,
      turn,
      manifest,
      entities,
      threads,
      chronicle,
      {
        allowedInventoryCycleEdges: inventoryCycleEdges(entitiesInput),
        baselineInventoryOwnership: inventoryOwnershipSnapshot(entitiesInput),
      },
      collector,
    );
    collector.assertNone();
    return {
      operations: applied,
      manifest,
      entities,
      threads,
      chronicle,
      signals: collector.signals(),
    };
  } catch (error) {
    if (error instanceof TransactionValidationError) throw error;
    if (error instanceof DomainValidationError) {
      throw new TransactionValidationError(error.message, {
        cause: error,
        violations: error.violations,
      });
    }
    throw error;
  }
}
