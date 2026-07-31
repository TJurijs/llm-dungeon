import { randomUUID } from "node:crypto";
import { z } from "zod";
import { cancelledGenerationFailure, GenerationFailure } from "../llm/failures.js";
import { attachRequestDiagnostics } from "../llm/request-diagnostics.js";
import { attachAttemptMetadata, attachStructuredFailure } from "../llm/structured-error.js";
import {
  modelExecutionProfileFingerprint,
  outputBudgetForPhase,
  timeoutForPhase,
  type FrozenModelExecutionProfile,
  type ModelGenerationPhase,
  type OutputTokenField,
  type SchemaProjectionId,
} from "../model-execution-profile.js";
import type {
  ProviderAttemptMetadata,
  ProviderRequestDiagnostics,
  StructuredOutputBudgetRequest,
  StructuredRequest,
  StructuredResult,
} from "../types.js";
import type { ProviderConfig } from "../schemas.js";
import {
  isRecord,
  jsonSchemaFor,
  localSchemaSystemPrompt,
  projectSchemaById,
  type ProviderSchemaProjection,
} from "./schema-projection.js";

export type FetchLike = typeof fetch;

export interface ProviderExecutionOptions {
  executionProfile?: FrozenModelExecutionProfile;
}

/** Shared chat-completions transport, diagnostics, and structured decoding. */
export function parseJsonText(text: string): unknown {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch (directError) {
    throw new GenerationFailure(
      "malformed_json",
      `Provider returned invalid JSON: ${directError instanceof Error ? directError.message : String(directError)}`,
      true,
    );
  }
}

export function malformedStructuredResponse(
  rawText: string,
  error: unknown,
  usage: StructuredResult<unknown>["usage"],
  truncated: boolean,
  structuredMode: StructuredResult<unknown>["structuredMode"],
  attemptMetadata?: ProviderAttemptMetadata,
): GenerationFailure {
  const message = truncated
    ? "Provider response was truncated before the root JSON value completed"
    : error instanceof GenerationFailure
      ? error.message
      : `Provider returned malformed root JSON: ${error instanceof Error ? error.message : String(error)}`;
  const failure = new GenerationFailure("malformed_json", message, true);
  attachStructuredFailure(failure, {
    rawText,
    parsedResponse: null,
    ...(usage ? { usage } : {}),
    ...(structuredMode ? { structuredMode } : {}),
    ...(attemptMetadata ? { attemptMetadata: { ...attemptMetadata, truncated } } : {}),
  });
  return failure;
}

export function validateStructured<T>(schema: z.ZodType<T>, value: unknown): T {
  const direct = schema.safeParse(value);
  if (direct.success) return direct.data;
  throw direct.error;
}

export function decodeStructured<T>(request: StructuredRequest<T>, value: unknown): T {
  const wire = validateStructured(request.wireSchema ?? request.schema, value);
  if (!request.decodeResponse) return validateStructured(request.schema, wire);
  try {
    return validateStructured(request.schema, request.decodeResponse(wire));
  } catch (error) {
    if (error instanceof GenerationFailure) throw error;
    const detail = error instanceof Error ? error.message : String(error);
    throw new GenerationFailure(
      "domain_decode_violation",
      `Structured response could not be decoded into the domain model: ${detail}`,
      true,
    );
  }
}

export function xaiReasoningOptions(model: string): Record<string, unknown> | undefined {
  // Grok 4.5 is always a reasoning model. xAI documents `high` as the
  // implicit default and does not support disabling reasoning, so request the
  // lowest available effort explicitly for latency-sensitive gameplay.
  if (/^grok-4\.5(?:-|$)/i.test(model)) return { reasoning_effort: "low" };
  // Grok 4.3 supports disabling reasoning entirely, which avoids paying the
  // latency and output-token cost of hidden reasoning during gameplay.
  if (/^grok-4\.3(?:-|$)/i.test(model)) return { reasoning_effort: "none" };
  return undefined;
}

export function openAiReasoningOptions(model: string): Record<string, unknown> | undefined {
  // GPT-5.6 is evaluated and used as a latency-sensitive narrative model.
  // Pin the whole family to no reasoning so model-tier comparisons do not
  // accidentally compare Sol's provider default against Terra/Luna at none.
  if (/^gpt-5\.6(?:-|$)/i.test(model)) return { reasoning_effort: "none" };
  // GPT-5.4 Mini defaults to no reasoning, but send the documented value
  // explicitly so gameplay latency and hidden-token spend cannot drift.
  if (/^gpt-5\.4-mini(?:-|$)/i.test(model)) return { reasoning_effort: "none" };
  // Nano supports no-reasoning mode as well; keep the low-cost model on its
  // latency-optimized path explicitly rather than relying on a provider default.
  if (/^gpt-5\.4-nano(?:-|$)/i.test(model)) return { reasoning_effort: "none" };
  return undefined;
}

export function redactSecrets(value: string, secrets: string[]): string {
  return secrets.reduce(
    (redacted, secret) => (secret ? redacted.replaceAll(secret, "[redacted]") : redacted),
    value,
  );
}

type TransportAbortCause = "cancelled" | "timeout";

interface ResponseDeadline {
  provider: string;
  timeoutMs: number | undefined;
  requestSignal: AbortSignal | undefined;
  timeoutController: AbortController | undefined;
  signal: AbortSignal | undefined;
  abortCause: TransportAbortCause | undefined;
  timeout: ReturnType<typeof setTimeout> | undefined;
  markCancelled: (() => void) | undefined;
  sourcesReleased: boolean;
}

const responseDeadlines = new WeakMap<Response, ResponseDeadline>();

function releaseDeadlineSources(deadline: ResponseDeadline): void {
  if (deadline.sourcesReleased) return;
  deadline.sourcesReleased = true;
  if (deadline.timeout !== undefined) {
    clearTimeout(deadline.timeout);
    deadline.timeout = undefined;
  }
  if (deadline.markCancelled !== undefined) {
    deadline.requestSignal?.removeEventListener("abort", deadline.markCancelled);
    deadline.markCancelled = undefined;
  }
}

function deadlineFailure(
  deadline: ResponseDeadline,
  provider = deadline.provider,
): GenerationFailure | undefined {
  if (
    deadline.abortCause === "cancelled" ||
    (deadline.requestSignal?.aborted && deadline.abortCause !== "timeout")
  ) {
    return cancelledGenerationFailure(provider);
  }
  if (deadline.abortCause === "timeout" || deadline.timeoutController?.signal.aborted) {
    return new GenerationFailure(
      "network",
      `${provider} request timed out after ${deadline.timeoutMs}ms`,
      true,
    );
  }
  return undefined;
}

function createResponseDeadline(
  provider: string,
  requestSignal: AbortSignal | undefined,
  timeoutMs: number | undefined,
): ResponseDeadline {
  const timeoutController = timeoutMs === undefined ? undefined : new AbortController();
  const deadline: ResponseDeadline = {
    provider,
    timeoutMs,
    requestSignal,
    timeoutController,
    signal: undefined,
    abortCause: undefined,
    timeout: undefined,
    markCancelled: undefined,
    sourcesReleased: false,
  };
  if (requestSignal !== undefined) {
    deadline.markCancelled = () => {
      deadline.abortCause ??= "cancelled";
      if (deadline.abortCause === "cancelled") releaseDeadlineSources(deadline);
    };
    requestSignal.addEventListener("abort", deadline.markCancelled, { once: true });
  }
  if (timeoutController !== undefined) {
    deadline.timeout = setTimeout(() => {
      deadline.timeout = undefined;
      deadline.abortCause ??= "timeout";
      if (deadline.abortCause !== "timeout") return;
      releaseDeadlineSources(deadline);
      timeoutController.abort();
    }, timeoutMs);
  }
  deadline.signal =
    timeoutController === undefined
      ? requestSignal
      : requestSignal === undefined
        ? timeoutController.signal
        : AbortSignal.any([requestSignal, timeoutController.signal]);
  return deadline;
}

function cancelLateResponseBody(response: Response): void {
  try {
    const cancellation = response.body?.cancel();
    if (cancellation !== undefined) void cancellation.catch(() => undefined);
  } catch {
    // A late response is already detached from its caller. Cleanup is best-effort.
  }
}

async function waitForFetchResponse(
  pending: Promise<Response>,
  deadline: ResponseDeadline,
): Promise<Response> {
  const signal = deadline.signal;
  if (signal === undefined) return pending;

  const beforeWait = deadlineFailure(deadline);
  if (beforeWait !== undefined) throw beforeWait;

  return new Promise<Response>((resolve, reject) => {
    let settled = false;
    const finish = (operation: () => void): boolean => {
      if (settled) return false;
      settled = true;
      signal.removeEventListener("abort", abort);
      operation();
      return true;
    };
    const abort = (): void => {
      finish(() =>
        reject(
          deadlineFailure(deadline) ??
            new GenerationFailure("network", `${deadline.provider} request was aborted`, true),
        ),
      );
    };

    signal.addEventListener("abort", abort, { once: true });
    void pending
      .then(
        (response) => {
          if (!finish(() => resolve(response))) cancelLateResponseBody(response);
        },
        (error: unknown) => {
          finish(() => reject(error));
        },
      )
      .catch(() => undefined);
    if (signal.aborted) abort();
  });
}

function bodySignal(
  deadline: ResponseDeadline | undefined,
  callerSignal: AbortSignal | undefined,
): AbortSignal | undefined {
  const transportSignal = deadline?.signal;
  if (transportSignal === undefined) return callerSignal;
  if (
    callerSignal === undefined ||
    transportSignal === callerSignal ||
    callerSignal === deadline?.requestSignal
  ) {
    return transportSignal;
  }
  return AbortSignal.any([transportSignal, callerSignal]);
}

function bodyAbortFailure(
  deadline: ResponseDeadline | undefined,
  provider: string,
  callerSignal: AbortSignal | undefined,
): GenerationFailure | undefined {
  const transportFailure = deadline === undefined ? undefined : deadlineFailure(deadline, provider);
  if (transportFailure !== undefined) return transportFailure;
  return callerSignal?.aborted ? cancelledGenerationFailure(provider) : undefined;
}

async function waitForResponseBody<T>(
  response: Response,
  provider: string,
  callerSignal: AbortSignal | undefined,
  read: () => Promise<T>,
): Promise<T> {
  const deadline = responseDeadlines.get(response);
  try {
    const beforeRead = bodyAbortFailure(deadline, provider, callerSignal);
    if (beforeRead !== undefined) throw beforeRead;
    const pending = read();
    const signal = bodySignal(deadline, callerSignal);
    const value =
      signal === undefined
        ? await pending
        : await new Promise<T>((resolve, reject) => {
            let settled = false;
            const finish = (operation: () => void): void => {
              if (settled) return;
              settled = true;
              signal.removeEventListener("abort", abort);
              operation();
            };
            const abort = (): void => {
              finish(() =>
                reject(
                  bodyAbortFailure(deadline, provider, callerSignal) ??
                    new GenerationFailure("network", `${provider} response body was aborted`, true),
                ),
              );
            };
            signal.addEventListener("abort", abort, { once: true });
            pending.then(
              (body) => finish(() => resolve(body)),
              (error: unknown) => finish(() => reject(error)),
            );
            if (signal.aborted) abort();
          });
    const afterRead = bodyAbortFailure(deadline, provider, callerSignal);
    if (afterRead !== undefined) throw afterRead;
    return value;
  } catch (error) {
    const abortFailure = bodyAbortFailure(deadline, provider, callerSignal);
    if (abortFailure !== undefined) throw abortFailure;
    throw error;
  } finally {
    responseDeadlines.delete(response);
    if (deadline !== undefined) releaseDeadlineSources(deadline);
  }
}

export async function readError(
  response: Response,
  provider: string,
  secrets: string[] = [],
  signal?: AbortSignal,
): Promise<string> {
  let text: string;
  try {
    text = await waitForResponseBody(response, provider, signal, () => response.text());
  } catch (error) {
    if (error instanceof GenerationFailure) throw error;
    if (signal?.aborted) throw cancelledGenerationFailure(provider);
    throw error;
  }
  if (signal?.aborted) throw cancelledGenerationFailure(provider);
  return (redactSecrets(text, secrets) || response.statusText).slice(0, 1000);
}

export async function safeFetch(
  fetchImpl: FetchLike,
  provider: string,
  url: string,
  init: RequestInit,
  secrets: string[],
  timeoutMs?: number,
): Promise<Response> {
  const requestSignal = init.signal ?? undefined;
  if (requestSignal?.aborted) throw cancelledGenerationFailure(provider);

  const deadline = createResponseDeadline(provider, requestSignal, timeoutMs);
  let responseReturned = false;
  try {
    const response = await waitForFetchResponse(
      fetchImpl(url, {
        ...init,
        ...(deadline.signal === undefined ? {} : { signal: deadline.signal }),
      }),
      deadline,
    );
    const failure = deadlineFailure(deadline);
    if (failure !== undefined) {
      cancelLateResponseBody(response);
      throw failure;
    }
    responseDeadlines.set(response, deadline);
    responseReturned = true;
    return response;
  } catch (error) {
    const detail = redactSecrets(error instanceof Error ? error.message : String(error), secrets);
    const failure = deadlineFailure(deadline);
    if (failure !== undefined) throw failure;
    throw new GenerationFailure("network", `${provider} network request failed: ${detail}`, true);
  } finally {
    if (!responseReturned) releaseDeadlineSources(deadline);
  }
}

export function httpFailure(provider: string, status: number, details: string): GenerationFailure {
  if (status === 429)
    return new GenerationFailure(
      "rate_limit",
      `${provider} request failed (${status}): ${details}`,
      true,
      status,
    );
  if (status >= 500)
    return new GenerationFailure(
      "network",
      `${provider} request failed (${status}): ${details}`,
      true,
      status,
    );
  if (
    status === 400 &&
    /schema|response[_ -]?format|output[_ -]?config|structured output|invalid.argument|invalid argument/i.test(
      details,
    )
  ) {
    return new GenerationFailure(
      "schema_rejected",
      `${provider} rejected the exact structured-output schema (${status}): ${details}`,
      false,
      status,
    );
  }
  return new GenerationFailure(
    "provider",
    `${provider} request failed (${status}): ${details}`,
    false,
    status,
  );
}

export function modelLeaf(model: string): string {
  return model.split("/").at(-1) ?? model;
}

export function deepSeekThinkingOptions(model: string): Record<string, unknown> | undefined {
  const leaf = modelLeaf(model).toLowerCase();
  if (leaf !== "deepseek-v4-flash" && leaf !== "deepseek-v4-pro") return undefined;
  return { thinking: { type: "disabled" } };
}

/** Conservative transport policy for model families that reject sampling controls. */
export function providerSupportsTemperature(provider: string, model: string): boolean {
  const leaf = modelLeaf(model);
  const openAiReasoningModel = /^(?:o\d(?:[-.]|$)|gpt-5(?:[-.]|$))/i.test(leaf);
  const deepSeekReasoningModel = /^deepseek-(?:reasoner(?:[-.]|$)|v4-)/i.test(leaf);
  const anthropicWithoutTemperature =
    /^claude-opus-4-8(?:[-.]|$)/i.test(leaf) || leaf.toLowerCase() === "claude-sonnet-5";
  if (provider === "openai") return !openAiReasoningModel;
  if (provider === "deepseek") return !deepSeekReasoningModel;
  if (provider === "anthropic") return !anthropicWithoutTemperature;
  if (provider === "openrouter") return !openAiReasoningModel && !deepSeekReasoningModel;
  return true;
}

export function requestTemperature(
  provider: string,
  model: string,
  value: number,
): number | undefined {
  if (!providerSupportsTemperature(provider, model)) return undefined;
  // The Messages API accepts 0..1, while the shared configuration allows 0..2.
  if (provider === "anthropic" && value > 1) return undefined;
  return value;
}

export function finiteNonnegativeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

export function finiteNonnegativeNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

export function chatUsage(value: unknown): StructuredResult<unknown>["usage"] {
  if (!isRecord(value)) return undefined;
  const inputTokens = finiteNonnegativeInteger(value.prompt_tokens);
  const outputTokens = finiteNonnegativeInteger(value.completion_tokens);
  const totalTokens = finiteNonnegativeInteger(value.total_tokens);
  const billedCostUsd = finiteNonnegativeNumber(value.cost);
  if (
    inputTokens === undefined &&
    outputTokens === undefined &&
    totalTokens === undefined &&
    billedCostUsd === undefined
  )
    return undefined;
  return {
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
    ...(totalTokens === undefined ? {} : { totalTokens }),
    ...(billedCostUsd === undefined ? {} : { billedCostUsd }),
  };
}

export const OPENAI_RATE_LIMIT_HEADERS = [
  "x-ratelimit-limit-requests",
  "x-ratelimit-limit-tokens",
  "x-ratelimit-remaining-requests",
  "x-ratelimit-remaining-tokens",
  "x-ratelimit-reset-requests",
  "x-ratelimit-reset-tokens",
] as const;

export function safeDiagnosticHeader(
  headers: Headers,
  name: string,
  maxLength: number,
  secrets: string[],
): string | undefined {
  const value = headers.get(name);
  if (!value || value.length > maxLength || !/^[\x20-\x7e]+$/.test(value)) return undefined;
  if (secrets.some((secret) => secret && value.includes(secret))) return undefined;
  return value;
}

export function assertProfileTarget(
  profile: FrozenModelExecutionProfile,
  provider: string,
  model: string,
): void {
  if (profile.fingerprint !== modelExecutionProfileFingerprint(profile)) {
    throw new GenerationFailure(
      "schema_rejected",
      `Execution profile ${profile.key.provider}/${profile.key.model} has a stale fingerprint`,
      false,
    );
  }
  if (profile.key.provider !== provider || profile.key.model !== model) {
    throw new GenerationFailure(
      "schema_rejected",
      `Execution profile ${profile.key.provider}/${profile.key.model} does not match ${provider}/${model}`,
      false,
    );
  }
}

export function requestedPhase(
  request: StructuredOutputBudgetRequest,
  profile?: FrozenModelExecutionProfile,
): ModelGenerationPhase | undefined {
  if (request.generationPhase !== undefined) return request.generationPhase;
  return profile === undefined ? undefined : "decision";
}

export function profileTemperature(profile: FrozenModelExecutionProfile): number | undefined {
  return profile.temperature.policy === "fixed" ? profile.temperature.value : undefined;
}

export function profileReasoningBody(
  profile: FrozenModelExecutionProfile,
  request: StructuredRequest<unknown>,
): Record<string, unknown> {
  const policy = profile.reasoning;
  if (policy.policy === "chat_reasoning_effort") return { reasoning_effort: policy.value };
  if (policy.policy === "openrouter_reasoning_effort")
    return { reasoning: { effort: policy.value } };
  if (policy.policy === "openrouter_reasoning_disabled") return { reasoning: { enabled: false } };
  if (policy.policy === "deepseek_thinking_disabled") return { thinking: { type: "disabled" } };
  if (policy.policy === "deepseek_thinking_for_repairs") {
    return {
      thinking: {
        type: requestedPhase(request, profile) === "repair" ? "enabled" : "disabled",
      },
    };
  }
  return {};
}

export function configuredOutputBudget(
  request: StructuredOutputBudgetRequest,
  defaults: Pick<ProviderConfig, "maxOutputTokens">,
  profile?: FrozenModelExecutionProfile,
): number {
  const phase = requestedPhase(request, profile);
  if (profile === undefined || phase === undefined) {
    const requested = request.maxOutputTokens ?? defaults.maxOutputTokens;
    return request.outputTokenCeiling === undefined
      ? requested
      : Math.min(requested, request.outputTokenCeiling);
  }
  const profiled = outputBudgetForPhase(profile, phase, request.repairOfPhase);
  return request.outputTokenCeiling === undefined
    ? profiled
    : Math.min(profiled, request.outputTokenCeiling);
}

export function configuredTimeout(
  request: StructuredRequest<unknown>,
  profile?: FrozenModelExecutionProfile,
): number | undefined {
  const phase = requestedPhase(request, profile);
  return profile === undefined || phase === undefined ? undefined : timeoutForPhase(profile, phase);
}

export function attemptMetadata(
  request: StructuredRequest<unknown>,
  provider: string,
  model: string,
  route: string,
  structuredMode: NonNullable<StructuredResult<unknown>["structuredMode"]>,
  schemaProjection: SchemaProjectionId,
  outputTokenField: OutputTokenField,
  outputTokenBudget: number,
  timeoutMs?: number,
  profile?: FrozenModelExecutionProfile,
): ProviderAttemptMetadata {
  const phase = requestedPhase(request, profile);
  return {
    provider,
    model,
    route,
    ...(phase === undefined ? {} : { generationPhase: phase }),
    attemptKind: request.attemptKind ?? "initial",
    ...(profile === undefined ? {} : { profileFingerprint: profile.fingerprint }),
    structuredMode,
    schemaProjection,
    outputTokenField,
    outputTokenBudget,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    retryBackoffMs: request.retryBackoffMs ?? 0,
    truncated: false,
  };
}

export function responseAttemptMetadata(
  metadata: ProviderAttemptMetadata,
  finishReason: string | undefined,
  truncated: boolean,
): ProviderAttemptMetadata {
  return {
    ...metadata,
    ...(finishReason === undefined ? {} : { finishReason }),
    truncated,
  };
}

export function openAiRequestDiagnostics(
  model: string,
  timestamp: string,
  clientRequestId: string,
  secrets: string[],
  response?: Response,
): ProviderRequestDiagnostics {
  const rateLimitHeaders = response
    ? Object.fromEntries(
        OPENAI_RATE_LIMIT_HEADERS.flatMap((name) => {
          const value = safeDiagnosticHeader(response.headers, name, 128, secrets);
          return value === undefined ? [] : [[name, value]];
        }),
      )
    : {};
  const requestId = response
    ? safeDiagnosticHeader(response.headers, "x-request-id", 512, secrets)
    : undefined;
  return {
    timestamp,
    provider: "openai",
    model,
    clientRequestId,
    ...(requestId === undefined ? {} : { requestId }),
    ...(response === undefined ? {} : { httpStatus: response.status }),
    ...(Object.keys(rateLimitHeaders).length === 0 ? {} : { rateLimitHeaders }),
  };
}

export function xaiChatUsage(value: unknown): StructuredResult<unknown>["usage"] {
  const usage = chatUsage(value);
  if (
    usage?.inputTokens === undefined ||
    usage.outputTokens === undefined ||
    usage.totalTokens === undefined
  )
    return usage;
  // xAI's Chat Completions envelope can report visible completion tokens
  // separately while total_tokens also includes billed hidden reasoning. Keep
  // the shared output total cost-complete without exposing reasoning content.
  const billedOutputTokens = usage.totalTokens - usage.inputTokens;
  return billedOutputTokens > usage.outputTokens
    ? { ...usage, outputTokens: billedOutputTokens }
    : usage;
}

export async function readResponseObject(
  response: Response,
  provider: string,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  let value: unknown;
  try {
    value = await waitForResponseBody(response, provider, signal, () => response.json());
  } catch (error) {
    if (error instanceof GenerationFailure) throw error;
    if (signal?.aborted) throw cancelledGenerationFailure(provider);
    throw new GenerationFailure(
      "provider",
      `${provider} returned a non-JSON response envelope`,
      false,
      response.status,
    );
  }
  if (signal?.aborted) throw cancelledGenerationFailure(provider);
  if (!isRecord(value)) {
    throw new GenerationFailure(
      "provider",
      `${provider} returned an invalid response envelope`,
      false,
      response.status,
    );
  }
  return value;
}

export function structuredContentBlock(
  provider: string,
  detail: string,
  rawText: string,
  usage: StructuredResult<unknown>["usage"],
  attemptMetadata?: ProviderAttemptMetadata,
): GenerationFailure {
  const failure = new GenerationFailure(
    "content_block",
    `${provider} refused or blocked the request: ${detail}`,
    false,
  );
  attachStructuredFailure(failure, {
    rawText,
    parsedResponse: null,
    structuredMode: "exact_schema",
    ...(usage ? { usage } : {}),
    ...(attemptMetadata ? { attemptMetadata } : {}),
  });
  return failure;
}

export interface ChatCompletionsOptions {
  id: string;
  label: string;
  model: string;
  apiKey: string;
  defaults: Pick<ProviderConfig, "temperature" | "maxOutputTokens">;
  endpoint: string;
  fetchImpl: FetchLike;
  headers?: Record<string, string>;
  extraBody?: Record<string, unknown>;
  maxTokensField: "max_tokens" | "max_completion_tokens";
  projectSchema?: (schema: Record<string, unknown>) => ProviderSchemaProjection;
  schemaProjection?: SchemaProjectionId;
  jsonObjectWithLocalSchema?: boolean;
  reinforceSchemaInSystem?: boolean;
  parseUsage?: (value: unknown) => StructuredResult<unknown>["usage"];
  executionProfile?: FrozenModelExecutionProfile;
}

export async function generateChatCompletions<T>(
  request: StructuredRequest<T>,
  options: ChatCompletionsOptions,
): Promise<StructuredResult<T>> {
  const exactSchema = request.jsonSchema ?? jsonSchemaFor(request.wireSchema ?? request.schema);
  const profile = options.executionProfile;
  if (profile) assertProfileTarget(profile, options.id, options.model);
  const projectionId =
    profile?.structuredOutput.projection ?? options.schemaProjection ?? "identity_v1";
  const projection = profile
    ? projectSchemaById(exactSchema, projectionId)
    : (options.projectSchema?.(exactSchema) ?? { schema: exactSchema });
  const jsonObjectWithLocalSchema = profile
    ? profile.structuredOutput.mode === "json_object_local_schema"
    : options.jsonObjectWithLocalSchema === true;
  const structuredMode = jsonObjectWithLocalSchema ? "json_object_local_schema" : "exact_schema";
  const secrets = [options.apiKey, encodeURIComponent(options.apiKey)];
  const diagnosticTimestamp = new Date().toISOString();
  const clientRequestId = options.id === "openai" ? randomUUID() : undefined;
  const temperature =
    profile === undefined
      ? requestTemperature(
          options.id,
          options.model,
          request.temperature ?? options.defaults.temperature,
        )
      : profileTemperature(profile);
  const outputTokenField = profile?.outputTokenField ?? options.maxTokensField;
  if (outputTokenField === "maxOutputTokens") {
    throw new GenerationFailure(
      "schema_rejected",
      "Chat Completions cannot use maxOutputTokens",
      false,
    );
  }
  const outputTokenBudget = configuredOutputBudget(request, options.defaults, profile);
  const timeoutMs = configuredTimeout(request, profile);
  const metadata = attemptMetadata(
    request,
    options.id,
    options.model,
    profile?.key.route ?? (options.id === "openrouter" ? "openrouter" : "direct"),
    structuredMode,
    projectionId,
    outputTokenField,
    outputTokenBudget,
    timeoutMs,
    profile,
  );
  const extraBody = { ...options.extraBody };
  if (profile) {
    delete extraBody.reasoning;
    delete extraBody.reasoning_effort;
    delete extraBody.thinking;
    delete extraBody.plugins;
  }
  const body: Record<string, unknown> = {
    model: options.model,
    messages: [
      {
        role: "system",
        content:
          jsonObjectWithLocalSchema || options.reinforceSchemaInSystem
            ? localSchemaSystemPrompt(
                request.system,
                options.label,
                request.schemaName,
                projection.schema,
              )
            : request.system,
      },
      { role: "user", content: request.prompt },
    ],
    ...(temperature === undefined ? {} : { temperature }),
    stream: false,
    response_format: jsonObjectWithLocalSchema
      ? { type: "json_object" }
      : {
          type: "json_schema",
          json_schema: {
            name: request.schemaName,
            strict: true,
            schema: projection.schema,
          },
        },
    ...extraBody,
    ...(profile === undefined ? {} : profileReasoningBody(profile, request)),
  };
  body[outputTokenField] = outputTokenBudget;

  try {
    const response = await safeFetch(
      options.fetchImpl,
      options.label,
      options.endpoint,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${options.apiKey}`,
          "Content-Type": "application/json",
          ...options.headers,
          ...(clientRequestId === undefined ? {} : { "X-Client-Request-Id": clientRequestId }),
        },
        body: JSON.stringify(body),
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      },
      secrets,
      timeoutMs,
    );
    const requestDiagnostics =
      clientRequestId === undefined
        ? undefined
        : openAiRequestDiagnostics(
            options.model,
            diagnosticTimestamp,
            clientRequestId,
            secrets,
            response,
          );

    try {
      if (!response.ok)
        throw httpFailure(
          options.label,
          response.status,
          await readError(response, options.label, secrets, request.signal),
        );
      const envelope = await readResponseObject(response, options.label, request.signal);
      const choices = Array.isArray(envelope.choices) ? envelope.choices : [];
      const choice = isRecord(choices[0]) ? choices[0] : undefined;
      const message = isRecord(choice?.message) ? choice.message : undefined;
      const finishReason =
        typeof choice?.finish_reason === "string" ? choice.finish_reason : undefined;
      const responseMetadata = responseAttemptMetadata(
        metadata,
        finishReason,
        finishReason === "length",
      );
      const usage = (options.parseUsage ?? chatUsage)(envelope.usage);
      const refusal =
        typeof message?.refusal === "string"
          ? redactSecrets(message.refusal, secrets).slice(0, 1000)
          : undefined;
      if (refusal) throw structuredContentBlock(options.label, refusal, refusal, usage);
      if (finishReason === "content_filter") {
        throw structuredContentBlock(options.label, "content filter", "", usage);
      }
      const content = typeof message?.content === "string" ? message.content : undefined;
      if (!content) {
        if (finishReason === "length") {
          throw malformedStructuredResponse(
            "",
            new Error(`${options.label} exhausted its output limit before returning JSON`),
            usage,
            true,
            structuredMode,
            responseMetadata,
          );
        }
        throw new GenerationFailure(
          "provider",
          `${options.label} returned no message content (${finishReason ?? "unknown reason"})`,
          false,
        );
      }

      let parsed: unknown;
      try {
        parsed = parseJsonText(content);
      } catch (error) {
        throw malformedStructuredResponse(
          content,
          error,
          usage,
          finishReason === "length",
          structuredMode,
          responseMetadata,
        );
      }
      try {
        const data = decodeStructured(request, projection.normalize?.(parsed) ?? parsed);
        return {
          data,
          provider: options.id,
          model: options.model,
          rawText: content,
          structuredMode,
          ...(request.protocolVersion === undefined
            ? {}
            : { protocolVersion: request.protocolVersion }),
          ...(usage ? { usage } : {}),
          ...(requestDiagnostics === undefined ? {} : { requestDiagnostics }),
          attemptMetadata: responseMetadata,
        };
      } catch (error) {
        attachStructuredFailure(error, {
          rawText: content,
          parsedResponse: parsed,
          structuredMode,
          ...(usage ? { usage } : {}),
          attemptMetadata: responseMetadata,
        });
        throw error;
      }
    } catch (error) {
      if (requestDiagnostics !== undefined) attachRequestDiagnostics(error, requestDiagnostics);
      attachAttemptMetadata(error, metadata);
      throw error;
    }
  } catch (error) {
    if (clientRequestId !== undefined) {
      attachRequestDiagnostics(
        error,
        openAiRequestDiagnostics(options.model, diagnosticTimestamp, clientRequestId, secrets),
      );
    }
    attachAttemptMetadata(error, metadata);
    throw error;
  }
}
