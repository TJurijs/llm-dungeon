import { createHash } from "node:crypto";
import { DOMAIN_RULES, type DomainViolationCode } from "../domain/rules/registry.js";

export type DomainRepairValidationStage = "setup" | "turn_commit";

/**
 * Application-owned explanation for a locally rejected, structurally valid
 * model result. It is deliberately smaller than the correction prompt: no
 * response, prompt, or campaign-state payload is retained.
 */
export interface DomainRepairCause {
  logicalOperationId: string;
  validationStage: DomainRepairValidationStage;
  errorName: string;
  errorMessage: string;
  errorFingerprint: string;
}

const SAFE_ERROR_NAMES = new Set([
  "AppealPolicyError",
  "Error",
  "LockedOutcomeError",
  "TransactionValidationError",
]);
/** One batched envelope header plus its bounded violation list. */
const MAX_MESSAGE_LINES = 10;
const MAX_MESSAGE_LENGTH = 1_000;
const GENERIC_RULE = "Local domain validation rejected the structured result";

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function safeLogicalOperationId(value: string): string {
  const trimmed = value.trim();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(trimmed)
    ? trimmed.toLowerCase()
    : `sha256:${hash(trimmed || "unscoped")}`;
}

/**
 * Fallback classification for error sources that do not yet declare a rule
 * code. Every domain, setup, appeal, and locked-outcome path now carries
 * declarations, so this handles only unexpected shapes and legacy telemetry.
 */
function sanitizeLine(value: string): string {
  const leading = /^\s*-\s*/u.exec(value)?.[0] ?? "";
  const body = value.slice(leading.length).trim();

  if (
    body === "Initial setup validation failed:" ||
    body === "State consistency validation failed:" ||
    body === "Transaction validation failed:"
  ) {
    return `${leading}${body}`;
  }
  const omittedViolations = /^(\d+) further violation\(s\) omitted/u.exec(body);
  if (omittedViolations) {
    return `${leading}${omittedViolations[1]} further violation(s) omitted`;
  }
  const declaredCode = /^\[([a-z_]{1,64})\] /u.exec(body)?.[1];
  if (declaredCode && declaredCode in DOMAIN_RULES) {
    return `${leading}[${declaredCode}] ${DOMAIN_RULES[declaredCode as DomainViolationCode].redacted}`;
  }
  return `${leading}${GENERIC_RULE}`;
}

/** Retain the violated rule while removing identifiers and free-form campaign values. */
export function sanitizeDomainRepairMessage(value: string): string {
  const lines = value
    .replaceAll("\u0000", " ")
    .split(/\r?\n/u)
    .slice(0, MAX_MESSAGE_LINES)
    .map(sanitizeLine)
    .filter(Boolean);
  const bounded = lines.join("\n").slice(0, MAX_MESSAGE_LENGTH).trim();
  return bounded || GENERIC_RULE;
}

interface StructuredViolations {
  readonly violations?: readonly {
    readonly code: string;
    readonly message: string;
    readonly detail?: string;
  }[];
}

/**
 * Redact from the rule declarations when the error carries them.
 *
 * Pattern-matching rendered prose is what let telemetry drift out of sync with
 * the checks: a new rule whose branch was never added silently became an
 * unclassified cause. A declared code needs no branch.
 */
function redactFromDeclarations(
  error: unknown,
  stage: DomainRepairValidationStage,
): string | undefined {
  const violations = (error as StructuredViolations | null)?.violations;
  if (!violations?.length) return undefined;
  const lines = violations.slice(0, MAX_MESSAGE_LINES - 1).map(({ code, detail }) => {
    const rule =
      code in DOMAIN_RULES ? DOMAIN_RULES[code as DomainViolationCode].redacted : GENERIC_RULE;
    // The detail is a closed vocabulary token, so it is safe to keep.
    return `- [${code}] ${rule}${detail === undefined ? "" : ` (${detail})`}`;
  });
  const omitted = violations.length - lines.length;
  if (omitted > 0) lines.push(`- ${omitted} further violation(s) omitted`);
  if (lines.length === 1) return lines[0]!.slice(2);
  const header =
    stage === "setup" ? "Initial setup validation failed:" : "Transaction validation failed:";
  return `${header}\n${lines.join("\n")}`.slice(0, MAX_MESSAGE_LENGTH);
}

export function createDomainRepairCause(
  error: unknown,
  input: {
    logicalOperationId: string;
    validationStage: DomainRepairValidationStage;
  },
): DomainRepairCause {
  const errorName =
    error instanceof Error && SAFE_ERROR_NAMES.has(error.name) ? error.name : "Error";
  const rawMessage = error instanceof Error ? error.message : String(error);
  // Error sources that predate declared codes still fall back to classified
  // pattern redaction; they are ported rule by rule.
  const errorMessage =
    redactFromDeclarations(error, input.validationStage) ??
    redactFromDeclarations((error as { cause?: unknown } | null)?.cause, input.validationStage) ??
    sanitizeDomainRepairMessage(rawMessage);
  return {
    logicalOperationId: safeLogicalOperationId(input.logicalOperationId),
    validationStage: input.validationStage,
    errorName,
    errorMessage,
    // Fingerprints are diagnostic grouping keys, not proof of the rejected
    // payload. Hash the classified, redacted rule so even low-entropy campaign
    // secrets cannot be recovered with a dictionary attack.
    errorFingerprint: hash(`${errorName}\u0000${errorMessage}`),
  };
}
