import { describe, expect, it } from "vitest";
import { z } from "zod";
import { GenerationFailure } from "../src/llm/failures.js";
import { StructuredClient } from "../src/llm/structured-generation.js";
import { attachStructuredFailure } from "../src/llm/structured-error.js";
import type {
  LlmProvider,
  StructuredRequest,
  StructuredResult,
} from "../src/types.js";

const AnswerSchema = z.object({ answer: z.string() });

describe("StructuredClient", () => {
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
    expect(attempts.map((attempt) => ({
      phase: attempt.generationPhase,
      repairOf: attempt.repairOfPhase,
      kind: attempt.attemptKind,
      backoff: attempt.retryBackoffMs,
    }))).toEqual([
      { phase: "decision", repairOf: undefined, kind: "initial", backoff: 0 },
      { phase: "repair", repairOf: "decision", kind: "schema_repair", backoff: 0 },
      { phase: "repair", repairOf: "decision", kind: "transient_retry", backoff: 2 },
    ]);
  });
});
