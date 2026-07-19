import type { ProviderAttemptMetadata, StructuredResult } from "../types.js";

export interface StructuredFailureDetails {
  rawText: string;
  parsedResponse: unknown;
  usage?: StructuredResult<unknown>["usage"];
  structuredMode?: StructuredResult<unknown>["structuredMode"];
  attemptMetadata?: ProviderAttemptMetadata;
}

const failures = new WeakMap<object, StructuredFailureDetails>();
const attemptMetadataByError = new WeakMap<object, ProviderAttemptMetadata>();

export function attachStructuredFailure(error: unknown, details: StructuredFailureDetails): void {
  if ((typeof error === "object" && error !== null) || typeof error === "function") {
    failures.set(error as object, details);
    if (details.attemptMetadata) attemptMetadataByError.set(error as object, details.attemptMetadata);
  }
}

export function structuredFailureDetails(error: unknown): StructuredFailureDetails | undefined {
  return ((typeof error === "object" && error !== null) || typeof error === "function")
    ? failures.get(error as object)
    : undefined;
}

export function attachAttemptMetadata(error: unknown, metadata: ProviderAttemptMetadata): void {
  if ((typeof error === "object" && error !== null) || typeof error === "function") {
    const target = error as object;
    if (!attemptMetadataByError.has(target)) attemptMetadataByError.set(target, metadata);
  }
}

export function attemptMetadataFor(error: unknown): ProviderAttemptMetadata | undefined {
  return ((typeof error === "object" && error !== null) || typeof error === "function")
    ? attemptMetadataByError.get(error as object)
    : undefined;
}
