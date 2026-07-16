import { z } from "zod";

export const UsageSchema = z.object({
  inputTokens: z.number().int().nonnegative().optional(),
  outputTokens: z.number().int().nonnegative().optional(),
  totalTokens: z.number().int().nonnegative().optional(),
  /** Exact amount charged by a provider when the response supplies it. */
  billedCostUsd: z.number().nonnegative().optional(),
});

export type Usage = z.infer<typeof UsageSchema>;
