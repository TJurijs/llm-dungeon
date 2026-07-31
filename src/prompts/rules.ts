import { domainRulePromptFragments, type RulePhase } from "../domain/rules/registry.js";
import { section, type PromptSection } from "./render.js";

/**
 * Prompt text for the rules the application actually enforces.
 *
 * These sentences are generated from the same declarations the admission stage
 * evaluates, so a rule is stated exactly once and cannot survive in prose after
 * its check is removed. Hand-written policy sections remain the home for model
 * behavior that no deterministic check can verify.
 */
export function domainRuleSection(phase: RulePhase): PromptSection {
  return section(
    "domain-rules",
    "APPLICATION-ENFORCED DOMAIN RULES",
    `Deterministic validation checks each rule below against the complete effect list before anything is committed. A violation returns the whole turn for correction, so satisfy them while drafting rather than afterwards.
${domainRulePromptFragments(phase).join("\n")}`,
  );
}

export const ADJUDICATION_DOMAIN_RULES = domainRuleSection("adjudication");
export const RESOLUTION_DOMAIN_RULES = domainRuleSection("resolution");
export const APPEAL_DOMAIN_RULES = domainRuleSection("appeal");
export const SETUP_DOMAIN_RULES = domainRuleSection("setup");
