import type { StructuredResult } from "../types.js";

export interface StructuredFailureDetails {
  rawText: string;
  parsedResponse: unknown;
  usage?: StructuredResult<unknown>["usage"];
  structuredMode?: StructuredResult<unknown>["structuredMode"];
}

const failures = new WeakMap<object, StructuredFailureDetails>();

export function attachStructuredFailure(error: unknown, details: StructuredFailureDetails): void {
  if ((typeof error === "object" && error !== null) || typeof error === "function") {
    failures.set(error as object, details);
  }
}

export function structuredFailureDetails(error: unknown): StructuredFailureDetails | undefined {
  return ((typeof error === "object" && error !== null) || typeof error === "function")
    ? failures.get(error as object)
    : undefined;
}
