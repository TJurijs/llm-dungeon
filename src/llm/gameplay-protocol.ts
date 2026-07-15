import { z } from "zod";
import {
  CheckSpecSchema,
  ResolvedTurnSchema,
  StateOperationSchema,
  TurnDecisionSchema,
  type Entity,
  type Fact,
  type ResolvedTurn,
  type StateOperation,
  type TurnDecision,
} from "../schemas.js";
import type { StructuredRequest } from "../types.js";

export const GAMEPLAY_PROTOCOL_VERSION = 1 as const;

export const GAMEPLAY_SCHEMA_NAMES = {
  decision: "turn_decision_v1",
  resolution: "turn_resolution_v1",
  appealResolution: "appeal_resolution_v1",
  domainCorrection: "domain_repair_turn_resolution_v1",
  appealDomainCorrection: "domain_repair_appeal_resolution_v1",
  connectionProbe: "connection_gameplay_contract_v1",
} as const;

const EffectKindSchema = z.enum([
  "create_entity",
  "add_fact",
  "supersede_fact",
  "set_entity_state",
  "move_entity",
  "change_inventory",
  "transfer_item",
  "add_condition",
  "remove_condition",
  "add_trait",
  "set_relationship",
  "create_thread",
  "update_thread",
  "resolve_thread",
  "record_major_event",
  "advance_time",
  "end_campaign",
]);

const EntityKindCodeSchema = z.number().int().min(0).max(7);
const FactSectionCodeSchema = z.number().int().min(0).max(6);
const LifecycleCodeSchema = z.number().int().min(0).max(4);

const ENTITY_KIND_BY_CODE: Readonly<Record<number, Entity["kind"] | undefined>> = {
  0: undefined,
  1: "person",
  2: "location",
  3: "item",
  4: "faction",
  5: "creature",
  6: "event",
  7: "other",
};

const FACT_SECTION_BY_CODE: Readonly<Record<number, Fact["section"] | undefined>> = {
  0: undefined,
  1: "established",
  2: "secrets",
  3: "knowledge",
  4: "beliefs",
  5: "intentions",
  6: "history",
};

const LIFECYCLE_BY_CODE: Readonly<Record<number, "resolved" | "failed" | "dead" | "ended" | undefined>> = {
  0: undefined,
  1: "resolved",
  2: "failed",
  3: "dead",
  4: "ended",
};

const WireEffectSchema = z.object({
  kind: EffectKindSchema,
  targetId: z.string(),
  relatedId: z.string(),
  itemId: z.string(),
  entityKindCode: EntityKindCodeSchema,
  factSectionCode: FactSectionCodeSchema,
  lifecycleCode: LifecycleCodeSchema,
  name: z.string(),
  status: z.string(),
  text: z.string(),
  quantity: z.number().int(),
  tags: z.array(z.string().min(1)),
  references: z.array(z.string().min(1)),
}).strict();

export const WireTurnSchema = z.object({
  decision: z.enum(["resolved", "check_required"]),
  narration: z.string(),
  effects: z.array(WireEffectSchema).max(40),
  summary: z.string(),
  checkName: z.string(),
  difficulty: z.number().int().min(0).max(95),
  modifiers: z.array(z.object({
    label: z.string().min(1),
    value: z.number().int().min(-30).max(30),
  }).strict()).max(5),
  exceptionalSuccessStakes: z.string(),
  successStakes: z.string(),
  failureStakes: z.string(),
  severeFailureStakes: z.string(),
  failureCampaignStatus: z.enum(["none", "dead", "ended"]),
}).strict();

/** Provider-facing subset for phases where the application already owns the outcome. */
export const WireResolvedTurnSchema = WireTurnSchema.extend({
  decision: z.literal("resolved"),
}).strict();

export type WireTurn = z.infer<typeof WireTurnSchema>;
type WireEffect = z.infer<typeof WireEffectSchema>;

/**
 * The V1 gameplay contract stays shallow enough for both supported providers
 * while keeping every conditional machine vocabulary provider-enforceable.
 */
export const GAMEPLAY_WIRE_JSON_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: [
    "decision", "narration", "effects", "summary", "checkName", "difficulty",
    "modifiers", "exceptionalSuccessStakes", "successStakes", "failureStakes",
    "severeFailureStakes", "failureCampaignStatus",
  ],
  properties: {
    decision: { type: "string", enum: ["resolved", "check_required"] },
    narration: { type: "string" },
    effects: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "kind", "targetId", "relatedId", "itemId", "entityKindCode",
          "factSectionCode", "lifecycleCode", "name", "status", "text",
          "quantity", "tags", "references",
        ],
        properties: {
          kind: { type: "string", enum: EffectKindSchema.options },
          targetId: { type: "string" },
          relatedId: { type: "string" },
          itemId: { type: "string" },
          entityKindCode: { type: "integer", minimum: 0, maximum: 7 },
          factSectionCode: { type: "integer", minimum: 0, maximum: 6 },
          lifecycleCode: { type: "integer", minimum: 0, maximum: 4 },
          name: { type: "string" },
          status: { type: "string" },
          text: {
            type: "string",
            description: "Effect-dependent text. It must be nonempty whenever the selected effect uses text; for advance_time it is the required new end-of-turn time label.",
          },
          quantity: { type: "integer" },
          tags: { type: "array", items: { type: "string" } },
          references: { type: "array", items: { type: "string" } },
        },
      },
    },
    summary: { type: "string" },
    checkName: { type: "string" },
    difficulty: { type: "integer", minimum: 0, maximum: 95 },
    modifiers: {
      type: "array",
      maxItems: 5,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["label", "value"],
        properties: {
          label: { type: "string" },
          value: { type: "integer", minimum: -30, maximum: 30 },
        },
      },
    },
    exceptionalSuccessStakes: { type: "string" },
    successStakes: { type: "string" },
    failureStakes: { type: "string" },
    severeFailureStakes: { type: "string" },
    failureCampaignStatus: { type: "string", enum: ["none", "dead", "ended"] },
  },
};

export const RESOLVED_GAMEPLAY_WIRE_JSON_SCHEMA: Record<string, unknown> = {
  ...GAMEPLAY_WIRE_JSON_SCHEMA,
  properties: {
    ...(GAMEPLAY_WIRE_JSON_SCHEMA.properties as Record<string, unknown>),
    decision: { type: "string", enum: ["resolved"] },
  },
};

export function gameplayRequest<T>(
  request: Omit<StructuredRequest<T>, "wireSchema" | "jsonSchema" | "protocolVersion">,
): StructuredRequest<T> {
  return {
    ...request,
    wireSchema: WireTurnSchema,
    jsonSchema: GAMEPLAY_WIRE_JSON_SCHEMA,
    protocolVersion: GAMEPLAY_PROTOCOL_VERSION,
  };
}

export function resolvedGameplayRequest<T>(
  request: Omit<StructuredRequest<T>, "wireSchema" | "jsonSchema" | "protocolVersion">,
): StructuredRequest<T> {
  return {
    ...request,
    wireSchema: WireResolvedTurnSchema,
    jsonSchema: RESOLVED_GAMEPLAY_WIRE_JSON_SCHEMA,
    protocolVersion: GAMEPLAY_PROTOCOL_VERSION,
  };
}

export class ProtocolDecodeError extends Error {
  readonly code = "domain_decode_violation" as const;

  constructor(message: string, readonly path: string) {
    super(`${path}: ${message}`);
    this.name = "ProtocolDecodeError";
  }
}

function required<T>(value: T, path: string): T {
  if (typeof value === "string" && value.length === 0) {
    throw new ProtocolDecodeError("field is required for this effect", path);
  }
  return value;
}

function requiredCode<T>(mapping: Readonly<Record<number, T | undefined>>, code: number, path: string): T {
  const value = mapping[code];
  if (value === undefined) throw new ProtocolDecodeError("a nonzero machine code is required for this effect", path);
  return value;
}

const UNCHANGED = "$unchanged";

function optionalList(values: string[], path: string): string[] | undefined {
  if (values.length === 1 && values[0] === UNCHANGED) return undefined;
  if (values.includes(UNCHANGED)) throw new ProtocolDecodeError(`${UNCHANGED} must be the only list value`, path);
  return values;
}

function decodeEffect(effect: WireEffect, index: number): StateOperation {
  const at = (field: string) => `effects[${index}].${field}`;
  const targetId = () => required(effect.targetId, at("targetId"));
  const relatedId = () => required(effect.relatedId, at("relatedId"));
  const itemId = () => required(effect.itemId, at("itemId"));
  const text = () => required(effect.text, at("text"));
  const quantity = () => required(effect.quantity, at("quantity"));

  switch (effect.kind) {
    case "create_entity":
      return StateOperationSchema.parse({
        type: "create_entity",
        entity: {
          id: targetId(),
          kind: requiredCode(ENTITY_KIND_BY_CODE, effect.entityKindCode, at("entityKindCode")),
          name: required(effect.name, at("name")),
          status: effect.status || "active",
          ...(effect.relatedId === "" ? {} : { location: effect.relatedId }),
          tags: effect.tags,
          description: effect.text,
          establishedFacts: [],
          secrets: [],
          playerKnowledge: [],
        },
      });
    case "add_fact":
      return StateOperationSchema.parse({
        type: "add_fact",
        targetId: targetId(),
        section: requiredCode(FACT_SECTION_BY_CODE, effect.factSectionCode, at("factSectionCode")),
        text: text(),
      });
    case "supersede_fact":
      return StateOperationSchema.parse({
        type: "supersede_fact", targetId: targetId(), factId: relatedId(), replacementText: text(),
      });
    case "set_entity_state": {
      const tags = optionalList(effect.tags, at("tags"));
      if (effect.name === "" && effect.status === "" && tags === undefined) {
        throw new ProtocolDecodeError("at least one of name, status, or tags is required", at("kind"));
      }
      return StateOperationSchema.parse({
        type: "set_entity_state", targetId: targetId(),
        ...(effect.name === "" ? {} : { name: effect.name }),
        ...(effect.status === "" ? {} : { status: effect.status }),
        ...(tags === undefined ? {} : { tags }),
      });
    }
    case "move_entity":
      return StateOperationSchema.parse({ type: "move_entity", targetId: targetId(), locationId: relatedId() });
    case "change_inventory":
      return StateOperationSchema.parse({ type: "change_inventory", ownerId: targetId(), itemId: itemId(), quantityDelta: quantity() });
    case "transfer_item":
      return StateOperationSchema.parse({ type: "transfer_item", fromId: targetId(), toId: relatedId(), itemId: itemId(), quantity: quantity() });
    case "add_condition":
    case "remove_condition":
      return StateOperationSchema.parse({ type: effect.kind, targetId: targetId(), condition: text() });
    case "add_trait":
      return StateOperationSchema.parse({ type: "add_trait", targetId: targetId(), trait: text() });
    case "set_relationship":
      return StateOperationSchema.parse({ type: "set_relationship", sourceId: targetId(), targetId: relatedId(), summary: text() });
    case "create_thread":
      return StateOperationSchema.parse({
        type: "create_thread", threadId: effect.targetId || undefined,
        title: required(effect.name, at("name")), summary: text(), relatedEntityIds: effect.references,
      });
    case "update_thread": {
      const references = optionalList(effect.references, at("references"));
      return StateOperationSchema.parse({
        type: "update_thread", threadId: targetId(), summary: text(),
        ...(references === undefined ? {} : { relatedEntityIds: references }),
      });
    }
    case "resolve_thread": {
      const status = requiredCode(LIFECYCLE_BY_CODE, effect.lifecycleCode, at("lifecycleCode"));
      if (status !== "resolved" && status !== "failed") {
        throw new ProtocolDecodeError("must be 1 (resolved) or 2 (failed)", at("lifecycleCode"));
      }
      return StateOperationSchema.parse({ type: "resolve_thread", threadId: targetId(), outcome: text(), status });
    }
    case "record_major_event":
      return StateOperationSchema.parse({ type: "record_major_event", text: text() });
    case "advance_time":
      return StateOperationSchema.parse({ type: "advance_time", minutes: quantity(), timeLabel: text() });
    case "end_campaign": {
      const status = requiredCode(LIFECYCLE_BY_CODE, effect.lifecycleCode, at("lifecycleCode"));
      if (status !== "dead" && status !== "ended") {
        throw new ProtocolDecodeError("must be 3 (dead) or 4 (ended)", at("lifecycleCode"));
      }
      return StateOperationSchema.parse({ type: "end_campaign", status, reason: text() });
    }
  }
}

function assertResolvedShape(wire: WireTurn): void {
  if (!wire.narration) throw new ProtocolDecodeError("required when decision=resolved", "narration");
  if (!wire.summary) throw new ProtocolDecodeError("required when decision=resolved", "summary");
  if (wire.checkName !== "" || wire.difficulty !== 0 || wire.modifiers.length
    || wire.exceptionalSuccessStakes !== "" || wire.successStakes !== ""
    || wire.failureStakes !== "" || wire.severeFailureStakes !== ""
    || wire.failureCampaignStatus !== "none") {
    throw new ProtocolDecodeError("check strings must be empty, difficulty 0, modifiers empty, and failureCampaignStatus none when decision=resolved", "decision");
  }
}

export function decodeTurnDecision(input: unknown): TurnDecision {
  const wire = WireTurnSchema.parse(input);
  if (wire.decision === "resolved") {
    assertResolvedShape(wire);
    return TurnDecisionSchema.parse({
      kind: "resolved",
      narration: wire.narration,
      turnSummary: wire.summary,
      operations: wire.effects.map(decodeEffect),
    });
  }
  if (wire.narration !== "" || wire.summary !== "" || wire.effects.length) {
    throw new ProtocolDecodeError("narration and summary must be empty and effects absent when a check is requested", "decision");
  }
  return TurnDecisionSchema.parse({
    kind: "check_required",
    check: CheckSpecSchema.parse({
      name: required(wire.checkName, "checkName"),
      difficulty: required(wire.difficulty, "difficulty"),
      modifiers: wire.modifiers,
      exceptionalSuccessStakes: required(wire.exceptionalSuccessStakes, "exceptionalSuccessStakes"),
      successStakes: required(wire.successStakes, "successStakes"),
      failureStakes: required(wire.failureStakes, "failureStakes"),
      severeFailureStakes: required(wire.severeFailureStakes, "severeFailureStakes"),
      failureCampaignStatus: wire.failureCampaignStatus,
    }),
  });
}

export function decodeResolvedTurn(input: unknown): ResolvedTurn {
  const wire = WireTurnSchema.parse(input);
  if (wire.decision !== "resolved") throw new ProtocolDecodeError("resolution must return decision=resolved", "decision");
  assertResolvedShape(wire);
  return ResolvedTurnSchema.parse({
    narration: wire.narration,
    turnSummary: wire.summary,
    operations: wire.effects.map(decodeEffect),
  });
}
