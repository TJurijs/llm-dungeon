import { describe, expect, it } from "vitest";
import {
  DEFAULT_MODEL_EXECUTION_PROFILE_DRAFTS,
  ModelExecutionProfileDraftSchema,
  assertSingleCalibrationVariableChange,
  changedCalibrationVariables,
  escalateOutputBudgetAfterTruncation,
  freezeModelExecutionProfile,
  outputBudgetForPhase,
} from "../src/model-execution-profile.js";

function selectedProfile() {
  const base = DEFAULT_MODEL_EXECUTION_PROFILE_DRAFTS.find((profile) =>
    profile.key.provider === "openai" && profile.key.model === "gpt-5.6-terra");
  if (!base) throw new Error("Missing OpenAI default execution profile");
  return {
    ...base,
    calibratedAt: "2026-07-19T12:00:00.000Z",
    evidenceRef: "playtests/calibration-terra/attempts.jsonl",
  };
}

describe("model execution profiles", () => {
  it("ships strict uncalibrated defaults for every curated route", () => {
    expect(DEFAULT_MODEL_EXECUTION_PROFILE_DRAFTS.map((profile) =>
      `${profile.key.provider}/${profile.key.model}/${profile.key.route}`)).toEqual([
      "gemini/gemini-3.5-flash/direct",
      "gemini/gemini-3.1-flash-lite/direct",
      "openrouter/qwen/qwen3.7-plus/openrouter",
      "xai/grok-4.5/direct",
      "openai/gpt-5.4/direct",
      "openai/gpt-5.6-terra/direct",
      "deepseek/deepseek-v4-flash/direct",
      "deepseek/deepseek-v4-pro/direct",
    ]);
    expect(() => ModelExecutionProfileDraftSchema.parse({
      ...DEFAULT_MODEL_EXECUTION_PROFILE_DRAFTS[0],
      arbitraryProviderBody: { unsafe: true },
    })).toThrow();
  });

  it("freezes execution content by fingerprint while ignoring evidence bookkeeping", () => {
    const first = freezeModelExecutionProfile(selectedProfile());
    const second = freezeModelExecutionProfile({
      ...selectedProfile(),
      calibratedAt: "2026-07-20T12:00:00.000Z",
      evidenceRef: "another/evidence.jsonl",
    });
    const changed = freezeModelExecutionProfile({
      ...selectedProfile(),
      outputBudgets: { ...selectedProfile().outputBudgets, decision: 8_000 },
    });

    expect(first.frozen).toBe(true);
    expect(Object.isFrozen(first.outputBudgets)).toBe(true);
    expect(Object.isFrozen(first.key)).toBe(true);
    expect(first.fingerprint).toBe(second.fingerprint);
    expect(changed.fingerprint).not.toBe(first.fingerprint);
  });

  it("enforces one-variable-at-a-time calibration", () => {
    const original = DEFAULT_MODEL_EXECUTION_PROFILE_DRAFTS[3]!;
    const temperatureVariant = { ...original, temperature: { policy: "omitted" as const } };
    expect(changedCalibrationVariables(original, temperatureVariant)).toEqual(["temperature"]);
    expect(assertSingleCalibrationVariableChange(original, temperatureVariant)).toBe("temperature");
    expect(() => assertSingleCalibrationVariableChange(original, {
      ...temperatureVariant,
      outputBudgets: { ...original.outputBudgets, decision: 8_000 },
    })).toThrow("exactly one variable");
  });

  it("escalates only explicit truncation through bounded phase steps", () => {
    const original = DEFAULT_MODEL_EXECUTION_PROFILE_DRAFTS[0]!;
    expect(escalateOutputBudgetAfterTruncation(original, "setup", false)).toBeUndefined();
    const at16k = escalateOutputBudgetAfterTruncation(original, "setup", true);
    expect(at16k?.outputBudgets.setup).toBe(16_000);
    const at32k = escalateOutputBudgetAfterTruncation(at16k!, "setup", true);
    expect(at32k?.outputBudgets.setup).toBe(32_000);
    expect(escalateOutputBudgetAfterTruncation(at32k!, "setup", true)).toBeUndefined();

    const decision8k = escalateOutputBudgetAfterTruncation(original, "decision", true);
    expect(decision8k?.outputBudgets.decision).toBe(8_000);
    expect(escalateOutputBudgetAfterTruncation(decision8k!, "decision", true)).toBeUndefined();
  });

  it("never gives a repair less output budget than its failed phase", () => {
    const original = DEFAULT_MODEL_EXECUTION_PROFILE_DRAFTS[0]!;
    const largerSetup = {
      ...original,
      outputBudgets: { ...original.outputBudgets, setup: 16_000, repair: 8_000 },
    };
    expect(outputBudgetForPhase(largerSetup, "repair", "setup")).toBe(16_000);
    expect(outputBudgetForPhase(largerSetup, "repair", "decision")).toBe(8_000);
  });
});
