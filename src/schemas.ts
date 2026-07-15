import { z } from "zod";
import { DEFAULT_LANGUAGE, LanguageCodeSchema } from "./language.js";

export const SafeIdSchema = z
  .string()
  .regex(/^[a-z][a-z0-9_-]*:[a-z0-9][a-z0-9_-]*$/, "must be a safe namespaced id")
  .describe("A non-empty lowercase namespaced ID such as npc:mara-venn or location:crooked-crown; it must match ^[a-z][a-z0-9_-]*:[a-z0-9][a-z0-9_-]*$");

const GeneratedIdHintSchema = z
  .string()
  .optional()
  .default("generated:auto")
  .describe("Optional human-readable ID hint. The application always replaces this value with a unique safe namespaced ID.");

const ReferenceIdHintSchema = z
  .string()
  .trim()
  .min(1)
  .describe("An existing state ID. The namespace may be omitted only when the application can restore it from one exact, unique, type-compatible match.");

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

export const FactSchema = z.object({
  id: SafeIdSchema,
  section: FactSectionSchema,
  text: z.string().min(1),
  active: z.boolean().default(true),
});

export const RelationshipSchema = z.object({
  targetId: SafeIdSchema,
  summary: z.string().min(1),
});

export const EntitySchema = z.object({
  id: SafeIdSchema,
  kind: EntityKindSchema,
  name: z.string().min(1),
  status: z.string().min(1).default("active"),
  location: SafeIdSchema.optional(),
  tags: z.array(z.string().min(1)).default([]),
  updatedTurn: z.number().int().nonnegative(),
  description: z.string()
    .describe("Stable enduring appearance or nature only; never current placement, ownership, activity, mood, or temporary condition.")
    .default(""),
  traits: z.array(z.string().min(1)).default([]),
  conditions: z.array(z.string().min(1)).default([]),
  inventory: z.array(InventoryEntrySchema).default([]),
  facts: z.array(FactSchema).default([]),
  relationships: z.array(RelationshipSchema).default([]),
});

export const ThreadSchema = z.object({
  id: SafeIdSchema,
  title: z.string().min(1),
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
  quantityDelta: z.number().int().refine((value) => value !== 0),
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
  trait: z.string().min(1),
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
  value: z.number().int().min(-30).max(30).describe(
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

export const CheckSpecSchema = CheckSpecInputSchema
  .superRefine((check, ctx) => {
    const total = check.modifiers.reduce((sum, modifier) => sum + modifier.value, 0);
    if (total < -50 || total > 50) {
      ctx.addIssue({ code: "custom", message: "combined modifiers must be between -50 and 50" });
    }
  })
  .transform((check) => ({
    ...check,
    exceptionalSuccessStakes: check.exceptionalSuccessStakes ?? check.successStakes,
    severeFailureStakes: check.severeFailureStakes ?? check.failureStakes,
  }));

export const ResolvedTurnSchema = z.object({
  narration: z.string().min(1),
  turnSummary: z.string().min(1),
  operations: z.array(StateOperationSchema).max(40),
});

export const TurnDecisionSchema = z.discriminatedUnion("kind", [
  ResolvedTurnSchema.extend({ kind: z.literal("resolved") }),
  z.object({ kind: z.literal("check_required"), check: CheckSpecSchema }),
]);

const InitialEntitySchema = z.object({
  id: SafeIdSchema,
  kind: EntityKindSchema,
  name: z.string().min(1),
  status: z.string().min(1).default("active"),
  location: SafeIdSchema
    .describe("Optional physical containment by a different included location ID. Never use the entity's own ID; omit it for a top-level location; location-parent chains must be acyclic.")
    .optional(),
  tags: z.array(z.string().min(1)).default([]),
  description: z.string().default(""),
  establishedFacts: z.array(z.string().min(1)).default([]),
  secrets: z.array(z.string().min(1)).default([]),
  playerKnowledge: z.array(z.string().min(1)).default([]),
  traits: z.array(z.string().min(1)).default([]),
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

export const SetupResultSchema = z.object({
  campaignTitle: z.string().min(1),
  scenarioMarkdown: z.string().min(1),
  openingNarration: z.string().min(1),
  timeLabel: z.string().min(1),
  player: InitialEntitySchema,
  entities: z.array(InitialEntitySchema).min(1).max(20),
  threads: z.array(InitialThreadSchema).max(10).default([]),
});

export const ProviderConfigSchema = z.object({
  provider: z.enum(["openrouter", "gemini"]),
  model: z.string().min(1),
  temperature: z.number().min(0).max(2).default(0.8),
  maxOutputTokens: z.number().int().min(256).max(32_000).default(4000),
  endpoint: z.string().url().optional(),
});

export const QuestionAnswerSchema = z.object({
  answer: z.string().trim().min(1).max(20_000),
}).strict();

export type Entity = z.infer<typeof EntitySchema>;
export type Fact = z.infer<typeof FactSchema>;
export type Thread = z.infer<typeof ThreadSchema>;
export type ChronicleEvent = z.infer<typeof ChronicleEventSchema>;
export type GameState = z.infer<typeof ManifestSchema>;
export type StateOperation = z.infer<typeof StateOperationSchema>;
export type CheckSpec = z.infer<typeof CheckSpecSchema>;
export type ResolvedTurn = z.infer<typeof ResolvedTurnSchema>;
export type TurnDecision = z.infer<typeof TurnDecisionSchema>;
export type SetupResult = z.infer<typeof SetupResultSchema>;
export type ProviderConfig = z.infer<typeof ProviderConfigSchema>;
export type QuestionAnswer = z.infer<typeof QuestionAnswerSchema>;
