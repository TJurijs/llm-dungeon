import {
  advisoryRulePromptFragments,
  domainRulePromptFragments,
  type RulePhase,
} from "../domain/rules/registry.js";
import { section, type PromptSection } from "./render.js";

/**
 * Prompt text for the rules the application actually enforces.
 *
 * These sentences are generated from the same declarations the admission stage
 * evaluates, so a rule is stated exactly once and cannot survive in prose after
 * its check is removed. Hand-written policy sections remain the home for model
 * behavior that no deterministic check can verify.
 *
 * Only `reject` rules appear here. A rule that is normalized or merely observed
 * cannot return a turn, and listing it under this heading would make the stated
 * consequence untrue for part of the list.
 */
export function domainRuleSection(phase: RulePhase): PromptSection | undefined {
  const fragments = domainRulePromptFragments(phase, "reject");
  // A heading that promises validation with nothing listed under it is prompt
  // budget spent on a claim about an empty set.
  if (fragments.length === 0) return undefined;
  return section(
    "domain-rules",
    "APPLICATION-ENFORCED DOMAIN RULES",
    `Deterministic validation checks each rule below against the complete effect list before anything is committed. A violation returns the whole turn for correction, so satisfy them while drafting rather than afterwards.
${fragments.join("\n")}`,
  );
}

/**
 * Expectations the application checks but never fails a turn over.
 *
 * Kept separate so the enforced list stays literally true. These still belong in
 * the prompt: deterministic pruning can remove a forbidden tag, but only the
 * model can record the state that tag was standing in for.
 */
export function advisoryRuleSection(phase: RulePhase): PromptSection | undefined {
  const fragments = advisoryRulePromptFragments(phase);
  if (fragments.length === 0) return undefined;
  return section(
    "advisory-rules",
    "REVIEWED DRAFTING EXPECTATIONS",
    `The application either corrects each point below deterministically or records it for human review. None of them returns a turn, so treat them as craft rather than as gates.
${fragments.join("\n")}`,
  );
}

export const ADJUDICATION_DOMAIN_RULES = domainRuleSection("adjudication");
export const RESOLUTION_DOMAIN_RULES = domainRuleSection("resolution");
export const APPEAL_DOMAIN_RULES = domainRuleSection("appeal");
export const SETUP_DOMAIN_RULES = domainRuleSection("setup");

export const ADJUDICATION_ADVISORY_RULES = advisoryRuleSection("adjudication");
export const RESOLUTION_ADVISORY_RULES = advisoryRuleSection("resolution");
export const APPEAL_ADVISORY_RULES = advisoryRuleSection("appeal");
export const SETUP_ADVISORY_RULES = advisoryRuleSection("setup");
