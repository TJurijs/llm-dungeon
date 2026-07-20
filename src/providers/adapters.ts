import { GenerationFailure } from "../llm/failures.js";
import { attachAttemptMetadata, attachStructuredFailure } from "../llm/structured-error.js";
import type { ProviderConfig } from "../schemas.js";
import type { FrozenModelExecutionProfile } from "../model-execution-profile.js";
import type {
  LlmProvider,
  StructuredRequest,
  StructuredResult,
} from "../types.js";
import {
  isRecord,
  jsonSchemaFor,
  projectOpenAiStrictSchema,
  projectSchemaById,
  routesToGemini,
  sanitizeAnthropicSchema,
  sanitizeGeminiSchema,
} from "./schema-projection.js";
import {
  assertProfileTarget,
  attemptMetadata,
  configuredOutputBudget,
  configuredTimeout,
  decodeStructured,
  deepSeekThinkingOptions,
  finiteNonnegativeInteger,
  generateChatCompletions,
  httpFailure,
  malformedStructuredResponse,
  openAiReasoningOptions,
  parseJsonText,
  profileTemperature,
  readError,
  readResponseObject,
  redactSecrets,
  requestTemperature,
  responseAttemptMetadata,
  safeFetch,
  structuredContentBlock,
  xaiChatUsage,
  xaiReasoningOptions,
  type FetchLike,
} from "./transport.js";

/** The concrete provider adapters over the shared transport. */
export class OpenRouterProvider implements LlmProvider {
  readonly id = "openrouter";

  constructor(
    readonly model: string,
    private readonly apiKey: string,
    private readonly defaults: Pick<ProviderConfig, "temperature" | "maxOutputTokens">,
    private readonly endpoint = "https://openrouter.ai/api/v1/chat/completions",
    private readonly fetchImpl: FetchLike = fetch,
    private readonly executionProfile?: FrozenModelExecutionProfile,
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
        ...(["qwen/qwen3.7-plus", "minimax/minimax-m3", "z-ai/glm-4.6", "tencent/hy3"].includes(this.model)
          ? { reasoning: { effort: "none" } }
          : {}),
        ...(this.model === "deepseek/deepseek-v3.2"
          ? { reasoning: { enabled: false } }
          : {}),
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
      schemaProjection: routesToGemini(this.model) ? "gemini_compatible_v1" : "identity_v1",
      reinforceSchemaInSystem: this.model === "moonshotai/kimi-k2.6",
      ...(this.executionProfile === undefined ? {} : { executionProfile: this.executionProfile }),
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
    private readonly executionProfile?: FrozenModelExecutionProfile,
  ) {}

  async generateStructured<T>(request: StructuredRequest<T>): Promise<StructuredResult<T>> {
    const reasoningOptions = openAiReasoningOptions(this.model);
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
      schemaProjection: "openai_strict_v1",
      ...(reasoningOptions === undefined ? {} : { extraBody: reasoningOptions }),
      ...(this.executionProfile === undefined ? {} : { executionProfile: this.executionProfile }),
    });
  }
}

/** xAI exposes an OpenAI-compatible Chat Completions API with strict structured outputs. */
export class XaiProvider implements LlmProvider {
  readonly id = "xai";

  constructor(
    readonly model: string,
    private readonly apiKey: string,
    private readonly defaults: Pick<ProviderConfig, "temperature" | "maxOutputTokens">,
    private readonly endpoint = "https://api.x.ai/v1/chat/completions",
    private readonly fetchImpl: FetchLike = fetch,
    private readonly executionProfile?: FrozenModelExecutionProfile,
  ) {}

  async generateStructured<T>(request: StructuredRequest<T>): Promise<StructuredResult<T>> {
    const reasoningOptions = xaiReasoningOptions(this.model);
    return generateChatCompletions(request, {
      id: this.id,
      label: "xAI",
      model: this.model,
      apiKey: this.apiKey,
      defaults: this.defaults,
      endpoint: this.endpoint,
      fetchImpl: this.fetchImpl,
      maxTokensField: "max_tokens",
      projectSchema: projectOpenAiStrictSchema,
      schemaProjection: "openai_strict_v1",
      parseUsage: xaiChatUsage,
      ...(reasoningOptions === undefined ? {} : { extraBody: reasoningOptions }),
      ...(this.executionProfile === undefined ? {} : { executionProfile: this.executionProfile }),
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
    private readonly executionProfile?: FrozenModelExecutionProfile,
  ) {}

  async generateStructured<T>(request: StructuredRequest<T>): Promise<StructuredResult<T>> {
    const thinkingOptions = deepSeekThinkingOptions(this.model);
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
      ...(thinkingOptions === undefined ? {} : { extraBody: thinkingOptions }),
      ...(this.executionProfile === undefined ? {} : { executionProfile: this.executionProfile }),
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
    private readonly executionProfile?: FrozenModelExecutionProfile,
  ) {}

  async generateStructured<T>(request: StructuredRequest<T>): Promise<StructuredResult<T>> {
    const exactSchema = request.jsonSchema ?? jsonSchemaFor(request.wireSchema ?? request.schema);
    const profile = this.executionProfile;
    if (profile) assertProfileTarget(profile, this.id, this.model);
    if (profile?.structuredOutput.mode === "json_object_local_schema") {
      throw new GenerationFailure("schema_rejected", "Anthropic Messages requires a JSON Schema execution profile", false);
    }
    const projectionId = profile?.structuredOutput.projection ?? "anthropic_compatible_v1";
    const outputSchema = (profile
      ? projectSchemaById(exactSchema, projectionId).schema
      : sanitizeAnthropicSchema(exactSchema)) as Record<string, unknown>;
    const secrets = [this.apiKey, encodeURIComponent(this.apiKey)];
    const temperature = profile === undefined
      ? requestTemperature(this.id, this.model, request.temperature ?? this.defaults.temperature)
      : profileTemperature(profile);
    const outputTokenField = profile?.outputTokenField ?? "max_tokens";
    if (outputTokenField !== "max_tokens") {
      throw new GenerationFailure("schema_rejected", "Anthropic Messages requires max_tokens", false);
    }
    const outputTokenBudget = configuredOutputBudget(request, this.defaults, profile);
    const timeoutMs = configuredTimeout(request, profile);
    const baseMetadata = attemptMetadata(
      request,
      this.id,
      this.model,
      profile?.key.route ?? "direct",
      "exact_schema",
      projectionId,
      outputTokenField,
      outputTokenBudget,
      timeoutMs,
      profile,
    );
    let response: Response;
    try {
      response = await safeFetch(this.fetchImpl, "Anthropic", this.endpoint, {
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
        max_tokens: outputTokenBudget,
        ...(temperature === undefined ? {} : { temperature }),
        output_config: {
          format: {
            type: "json_schema",
            schema: outputSchema,
          },
        },
      }),
      }, secrets, timeoutMs);
    } catch (error) {
      attachAttemptMetadata(error, baseMetadata);
      throw error;
    }

    if (!response.ok) {
      const failure = httpFailure("Anthropic", response.status, await readError(response, secrets));
      attachAttemptMetadata(failure, baseMetadata);
      throw failure;
    }
    const envelope = await readResponseObject(response, "Anthropic");
    const usage = anthropicUsage(envelope.usage);
    const stopReason = typeof envelope.stop_reason === "string" ? envelope.stop_reason : undefined;
    const responseMetadata = responseAttemptMetadata(baseMetadata, stopReason, stopReason === "max_tokens");
    const blocks = Array.isArray(envelope.content) ? envelope.content : [];
    const content = blocks
      .filter((block): block is Record<string, unknown> => isRecord(block) && block.type === "text")
      .map((block) => typeof block.text === "string" ? block.text : "")
      .join("");
    if (stopReason === "refusal") {
      const refusal = redactSecrets(content || "safety refusal", secrets).slice(0, 1000);
      const failure = structuredContentBlock("Anthropic", refusal, refusal, usage);
      attachAttemptMetadata(failure, responseMetadata);
      throw failure;
    }
    if (!content) {
      if (stopReason === "max_tokens") {
        throw malformedStructuredResponse("", new Error("Anthropic exhausted max_tokens before returning JSON"), usage, true, "exact_schema", responseMetadata);
      }
      const failure = new GenerationFailure("provider", `Anthropic returned no text content (${stopReason ?? "unknown reason"})`, false);
      attachAttemptMetadata(failure, responseMetadata);
      throw failure;
    }

    let parsed: unknown;
    try {
      parsed = parseJsonText(content);
    } catch (error) {
      throw malformedStructuredResponse(content, error, usage, stopReason === "max_tokens", "exact_schema", responseMetadata);
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
        attemptMetadata: responseMetadata,
      };
    } catch (error) {
      attachStructuredFailure(error, {
        rawText: content,
        parsedResponse: parsed,
        structuredMode: "exact_schema",
        ...(usage ? { usage } : {}),
        attemptMetadata: responseMetadata,
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
    private readonly executionProfile?: FrozenModelExecutionProfile,
  ) {}

  async generateStructured<T>(request: StructuredRequest<T>): Promise<StructuredResult<T>> {
    const url = `${this.endpoint.replace(/\/$/, "")}/models/${encodeURIComponent(this.model)}:generateContent`;
    const exactSchema = request.jsonSchema ?? jsonSchemaFor(request.wireSchema ?? request.schema);
    const profile = this.executionProfile;
    if (profile) assertProfileTarget(profile, this.id, this.model);
    if (profile?.structuredOutput.mode === "json_object_local_schema") {
      throw new GenerationFailure("schema_rejected", "Gemini requires a JSON Schema execution profile", false);
    }
    const projectionId = profile?.structuredOutput.projection ?? "gemini_compatible_v1";
    const outputSchema = profile
      ? projectSchemaById(exactSchema, projectionId).schema
      : sanitizeGeminiSchema(exactSchema);
    const outputTokenField = profile?.outputTokenField ?? "maxOutputTokens";
    if (outputTokenField !== "maxOutputTokens") {
      throw new GenerationFailure("schema_rejected", "Gemini requires maxOutputTokens", false);
    }
    const outputTokenBudget = configuredOutputBudget(request, this.defaults, profile);
    const timeoutMs = configuredTimeout(request, profile);
    const baseMetadata = attemptMetadata(
      request,
      this.id,
      this.model,
      profile?.key.route ?? "direct",
      "exact_schema",
      projectionId,
      outputTokenField,
      outputTokenBudget,
      timeoutMs,
      profile,
    );
    const temperature = profile === undefined
      ? request.temperature ?? this.defaults.temperature
      : profileTemperature(profile);
    const thinkingConfig = profile === undefined
      ? (/^gemini-3(?:\.|-)/i.test(this.model) ? { thinkingConfig: { thinkingLevel: "low" } } : {})
      : profile.reasoning.policy === "gemini_thinking_low"
        ? { thinkingConfig: { thinkingLevel: "low" } }
        : {};
    const secrets = [this.apiKey, encodeURIComponent(this.apiKey)];
    let response: Response;
    try {
      response = await safeFetch(this.fetchImpl, "Gemini", url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": this.apiKey },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: request.system }] },
        contents: [{ role: "user", parts: [{ text: request.prompt }] }],
        generationConfig: {
          ...(temperature === undefined ? {} : { temperature }),
          maxOutputTokens: outputTokenBudget,
          ...thinkingConfig,
          responseFormat: {
            text: {
              mimeType: "APPLICATION_JSON",
              schema: outputSchema,
            },
          },
        },
      }),
      }, secrets, timeoutMs);
    } catch (error) {
      attachAttemptMetadata(error, baseMetadata);
      throw error;
    }

    if (!response.ok) {
      const failure = httpFailure("Gemini", response.status, await readError(response, secrets));
      attachAttemptMetadata(failure, baseMetadata);
      throw failure;
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
    const responseMetadata = responseAttemptMetadata(
      baseMetadata,
      candidate?.finishReason,
      candidate?.finishReason === "MAX_TOKENS",
    );
    const content = candidate?.content?.parts
      ?.filter((part) => part.thought !== true)
      .map((part) => part.text ?? "")
      .join("");
    const usageMetadata = body.usageMetadata;
    const billedOutputTokens = usageMetadata?.candidatesTokenCount === undefined && usageMetadata?.thoughtsTokenCount === undefined
      ? undefined
      : (usageMetadata?.candidatesTokenCount ?? 0) + (usageMetadata?.thoughtsTokenCount ?? 0);
    const usage = usageMetadata
      ? {
          ...(usageMetadata.promptTokenCount === undefined ? {} : { inputTokens: usageMetadata.promptTokenCount }),
          ...(billedOutputTokens === undefined ? {} : { outputTokens: billedOutputTokens }),
          ...(usageMetadata.totalTokenCount === undefined ? {} : { totalTokens: usageMetadata.totalTokenCount }),
        }
      : undefined;
    if (!content) {
      const blocked = candidate?.finishReason && /SAFETY|BLOCK/i.test(candidate.finishReason);
      if (candidate?.finishReason === "MAX_TOKENS") {
        throw malformedStructuredResponse("", new Error("Gemini exhausted maxOutputTokens before returning JSON"), usage, true, "exact_schema", responseMetadata);
      }
      const failure = new GenerationFailure(blocked ? "content_block" : "provider", `Gemini returned no message content (${candidate?.finishReason ?? "unknown reason"})`, false);
      attachAttemptMetadata(failure, responseMetadata);
      throw failure;
    }
    let parsed: unknown;
    try {
      parsed = parseJsonText(content);
    } catch (error) {
      throw malformedStructuredResponse(content, error, usage, candidate?.finishReason === "MAX_TOKENS", "exact_schema", responseMetadata);
    }
    try {
      const data = decodeStructured(request, parsed);
      return {
        data, provider: this.id, model: this.model, rawText: content, structuredMode: "exact_schema",
        ...(request.protocolVersion === undefined ? {} : { protocolVersion: request.protocolVersion }),
        ...(usage ? { usage } : {}),
        attemptMetadata: responseMetadata,
      };
    } catch (error) {
      attachStructuredFailure(error, {
        rawText: content,
        parsedResponse: parsed,
        structuredMode: "exact_schema",
        ...(usage ? { usage } : {}),
        attemptMetadata: responseMetadata,
      });
      throw error;
    }
  }
}


