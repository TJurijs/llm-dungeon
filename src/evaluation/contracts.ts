import { z } from "zod";
import { DEFAULT_LANGUAGE, LanguageCodeSchema } from "../language.js";
import type { FailureKind } from "../llm/failures.js";
import { ProviderConfigSchema } from "../schemas.js";
import type { StructuredResult, TurnResult } from "../types.js";
import type { JudgeTurn } from "./judge.js";

export const PlayerApproachSchema = z.enum([
  "exploration",
  "social",
  "investigation",
  "combat",
  "experimentation",
  "rule_challenge",
]);

export const SimulatedPlayerActionSchema = z.object({
  action: z.string().min(1).max(800),
  approach: PlayerApproachSchema,
});

export type SimulatedPlayerAction = z.infer<typeof SimulatedPlayerActionSchema>;

export const ModelCostSchema = z.object({
  inputPerMillion: z.number().nonnegative(),
  outputPerMillion: z.number().nonnegative(),
});

export type ModelCost = z.infer<typeof ModelCostSchema>;

const EvaluationModelSchema = z.object({
  config: ProviderConfigSchema,
  cost: ModelCostSchema,
});

export const PlayerProfileIdSchema = z.enum([
  "curious-explorer",
  "social-manipulator",
  "cautious-investigator",
  "reckless-adventurer",
  "combat-focused",
  "creative-problem-solver",
  "rule-challenger",
  "long-term-planner",
  "chaotic",
]);

export const EvaluationConfigSchema = z.object({
  language: LanguageCodeSchema.default(DEFAULT_LANGUAGE),
  sessions: z.number().int().min(1).max(100),
  turns: z.number().int().min(1).max(200),
  concurrency: z.number().int().min(1).max(10).optional(),
  maxCostUsd: z.number().positive(),
  playerProfiles: z.array(PlayerProfileIdSchema)
    .min(1)
    .max(PlayerProfileIdSchema.options.length)
    .refine((profiles) => new Set(profiles).size === profiles.length, "Player profile pool cannot contain duplicates")
    .default(["curious-explorer"]),
  dm: EvaluationModelSchema,
  player: EvaluationModelSchema,
});

export type EvaluationConfig = z.infer<typeof EvaluationConfigSchema>;

export type EvaluationProgressPhase =
  | "queued"
  | "setup"
  | "playing"
  | "judging"
  | "completed"
  | "failed"
  | "cost_limit";

export interface EvaluationProgressEvent {
  sessionId: string;
  profile: string;
  phase: EvaluationProgressPhase;
  completedTurns: number;
  currentTurn: number;
  totalTurns: number;
  estimatedCostUsd: number;
  retries: number;
  message: string;
  updatedAt: string;
}

export const PLAYER_PROFILES = [
  { id: "curious-explorer", instruction: "Explore unfamiliar places, examine details, and follow discoveries organically." },
  { id: "social-manipulator", instruction: "Pursue goals through conversation, bargains, deception, alliances, and NPC relationships." },
  { id: "cautious-investigator", instruction: "Gather evidence, verify claims, prepare carefully, and revisit unresolved clues." },
  { id: "reckless-adventurer", instruction: "Take bold risks, escalate tense situations, and accept dangerous consequences." },
  { id: "combat-focused", instruction: "Use force when fictionally reasonable while still adapting to injuries and consequences." },
  { id: "creative-problem-solver", instruction: "Combine ordinary objects, environmental details, and social leverage in unusual ways." },
  { id: "rule-challenger", instruction: "Occasionally attempt impossible actions or claim an unowned item to test whether the world resists unsupported assertions." },
  { id: "long-term-planner", instruction: "Form a durable goal, track promises, and revisit people or places affected by earlier choices." },
  { id: "chaotic", instruction: "Act as an adversarially incoherent player. Rotate among gibberish strings, actions that make no fictional sense, contradictions of established facts, and attempts to use specific items or abilities the character does not possess. Occasionally provide a valid action so the DM must recover gracefully rather than treating the entire session as invalid. Never explain the test or label an action as adversarial." },
] as const;

export type PlayerProfile = (typeof PLAYER_PROFILES)[number];

export interface CallRecord {
  timestamp: string;
  role: "dm" | "player";
  sessionId: string;
  sequence: number;
  schemaName: string;
  provider: string;
  model: string;
  durationMs: number;
  promptHash: string;
  systemHash: string;
  system: string;
  prompt: string;
  success: boolean;
  usage?: StructuredResult<unknown>["usage"];
  estimatedCostUsd: number;
  response?: unknown;
  rawText?: string;
  structuredMode?: StructuredResult<unknown>["structuredMode"];
  protocolVersion?: number;
  failureKind?: FailureKind;
  error?: string;
}

export interface EvaluationTurnRecord extends JudgeTurn {
  turn: number;
  action: string;
  approach: SimulatedPlayerAction["approach"];
  narration?: string;
  summary?: string;
  check?: TurnResult["check"];
  operations?: TurnResult["operations"];
  status: "completed" | "failed";
  error?: string;
}

export const EvaluationRunIdSchema = z.string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/, "must be a safe evaluation run ID");

const EvaluationSessionIdSchema = z.string()
  .regex(/^session-[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/, "must be a safe evaluation session ID");

export const SessionMetricsSchema = z.object({
  sessionId: EvaluationSessionIdSchema,
  profile: PlayerProfileIdSchema,
  status: z.enum(["completed", "failed"]),
  stopReason: z.enum(["turn_limit", "campaign_ended", "cost_limit", "error"]),
  turnsCompleted: z.number().int().nonnegative(),
  dmCalls: z.number().int().nonnegative(),
  playerCalls: z.number().int().nonnegative(),
  failedCalls: z.number().int().nonnegative(),
  schemaRepairCalls: z.number().int().nonnegative(),
  transientRetryCalls: z.number().int().nonnegative(),
  domainRepairCalls: z.number().int().nonnegative(),
  domainRepairsExhausted: z.number().int().nonnegative(),
  repairCallsSucceeded: z.number().int().nonnegative(),
  repairCallsFailed: z.number().int().nonnegative(),
  failedCallCostUsd: z.number().nonnegative(),
  failureFingerprints: z.record(z.string(), z.number().int().nonnegative()),
  checks: z.number().int().nonnegative(),
  /** Fraction of completed turns that required a check, from 0 to 1. */
  checkRate: z.number().min(0).max(1),
  averageDifficulty: z.number().nullable(),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  estimatedCostUsd: z.number().nonnegative(),
  averageCallLatencyMs: z.number().nonnegative(),
  judgeStatus: z.enum(["completed", "failed", "not_run"]),
  judgeScore: z.number().min(0).max(10).optional(),
  judgeVerdict: z.enum(["poor", "mixed", "good", "excellent"]).optional(),
  judgeHighIssues: z.number().int().nonnegative(),
  qualityGatePassed: z.boolean(),
  approachCounts: z.record(z.string(), z.number().int().nonnegative()),
  entitiesAtEnd: z.number().int().nonnegative(),
  factsAtEnd: z.number().int().nonnegative(),
  campaignStatus: z.string().min(1),
  error: z.string().optional(),
});

export type SessionMetrics = z.infer<typeof SessionMetricsSchema>;

const SessionManifestEntrySchema = z.object({
  id: EvaluationSessionIdSchema,
  profile: PlayerProfileIdSchema,
  status: z.enum(["pending", "running", "completed", "failed"]),
  metrics: SessionMetricsSchema.optional(),
});

export const EvaluationManifestSchema = z.object({
  schemaVersion: z.literal(1),
  runId: EvaluationRunIdSchema,
  startedAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  completedAt: z.string().datetime().optional(),
  status: z.enum(["running", "completed", "completed_with_failures", "cost_limit"]),
  codeVersion: z.object({
    commit: z.string().nullable(),
    dirty: z.boolean().nullable(),
    sourceHash: z.string().min(1),
  }),
  config: EvaluationConfigSchema,
  worldPromptHash: z.string().min(1),
  totalEstimatedCostUsd: z.number().nonnegative(),
  abandonedCostUsd: z.number().nonnegative(),
  sessions: z.array(SessionManifestEntrySchema),
});

export type EvaluationManifest = z.infer<typeof EvaluationManifestSchema>;

export interface EvaluationRunResult {
  manifest: EvaluationManifest;
  runDir: string;
  reportPath: string;
}
