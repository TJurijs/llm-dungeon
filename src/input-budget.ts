import { Buffer } from "node:buffer";
import type { LlmProvider, StructuredOutputBudgetRequest } from "./types.js";

/**
 * Application-wide compatibility envelope for provider input. Frozen model
 * profiles intentionally do not own this value: adding it there would change
 * existing profile fingerprints and invalidate otherwise-current evidence.
 */
export const APPLICATION_CONTEXT_TOKEN_BUDGET = 128_000;
/** Hard application ceiling even when a model could accept a larger request. */
export const APPLICATION_INPUT_TOKEN_LIMIT = 100_000;
/** Conservative fallback for providers that cannot expose their effective request budget. */
export const APPLICATION_OUTPUT_TOKEN_RESERVE = 32_000;
export const APPLICATION_SCHEMA_FRAMING_TOKEN_RESERVE = 8_000;

export function inputTokenLimitForOutputBudget(outputTokenBudget: number): number {
  if (!Number.isSafeInteger(outputTokenBudget) || outputTokenBudget < 0) {
    throw new Error("Effective output token budget must be a nonnegative safe integer");
  }
  return Math.max(
    0,
    Math.min(
      APPLICATION_INPUT_TOKEN_LIMIT,
      APPLICATION_CONTEXT_TOKEN_BUDGET -
        outputTokenBudget -
        APPLICATION_SCHEMA_FRAMING_TOKEN_RESERVE,
    ),
  );
}

const DEFAULT_PHASE_OUTPUT_TOKEN_BUDGETS = {
  setup: 8_000,
  decision: 4_000,
  locked_resolution: 4_000,
  repair: 8_000,
} as const;

/**
 * Resolve the exact official-provider allowance when available. Lightweight
 * custom/fake providers retain a conservative deterministic request fallback.
 */
export function resolveEffectiveOutputTokenBudget(
  provider: LlmProvider,
  request: StructuredOutputBudgetRequest,
): number {
  const providerBudget = provider.effectiveOutputTokenBudget?.(request);
  if (providerBudget !== undefined) return providerBudget;
  if (request.outputTokenCeiling !== undefined) return request.outputTokenCeiling;
  if (request.maxOutputTokens !== undefined) return request.maxOutputTokens;
  return request.generationPhase === undefined
    ? APPLICATION_OUTPUT_TOKEN_RESERVE
    : DEFAULT_PHASE_OUTPUT_TOKEN_BUDGETS[request.generationPhase];
}

export const INPUT_CHARACTER_LIMITS = {
  premise: 100_000,
  character: 100_000,
  worldRules: 500_000,
  action: 10_000,
  question: 10_000,
  appeal: 10_000,
} as const;

export interface InputBudgetSection {
  readonly id: string;
  readonly text: string;
}

export interface InputBudgetSectionReport {
  readonly id: string;
  readonly estimatedTokens: number;
}

export interface InputBudgetReport {
  readonly phase: string;
  readonly estimatedInputTokens: number;
  readonly inputTokenLimit: number;
  readonly contextTokenBudget: number;
  readonly outputTokenReserve: number;
  readonly schemaFramingTokenReserve: number;
  readonly sections: readonly InputBudgetSectionReport[];
}

interface PromptDocumentLike {
  readonly sections: readonly {
    readonly id: string;
    readonly title?: string;
    readonly content: string;
  }[];
}

/**
 * Provider tokenizers differ and custom models may not expose one locally.
 * Counting at least one unit per Unicode scalar, and at least one per two UTF-8
 * bytes, deliberately overestimates normal prose while remaining deterministic
 * for every supported language.
 */
export function conservativeInputTokenEstimate(value: string): number {
  let scalars = 0;
  for (const _character of value) scalars += 1;
  return Math.max(scalars, Math.ceil(Buffer.byteLength(value, "utf8") / 2));
}

/** Named diagnostic sections for the exact system and prompt document. */
export function promptDocumentInputSections(
  system: string,
  document: PromptDocumentLike,
  expandedSections: Readonly<Record<string, PromptDocumentLike["sections"] | undefined>> = {},
): readonly InputBudgetSection[] {
  return [
    { id: "system", text: system },
    ...document.sections.flatMap((item): readonly InputBudgetSection[] => {
      const expanded = expandedSections[item.id];
      if (expanded === undefined) {
        return [
          {
            id: `prompt:${item.id}`,
            text: item.title ? `${item.title}\n${item.content}` : item.content,
          },
        ];
      }
      return [
        ...(item.title ? [{ id: `prompt:${item.id}/header`, text: item.title }] : []),
        ...expanded.map((child) => ({
          id: `prompt:${item.id}/${child.id}`,
          text: child.title ? `${child.title}\n${child.content}` : child.content,
        })),
      ];
    }),
  ];
}

export function inspectStructuredInputBudget(input: {
  readonly phase?: string;
  readonly system: string;
  readonly prompt: string;
  readonly sections?: readonly InputBudgetSection[];
  /** Effective provider-facing output allowance for this physical attempt. */
  readonly outputTokenReserve?: number;
}): InputBudgetReport {
  const outputTokenReserve = input.outputTokenReserve ?? APPLICATION_OUTPUT_TOKEN_RESERVE;
  const diagnosticSections = input.sections ?? [
    { id: "system", text: input.system },
    { id: "prompt", text: input.prompt },
  ];
  const sections = diagnosticSections
    .map((item) => ({
      id: item.id,
      estimatedTokens: conservativeInputTokenEstimate(item.text),
    }))
    .sort(
      (left, right) =>
        right.estimatedTokens - left.estimatedTokens || left.id.localeCompare(right.id),
    );
  return {
    phase: input.phase ?? "unspecified",
    estimatedInputTokens: conservativeInputTokenEstimate(`${input.system}\n\n${input.prompt}`),
    inputTokenLimit: inputTokenLimitForOutputBudget(outputTokenReserve),
    contextTokenBudget: APPLICATION_CONTEXT_TOKEN_BUDGET,
    outputTokenReserve,
    schemaFramingTokenReserve: APPLICATION_SCHEMA_FRAMING_TOKEN_RESERVE,
    sections,
  };
}

export class InputBudgetExceededError extends Error {
  readonly code = "input_budget_exceeded" as const;

  constructor(readonly report: InputBudgetReport) {
    const breakdown = report.sections
      .map((section) => `- ${section.id}: ${section.estimatedTokens.toLocaleString("en-US")}`)
      .join("\n");
    super(
      `Input context exceeds the application limit before the ${report.phase} provider attempt: ` +
        `${report.estimatedInputTokens.toLocaleString("en-US")} conservative tokens exceeds ` +
        `${report.inputTokenLimit.toLocaleString("en-US")} ` +
        `(context envelope ${report.contextTokenBudget.toLocaleString("en-US")}; ` +
        `${report.outputTokenReserve.toLocaleString("en-US")} reserved for output and ` +
        `${report.schemaFramingTokenReserve.toLocaleString("en-US")} for schema/message framing).\n` +
        `Section breakdown (largest first):\n${breakdown}\n` +
        "This over-budget attempt was not sent to the provider, and no input was truncated.",
    );
    this.name = "InputBudgetExceededError";
  }
}

export function assertStructuredInputBudget(input: {
  readonly phase?: string;
  readonly system: string;
  readonly prompt: string;
  readonly sections?: readonly InputBudgetSection[];
  /** Effective provider-facing output allowance for this physical attempt. */
  readonly outputTokenReserve?: number;
}): InputBudgetReport {
  const report = inspectStructuredInputBudget(input);
  if (report.estimatedInputTokens > report.inputTokenLimit) {
    throw new InputBudgetExceededError(report);
  }
  return report;
}

function assertMaximumLength(value: string, label: string, limit: number): void {
  if (value.length > limit) {
    throw new Error(`${label} exceeds ${limit.toLocaleString("en-US")} characters`);
  }
}

/** Consistent raw setup limits for terminal, browser, and direct engine callers. */
export function assertSetupGenerationInput(input: {
  readonly premise: string;
  readonly character: string;
  readonly worldRules: string;
}): void {
  assertMaximumLength(input.premise, "Premise", INPUT_CHARACTER_LIMITS.premise);
  assertMaximumLength(input.character, "Character concept", INPUT_CHARACTER_LIMITS.character);
  assertMaximumLength(input.worldRules, "World and DM style", INPUT_CHARACTER_LIMITS.worldRules);
  if (!input.worldRules.trim()) throw new Error("World and DM style cannot be empty");
}

export function normalizePlayerAction(value: string): string {
  const action = value.trim();
  if (!action) throw new Error("Action cannot be empty");
  assertMaximumLength(action, "Action", INPUT_CHARACTER_LIMITS.action);
  return action;
}

export function normalizePlayerQuestion(value: string): string {
  const question = value.trim();
  if (!question) throw new Error("Question cannot be empty");
  assertMaximumLength(question, "Question", INPUT_CHARACTER_LIMITS.question);
  return question;
}
