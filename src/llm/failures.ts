import { ZodError } from "zod";
import { ProtocolDecodeError } from "./gameplay-protocol.js";

export type FailureKind =
  | "network"
  | "rate_limit"
  | "provider"
  | "schema_rejected"
  | "malformed_json"
  | "wire_schema_violation"
  | "domain_decode_violation"
  | "reference_violation"
  | "invariant_violation"
  | "content_block";

export class GenerationFailure extends Error {
  constructor(
    readonly kind: FailureKind,
    message: string,
    readonly retryable: boolean,
    readonly status?: number,
  ) {
    super(message);
    this.name = "GenerationFailure";
  }
}

export function classifyFailure(error: unknown): { kind: FailureKind; retryable: boolean } {
  if (error instanceof GenerationFailure) return error;
  if (error instanceof ProtocolDecodeError) return { kind: "domain_decode_violation", retryable: true };
  if (error instanceof ZodError) return { kind: "wire_schema_violation", retryable: true };
  if (error instanceof TypeError) return { kind: "network", retryable: true };
  const message = error instanceof Error ? error.message : String(error);
  if (/fetch failed|network|ECONNRESET|ETIMEDOUT|ENOTFOUND|socket/i.test(message)) {
    return { kind: "network", retryable: true };
  }
  if (/unknown .* reference|ambiguous .* reference|unknown entity|unknown thread/i.test(message)) {
    return { kind: "reference_violation", retryable: true };
  }
  if (/consistency|inventory .* negative|duplicate|already exists|not a location|must change/i.test(message)) {
    return { kind: "invariant_violation", retryable: true };
  }
  return { kind: "provider", retryable: false };
}

export function conciseFailure(error: unknown): string {
  if (error instanceof ZodError) {
    return error.issues
      .slice(0, 12)
      .map((issue) => `${issue.path.join(".") || "response"}: ${issue.message}`)
      .join("; ");
  }
  return error instanceof Error ? error.message : String(error);
}
