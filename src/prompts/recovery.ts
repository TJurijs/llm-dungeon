import { conciseFailure } from "../llm/failures.js";

function serialized(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

export function setupDomainCorrectionPrompt(originalPrompt: string, badSetup: unknown, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return `${originalPrompt}\n\nSETUP DOMAIN CORRECTION\nThe previous structured setup violated an application-owned invariant.\nValidation error: ${message}\nPrevious setup: ${serialized(badSetup)}\n\nReturn one complete corrected setup object. Preserve valid creative content, correct every related reference, and do not mention the correction.`;
}

export function turnDomainCorrectionPrompt(originalPrompt: string, badResult: unknown, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return `${originalPrompt}\n\nTURN DOMAIN CORRECTION\nThe previous structured response could not be applied atomically.\nValidation error: ${message}\nPrevious response: ${serialized(badResult)}\n\nReturn one complete corrected response object using only authoritative IDs, inventory, and facts supplied above. Do not mention the correction.`;
}

export function structuredRepairPrompt(originalPrompt: string, badResult: unknown, error: unknown): string {
  return `${originalPrompt}\n\nSTRUCTURED RESPONSE REPAIR\nThe previous response could not be decoded into the enforced protocol.\nIssues: ${conciseFailure(error)}\nPrevious response: ${serialized(badResult) ?? "unavailable"}\n\nReturn exactly one complete JSON value matching the enforced schema. Use only documented fields and enum values. Do not wrap it in Markdown or mention this repair.`;
}
