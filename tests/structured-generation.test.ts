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
    const attempts: Array<{ prompt: string; schemaName: string }> = [];
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
        attempts.push({ prompt: request.prompt, schemaName: request.schemaName });
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
      },
      { transientDelayMs: 0 },
    );

    expect(result.data).toEqual({ answer: "recovered" });
    expect(attempts.map((attempt) => attempt.schemaName)).toEqual([
      "answer",
      "repair_answer",
      "transient_retry_answer",
    ]);
    expect(attempts[1]?.prompt).toContain("STRUCTURED RESPONSE REPAIR");
    expect(attempts[1]?.prompt).toContain('{"answer":7}');
    expect(attempts[2]?.prompt).toBe(attempts[1]?.prompt);
  });
});
