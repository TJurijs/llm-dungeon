import { z } from "zod";
import { SafeIdSchema } from "../schemas.js";

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
