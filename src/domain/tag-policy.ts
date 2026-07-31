const RESERVED_MUTABLE_STATE_TAGS = new Set([
  "active",
  "alarmed",
  "armed",
  "confined",
  "discovered",
  "guarding",
  "hidden",
  "holding",
  "idle",
  "in-transit",
  "known",
  "missing",
  "undiscovered",
  "unknown",
]);

const INTERNAL_TAG_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;

export type NewTagPolicyViolation = "mutable_state" | "non_machine";

/**
 * Tags are machine taxonomy, not localized prose or current state. Existing
 * legacy tags remain readable; this policy is applied only when a tag is new.
 */
export function newTagPolicyViolation(tag: string): NewTagPolicyViolation | undefined {
  if (RESERVED_MUTABLE_STATE_TAGS.has(tag.trim().toLowerCase())) return "mutable_state";
  if (!INTERNAL_TAG_PATTERN.test(tag)) return "non_machine";
  return undefined;
}
