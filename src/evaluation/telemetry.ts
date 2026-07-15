import { classifyFailure } from "../llm/failures.js";
import { structuredFailureDetails } from "../llm/structured-error.js";
import type { LlmProvider, StructuredRequest, StructuredResult } from "../types.js";
import type { CallRecord, ModelCost } from "./contracts.js";
import {
  estimateCost,
  estimateReservation,
  EvaluationBudget,
  EvaluationCostLimitError,
} from "./cost.js";
import { hashText } from "./hash.js";

export class TelemetryProvider implements LlmProvider {
  readonly id: string;
  readonly model: string;
  private sequence = 0;

  constructor(
    private readonly base: LlmProvider,
    private readonly role: "dm" | "player",
    private readonly sessionId: string,
    private readonly cost: ModelCost,
    private readonly budget: EvaluationBudget,
    private readonly record: (call: CallRecord) => Promise<void>,
  ) {
    this.id = base.id;
    this.model = base.model;
  }

  async generateStructured<T>(request: StructuredRequest<T>): Promise<StructuredResult<T>> {
    const reservation = await this.budget.acquire(estimateReservation(request, this.cost));
    this.sequence += 1;
    const started = Date.now();
    try {
      const result = await this.base.generateStructured(request);
      const call: CallRecord = {
        timestamp: new Date().toISOString(),
        role: this.role,
        sessionId: this.sessionId,
        sequence: this.sequence,
        schemaName: request.schemaName,
        provider: result.provider,
        model: result.model,
        durationMs: Date.now() - started,
        promptHash: hashText(request.prompt),
        systemHash: hashText(request.system),
        system: request.system,
        prompt: request.prompt,
        success: true,
        ...(result.usage ? { usage: result.usage } : {}),
        estimatedCostUsd: estimateCost(result.usage, this.cost),
        response: result.data,
        ...(result.rawText ? { rawText: result.rawText } : {}),
        ...(result.structuredMode ? { structuredMode: result.structuredMode } : {}),
        ...(result.protocolVersion === undefined ? {} : { protocolVersion: result.protocolVersion }),
      };
      this.budget.commit(reservation, call.estimatedCostUsd);
      await this.record(call);
      return result;
    } catch (error) {
      if (error instanceof EvaluationCostLimitError) throw error;
      const failed = structuredFailureDetails(error);
      const call: CallRecord = {
        timestamp: new Date().toISOString(),
        role: this.role,
        sessionId: this.sessionId,
        sequence: this.sequence,
        schemaName: request.schemaName,
        provider: this.base.id,
        model: this.base.model,
        durationMs: Date.now() - started,
        promptHash: hashText(request.prompt),
        systemHash: hashText(request.system),
        system: request.system,
        prompt: request.prompt,
        success: false,
        ...(failed?.usage ? { usage: failed.usage } : {}),
        estimatedCostUsd: estimateCost(failed?.usage, this.cost),
        ...(failed ? { response: failed.parsedResponse, rawText: failed.rawText } : {}),
        ...(failed?.structuredMode ? { structuredMode: failed.structuredMode } : {}),
        failureKind: classifyFailure(error).kind,
        error: error instanceof Error ? error.message : String(error),
      };
      this.budget.commit(reservation, call.estimatedCostUsd);
      await this.record(call);
      throw error;
    }
  }
}
