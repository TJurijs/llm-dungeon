import { z } from "zod";
import { CheckResultSchema } from "../mechanics.js";
import { SafeIdSchema } from "../schemas.js";

const UsageSchema = z.object({
  inputTokens: z.number().int().nonnegative().optional(),
  outputTokens: z.number().int().nonnegative().optional(),
  totalTokens: z.number().int().nonnegative().optional(),
});

const RequestedActionSchema = z.object({
  kind: z.literal("action"),
  action: z.string().trim().min(1),
  phase: z.literal("requested"),
});

const RolledActionSchema = z.object({
  kind: z.literal("action"),
  action: z.string().trim().min(1),
  phase: z.literal("rolled"),
  checkResult: CheckResultSchema,
  priorUsage: UsageSchema.optional(),
});

export const PendingActionSchema = z.union([RequestedActionSchema, RolledActionSchema]);

const PendingCommitSchema = z.object({
  kind: z.literal("commit"),
  writes: z.record(z.string().min(1), z.string()).refine(
    (writes) => Object.prototype.hasOwnProperty.call(writes, "manifest.json"),
    "A pending commit must include manifest.json",
  ),
  campaignId: SafeIdSchema,
  expectedPreviousTurn: z.number().int().nonnegative(),
  targetTurn: z.number().int().positive(),
  preManifestHash: z.string().regex(/^[a-f0-9]{64}$/i, "must be a SHA-256 hash"),
}).refine(
  (commit) => commit.targetTurn === commit.expectedPreviousTurn + 1,
  { path: ["targetTurn"], message: "must immediately follow expectedPreviousTurn" },
);

export const PendingTurnSchema = z.union([PendingActionSchema, PendingCommitSchema]);

export type PendingAction = z.infer<typeof PendingActionSchema>;
export type PendingCommit = z.infer<typeof PendingCommitSchema>;
export type PendingTurn = z.infer<typeof PendingTurnSchema>;
