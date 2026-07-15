/**
 * An input transaction violated a deterministic domain rule.
 *
 * Keep this internal distinction separate from parsing and programming errors:
 * only these violations are eligible for an LLM domain-correction attempt.
 */
export class DomainValidationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "DomainValidationError";
  }
}

export function rejectDomainChange(message: string): never {
  throw new DomainValidationError(message);
}
