import { conciseFailure } from "../llm/failures.js";

function serialized(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

function decisionRepairChecklist(value: unknown): string {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return "";
  const decision = (value as Record<string, unknown>).decision;
  if (decision === "check_required") {
    return `\n\nCHECK-REQUIRED REPAIR CHECKLIST
The previous response selected decision=check_required. If that decision remains warranted, set narration exactly to "", summary exactly to "", and effects exactly to []. A description or summary of the attempted action is forbidden before the application supplies the roll. Preserve the completed check fields and verify those three empty fields immediately before returning.`;
  }
  if (decision === "resolved") {
    return `\n\nRESOLVED REPAIR CHECKLIST
The previous response selected decision=resolved. If that decision remains warranted, narration and summary must be nonempty, effects must contain only caused durable changes, every check string must be "", difficulty must be 0, modifiers must be [], and failureCampaignStatus must be none.`;
  }
  return "";
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
  return `${originalPrompt}\n\nSTRUCTURED RESPONSE REPAIR\nThe previous response could not be decoded into the enforced protocol.\nIssues: ${conciseFailure(error)}\nPrevious response: ${serialized(badResult) ?? "unavailable"}${decisionRepairChecklist(badResult)}\n\nREPAIR PROCEDURE\n- Return a new, complete JSON value; do not repeat the previous response unchanged.\n- Preserve its valid content, array elements, and ordering while correcting every reported path.\n- A field reported as undefined is a missing mandatory key. Restore that key at its exact path.\n- Audit every sibling object in the same array for the same omission, including issues beyond the displayed list.\n- Required keys remain mandatory when their documented neutral value is "", 0, or []. For fields used by the selected operation, restore the meaningful value required by the narration and contract rather than a neutral placeholder.\n\nReturn exactly one complete JSON value matching the enforced schema. Correct every reported issue, use only documented fields and enum values, and do not wrap the JSON in Markdown or mention this repair.`;
}
