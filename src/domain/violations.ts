import type { StateOperation } from "../schemas.js";
import { visitOperationReferences } from "./operation-references.js";
import { CampaignInvariantError, DomainValidationError } from "./validation-error.js";
import { DOMAIN_RULES, type DomainViolationCode } from "./rules/registry.js";

/**
 * Codes are the join key between the admission checks, redacted repair-cause
 * telemetry, and playtest coverage reporting. The type is derived from the
 * rule registry, so a check cannot report a rule that was never declared.
 */
export type { DomainViolationCode };

/**
 * Why a rule failed, drawn from a closed vocabulary.
 *
 * Redacted telemetry may carry this verbatim: every member is a fixed token,
 * so a detail can never leak an ID, a name, or generated prose. It exists so
 * diagnosing a rejection does not require reading the rejected response, which
 * is deliberately never persisted.
 */
export type DomainViolationDetail =
  "generated_suffix_variant" | "stem_shared" | "namespace_mismatch" | "unrecognized";

export interface DomainViolation {
  readonly code: DomainViolationCode;
  readonly message: string;
  readonly detail?: DomainViolationDetail;
}

/**
 * A correction prompt that lists every fault is still bounded, but an unbounded
 * list would crowd out the campaign evidence the model needs to fix them.
 */
const MAX_REPORTED_VIOLATIONS = 6;

export function formatDomainViolations(violations: readonly DomainViolation[]): string {
  if (violations.length === 0) return "";
  // A single fault keeps its exact rule text so existing diagnostics, tests,
  // and repair-cause classifications remain stable.
  if (violations.length === 1) return violations[0]!.message;
  const reported = violations.slice(0, MAX_REPORTED_VIOLATIONS);
  const omitted = violations.length - reported.length;
  const lines = reported.map((violation) => `- [${violation.code}] ${violation.message}`);
  if (omitted > 0) {
    lines.push(`- ${omitted} further violation(s) omitted; correct every listed rule first.`);
  }
  return `Transaction validation failed:\n${lines.join("\n")}`;
}

/**
 * Collects every deterministic violation in one admission pass.
 *
 * Rejecting on the first fault means a response with several problems consumes
 * the whole bounded repair budget on one of them. Collecting lets a single
 * correction address the complete set, so admission checks can be added
 * without making recovery less likely to succeed.
 */
export class DomainViolationCollector {
  private readonly violations: DomainViolation[] = [];
  private readonly signalled: DomainViolation[] = [];
  private readonly invariants: DomainViolation[] = [];
  private readonly seen = new Set<string>();
  private readonly failedSubjects = new Set<string>();

  /**
   * Record a violation unless it merely repeats an earlier one. Passing the
   * subjects a rule failed on lets later operations that depend on those
   * records stay quiet instead of reporting the same root cause again.
   */
  add(
    code: DomainViolationCode,
    message: string,
    options: {
      readonly subjects?: readonly string[];
      readonly detail?: DomainViolationDetail;
    } = {},
  ): void {
    const fingerprint = `${code}\u0000${message}`;
    // The registry decides what a rule does. Hard-coding that at each check is
    // what let a judgment-quality observation spend a turn's single bounded
    // correction; reading the declared disposition keeps the ladder honest and
    // makes adding a review-only rule safe.
    const disposition = DOMAIN_RULES[code].disposition;
    const blocking = disposition !== "signal";
    if (!this.seen.has(fingerprint)) {
      this.seen.add(fingerprint);
      const violation = {
        code,
        message,
        ...(options.detail === undefined ? {} : { detail: options.detail }),
      };
      // Three lanes, because a correctable model fault and an application
      // defect are different failures that happen to be found by the same
      // pass. Only the first is worth asking a model about.
      if (disposition === "invariant") this.invariants.push(violation);
      else if (blocking) this.violations.push(violation);
      else this.signalled.push(violation);
    }
    // A review-only rule must not poison dependent operations: the records it
    // named are still usable, so cascade suppression stays with real failures.
    if (!blocking) return;
    for (const subject of options.subjects ?? []) this.failedSubjects.add(subject);
  }

  /** Mark a record as unusable so dependent operations do not cascade. */
  markFailedSubject(id: string): void {
    this.failedSubjects.add(id);
  }

  /** True once a rule has already reported this exact record as unusable. */
  isFailedSubject(id: string): boolean {
    return this.failedSubjects.has(id);
  }

  /**
   * True when an operation only fails because a record it references already
   * failed. Reporting the root cause once keeps the correction actionable.
   */
  cascadesFromFailedSubject(operation: StateOperation): boolean {
    if (this.failedSubjects.size === 0) return false;
    let cascades = false;
    visitOperationReferences(operation, (reference) => {
      if (this.failedSubjects.has(reference)) cascades = true;
    });
    return cascades;
  }

  get size(): number {
    return this.violations.length;
  }

  list(): readonly DomainViolation[] {
    return this.violations;
  }

  /** Rules observed for review that deliberately did not block the turn. */
  signals(): readonly DomainViolation[] {
    return this.signalled;
  }

  /** Rules only an application defect or an externally edited save can trip. */
  invariantFailures(): readonly DomainViolation[] {
    return this.invariants;
  }

  assertNone(): void {
    // Invariants first. If the campaign is already inconsistent, whatever the
    // model got wrong on top of that is not the interesting fault, and asking
    // it to try again cannot help.
    if (this.invariants.length > 0) {
      throw new CampaignInvariantError(formatDomainViolations(this.invariants), {
        violations: this.invariants,
      });
    }
    if (this.violations.length === 0) return;
    throw new DomainValidationError(formatDomainViolations(this.violations), {
      violations: this.violations,
    });
  }
}
