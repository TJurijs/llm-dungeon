import { z } from "zod";
import { DEFAULT_LANGUAGE, LanguageCodeSchema } from "./language.js";
import { UsageSchema } from "./usage.js";

export const COMPLETED_STORY_SCHEMA_VERSION = 1 as const;
export const COMPLETED_STORY_MIN_WORDS = 400;
export const COMPLETED_STORY_MAX_WORDS = 600;
export const COMPLETED_STORY_TARGET_WORDS = 500;
export const COMPLETED_STORY_TARGET_MIN_WORDS = 450;
export const COMPLETED_STORY_TARGET_MAX_WORDS = 550;

/**
 * The completed-story contract currently supports English and Russian, whose
 * prose is deterministically countable by Unicode whitespace-delimited words.
 */
export function completedStoryWordCount(value: string): number {
  const trimmed = value.trim();
  return trimmed ? trimmed.split(/\s+/u).length : 0;
}

const CompletedStoryTextSchema = z
  .string()
  .trim()
  .min(1)
  .superRefine((story, context) => {
    const words = completedStoryWordCount(story);
    if (words < COMPLETED_STORY_MIN_WORDS || words > COMPLETED_STORY_MAX_WORDS) {
      context.addIssue({
        code: "custom",
        message: `completed story must contain ${COMPLETED_STORY_MIN_WORDS}-${COMPLETED_STORY_MAX_WORDS} words; received ${words}`,
      });
    }
  })
  .describe(
    `A retrospective campaign story whose accepted length is ${COMPLETED_STORY_MIN_WORDS}-${COMPLETED_STORY_MAX_WORDS} whitespace-delimited words. Write one direct draft of about ${COMPLETED_STORY_TARGET_WORDS} words, targeting ${COMPLETED_STORY_TARGET_MIN_WORDS}-${COMPLETED_STORY_TARGET_MAX_WORDS} words as a safety margin.`,
  );

/** Strict provider response for the separate post-completion artifact lane. */
export const CompletedStoryOutputSchema = z
  .object({
    story: CompletedStoryTextSchema,
  })
  .strict();

export const SafeIdSchema = z
  .string()
  .regex(/^[a-z][a-z0-9_-]*:[a-z0-9][a-z0-9_-]*$/, "must be a safe namespaced id")
  .describe(
    "A non-empty lowercase namespaced ID such as npc:mara-venn or location:crooked-crown; it must match ^[a-z][a-z0-9_-]*:[a-z0-9][a-z0-9_-]*$",
  );

const GeneratedIdHintSchema = z
  .string()
  .optional()
  .default("generated:auto")
  .describe(
    "Optional human-readable ID hint. The application always replaces this value with a unique safe namespaced ID.",
  );

const ReferenceIdHintSchema = z
  .string()
  .trim()
  .min(1)
  .describe(
    "An existing state ID. The namespace may be omitted only when the application can restore it from one exact, unique, type-compatible match.",
  );

export const FactSectionSchema = z.enum([
  "established",
  "secrets",
  "knowledge",
  "beliefs",
  "intentions",
  "history",
]);

export const EntityKindSchema = z.enum([
  "person",
  "location",
  "item",
  "faction",
  "creature",
  "event",
  "other",
]);

export const InventoryEntrySchema = z.object({
  entityId: SafeIdSchema,
  quantity: z.number().int().positive(),
});

/**
 * How a proposition came to be known.
 *
 * Without this, "a trace suggests X" and "X is proven" are the same durable
 * record, so evidence overreach is invisible to code, to inspection, and to
 * judging. Optional so legacy Markdown facts stay readable.
 */
export const FactBasisSchema = z.enum([
  "observed",
  "reported",
  "inferred",
  "recorded",
  "established",
]);

export const FactSchema = z
  .object({
    id: SafeIdSchema,
    section: FactSectionSchema,
    text: z.string().min(1),
    active: z.boolean().default(true),
    /** Application-owned lifecycle metadata; absent only on legacy Markdown facts. */
    createdTurn: z.number().int().nonnegative().optional(),
    supersededTurn: z.number().int().nonnegative().optional(),
    basis: FactBasisSchema.optional(),
    /** The record the evidence came from; required for reported and inferred. */
    sourceId: SafeIdSchema.optional(),
  })
  .superRefine((fact, context) => {
    if (fact.active && fact.supersededTurn !== undefined) {
      context.addIssue({ code: "custom", message: "an active fact cannot have supersededTurn" });
    }
    if (
      fact.createdTurn !== undefined &&
      fact.supersededTurn !== undefined &&
      fact.supersededTurn < fact.createdTurn
    ) {
      context.addIssue({
        code: "custom",
        message: "supersededTurn cannot precede createdTurn",
      });
    }
  });

export const RelationshipSchema = z.object({
  targetId: SafeIdSchema,
  summary: z.string().min(1),
});

const TraitSchema = z.string().min(1);

export const EntitySchema = z.object({
  id: SafeIdSchema,
  kind: EntityKindSchema,
  name: z.string().min(1),
  status: z.string().min(1).default("active"),
  location: SafeIdSchema.optional(),
  tags: z.array(z.string().min(1)).default([]),
  updatedTurn: z.number().int().nonnegative(),
  description: z
    .string()
    .describe(
      "Stable enduring appearance or nature only; never current placement, ownership, activity, mood, or temporary condition.",
    )
    .default(""),
  traits: z.array(TraitSchema).default([]),
  conditions: z.array(z.string().min(1)).default([]),
  inventory: z.array(InventoryEntrySchema).default([]),
  facts: z.array(FactSchema).default([]),
  relationships: z.array(RelationshipSchema).default([]),
});

export const ThreadSchema = z.object({
  id: SafeIdSchema,
  title: z.string().min(1),
  /** Immutable initial problem/goal; absent only in legacy Markdown until read migration. */
  objective: z.string().min(1).optional(),
  /** Application-owned lifecycle turns; optional only for legacy Markdown. */
  createdTurn: z.number().int().nonnegative().optional(),
  updatedTurn: z.number().int().nonnegative().optional(),
  closedTurn: z.number().int().nonnegative().optional(),
  summary: z.string().min(1),
  status: z.enum(["active", "resolved", "failed"]),
  relatedEntityIds: z.array(SafeIdSchema).default([]),
});

export const ChronicleEventSchema = z.object({
  id: SafeIdSchema,
  text: z.string().min(1),
  turn: z.number().int().nonnegative(),
});

export const ManifestSchema = z.object({
  schemaVersion: z.literal(1),
  campaignId: SafeIdSchema,
  title: z.string().min(1),
  turn: z.number().int().nonnegative(),
  status: z.enum(["active", "dead", "ended"]),
  playerId: SafeIdSchema,
  currentLocationId: SafeIdSchema,
  elapsedMinutes: z.number().int().nonnegative(),
  timeLabel: z.string().min(1),
  language: LanguageCodeSchema.default(DEFAULT_LANGUAGE),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

/**
 * Independently persisted, player-safe prose generated from one immutable
 * campaign snapshot after gameplay has settled.
 */
export const CompletedStoryArtifactSchema = z
  .object({
    schemaVersion: z.literal(COMPLETED_STORY_SCHEMA_VERSION),
    campaignId: SafeIdSchema,
    sourceRevision: z.string().trim().min(1).max(200),
    sourceTurn: z.number().int().nonnegative(),
    campaignStatus: ManifestSchema.shape.status,
    provider: z.string().trim().min(1).max(200),
    model: z.string().trim().min(1).max(500),
    generatedAt: z.string().datetime(),
    usage: UsageSchema.optional(),
    story: CompletedStoryTextSchema,
  })
  .strict();

const CreateEntityOperationSchema = z.object({
  type: z.literal("create_entity"),
  entity: z.object({
    id: SafeIdSchema,
    kind: EntityKindSchema,
    name: z.string().min(1),
    status: z.string().min(1).default("active"),
    location: ReferenceIdHintSchema.optional(),
    tags: z.array(z.string().min(1)).default([]),
    description: z.string().default(""),
    establishedFacts: z.array(z.string().min(1)).default([]),
    secrets: z.array(z.string().min(1)).default([]),
    playerKnowledge: z.array(z.string().min(1)).default([]),
  }),
});

const AddFactOperationSchema = z.object({
  type: z.literal("add_fact"),
  targetId: ReferenceIdHintSchema,
  section: FactSectionSchema,
  factId: GeneratedIdHintSchema,
  text: z.string().min(1),
  basis: FactBasisSchema.optional(),
  sourceId: ReferenceIdHintSchema.optional(),
});

const SupersedeFactOperationSchema = z.object({
  type: z.literal("supersede_fact"),
  targetId: ReferenceIdHintSchema,
  factId: ReferenceIdHintSchema,
  replacementFactId: GeneratedIdHintSchema,
  replacementText: z.string().min(1),
});

const SetEntityStateOperationSchema = z.object({
  type: z.literal("set_entity_state"),
  targetId: ReferenceIdHintSchema,
  name: z.string().min(1).optional(),
  status: z.string().min(1).optional(),
  tags: z.array(z.string().min(1)).optional(),
});

const MoveEntityOperationSchema = z.object({
  type: z.literal("move_entity"),
  targetId: ReferenceIdHintSchema,
  locationId: ReferenceIdHintSchema,
});

const ChangeInventoryOperationSchema = z.object({
  type: z.literal("change_inventory"),
  ownerId: ReferenceIdHintSchema,
  itemId: ReferenceIdHintSchema,
  quantityDelta: z
    .number()
    .int()
    .refine((value) => value !== 0),
});

const TransferItemOperationSchema = z.object({
  type: z.literal("transfer_item"),
  fromId: ReferenceIdHintSchema,
  toId: ReferenceIdHintSchema,
  itemId: ReferenceIdHintSchema,
  quantity: z.number().int().positive(),
});

const ConditionOperationSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("add_condition"),
    targetId: ReferenceIdHintSchema,
    condition: z.string().min(1),
  }),
  z.object({
    type: z.literal("remove_condition"),
    targetId: ReferenceIdHintSchema,
    condition: z.string().min(1),
  }),
]);

const TraitOperationSchema = z.object({
  type: z.literal("add_trait"),
  targetId: ReferenceIdHintSchema,
  trait: TraitSchema,
});

const RelationshipOperationSchema = z.object({
  type: z.literal("set_relationship"),
  sourceId: ReferenceIdHintSchema,
  targetId: ReferenceIdHintSchema,
  summary: z.string().min(1),
});

const ThreadOperationSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("create_thread"),
    threadId: GeneratedIdHintSchema,
    title: z.string().min(1),
    summary: z.string().min(1),
    relatedEntityIds: z.array(ReferenceIdHintSchema).default([]),
  }),
  z.object({
    type: z.literal("update_thread"),
    threadId: ReferenceIdHintSchema,
    summary: z.string().min(1),
    relatedEntityIds: z.array(ReferenceIdHintSchema).optional(),
  }),
  z.object({
    type: z.literal("resolve_thread"),
    threadId: ReferenceIdHintSchema,
    outcome: z.string().min(1),
    status: z.enum(["resolved", "failed"]),
  }),
]);

const MajorEventOperationSchema = z.object({
  type: z.literal("record_major_event"),
  eventId: GeneratedIdHintSchema,
  text: z.string().min(1),
});

const AdvanceTimeOperationSchema = z.object({
  type: z.literal("advance_time"),
  minutes: z.number().int().nonnegative().max(525_600),
  timeLabel: z.string().min(1),
});

const EndCampaignOperationSchema = z.object({
  type: z.literal("end_campaign"),
  status: z.enum(["dead", "ended"]),
  reason: z.string().min(1),
});

export const StateOperationSchema = z.discriminatedUnion("type", [
  CreateEntityOperationSchema,
  AddFactOperationSchema,
  SupersedeFactOperationSchema,
  SetEntityStateOperationSchema,
  MoveEntityOperationSchema,
  ChangeInventoryOperationSchema,
  TransferItemOperationSchema,
  ...ConditionOperationSchema.options,
  TraitOperationSchema,
  RelationshipOperationSchema,
  ...ThreadOperationSchema.options,
  MajorEventOperationSchema,
  AdvanceTimeOperationSchema,
  EndCampaignOperationSchema,
]);

export const ModifierSchema = z.object({
  label: z.string().min(1).describe("A concrete circumstance affecting this attempt."),
  value: z
    .number()
    .int()
    .min(-30)
    .max(30)
    .describe(
      "Positive values help the acting player character succeed; negative values hinder them. Never reverse this sign convention.",
    ),
});

const CheckSpecInputSchema = z.object({
  name: z.string().min(1),
  difficulty: z.number().int().min(5).max(95),
  modifiers: z.array(ModifierSchema).max(5),
  exceptionalSuccessStakes: z.string().min(1).optional(),
  successStakes: z.string().min(1),
  failureStakes: z.string().min(1),
  severeFailureStakes: z.string().min(1).optional(),
  failureCampaignStatus: z.enum(["none", "dead", "ended"]).default("none"),
});

export const CheckSpecSchema = CheckSpecInputSchema.superRefine((check, ctx) => {
  const total = check.modifiers.reduce((sum, modifier) => sum + modifier.value, 0);
  if (total < -50 || total > 50) {
    ctx.addIssue({ code: "custom", message: "combined modifiers must be between -50 and 50" });
  }
}).transform((check) => ({
  ...check,
  exceptionalSuccessStakes: check.exceptionalSuccessStakes ?? check.successStakes,
  severeFailureStakes: check.severeFailureStakes ?? check.failureStakes,
}));

/**
 * One declared disposition for one active thread.
 *
 * Thread updates were previously optional effects, so silence and "nothing
 * changed" were indistinguishable and omission could not be detected. The
 * audit is a closed set over the active threads: every thread gets an explicit
 * verdict, and the application derives the thread operations from it, which
 * makes a declaration/operation mismatch impossible rather than merely invalid.
 */
export const ThreadAuditEntrySchema = z.object({
  /**
   * 1-based position in the active-thread list supplied in context.
   *
   * An ordinal rather than an ID because reproducing a long generated ID many
   * times per turn is a transcription task with a real error rate: mandatory
   * per-thread ID copying multiplied reference failures roughly eightfold.
   * A number cannot be misspelled.
   */
  threadIndex: z.number().int().positive().max(20),
  verdict: z.enum(["unchanged", "progressed", "resolved", "failed"]),
  /** Rolling summary, closure outcome, or the reason a thread is unchanged. */
  text: z.string().default(""),
  relatedEntityIds: z.array(ReferenceIdHintSchema).optional(),
});

/**
 * The declared end-of-turn scene.
 *
 * Narration routinely moves actors while the effect list does not. Code cannot
 * read narration, but it can require the same generation to state where the
 * scene ended and then reconcile that declaration against authoritative
 * placement deterministically.
 */
export const SceneStateSchema = z.object({
  locationId: ReferenceIdHintSchema,
  /**
   * Actors physically present at the end of the turn. Authoritative inbound
   * only: a declared presence moves an actor here, while omission is a review
   * signal because the destination of a departure is not stated.
   */
  presentActorIds: z.array(ReferenceIdHintSchema).max(20).default([]),
});

export const ResolvedTurnSchema = z.object({
  narration: z.string().min(1),
  turnSummary: z.string().min(1),
  operations: z.array(StateOperationSchema).max(40),
  /**
   * Absent means the turn predates the V2 contract; the wire always supplies
   * it, so a declared-but-empty audit is a coverage violation rather than a
   * silent opt-out.
   */
  threadAudit: z.array(ThreadAuditEntrySchema).max(20).optional(),
  sceneState: SceneStateSchema.optional(),
});

export const TurnDecisionSchema = z.discriminatedUnion("kind", [
  ResolvedTurnSchema.extend({ kind: z.literal("resolved") }),
  ResolvedTurnSchema.extend({
    kind: z.enum(["automatic_success", "automatic_failure"]),
    reason: z.string().min(1),
  }),
  z.object({ kind: z.literal("check_required"), check: CheckSpecSchema }),
]);

export const AutomaticOutcomeSchema = z
  .object({
    outcome: z.enum(["success", "failure"]),
    reason: z.string().min(1),
  })
  .strict();

const InitialEntitySchema = z.object({
  id: SafeIdSchema,
  kind: EntityKindSchema,
  name: z.string().min(1),
  status: z.string().min(1).default("active"),
  location: SafeIdSchema.describe(
    "Optional physical containment by a different included location ID. Never use the entity's own ID; omit it for a top-level location; location-parent chains must be acyclic.",
  ).optional(),
  tags: z.array(z.string().min(1)).default([]),
  description: z.string().default(""),
  establishedFacts: z.array(z.string().min(1)).default([]),
  secrets: z.array(z.string().min(1)).default([]),
  playerKnowledge: z.array(z.string().min(1)).default([]),
  traits: z.array(TraitSchema).default([]),
  conditions: z.array(z.string().min(1)).default([]),
  inventory: z.array(InventoryEntrySchema).default([]),
});

const InitialThreadSchema = z.object({
  id: GeneratedIdHintSchema,
  title: z.string().min(1),
  summary: z.string().min(1),
  status: z.enum(["active", "resolved", "failed"]),
  relatedEntityIds: z.array(SafeIdSchema).default([]),
});

/** The player is separate; generated setup may persist at most this many other entities. */
export const SETUP_ENTITY_LIMIT = 20;

export const SetupResultSchema = z.object({
  campaignTitle: z.string().min(1),
  scenarioMarkdown: z.string().min(1),
  openingNarration: z.string().min(1),
  timeLabel: z.string().min(1),
  player: InitialEntitySchema,
  entities: z.array(InitialEntitySchema).min(1).max(SETUP_ENTITY_LIMIT),
  threads: z.array(InitialThreadSchema).max(10).default([]),
});

export const ProviderConfigSchema = z.object({
  provider: z.enum(["openrouter", "xai", "gemini", "openai", "anthropic", "deepseek"]),
  model: z.string().min(1),
  temperature: z.number().min(0).max(2).default(0.8),
  maxOutputTokens: z.number().int().min(256).max(32_000).default(4000),
  endpoint: z.string().url().optional(),
});

export const QuestionAnswerSchema = z
  .object({
    answer: z.string().trim().min(1).max(20_000),
  })
  .strict();

export type Entity = z.infer<typeof EntitySchema>;
export type Fact = z.infer<typeof FactSchema>;
export type FactBasis = z.infer<typeof FactBasisSchema>;
export type ThreadAuditEntry = z.infer<typeof ThreadAuditEntrySchema>;
export type SceneState = z.infer<typeof SceneStateSchema>;
export type Thread = z.infer<typeof ThreadSchema>;
export type ChronicleEvent = z.infer<typeof ChronicleEventSchema>;
export type GameState = z.infer<typeof ManifestSchema>;
export type StateOperation = z.infer<typeof StateOperationSchema>;
export type CheckSpec = z.infer<typeof CheckSpecSchema>;
export type ResolvedTurn = z.infer<typeof ResolvedTurnSchema>;
export type TurnDecision = z.infer<typeof TurnDecisionSchema>;
export type AutomaticOutcome = z.infer<typeof AutomaticOutcomeSchema>;
export type SetupResult = z.infer<typeof SetupResultSchema>;
export type ProviderConfig = z.infer<typeof ProviderConfigSchema>;
export type QuestionAnswer = z.infer<typeof QuestionAnswerSchema>;
export type CompletedStoryOutput = z.infer<typeof CompletedStoryOutputSchema>;
export type CompletedStoryArtifact = z.infer<typeof CompletedStoryArtifactSchema>;
