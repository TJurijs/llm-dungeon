import { describe, expect, it } from "vitest";
import { z } from "zod";
import { GenerationFailure } from "../src/llm/failures.js";
import { StructuredClient } from "../src/llm/structured-generation.js";
import { attachStructuredFailure } from "../src/llm/structured-error.js";
import { InputBudgetExceededError } from "../src/input-budget.js";
import type { LlmProvider, StructuredRequest, StructuredResult } from "../src/types.js";

const AnswerSchema = z.object({ answer: z.string() });

describe("StructuredClient", () => {
  it("rechecks a repair against the provider's effective phase output budget", async () => {
    const phases: Array<StructuredRequest<unknown>["generationPhase"]> = [];
    let providerCalls = 0;
    const schemaFailure = AnswerSchema.safeParse({ answer: 7 });
    if (schemaFailure.success) throw new Error("Expected the fixture to violate the schema");
    attachStructuredFailure(schemaFailure.error, {
      rawText: '{"answer":7}',
      parsedResponse: { answer: 7 },
    });
    const provider: LlmProvider = {
      id: "phase-budget",
      model: "phase-budget-model",
      effectiveOutputTokenBudget(request) {
        phases.push(request.generationPhase);
        return request.generationPhase === "repair" ? 32_000 : 4_000;
      },
      async generateStructured(): Promise<never> {
        providerCalls += 1;
        throw schemaFailure.error;
      },
    };

    let failure: unknown;
    try {
      await new StructuredClient(provider).generate({
        schemaName: "answer",
        schema: AnswerSchema,
        system: "system",
        prompt: "p".repeat(90_000),
        generationPhase: "decision",
      });
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(InputBudgetExceededError);
    expect((failure as InputBudgetExceededError).report).toMatchObject({
      phase: "repair",
      inputTokenLimit: 88_000,
      outputTokenReserve: 32_000,
    });
    expect(providerCalls).toBe(1);
    expect(phases).toEqual(["decision", "repair"]);
  });

  it("keeps the schema-repair prompt active when that attempt needs a transient retry", async () => {
    const attempts: Array<{
      prompt: string;
      schemaName: string;
      generationPhase: StructuredRequest<unknown>["generationPhase"];
      repairOfPhase: StructuredRequest<unknown>["repairOfPhase"];
      attemptKind: StructuredRequest<unknown>["attemptKind"];
      retryBackoffMs: number | undefined;
    }> = [];
    const schemaFailure = AnswerSchema.safeParse({ answer: 7 });
    if (schemaFailure.success) throw new Error("Expected the fixture to violate the schema");
    attachStructuredFailure(schemaFailure.error, {
      rawText: '{"answer":7}',
      parsedResponse: { answer: 7 },
    });

    const provider: LlmProvider = {
      id: "fake",
      model: "fake-model",
      async generateStructured<T>(request: StructuredRequest<T>): Promise<StructuredResult<T>> {
        attempts.push({
          prompt: request.prompt,
          schemaName: request.schemaName,
          generationPhase: request.generationPhase,
          repairOfPhase: request.repairOfPhase,
          attemptKind: request.attemptKind,
          retryBackoffMs: request.retryBackoffMs,
        });
        if (attempts.length === 1) throw schemaFailure.error;
        if (attempts.length === 2) {
          throw new GenerationFailure("network", "temporary connection failure", true);
        }
        return {
          data: request.schema.parse({ answer: "recovered" }),
          provider: this.id,
          model: this.model,
        };
      },
    };

    const result = await new StructuredClient(provider).generate(
      {
        schemaName: "answer",
        schema: AnswerSchema,
        system: "system",
        prompt: "original prompt",
        generationPhase: "decision",
      },
      { transientDelayMs: 2 },
    );

    expect(result.data).toEqual({ answer: "recovered" });
    expect(attempts.map((attempt) => attempt.schemaName)).toEqual([
      "answer",
      "repair_answer",
      "transient_retry_answer",
    ]);
    expect(attempts[1]?.prompt).toContain("STRUCTURED RESPONSE REPAIR");
    expect(attempts[1]?.prompt).toContain('{"answer":7}');
    expect(attempts[1]?.prompt).toContain("Restore that key at its exact path");
    expect(attempts[1]?.prompt).toContain("Audit every sibling object in the same array");
    expect(attempts[1]?.prompt).toContain("do not repeat the previous response unchanged");
    expect(attempts[2]?.prompt).toBe(attempts[1]?.prompt);
    expect(
      attempts.map((attempt) => ({
        phase: attempt.generationPhase,
        repairOf: attempt.repairOfPhase,
        kind: attempt.attemptKind,
        backoff: attempt.retryBackoffMs,
      })),
    ).toEqual([
      { phase: "decision", repairOf: undefined, kind: "initial", backoff: 0 },
      { phase: "repair", repairOf: "decision", kind: "schema_repair", backoff: 0 },
      { phase: "repair", repairOf: "decision", kind: "transient_retry", backoff: 2 },
    ]);
  });

  it("retries one content block with an outcome-focused fictional rendering prompt", async () => {
    const attempts: StructuredRequest<unknown>[] = [];
    const budgetPhases: Array<StructuredRequest<unknown>["generationPhase"]> = [];
    const provider: LlmProvider = {
      id: "fake",
      model: "fake-model",
      effectiveOutputTokenBudget(request) {
        budgetPhases.push(request.generationPhase);
        return request.generationPhase === "decision" ? 8_000 : 4_000;
      },
      async generateStructured<T>(request: StructuredRequest<T>): Promise<StructuredResult<T>> {
        attempts.push(request as StructuredRequest<unknown>);
        if (attempts.length === 1) {
          throw new GenerationFailure("content_block", "blocked fictional output", false);
        }
        return {
          data: request.schema.parse({ answer: "recovered" }),
          provider: this.id,
          model: this.model,
        };
      },
    };

    await expect(
      new StructuredClient(provider).generate({
        schemaName: "answer",
        schema: AnswerSchema,
        system: "system",
        prompt: "Exact state and player action.",
        generationPhase: "decision",
      }),
    ).resolves.toMatchObject({ data: { answer: "recovered" } });

    expect(attempts.map((attempt) => attempt.schemaName)).toEqual([
      "answer",
      "content_repair_answer",
    ]);
    expect(attempts.map((attempt) => attempt.attemptKind)).toEqual(["initial", "content_repair"]);
    expect(attempts[1]?.generationPhase).toBe("decision");
    expect(attempts[1]?.repairOfPhase).toBeUndefined();
    expect(attempts[1]?.prompt).toContain("Exact state and player action.");
    expect(attempts[1]?.prompt).toContain("Preserve all supplied authoritative context");
    expect(attempts[1]?.prompt).toContain("outcome-focused, non-procedural level");
    expect(attempts[1]?.prompt).toContain("Do not mention moderation");
    expect(budgetPhases).toEqual(["decision", "decision"]);
  });

  it("attempts at most one content repair by default", async () => {
    let attempts = 0;
    const provider: LlmProvider = {
      id: "fake",
      model: "fake-model",
      async generateStructured(): Promise<never> {
        attempts += 1;
        throw new GenerationFailure("content_block", "still blocked", false);
      },
    };

    await expect(
      new StructuredClient(provider).generate({
        schemaName: "answer",
        schema: AnswerSchema,
        system: "system",
        prompt: "prompt",
      }),
    ).rejects.toMatchObject({ kind: "content_block" });
    expect(attempts).toBe(2);
  });

  it("preserves content-safe framing through a schema repair and its transient retry", async () => {
    const attempts: StructuredRequest<unknown>[] = [];
    const schemaFailure = AnswerSchema.safeParse({ answer: 7 });
    if (schemaFailure.success) throw new Error("Expected the fixture to violate the schema");
    attachStructuredFailure(schemaFailure.error, {
      rawText: '{"answer":7}',
      parsedResponse: { answer: 7 },
    });
    const provider: LlmProvider = {
      id: "fake",
      model: "fake-model",
      async generateStructured<T>(request: StructuredRequest<T>): Promise<StructuredResult<T>> {
        attempts.push(request as StructuredRequest<unknown>);
        if (attempts.length === 1) {
          throw new GenerationFailure("content_block", "blocked fictional output", false);
        }
        if (attempts.length === 2) throw schemaFailure.error;
        if (attempts.length === 3) {
          throw new GenerationFailure("network", "temporary connection failure", true);
        }
        return {
          data: request.schema.parse({ answer: "recovered" }),
          provider: this.id,
          model: this.model,
        };
      },
    };

    await expect(
      new StructuredClient(provider).generate(
        {
          schemaName: "answer",
          schema: AnswerSchema,
          system: "system",
          prompt: "original prompt",
          generationPhase: "decision",
        },
        { transientDelayMs: 0 },
      ),
    ).resolves.toMatchObject({ data: { answer: "recovered" } });

    expect(attempts.map((attempt) => attempt.attemptKind)).toEqual([
      "initial",
      "content_repair",
      "schema_repair",
      "transient_retry",
    ]);
    expect(
      attempts
        .slice(1)
        .every((attempt) => attempt.prompt.includes("CONTENT-SAFE FICTIONAL RENDERING RETRY")),
    ).toBe(true);
    expect(attempts[2]?.prompt).toContain("STRUCTURED RESPONSE REPAIR");
    expect(attempts[3]?.prompt).toBe(attempts[2]?.prompt);
    expect(
      attempts.map((attempt) => ({
        phase: attempt.generationPhase,
        repairOf: attempt.repairOfPhase,
      })),
    ).toEqual([
      { phase: "decision", repairOf: undefined },
      { phase: "decision", repairOf: undefined },
      { phase: "repair", repairOf: "decision" },
      { phase: "repair", repairOf: "decision" },
    ]);
  });

  it.each(["schema", "network", "content"] as const)(
    "does not recover a user-cancelled %s failure",
    async (failureKind) => {
      const controller = new AbortController();
      let attempts = 0;
      const schemaFailure = AnswerSchema.safeParse({ answer: 7 });
      if (schemaFailure.success) throw new Error("Expected the fixture to violate the schema");
      const provider: LlmProvider = {
        id: "fake",
        model: "fake-model",
        async generateStructured<T>(request: StructuredRequest<T>): Promise<StructuredResult<T>> {
          attempts += 1;
          expect(request.signal).toBe(controller.signal);
          controller.abort();
          if (failureKind === "schema") throw schemaFailure.error;
          if (failureKind === "content") {
            throw new GenerationFailure("content_block", "blocked fictional output", false);
          }
          throw new GenerationFailure("network", "temporary connection failure", true);
        },
      };

      await expect(
        new StructuredClient(provider).generate(
          {
            schemaName: "answer",
            schema: AnswerSchema,
            system: "system",
            prompt: "prompt",
          },
          {
            signal: controller.signal,
            maxRepairs: 10,
            maxTransientRetries: 10,
            transientDelayMs: 1,
          },
        ),
      ).rejects.toMatchObject({ kind: "cancelled", retryable: false });
      expect(attempts).toBe(1);
    },
  );
});
