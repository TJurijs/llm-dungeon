import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  AnthropicProvider,
  DeepSeekProvider,
  GeminiProvider,
  OpenAIProvider,
  OpenRouterProvider,
  XaiProvider,
  createProvider,
  providerSupportsTemperature,
} from "../src/providers.js";
import { SetupResultSchema, TurnDecisionSchema } from "../src/schemas.js";
import {
  GAMEPLAY_PROTOCOL_VERSION,
  GAMEPLAY_WIRE_JSON_SCHEMA,
  RESOLVED_GAMEPLAY_WIRE_JSON_SCHEMA,
  WireResolvedTurnSchema,
  WireTurnSchema,
  decodeTurnDecision,
  resolvedGameplayRequest,
} from "../src/llm/gameplay-protocol.js";
import { GenerationFailure } from "../src/llm/failures.js";
import { requestDiagnosticsFor } from "../src/llm/request-diagnostics.js";
import { attemptMetadataFor, structuredFailureDetails } from "../src/llm/structured-error.js";
import type { LlmProvider } from "../src/types.js";
import { createTestStore, setupFixture } from "./helpers.js";

const answerSchema = z.object({ answer: z.string() });
const answerRequest = {
  schemaName: "answer",
  schema: answerSchema,
  system: "system",
  prompt: "prompt",
};

/** A resolved V3 turn: one channel, so effects carry the whole transaction. */
function resolvedWire(effects: unknown[] = []) {
  return {
    decision: "resolved",
    narration: "Schema enforcement verified.",
    summary: "Schema enforcement verified.",
    effects,
    checkName: "",
    difficulty: 0,
    modifiers: [],
    exceptionalSuccessStakes: "",
    successStakes: "",
    failureStakes: "",
    severeFailureStakes: "",
    failureCampaignStatus: "none",
  };
}

function effect(overrides: Record<string, unknown>) {
  return {
    kind: "add_fact",
    targetId: "",
    relatedId: "",
    itemId: "",
    threadOrdinal: 0,
    entityKindCode: 0,
    factSectionCode: 0,
    factBasisCode: 0,
    lifecycleCode: 0,
    name: "",
    status: "",
    text: "",
    quantity: 0,
    tags: [],
    references: [],
    ...overrides,
  };
}

const gameplayRequest = {
  schemaName: "turn_decision_v3",
  schema: TurnDecisionSchema,
  wireSchema: WireTurnSchema,
  jsonSchema: GAMEPLAY_WIRE_JSON_SCHEMA,
  decodeResponse: decodeTurnDecision,
  protocolVersion: GAMEPLAY_PROTOCOL_VERSION,
  system: "system",
  prompt: "prompt",
};

describe("provider adapters", () => {
  it("locks provider schemas to resolved responses after the application rolls", () => {
    const request = resolvedGameplayRequest({
      schemaName: "turn_resolution_v3",
      schema: TurnDecisionSchema,
      decodeResponse: decodeTurnDecision,
      system: "system",
      prompt: "prompt",
    });

    expect(request.wireSchema).toBe(WireResolvedTurnSchema);
    expect(request.jsonSchema).toEqual(RESOLVED_GAMEPLAY_WIRE_JSON_SCHEMA);
    expect((request.jsonSchema?.properties as Record<string, any>).decision.enum).toEqual([
      "resolved",
    ]);
    expect(
      request.wireSchema?.safeParse({ ...resolvedWire(), decision: "check_required" }).success,
    ).toBe(false);
    expect(request.wireSchema?.safeParse(resolvedWire()).success).toBe(true);
  });

  it.each([
    [
      "OpenRouter",
      (apiKey: string, fetchMock: typeof fetch) =>
        new OpenRouterProvider(
          "provider/model",
          apiKey,
          { temperature: 0.8, maxOutputTokens: 1000 },
          "https://example.test/chat",
          fetchMock,
        ),
    ],
    [
      "Gemini",
      (apiKey: string, fetchMock: typeof fetch) =>
        new GeminiProvider(
          "gemini-model",
          apiKey,
          { temperature: 0.8, maxOutputTokens: 1000 },
          "https://example.test/v1beta",
          fetchMock,
        ),
    ],
    [
      "OpenAI",
      (apiKey: string, fetchMock: typeof fetch) =>
        new OpenAIProvider(
          "gpt-4o",
          apiKey,
          { temperature: 0.8, maxOutputTokens: 1000 },
          "https://example.test/chat",
          fetchMock,
        ),
    ],
    [
      "Anthropic",
      (apiKey: string, fetchMock: typeof fetch) =>
        new AnthropicProvider(
          "claude-model",
          apiKey,
          { temperature: 0.8, maxOutputTokens: 1000 },
          "https://example.test/messages",
          fetchMock,
        ),
    ],
    [
      "DeepSeek",
      (apiKey: string, fetchMock: typeof fetch) =>
        new DeepSeekProvider(
          "deepseek-chat",
          apiKey,
          { temperature: 0.8, maxOutputTokens: 1000 },
          "https://example.test/chat",
          fetchMock,
        ),
    ],
  ])("redacts the configured API key from %s HTTP failures", async (_name, createProvider) => {
    const apiKey = "test-key-that-must-not-escape";
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ error: `Invalid credential ${apiKey}; received ${apiKey}` }),
          { status: 401 },
        ),
    );
    const provider = createProvider(apiKey, fetchMock as typeof fetch);

    let failure: unknown;
    try {
      await provider.generateStructured(answerRequest);
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(GenerationFailure);
    expect((failure as Error).message).not.toContain(apiKey);
    expect((failure as Error).message).toContain("[redacted]");
  });

  it("redacts an echoed key before truncating a long provider error", async () => {
    const apiKey = "boundary-secret-key";
    const fetchMock = vi.fn(
      async () => new Response(`${"x".repeat(992)}${apiKey}`, { status: 401 }),
    );
    const provider = new OpenRouterProvider(
      "provider/model",
      apiKey,
      { temperature: 0.8, maxOutputTokens: 1000 },
      "https://example.test/chat",
      fetchMock as typeof fetch,
    );

    let failure: unknown;
    try {
      await provider.generateStructured(answerRequest);
    } catch (error) {
      failure = error;
    }
    expect((failure as Error).message).not.toContain(apiKey.slice(0, 8));
  });

  it("reports an exact actionable path when a transfer uses a negative quantity", () => {
    expect(() =>
      decodeTurnDecision(
        resolvedWire([
          effect({
            kind: "transfer_item",
            targetId: "player:hero",
            relatedId: "npc:mara",
            itemId: "item:silver-marks",
            quantity: -3,
          }),
        ]),
      ),
    ).toThrow(
      "effects[0].quantity: transfer_item quantity must be strictly positive; direction is targetId (prior owner) to relatedId (new owner), so never use a negative quantity",
    );
    expect(
      (GAMEPLAY_WIRE_JSON_SCHEMA.properties as Record<string, any>).effects.items.properties
        .quantity.description,
    ).toContain("never use a negative transfer quantity");
  });

  it("captures allowlisted OpenAI request diagnostics without retaining arbitrary headers", async () => {
    let sentClientRequestId: string | null = null;
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      sentClientRequestId = new Headers(init?.headers).get("x-client-request-id");
      return new Response(
        JSON.stringify({
          choices: [{ finish_reason: "stop", message: { content: '{"answer":"yes"}' } }],
        }),
        {
          status: 200,
          headers: {
            "x-request-id": "req_success_123",
            "x-ratelimit-remaining-requests": "99",
            "x-ratelimit-reset-requests": "250ms",
            "x-ratelimit-limit-tokens": "openai-key",
            "x-unsafe-diagnostic": "must-not-be-retained",
          },
        },
      );
    });
    const provider = new OpenAIProvider(
      "gpt-5.6-luna",
      "openai-key",
      { temperature: 0.8, maxOutputTokens: 1000 },
      "https://example.test/chat",
      fetchMock as typeof fetch,
    );

    const result = await provider.generateStructured(answerRequest);

    expect(sentClientRequestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(result.requestDiagnostics).toMatchObject({
      timestamp: expect.any(String),
      provider: "openai",
      model: "gpt-5.6-luna",
      clientRequestId: sentClientRequestId,
      requestId: "req_success_123",
      httpStatus: 200,
      rateLimitHeaders: {
        "x-ratelimit-remaining-requests": "99",
        "x-ratelimit-reset-requests": "250ms",
      },
    });
    expect(JSON.stringify(result.requestDiagnostics)).not.toContain("must-not-be-retained");
    expect(JSON.stringify(result.requestDiagnostics)).not.toContain("openai-key");
  });

  it("retains OpenAI correlation metadata on HTTP failures", async () => {
    let sentClientRequestId: string | null = null;
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      sentClientRequestId = new Headers(init?.headers).get("x-client-request-id");
      return new Response(JSON.stringify({ error: { message: "insufficient permissions" } }), {
        status: 401,
        headers: {
          "x-request-id": "req_failure_456",
          "x-ratelimit-remaining-tokens": "12345",
        },
      });
    });
    const provider = new OpenAIProvider(
      "gpt-5.6-luna",
      "openai-key",
      { temperature: 0.8, maxOutputTokens: 1000 },
      "https://example.test/chat",
      fetchMock as typeof fetch,
    );

    let failure: unknown;
    try {
      await provider.generateStructured(answerRequest);
    } catch (error) {
      failure = error;
    }

    expect(failure).toMatchObject({ kind: "provider", status: 401 });
    expect(requestDiagnosticsFor(failure)).toMatchObject({
      timestamp: expect.any(String),
      provider: "openai",
      model: "gpt-5.6-luna",
      clientRequestId: sentClientRequestId,
      requestId: "req_failure_456",
      httpStatus: 401,
      rateLimitHeaders: { "x-ratelimit-remaining-tokens": "12345" },
    });
  });

  it.each([
    [
      "OpenRouter",
      (apiKey: string, fetchMock: typeof fetch) =>
        new OpenRouterProvider(
          "provider/model",
          apiKey,
          { temperature: 0.8, maxOutputTokens: 1000 },
          "https://example.test/chat",
          fetchMock,
        ),
    ],
    [
      "Gemini",
      (apiKey: string, fetchMock: typeof fetch) =>
        new GeminiProvider(
          "gemini-model",
          apiKey,
          { temperature: 0.8, maxOutputTokens: 1000 },
          "https://example.test/v1beta",
          fetchMock,
        ),
    ],
    [
      "OpenAI",
      (apiKey: string, fetchMock: typeof fetch) =>
        new OpenAIProvider(
          "gpt-4o",
          apiKey,
          { temperature: 0.8, maxOutputTokens: 1000 },
          "https://example.test/chat",
          fetchMock,
        ),
    ],
    [
      "Anthropic",
      (apiKey: string, fetchMock: typeof fetch) =>
        new AnthropicProvider(
          "claude-model",
          apiKey,
          { temperature: 0.8, maxOutputTokens: 1000 },
          "https://example.test/messages",
          fetchMock,
        ),
    ],
    [
      "DeepSeek",
      (apiKey: string, fetchMock: typeof fetch) =>
        new DeepSeekProvider(
          "deepseek-chat",
          apiKey,
          { temperature: 0.8, maxOutputTokens: 1000 },
          "https://example.test/chat",
          fetchMock,
        ),
    ],
  ])("redacts the configured API key from %s network exceptions", async (_name, createProvider) => {
    const apiKey = "network-key-that-must-not-escape";
    const fetchMock = vi.fn(async () => {
      throw new TypeError(`fetch failed while sending ${apiKey}`);
    });
    const provider = createProvider(apiKey, fetchMock as typeof fetch);

    let failure: unknown;
    try {
      await provider.generateStructured(answerRequest);
    } catch (error) {
      failure = error;
    }

    expect(failure).toMatchObject({ kind: "network", retryable: true });
    expect((failure as Error).message).not.toContain(apiKey);
    expect((failure as Error).message).toContain("[redacted]");
  });

  it("sends a strict exact JSON schema to OpenRouter", async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, any>;
      expect(body.response_format.type).toBe("json_schema");
      expect(body.response_format.json_schema.strict).toBe(true);
      expect(body.provider.require_parameters).toBe(true);
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: '{"answer":"yes"}' } }],
          usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4, cost: 0.000123 },
        }),
        { status: 200 },
      );
    });
    const provider = new OpenRouterProvider(
      "provider/model",
      "key",
      { temperature: 0.8, maxOutputTokens: 1000 },
      "https://example.test/chat",
      fetchMock as typeof fetch,
    );
    const result = await provider.generateStructured(answerRequest);
    expect(result.data).toEqual({ answer: "yes" });
    expect(result.usage).toEqual({
      inputTokens: 3,
      outputTokens: 1,
      totalTokens: 4,
      billedCostUsd: 0.000123,
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("maps every provider to its dedicated environment key", () => {
    const defaults = { temperature: 0.8, maxOutputTokens: 1000 };
    expect(
      createProvider(
        { provider: "gemini", model: "gemini-model", ...defaults },
        { GEMINI_API_KEY: "gemini-key" },
      ),
    ).toBeInstanceOf(GeminiProvider);
    expect(
      createProvider(
        { provider: "openrouter", model: "vendor/model", ...defaults },
        { OPENROUTER_API_KEY: "openrouter-key" },
      ),
    ).toBeInstanceOf(OpenRouterProvider);
    expect(
      createProvider(
        { provider: "xai", model: "grok-4.5", ...defaults },
        { XAI_API_KEY: "xai-key" },
      ),
    ).toBeInstanceOf(XaiProvider);
    expect(
      createProvider(
        { provider: "openai", model: "gpt-4o", ...defaults },
        { OPENAI_API_KEY: "openai-key" },
      ),
    ).toBeInstanceOf(OpenAIProvider);
    expect(
      createProvider(
        { provider: "anthropic", model: "claude-model", ...defaults },
        { ANTHROPIC_API_KEY: "anthropic-key" },
      ),
    ).toBeInstanceOf(AnthropicProvider);
    expect(
      createProvider(
        { provider: "deepseek", model: "deepseek-chat", ...defaults },
        { DEEPSEEK_API_KEY: "deepseek-key" },
      ),
    ).toBeInstanceOf(DeepSeekProvider);
    expect(() => createProvider({ provider: "openai", model: "gpt-4o", ...defaults }, {})).toThrow(
      "OPENAI_API_KEY is not set",
    );
  });

  it("adapts optional fields to OpenAI strict schema and restores null to omission locally", async () => {
    const optionalAnswerSchema = z
      .object({
        answer: z.string(),
        note: z.string().optional(),
      })
      .strict();
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, any>;
      expect(body.max_completion_tokens).toBe(777);
      expect(body).not.toHaveProperty("max_tokens");
      expect(body.temperature).toBe(0.4);
      expect(body.response_format).toMatchObject({
        type: "json_schema",
        json_schema: { name: "optional_answer", strict: true },
      });
      const schema = body.response_format.json_schema.schema;
      expect(schema.required).toEqual(["answer", "note"]);
      expect(schema.additionalProperties).toBe(false);
      expect(schema.properties.note.anyOf).toEqual([{ type: "string" }, { type: "null" }]);
      expect(JSON.stringify(schema)).not.toContain('"$schema"');
      return new Response(
        JSON.stringify({
          choices: [
            { finish_reason: "stop", message: { content: '{"answer":"yes","note":null}' } },
          ],
          usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 },
        }),
        { status: 200 },
      );
    });
    const provider = new OpenAIProvider(
      "gpt-4o",
      "key",
      { temperature: 0.8, maxOutputTokens: 1000 },
      "https://example.test/chat",
      fetchMock as typeof fetch,
    );
    const result = await provider.generateStructured({
      schemaName: "optional_answer",
      schema: optionalAnswerSchema,
      system: "system",
      prompt: "prompt",
      temperature: 0.4,
      maxOutputTokens: 777,
    });
    expect(result.data).toEqual({ answer: "yes" });
    expect(result.usage).toEqual({ inputTokens: 8, outputTokens: 4, totalTokens: 12 });
  });

  it("uses xAI Chat Completions structured output with its dedicated key", async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      expect(headers.get("authorization")).toBe("Bearer xai-key");
      const body = JSON.parse(String(init?.body)) as Record<string, any>;
      expect(body.model).toBe("grok-4.5");
      expect(body.max_tokens).toBe(1000);
      expect(body.reasoning_effort).toBe("low");
      expect(body.response_format).toMatchObject({
        type: "json_schema",
        json_schema: { name: "answer", strict: true },
      });
      return new Response(
        JSON.stringify({
          choices: [{ finish_reason: "stop", message: { content: '{"answer":"yes"}' } }],
          usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 6 },
        }),
        { status: 200 },
      );
    });
    const provider = new XaiProvider(
      "grok-4.5",
      "xai-key",
      { temperature: 0.8, maxOutputTokens: 1000 },
      "https://example.test/chat",
      fetchMock as typeof fetch,
    );
    await expect(provider.generateStructured(answerRequest)).resolves.toMatchObject({
      provider: "xai",
      model: "grok-4.5",
      data: { answer: "yes" },
      usage: { inputTokens: 3, outputTokens: 3, totalTokens: 6 },
    });
  });

  it("explicitly disables reasoning for direct OpenAI GPT-5.4 Mini", async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, any>;
      expect(body.model).toBe("gpt-5.4-mini");
      expect(body.reasoning_effort).toBe("none");
      expect(body).not.toHaveProperty("temperature");
      expect(body.max_completion_tokens).toBe(1000);
      return new Response(
        JSON.stringify({
          choices: [{ finish_reason: "stop", message: { content: '{"answer":"yes"}' } }],
        }),
        { status: 200 },
      );
    });
    const provider = new OpenAIProvider(
      "gpt-5.4-mini",
      "openai-key",
      { temperature: 0.8, maxOutputTokens: 1000 },
      "https://example.test/chat",
      fetchMock as typeof fetch,
    );
    await expect(provider.generateStructured(answerRequest)).resolves.toMatchObject({
      provider: "openai",
      model: "gpt-5.4-mini",
      data: { answer: "yes" },
    });
  });

  it("disables Grok 4.3 reasoning without changing Grok 4.5's low setting", async () => {
    const reasoningByModel = new Map<string, unknown>();
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, any>;
      reasoningByModel.set(String(body.model), body.reasoning_effort);
      return new Response(
        JSON.stringify({
          choices: [{ finish_reason: "stop", message: { content: '{"answer":"yes"}' } }],
        }),
        { status: 200 },
      );
    });

    for (const model of ["grok-4.3", "grok-4.5"]) {
      const provider = new XaiProvider(
        model,
        "xai-key",
        { temperature: 0.8, maxOutputTokens: 1000 },
        "https://example.test/chat",
        fetchMock as typeof fetch,
      );
      await expect(provider.generateStructured(answerRequest)).resolves.toMatchObject({
        provider: "xai",
        model,
        data: { answer: "yes" },
      });
    }

    expect(reasoningByModel).toEqual(
      new Map([
        ["grok-4.3", "none"],
        ["grok-4.5", "low"],
      ]),
    );
  });

  it("preserves Gameplay Contract V1 through OpenAI's strict schema projection", async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, any>;
      const schema = body.response_format.json_schema.schema;
      expect(schema.required).toEqual(GAMEPLAY_WIRE_JSON_SCHEMA.required);
      expect(schema.properties.decision.enum).toEqual(["resolved", "check_required"]);
      expect(schema.properties.effects.items.additionalProperties).toBe(false);
      return new Response(
        JSON.stringify({
          choices: [
            { finish_reason: "stop", message: { content: JSON.stringify(resolvedWire()) } },
          ],
        }),
        { status: 200 },
      );
    });
    const provider = new OpenAIProvider(
      "gpt-4o",
      "key",
      { temperature: 0.8, maxOutputTokens: 1000 },
      "https://example.test/chat",
      fetchMock as typeof fetch,
    );
    await expect(provider.generateStructured(gameplayRequest)).resolves.toMatchObject({
      provider: "openai",
      protocolVersion: 3,
      data: { kind: "resolved", operations: [] },
    });
  });

  it("uses Anthropic Messages structured output with its explicit schema projection", async () => {
    const constrainedSchema = z
      .object({
        id: z
          .string()
          .regex(/^[a-z]+$/)
          .min(2),
        kind: z.enum(["person", "creature"]),
        quantity: z.number().int().min(1).max(20),
        entries: z.array(z.string()).max(3),
      })
      .strict();
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      expect(headers.get("x-api-key")).toBe("anthropic-key");
      expect(headers.get("anthropic-version")).toBe("2023-06-01");
      expect(headers.get("authorization")).toBeNull();
      const body = JSON.parse(String(init?.body)) as Record<string, any>;
      expect(body).toMatchObject({
        model: "claude-model",
        system: "system",
        messages: [{ role: "user", content: "prompt" }],
        max_tokens: 900,
        temperature: 0.7,
      });
      expect(body.output_config.format.type).toBe("json_schema");
      const schema = body.output_config.format.schema;
      expect(schema.required).toEqual(["id", "kind", "quantity", "entries"]);
      expect(schema.additionalProperties).toBe(false);
      expect(schema.properties.id).not.toHaveProperty("pattern");
      expect(schema.properties.kind.enum).toEqual(["person", "creature"]);
      expect(schema.properties.quantity.type).toBe("integer");
      expect(schema.properties.quantity).not.toHaveProperty("minimum");
      expect(schema.properties.quantity).not.toHaveProperty("maximum");
      expect(schema.properties.entries).not.toHaveProperty("maxItems");
      return new Response(
        JSON.stringify({
          stop_reason: "end_turn",
          content: [
            { type: "text", text: '{"id":"hero","kind":"person","quantity":1,"entries":["one"]}' },
          ],
          usage: { input_tokens: 12, output_tokens: 7 },
        }),
        { status: 200 },
      );
    });
    const provider = new AnthropicProvider(
      "claude-model",
      "anthropic-key",
      { temperature: 0.8, maxOutputTokens: 1000 },
      "https://example.test/messages",
      fetchMock as typeof fetch,
    );
    const result = await provider.generateStructured({
      schemaName: "constrained",
      schema: constrainedSchema,
      system: "system",
      prompt: "prompt",
      temperature: 0.7,
      maxOutputTokens: 900,
    });
    expect(result.data.quantity).toBe(1);
    expect(result.usage).toEqual({ inputTokens: 12, outputTokens: 7, totalTokens: 19 });
  });

  it("preserves required wire vocabulary while projecting unsupported Anthropic constraints", async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, any>;
      const schema = body.output_config.format.schema;
      expect(schema.required).toEqual(GAMEPLAY_WIRE_JSON_SCHEMA.required);
      expect(schema.properties.failureCampaignStatus.enum).toEqual(["none", "dead", "ended"]);
      expect(schema.properties.effects.items.additionalProperties).toBe(false);
      expect(schema.properties.difficulty).not.toHaveProperty("minimum");
      expect(schema.properties.difficulty).not.toHaveProperty("maximum");
      return new Response(
        JSON.stringify({
          stop_reason: "end_turn",
          content: [{ type: "text", text: JSON.stringify(resolvedWire()) }],
        }),
        { status: 200 },
      );
    });
    const provider = new AnthropicProvider(
      "claude-model",
      "key",
      { temperature: 0.8, maxOutputTokens: 1000 },
      "https://example.test/messages",
      fetchMock as typeof fetch,
    );
    await expect(provider.generateStructured(gameplayRequest)).resolves.toMatchObject({
      provider: "anthropic",
      protocolVersion: 3,
      data: { kind: "resolved", operations: [] },
    });
  });

  it("uses DeepSeek JSON Object mode while preserving the exact local gameplay contract", async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, any>;
      expect(body.response_format).toEqual({ type: "json_object" });
      expect(body.thinking).toEqual({ type: "disabled" });
      expect(body).not.toHaveProperty("temperature");
      expect(body.messages[0].content).toContain("DEEPSEEK JSON OUTPUT CONTRACT");
      expect(body.messages[0].content).toContain("Schema name: turn_decision_v3");
      expect(body.messages[0].content).toContain(
        '\"decision\":{\"type\":\"string\",\"enum\":[\"resolved\",\"check_required\"]',
      );
      expect(body.messages[0].content).toContain(
        "Required fields apply independently to every object inside an array",
      );
      expect(body.messages[0].content).toContain(
        "$.effects[]: kind, targetId, relatedId, itemId, threadOrdinal, entityKindCode, factSectionCode, factBasisCode, lifecycleCode, name, status, text, quantity, tags, references",
      );
      expect(body.messages[0].content).toContain("$.modifiers[]: label, value");
      expect(body.messages[0].content).toContain("Example JSON object with the required shape:");
      return new Response(
        JSON.stringify({
          choices: [
            { finish_reason: "stop", message: { content: JSON.stringify(resolvedWire()) } },
          ],
          usage: { prompt_tokens: 12, completion_tokens: 7, total_tokens: 19 },
        }),
        { status: 200 },
      );
    });
    const provider = new DeepSeekProvider(
      "deepseek-v4-flash",
      "key",
      { temperature: 0.8, maxOutputTokens: 1000 },
      "https://example.test/chat",
      fetchMock as typeof fetch,
    );
    await expect(provider.generateStructured(gameplayRequest)).resolves.toMatchObject({
      provider: "deepseek",
      protocolVersion: 3,
      structuredMode: "json_object_local_schema",
      data: { kind: "resolved", operations: [] },
      usage: { inputTokens: 12, outputTokens: 7, totalTokens: 19 },
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it.each(["deepseek-v4-flash", "deepseek-v4-pro"])(
    "disables upstream thinking for direct DeepSeek v4 model %s",
    async (model) => {
      const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        expect(body.thinking).toEqual({ type: "disabled" });
        expect(body.response_format).toEqual({ type: "json_object" });
        expect(body).not.toHaveProperty("temperature");
        return new Response(
          JSON.stringify({
            choices: [{ finish_reason: "stop", message: { content: '{"answer":"yes"}' } }],
          }),
          { status: 200 },
        );
      });
      const provider = new DeepSeekProvider(
        model,
        "key",
        { temperature: 0.8, maxOutputTokens: 1000 },
        "https://example.test/chat",
        fetchMock as typeof fetch,
      );

      await expect(provider.generateStructured(answerRequest)).resolves.toMatchObject({
        provider: "deepseek",
        data: { answer: "yes" },
      });
    },
  );

  it("preserves ordinary DeepSeek transport controls outside the direct v4 models", async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(body).not.toHaveProperty("thinking");
      expect(body.temperature).toBe(0.8);
      expect(body.response_format).toEqual({ type: "json_object" });
      return new Response(
        JSON.stringify({
          choices: [{ finish_reason: "stop", message: { content: '{"answer":"yes"}' } }],
        }),
        { status: 200 },
      );
    });
    const provider = new DeepSeekProvider(
      "deepseek-chat",
      "key",
      { temperature: 0.8, maxOutputTokens: 1000 },
      "https://example.test/chat",
      fetchMock as typeof fetch,
    );

    await expect(provider.generateStructured(answerRequest)).resolves.toMatchObject({
      provider: "deepseek",
      data: { answer: "yes" },
    });
  });

  it("rejects a valid DeepSeek JSON object that violates the local schema", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            choices: [{ finish_reason: "stop", message: { content: '{\"answer\":42}' } }],
          }),
          { status: 200 },
        ),
    );
    const provider = new DeepSeekProvider(
      "deepseek-v4-pro",
      "key",
      { temperature: 0.8, maxOutputTokens: 1000 },
      "https://example.test/chat",
      fetchMock as typeof fetch,
    );

    let failure: unknown;
    try {
      await provider.generateStructured(answerRequest);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(z.ZodError);
    expect(structuredFailureDetails(failure)).toMatchObject({
      parsedResponse: { answer: 42 },
      structuredMode: "json_object_local_schema",
    });
  });

  it("omits unsupported temperature controls for reasoning model families", async () => {
    expect(providerSupportsTemperature("openai", "gpt-5.6")).toBe(false);
    expect(providerSupportsTemperature("openrouter", "openai/o3-mini")).toBe(false);
    expect(providerSupportsTemperature("deepseek", "deepseek-reasoner")).toBe(false);
    expect(providerSupportsTemperature("deepseek", "deepseek-v4-flash")).toBe(false);
    expect(providerSupportsTemperature("anthropic", "claude-opus-4-8")).toBe(false);
    expect(providerSupportsTemperature("anthropic", "claude-sonnet-5")).toBe(false);
    expect(providerSupportsTemperature("anthropic", "claude-sonnet-4-6")).toBe(true);
    expect(providerSupportsTemperature("openai", "gpt-4o")).toBe(true);

    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, any>;
      expect(body).not.toHaveProperty("temperature");
      expect(body.reasoning_effort).toBe("none");
      expect(body.max_completion_tokens).toBe(1000);
      return new Response(
        JSON.stringify({
          choices: [{ finish_reason: "stop", message: { content: '{"answer":"yes"}' } }],
        }),
        { status: 200 },
      );
    });
    const provider = new OpenAIProvider(
      "gpt-5.6-sol",
      "key",
      { temperature: 0.8, maxOutputTokens: 1000 },
      "https://example.test/chat",
      fetchMock as typeof fetch,
    );
    await expect(provider.generateStructured(answerRequest)).resolves.toMatchObject({
      data: { answer: "yes" },
    });
  });

  it("disables default Kimi reasoning so structured output retains its token budget", async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, any>;
      expect(body.reasoning).toEqual({ effort: "none" });
      expect(body.plugins).toEqual([{ id: "response-healing" }]);
      expect(body.provider).toEqual({ require_parameters: true });
      expect(body.messages[0].content).toContain("OPENROUTER JSON OUTPUT CONTRACT");
      expect(body.messages[0].content).toContain("JSON Schema:");
      return new Response(
        JSON.stringify({
          choices: [{ finish_reason: "stop", message: { content: '{"answer":"yes"}' } }],
        }),
        { status: 200 },
      );
    });
    const provider = new OpenRouterProvider(
      "moonshotai/kimi-k2.6",
      "key",
      { temperature: 0.8, maxOutputTokens: 1000 },
      "https://example.test/chat",
      fetchMock as typeof fetch,
    );
    await expect(provider.generateStructured(answerRequest)).resolves.toMatchObject({
      data: { answer: "yes" },
    });
  });

  it("explicitly disables Luna reasoning while preserving strict structured output", async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, any>;
      expect(body.model).toBe("gpt-5.6-luna");
      expect(body.reasoning_effort).toBe("none");
      expect(body).not.toHaveProperty("temperature");
      expect(body.response_format).toMatchObject({
        type: "json_schema",
        json_schema: { name: "answer", strict: true },
      });
      return new Response(
        JSON.stringify({
          choices: [{ finish_reason: "stop", message: { content: '{"answer":"yes"}' } }],
        }),
        { status: 200 },
      );
    });
    const provider = new OpenAIProvider(
      "gpt-5.6-luna",
      "key",
      { temperature: 0.8, maxOutputTokens: 1000 },
      "https://example.test/chat",
      fetchMock as typeof fetch,
    );
    await expect(provider.generateStructured(answerRequest)).resolves.toMatchObject({
      data: { answer: "yes" },
    });
  });

  it("explicitly disables Terra reasoning while preserving strict structured output", async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, any>;
      expect(body.model).toBe("gpt-5.6-terra");
      expect(body.reasoning_effort).toBe("none");
      expect(body).not.toHaveProperty("temperature");
      expect(body.max_completion_tokens).toBe(1000);
      expect(body.response_format).toMatchObject({
        type: "json_schema",
        json_schema: { name: "answer", strict: true },
      });
      return new Response(
        JSON.stringify({
          choices: [{ finish_reason: "stop", message: { content: '{"answer":"yes"}' } }],
        }),
        { status: 200 },
      );
    });
    const provider = new OpenAIProvider(
      "gpt-5.6-terra",
      "key",
      { temperature: 0.8, maxOutputTokens: 1000 },
      "https://example.test/chat",
      fetchMock as typeof fetch,
    );
    await expect(provider.generateStructured(answerRequest)).resolves.toMatchObject({
      data: { answer: "yes" },
    });
  });

  it("explicitly disables Nano reasoning while preserving strict structured output", async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, any>;
      expect(body.model).toBe("gpt-5.4-nano");
      expect(body.reasoning_effort).toBe("none");
      expect(body).not.toHaveProperty("temperature");
      expect(body.max_completion_tokens).toBe(1000);
      expect(body.response_format).toMatchObject({
        type: "json_schema",
        json_schema: { name: "answer", strict: true },
      });
      return new Response(
        JSON.stringify({
          choices: [{ finish_reason: "stop", message: { content: '{"answer":"yes"}' } }],
        }),
        { status: 200 },
      );
    });
    const provider = new OpenAIProvider(
      "gpt-5.4-nano",
      "key",
      { temperature: 0.8, maxOutputTokens: 1000 },
      "https://example.test/chat",
      fetchMock as typeof fetch,
    );
    await expect(provider.generateStructured(answerRequest)).resolves.toMatchObject({
      data: { answer: "yes" },
    });
  });

  it("disables Qwen 3.7 Plus reasoning without enabling Kimi response healing", async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, any>;
      expect(body.reasoning).toEqual({ effort: "none" });
      expect(body).not.toHaveProperty("plugins");
      expect(body.messages[0].content).not.toContain("OPENROUTER JSON OUTPUT CONTRACT");
      return new Response(
        JSON.stringify({
          choices: [{ finish_reason: "stop", message: { content: '{"answer":"yes"}' } }],
        }),
        { status: 200 },
      );
    });
    const provider = new OpenRouterProvider(
      "qwen/qwen3.7-plus",
      "key",
      { temperature: 0.8, maxOutputTokens: 1000 },
      "https://example.test/chat",
      fetchMock as typeof fetch,
    );
    await expect(provider.generateStructured(answerRequest)).resolves.toMatchObject({
      data: { answer: "yes" },
    });
  });

  it("disables MiniMax M3 reasoning without enabling Kimi response healing", async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, any>;
      expect(body.reasoning).toEqual({ effort: "none" });
      expect(body).not.toHaveProperty("plugins");
      expect(body.messages[0].content).not.toContain("OPENROUTER JSON OUTPUT CONTRACT");
      return new Response(
        JSON.stringify({
          choices: [{ finish_reason: "stop", message: { content: '{"answer":"yes"}' } }],
        }),
        { status: 200 },
      );
    });
    const provider = new OpenRouterProvider(
      "minimax/minimax-m3",
      "key",
      { temperature: 0.8, maxOutputTokens: 1000 },
      "https://example.test/chat",
      fetchMock as typeof fetch,
    );
    await expect(provider.generateStructured(answerRequest)).resolves.toMatchObject({
      data: { answer: "yes" },
    });
  });

  it("explicitly selects Hy3 no-think mode without enabling Kimi response healing", async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, any>;
      expect(body.reasoning).toEqual({ effort: "none" });
      expect(body).not.toHaveProperty("plugins");
      expect(body.messages[0].content).not.toContain("OPENROUTER JSON OUTPUT CONTRACT");
      return new Response(
        JSON.stringify({
          choices: [{ finish_reason: "stop", message: { content: '{"answer":"yes"}' } }],
        }),
        { status: 200 },
      );
    });
    const provider = new OpenRouterProvider(
      "tencent/hy3",
      "key",
      { temperature: 0.8, maxOutputTokens: 1000 },
      "https://example.test/chat",
      fetchMock as typeof fetch,
    );
    await expect(provider.generateStructured(answerRequest)).resolves.toMatchObject({
      data: { answer: "yes" },
    });
  });

  it("disables GLM 4.6 reasoning", async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(body.reasoning).toEqual({ effort: "none" });
      expect(body).not.toHaveProperty("plugins");
      return new Response(
        JSON.stringify({
          choices: [{ finish_reason: "stop", message: { content: '{"answer":"yes"}' } }],
        }),
        { status: 200 },
      );
    });
    const provider = new OpenRouterProvider(
      "z-ai/glm-4.6",
      "key",
      { temperature: 0.8, maxOutputTokens: 1000 },
      "https://example.test/chat",
      fetchMock as typeof fetch,
    );
    await expect(provider.generateStructured(answerRequest)).resolves.toMatchObject({
      data: { answer: "yes" },
    });
  });

  it("disables DeepSeek V3.2 reasoning with its documented enabled boolean", async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, any>;
      expect(body.reasoning).toEqual({ enabled: false });
      expect(body).not.toHaveProperty("plugins");
      expect(body.provider).toEqual({ require_parameters: true });
      return new Response(
        JSON.stringify({
          choices: [{ finish_reason: "stop", message: { content: '{"answer":"yes"}' } }],
        }),
        { status: 200 },
      );
    });
    const provider = new OpenRouterProvider(
      "deepseek/deepseek-v3.2",
      "key",
      { temperature: 0.8, maxOutputTokens: 1000 },
      "https://example.test/chat",
      fetchMock as typeof fetch,
    );
    await expect(provider.generateStructured(answerRequest)).resolves.toMatchObject({
      data: { answer: "yes" },
    });
  });

  it("omits temperature for Claude Opus 4.8", async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body))).not.toHaveProperty("temperature");
      return new Response(
        JSON.stringify({
          stop_reason: "end_turn",
          content: [{ type: "text", text: '{"answer":"yes"}' }],
        }),
        { status: 200 },
      );
    });
    const provider = new AnthropicProvider(
      "claude-opus-4-8",
      "key",
      { temperature: 0.8, maxOutputTokens: 1000 },
      "https://example.test/messages",
      fetchMock as typeof fetch,
    );
    await expect(provider.generateStructured(answerRequest)).resolves.toMatchObject({
      data: { answer: "yes" },
    });
  });

  it("omits deprecated temperature for exact Claude Sonnet 5", async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(body.model).toBe("claude-sonnet-5");
      expect(body).not.toHaveProperty("temperature");
      expect(body.output_config).toBeDefined();
      return new Response(
        JSON.stringify({
          stop_reason: "end_turn",
          content: [{ type: "text", text: '{"answer":"yes"}' }],
        }),
        { status: 200 },
      );
    });
    const provider = new AnthropicProvider(
      "claude-sonnet-5",
      "key",
      { temperature: 0.8, maxOutputTokens: 1000 },
      "https://example.test/messages",
      fetchMock as typeof fetch,
    );
    await expect(
      provider.generateStructured({
        ...answerRequest,
        temperature: 0,
      }),
    ).resolves.toMatchObject({ data: { answer: "yes" } });
  });

  it("classifies OpenAI and Anthropic refusals as content blocks with usage", async () => {
    const openAi = new OpenAIProvider(
      "gpt-4o",
      "key",
      { temperature: 0.8, maxOutputTokens: 1000 },
      "https://example.test/chat",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              choices: [{ finish_reason: "stop", message: { refusal: "Cannot comply." } }],
              usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
            }),
            { status: 200 },
          ),
      ) as typeof fetch,
    );
    const anthropic = new AnthropicProvider(
      "claude-model",
      "key",
      { temperature: 0.8, maxOutputTokens: 1000 },
      "https://example.test/messages",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              stop_reason: "refusal",
              content: [{ type: "text", text: "Cannot comply." }],
              usage: { input_tokens: 6, output_tokens: 3 },
            }),
            { status: 200 },
          ),
      ) as typeof fetch,
    );

    for (const provider of [openAi, anthropic]) {
      let failure: unknown;
      try {
        await provider.generateStructured(answerRequest);
      } catch (error) {
        failure = error;
      }
      expect(failure).toMatchObject({ kind: "content_block", retryable: false });
      expect(structuredFailureDetails(failure)?.usage?.inputTokens).toBeGreaterThan(0);
    }
  });

  it("retains usage and truncation classification for incomplete OpenAI and Anthropic JSON", async () => {
    const openAi = new OpenAIProvider(
      "gpt-4o",
      "key",
      { temperature: 0.8, maxOutputTokens: 1000 },
      "https://example.test/chat",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              choices: [{ finish_reason: "length", message: { content: '{"answer":' } }],
              usage: { prompt_tokens: 5, completion_tokens: 100, total_tokens: 105 },
            }),
            { status: 200 },
          ),
      ) as typeof fetch,
    );
    const anthropic = new AnthropicProvider(
      "claude-model",
      "key",
      { temperature: 0.8, maxOutputTokens: 1000 },
      "https://example.test/messages",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              stop_reason: "max_tokens",
              content: [{ type: "text", text: '{"answer":' }],
              usage: { input_tokens: 6, output_tokens: 100 },
            }),
            { status: 200 },
          ),
      ) as typeof fetch,
    );

    for (const provider of [openAi, anthropic]) {
      let failure: unknown;
      try {
        await provider.generateStructured(answerRequest);
      } catch (error) {
        failure = error;
      }
      expect(failure).toMatchObject({ kind: "malformed_json", retryable: true });
      expect((failure as Error).message).toContain("truncated");
      expect(structuredFailureDetails(failure)?.usage?.outputTokens).toBe(100);
    }
  });

  it("uses the Gemini-compatible schema projection for Gemini routed through OpenRouter", async () => {
    const constrainedSchema = z.object({
      id: z
        .string()
        .regex(/^[a-z]+$/)
        .min(2)
        .default("hero"),
      kind: z.literal("person"),
      entries: z.array(z.string()).max(3),
    });
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, any>;
      const schema = body.response_format.json_schema.schema;
      const serialized = JSON.stringify(schema);
      expect(schema.properties.kind.enum).toEqual(["person"]);
      expect(serialized).not.toContain('"$schema"');
      expect(serialized).not.toContain('"default"');
      expect(serialized).not.toContain('"pattern"');
      expect(schema.properties.entries).not.toHaveProperty("maxItems");
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: '{"id":"hero","kind":"person","entries":["one"]}' } }],
        }),
        { status: 200 },
      );
    });
    const provider = new OpenRouterProvider(
      "google/gemini-3.5-flash",
      "key",
      { temperature: 0.8, maxOutputTokens: 1000 },
      "https://example.test/chat",
      fetchMock as typeof fetch,
    );
    expect(
      (
        await provider.generateStructured({
          ...answerRequest,
          schemaName: "constrained",
          schema: constrainedSchema,
        })
      ).data.entries,
    ).toEqual(["one"]);
  });

  it("enforces Gameplay Contract V1 machine codes and decodes its stable effect shape into domain operations", async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, any>;
      const schema = body.response_format.json_schema.schema;
      expect(schema).toEqual(GAMEPLAY_WIRE_JSON_SCHEMA);
      expect(schema.properties.narration.description).toContain("check_required");
      expect(schema.properties.effects.description).toContain("check_required");
      expect(schema.properties.summary.description).toContain("check_required");
      expect(schema.properties.effects.items.required).toContain("references");
      expect(schema.properties.effects.items.properties.text.description).toContain("advance_time");
      expect(schema.properties.effects).not.toHaveProperty("maxItems");
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify(
                  resolvedWire([
                    effect({
                      kind: "create_entity",
                      targetId: "location:market-square",
                      entityKindCode: 2,
                      name: "Market Square",
                      status: "open",
                      text: "A busy public square.",
                      tags: ["market"],
                    }),
                  ]),
                ),
              },
            },
          ],
        }),
        { status: 200 },
      );
    });
    const provider = new OpenRouterProvider(
      "provider/model",
      "key",
      { temperature: 0.8, maxOutputTokens: 1000 },
      "https://example.test/chat",
      fetchMock as typeof fetch,
    );
    const result = await provider.generateStructured(gameplayRequest);
    expect(result.structuredMode).toBe("exact_schema");
    expect(result.protocolVersion).toBe(3);
    expect(result.data).toMatchObject({
      kind: "resolved",
      operations: [
        { type: "create_entity", entity: { id: "location:market-square", kind: "location" } },
      ],
    });
  });

  it("remaps an unsafe same-turn create hint and its exact references before allocating a durable ID", async () => {
    const unsafeHint = "npc:Master Haddon";
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify(
                    resolvedWire(
                      [
                        effect({
                          kind: "add_fact",
                          targetId: unsafeHint,
                          factSectionCode: 3,
                          factBasisCode: 0,
                          text: "Haddon offered a timber-line patrol contract.",
                        }),
                        effect({
                          kind: "set_relationship",
                          targetId: "player:hero",
                          relatedId: unsafeHint,
                          text: "The hero works for Haddon as a contracted scout.",
                        }),
                        effect({
                          kind: "create_entity",
                          targetId: unsafeHint,
                          relatedId: "location:crooked-crown",
                          entityKindCode: 1,
                          name: "Master Haddon",
                          status: "watchful",
                          text: "A practical timber foreman.",
                          tags: ["foreman"],
                        }),
                      ]),
                  ),
                },
              },
            ],
          }),
          { status: 200 },
        ),
    );
    const provider = new OpenRouterProvider(
      "provider/model",
      "key",
      { temperature: 0.8, maxOutputTokens: 1000 },
      "https://example.test/chat",
      fetchMock as typeof fetch,
    );

    const generated = await provider.generateStructured(gameplayRequest);
    expect(generated.data.kind).toBe("resolved");
    if (generated.data.kind === "check_required") throw new Error("Expected a resolved turn");
    const createdHint = generated.data.operations.find(
      (operation) => operation.type === "create_entity",
    )?.entity.id;
    expect(createdHint).toMatch(/^generated:wire-create-/u);
    expect(generated.data.operations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "add_fact", targetId: createdHint }),
        expect.objectContaining({ type: "set_relationship", targetId: createdHint }),
        expect.objectContaining({
          type: "create_entity",
          entity: expect.objectContaining({ id: createdHint }),
        }),
      ]),
    );

    const store = await createTestStore();
    const committed = await store.commitTurnWithResult({
      action: "I accept Haddon's patrol contract.",
      resolved: generated.data,
      provider: generated.provider,
      model: generated.model,
    });
    const durableId = committed.operations.find((operation) => operation.type === "create_entity")
      ?.entity.id;
    expect(durableId).toBe("npc:master-haddon");
    expect(durableId).not.toBe(createdHint);
    expect(committed.operations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "add_fact", targetId: durableId }),
        expect.objectContaining({ type: "set_relationship", targetId: durableId }),
      ]),
    );
    expect((await store.load()).entities.has(durableId!)).toBe(true);
  });

  it("does not sanitize unsafe established references, empty creates, duplicates, or near-misses", async () => {
    const store = await createTestStore();
    const unresolvedEstablished = decodeTurnDecision(
      resolvedWire([
        effect({
          kind: "add_fact",
          targetId: "npc:Unknown Established Actor",
          factSectionCode: 3,
          factBasisCode: 0,
          text: "This must not be attached to a guessed actor.",
        }),
      ]),
    );
    expect(unresolvedEstablished.kind).toBe("resolved");
    if (unresolvedEstablished.kind === "check_required") {
      throw new Error("Expected a resolved turn");
    }
    expect(unresolvedEstablished.operations[0]).toMatchObject({
      type: "add_fact",
      targetId: "npc:Unknown Established Actor",
    });
    await expect(
      store.commitTurnWithResult({
        action: "I rely on an unknown actor.",
        resolved: unresolvedEstablished,
        provider: "fake",
        model: "fake-model",
      }),
    ).rejects.toThrow(/Unknown entity reference npc:Unknown Established Actor/u);

    expect(() =>
      decodeTurnDecision(
        resolvedWire([
          effect({
            kind: "create_entity",
            targetId: "",
            entityKindCode: 1,
            name: "Nameless Hint",
            text: "The empty hint remains invalid.",
          }),
        ]),
      ),
    ).toThrow(/effects\[0\]\.targetId: field is required/u);

    expect(() =>
      decodeTurnDecision(
        resolvedWire([
          effect({
            kind: "create_entity",
            targetId: "npc:Duplicate Hint",
            entityKindCode: 1,
            name: "First",
            text: "First duplicate.",
          }),
          effect({
            kind: "create_entity",
            targetId: "npc:Duplicate Hint",
            entityKindCode: 1,
            name: "Second",
            text: "Second duplicate.",
          }),
        ]),
      ),
    ).toThrow(/duplicate create_entity targetId hint/u);

    const nearMiss = decodeTurnDecision(
      resolvedWire([
        effect({
          kind: "create_entity",
          targetId: "npc:Master Haddon",
          relatedId: "location:crooked-crown",
          entityKindCode: 1,
          name: "Master Haddon",
          text: "A timber foreman.",
        }),
        effect({
          kind: "add_fact",
          targetId: "npc:Master Hadd0n",
          factSectionCode: 3,
          factBasisCode: 0,
          text: "A near-miss must not be rewritten by the wire decoder.",
        }),
      ]),
    );
    expect(nearMiss.kind).toBe("resolved");
    if (nearMiss.kind === "check_required") throw new Error("Expected a resolved turn");
    expect(nearMiss.operations[1]).toMatchObject({ targetId: "npc:Master Hadd0n" });
    await expect(
      store.commitTurnWithResult({
        action: "I rely on a near-miss actor reference.",
        resolved: nearMiss,
        provider: "fake",
        model: "fake-model",
      }),
    ).rejects.toThrow(/Unknown entity reference npc:Master Hadd0n/u);
  });

  it("rejects domain-shaped and prose-coded responses outside the wire contract", () => {
    expect(
      WireTurnSchema.safeParse({
        kind: "resolved",
        turnSummary: "wrong shape",
        operations: [],
      }).success,
    ).toBe(false);
    expect(
      WireTurnSchema.safeParse(
        resolvedWire([
          {
            ...effect({
              kind: "add_fact",
              targetId: "player:hero",
              factSectionCode: 3,
              factBasisCode: 0,
              text: "A clue.",
            }),
            factSectionCode: "Player Knowledge",
          },
        ]),
      ).success,
    ).toBe(false);
    expect(
      decodeTurnDecision(
        resolvedWire([
          effect({
            kind: "add_fact",
            targetId: "player:hero",
            factSectionCode: 3,
            factBasisCode: 0,
            text: "A clue.",
          }),
        ]),
      ),
    ).toMatchObject({ kind: "resolved", operations: [{ type: "add_fact", section: "knowledge" }] });
  });

  it("decodes explicit automatic outcomes and rejects reasons on silent direct resolution", () => {
    expect(
      decodeTurnDecision({
        ...resolvedWire(),
        checkName: "The captive is already restrained.",
        successStakes: "$automatic_success",
      }),
    ).toMatchObject({
      kind: "automatic_success",
      reason: "The captive is already restrained.",
      narration: "Schema enforcement verified.",
    });
    expect(() =>
      decodeTurnDecision({ ...resolvedWire(), checkName: "This must stay silent." }),
    ).toThrow(/check strings/);
    expect(() =>
      decodeTurnDecision({
        ...resolvedWire(),
        failureStakes: "$automatic_failure",
      }),
    ).toThrow(/checkName/);
  });

  it("uses explicit sentinels without losing intentional empty list updates", () => {
    expect(
      decodeTurnDecision(
        resolvedWire([
          effect({
            kind: "set_entity_state",
            targetId: "npc:mara-venn",
            name: "Mara",
            tags: ["$unchanged"],
          }),
          // Thread lifecycle is an ordinary effect again, addressed by the
          // thread's number in context. The domain owns the thread list, so the
          // decoder emits the ordinal as a reference hint and resolves nothing.
          effect({ kind: "update_thread", threadOrdinal: 1, text: "The road is open." }),
          effect({
            kind: "resolve_thread",
            threadOrdinal: 2,
            lifecycleCode: 2,
            text: "The caravan was never found.",
            references: ["$unchanged"],
          }),
        ]),
      ),
    ).toMatchObject({
      kind: "resolved",
      operations: [
        { type: "set_entity_state", targetId: "npc:mara-venn", name: "Mara" },
        { type: "update_thread", threadId: "$thread:1", summary: "The road is open." },
        {
          type: "resolve_thread",
          threadId: "$thread:2",
          status: "failed",
          outcome: "The caravan was never found.",
        },
      ],
    });
    // A retained-links sentinel leaves the durable references untouched.
    expect(
      decodeTurnDecision(
        resolvedWire([
          effect({
            kind: "update_thread",
            threadOrdinal: 1,
            text: "Still open.",
            references: ["$unchanged"],
          }),
        ]),
      ).operations[0],
    ).not.toHaveProperty("relatedEntityIds");
    // One thread, one effect: the only duplicate representation a single
    // channel can still express.
    expect(() =>
      decodeTurnDecision(
        resolvedWire([
          effect({ kind: "update_thread", threadOrdinal: 1, text: "First." }),
          effect({ kind: "update_thread", threadOrdinal: 1, text: "Second." }),
        ]),
      ),
    ).toThrow(/addressed at most once/);
    // An ordinal is required: a thread effect cannot fall back to an ID.
    expect(() =>
      decodeTurnDecision(
        resolvedWire([effect({ kind: "update_thread", targetId: "thread:road", text: "By ID." })]),
      ),
    ).toThrow(/1-based number/);
    expect(() =>
      decodeTurnDecision(
        resolvedWire(
          Array.from({ length: 41 }, () => effect({ kind: "record_major_event", text: "Event" })),
        ),
      ),
    ).toThrow();
  });

  it("classifies wire-valid but domain-invalid effects separately", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify(
                    resolvedWire([
                      effect({
                        kind: "end_campaign",
                        lifecycleCode: 1,
                        text: "Not a valid ending.",
                      }),
                    ]),
                  ),
                },
              },
            ],
          }),
          { status: 200 },
        ),
    );
    const provider = new OpenRouterProvider(
      "provider/model",
      "key",
      { temperature: 0.8, maxOutputTokens: 1000 },
      "https://example.test/chat",
      fetchMock as typeof fetch,
    );
    await expect(provider.generateStructured(gameplayRequest)).rejects.toMatchObject({
      kind: "domain_decode_violation",
    });
  });

  it("sends and validates the exact Gameplay Contract V1 schema through Gemini", async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, any>;
      const schema = body.generationConfig.responseFormat.text.schema;
      expect(schema.type).toBe("object");
      expect(schema.required).toContain("failureCampaignStatus");
      expect(schema.properties.effects.items.additionalProperties).toBe(false);
      expect(schema.properties.effects).not.toHaveProperty("maxItems");
      return new Response(
        JSON.stringify({
          candidates: [{ content: { parts: [{ text: JSON.stringify(resolvedWire()) }] } }],
          usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 10, totalTokenCount: 30 },
        }),
        { status: 200 },
      );
    });
    const provider = new GeminiProvider(
      "gemini-model",
      "key",
      { temperature: 0.8, maxOutputTokens: 1000 },
      "https://example.test/v1beta",
      fetchMock as typeof fetch,
    );
    const result = await provider.generateStructured(gameplayRequest);
    expect(result.data).toMatchObject({ kind: "resolved", operations: [] });
    expect(result.usage).toEqual({ inputTokens: 20, outputTokens: 10, totalTokens: 30 });
  });

  it.each([
    ["non-JSON", "not json", 200],
    ["null", "null", 200],
    ["root array", "[]", 200],
    ["malformed object", '{"candidates":[42]}', undefined],
  ])(
    "fails closed on a %s Gemini success envelope with attempt metadata",
    async (_case, body, status) => {
      const provider = new GeminiProvider(
        "gemini-model",
        "key",
        { temperature: 0.8, maxOutputTokens: 1000 },
        "https://example.test/v1beta",
        vi.fn(async () => new Response(body, { status: 200 })) as typeof fetch,
      );
      let failure: unknown;
      try {
        await provider.generateStructured(answerRequest);
      } catch (error) {
        failure = error;
      }

      expect(failure).toMatchObject({ kind: "provider", retryable: false });
      expect((failure as GenerationFailure).status).toBe(status);
      expect(attemptMetadataFor(failure)).toEqual({
        provider: "gemini",
        model: "gemini-model",
        route: "direct",
        attemptKind: "initial",
        structuredMode: "exact_schema",
        schemaProjection: "gemini_compatible_v1",
        outputTokenField: "maxOutputTokens",
        outputTokenBudget: 1000,
        retryBackoffMs: 0,
        truncated: false,
      });
    },
  );

  it.each([
    [
      "Chat Completions",
      (fetchMock: typeof fetch): LlmProvider =>
        new OpenAIProvider(
          "gpt-4o",
          "key",
          { temperature: 0.8, maxOutputTokens: 1000 },
          "https://example.test/chat",
          fetchMock,
        ),
    ],
    [
      "Anthropic Messages",
      (fetchMock: typeof fetch): LlmProvider =>
        new AnthropicProvider(
          "claude-model",
          "key",
          { temperature: 0.8, maxOutputTokens: 1000 },
          "https://example.test/messages",
          fetchMock,
        ),
    ],
    [
      "Gemini",
      (fetchMock: typeof fetch): LlmProvider =>
        new GeminiProvider(
          "gemini-model",
          "key",
          { temperature: 0.8, maxOutputTokens: 1000 },
          "https://example.test/v1beta",
          fetchMock,
        ),
    ],
  ])("propagates terminal cancellation through the %s transport", async (_case, createProvider) => {
    const controller = new AbortController();
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const fetchMock = vi.fn(
      async (_url: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          const rejectAbort = (): void => reject(new DOMException("aborted", "AbortError"));
          init?.signal?.addEventListener("abort", rejectAbort, { once: true });
          markStarted?.();
          if (init?.signal?.aborted) rejectAbort();
        }),
    );
    const provider = createProvider(fetchMock as typeof fetch);
    const pending = provider.generateStructured({ ...answerRequest, signal: controller.signal });
    await started;
    controller.abort();

    let failure: unknown;
    try {
      await pending;
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({ kind: "cancelled", retryable: false });
    expect(attemptMetadataFor(failure)).toMatchObject({
      provider: provider.id,
      model: provider.model,
      attemptKind: "initial",
      retryBackoffMs: 0,
      truncated: false,
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("rejects root arrays rather than selecting or merging a candidate", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            candidates: [{ content: { parts: [{ text: '[{"answer":"yes"}]' }] } }],
          }),
          { status: 200 },
        ),
    );
    const provider = new GeminiProvider(
      "gemini-model",
      "key",
      { temperature: 0.8, maxOutputTokens: 1000 },
      "https://example.test/v1beta",
      fetchMock as typeof fetch,
    );
    await expect(provider.generateStructured(answerRequest)).rejects.toBeInstanceOf(z.ZodError);
  });

  it("preserves optional setup-location guidance in Gemini's compatible schema", async () => {
    let projectedEntitySchema: Record<string, any> | undefined;
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, any>;
      projectedEntitySchema =
        body.generationConfig.responseFormat.text.schema.properties.entities.items;
      return new Response(
        JSON.stringify({
          candidates: [
            {
              finishReason: "STOP",
              content: { parts: [{ text: JSON.stringify(setupFixture) }] },
            },
          ],
        }),
        { status: 200 },
      );
    });
    const provider = new GeminiProvider(
      "gemini-model",
      "key",
      { temperature: 0.8, maxOutputTokens: 16_000 },
      "https://example.test/v1beta",
      fetchMock as typeof fetch,
    );

    await expect(
      provider.generateStructured({
        schemaName: "campaign_setup",
        schema: SetupResultSchema,
        system: "system",
        prompt: "prompt",
      }),
    ).resolves.toMatchObject({ data: setupFixture });

    const projectedLocation = projectedEntitySchema?.properties.location;
    expect(projectedEntitySchema?.required).not.toContain("location");
    expect(projectedLocation).not.toHaveProperty("pattern");
    expect(projectedLocation?.description).toContain("physical containment");
    expect(projectedLocation?.description).toContain("omit it for a top-level location");
  });

  it("retains raw schema-invalid output and billed usage for diagnostics", async () => {
    const rawText = '[{"answer":"one"},{"answer":"two"}]';
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            candidates: [{ content: { parts: [{ text: rawText }] } }],
            usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 10, totalTokenCount: 30 },
          }),
          { status: 200 },
        ),
    );
    const provider = new GeminiProvider(
      "gemini-model",
      "key",
      { temperature: 0.8, maxOutputTokens: 1000 },
      "https://example.test/v1beta",
      fetchMock as typeof fetch,
    );
    let failure: unknown;
    try {
      await provider.generateStructured(answerRequest);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(z.ZodError);
    expect(structuredFailureDetails(failure)).toMatchObject({
      rawText,
      parsedResponse: [{ answer: "one" }, { answer: "two" }],
      structuredMode: "exact_schema",
      usage: { inputTokens: 20, outputTokens: 10, totalTokens: 30 },
    });
  });

  it("classifies incomplete JSON without salvaging a nested value", async () => {
    const rawText = '{"outer":{"answer":"yes"}';
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            candidates: [{ finishReason: "MAX_TOKENS", content: { parts: [{ text: rawText }] } }],
          }),
          { status: 200 },
        ),
    );
    const provider = new GeminiProvider(
      "gemini-model",
      "key",
      { temperature: 0.8, maxOutputTokens: 1000 },
      "https://example.test/v1beta",
      fetchMock as typeof fetch,
    );
    let failure: unknown;
    try {
      await provider.generateStructured(answerRequest);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(GenerationFailure);
    expect((failure as GenerationFailure).kind).toBe("malformed_json");
    expect(structuredFailureDetails(failure)?.rawText).toBe(rawText);
  });

  it("classifies a no-content MAX_TOKENS response as a repairable truncated JSON failure", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            candidates: [{ finishReason: "MAX_TOKENS" }],
            usageMetadata: {
              promptTokenCount: 20,
              candidatesTokenCount: 100,
              totalTokenCount: 120,
            },
          }),
          { status: 200 },
        ),
    );
    const provider = new GeminiProvider(
      "gemini-model",
      "key",
      { temperature: 0.8, maxOutputTokens: 1000 },
      "https://example.test/v1beta",
      fetchMock as typeof fetch,
    );
    let failure: unknown;
    try {
      await provider.generateStructured(answerRequest);
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({ kind: "malformed_json", retryable: true });
    expect(structuredFailureDetails(failure)).toMatchObject({
      rawText: "",
      structuredMode: "exact_schema",
      usage: { inputTokens: 20, outputTokens: 100, totalTokens: 120 },
    });
  });

  it("classifies Gemini PROHIBITED_CONTENT as a typed content block with usage and metadata", async () => {
    const provider = new GeminiProvider(
      "gemini-model",
      "key",
      { temperature: 0.8, maxOutputTokens: 1000 },
      "https://example.test/v1beta",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              candidates: [{ finishReason: "PROHIBITED_CONTENT" }],
              usageMetadata: {
                promptTokenCount: 20,
                candidatesTokenCount: 3,
                totalTokenCount: 23,
              },
            }),
            { status: 200 },
          ),
      ) as typeof fetch,
    );

    let failure: unknown;
    try {
      await provider.generateStructured(answerRequest);
    } catch (error) {
      failure = error;
    }

    expect(failure).toMatchObject({ kind: "content_block", retryable: false });
    expect(structuredFailureDetails(failure)).toMatchObject({
      rawText: "",
      parsedResponse: null,
      structuredMode: "exact_schema",
      usage: { inputTokens: 20, outputTokens: 3, totalTokens: 23 },
      attemptMetadata: {
        finishReason: "PROHIBITED_CONTENT",
        truncated: false,
      },
    });
  });

  it("classifies a Gemini prompt-feedback block when no candidate exists", async () => {
    const provider = new GeminiProvider(
      "gemini-model",
      "key",
      { temperature: 0.8, maxOutputTokens: 1000 },
      "https://example.test/v1beta",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              promptFeedback: { blockReason: "BLOCKLIST" },
              usageMetadata: { promptTokenCount: 20, totalTokenCount: 20 },
            }),
            { status: 200 },
          ),
      ) as typeof fetch,
    );

    let failure: unknown;
    try {
      await provider.generateStructured(answerRequest);
    } catch (error) {
      failure = error;
    }

    expect(failure).toMatchObject({ kind: "content_block", retryable: false });
    expect(structuredFailureDetails(failure)).toMatchObject({
      usage: { inputTokens: 20, totalTokens: 20 },
      attemptMetadata: { finishReason: "BLOCKLIST" },
    });
  });

  it("removes unsupported JSON Schema keywords before calling Gemini", async () => {
    const constrainedSchema = z.object({
      id: z
        .string()
        .regex(/^[a-z]+$/)
        .min(2)
        .default("hero"),
      kind: z.literal("person"),
      quantity: z.number().int().positive().max(20),
      entries: z.array(z.string()).max(3),
    });
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, any>;
      const schema = body.generationConfig.responseFormat.text.schema;
      const serialized = JSON.stringify(schema);
      expect(schema.properties.kind.enum).toEqual(["person"]);
      expect(schema.properties.quantity.maximum).toBe(20);
      expect(serialized).not.toContain('"$schema"');
      expect(serialized).not.toContain('"default"');
      expect(serialized).not.toContain('"pattern"');
      expect(schema.properties.entries).not.toHaveProperty("maxItems");
      return new Response(
        JSON.stringify({
          candidates: [
            {
              content: {
                parts: [{ text: '{"id":"hero","kind":"person","quantity":1,"entries":["one"]}' }],
              },
            },
          ],
        }),
        { status: 200 },
      );
    });
    const provider = new GeminiProvider(
      "gemini-model",
      "key",
      { temperature: 0.8, maxOutputTokens: 1000 },
      "https://example.test/v1beta",
      fetchMock as typeof fetch,
    );
    expect(
      (
        await provider.generateStructured({
          ...answerRequest,
          schemaName: "constrained",
          schema: constrainedSchema,
        })
      ).data.quantity,
    ).toBe(1);
  });

  it("fails closed after one request when Gemini rejects the exact schema", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            error: { status: "INVALID_ARGUMENT", message: "Schema is too complex." },
          }),
          { status: 400 },
        ),
    );
    const provider = new GeminiProvider(
      "gemini-model",
      "key",
      { temperature: 0.8, maxOutputTokens: 1000 },
      "https://example.test/v1beta",
      fetchMock as typeof fetch,
    );
    await expect(provider.generateStructured(gameplayRequest)).rejects.toMatchObject({
      kind: "schema_rejected",
      retryable: false,
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("does not accept commentary or Markdown fences around structured JSON", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            candidates: [{ content: { parts: [{ text: '```json\n{"answer":"yes"}\n```' }] } }],
          }),
          { status: 200 },
        ),
    );
    const provider = new GeminiProvider(
      "gemini-model",
      "key",
      { temperature: 0.8, maxOutputTokens: 1000 },
      "https://example.test/v1beta",
      fetchMock as typeof fetch,
    );
    await expect(provider.generateStructured(answerRequest)).rejects.toMatchObject({
      kind: "malformed_json",
    });
  });
});
