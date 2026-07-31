import { structuredFailureDetails } from "./structured-error.js";
import { cancelledGenerationFailure, classifyFailure } from "./failures.js";
import type { FailureKind } from "./failures.js";
import { contentBlockRepairPrompt, structuredRepairPrompt } from "../prompts.js";
import { assertStructuredInputBudget, resolveEffectiveOutputTokenBudget } from "../input-budget.js";
import type { LlmProvider, StructuredRequest, StructuredResult } from "../types.js";

export function combineUsage(
  first: StructuredResult<unknown>["usage"],
  second: StructuredResult<unknown>["usage"],
): StructuredResult<unknown>["usage"] {
  if (!first && !second) return undefined;
  const add = (a?: number, b?: number): number | undefined =>
    a === undefined && b === undefined ? undefined : (a ?? 0) + (b ?? 0);
  const inputTokens = add(first?.inputTokens, second?.inputTokens);
  const outputTokens = add(first?.outputTokens, second?.outputTokens);
  const totalTokens = add(first?.totalTokens, second?.totalTokens);
  const billedCostUsd = add(first?.billedCostUsd, second?.billedCostUsd);
  return {
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
    ...(totalTokens === undefined ? {} : { totalTokens }),
    ...(billedCostUsd === undefined ? {} : { billedCostUsd }),
  };
}

export interface StructuredGenerationOptions {
  maxRepairs?: number;
  maxContentRepairs?: number;
  maxTransientRetries?: number;
  transientDelayMs?: number;
  signal?: AbortSignal;
}

const REPAIRABLE = new Set<FailureKind>([
  "malformed_json",
  "wire_schema_violation",
  "domain_decode_violation",
]);

type AttemptKind = "initial" | "repair" | "content_repair" | "transient_retry";

async function waitForTransientRetry(
  delayMs: number,
  signal: AbortSignal | undefined,
  provider: string,
): Promise<void> {
  if (signal === undefined) {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    return;
  }
  if (signal.aborted) throw cancelledGenerationFailure(provider);
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      signal.removeEventListener("abort", cancel);
      resolve();
    }, delayMs);
    const cancel = (): void => {
      clearTimeout(timeout);
      reject(cancelledGenerationFailure(provider));
    };
    signal.addEventListener("abort", cancel, { once: true });
  });
}

export class StructuredClient {
  constructor(private readonly provider: LlmProvider) {}

  async generate<T>(
    request: StructuredRequest<T>,
    options: StructuredGenerationOptions = {},
  ): Promise<StructuredResult<T>> {
    const maxRepairs = options.maxRepairs ?? 1;
    const maxContentRepairs = options.maxContentRepairs ?? 1;
    const maxTransientRetries = options.maxTransientRetries ?? 1;
    const delayMs = options.transientDelayMs ?? 150;
    const signal = options.signal ?? request.signal;
    let repairs = 0;
    let contentRepairs = 0;
    let transientRetries = 0;
    let prompt = request.prompt;
    let kind: AttemptKind = "initial";
    const originalPhase = request.generationPhase;
    let activePhase = originalPhase;
    let activeRepairOfPhase = request.repairOfPhase;
    let activeRetryBackoffMs = request.retryBackoffMs ?? 0;
    let accumulatedUsage: StructuredResult<unknown>["usage"];

    for (;;) {
      try {
        if (signal?.aborted) throw cancelledGenerationFailure(this.provider.id);
        const attemptRequest: StructuredRequest<T> = {
          ...request,
          schemaName: kind === "initial" ? request.schemaName : `${kind}_${request.schemaName}`,
          prompt,
          ...(activePhase === undefined ? {} : { generationPhase: activePhase }),
          ...(activeRepairOfPhase === undefined ? {} : { repairOfPhase: activeRepairOfPhase }),
          attemptKind:
            kind === "repair"
              ? "schema_repair"
              : kind === "content_repair"
                ? "content_repair"
                : kind === "transient_retry"
                  ? "transient_retry"
                  : (request.attemptKind ?? "initial"),
          retryBackoffMs: activeRetryBackoffMs,
          ...(signal === undefined ? {} : { signal }),
          ...(kind === "repair" ? { temperature: Math.min(request.temperature ?? 0.4, 0.4) } : {}),
        };
        assertStructuredInputBudget({
          phase: attemptRequest.generationPhase ?? attemptRequest.schemaName,
          system: attemptRequest.system,
          prompt: attemptRequest.prompt,
          outputTokenReserve: resolveEffectiveOutputTokenBudget(this.provider, attemptRequest),
          ...(kind === "repair" || request.inputBudgetSections === undefined
            ? {}
            : { sections: request.inputBudgetSections }),
        });
        const result = await this.provider.generateStructured(attemptRequest);
        const usage = combineUsage(accumulatedUsage, result.usage);
        return { ...result, ...(usage ? { usage } : {}) };
      } catch (error) {
        const classified = classifyFailure(error);
        if (classified.kind === "cancelled") throw error;
        if (signal?.aborted) throw cancelledGenerationFailure(this.provider.id);
        accumulatedUsage = combineUsage(accumulatedUsage, structuredFailureDetails(error)?.usage);

        if (REPAIRABLE.has(classified.kind) && repairs < maxRepairs) {
          repairs += 1;
          kind = "repair";
          activeRetryBackoffMs = 0;
          if (originalPhase !== undefined && originalPhase !== "repair") {
            activePhase = "repair";
            activeRepairOfPhase = originalPhase;
          }
          const failed = structuredFailureDetails(error);
          prompt = structuredRepairPrompt(
            prompt,
            failed?.parsedResponse ?? failed?.rawText ?? null,
            error,
          );
          continue;
        }

        if (classified.kind === "content_block" && contentRepairs < maxContentRepairs) {
          contentRepairs += 1;
          kind = "content_repair";
          activeRetryBackoffMs = 0;
          // Content-safe rendering changes only the prompt suffix. It retains
          // the current semantic phase (including repair when a repair output
          // was blocked), so the frozen profile keeps the correct phase budget.
          prompt = contentBlockRepairPrompt(prompt);
          continue;
        }

        if (
          (classified.kind === "network" || classified.kind === "rate_limit") &&
          classified.retryable &&
          transientRetries < maxTransientRetries
        ) {
          transientRetries += 1;
          kind = "transient_retry";
          activeRetryBackoffMs = delayMs * transientRetries;
          await waitForTransientRetry(activeRetryBackoffMs, signal, this.provider.id);
          continue;
        }
        throw error;
      }
    }
  }
}

export function generateStructured<T>(
  provider: LlmProvider,
  request: StructuredRequest<T>,
  options?: StructuredGenerationOptions,
): Promise<StructuredResult<T>> {
  return new StructuredClient(provider).generate(request, options);
}
