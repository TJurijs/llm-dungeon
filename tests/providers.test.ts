import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { GeminiProvider, OpenRouterProvider } from "../src/providers.js";
import { TurnDecisionSchema } from "../src/schemas.js";
import {
  GAMEPLAY_PROTOCOL_VERSION,
  GAMEPLAY_WIRE_JSON_SCHEMA,
  WireTurnSchema,
  decodeTurnDecision,
} from "../src/llm/gameplay-protocol.js";
import { GenerationFailure } from "../src/llm/failures.js";
import { structuredFailureDetails } from "../src/llm/structured-error.js";

const answerSchema = z.object({ answer: z.string() });
const answerRequest = { schemaName: "answer", schema: answerSchema, system: "system", prompt: "prompt" };

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
    entityKindCode: 0,
    factSectionCode: 0,
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
  schemaName: "turn_decision_v1",
  schema: TurnDecisionSchema,
  wireSchema: WireTurnSchema,
  jsonSchema: GAMEPLAY_WIRE_JSON_SCHEMA,
  decodeResponse: decodeTurnDecision,
  protocolVersion: GAMEPLAY_PROTOCOL_VERSION,
  system: "system",
  prompt: "prompt",
};

describe("provider adapters", () => {
  it.each([
    ["OpenRouter", (apiKey: string, fetchMock: typeof fetch) =>
      new OpenRouterProvider("provider/model", apiKey, { temperature: 0.8, maxOutputTokens: 1000 }, "https://example.test/chat", fetchMock)],
    ["Gemini", (apiKey: string, fetchMock: typeof fetch) =>
      new GeminiProvider("gemini-model", apiKey, { temperature: 0.8, maxOutputTokens: 1000 }, "https://example.test/v1beta", fetchMock)],
  ])("redacts the configured API key from %s HTTP failures", async (_name, createProvider) => {
    const apiKey = "test-key-that-must-not-escape";
    const fetchMock = vi.fn(async () => new Response(
      JSON.stringify({ error: `Invalid credential ${apiKey}; received ${apiKey}` }),
      { status: 401 },
    ));
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
    const fetchMock = vi.fn(async () => new Response(
      `${"x".repeat(992)}${apiKey}`,
      { status: 401 },
    ));
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

  it.each([
    ["OpenRouter", (apiKey: string, fetchMock: typeof fetch) =>
      new OpenRouterProvider("provider/model", apiKey, { temperature: 0.8, maxOutputTokens: 1000 }, "https://example.test/chat", fetchMock)],
    ["Gemini", (apiKey: string, fetchMock: typeof fetch) =>
      new GeminiProvider("gemini-model", apiKey, { temperature: 0.8, maxOutputTokens: 1000 }, "https://example.test/v1beta", fetchMock)],
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
      return new Response(JSON.stringify({ choices: [{ message: { content: '{"answer":"yes"}' } }], usage: { total_tokens: 4 } }), { status: 200 });
    });
    const provider = new OpenRouterProvider("provider/model", "key", { temperature: 0.8, maxOutputTokens: 1000 }, "https://example.test/chat", fetchMock as typeof fetch);
    expect((await provider.generateStructured(answerRequest)).data).toEqual({ answer: "yes" });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("uses the Gemini-compatible schema projection for Gemini routed through OpenRouter", async () => {
    const constrainedSchema = z.object({
      id: z.string().regex(/^[a-z]+$/).min(2).default("hero"),
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
      return new Response(JSON.stringify({
        choices: [{ message: { content: '{"id":"hero","kind":"person","entries":["one"]}' } }],
      }), { status: 200 });
    });
    const provider = new OpenRouterProvider(
      "google/gemini-3.5-flash",
      "key",
      { temperature: 0.8, maxOutputTokens: 1000 },
      "https://example.test/chat",
      fetchMock as typeof fetch,
    );
    expect((await provider.generateStructured({ ...answerRequest, schemaName: "constrained", schema: constrainedSchema })).data.entries).toEqual(["one"]);
  });

  it("enforces Gameplay Contract V1 machine codes and decodes its stable effect shape into domain operations", async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, any>;
      const schema = body.response_format.json_schema.schema;
      expect(schema).toEqual(GAMEPLAY_WIRE_JSON_SCHEMA);
      expect(schema.properties.effects.items.required).toContain("references");
      expect(schema.properties.effects).not.toHaveProperty("maxItems");
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(resolvedWire([
        effect({
          kind: "create_entity",
          targetId: "location:market-square",
          entityKindCode: 2,
          name: "Market Square",
          status: "open",
          text: "A busy public square.",
          tags: ["market"],
        }),
      ])) } }] }), { status: 200 });
    });
    const provider = new OpenRouterProvider("provider/model", "key", { temperature: 0.8, maxOutputTokens: 1000 }, "https://example.test/chat", fetchMock as typeof fetch);
    const result = await provider.generateStructured(gameplayRequest);
    expect(result.structuredMode).toBe("exact_schema");
    expect(result.protocolVersion).toBe(1);
    expect(result.data).toMatchObject({
      kind: "resolved",
      operations: [{ type: "create_entity", entity: { id: "location:market-square", kind: "location" } }],
    });
  });

  it("rejects domain-shaped and prose-coded responses outside the wire contract", () => {
    expect(WireTurnSchema.safeParse({
      kind: "resolved",
      turnSummary: "wrong shape",
      operations: [],
    }).success).toBe(false);
    expect(WireTurnSchema.safeParse(resolvedWire([
      { ...effect({ kind: "add_fact", targetId: "player:hero", factSectionCode: 3, text: "A clue." }), factSectionCode: "Player Knowledge" },
    ])).success).toBe(false);
    expect(decodeTurnDecision(resolvedWire([
      effect({ kind: "add_fact", targetId: "player:hero", factSectionCode: 3, text: "A clue." }),
    ]))).toMatchObject({ kind: "resolved", operations: [{ type: "add_fact", section: "knowledge" }] });
  });

  it("uses explicit sentinels without losing intentional empty list updates", () => {
    expect(decodeTurnDecision(resolvedWire([
      effect({ kind: "set_entity_state", targetId: "npc:mara-venn", name: "Mara", tags: ["$unchanged"] }),
      effect({ kind: "update_thread", targetId: "thread:northern-road", text: "The road is open.", references: [] }),
    ]))).toMatchObject({
      kind: "resolved",
      operations: [
        { type: "set_entity_state", targetId: "npc:mara-venn", name: "Mara" },
        { type: "update_thread", threadId: "thread:northern-road", relatedEntityIds: [] },
      ],
    });
    expect(() => decodeTurnDecision(resolvedWire(Array.from({ length: 41 }, () =>
      effect({ kind: "record_major_event", text: "Event" }))))).toThrow();
  });

  it("classifies wire-valid but domain-invalid effects separately", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify(resolvedWire([
        effect({ kind: "end_campaign", lifecycleCode: 1, text: "Not a valid ending." }),
      ])) } }],
    }), { status: 200 }));
    const provider = new OpenRouterProvider("provider/model", "key", { temperature: 0.8, maxOutputTokens: 1000 }, "https://example.test/chat", fetchMock as typeof fetch);
    await expect(provider.generateStructured(gameplayRequest)).rejects.toMatchObject({ kind: "domain_decode_violation" });
  });

  it("sends and validates the exact Gameplay Contract V1 schema through Gemini", async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, any>;
      const schema = body.generationConfig.responseFormat.text.schema;
      expect(schema.type).toBe("object");
      expect(schema.required).toContain("failureCampaignStatus");
      expect(schema.properties.effects.items.additionalProperties).toBe(false);
      expect(schema.properties.effects).not.toHaveProperty("maxItems");
      return new Response(JSON.stringify({
        candidates: [{ content: { parts: [{ text: JSON.stringify(resolvedWire()) }] } }],
        usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 10, totalTokenCount: 30 },
      }), { status: 200 });
    });
    const provider = new GeminiProvider("gemini-model", "key", { temperature: 0.8, maxOutputTokens: 1000 }, "https://example.test/v1beta", fetchMock as typeof fetch);
    const result = await provider.generateStructured(gameplayRequest);
    expect(result.data).toMatchObject({ kind: "resolved", operations: [] });
    expect(result.usage).toEqual({ inputTokens: 20, outputTokens: 10, totalTokens: 30 });
  });

  it("rejects root arrays rather than selecting or merging a candidate", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      candidates: [{ content: { parts: [{ text: '[{"answer":"yes"}]' }] } }],
    }), { status: 200 }));
    const provider = new GeminiProvider("gemini-model", "key", { temperature: 0.8, maxOutputTokens: 1000 }, "https://example.test/v1beta", fetchMock as typeof fetch);
    await expect(provider.generateStructured(answerRequest)).rejects.toBeInstanceOf(z.ZodError);
  });

  it("retains raw schema-invalid output and billed usage for diagnostics", async () => {
    const rawText = '[{"answer":"one"},{"answer":"two"}]';
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      candidates: [{ content: { parts: [{ text: rawText }] } }],
      usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 10, totalTokenCount: 30 },
    }), { status: 200 }));
    const provider = new GeminiProvider("gemini-model", "key", { temperature: 0.8, maxOutputTokens: 1000 }, "https://example.test/v1beta", fetchMock as typeof fetch);
    let failure: unknown;
    try { await provider.generateStructured(answerRequest); } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(z.ZodError);
    expect(structuredFailureDetails(failure)).toEqual({
      rawText,
      parsedResponse: [{ answer: "one" }, { answer: "two" }],
      structuredMode: "exact_schema",
      usage: { inputTokens: 20, outputTokens: 10, totalTokens: 30 },
    });
  });

  it("classifies incomplete JSON without salvaging a nested value", async () => {
    const rawText = '{"outer":{"answer":"yes"}';
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      candidates: [{ finishReason: "MAX_TOKENS", content: { parts: [{ text: rawText }] } }],
    }), { status: 200 }));
    const provider = new GeminiProvider("gemini-model", "key", { temperature: 0.8, maxOutputTokens: 1000 }, "https://example.test/v1beta", fetchMock as typeof fetch);
    let failure: unknown;
    try { await provider.generateStructured(answerRequest); } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(GenerationFailure);
    expect((failure as GenerationFailure).kind).toBe("malformed_json");
    expect(structuredFailureDetails(failure)?.rawText).toBe(rawText);
  });

  it("classifies a no-content MAX_TOKENS response as a repairable truncated JSON failure", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      candidates: [{ finishReason: "MAX_TOKENS" }],
      usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 100, totalTokenCount: 120 },
    }), { status: 200 }));
    const provider = new GeminiProvider("gemini-model", "key", { temperature: 0.8, maxOutputTokens: 1000 }, "https://example.test/v1beta", fetchMock as typeof fetch);
    let failure: unknown;
    try { await provider.generateStructured(answerRequest); } catch (error) { failure = error; }
    expect(failure).toMatchObject({ kind: "malformed_json", retryable: true });
    expect(structuredFailureDetails(failure)).toMatchObject({
      rawText: "",
      structuredMode: "exact_schema",
      usage: { inputTokens: 20, outputTokens: 100, totalTokens: 120 },
    });
  });

  it("removes unsupported JSON Schema keywords before calling Gemini", async () => {
    const constrainedSchema = z.object({
      id: z.string().regex(/^[a-z]+$/).min(2).default("hero"),
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
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: '{"id":"hero","kind":"person","quantity":1,"entries":["one"]}' }] } }] }), { status: 200 });
    });
    const provider = new GeminiProvider("gemini-model", "key", { temperature: 0.8, maxOutputTokens: 1000 }, "https://example.test/v1beta", fetchMock as typeof fetch);
    expect((await provider.generateStructured({ ...answerRequest, schemaName: "constrained", schema: constrainedSchema })).data.quantity).toBe(1);
  });

  it("fails closed after one request when Gemini rejects the exact schema", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      error: { status: "INVALID_ARGUMENT", message: "Schema is too complex." },
    }), { status: 400 }));
    const provider = new GeminiProvider("gemini-model", "key", { temperature: 0.8, maxOutputTokens: 1000 }, "https://example.test/v1beta", fetchMock as typeof fetch);
    await expect(provider.generateStructured(gameplayRequest)).rejects.toMatchObject({ kind: "schema_rejected", retryable: false });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("does not accept commentary or Markdown fences around structured JSON", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      candidates: [{ content: { parts: [{ text: '```json\n{"answer":"yes"}\n```' }] } }],
    }), { status: 200 }));
    const provider = new GeminiProvider("gemini-model", "key", { temperature: 0.8, maxOutputTokens: 1000 }, "https://example.test/v1beta", fetchMock as typeof fetch);
    await expect(provider.generateStructured(answerRequest)).rejects.toMatchObject({ kind: "malformed_json" });
  });
});
