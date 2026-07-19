import { z } from "zod";
import { classifyFailure, GenerationFailure, type FailureKind } from "../llm/failures.js";
import { attemptMetadataFor } from "../llm/structured-error.js";
import type { ProviderAttemptMetadata } from "../types.js";

export const FailureOwnerSchema = z.enum([
  "candidate_model",
  "adapter_configuration",
  "provider_route",
  "account_access",
  "judge",
  "player_driver",
  "application",
  "inconclusive",
]);
export type FailureOwner = z.infer<typeof FailureOwnerSchema>;

export const PlaytestCallLaneSchema = z.enum([
  "calibration",
  "candidate",
  "player_driver",
  "judge",
]);
export type PlaytestCallLane = z.infer<typeof PlaytestCallLaneSchema>;

export const FailureAttributionSchema = z.object({
  owner: FailureOwnerSchema,
  lane: PlaytestCallLaneSchema,
  failureKind: z.string().min(1),
  reason: z.string().min(1),
  candidateStatusImpact: z.enum(["counts", "excluded", "inconclusive"]),
}).strict();
export type FailureAttribution = z.infer<typeof FailureAttributionSchema>;

export interface FailureAttributionContext {
  lane: PlaytestCallLane;
  stage?: "provider_call" | "domain_validation" | "persistence" | "application";
  attemptMetadata?: ProviderAttemptMetadata;
}

function laneOutputOwner(lane: PlaytestCallLane): FailureOwner {
  if (lane === "judge") return "judge";
  if (lane === "player_driver") return "player_driver";
  return "candidate_model";
}

function impact(owner: FailureOwner, lane: PlaytestCallLane): FailureAttribution["candidateStatusImpact"] {
  if (lane !== "candidate") return "excluded";
  if (owner === "candidate_model") return "counts";
  return "inconclusive";
}

function attribution(
  owner: FailureOwner,
  lane: PlaytestCallLane,
  failureKind: FailureKind | "application",
  reason: string,
): FailureAttribution {
  return FailureAttributionSchema.parse({
    owner,
    lane,
    failureKind,
    reason,
    candidateStatusImpact: impact(owner, lane),
  });
}

/** Deterministic ownership based only on typed failures and provider metadata. */
export function attributePlaytestFailure(
  error: unknown,
  context: FailureAttributionContext,
): FailureAttribution {
  const metadata = context.attemptMetadata ?? attemptMetadataFor(error);
  if (context.stage === "persistence" || context.stage === "application") {
    return attribution("application", context.lane, "application", "application_or_persistence_failure");
  }

  if (error instanceof GenerationFailure && (error.status === 401 || error.status === 403)) {
    return attribution("account_access", context.lane, error.kind, "authentication_or_model_access");
  }

  const classified = classifyFailure(error);
  if (classified.kind === "rate_limit" || classified.kind === "network") {
    return attribution("provider_route", context.lane, classified.kind, "provider_route_or_network_failure");
  }
  if (classified.kind === "schema_rejected") {
    return attribution("adapter_configuration", context.lane, classified.kind, "provider_rejected_structured_output_configuration");
  }
  if (metadata?.truncated) {
    return attribution("adapter_configuration", context.lane, classified.kind, "output_budget_truncation");
  }
  if (classified.kind === "malformed_json"
    || classified.kind === "wire_schema_violation"
    || classified.kind === "domain_decode_violation"
    || classified.kind === "reference_violation"
    || classified.kind === "invariant_violation"
    || classified.kind === "content_block") {
    const owner = laneOutputOwner(context.lane);
    return attribution(owner, context.lane, classified.kind, "lane_model_output_failure");
  }
  if (context.stage === "domain_validation") {
    return attribution(laneOutputOwner(context.lane), context.lane, classified.kind, "typed_domain_validation_failure");
  }
  if (context.lane === "judge" || context.lane === "player_driver") {
    return attribution(laneOutputOwner(context.lane), context.lane, classified.kind, "lane_provider_failure");
  }
  return attribution("inconclusive", context.lane, classified.kind, "insufficient_typed_evidence");
}
