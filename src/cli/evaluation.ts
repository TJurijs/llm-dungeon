import { ProfileIdSchema, type ProfileId } from "../playtest.js";
import { PlaytestCli, type LegacyEvaluateOptions } from "./playtest.js";
import type { CliProjectContext } from "./project-context.js";

/** @deprecated Use the `playtest` command group. */
export interface EvaluateOptions extends LegacyEvaluateOptions {}

export function positiveInteger(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${value} must be a positive integer`);
  }
  return parsed;
}

export function positiveNumber(value: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${value} must be a positive number`);
  }
  return parsed;
}

export function profilePool(value: string): ProfileId[] {
  return ProfileIdSchema.array().min(1).parse(
    value.split(",").map((profile) => profile.trim()).filter(Boolean),
  );
}

/**
 * Compatibility wrapper for old command spellings. It deliberately delegates
 * to the unified playtest runner and cannot construct the retired evaluator.
 */
export class EvaluationCli {
  private readonly playtest: PlaytestCli;

  constructor(project: CliProjectContext) {
    this.playtest = new PlaytestCli(project);
  }

  run(options: EvaluateOptions): Promise<void> {
    return this.playtest.legacyEvaluate(options);
  }

  resume(runId: string): Promise<void> {
    return this.playtest.resume(runId);
  }

  regenerateReport(runId: string): Promise<void> {
    return this.playtest.report(runId);
  }
}
