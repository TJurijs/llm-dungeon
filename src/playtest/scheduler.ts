import type { LlmProvider, StructuredRequest, StructuredResult } from "../types.js";

export interface ScheduledCallTiming {
  queueWaitMs: number;
  providerCallMs: number;
}

export interface ScheduledCallResult<T> extends ScheduledCallTiming {
  value: T;
}

const failedCallTimings = new WeakMap<object, ScheduledCallTiming>();

export function scheduledCallTimingFor(error: unknown): ScheduledCallTiming | undefined {
  return ((typeof error === "object" && error !== null) || typeof error === "function")
    ? failedCallTimings.get(error as object)
    : undefined;
}

interface Waiter {
  resolve: (release: () => void) => void;
  reject: (error: Error) => void;
  signal?: AbortSignal | undefined;
  abort?: (() => void) | undefined;
}

class Semaphore {
  private active = 0;
  private readonly waiters: Waiter[] = [];

  constructor(readonly limit: number) {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new Error("Concurrency limits must be positive integers");
    }
  }

  async acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) throw new Error("Playtest operation cancelled");
    if (this.active < this.limit) {
      this.active += 1;
      return this.releaseOnce();
    }
    return new Promise<() => void>((resolve, reject) => {
      const waiter: Waiter = { resolve, reject, signal };
      if (signal) {
        waiter.abort = () => {
          const index = this.waiters.indexOf(waiter);
          if (index >= 0) this.waiters.splice(index, 1);
          reject(new Error("Playtest operation cancelled"));
        };
        signal.addEventListener("abort", waiter.abort, { once: true });
      }
      this.waiters.push(waiter);
    });
  }

  private releaseOnce(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.release();
    };
  }

  private release(): void {
    const next = this.waiters.shift();
    if (!next) {
      this.active -= 1;
      return;
    }
    if (next.signal && next.abort) next.signal.removeEventListener("abort", next.abort);
    next.resolve(this.releaseOnce());
  }
}

/**
 * Coordinates provider calls independently from campaign workers. A judge or
 * player call can wait for its own provider pool without consuming a candidate
 * campaign's turn lock.
 */
export class PlaytestProviderScheduler {
  private readonly global: Semaphore;
  private readonly providers = new Map<string, Semaphore>();

  constructor(
    globalLimit: number,
    providerLimits: Readonly<Record<string, number>> = {},
  ) {
    this.global = new Semaphore(globalLimit);
    for (const [provider, limit] of Object.entries(providerLimits)) {
      this.providers.set(provider, new Semaphore(limit));
    }
  }

  private provider(provider: string): Semaphore {
    let semaphore = this.providers.get(provider);
    if (!semaphore) {
      semaphore = new Semaphore(this.global.limit);
      this.providers.set(provider, semaphore);
    }
    return semaphore;
  }

  async schedule<T>(
    provider: string,
    operation: () => Promise<T>,
    signal?: AbortSignal,
  ): Promise<ScheduledCallResult<T>> {
    const queuedAt = Date.now();
    const releaseProvider = await this.provider(provider).acquire(signal);
    let releaseGlobal: (() => void) | undefined;
    try {
      releaseGlobal = await this.global.acquire(signal);
      const startedAt = Date.now();
      try {
        const value = await operation();
        return {
          value,
          queueWaitMs: startedAt - queuedAt,
          providerCallMs: Date.now() - startedAt,
        };
      } catch (error) {
        if ((typeof error === "object" && error !== null) || typeof error === "function") {
          failedCallTimings.set(error as object, {
            queueWaitMs: startedAt - queuedAt,
            providerCallMs: Date.now() - startedAt,
          });
        }
        throw error;
      }
    } finally {
      releaseGlobal?.();
      releaseProvider();
    }
  }
}

/** Serializes all work for one campaign while allowing different campaigns to run in parallel. */
export class CampaignTurnScheduler {
  private readonly tails = new Map<string, Promise<void>>();

  async run<T>(campaignId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(campaignId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    const tail = previous.then(() => current, () => current);
    this.tails.set(campaignId, tail);
    await previous.catch(() => undefined);
    try {
      return await operation();
    } finally {
      release();
      if (this.tails.get(campaignId) === tail) this.tails.delete(campaignId);
    }
  }
}

export interface ScheduledProviderCall {
  request: StructuredRequest<unknown>;
  timing: ScheduledCallTiming;
  success: boolean;
}

/** Adds provider-pool scheduling without changing the provider wire contract. */
export class ScheduledProvider implements LlmProvider {
  readonly id: string;
  readonly model: string;

  constructor(
    private readonly base: LlmProvider,
    private readonly scheduler: PlaytestProviderScheduler,
    private readonly signal: AbortSignal | undefined,
    private readonly onCall: (call: ScheduledProviderCall) => void = () => undefined,
  ) {
    this.id = base.id;
    this.model = base.model;
  }

  async generateStructured<T>(request: StructuredRequest<T>): Promise<StructuredResult<T>> {
    try {
      const scheduled = await this.scheduler.schedule(
        this.id,
        () => this.base.generateStructured(request),
        this.signal,
      );
      try {
        this.onCall({
          request: request as StructuredRequest<unknown>,
          timing: {
            queueWaitMs: scheduled.queueWaitMs,
            providerCallMs: scheduled.providerCallMs,
          },
          success: true,
        });
      } catch {
        // Telemetry observers must never interrupt a successful provider call.
      }
      return scheduled.value;
    } catch (error) {
      const timing = scheduledCallTimingFor(error);
      if (timing) {
        try {
          this.onCall({
            request: request as StructuredRequest<unknown>,
            timing,
            success: false,
          });
        } catch {
          // Telemetry observers must never replace the provider failure.
        }
      }
      throw error;
    }
  }
}
