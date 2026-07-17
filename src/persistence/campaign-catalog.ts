import { mkdir, readFile, rename } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { LanguageCodeSchema } from "../language.js";
import { ProviderConfigSchema, SafeIdSchema, SetupResultSchema } from "../schemas.js";
import { UsageSchema } from "../usage.js";
import { executePendingCommit } from "./commit.js";
import { atomicWriteJson, pathExists, unlinkIfExists } from "./files.js";
import { PendingTurnSchema } from "./pending.js";
import { campaignIdAt } from "./replacement.js";

export const CAMPAIGNS_DIRECTORY = "campaigns";
export const CAMPAIGN_METADATA_FILE = "campaign-metadata.json";
export const CAMPAIGN_MIGRATION_INTENT_FILE = ".campaign-migration.json";
export const CAMPAIGN_CREATION_INTENT_FILE = ".campaign-creation.json";

const DirectoryNameSchema = z.string()
  .regex(/^[A-Za-z0-9._-]+$/, "must be a generated directory name")
  .refine((name) => name !== "." && name !== "..", "must not traverse directories");

const CampaignMetadataFields = {
  schemaVersion: z.literal(1),
  campaignId: SafeIdSchema,
  registeredAt: z.string().datetime(),
  creationRequestId: z.string().uuid().optional(),
  creationFingerprint: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  providerConfig: ProviderConfigSchema.optional(),
} as const;

export const ActiveCampaignMetadataSchema = z.object({
  ...CampaignMetadataFields,
  archived: z.literal(false),
}).strict();

export const ArchivedCampaignMetadataSchema = z.object({
  ...CampaignMetadataFields,
  archived: z.literal(true),
  archivedAt: z.string().datetime(),
}).strict();

export const CampaignMetadataSchema = z.discriminatedUnion("archived", [
  ActiveCampaignMetadataSchema,
  ArchivedCampaignMetadataSchema,
]);

export type CampaignMetadata = z.infer<typeof CampaignMetadataSchema>;

export const CatalogNewGameInputSchema = z.object({
  setup: SetupResultSchema,
  worldRules: z.string(),
  language: LanguageCodeSchema.optional(),
  setupInput: z.object({
    premise: z.string(),
    character: z.string(),
  }).strict().optional(),
  openingGeneration: z.object({
    provider: z.string().min(1),
    model: z.string().min(1),
    usage: UsageSchema.optional(),
  }).strict().optional(),
}).strict();

export const CampaignCreationIntentSchema = z.object({
  schemaVersion: z.literal(1),
  metadata: ActiveCampaignMetadataSchema,
  input: CatalogNewGameInputSchema,
}).strict();

export type CampaignCreationIntent = z.infer<typeof CampaignCreationIntentSchema>;

const LegacyCampaignSourceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("current") }).strict(),
  z.object({
    kind: z.literal("archive"),
    directory: DirectoryNameSchema,
  }).strict(),
]);

export type LegacyCampaignSource = z.infer<typeof LegacyCampaignSourceSchema>;

export const CampaignMigrationIntentSchema = z.object({
  schemaVersion: z.literal(1),
  createdAt: z.string().datetime(),
  entries: z.array(z.object({
    source: LegacyCampaignSourceSchema,
    metadata: CampaignMetadataSchema,
  }).strict()).min(1),
}).strict();

export type CampaignMigrationIntent = z.infer<typeof CampaignMigrationIntentSchema>;

export function campaignDirectoryName(campaignId: string): string {
  const validated = SafeIdSchema.parse(campaignId);
  return `campaign-${Buffer.from(validated, "utf8").toString("base64url")}`;
}

export function campaignScopePath(dataRoot: string, campaignId: string): string {
  return path.join(dataRoot, CAMPAIGNS_DIRECTORY, campaignDirectoryName(campaignId));
}

export function campaignMetadataPath(scopeRoot: string): string {
  return path.join(scopeRoot, CAMPAIGN_METADATA_FILE);
}

export async function readCampaignMetadata(scopeRoot: string): Promise<CampaignMetadata> {
  return CampaignMetadataSchema.parse(JSON.parse(
    await readFile(campaignMetadataPath(scopeRoot), "utf8"),
  ));
}

export function writeCampaignMetadata(scopeRoot: string, metadata: CampaignMetadata): Promise<void> {
  return atomicWriteJson(campaignMetadataPath(scopeRoot), CampaignMetadataSchema.parse(metadata));
}

function legacySourcePath(dataRoot: string, source: LegacyCampaignSource): string {
  return source.kind === "current"
    ? path.join(dataRoot, "current")
    : path.join(dataRoot, "archive", source.directory);
}

async function recoverPendingCommitAt(currentDir: string): Promise<void> {
  const pendingPath = path.join(currentDir, "pending-turn.json");
  if (!(await pathExists(pendingPath))) return;
  const pending = PendingTurnSchema.parse(JSON.parse(await readFile(pendingPath, "utf8")));
  if (pending.kind === "commit") await executePendingCommit(currentDir, pendingPath, pending);
}

/**
 * Finish the durable, same-filesystem migration one campaign at a time. A
 * campaign is visible to the catalog only after both its current directory and
 * metadata exist. Replaying after any rename or metadata write is idempotent.
 */
export async function recoverCampaignCatalogMigration(
  dataRoot: string,
  intentPath = path.join(dataRoot, CAMPAIGN_MIGRATION_INTENT_FILE),
): Promise<void> {
  if (!(await pathExists(intentPath))) return;
  const intent = CampaignMigrationIntentSchema.parse(JSON.parse(await readFile(intentPath, "utf8")));
  await mkdir(path.join(dataRoot, CAMPAIGNS_DIRECTORY), { recursive: true });

  for (const entry of intent.entries) {
    const sourcePath = legacySourcePath(dataRoot, entry.source);
    const scopeRoot = campaignScopePath(dataRoot, entry.metadata.campaignId);
    const targetPath = path.join(scopeRoot, "current");
    const sourceId = await campaignIdAt(sourcePath);
    const targetId = await campaignIdAt(targetPath);

    if (sourceId !== undefined && sourceId !== entry.metadata.campaignId) {
      throw new Error(`Legacy migration source belongs to another campaign: ${sourceId}`);
    }
    if (targetId !== undefined && targetId !== entry.metadata.campaignId) {
      throw new Error(`Catalog migration target belongs to another campaign: ${targetId}`);
    }
    if (sourceId !== undefined && targetId !== undefined) {
      throw new Error(`Campaign ${entry.metadata.campaignId} exists in both legacy and catalog storage`);
    }
    if (sourceId === undefined && targetId === undefined) {
      throw new Error(`Campaign ${entry.metadata.campaignId} has neither a legacy source nor a catalog target`);
    }

    if (sourceId !== undefined) {
      if (await pathExists(campaignMetadataPath(scopeRoot))) {
        throw new Error(`Campaign ${entry.metadata.campaignId} has metadata before its migration move`);
      }
      await mkdir(scopeRoot, { recursive: true });
      await rename(sourcePath, targetPath);
    }

    await recoverPendingCommitAt(targetPath);
    if (await pathExists(campaignMetadataPath(scopeRoot))) {
      const existing = await readCampaignMetadata(scopeRoot);
      if (JSON.stringify(existing) !== JSON.stringify(entry.metadata)) {
        throw new Error(`Campaign ${entry.metadata.campaignId} migration metadata conflicts with its durable intent`);
      }
    } else {
      await writeCampaignMetadata(scopeRoot, entry.metadata);
    }
  }

  await unlinkIfExists(intentPath);
}
