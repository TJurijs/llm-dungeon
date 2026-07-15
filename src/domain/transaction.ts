import type {
  ChronicleEvent,
  Entity,
  GameState,
  StateOperation,
  Thread,
} from "../schemas.js";
import { applyOperations } from "./transaction-application.js";
import { prepareOperations } from "./transaction-normalization.js";
import { DomainValidationError } from "./validation-error.js";

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
    if (error instanceof DomainValidationError) {
      throw new TransactionValidationError(error.message, { cause: error });
    }
    throw error;
  }
}
