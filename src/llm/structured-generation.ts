import { structuredFailureDetails } from "./structured-error.js";
import { classifyFailure } from "./failures.js";
import type { FailureKind } from "./failures.js";
import { structuredRepairPrompt } from "../prompts.js";
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
  return {
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
    ...(totalTokens === undefined ? {} : { totalTokens }),
  };
}

export interface StructuredGenerationOptions {
  maxRepairs?: number;
  maxTransientRetries?: number;
  transientDelayMs?: number;
}

const REPAIRABLE = new Set<FailureKind>([
  "malformed_json",
  "wire_schema_violation",
  "domain_decode_violation",
]);

type AttemptKind = "initial" | "repair" | "transient_retry";

export class StructuredClient {
  constructor(private readonly provider: LlmProvider) {}

  async generate<T>(
    request: StructuredRequest<T>,
    options: StructuredGenerationOptions = {},
  ): Promise<StructuredResult<T>> {
    const maxRepairs = options.maxRepairs ?? 1;
    const maxTransientRetries = options.maxTransientRetries ?? 1;
    const delayMs = options.transientDelayMs ?? 150;
    let repairs = 0;
    let transientRetries = 0;
    let prompt = request.prompt;
    let kind: AttemptKind = "initial";
    let accumulatedUsage: StructuredResult<unknown>["usage"];

    for (;;) {
      try {
        const result = await this.provider.generateStructured({
          ...request,
          schemaName: kind === "initial" ? request.schemaName : `${kind}_${request.schemaName}`,
          prompt,
          ...(kind === "repair" ? { temperature: Math.min(request.temperature ?? 0.4, 0.4) } : {}),
        });
        const usage = combineUsage(accumulatedUsage, result.usage);
        return { ...result, ...(usage ? { usage } : {}) };
      } catch (error) {
        const classified = classifyFailure(error);
        accumulatedUsage = combineUsage(accumulatedUsage, structuredFailureDetails(error)?.usage);

        if (REPAIRABLE.has(classified.kind) && repairs < maxRepairs) {
          repairs += 1;
          kind = "repair";
          const failed = structuredFailureDetails(error);
          prompt = structuredRepairPrompt(request.prompt, failed?.parsedResponse ?? failed?.rawText ?? null, error);
          continue;
        }

        if ((classified.kind === "network" || classified.kind === "rate_limit")
          && classified.retryable && transientRetries < maxTransientRetries) {
          transientRetries += 1;
          kind = "transient_retry";
          await new Promise((resolve) => setTimeout(resolve, delayMs * transientRetries));
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
