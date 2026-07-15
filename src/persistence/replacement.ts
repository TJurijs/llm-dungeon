import { mkdir, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { ManifestSchema, SafeIdSchema } from "../schemas.js";
import { pathExists, unlinkIfExists } from "./files.js";

const DirectoryNameSchema = z.string()
  .regex(/^[A-Za-z0-9._-]+$/, "must be a generated directory name")
  .refine((name) => name !== "." && name !== "..", "must not traverse directories");

export const ReplacementIntentSchema = z.object({
  schemaVersion: z.literal(1),
  stagedDirectory: DirectoryNameSchema.refine((name) => name.startsWith(".new-"), "must be a staged campaign directory"),
  stagedCampaignId: SafeIdSchema,
  archivedDirectory: DirectoryNameSchema.optional(),
  previousCampaignId: SafeIdSchema.optional(),
}).refine(
  (intent) => Boolean(intent.archivedDirectory) === Boolean(intent.previousCampaignId),
  "Archived directory and previous campaign ID must be present together",
);

export type ReplacementIntent = z.infer<typeof ReplacementIntentSchema>;

export interface ReplacementPaths {
  dataRoot: string;
  currentDir: string;
  archiveDir: string;
  intentPath: string;
}

export async function campaignIdAt(directory: string): Promise<string | undefined> {
  const manifestPath = path.join(directory, "manifest.json");
  if (!(await pathExists(manifestPath))) return undefined;
  return ManifestSchema.parse(JSON.parse(await readFile(manifestPath, "utf8"))).campaignId;
}

/** Complete or roll back a replacement described by its durable intent. */
export async function recoverCampaignReplacement(paths: ReplacementPaths): Promise<void> {
  if (!(await pathExists(paths.intentPath))) return;
  const intent = ReplacementIntentSchema.parse(JSON.parse(
    await readFile(paths.intentPath, "utf8"),
  ));
  const stagedPath = path.join(paths.dataRoot, intent.stagedDirectory);
  const archivedPath = intent.archivedDirectory
    ? path.join(paths.archiveDir, intent.archivedDirectory)
    : undefined;
  const stagedId = await campaignIdAt(stagedPath);
  if (stagedId && stagedId !== intent.stagedCampaignId) {
    throw new Error("Replacement staging directory belongs to another campaign");
  }
  if (archivedPath && await pathExists(archivedPath)) {
    const archivedId = await campaignIdAt(archivedPath);
    if (archivedId !== intent.previousCampaignId) {
      throw new Error("Replacement archive directory belongs to another campaign");
    }
  }

  const currentId = await campaignIdAt(paths.currentDir);
  if (currentId === intent.stagedCampaignId) {
    if (stagedId) await rm(stagedPath, { recursive: true, force: true });
    await unlinkIfExists(paths.intentPath);
    return;
  }
  if (currentId) {
    if (!archivedPath || currentId !== intent.previousCampaignId || await pathExists(archivedPath)) {
      throw new Error("Replacement intent conflicts with the active campaign");
    }
    await mkdir(paths.archiveDir, { recursive: true });
    await rename(paths.currentDir, archivedPath);
  }

  if (await pathExists(stagedPath)) {
    await rename(stagedPath, paths.currentDir);
    await unlinkIfExists(paths.intentPath);
    return;
  }
  if (archivedPath && await pathExists(archivedPath)) {
    await rename(archivedPath, paths.currentDir);
    await unlinkIfExists(paths.intentPath);
    return;
  }
  throw new Error("Replacement intent has neither a staged nor recoverable archived campaign");
}
