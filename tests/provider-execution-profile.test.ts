import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  DEFAULT_MODEL_EXECUTION_PROFILE_DRAFTS,
  freezeModelExecutionProfile,
} from "../src/model-execution-profile.js";
import { attemptMetadataFor } from "../src/llm/structured-error.js";
import { DeepSeekProvider, OpenAIProvider } from "../src/providers.js";

const AnswerSchema = z.object({ answer: z.string() }).strict();

function terraProfile() {
  const draft = DEFAULT_MODEL_EXECUTION_PROFILE_DRAFTS.find((profile) => profile.key.model === "gpt-5.6-terra");
  if (!draft) throw new Error("Missing Terra profile");
  return freezeModelExecutionProfile({
    ...draft,
    calibratedAt: "2026-07-19T12:00:00.000Z",
    evidenceRef: "calibration/terra/attempts.jsonl",
  });
}

describe("profile-driven provider execution", () => {
  it("keeps DeepSeek fast for normal calls and enables thinking only for bounded repair", async () => {
    const draft = DEFAULT_MODEL_EXECUTION_PROFILE_DRAFTS.find((profile) =>
      profile.key.provider === "deepseek" && profile.key.model === "deepseek-v4-flash");
    if (!draft) throw new Error("Missing DeepSeek profile");
    const profile = freezeModelExecutionProfile({
      ...draft,
      calibratedAt: "2026-07-19T12:00:00.000Z",
      evidenceRef: "calibration/deepseek/attempts.jsonl",
    });
    const thinkingModes: string[] = [];
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, any>;
      thinkingModes.push(body.thinking.type);
      return new Response(JSON.stringify({
        choices: [{ finish_reason: "stop", message: { content: '{"answer":"yes"}' } }],
      }), { status: 200 });
    });
    const provider = new DeepSeekProvider(
      profile.key.model,
      "key",
      { temperature: 0.8, maxOutputTokens: 1_000 },
      "https://example.test/chat",
      fetchMock as typeof fetch,
      profile,
    );

    await provider.generateStructured({
      schemaName: "profiled_decision",
      schema: AnswerSchema,
      system: "Return JSON.",
      prompt: "prompt",
      generationPhase: "decision",
    });
    await provider.generateStructured({
      schemaName: "profiled_repair",
      schema: AnswerSchema,
      system: "Return JSON.",
      prompt: "repair prompt",
      generationPhase: "repair",
      repairOfPhase: "decision",
      attemptKind: "schema_repair",
    });

    expect(profile.reasoning).toEqual({ policy: "deepseek_thinking_for_repairs" });
    expect(thinkingModes).toEqual(["disabled", "enabled"]);
  });

  it("uses the frozen phase budget, temperature, reasoning, token field, and timeout", async () => {
    const profile = terraProfile();
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(body.max_completion_tokens).toBe(8_000);
      expect(body).not.toHaveProperty("max_tokens");
      expect(body).not.toHaveProperty("temperature");
      expect(body.reasoning_effort).toBe("none");
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      return new Response(JSON.stringify({
        choices: [{ finish_reason: "stop", message: { content: '{"answer":"yes"}' } }],
      }), { status: 200 });
    });
    const provider = new OpenAIProvider(
      profile.key.model,
      "key",
      { temperature: 1.7, maxOutputTokens: 999 },
      "https://example.test/chat",
      fetchMock as typeof fetch,
      profile,
    );
    const result = await provider.generateStructured({
      schemaName: "profiled_setup",
      schema: AnswerSchema,
      system: "system",
      prompt: "prompt",
      temperature: 1.4,
      maxOutputTokens: 777,
      generationPhase: "setup",
    });
    expect(result.attemptMetadata).toMatchObject({
      profileFingerprint: profile.fingerprint,
      generationPhase: "setup",
      schemaProjection: "openai_strict_v1",
      outputTokenField: "max_completion_tokens",
      outputTokenBudget: 8_000,
      timeoutMs: 180_000,
      retryBackoffMs: 0,
      truncated: false,
      finishReason: "stop",
    });
  });

  it("honors an application-owned output ceiling below the frozen phase budget", async () => {
    const profile = terraProfile();
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(body.max_completion_tokens).toBe(1_500);
      return new Response(JSON.stringify({
        choices: [{ finish_reason: "stop", message: { content: '{"answer":"yes"}' } }],
      }), { status: 200 });
    });
    const provider = new OpenAIProvider(
      profile.key.model,
      "key",
      { temperature: 0.8, maxOutputTokens: 4_000 },
      "https://example.test/chat",
      fetchMock as typeof fetch,
      profile,
    );
    const result = await provider.generateStructured({
      schemaName: "profiled_player_action",
      schema: AnswerSchema,
      system: "system",
      prompt: "prompt",
      maxOutputTokens: 1_500,
      outputTokenCeiling: 1_500,
      generationPhase: "decision",
    });
    expect(result.attemptMetadata?.outputTokenBudget).toBe(1_500);
  });

  it("retains explicit finish truncation even when the returned JSON is locally valid", async () => {
    const profile = terraProfile();
    const provider = new OpenAIProvider(
      profile.key.model,
      "key",
      { temperature: 0.8, maxOutputTokens: 1_000 },
      "https://example.test/chat",
      vi.fn(async () => new Response(JSON.stringify({
        choices: [{ finish_reason: "length", message: { content: '{"answer":"yes"}' } }],
      }), { status: 200 })) as typeof fetch,
      profile,
    );
    const result = await provider.generateStructured({
      schemaName: "profiled_decision",
      schema: AnswerSchema,
      system: "system",
      prompt: "prompt",
      generationPhase: "decision",
    });
    expect(result.data).toEqual({ answer: "yes" });
    expect(result.attemptMetadata).toMatchObject({ finishReason: "length", truncated: true });
  });

  it("classifies a profile timeout and retains the attempted settings", async () => {
    const profile = terraProfile();
    const { frozen: _frozen, fingerprint: _fingerprint, ...selected } = profile;
    const provider = new OpenAIProvider(
      profile.key.model,
      "key",
      { temperature: 0.8, maxOutputTokens: 1_000 },
      "https://example.test/chat",
      vi.fn(async (_url: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      })) as typeof fetch,
      freezeModelExecutionProfile({
        ...selected,
        timeout: { ...profile.timeout, decisionMs: 1_000 },
      }),
    );
    let failure: unknown;
    try {
      await provider.generateStructured({
        schemaName: "profiled_timeout",
        schema: AnswerSchema,
        system: "system",
        prompt: "prompt",
        generationPhase: "decision",
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({ kind: "network", retryable: true });
    expect(attemptMetadataFor(failure)).toMatchObject({ timeoutMs: 1_000, outputTokenBudget: 4_000 });
  }, 3_000);
});
