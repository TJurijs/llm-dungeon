import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { z } from "zod";
import { ProviderConfigSchema } from "./schemas.js";

export const MODEL_EXECUTION_PROFILE_VERSION = 1 as const;
/** Increment whenever profile interpretation or a named projection changes. */
export const MODEL_EXECUTION_ADAPTER_REVISION = 7 as const;

export const ModelGenerationPhaseSchema = z.enum([
  "setup",
  "decision",
  "locked_resolution",
  "repair",
]);
export type ModelGenerationPhase = z.infer<typeof ModelGenerationPhaseSchema>;

export const SchemaProjectionIdSchema = z.enum([
  "identity_v1",
  "openai_strict_v1",
  "gemini_compatible_v1",
  "anthropic_compatible_v1",
]);
export type SchemaProjectionId = z.infer<typeof SchemaProjectionIdSchema>;

export const OutputTokenFieldSchema = z.enum([
  "max_tokens",
  "max_completion_tokens",
  "maxOutputTokens",
]);
export type OutputTokenField = z.infer<typeof OutputTokenFieldSchema>;

const StructuredOutputPolicySchema = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("native_strict_json_schema"),
    projection: z.literal("identity_v1"),
  }).strict(),
  z.object({
    mode: z.literal("projected_strict_json_schema"),
    projection: z.enum([
      "openai_strict_v1",
      "gemini_compatible_v1",
      "anthropic_compatible_v1",
    ]),
  }).strict(),
  z.object({
    mode: z.literal("json_object_local_schema"),
    projection: z.literal("identity_v1"),
    reinforceSchema: z.literal(true),
  }).strict(),
]);

const TemperaturePolicySchema = z.discriminatedUnion("policy", [
  z.object({ policy: z.literal("fixed"), value: z.number().min(0).max(2) }).strict(),
  z.object({ policy: z.literal("omitted") }).strict(),
]);

const ReasoningPolicySchema = z.discriminatedUnion("policy", [
  z.object({ policy: z.literal("omitted") }).strict(),
  z.object({
    policy: z.literal("chat_reasoning_effort"),
    value: z.enum(["none", "low"]),
  }).strict(),
  z.object({
    policy: z.literal("openrouter_reasoning_effort"),
    value: z.enum(["none", "low"]),
  }).strict(),
  z.object({ policy: z.literal("openrouter_reasoning_disabled") }).strict(),
  z.object({ policy: z.literal("deepseek_thinking_disabled") }).strict(),
  z.object({ policy: z.literal("deepseek_thinking_for_repairs") }).strict(),
  z.object({ policy: z.literal("gemini_thinking_low") }).strict(),
]);

export const PhaseBudgetsSchema = z.object({
  setup: z.number().int().min(256).max(32_000),
  decision: z.number().int().min(256).max(32_000),
  lockedResolution: z.number().int().min(256).max(32_000),
  repair: z.number().int().min(256).max(32_000),
}).strict();
export type PhaseBudgets = z.infer<typeof PhaseBudgetsSchema>;

export const TimeoutPolicySchema = z.object({
  setupMs: z.number().int().min(1_000).max(600_000),
  decisionMs: z.number().int().min(1_000).max(600_000),
  lockedResolutionMs: z.number().int().min(1_000).max(600_000),
  repairMs: z.number().int().min(1_000).max(600_000),
}).strict();
export type TimeoutPolicy = z.infer<typeof TimeoutPolicySchema>;

export const ModelExecutionProfileDraftSchema = z.object({
  schemaVersion: z.literal(MODEL_EXECUTION_PROFILE_VERSION),
  key: z.object({
    provider: ProviderConfigSchema.shape.provider,
    model: z.string().trim().min(1).max(300),
    route: z.string().trim().min(1).max(100),
  }).strict(),
  structuredOutput: StructuredOutputPolicySchema,
  temperature: TemperaturePolicySchema,
  reasoning: ReasoningPolicySchema,
  outputTokenField: OutputTokenFieldSchema,
  outputBudgets: PhaseBudgetsSchema,
  timeout: TimeoutPolicySchema,
  adapterRevision: z.number().int().positive(),
}).strict();
export type ModelExecutionProfileDraft = z.infer<typeof ModelExecutionProfileDraftSchema>;

export const ModelExecutionProfileSchema = ModelExecutionProfileDraftSchema.extend({
  calibratedAt: z.string().datetime({ offset: true }),
  evidenceRef: z.string().trim().min(1).max(500),
}).strict();
export type ModelExecutionProfile = z.infer<typeof ModelExecutionProfileSchema>;

export const FrozenModelExecutionProfileSchema = ModelExecutionProfileSchema.extend({
  frozen: z.literal(true),
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
export type FrozenModelExecutionProfile = z.infer<typeof FrozenModelExecutionProfileSchema>;

const DEFAULT_BUDGETS = {
  setup: 8_000,
  decision: 4_000,
  lockedResolution: 4_000,
  repair: 8_000,
} as const;

const DEFAULT_TIMEOUTS = {
  setupMs: 180_000,
  decisionMs: 120_000,
  lockedResolutionMs: 120_000,
  repairMs: 120_000,
} as const;

function draft(
  key: ModelExecutionProfileDraft["key"],
  structuredOutput: ModelExecutionProfileDraft["structuredOutput"],
  temperature: ModelExecutionProfileDraft["temperature"],
  reasoning: ModelExecutionProfileDraft["reasoning"],
  outputTokenField: OutputTokenField,
): ModelExecutionProfileDraft {
  return ModelExecutionProfileDraftSchema.parse({
    schemaVersion: MODEL_EXECUTION_PROFILE_VERSION,
    key,
    structuredOutput,
    temperature,
    reasoning,
    outputTokenField,
    outputBudgets: DEFAULT_BUDGETS,
    timeout: DEFAULT_TIMEOUTS,
    adapterRevision: MODEL_EXECUTION_ADAPTER_REVISION,
  });
}

/** Uncalibrated starting variants only; these are not certification evidence. */
export const DEFAULT_MODEL_EXECUTION_PROFILE_DRAFTS: readonly ModelExecutionProfileDraft[] = [
  ...["gemini-3.5-flash", "gemini-3.1-flash-lite", "gemini-3.6-flash", "gemini-3.5-flash-lite"].map((model) => draft(
    { provider: "gemini", model, route: "direct" },
    { mode: "projected_strict_json_schema", projection: "gemini_compatible_v1" },
    { policy: "fixed", value: 0.8 },
    { policy: "gemini_thinking_low" },
    "maxOutputTokens",
  )),
  draft(
    { provider: "openrouter", model: "qwen/qwen3.7-plus", route: "openrouter" },
    { mode: "native_strict_json_schema", projection: "identity_v1" },
    { policy: "fixed", value: 0.8 },
    { policy: "openrouter_reasoning_effort", value: "none" },
    "max_tokens",
  ),
  draft(
    { provider: "xai", model: "grok-4.5", route: "direct" },
    { mode: "projected_strict_json_schema", projection: "openai_strict_v1" },
    { policy: "fixed", value: 0.8 },
    { policy: "chat_reasoning_effort", value: "low" },
    "max_tokens",
  ),
  ...["gpt-5.4", "gpt-5.6-terra"].map((model) => draft(
    { provider: "openai", model, route: "direct" },
    { mode: "projected_strict_json_schema", projection: "openai_strict_v1" },
    { policy: "omitted" },
    { policy: "chat_reasoning_effort", value: "none" },
    "max_completion_tokens",
  )),
  ...["deepseek-v4-flash", "deepseek-v4-pro"].map((model) => draft(
    { provider: "deepseek", model, route: "direct" },
    { mode: "json_object_local_schema", projection: "identity_v1", reinforceSchema: true },
    { policy: "omitted" },
    { policy: "deepseek_thinking_for_repairs" },
    "max_tokens",
  )),
  // Anthropic Messages uses output_config json_schema with the compatible
  // projection. Temperature and reasoning are omitted so one provider-level
  // starting draft is valid across Haiku (which allows temperature) and the
  // Opus 4.8 / Sonnet 5 family (which reject sampling controls).
  ...["claude-haiku-4-5", "claude-sonnet-5"].map((model) => draft(
    { provider: "anthropic", model, route: "direct" },
    { mode: "projected_strict_json_schema", projection: "anthropic_compatible_v1" },
    { policy: "omitted" },
    { policy: "omitted" },
    "max_tokens",
  )),
];

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => [key, canonicalize(item)]));
}

function executionDraft(profile: ModelExecutionProfileDraft): ModelExecutionProfileDraft {
  return ModelExecutionProfileDraftSchema.parse({
    schemaVersion: profile.schemaVersion,
    key: profile.key,
    structuredOutput: profile.structuredOutput,
    temperature: profile.temperature,
    reasoning: profile.reasoning,
    outputTokenField: profile.outputTokenField,
    outputBudgets: profile.outputBudgets,
    timeout: profile.timeout,
    adapterRevision: profile.adapterRevision,
  });
}

export function modelExecutionProfileFingerprint(profile: ModelExecutionProfileDraft): string {
  const executionContent = executionDraft(profile);
  return createHash("sha256").update(JSON.stringify(canonicalize(executionContent))).digest("hex");
}

/** Recursively freeze a value and everything it references, in place. */
export function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}

export function freezeModelExecutionProfile(profile: ModelExecutionProfile): FrozenModelExecutionProfile {
  const parsed = ModelExecutionProfileSchema.parse(profile);
  const frozen = FrozenModelExecutionProfileSchema.parse({
    ...parsed,
    frozen: true,
    fingerprint: modelExecutionProfileFingerprint(parsed),
  });
  return deepFreeze(structuredClone(frozen));
}

/**
 * Shipped execution-profile evidence is data, not logic: it changes whenever
 * a model is calibrated/certified and should ship in defaults/ so every
 * checkout gets a working profile without re-running paid calibration. Most
 * entries use the documented default budgets/timeouts (no override needed);
 * a model whose certification-scale turns proved those defaults insufficient
 * carries explicit outputBudgets/timeout overrides so a fresh checkout runs
 * the exact validated values instead of silently reintroducing the failure
 * that calibration fixed. Use `playtest promote` to generate/update entries
 * from real local evidence rather than hand-editing this file.
 */
const SHIPPED_PROFILE_EVIDENCE_URL = new URL("../defaults/model-execution-profiles.json", import.meta.url);

const ShippedProfileEvidenceSchema = z.object({
  provider: ProviderConfigSchema.shape.provider,
  model: z.string().trim().min(1).max(300),
  route: z.string().trim().min(1).max(100),
  calibratedAt: z.string().datetime({ offset: true }),
  evidenceRef: z.string().trim().min(1).max(500),
  outputBudgets: PhaseBudgetsSchema.optional(),
  timeout: TimeoutPolicySchema.optional(),
}).strict();
export type ShippedProfileEvidence = z.infer<typeof ShippedProfileEvidenceSchema>;

const ShippedProfileEvidenceFileSchema = z.object({
  version: z.literal(1),
  profiles: z.array(ShippedProfileEvidenceSchema),
}).strict();

export const SHIPPED_PROFILE_EVIDENCE: readonly ShippedProfileEvidence[] =
  ShippedProfileEvidenceFileSchema.parse(
    JSON.parse(readFileSync(SHIPPED_PROFILE_EVIDENCE_URL, "utf8")),
  ).profiles;

/** Frozen release evidence used until a local calibration supersedes it. */
export const SHIPPED_MODEL_EXECUTION_PROFILES: readonly FrozenModelExecutionProfile[] =
  SHIPPED_PROFILE_EVIDENCE.map((evidence) => {
    const candidate = DEFAULT_MODEL_EXECUTION_PROFILE_DRAFTS.find((profile) =>
      profile.key.provider === evidence.provider
      && profile.key.model === evidence.model
      && profile.key.route === evidence.route);
    if (!candidate) throw new Error(`Missing shipped execution profile draft for ${evidence.provider}/${evidence.model}`);
    return freezeModelExecutionProfile({
      ...candidate,
      ...(evidence.outputBudgets ? { outputBudgets: evidence.outputBudgets } : {}),
      ...(evidence.timeout ? { timeout: evidence.timeout } : {}),
      calibratedAt: evidence.calibratedAt,
      evidenceRef: evidence.evidenceRef,
    });
  });

function comparableVariables(profile: ModelExecutionProfileDraft): Record<string, unknown> {
  return {
    "structuredOutput": profile.structuredOutput,
    "temperature": profile.temperature,
    "reasoning": profile.reasoning,
    "outputTokenField": profile.outputTokenField,
    "outputBudgets.setup": profile.outputBudgets.setup,
    "outputBudgets.decision": profile.outputBudgets.decision,
    "outputBudgets.lockedResolution": profile.outputBudgets.lockedResolution,
    "outputBudgets.repair": profile.outputBudgets.repair,
    "timeout": profile.timeout,
    "route": profile.key.route,
  };
}

export function changedCalibrationVariables(
  left: ModelExecutionProfileDraft,
  right: ModelExecutionProfileDraft,
): string[] {
  const first = executionDraft(left);
  const second = executionDraft(right);
  if (first.key.provider !== second.key.provider || first.key.model !== second.key.model) {
    throw new Error("Calibration variants must target the same provider and model");
  }
  const leftVariables = comparableVariables(first);
  const rightVariables = comparableVariables(second);
  return Object.keys(leftVariables).filter((key) =>
    JSON.stringify(canonicalize(leftVariables[key])) !== JSON.stringify(canonicalize(rightVariables[key])));
}

export function assertSingleCalibrationVariableChange(
  left: ModelExecutionProfileDraft,
  right: ModelExecutionProfileDraft,
): string {
  const changes = changedCalibrationVariables(left, right);
  if (changes.length !== 1) {
    throw new Error(`Calibration variants must change exactly one variable; changed ${changes.length}: ${changes.join(", ") || "none"}`);
  }
  return changes[0]!;
}

export const CALIBRATION_OUTPUT_BUDGET_STEPS = {
  setup: [8_000, 16_000, 32_000],
  decision: [4_000, 8_000],
  locked_resolution: [4_000, 8_000],
  repair: [8_000, 16_000, 32_000],
} as const satisfies Record<ModelGenerationPhase, readonly number[]>;

function budgetKey(phase: ModelGenerationPhase): keyof ModelExecutionProfileDraft["outputBudgets"] {
  if (phase === "locked_resolution") return "lockedResolution";
  return phase;
}

export function outputBudgetForPhase(
  profile: ModelExecutionProfileDraft,
  phase: ModelGenerationPhase,
  repairOfPhase?: Exclude<ModelGenerationPhase, "repair">,
): number {
  const parsed = executionDraft(profile);
  if (phase !== "repair") return parsed.outputBudgets[budgetKey(phase)];
  const failedBudget = repairOfPhase === undefined
    ? 0
    : parsed.outputBudgets[budgetKey(repairOfPhase)];
  return Math.max(parsed.outputBudgets.repair, failedBudget);
}

export function timeoutForPhase(
  profile: ModelExecutionProfileDraft,
  phase: ModelGenerationPhase,
): number {
  const parsed = executionDraft(profile);
  if (phase === "setup") return parsed.timeout.setupMs;
  if (phase === "decision") return parsed.timeout.decisionMs;
  if (phase === "locked_resolution") return parsed.timeout.lockedResolutionMs;
  return parsed.timeout.repairMs;
}

/** Returns a new draft only when explicit truncation justifies the next bounded step. */
export function escalateOutputBudgetAfterTruncation(
  profile: ModelExecutionProfileDraft,
  phase: ModelGenerationPhase,
  truncated: boolean,
): ModelExecutionProfileDraft | undefined {
  if (!truncated) return undefined;
  const parsed = executionDraft(profile);
  const key = budgetKey(phase);
  const current = parsed.outputBudgets[key];
  const next = CALIBRATION_OUTPUT_BUDGET_STEPS[phase].find((value) => value > current);
  if (next === undefined) return undefined;
  return ModelExecutionProfileDraftSchema.parse({
    ...parsed,
    outputBudgets: { ...parsed.outputBudgets, [key]: next },
  });
}
