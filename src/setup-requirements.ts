import { z } from "zod";
import { EntityKindSchema, SafeIdSchema, SETUP_ENTITY_LIMIT, type SetupResult } from "./schemas.js";
import { ScenarioContractSchema } from "./scenario-contracts.js";

const RequiredSetupEntitySchema = z
  .object({
    id: SafeIdSchema,
    kinds: z.array(EntityKindSchema).min(1),
    purpose: z.string().trim().min(1).max(240),
    minimumTraits: z.number().int().nonnegative().max(8).default(0),
    mustHaveCustody: z.boolean().default(false),
    mustHaveLocation: z.boolean().default(false),
    mustHavePlacement: z.boolean().default(false),
  })
  .strict();

const RequiredLocationParentSchema = z
  .object({
    childId: SafeIdSchema,
    parentId: SafeIdSchema,
  })
  .strict();

const RequiredInventorySchema = z
  .object({
    ownerId: SafeIdSchema,
    itemId: SafeIdSchema,
  })
  .strict();

const RequiredThreadLinksSchema = z
  .object({
    label: z.string().trim().min(1).max(120),
    relatedEntityIds: z.array(SafeIdSchema).min(1),
  })
  .strict();

/** Optional, shipped-seed admission rules. They constrain structure, never hidden truth. */
export const SetupRequirementsSchema = z
  .object({
    schemaVersion: z.literal(1),
    entities: z.array(RequiredSetupEntitySchema).max(24).default([]),
    locationParents: z.array(RequiredLocationParentSchema).max(24).default([]),
    inventory: z.array(RequiredInventorySchema).max(24).default([]),
    threadLinks: z.array(RequiredThreadLinksSchema).max(10).default([]),
    /**
     * Continuity the seed asserts for the whole campaign rather than its
     * opening state. Evaluated as review signals every turn and as coverage by
     * the playtest harness, so a new scenario needs no new code.
     */
    ongoing: z.array(ScenarioContractSchema).max(16).default([]),
  })
  .strict();

export type SetupRequirements = z.infer<typeof SetupRequirementsSchema>;

export function setupRequirementsPrompt(requirements: SetupRequirements): string {
  const closedEntitySet =
    requirements.entities.length === SETUP_ENTITY_LIMIT
      ? [
          `CLOSED ENTITY SET: these requirements fill all ${SETUP_ENTITY_LIMIT} available non-player entity slots. The entities array must contain exactly these required IDs, with no extra records or substitutions. Every inventory entry must reference an included required item ID; never retain an inventory reference to an omitted or prose-only item.`,
        ]
      : [];
  const lines = [
    "APPLICATION-ENFORCED SEED STRUCTURE",
    "Use every exact ID below for the described role. These IDs identify required records, not optional examples.",
    ...closedEntitySet,
    ...requirements.entities.map(
      (requirement) =>
        `- ${requirement.id}: kind=${requirement.kinds.join("|")}; ${requirement.purpose}${
          requirement.minimumTraits > 0
            ? `; at least ${requirement.minimumTraits} self-contained capability trait(s)`
            : ""
        }${requirement.mustHaveCustody ? "; must have exact opening custody" : ""}${
          requirement.mustHaveLocation ? "; must have an exact opening location" : ""
        }${requirement.mustHavePlacement ? "; must have exact opening custody or location" : ""}`,
    ),
    ...requirements.locationParents.map(
      ({ childId, parentId }) => `- exact location parent: ${childId} is inside ${parentId}`,
    ),
    ...requirements.inventory.map(
      ({ ownerId, itemId }) => `- exact opening custody: ${ownerId} inventories ${itemId}`,
    ),
    ...requirements.threadLinks.map(
      ({ label, relatedEntityIds }) =>
        `- ${label}: one thread must privately link all of ${relatedEntityIds.join(", ")}`,
    ),
    "All other names, facts, secrets, motives, and chronology remain creative within the supplied seed. Do not expose hidden requirements in player-visible narration or scenarioMarkdown.",
  ];
  return lines.join("\n");
}

export function assertSetupRequirements(
  setup: SetupResult,
  requirements: SetupRequirements | undefined,
): void {
  if (requirements === undefined) return;
  const parsed = SetupRequirementsSchema.parse(requirements);
  const all = [setup.player, ...setup.entities];
  const byId = new Map(all.map((entity) => [entity.id, entity]));
  const ownersByItem = new Map<string, string[]>();
  for (const owner of all) {
    for (const entry of owner.inventory) {
      const owners = ownersByItem.get(entry.entityId) ?? [];
      owners.push(owner.id);
      ownersByItem.set(entry.entityId, owners);
    }
  }
  const errors: string[] = [];
  for (const requirement of parsed.entities) {
    const entity = byId.get(requirement.id);
    if (entity === undefined) {
      errors.push(`required seed entity ${requirement.id} is missing (${requirement.purpose})`);
      continue;
    }
    if (!requirement.kinds.includes(entity.kind)) {
      errors.push(
        `required seed entity ${requirement.id} must have kind ${requirement.kinds.join(" or ")}, received ${entity.kind}`,
      );
    }
    if (entity.traits.length < requirement.minimumTraits) {
      errors.push(
        `required seed entity ${requirement.id} needs at least ${requirement.minimumTraits} capability trait(s)`,
      );
    }
    if (requirement.mustHaveCustody && (ownersByItem.get(requirement.id)?.length ?? 0) !== 1) {
      errors.push(`required seed item ${requirement.id} must have exactly one opening custodian`);
    }
    if (requirement.mustHaveLocation && entity.location === undefined) {
      errors.push(`required seed entity ${requirement.id} must have an exact opening location`);
    }
    if (
      requirement.mustHavePlacement &&
      entity.location === undefined &&
      (ownersByItem.get(requirement.id)?.length ?? 0) !== 1
    ) {
      errors.push(
        `required seed entity ${requirement.id} must have exactly one opening custodian or an exact opening location`,
      );
    }
  }
  for (const requirement of parsed.locationParents) {
    if (byId.get(requirement.childId)?.location !== requirement.parentId) {
      errors.push(
        `required seed location ${requirement.childId} must be directly inside ${requirement.parentId}`,
      );
    }
  }
  for (const requirement of parsed.inventory) {
    const owner = byId.get(requirement.ownerId);
    if (!owner?.inventory.some((entry) => entry.entityId === requirement.itemId)) {
      errors.push(
        `required seed custodian ${requirement.ownerId} must inventory ${requirement.itemId}`,
      );
    }
  }
  for (const requirement of parsed.threadLinks) {
    const required = new Set(requirement.relatedEntityIds);
    const found = setup.threads.some((thread) => {
      const related = new Set(thread.relatedEntityIds);
      return [...required].every((id) => related.has(id));
    });
    if (!found) {
      errors.push(
        `required seed thread ${JSON.stringify(requirement.label)} must link ${requirement.relatedEntityIds.join(", ")}`,
      );
    }
  }
  if (errors.length > 0) {
    throw new Error(`Seed setup requirements failed:\n- ${errors.join("\n- ")}`);
  }
}
