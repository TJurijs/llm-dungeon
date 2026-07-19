import { readFile } from "node:fs/promises";
import { z } from "zod";
import { LanguageCodeSchema } from "./language.js";

/**
 * Read-only projection of the retired evaluation-v1 manifest. Historical
 * artifacts stay inspectable, but no code here can create or resume a v1 run.
 */
export const LegacyEvaluationManifestSchema = z.object({
  schemaVersion: z.literal(1),
  runId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/),
  config: z.object({
    language: LanguageCodeSchema,
  }).passthrough(),
  sessions: z.array(z.object({
    id: z.string().regex(/^session-[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/),
    profile: z.string().min(1),
  }).passthrough()),
}).passthrough();

export type LegacyEvaluationManifest = z.infer<typeof LegacyEvaluationManifestSchema>;

export async function readLegacyEvaluationManifest(
  manifestPath: string,
): Promise<LegacyEvaluationManifest> {
  return LegacyEvaluationManifestSchema.parse(JSON.parse(await readFile(manifestPath, "utf8")));
}
