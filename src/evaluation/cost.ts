import type { ProviderConfig } from "../schemas.js";
import type { StructuredRequest, StructuredResult } from "../types.js";
import type { ModelCost } from "./contracts.js";

export class EvaluationCostLimitError extends Error {
  constructor() {
    super("Evaluation cost limit reached");
  }
}

interface BudgetWaiter {
  amount: number;
  resolve: (token: symbol) => void;
  reject: (error: EvaluationCostLimitError) => void;
}

/** Coordinates estimated spend across concurrent sessions without serializing provider calls. */
export class EvaluationBudget {
  private committed: number;
  private readonly reservations = new Map<symbol, number>();
  private readonly waiters: BudgetWaiter[] = [];

  constructor(private readonly ceiling: number, spent = 0) {
    this.committed = roundMoney(spent);
  }

  get spent(): number {
    return this.committed;
  }

  canCall(): boolean {
    return this.committed < this.ceiling;
  }

  addHistorical(cost: number): void {
    this.committed = roundMoney(this.committed + cost);
    this.drain();
  }

  acquire(amount: number): Promise<symbol> {
    if (!this.canCall()) return Promise.reject(new EvaluationCostLimitError());
    const normalized = Math.max(roundMoney(amount), 0.000001);
    const token = this.tryAcquire(normalized);
    if (token) return Promise.resolve(token);
    return new Promise<symbol>((resolve, reject) => {
      this.waiters.push({ amount: normalized, resolve, reject });
    });
  }

  commit(token: symbol, actualCost: number): void {
    if (!this.reservations.delete(token)) return;
    this.committed = roundMoney(this.committed + actualCost);
    this.drain();
  }

  private reservedTotal(): number {
    let total = 0;
    for (const amount of this.reservations.values()) total += amount;
    return roundMoney(total);
  }

  private tryAcquire(amount: number): symbol | undefined {
    if (!this.canCall()) return undefined;
    const available = this.ceiling - this.committed - this.reservedTotal();
    // Preserve the historical behavior that permits one final in-flight call when
    // its exact token cost cannot be known until the provider responds.
    if (amount > available && this.reservations.size > 0) return undefined;
    const token = Symbol("evaluation-budget");
    this.reservations.set(token, amount);
    return token;
  }

  private drain(): void {
    while (this.waiters.length) {
      if (!this.canCall()) {
        for (const waiter of this.waiters.splice(0)) waiter.reject(new EvaluationCostLimitError());
        return;
      }
      const waiter = this.waiters[0]!;
      const token = this.tryAcquire(waiter.amount);
      if (!token) return;
      this.waiters.shift();
      waiter.resolve(token);
    }
  }
}

export function roundMoney(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

export function completedJsonLineCost(text: string): number {
  const lines = text.split("\n");
  const lastNonempty = lines.findLastIndex((line) => line.trim().length > 0);
  const cost = lines.reduce((sum, line, index) => {
    if (!line.trim()) return sum;
    let parsed: { estimatedCostUsd?: unknown };
    try {
      parsed = JSON.parse(line) as { estimatedCostUsd?: unknown };
    } catch (error) {
      if (error instanceof SyntaxError && index === lastNonempty && !text.endsWith("\n")) return sum;
      throw error;
    }
    if (typeof parsed.estimatedCostUsd !== "number"
      || !Number.isFinite(parsed.estimatedCostUsd) || parsed.estimatedCostUsd < 0) {
      throw new Error("Recorded evaluation call has an invalid estimated cost");
    }
    return sum + parsed.estimatedCostUsd;
  }, 0);
  return roundMoney(cost);
}

export function estimateCost(
  usage: StructuredResult<unknown>["usage"],
  cost: ModelCost,
): number {
  if (!usage) return 0;
  return roundMoney(
    ((usage.inputTokens ?? 0) * cost.inputPerMillion
      + (usage.outputTokens ?? 0) * cost.outputPerMillion)
      / 1_000_000,
  );
}

export function estimateReservation(
  request: StructuredRequest<unknown>,
  cost: ModelCost,
): number {
  const inputUpperBound = Buffer.byteLength(`${request.system}\n${request.prompt}`, "utf8") + 512;
  return roundMoney(
    (inputUpperBound * cost.inputPerMillion
      + (request.maxOutputTokens ?? 4000) * cost.outputPerMillion)
      / 1_000_000,
  );
}

export function inferModelCost(config: ProviderConfig): ModelCost | undefined {
  const model = config.model.toLowerCase();
  if (config.provider === "gemini" && model === "gemini-3.5-flash") return { inputPerMillion: 1.5, outputPerMillion: 9 };
  if (model.includes("gemini-3.1-flash-lite")) return { inputPerMillion: 0.25, outputPerMillion: 1.5 };
  if (config.provider === "openrouter" && model.includes("gemini-3.5-flash")) return { inputPerMillion: 1.5, outputPerMillion: 9 };
  if (config.provider === "gemini" && model === "gemini-3-flash-preview") return { inputPerMillion: 0.5, outputPerMillion: 3 };
  return undefined;
}

export function configuredModelCost(config: ProviderConfig, label: string): ModelCost {
  const inferred = inferModelCost(config);
  if (!inferred) {
    throw new Error(`No built-in pricing for ${label} model ${config.model}; select a supported model for auto-runs`);
  }
  return inferred;
}
