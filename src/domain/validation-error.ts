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
