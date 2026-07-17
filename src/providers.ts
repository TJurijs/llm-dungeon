import { readFile } from "node:fs/promises";
import { z } from "zod";
import { ProviderConfigSchema, type ProviderConfig } from "./schemas.js";
import { GenerationFailure } from "./llm/failures.js";
import { attachStructuredFailure } from "./llm/structured-error.js";
import type { LlmProvider, StructuredRequest, StructuredResult } from "./types.js";

type FetchLike = typeof fetch;

/** Increment when provider transport or schema projection changes compatibility. */
export const PROVIDER_ADAPTER_COMPATIBILITY_REVISION = 3 as const;

function parseJsonText(text: string): unknown {
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

function malformedStructuredResponse(
  rawText: string,
  error: unknown,
  usage: StructuredResult<unknown>["usage"],
  truncated: boolean,
  structuredMode: StructuredResult<unknown>["structuredMode"],
): GenerationFailure {
  const message = truncated
    ? "Provider response was truncated before the root JSON value completed"
    : error instanceof GenerationFailure ? error.message : `Provider returned malformed root JSON: ${error instanceof Error ? error.message : String(error)}`;
  const failure = new GenerationFailure("malformed_json", message, true);
  attachStructuredFailure(failure, {
    rawText,
    parsedResponse: null,
    ...(usage ? { usage } : {}),
    ...(structuredMode ? { structuredMode } : {}),
  });
  return failure;
}

function validateStructured<T>(schema: z.ZodType<T>, value: unknown): T {
  const direct = schema.safeParse(value);
  if (direct.success) return direct.data;
  throw direct.error;
}

function decodeStructured<T>(request: StructuredRequest<T>, value: unknown): T {
  const wire = validateStructured(request.wireSchema ?? request.schema, value);
  if (!request.decodeResponse) return validateStructured(request.schema, wire);
  try {
    return validateStructured(request.schema, request.decodeResponse(wire));
  } catch (error) {
    if (error instanceof GenerationFailure) throw error;
    const detail = error instanceof Error ? error.message : String(error);
    throw new GenerationFailure("domain_decode_violation", `Structured response could not be decoded into the domain model: ${detail}`, true);
  }
}

function jsonSchemaFor<T>(schema: z.ZodType<T>): Record<string, unknown> {
  return z.toJSONSchema(schema, { target: "draft-7" }) as Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

interface ProviderSchemaProjection {
  schema: Record<string, unknown>;
  normalize?: (value: unknown) => unknown;
}

/**
 * OpenAI strict structured outputs require every object property to be listed
 * in `required`. Optional application fields are represented as nullable on
 * the wire, then deterministically restored to omission before authoritative
 * local validation. Gameplay Contract V1 has no optional wire fields, so its
 * schema and decoded value pass through unchanged.
 */
function projectOpenAiStrictSchema(schema: Record<string, unknown>): ProviderSchemaProjection {
  const unsupportedAnnotations = new Set(["$schema", "default", "examples", "minLength", "maxLength"]);

  function project(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(project);
    if (!isRecord(value)) return value;

    const output: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      if (unsupportedAnnotations.has(key)) continue;
      if (key === "properties" && isRecord(item)) {
        output.properties = Object.fromEntries(
          Object.entries(item).map(([name, propertySchema]) => [name, project(propertySchema)]),
        );
        continue;
      }
      if (key === "$defs" && isRecord(item)) {
        output.$defs = Object.fromEntries(
          Object.entries(item).map(([name, definition]) => [name, project(definition)]),
        );
        continue;
      }
      output[key] = project(item);
    }

    if (isRecord(value.properties)) {
      const required = new Set(Array.isArray(value.required) ? value.required.filter((item): item is string => typeof item === "string") : []);
      const properties = output.properties as Record<string, unknown>;
      for (const name of Object.keys(value.properties)) {
        if (!required.has(name)) {
          properties[name] = { anyOf: [properties[name], { type: "null" }] };
        }
      }
      output.required = Object.keys(value.properties);
      output.additionalProperties = false;
    }
    return output;
  }

  function restoreOptionalOmissions(value: unknown, sourceSchema: unknown): unknown {
    if (!isRecord(sourceSchema)) return value;
    if (Array.isArray(value)) {
      return value.map((item) => restoreOptionalOmissions(item, sourceSchema.items));
    }
    if (!isRecord(value) || !isRecord(sourceSchema.properties)) return value;

    const required = new Set(Array.isArray(sourceSchema.required)
      ? sourceSchema.required.filter((item): item is string => typeof item === "string")
      : []);
    const restored: Record<string, unknown> = { ...value };
    for (const [name, propertySchema] of Object.entries(sourceSchema.properties)) {
      if (!required.has(name) && restored[name] === null) {
        delete restored[name];
      } else if (name in restored) {
        restored[name] = restoreOptionalOmissions(restored[name], propertySchema);
      }
    }
    return restored;
  }

  return {
    schema: project(schema) as Record<string, unknown>,
    normalize: (value) => restoreOptionalOmissions(value, schema),
  };
}

const ANTHROPIC_UNSUPPORTED_SCHEMA_KEYWORDS = new Set([
  "$schema",
  "default",
  "examples",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "minLength",
  "maxLength",
  "pattern",
  "maxItems",
  "uniqueItems",
  "minProperties",
  "maxProperties",
]);

const ANTHROPIC_SUPPORTED_STRING_FORMATS = new Set([
  "date-time",
  "time",
  "date",
  "duration",
  "email",
  "hostname",
  "uri",
  "ipv4",
  "ipv6",
  "uuid",
]);

/** Provider projection follows Anthropic's documented SDK transformation. */
function sanitizeAnthropicSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeAnthropicSchema);
  if (!isRecord(value)) return value;

  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (ANTHROPIC_UNSUPPORTED_SCHEMA_KEYWORDS.has(key)) continue;
    if (key === "format" && (typeof item !== "string" || !ANTHROPIC_SUPPORTED_STRING_FORMATS.has(item))) continue;
    if (key === "minItems" && item !== 0 && item !== 1) continue;
    if ((key === "properties" || key === "$defs") && isRecord(item)) {
      output[key] = Object.fromEntries(
        Object.entries(item).map(([name, schema]) => [name, sanitizeAnthropicSchema(schema)]),
      );
      continue;
    }
    output[key] = sanitizeAnthropicSchema(item);
  }
  if (isRecord(value.properties) && output.additionalProperties === undefined) {
    output.additionalProperties = false;
  }
  return output;
}

const GEMINI_SCHEMA_KEYWORDS = new Set([
  "$id",
  "$defs",
  "$ref",
  "$anchor",
  "type",
  "format",
  "title",
  "description",
  "enum",
  "items",
  "prefixItems",
  "minItems",
  "maxItems",
  "minimum",
  "maximum",
  "anyOf",
  "oneOf",
  "properties",
  "additionalProperties",
  "required",
  "propertyOrdering",
]);

function sanitizeGeminiSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeGeminiSchema);
  if (!value || typeof value !== "object") return value;

  const input = value as Record<string, unknown>;
  const output: Record<string, unknown> = {};

  for (const [key, item] of Object.entries(input)) {
    // Gemini multiplies nested schema complexity by maxItems and can reject
    // otherwise supported object schemas. Cardinality remains authoritative in
    // the local Zod validator for every request.
    if (key === "maxItems") continue;
    // A literal is represented as `const` by Zod, while Gemini supports `enum`.
    if (key === "const" && input.enum === undefined) {
      output.enum = [item];
      continue;
    }
    if (!GEMINI_SCHEMA_KEYWORDS.has(key)) continue;

    // Keys inside these maps are user-defined names, not schema keywords.
    if ((key === "properties" || key === "$defs") && item && typeof item === "object" && !Array.isArray(item)) {
      output[key] = Object.fromEntries(
        Object.entries(item as Record<string, unknown>).map(([name, schema]) => [name, sanitizeGeminiSchema(schema)]),
      );
      continue;
    }

    output[key] = sanitizeGeminiSchema(item);
  }

  return output;
}

function routesToGemini(model: string): boolean {
  return /(?:^|\/)gemini(?:-|$)/i.test(model);
}

function redactSecrets(value: string, secrets: string[]): string {
  return secrets.reduce(
    (redacted, secret) => secret ? redacted.replaceAll(secret, "[redacted]") : redacted,
    value,
  );
}

async function readError(response: Response, secrets: string[] = []): Promise<string> {
  const text = await response.text();
  return (redactSecrets(text, secrets) || response.statusText).slice(0, 1000);
}

async function safeFetch(
  fetchImpl: FetchLike,
  provider: string,
  url: string,
  init: RequestInit,
  secrets: string[],
): Promise<Response> {
  try {
    return await fetchImpl(url, init);
  } catch (error) {
    const detail = redactSecrets(error instanceof Error ? error.message : String(error), secrets);
    throw new GenerationFailure("network", `${provider} network request failed: ${detail}`, true);
  }
}

function httpFailure(provider: string, status: number, details: string): GenerationFailure {
  if (status === 429) return new GenerationFailure("rate_limit", `${provider} request failed (${status}): ${details}`, true, status);
  if (status >= 500) return new GenerationFailure("network", `${provider} request failed (${status}): ${details}`, true, status);
  if (status === 400 && /schema|response[_ -]?format|output[_ -]?config|structured output|invalid.argument|invalid argument/i.test(details)) {
    return new GenerationFailure("schema_rejected", `${provider} rejected the exact structured-output schema (${status}): ${details}`, false, status);
  }
  return new GenerationFailure("provider", `${provider} request failed (${status}): ${details}`, false, status);
}

function modelLeaf(model: string): string {
  return model.split("/").at(-1) ?? model;
}

/** Conservative transport policy for model families that reject sampling controls. */
export function providerSupportsTemperature(provider: string, model: string): boolean {
  const leaf = modelLeaf(model);
  const openAiReasoningModel = /^(?:o\d(?:[-.]|$)|gpt-5(?:[-.]|$))/i.test(leaf);
  const deepSeekReasoningModel = /^deepseek-(?:reasoner(?:[-.]|$)|v4-)/i.test(leaf);
  const anthropicWithoutTemperature = /^claude-opus-4-8(?:[-.]|$)/i.test(leaf);
  if (provider === "openai") return !openAiReasoningModel;
  if (provider === "deepseek") return !deepSeekReasoningModel;
  if (provider === "anthropic") return !anthropicWithoutTemperature;
  if (provider === "openrouter") return !openAiReasoningModel && !deepSeekReasoningModel;
  return true;
}

function requestTemperature(
  provider: string,
  model: string,
  value: number,
): number | undefined {
  if (!providerSupportsTemperature(provider, model)) return undefined;
  // The Messages API accepts 0..1, while the shared configuration allows 0..2.
  if (provider === "anthropic" && value > 1) return undefined;
  return value;
}

function finiteNonnegativeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function finiteNonnegativeNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function chatUsage(value: unknown): StructuredResult<unknown>["usage"] {
  if (!isRecord(value)) return undefined;
  const inputTokens = finiteNonnegativeInteger(value.prompt_tokens);
  const outputTokens = finiteNonnegativeInteger(value.completion_tokens);
  const totalTokens = finiteNonnegativeInteger(value.total_tokens);
  const billedCostUsd = finiteNonnegativeNumber(value.cost);
  if (inputTokens === undefined && outputTokens === undefined && totalTokens === undefined && billedCostUsd === undefined) return undefined;
  return {
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
    ...(totalTokens === undefined ? {} : { totalTokens }),
    ...(billedCostUsd === undefined ? {} : { billedCostUsd }),
  };
}

async function readResponseObject(response: Response, provider: string): Promise<Record<string, unknown>> {
  let value: unknown;
  try {
    value = await response.json();
  } catch {
    throw new GenerationFailure("provider", `${provider} returned a non-JSON response envelope`, false, response.status);
  }
  if (!isRecord(value)) {
    throw new GenerationFailure("provider", `${provider} returned an invalid response envelope`, false, response.status);
  }
  return value;
}

function structuredContentBlock(
  provider: string,
  detail: string,
  rawText: string,
  usage: StructuredResult<unknown>["usage"],
): GenerationFailure {
  const failure = new GenerationFailure("content_block", `${provider} refused or blocked the request: ${detail}`, false);
  attachStructuredFailure(failure, {
    rawText,
    parsedResponse: null,
    structuredMode: "exact_schema",
    ...(usage ? { usage } : {}),
  });
  return failure;
}

interface ChatCompletionsOptions {
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
  jsonObjectWithLocalSchema?: boolean;
  reinforceSchemaInSystem?: boolean;
}

function jsonExampleForSchema(schema: unknown): unknown {
  if (!isRecord(schema)) return null;
  if ("const" in schema) return schema.const;
  if (Array.isArray(schema.enum) && schema.enum.length > 0) return schema.enum[0];
  if (Array.isArray(schema.anyOf) && schema.anyOf.length > 0) {
    const preferred = schema.anyOf.find((entry) => !isRecord(entry) || entry.type !== "null") ?? schema.anyOf[0];
    return jsonExampleForSchema(preferred);
  }
  if (schema.type === "object" || isRecord(schema.properties)) {
    const properties = isRecord(schema.properties) ? schema.properties : {};
    const required = new Set(Array.isArray(schema.required)
      ? schema.required.filter((name): name is string => typeof name === "string")
      : Object.keys(properties));
    return Object.fromEntries(Object.entries(properties)
      .filter(([name]) => required.has(name))
      .map(([name, propertySchema]) => [name, jsonExampleForSchema(propertySchema)]));
  }
  if (schema.type === "array") {
    const count = typeof schema.minItems === "number" && schema.minItems > 0 ? Math.ceil(schema.minItems) : 0;
    return Array.from({ length: count }, () => jsonExampleForSchema(schema.items));
  }
  if (schema.type === "integer" || schema.type === "number") {
    return typeof schema.minimum === "number" ? schema.minimum : 0;
  }
  if (schema.type === "boolean") return false;
  if (schema.type === "string") {
    const length = typeof schema.minLength === "number" && schema.minLength > 0 ? Math.ceil(schema.minLength) : 0;
    return "x".repeat(length);
  }
  return null;
}

function localSchemaSystemPrompt(
  original: string,
  provider: string,
  schemaName: string,
  schema: Record<string, unknown>,
): string {
  return `${original}\n\n${provider.toUpperCase()} JSON OUTPUT CONTRACT\nReturn exactly one valid JSON object and no other text. Do not use Markdown fences. The JSON object is validated locally against the complete schema below; include every required field, use only documented fields, and obey all enum and numeric constraints.\nSchema name: ${schemaName}\nJSON Schema: ${JSON.stringify(schema)}\nExample JSON object with the required shape: ${JSON.stringify(jsonExampleForSchema(schema))}`;
}

async function generateChatCompletions<T>(
  request: StructuredRequest<T>,
  options: ChatCompletionsOptions,
): Promise<StructuredResult<T>> {
  const exactSchema = request.jsonSchema ?? jsonSchemaFor(request.wireSchema ?? request.schema);
  const projection = options.projectSchema?.(exactSchema) ?? { schema: exactSchema };
  const structuredMode = options.jsonObjectWithLocalSchema ? "json_object_local_schema" : "exact_schema";
  const secrets = [options.apiKey, encodeURIComponent(options.apiKey)];
  const temperature = requestTemperature(
    options.id,
    options.model,
    request.temperature ?? options.defaults.temperature,
  );
  const body: Record<string, unknown> = {
    model: options.model,
    messages: [
      {
        role: "system",
        content: options.jsonObjectWithLocalSchema || options.reinforceSchemaInSystem
          ? localSchemaSystemPrompt(request.system, options.label, request.schemaName, projection.schema)
          : request.system,
      },
      { role: "user", content: request.prompt },
    ],
    ...(temperature === undefined ? {} : { temperature }),
    stream: false,
    response_format: options.jsonObjectWithLocalSchema
      ? { type: "json_object" }
      : {
          type: "json_schema",
          json_schema: {
            name: request.schemaName,
            strict: true,
            schema: projection.schema,
          },
        },
    ...options.extraBody,
  };
  body[options.maxTokensField] = request.maxOutputTokens ?? options.defaults.maxOutputTokens;

  const response = await safeFetch(options.fetchImpl, options.label, options.endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${options.apiKey}`,
      "Content-Type": "application/json",
      ...options.headers,
    },
    body: JSON.stringify(body),
  }, secrets);

  if (!response.ok) throw httpFailure(options.label, response.status, await readError(response, secrets));
  const envelope = await readResponseObject(response, options.label);
  const choices = Array.isArray(envelope.choices) ? envelope.choices : [];
  const choice = isRecord(choices[0]) ? choices[0] : undefined;
  const message = isRecord(choice?.message) ? choice.message : undefined;
  const finishReason = typeof choice?.finish_reason === "string" ? choice.finish_reason : undefined;
  const usage = chatUsage(envelope.usage);
  const refusal = typeof message?.refusal === "string" ? redactSecrets(message.refusal, secrets).slice(0, 1000) : undefined;
  if (refusal) throw structuredContentBlock(options.label, refusal, refusal, usage);
  if (finishReason === "content_filter") {
    throw structuredContentBlock(options.label, "content filter", "", usage);
  }
  const content = typeof message?.content === "string" ? message.content : undefined;
  if (!content) {
    if (finishReason === "length") {
      throw malformedStructuredResponse("", new Error(`${options.label} exhausted its output limit before returning JSON`), usage, true, structuredMode);
    }
    throw new GenerationFailure("provider", `${options.label} returned no message content (${finishReason ?? "unknown reason"})`, false);
  }

  let parsed: unknown;
  try {
    parsed = parseJsonText(content);
  } catch (error) {
    throw malformedStructuredResponse(content, error, usage, finishReason === "length", structuredMode);
  }
  try {
    const data = decodeStructured(request, projection.normalize?.(parsed) ?? parsed);
    return {
      data,
      provider: options.id,
      model: options.model,
      rawText: content,
      structuredMode,
      ...(request.protocolVersion === undefined ? {} : { protocolVersion: request.protocolVersion }),
      ...(usage ? { usage } : {}),
    };
  } catch (error) {
    attachStructuredFailure(error, {
      rawText: content,
      parsedResponse: parsed,
      structuredMode,
      ...(usage ? { usage } : {}),
    });
    throw error;
  }
}

export class OpenRouterProvider implements LlmProvider {
  readonly id = "openrouter";

  constructor(
    readonly model: string,
    private readonly apiKey: string,
    private readonly defaults: Pick<ProviderConfig, "temperature" | "maxOutputTokens">,
    private readonly endpoint = "https://openrouter.ai/api/v1/chat/completions",
    private readonly fetchImpl: FetchLike = fetch,
  ) {}

  async generateStructured<T>(request: StructuredRequest<T>): Promise<StructuredResult<T>> {
    return generateChatCompletions(request, {
      id: this.id,
      label: "OpenRouter",
      model: this.model,
      apiKey: this.apiKey,
      defaults: this.defaults,
      endpoint: this.endpoint,
      fetchImpl: this.fetchImpl,
      headers: {
        "HTTP-Referer": "https://github.com/llm-dungeon",
        "X-Title": "llm-dungeon",
      },
      extraBody: {
        provider: { require_parameters: true },
        // Kimi enables reasoning by default and counts it against max_tokens.
        // It also intermittently wraps structured output in Markdown, which
        // OpenRouter's non-streaming response healer normalizes before our
        // authoritative strict decoder validates the complete schema.
        ...(this.model === "moonshotai/kimi-k2.6" ? {
          reasoning: { effort: "none" },
          plugins: [{ id: "response-healing" }],
        } : {}),
      },
      maxTokensField: "max_tokens",
      // OpenRouter forwards schema constraints to the selected upstream model.
      // Gemini routes need the same projection as the direct Gemini adapter.
      projectSchema: (schema) => ({ schema: routesToGemini(this.model) ? sanitizeGeminiSchema(schema) as Record<string, unknown> : schema }),
      reinforceSchemaInSystem: this.model === "moonshotai/kimi-k2.6",
    });
  }
}

export class OpenAIProvider implements LlmProvider {
  readonly id = "openai";

  constructor(
    readonly model: string,
    private readonly apiKey: string,
    private readonly defaults: Pick<ProviderConfig, "temperature" | "maxOutputTokens">,
    private readonly endpoint = "https://api.openai.com/v1/chat/completions",
    private readonly fetchImpl: FetchLike = fetch,
  ) {}

  async generateStructured<T>(request: StructuredRequest<T>): Promise<StructuredResult<T>> {
    return generateChatCompletions(request, {
      id: this.id,
      label: "OpenAI",
      model: this.model,
      apiKey: this.apiKey,
      defaults: this.defaults,
      endpoint: this.endpoint,
      fetchImpl: this.fetchImpl,
      maxTokensField: "max_completion_tokens",
      projectSchema: projectOpenAiStrictSchema,
    });
  }
}

export class DeepSeekProvider implements LlmProvider {
  readonly id = "deepseek";

  constructor(
    readonly model: string,
    private readonly apiKey: string,
    private readonly defaults: Pick<ProviderConfig, "temperature" | "maxOutputTokens">,
    private readonly endpoint = "https://api.deepseek.com/chat/completions",
    private readonly fetchImpl: FetchLike = fetch,
  ) {}

  async generateStructured<T>(request: StructuredRequest<T>): Promise<StructuredResult<T>> {
    return generateChatCompletions(request, {
      id: this.id,
      label: "DeepSeek",
      model: this.model,
      apiKey: this.apiKey,
      defaults: this.defaults,
      endpoint: this.endpoint,
      fetchImpl: this.fetchImpl,
      maxTokensField: "max_tokens",
      jsonObjectWithLocalSchema: true,
    });
  }
}

function anthropicUsage(value: unknown): StructuredResult<unknown>["usage"] {
  if (!isRecord(value)) return undefined;
  const inputTokens = finiteNonnegativeInteger(value.input_tokens);
  const outputTokens = finiteNonnegativeInteger(value.output_tokens);
  if (inputTokens === undefined && outputTokens === undefined) return undefined;
  return {
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
    ...(inputTokens === undefined || outputTokens === undefined ? {} : { totalTokens: inputTokens + outputTokens }),
  };
}

export class AnthropicProvider implements LlmProvider {
  readonly id = "anthropic";

  constructor(
    readonly model: string,
    private readonly apiKey: string,
    private readonly defaults: Pick<ProviderConfig, "temperature" | "maxOutputTokens">,
    private readonly endpoint = "https://api.anthropic.com/v1/messages",
    private readonly fetchImpl: FetchLike = fetch,
  ) {}

  async generateStructured<T>(request: StructuredRequest<T>): Promise<StructuredResult<T>> {
    const exactSchema = request.jsonSchema ?? jsonSchemaFor(request.wireSchema ?? request.schema);
    const outputSchema = sanitizeAnthropicSchema(exactSchema) as Record<string, unknown>;
    const secrets = [this.apiKey, encodeURIComponent(this.apiKey)];
    const temperature = requestTemperature(
      this.id,
      this.model,
      request.temperature ?? this.defaults.temperature,
    );
    const response = await safeFetch(this.fetchImpl, "Anthropic", this.endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": this.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: this.model,
        system: request.system,
        messages: [{ role: "user", content: request.prompt }],
        max_tokens: request.maxOutputTokens ?? this.defaults.maxOutputTokens,
        ...(temperature === undefined ? {} : { temperature }),
        output_config: {
          format: {
            type: "json_schema",
            schema: outputSchema,
          },
        },
      }),
    }, secrets);

    if (!response.ok) throw httpFailure("Anthropic", response.status, await readError(response, secrets));
    const envelope = await readResponseObject(response, "Anthropic");
    const usage = anthropicUsage(envelope.usage);
    const stopReason = typeof envelope.stop_reason === "string" ? envelope.stop_reason : undefined;
    const blocks = Array.isArray(envelope.content) ? envelope.content : [];
    const content = blocks
      .filter((block): block is Record<string, unknown> => isRecord(block) && block.type === "text")
      .map((block) => typeof block.text === "string" ? block.text : "")
      .join("");
    if (stopReason === "refusal") {
      const refusal = redactSecrets(content || "safety refusal", secrets).slice(0, 1000);
      throw structuredContentBlock("Anthropic", refusal, refusal, usage);
    }
    if (!content) {
      if (stopReason === "max_tokens") {
        throw malformedStructuredResponse("", new Error("Anthropic exhausted max_tokens before returning JSON"), usage, true, "exact_schema");
      }
      throw new GenerationFailure("provider", `Anthropic returned no text content (${stopReason ?? "unknown reason"})`, false);
    }

    let parsed: unknown;
    try {
      parsed = parseJsonText(content);
    } catch (error) {
      throw malformedStructuredResponse(content, error, usage, stopReason === "max_tokens", "exact_schema");
    }
    try {
      const data = decodeStructured(request, parsed);
      return {
        data,
        provider: this.id,
        model: this.model,
        rawText: content,
        structuredMode: "exact_schema",
        ...(request.protocolVersion === undefined ? {} : { protocolVersion: request.protocolVersion }),
        ...(usage ? { usage } : {}),
      };
    } catch (error) {
      attachStructuredFailure(error, {
        rawText: content,
        parsedResponse: parsed,
        structuredMode: "exact_schema",
        ...(usage ? { usage } : {}),
      });
      throw error;
    }
  }
}

export class GeminiProvider implements LlmProvider {
  readonly id = "gemini";

  constructor(
    readonly model: string,
    private readonly apiKey: string,
    private readonly defaults: Pick<ProviderConfig, "temperature" | "maxOutputTokens">,
    private readonly endpoint = "https://generativelanguage.googleapis.com/v1beta",
    private readonly fetchImpl: FetchLike = fetch,
  ) {}

  async generateStructured<T>(request: StructuredRequest<T>): Promise<StructuredResult<T>> {
    const url = `${this.endpoint.replace(/\/$/, "")}/models/${encodeURIComponent(this.model)}:generateContent`;
    const outputSchema = sanitizeGeminiSchema(request.jsonSchema ?? jsonSchemaFor(request.wireSchema ?? request.schema));
    const secrets = [this.apiKey, encodeURIComponent(this.apiKey)];
    const response = await safeFetch(this.fetchImpl, "Gemini", url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": this.apiKey },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: request.system }] },
        contents: [{ role: "user", parts: [{ text: request.prompt }] }],
        generationConfig: {
          temperature: request.temperature ?? this.defaults.temperature,
          maxOutputTokens: request.maxOutputTokens ?? this.defaults.maxOutputTokens,
          ...(/^gemini-3(?:\.|-)/i.test(this.model) ? { thinkingConfig: { thinkingLevel: "low" } } : {}),
          responseFormat: {
            text: {
              mimeType: "APPLICATION_JSON",
              schema: outputSchema,
            },
          },
        },
      }),
    }, secrets);

    if (!response.ok) {
      throw httpFailure("Gemini", response.status, await readError(response, secrets));
    }
    const body = (await response.json()) as {
      candidates?: Array<{ finishReason?: string; content?: { parts?: Array<{ text?: string; thought?: boolean }> } }>;
      usageMetadata?: {
        promptTokenCount?: number;
        candidatesTokenCount?: number;
        thoughtsTokenCount?: number;
        totalTokenCount?: number;
      };
    };
    const candidate = body.candidates?.[0];
    const content = candidate?.content?.parts
      ?.filter((part) => part.thought !== true)
      .map((part) => part.text ?? "")
      .join("");
    const metadata = body.usageMetadata;
    const billedOutputTokens = metadata?.candidatesTokenCount === undefined && metadata?.thoughtsTokenCount === undefined
      ? undefined
      : (metadata?.candidatesTokenCount ?? 0) + (metadata?.thoughtsTokenCount ?? 0);
    const usage = metadata
      ? {
          ...(metadata.promptTokenCount === undefined ? {} : { inputTokens: metadata.promptTokenCount }),
          ...(billedOutputTokens === undefined ? {} : { outputTokens: billedOutputTokens }),
          ...(metadata.totalTokenCount === undefined ? {} : { totalTokens: metadata.totalTokenCount }),
        }
      : undefined;
    if (!content) {
      const blocked = candidate?.finishReason && /SAFETY|BLOCK/i.test(candidate.finishReason);
      if (candidate?.finishReason === "MAX_TOKENS") {
        throw malformedStructuredResponse("", new Error("Gemini exhausted maxOutputTokens before returning JSON"), usage, true, "exact_schema");
      }
      throw new GenerationFailure(blocked ? "content_block" : "provider", `Gemini returned no message content (${candidate?.finishReason ?? "unknown reason"})`, false);
    }
    let parsed: unknown;
    try {
      parsed = parseJsonText(content);
    } catch (error) {
      throw malformedStructuredResponse(content, error, usage, candidate?.finishReason === "MAX_TOKENS", "exact_schema");
    }
    try {
      const data = decodeStructured(request, parsed);
      return {
        data, provider: this.id, model: this.model, rawText: content, structuredMode: "exact_schema",
        ...(request.protocolVersion === undefined ? {} : { protocolVersion: request.protocolVersion }),
        ...(usage ? { usage } : {}),
      };
    } catch (error) {
      attachStructuredFailure(error, { rawText: content, parsedResponse: parsed, structuredMode: "exact_schema", ...(usage ? { usage } : {}) });
      throw error;
    }
  }
}

export async function loadProviderConfig(configPath: string): Promise<ProviderConfig> {
  const raw = await readFile(configPath, "utf8");
  return ProviderConfigSchema.parse(JSON.parse(raw));
}

export function createProvider(
  config: ProviderConfig,
  environment: NodeJS.ProcessEnv = process.env,
  fetchImpl: FetchLike = fetch,
): LlmProvider {
  switch (config.provider) {
    case "openrouter": {
      const key = environment.OPENROUTER_API_KEY;
      if (!key) throw new Error("OPENROUTER_API_KEY is not set");
      return new OpenRouterProvider(
        config.model,
        key,
        config,
        config.endpoint ?? "https://openrouter.ai/api/v1/chat/completions",
        fetchImpl,
      );
    }
    case "gemini": {
      const key = environment.GEMINI_API_KEY;
      if (!key) throw new Error("GEMINI_API_KEY is not set");
      return new GeminiProvider(
        config.model,
        key,
        config,
        config.endpoint ?? "https://generativelanguage.googleapis.com/v1beta",
        fetchImpl,
      );
    }
    case "openai": {
      const key = environment.OPENAI_API_KEY;
      if (!key) throw new Error("OPENAI_API_KEY is not set");
      return new OpenAIProvider(
        config.model,
        key,
        config,
        config.endpoint ?? "https://api.openai.com/v1/chat/completions",
        fetchImpl,
      );
    }
    case "anthropic": {
      const key = environment.ANTHROPIC_API_KEY;
      if (!key) throw new Error("ANTHROPIC_API_KEY is not set");
      return new AnthropicProvider(
        config.model,
        key,
        config,
        config.endpoint ?? "https://api.anthropic.com/v1/messages",
        fetchImpl,
      );
    }
    case "deepseek": {
      const key = environment.DEEPSEEK_API_KEY;
      if (!key) throw new Error("DEEPSEEK_API_KEY is not set");
      return new DeepSeekProvider(
        config.model,
        key,
        config,
        config.endpoint ?? "https://api.deepseek.com/chat/completions",
        fetchImpl,
      );
    }
  }
}
