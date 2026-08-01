import type { DomainViolation, DomainViolationCode, DomainViolationDetail } from "./violations.js";

export interface DomainValidationErrorOptions extends ErrorOptions {
  /** Every rule this transaction violated, when admission collected them. */
  readonly violations?: readonly DomainViolation[];
}

/**
 * An input transaction violated a deterministic domain rule.
 *
 * Keep this internal distinction separate from parsing and programming errors:
 * only these violations are eligible for an LLM domain-correction attempt.
 */
export class DomainValidationError extends Error {
  readonly violations: readonly DomainViolation[];

  constructor(message: string, options?: DomainValidationErrorOptions) {
    super(message, options);
    this.name = "DomainValidationError";
    this.violations = options?.violations ?? [];
  }
}

/**
 * A rule fired that no model response could have caused or can repair.
 *
 * Either the application produced inconsistent state, or the campaign's
 * Markdown was edited outside the application. Both are real and both must
 * stop the turn, but neither is a correction request: sending one spends the
 * turn's single bounded repair on a fault the model cannot see, and then fails
 * anyway. Deliberately not a `DomainValidationError`, because that type is the
 * marker for "eligible for an LLM domain-correction attempt".
 */
export class CampaignInvariantError extends Error {
  readonly violations: readonly DomainViolation[];

  constructor(message: string, options?: DomainValidationErrorOptions) {
    super(message, options);
    this.name = "CampaignInvariantError";
    this.violations = options?.violations ?? [];
  }
}

/**
 * Reject one rule immediately.
 *
 * An admission pass catches these so the complete violation set can be
 * reported together; the pending-commit replay path keeps throw-on-first
 * behavior because its ledger was already accepted.
 */
export function rejectDomainChange(
  message: string,
  code: DomainViolationCode = "domain_rule",
  detail?: DomainViolationDetail,
): never {
  throw new DomainValidationError(message, {
    violations: [{ code, message, ...(detail === undefined ? {} : { detail }) }],
  });
}
