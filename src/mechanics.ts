import { randomInt } from "node:crypto";
import { z } from "zod";
import { CheckSpecSchema, type CheckSpec } from "./schemas.js";
import { DEFAULT_LANGUAGE, languageDefinition, type LanguageCode } from "./language.js";

export type RollD100 = () => number;

export interface CheckResult {
  spec: CheckSpec;
  roll: number;
  modifierTotal: number;
  total: number;
  margin: number;
  outcome: "exceptional_success" | "success" | "failure" | "severe_failure";
}

export const secureRollD100: RollD100 = () => randomInt(1, 101);

export function resolveCheck(rawSpec: CheckSpec, roll: number): CheckResult {
  const spec = CheckSpecSchema.parse(rawSpec);
  if (!Number.isInteger(roll) || roll < 1 || roll > 100) {
    throw new Error("d100 roll must be an integer from 1 to 100");
  }

  const modifierTotal = spec.modifiers.reduce((sum, modifier) => sum + modifier.value, 0);
  const total = roll + modifierTotal;
  const margin = total - spec.difficulty;

  let outcome: CheckResult["outcome"];
  if (roll === 1) outcome = "severe_failure";
  else if (roll === 100) outcome = "exceptional_success";
  else if (margin >= 30) outcome = "exceptional_success";
  else if (margin >= 0) outcome = "success";
  else if (margin > -30) outcome = "failure";
  else outcome = "severe_failure";

  return { spec, roll, modifierTotal, total, margin, outcome };
}

export const CheckResultSchema: z.ZodType<CheckResult> = z.object({
  spec: CheckSpecSchema,
  roll: z.number().int().min(1).max(100),
  modifierTotal: z.number().int(),
  total: z.number().int(),
  margin: z.number().int(),
  outcome: z.enum(["exceptional_success", "success", "failure", "severe_failure"]),
}).superRefine((result, context) => {
  const expected = resolveCheck(result.spec, result.roll);
  for (const field of ["modifierTotal", "total", "margin", "outcome"] as const) {
    if (result[field] !== expected[field]) {
      context.addIssue({
        code: "custom",
        path: [field],
        message: `does not match the locked natural roll (expected ${expected[field]})`,
      });
    }
  }
});

export function formatCheck(result: CheckResult, language: LanguageCode = DEFAULT_LANGUAGE): string {
  const copy = languageDefinition(language).mechanics;
  const modifierLines = result.spec.modifiers.length
    ? result.spec.modifiers
        .map((modifier) => `  ${modifier.value >= 0 ? "+" : ""}${modifier.value} ${modifier.label}`)
        .join("\n")
    : `  ${copy.noModifiers}`;
  const label = copy.outcomes[result.outcome];
  return [
    `${result.spec.name}: d100 = ${result.roll}`,
    modifierLines,
    `${copy.total} ${result.total}${copy.comparisonConnector}${copy.difficulty} ${result.spec.difficulty} — ${label}`,
  ].join("\n");
}
