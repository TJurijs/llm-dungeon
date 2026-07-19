import type { StructuredRequest, StructuredResult } from "../types.js";
import { estimateTokenCost, roundUsd } from "../pricing.js";

export interface PlaytestModelCost {
  inputPerMillion: number;
  outputPerMillion: number;
}

export class PlaytestCostLimitError extends Error {
  constructor() {
    super("Playtest cost limit reached");
    this.name = "PlaytestCostLimitError";
  }
}

interface BudgetWaiter {
  amount: number;
  resolve: (token: symbol) => void;
  reject: (error: PlaytestCostLimitError) => void;
}

/** One reservation-based cost authority shared by every candidate, player, and judge lane. */
export class PlaytestCostManager {
  private committed: number;
  private readonly reservations = new Map<symbol, number>();
  private readonly waiters: BudgetWaiter[] = [];

  constructor(readonly ceilingUsd: number, spentUsd = 0) {
    if (!Number.isFinite(ceilingUsd) || ceilingUsd <= 0) {
      throw new Error("Playtest cost ceiling must be positive");
    }
    this.committed = roundUsd(spentUsd);
  }

  get spentUsd(): number {
    return this.committed;
  }

  canCall(): boolean {
    return this.committed < this.ceilingUsd;
  }

  addHistorical(costUsd: number): void {
    if (!Number.isFinite(costUsd) || costUsd < 0) throw new Error("Historical cost must be nonnegative");
    this.committed = roundUsd(this.committed + costUsd);
    this.drain();
  }

  acquire(amountUsd: number): Promise<symbol> {
    if (!this.canCall()) return Promise.reject(new PlaytestCostLimitError());
    const amount = Math.max(roundUsd(amountUsd), 0.000001);
    const token = this.tryAcquire(amount);
    if (token) return Promise.resolve(token);
    if (this.reservations.size === 0) return Promise.reject(new PlaytestCostLimitError());
    return new Promise<symbol>((resolve, reject) => this.waiters.push({ amount, resolve, reject }));
  }

  commit(token: symbol, actualCostUsd: number): void {
    if (!this.reservations.delete(token)) return;
    this.committed = roundUsd(this.committed + Math.max(actualCostUsd, 0));
    this.drain();
  }

  release(token: symbol): void {
    if (!this.reservations.delete(token)) return;
    this.drain();
  }

  private reserved(): number {
    return roundUsd([...this.reservations.values()].reduce((sum, amount) => sum + amount, 0));
  }

  private tryAcquire(amount: number): symbol | undefined {
    if (!this.canCall()) return undefined;
    const available = this.ceilingUsd - this.committed - this.reserved();
    if (amount > available) return undefined;
    const token = Symbol("playtest-cost-reservation");
    this.reservations.set(token, amount);
    return token;
  }

  private drain(): void {
    while (this.waiters.length) {
      if (!this.canCall()) {
        for (const waiter of this.waiters.splice(0)) waiter.reject(new PlaytestCostLimitError());
        return;
      }
      const next = this.waiters[0]!;
      const token = this.tryAcquire(next.amount);
      if (!token) {
        if (this.reservations.size > 0) return;
        this.waiters.shift();
        next.reject(new PlaytestCostLimitError());
        continue;
      }
      this.waiters.shift();
      next.resolve(token);
    }
  }
}

export function estimatePlaytestReservation(
  request: StructuredRequest<unknown>,
  cost: PlaytestModelCost,
): number {
  const inputUpperBound = Buffer.byteLength(`${request.system}\n${request.prompt}`, "utf8") + 512;
  return roundUsd(
    (inputUpperBound * cost.inputPerMillion
      + (request.maxOutputTokens ?? 4_000) * cost.outputPerMillion)
      / 1_000_000,
  );
}

export function estimatePlaytestCost(
  usage: StructuredResult<unknown>["usage"],
  cost: PlaytestModelCost,
  conservativeFallbackUsd = 0,
): number {
  if (usage?.billedCostUsd !== undefined) return roundUsd(usage.billedCostUsd);
  if (usage?.inputTokens === undefined && usage?.outputTokens === undefined) {
    return roundUsd(conservativeFallbackUsd);
  }
  return estimateTokenCost(usage, cost);
}
