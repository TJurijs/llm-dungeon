import { conciseFailure } from "../llm/failures.js";
import { conservativeInputTokenEstimate } from "../input-budget.js";

/** Decision prompts reserve this bounded suffix for schema/domain recovery. */
export const TURN_RECOVERY_APPENDIX_TOKEN_LIMIT = 8_000;

function boundedRecoveryAppendix(
  value: string,
  label: string,
  limit = TURN_RECOVERY_APPENDIX_TOKEN_LIMIT,
): string {
  if (conservativeInputTokenEstimate(value) <= limit) return value;
  const note = `[${label} abbreviated to preserve the application input envelope.]`;
  const characters = [...value];
  const candidate = (retained: number): string => {
    const leadingCount = Math.ceil(retained / 2);
    const trailingCount = retained - leadingCount;
    return `${characters.slice(0, leadingCount).join("")}\n${note}\n${
      trailingCount > 0 ? characters.slice(-trailingCount).join("") : ""
    }`;
  };
  let low = 0;
  let high = characters.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (conservativeInputTokenEstimate(candidate(middle)) <= limit) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }
  return candidate(low);
}

function withBoundedRecoveryAppendix(
  originalPrompt: string,
  appendix: string,
  label: string,
): string {
  const existingMarkers = ["\n\nTURN DOMAIN CORRECTION\n", "\n\nSTRUCTURED RESPONSE REPAIR\n"];
  const markerOffset = existingMarkers
    .map((marker) => originalPrompt.indexOf(marker))
    .filter((offset) => offset >= 0)
    .sort((left, right) => left - right)[0];
  const basePrompt =
    markerOffset === undefined ? originalPrompt : originalPrompt.slice(0, markerOffset);
  const priorRecovery =
    markerOffset === undefined ? "" : originalPrompt.slice(markerOffset + 2).trim();
  const combinedAppendix = priorRecovery
    ? `PRIOR BOUNDED RECOVERY REQUIREMENT — STILL APPLIES\n${boundedRecoveryAppendix(
        priorRecovery,
        "prior recovery requirement",
        3_000,
      )}\n\nCURRENT RECOVERY REQUIREMENT\n${boundedRecoveryAppendix(
        appendix,
        "current recovery evidence",
        4_500,
      )}`
    : appendix;
  return `${basePrompt}\n\n${boundedRecoveryAppendix(combinedAppendix, label)}`;
}

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
The previous response selected decision=resolved. If that decision remains warranted, narration and summary must be nonempty and effects must contain only caused durable changes. For ordinary resolution every check field must be neutral. For an automatic outcome preserve the exact contract marker and keep only its player-safe reason in checkName; do not reveal secrets or alternate stakes.`;
  }
  return "";
}

export function setupDomainCorrectionPrompt(
  originalPrompt: string,
  badSetup: unknown,
  error: unknown,
): string {
  const message = error instanceof Error ? error.message : String(error);
  return `${originalPrompt}\n\nSETUP DOMAIN CORRECTION\nThe previous structured setup violated an application-owned invariant.\nValidation error: ${message}\nPrevious setup: ${serialized(badSetup)}\n\nReturn one complete corrected setup object. Preserve valid creative content, correct every related reference, and do not mention the correction.`;
}

export function turnDomainCorrectionPrompt(
  originalPrompt: string,
  badResult: unknown,
  error: unknown,
  authoritativeThreadIds: readonly string[] = [],
): string {
  const message = error instanceof Error ? error.message : String(error);
  const threadAuthority = authoritativeThreadIds.length
    ? `\n\nAUTHORITATIVE EXISTING THREAD IDS — CLOSED SET\n${authoritativeThreadIds
        .map((id) => `- ${id}`)
        .join(
          "\n",
        )}\nUse only an ID from this list for an effect that references an existing thread. If none matches the intended change, remove or revise that unsupported change.`
    : "";
  return withBoundedRecoveryAppendix(
    originalPrompt,
    `TURN DOMAIN CORRECTION\nThe previous structured response could not be applied atomically.\nValidation error: ${message}\nPrevious response: ${serialized(badResult)}${threadAuthority}\n\nEXACT-ID CORRECTION PROCEDURE\n- Square brackets mark ID boundaries in context; they are display delimiters, not part of an ID.\n- For every existing-state reference field, copy only the exact characters inside one bracketed authoritative ID supplied above and emit them without brackets.\n- Never shorten, normalize, reconstruct, or guess an ID from a display name. An almost-matching ID is still unknown.\n- When the validation error names an unknown ID, replace every occurrence with an exact bare authoritative ID only when the intended record is unambiguous.\n- If no exact authoritative ID is supplied, remove or revise the unsupported completed change and its narration instead of inventing a reference.\n\nReturn one complete corrected response object using only authoritative IDs, inventory, and facts supplied above. Preserve all valid content and correct every occurrence of the invalid reference. Do not mention the correction.`,
    "domain-correction evidence",
  );
}

export function structuredRepairPrompt(
  originalPrompt: string,
  badResult: unknown,
  error: unknown,
): string {
  return withBoundedRecoveryAppendix(
    originalPrompt,
    `STRUCTURED RESPONSE REPAIR\nThe previous response could not be decoded into the enforced protocol.\nIssues: ${conciseFailure(error)}\nPrevious response: ${serialized(badResult) ?? "unavailable"}${decisionRepairChecklist(badResult)}\n\nREPAIR PROCEDURE\n- Return a new, complete JSON value; do not repeat the previous response unchanged.\n- Preserve its valid content, array elements, and ordering while correcting every reported path.\n- A field reported as undefined is a missing mandatory key. Restore that key at its exact path.\n- Optional references are different from mandatory fields: if an optional ID/reference is empty or invalid and no exact valid reference is warranted, remove that entire optional key. Never use "" or null as an optional-reference placeholder, and never invent a replacement ID merely to retain the key.\n- Audit every sibling object in the same array for the same omission, including issues beyond the displayed list.\n- Required keys remain mandatory when their documented neutral value is "", 0, or []. For fields used by the selected operation, restore the meaningful value required by the narration and contract rather than a neutral placeholder.\n\nReturn exactly one complete JSON value matching the enforced schema. Correct every reported issue, use only documented fields and enum values, and do not wrap the JSON in Markdown or mention this repair.`,
    "structured-repair evidence",
  );
}

/**
 * Reframes a provider content block without changing the submitted game action
 * or any application-owned outcome. The original prompt remains the complete
 * authority; this suffix only constrains how the fiction is rendered.
 */
export function contentBlockRepairPrompt(originalPrompt: string): string {
  return `${originalPrompt}\n\nCONTENT-SAFE FICTIONAL RENDERING RETRY\nThe provider returned no usable content. Retry the exact same tabletop role-playing task.\n- Preserve all supplied authoritative context and the exact submitted input, including any setup seeds, player action and grammatical scope, question, appeal claim, artifact source, locked check or outcome, causal ordering, player agency, and required durable effects that are present. Do not replace, broaden, narrow, reject, moralize about, or automatically fail the submitted task because of this retry.\n- This is fictional narrative, not real-world instruction. Describe security bypasses, weapons, violence, dangerous machinery, and other sensitive events only at an outcome-focused, non-procedural level.\n- Do not provide reusable real-world steps, code, credentials, exploit details, construction instructions, targeting guidance, or other operational guidance.\n- Return the same exact enforced JSON contract. Do not mention moderation, policy, blocking, safety filters, or this retry in any player-visible output.`;
}
