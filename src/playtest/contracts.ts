import { z } from "zod";
import { LanguageCodeSchema } from "../language.js";
import { CheckResultSchema } from "../mechanics.js";
import {
  ModelAdapterStatusSchema,
  ModelQualityStatusSchema,
  ModelTechnicalGameplayStatusSchema,
  type ModelAdapterStatus,
  type ModelQualityStatus,
  type ModelTechnicalGameplayStatus,
} from "../model-status.js";
import {
  OutputTokenFieldSchema,
  SchemaProjectionIdSchema,
} from "../model-execution-profile.js";
import {
  ProviderConfigSchema,
  SafeIdSchema,
  SetupResultSchema,
  StateOperationSchema,
} from "../schemas.js";
import { FailureOwnerSchema, type FailureOwner } from "./failure-attribution.js";

export const PLAYTEST_ENGINE_VERSION = 1 as const;
export const PLAYTEST_MANIFEST_SCHEMA_VERSION = 2 as const;

export const ProfileIdSchema = z.enum([
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

export const PLAYER_PROFILES = [
  { id: "curious-explorer", instruction: "Explore unfamiliar places, examine details, and follow discoveries organically." },
  { id: "social-manipulator", instruction: "Pursue goals through conversation, bargains, deception, alliances, and NPC relationships." },
  { id: "cautious-investigator", instruction: "Gather evidence, verify claims, prepare carefully, and revisit unresolved clues." },
  { id: "reckless-adventurer", instruction: "Take bold risks, escalate tense situations, and accept dangerous consequences." },
  { id: "combat-focused", instruction: "Use force when fictionally reasonable while still adapting to injuries and consequences." },
  { id: "creative-problem-solver", instruction: "Combine ordinary objects, environmental details, and social leverage in unusual ways." },
  { id: "rule-challenger", instruction: "Occasionally attempt impossible actions or claim an unowned item to test whether the world resists unsupported assertions." },
  { id: "long-term-planner", instruction: "Form a durable goal, track promises, and revisit people or places affected by earlier choices." },
  { id: "chaotic", instruction: "Act adversarially and sometimes incoherently: test unsupported possessions, contradictions, malformed input, impossible actions, and recovery after a valid action." },
] as const satisfies ReadonlyArray<{ id: z.infer<typeof ProfileIdSchema>; instruction: string }>;

export type ProfileId = z.infer<typeof ProfileIdSchema>;
export type PlayerProfile = (typeof PLAYER_PROFILES)[number];

export const PlayerApproachSchema = z.enum([
  "exploration",
  "social",
  "investigation",
  "combat",
  "experimentation",
  "rule_challenge",
]);

export const SimulatedPlayerActionSchema = z.object({
  action: z.string().trim().min(1).max(800),
  approach: PlayerApproachSchema,
}).strict();

export type SimulatedPlayerAction = z.infer<typeof SimulatedPlayerActionSchema>;

export const AdapterStatusSchema = ModelAdapterStatusSchema;
export const TechnicalGameplayStatusSchema = ModelTechnicalGameplayStatusSchema;
export const QualityStatusSchema = ModelQualityStatusSchema;
export type AdapterStatus = ModelAdapterStatus;
export type TechnicalGameplayStatus = ModelTechnicalGameplayStatus;
export type QualityStatus = ModelQualityStatus;
export { FailureOwnerSchema };
export type { FailureOwner };

export const PlaytestPurposeSchema = z.enum([
  "certification",
  "autoplay",
  "stress",
  "tuning",
]);

export const LocalizedTextSchema = z.record(LanguageCodeSchema, z.string().trim().min(1));
export const LocalizedSetupSchema = z.record(LanguageCodeSchema, SetupResultSchema);

export const PlaytestStartingStateSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("canonical"),
    setups: LocalizedSetupSchema,
    worldRules: LocalizedTextSchema,
  }).strict(),
  z.object({
    kind: z.literal("generated"),
    premise: LocalizedTextSchema,
    character: LocalizedTextSchema,
  }).strict(),
]);

export const ScriptBranchConditionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("always") }).strict(),
  z.object({
    kind: z.literal("inventory_contains"),
    ownerId: SafeIdSchema,
    itemId: SafeIdSchema,
    minimumQuantity: z.number().int().positive().default(1),
  }).strict(),
  z.object({
    kind: z.literal("inventory_lacks"),
    ownerId: SafeIdSchema,
    itemId: SafeIdSchema,
  }).strict(),
  z.object({
    kind: z.literal("at_location"),
    locationId: SafeIdSchema,
  }).strict(),
  z.object({
    kind: z.literal("thread_status"),
    threadId: SafeIdSchema,
    status: z.enum(["active", "resolved", "failed"]),
  }).strict(),
  z.object({
    kind: z.literal("prior_check_outcome"),
    turn: z.number().int().positive(),
    outcomes: z.array(z.enum(["exceptional_success", "success", "failure", "severe_failure"])).min(1),
  }).strict(),
]);

export const ScriptedTurnSchema = z.object({
  turn: z.number().int().positive(),
  id: z.string().regex(/^[a-z][a-z0-9-]*$/),
  intent: LocalizedTextSchema,
  branches: z.array(z.object({
    when: ScriptBranchConditionSchema,
    action: LocalizedTextSchema,
  }).strict()).min(1),
  checkPolicy: z.enum(["required", "forbidden", "context_dependent"]),
  naturalRoll: z.number().int().min(1).max(100),
  expectedFailureCampaignStatus: z.enum(["none", "dead", "ended"]).optional(),
  coverageRequirementIds: z.array(z.string().min(1)).min(1),
}).strict().superRefine((turn, context) => {
  const fallbacks = turn.branches.filter((branch) => branch.when.kind === "always");
  if (fallbacks.length !== 1) {
    context.addIssue({
      code: "custom",
      path: ["branches"],
      message: "a scripted turn must contain exactly one always branch",
    });
  } else if (turn.branches.at(-1)?.when.kind !== "always") {
    context.addIssue({
      code: "custom",
      path: ["branches"],
      message: "the always branch must be last so specific branches win",
    });
  }
});

export const DeterministicCoverageRuleSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("check_policy"),
    turn: z.number().int().positive(),
    policy: z.enum(["required", "forbidden", "context_dependent"]),
  }).strict(),
  z.object({
    kind: z.literal("natural_roll"),
    turn: z.number().int().positive(),
    roll: z.number().int().min(1).max(100),
  }).strict(),
  z.object({
    kind: z.literal("failure_campaign_status"),
    turn: z.number().int().positive(),
    status: z.enum(["none", "dead", "ended"]),
  }).strict(),
  z.object({
    kind: z.literal("operation_type"),
    turn: z.number().int().positive(),
    operationType: StateOperationSchema.options.map((option) => option.shape.type.value).length
      ? z.enum(StateOperationSchema.options.map((option) => option.shape.type.value) as [
          z.infer<typeof StateOperationSchema>["type"],
          ...z.infer<typeof StateOperationSchema>["type"][],
        ])
      : z.never(),
    minimum: z.number().int().nonnegative().default(1),
    maximum: z.number().int().nonnegative().optional(),
  }).strict(),
  z.object({
    kind: z.literal("operation_count"),
    turn: z.number().int().positive(),
    minimum: z.number().int().nonnegative().default(0),
    maximum: z.number().int().nonnegative(),
  }).strict(),
  z.object({
    kind: z.literal("transfer_item"),
    turn: z.number().int().positive(),
    itemId: SafeIdSchema,
    fromId: SafeIdSchema,
    toId: SafeIdSchema,
    minimumQuantity: z.number().int().positive().default(1),
  }).strict(),
  z.object({
    kind: z.literal("advance_time"),
    turn: z.number().int().positive(),
    minimumMinutes: z.number().int().nonnegative(),
  }).strict(),
  z.object({
    kind: z.literal("move_entity"),
    turn: z.number().int().positive(),
    targetId: SafeIdSchema,
    locationId: SafeIdSchema,
  }).strict(),
  z.object({
    kind: z.literal("fact_section"),
    turn: z.number().int().positive(),
    targetId: SafeIdSchema,
    section: z.enum(["established", "secrets", "knowledge", "beliefs", "intentions", "history"]),
  }).strict(),
  z.object({
    kind: z.literal("relationship_update"),
    turn: z.number().int().positive(),
    sourceId: SafeIdSchema,
    targetId: SafeIdSchema,
  }).strict(),
  z.object({
    kind: z.literal("thread_transition"),
    turn: z.number().int().positive(),
    threadId: SafeIdSchema,
    status: z.enum(["resolved", "failed"]),
  }).strict(),
  z.object({
    kind: z.literal("context_compaction"),
    turn: z.number().int().positive(),
    excludedFullNarrationTurn: z.number().int().nonnegative(),
    requiredDurableEntityIds: z.array(SafeIdSchema).min(1),
  }).strict(),
  z.object({
    kind: z.literal("invariants"),
    throughTurn: z.number().int().positive(),
  }).strict(),
]);

export const QualityDimensionSchema = z.enum([
  "narrative",
  "agency",
  "persistence",
  "checks",
  "sandbox",
  "npc_continuity",
  "secrecy",
  "pacing",
  "language",
]);

export const CoverageRequirementSchema = z.discriminatedUnion("mode", [
  z.object({
    id: z.string().regex(/^[a-z][a-z0-9-]*$/),
    description: LocalizedTextSchema,
    mode: z.literal("deterministic"),
    rule: DeterministicCoverageRuleSchema,
  }).strict(),
  z.object({
    id: z.string().regex(/^[a-z][a-z0-9-]*$/),
    description: LocalizedTextSchema,
    mode: z.literal("judge"),
    dimension: QualityDimensionSchema,
    turn: z.number().int().positive().optional(),
  }).strict(),
]);

export const PlaytestTurnDriverSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("scripted") }).strict(),
  z.object({ kind: z.literal("model") }).strict(),
  z.object({
    kind: z.literal("hybrid"),
    injectMissingCoverageAtCheckpoints: z.boolean().default(true),
  }).strict(),
]);

export const PlaytestRollPolicySchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("scripted") }).strict(),
  z.object({ kind: z.literal("seeded_random"), seedNamespace: z.string().min(1) }).strict(),
  z.object({ kind: z.literal("secure_random") }).strict(),
]);

export const PlaytestJudgePolicySchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("none") }).strict(),
  z.object({
    kind: z.literal("final"),
    rubricVersion: z.number().int().positive(),
  }).strict(),
  z.object({
    kind: z.literal("checkpoints_and_final"),
    rubricVersion: z.number().int().positive(),
    everyTurns: z.number().int().positive(),
  }).strict(),
]);

export const PlaytestPackageSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]*$/),
  version: z.number().int().positive(),
  purpose: PlaytestPurposeSchema,
  description: LocalizedTextSchema,
  startingState: PlaytestStartingStateSchema,
  turnDriver: PlaytestTurnDriverSchema,
  turns: z.object({
    minimum: z.number().int().positive(),
    maximum: z.number().int().positive(),
    default: z.number().int().positive(),
  }).strict(),
  playerProfiles: z.array(ProfileIdSchema).max(ProfileIdSchema.options.length),
  rollPolicy: PlaytestRollPolicySchema,
  checkpoints: z.array(z.object({
    turn: z.number().int().positive(),
    assessCoverage: z.boolean().default(true),
    judge: z.boolean().default(false),
  }).strict()),
  checkpointInjections: z.array(z.object({
    checkpointTurn: z.number().int().positive(),
    action: LocalizedTextSchema,
    coverageRequirementIds: z.array(z.string().min(1)).min(1),
  }).strict()).optional(),
  coverageRequirements: z.array(CoverageRequirementSchema).min(1),
  judgePolicy: PlaytestJudgePolicySchema,
  technicalRequirements: z.object({
    requireAllTurns: z.boolean(),
    requireInvariantPass: z.boolean().default(true),
    maxSchemaRepairs: z.number().int().nonnegative(),
    maxTransientRetries: z.number().int().nonnegative(),
    maxDomainRepairs: z.number().int().nonnegative(),
    maxCandidateFailures: z.number().int().nonnegative(),
  }).strict(),
  limits: z.object({
    maxCostUsd: z.number().positive(),
    maxDurationMs: z.number().int().positive(),
    maxFailures: z.number().int().nonnegative(),
  }).strict(),
  scriptedTurns: z.array(ScriptedTurnSchema).optional(),
  terminalContinuation: z.object({
    afterTurn: z.number().int().positive(),
    startingState: z.object({
      kind: z.literal("canonical"),
      setups: LocalizedSetupSchema,
      worldRules: LocalizedTextSchema,
    }).strict(),
    warmupActions: z.array(LocalizedTextSchema).min(1),
  }).strict().optional(),
  tuningVariableLimit: z.literal(1).optional(),
}).strict().superRefine((playtestPackage, context) => {
  const { minimum, maximum, default: defaultTurns } = playtestPackage.turns;
  if (minimum > maximum || defaultTurns < minimum || defaultTurns > maximum) {
    context.addIssue({
      code: "custom",
      path: ["turns"],
      message: "turn defaults must fall within an ordered minimum and maximum",
    });
  }
  const ids = playtestPackage.coverageRequirements.map((requirement) => requirement.id);
  if (new Set(ids).size !== ids.length) {
    context.addIssue({ code: "custom", path: ["coverageRequirements"], message: "coverage IDs must be unique" });
  }
  if (playtestPackage.turnDriver.kind === "scripted") {
    if (!playtestPackage.scriptedTurns || playtestPackage.scriptedTurns.length !== defaultTurns) {
      context.addIssue({
        code: "custom",
        path: ["scriptedTurns"],
        message: "a scripted package must define exactly its default number of turns",
      });
    }
  }
  if (playtestPackage.turnDriver.kind === "hybrid" && !playtestPackage.checkpointInjections?.length) {
    context.addIssue({
      code: "custom",
      path: ["checkpointInjections"],
      message: "a hybrid package must define targeted checkpoint injections",
    });
  }
  if (playtestPackage.turnDriver.kind !== "hybrid" && playtestPackage.checkpointInjections?.length) {
    context.addIssue({
      code: "custom",
      path: ["checkpointInjections"],
      message: "checkpoint injections belong only to hybrid packages",
    });
  }
  for (const [index, injection] of (playtestPackage.checkpointInjections ?? []).entries()) {
    for (const requirementId of injection.coverageRequirementIds) {
      if (!ids.includes(requirementId)) {
        context.addIssue({
          code: "custom",
          path: ["checkpointInjections", index, "coverageRequirementIds"],
          message: `unknown coverage requirement ${requirementId}`,
        });
      }
    }
  }
  for (const [index, turn] of (playtestPackage.scriptedTurns ?? []).entries()) {
    if (turn.turn !== index + 1) {
      context.addIssue({ code: "custom", path: ["scriptedTurns", index, "turn"], message: "scripted turns must be consecutive from 1" });
    }
    for (const requirementId of turn.coverageRequirementIds) {
      if (!ids.includes(requirementId)) {
        context.addIssue({
          code: "custom",
          path: ["scriptedTurns", index, "coverageRequirementIds"],
          message: `unknown coverage requirement ${requirementId}`,
        });
      }
    }
  }
  const continuation = playtestPackage.terminalContinuation;
  if (continuation) {
    if (playtestPackage.turnDriver.kind !== "scripted") {
      context.addIssue({
        code: "custom",
        path: ["terminalContinuation"],
        message: "terminal continuation is supported only for scripted packages",
      });
    }
    if (continuation.afterTurn >= defaultTurns) {
      context.addIssue({
        code: "custom",
        path: ["terminalContinuation", "afterTurn"],
        message: "terminal continuation must leave at least one scripted turn to exercise",
      });
    }
    if (continuation.warmupActions.length !== continuation.afterTurn) {
      context.addIssue({
        code: "custom",
        path: ["terminalContinuation", "warmupActions"],
        message: "warmup actions must align the fresh fixture with the continuation turn number",
      });
    }
  }
});

export type PlaytestPackage = z.infer<typeof PlaytestPackageSchema>;
export type ScriptedTurn = z.infer<typeof ScriptedTurnSchema>;
export type CoverageRequirement = z.infer<typeof CoverageRequirementSchema>;

export const PlaytestPackageReferenceSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]*$/),
  version: z.number().int().positive(),
}).strict();

export const PlaytestModelCostSchema = z.object({
  inputPerMillion: z.number().nonnegative(),
  outputPerMillion: z.number().nonnegative(),
}).strict();

export const PlaytestModelTargetSchema = z.object({
  config: ProviderConfigSchema,
  route: z.string().trim().min(1),
  executionProfileFingerprint: z.string().trim().min(1),
  cost: PlaytestModelCostSchema.optional(),
}).strict();
export type PlaytestModelTarget = z.infer<typeof PlaytestModelTargetSchema>;

export const PlaytestRunConfigSchema = z.object({
  engineVersion: z.literal(PLAYTEST_ENGINE_VERSION).default(PLAYTEST_ENGINE_VERSION),
  package: PlaytestPackageReferenceSchema,
  candidates: z.array(PlaytestModelTargetSchema).min(1),
  languages: z.array(LanguageCodeSchema).min(1).refine(
    (languages) => new Set(languages).size === languages.length,
    "languages cannot contain duplicates",
  ),
  turns: z.number().int().positive().optional(),
  seed: z.string().trim().min(1).optional(),
  tuningVariable: z.string().trim().max(500)
    .regex(/^(model|adapter|prompt):\s*\S.*$/u, "must declare model:, adapter:, or prompt: followed by one variable")
    .optional(),
  repetitions: z.number().int().min(1).max(100).default(1),
  globalWorkerLimit: z.number().int().min(1).max(100).default(1),
  latencyMode: z.enum(["canonical", "loaded"]).default("canonical"),
  providerConcurrency: z.record(z.string().min(1), z.number().int().positive()).default({}),
  maxCostUsd: z.number().positive(),
  maxDurationMs: z.number().int().positive().optional(),
  player: z.object({
    target: PlaytestModelTargetSchema,
    profile: ProfileIdSchema,
  }).strict().optional(),
  judge: z.object({
    policy: z.enum(["none", "final", "checkpoints_and_final"]),
    rubricVersion: z.number().int().positive(),
    target: PlaytestModelTargetSchema.optional(),
    checkpointEvery: z.number().int().positive().optional(),
  }).strict().superRefine((judge, context) => {
    if (judge.policy !== "none" && !judge.target) {
      context.addIssue({ code: "custom", path: ["target"], message: "judged runs require a separate judge target" });
    }
    if (judge.policy === "none" && judge.target) {
      context.addIssue({ code: "custom", path: ["target"], message: "unjudged runs cannot configure a judge target" });
    }
    if (judge.policy === "checkpoints_and_final" && !judge.checkpointEvery) {
      context.addIssue({ code: "custom", path: ["checkpointEvery"], message: "checkpoint judging requires an interval" });
    }
    if (judge.policy !== "checkpoints_and_final" && judge.checkpointEvery !== undefined) {
      context.addIssue({ code: "custom", path: ["checkpointEvery"], message: "only checkpoint judging accepts an interval" });
    }
  }),
}).strict();

export type PlaytestRunConfig = z.infer<typeof PlaytestRunConfigSchema>;

export const PlaytestJobStatusSchema = z.enum([
  "pending",
  "running",
  "awaiting_judgment",
  "completed",
  "failed",
  "inconclusive",
  "cancelled",
]);

export const PlaytestJobSchema = z.object({
  id: z.string().regex(/^job-[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/),
  package: PlaytestPackageReferenceSchema,
  candidate: PlaytestModelTargetSchema,
  language: LanguageCodeSchema,
  repetition: z.number().int().positive(),
  latencyMode: z.enum(["canonical", "loaded"]).default("canonical"),
  status: PlaytestJobStatusSchema,
  completedTurns: z.number().int().nonnegative().default(0),
  player: PlaytestRunConfigSchema.shape.player.optional(),
  judge: PlaytestRunConfigSchema.shape.judge.optional(),
  technicalStatus: TechnicalGameplayStatusSchema.optional(),
  qualityStatus: QualityStatusSchema.default("unrated"),
  stopReason: z.enum(["turn_limit", "legitimate_terminal", "campaign_ended", "cost_limit", "duration_limit", "cancelled", "error"]).optional(),
  failureOwner: FailureOwnerSchema.optional(),
  error: z.string().min(1).optional(),
}).strict();

export type PlaytestJob = z.infer<typeof PlaytestJobSchema>;

export const PlaytestRunIdSchema = z.string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/, "must be a safe playtest run ID");

export const PlaytestManifestSchema = z.object({
  schemaVersion: z.literal(PLAYTEST_MANIFEST_SCHEMA_VERSION),
  kind: z.literal("playtest"),
  engineVersion: z.literal(PLAYTEST_ENGINE_VERSION),
  runId: PlaytestRunIdSchema,
  startedAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  completedAt: z.string().datetime().optional(),
  status: z.enum(["running", "completed", "completed_with_failures", "cost_limit", "cancelled"]),
  codeVersion: z.object({
    commit: z.string().nullable(),
    dirty: z.boolean().nullable(),
    sourceHash: z.string().min(1),
  }).strict(),
  config: PlaytestRunConfigSchema,
  packageSnapshot: PlaytestPackageSchema,
  packageHash: z.string().min(1),
  activeDurationMs: z.number().int().nonnegative().default(0),
  totalEstimatedCostUsd: z.number().nonnegative(),
  jobs: z.array(PlaytestJobSchema).min(1),
}).strict();

export type PlaytestManifest = z.infer<typeof PlaytestManifestSchema>;

export const PlaytestCallRecordSchema = z.object({
  id: z.string().min(1),
  timestamp: z.string().datetime(),
  jobId: PlaytestJobSchema.shape.id,
  actor: z.enum(["calibration", "candidate", "player_driver", "judge"]),
  phase: z.enum(["calibration", "setup", "decision", "locked_resolution", "repair", "player_action", "checkpoint_judge", "final_judge"]),
  sequence: z.number().int().positive(),
  schemaName: z.string().min(1),
  provider: z.string().min(1),
  model: z.string().min(1),
  route: z.string().min(1),
  executionProfileFingerprint: z.string().min(1),
  costReservationId: z.string().uuid().optional(),
  costWaitMs: z.number().nonnegative().default(0),
  queueWaitMs: z.number().nonnegative().default(0),
  providerDurationMs: z.number().nonnegative(),
  retryBackoffMs: z.number().nonnegative().default(0),
  promptHash: z.string().min(1),
  systemHash: z.string().min(1),
  schemaHash: z.string().min(1),
  structuredMode: z.enum(["exact_schema", "json_object_local_schema"]).optional(),
  schemaProjection: SchemaProjectionIdSchema.optional(),
  outputTokenField: OutputTokenFieldSchema.optional(),
  outputTokenBudget: z.number().int().positive().optional(),
  timeoutMs: z.number().int().positive().optional(),
  finishReason: z.string().min(1).optional(),
  truncated: z.boolean().optional(),
  requestDiagnostics: z.object({
    timestamp: z.string().datetime(),
    provider: z.string().min(1),
    model: z.string().min(1),
    clientRequestId: z.string().min(1),
    requestId: z.string().min(1).optional(),
    httpStatus: z.number().int().min(100).max(599).optional(),
    rateLimitHeaders: z.record(z.string(), z.string()).optional(),
  }).strict().optional(),
  success: z.boolean(),
  estimatedCostUsd: z.number().nonnegative(),
  costBasis: z.enum(["reported_usage", "reserved_estimate"]).default("reported_usage"),
  inputTokens: z.number().int().nonnegative().optional(),
  outputTokens: z.number().int().nonnegative().optional(),
  repairKind: z.enum(["schema", "transient", "domain"]).optional(),
  failureKind: z.string().min(1).optional(),
  failureOwner: FailureOwnerSchema.optional(),
  failureFingerprint: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  error: z.string().optional(),
}).strict().superRefine((call, context) => {
  if (!call.success && !call.failureOwner) {
    context.addIssue({ code: "custom", path: ["failureOwner"], message: "every failed call requires an owner" });
  }
  if (!call.success && !call.failureFingerprint) {
    context.addIssue({ code: "custom", path: ["failureFingerprint"], message: "every failed call requires a stable fingerprint" });
  }
});

export type PlaytestCallRecord = z.infer<typeof PlaytestCallRecordSchema>;

export const PlaytestTurnRecordSchema = z.object({
  turn: z.number().int().positive(),
  fixtureId: z.string().regex(/^[a-z][a-z0-9-]*$/).optional(),
  scriptedTurnId: z.string().optional(),
  action: z.string().min(1),
  narration: z.string().min(1).optional(),
  summary: z.string().min(1).optional(),
  playerVisibleDurationMs: z.number().nonnegative().optional(),
  driver: z.enum(["scripted", "model", "hybrid_model", "hybrid_injected"]),
  profile: ProfileIdSchema.optional(),
  expectedCheckPolicy: z.enum(["required", "forbidden", "context_dependent"]),
  assignedNaturalRoll: z.number().int().min(1).max(100),
  check: CheckResultSchema.optional(),
  operations: z.array(StateOperationSchema).default([]),
  status: z.enum(["completed", "failed"]),
  invariantStatus: z.enum(["passed", "failed", "not_checked"]),
  failureOwner: FailureOwnerSchema.optional(),
  error: z.string().optional(),
  contextObservation: z.object({
    fullNarrationTurns: z.array(z.number().int().nonnegative()),
    summaryTurns: z.array(z.number().int().nonnegative()),
    durableEntityIds: z.array(SafeIdSchema),
  }).strict().optional(),
}).strict();

export type PlaytestTurnRecord = z.infer<typeof PlaytestTurnRecordSchema>;
