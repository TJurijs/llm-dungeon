import { readFile } from "node:fs/promises";
import { z } from "zod";
import { ProviderConfigSchema, type ProviderConfig } from "./schemas.js";
import { GenerationFailure } from "./llm/failures.js";
import { attachStructuredFailure } from "./llm/structured-error.js";
import type { LlmProvider, StructuredRequest, StructuredResult } from "./types.js";

type FetchLike = typeof fetch;

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
  if (status === 400 && /schema|invalid.argument|invalid argument/i.test(details)) {
    return new GenerationFailure("schema_rejected", `${provider} rejected the exact structured-output schema (${status}): ${details}`, false, status);
  }
  return new GenerationFailure("provider", `${provider} request failed (${status}): ${details}`, false, status);
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
    const exactSchema = request.jsonSchema ?? jsonSchemaFor(request.wireSchema ?? request.schema);
    // OpenRouter forwards schema constraints to the selected upstream model.
    // Gemini routes need the same supported-keyword projection as the direct
    // Gemini adapter; the original Zod schema remains authoritative locally.
    const outputSchema = routesToGemini(this.model) ? sanitizeGeminiSchema(exactSchema) : exactSchema;
    const secrets = [this.apiKey, encodeURIComponent(this.apiKey)];
    const response = await safeFetch(this.fetchImpl, "OpenRouter", this.endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://github.com/llm-dungeon",
        "X-Title": "llm-dungeon",
      },
      body: JSON.stringify({
        model: this.model,
        messages: [
          { role: "system", content: request.system },
          { role: "user", content: request.prompt },
        ],
        temperature: request.temperature ?? this.defaults.temperature,
        max_tokens: request.maxOutputTokens ?? this.defaults.maxOutputTokens,
        stream: false,
        provider: { require_parameters: true },
        response_format: {
          type: "json_schema",
          json_schema: {
            name: request.schemaName,
            strict: true,
            schema: outputSchema,
          },
        },
      }),
    }, secrets);

    if (!response.ok) throw httpFailure("OpenRouter", response.status, await readError(response, secrets));
    const body = (await response.json()) as {
      choices?: Array<{ finish_reason?: string; message?: { content?: string } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number; cost?: number };
    };
    const choice = body.choices?.[0];
    const content = choice?.message?.content;
    if (!content) throw new GenerationFailure("content_block", "OpenRouter returned no message content", false);
    const usage = body.usage
      ? {
          ...(body.usage.prompt_tokens === undefined ? {} : { inputTokens: body.usage.prompt_tokens }),
          ...(body.usage.completion_tokens === undefined ? {} : { outputTokens: body.usage.completion_tokens }),
          ...(body.usage.total_tokens === undefined ? {} : { totalTokens: body.usage.total_tokens }),
          ...(typeof body.usage.cost === "number" && Number.isFinite(body.usage.cost) && body.usage.cost >= 0
            ? { billedCostUsd: body.usage.cost }
            : {}),
        }
      : undefined;
    let parsed: unknown;
    try {
      parsed = parseJsonText(content);
    } catch (error) {
      throw malformedStructuredResponse(content, error, usage, choice?.finish_reason === "length", "exact_schema");
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
  if (config.provider === "openrouter") {
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
