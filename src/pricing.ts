import type { Usage } from "./usage.js";
import { z } from "zod";

export interface TokenPrice {
  inputPerMillion: number;
  outputPerMillion: number;
}

export interface FiftyTurnEstimateBasis {
  turns: number;
  inputTokens: number;
  outputTokens: number;
  source: string;
  sourceUrl: string;
  checkedAt: string;
}

export const FIFTY_TURN_ESTIMATE = {
  turns: 50,
  inputTokens: 480_000,
  outputTokens: 110_000,
  source: "OpenRouter",
  sourceUrl: "https://openrouter.ai/api/v1/models",
  checkedAt: "2026-07-17",
} as const satisfies FiftyTurnEstimateBasis;

export interface ModelPriceEstimate extends TokenPrice {
  sourceModel: string;
  estimated50TurnsUsd: number;
}

const OpenRouterPriceResponseSchema = z.object({
  data: z.array(z.object({
    id: z.string().trim().min(1),
    pricing: z.object({
      prompt: z.union([z.string(), z.number()]),
      completion: z.union([z.string(), z.number()]),
    }).passthrough(),
  }).passthrough()),
}).passthrough();

const OPENROUTER_PRICE_REFRESH_MS = 6 * 60 * 60 * 1_000;
const OPENROUTER_PRICE_TIMEOUT_MS = 5_000;

/** Standard per-token rates returned by OpenRouter's public model catalog. */
const OPENROUTER_TOKEN_PRICES: Readonly<Record<string, TokenPrice>> = {
  "google/gemini-3.6-flash": { inputPerMillion: 1.5, outputPerMillion: 7.5 },
  "google/gemini-3.5-flash": { inputPerMillion: 1.5, outputPerMillion: 9 },
  "google/gemini-3.5-flash-lite": { inputPerMillion: 0.3, outputPerMillion: 2.5 },
  "google/gemini-3.1-flash-lite": { inputPerMillion: 0.25, outputPerMillion: 1.5 },
  "openai/gpt-5.6-sol": { inputPerMillion: 5, outputPerMillion: 30 },
  "openai/gpt-5.6-luna": { inputPerMillion: 1, outputPerMillion: 6 },
  "openai/gpt-5.6-terra": { inputPerMillion: 2.5, outputPerMillion: 15 },
  "openai/gpt-5.4-nano": { inputPerMillion: 0.2, outputPerMillion: 1.25 },
  "openai/gpt-5.4": { inputPerMillion: 2.5, outputPerMillion: 15 },
  "openai/gpt-5.4-mini": { inputPerMillion: 0.75, outputPerMillion: 4.5 },
  "openai/gpt-5-mini": { inputPerMillion: 0.25, outputPerMillion: 2 },
  "openai/gpt-4.1": { inputPerMillion: 2, outputPerMillion: 8 },
  "anthropic/claude-sonnet-4.6": { inputPerMillion: 3, outputPerMillion: 15 },
  "anthropic/claude-sonnet-5": { inputPerMillion: 3, outputPerMillion: 15 },
  "anthropic/claude-haiku-4.5": { inputPerMillion: 1, outputPerMillion: 5 },
  "anthropic/claude-opus-4.8": { inputPerMillion: 5, outputPerMillion: 25 },
  "deepseek/deepseek-v4-flash": { inputPerMillion: 0.098, outputPerMillion: 0.196 },
  "deepseek/deepseek-v4-pro": { inputPerMillion: 0.435, outputPerMillion: 0.87 },
  "moonshotai/kimi-k2.6": { inputPerMillion: 0.95, outputPerMillion: 4 },
  "minimax/minimax-m3": { inputPerMillion: 0.3, outputPerMillion: 1.2 },
  "qwen/qwen3.7-plus": { inputPerMillion: 0.32, outputPerMillion: 1.28 },
  "tencent/hy3": { inputPerMillion: 0.2, outputPerMillion: 0.8 },
  "deepseek/deepseek-v3.2": { inputPerMillion: 0.2145, outputPerMillion: 0.3218 },
  "x-ai/grok-4.5": { inputPerMillion: 2, outputPerMillion: 6 },
  "x-ai/grok-4.3": { inputPerMillion: 1.25, outputPerMillion: 2.5 },
};
const DEFAULT_OPENROUTER_PRICE_MAP = new Map(Object.entries(OPENROUTER_TOKEN_PRICES));

function perMillion(value: string | number): number | undefined {
  const parsed = Number(value) * 1_000_000;
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

export function parseOpenRouterPrices(value: unknown): Map<string, TokenPrice> {
  const response = OpenRouterPriceResponseSchema.parse(value);
  const prices = new Map<string, TokenPrice>();
  for (const model of response.data) {
    const inputPerMillion = perMillion(model.pricing.prompt);
    const outputPerMillion = perMillion(model.pricing.completion);
    if (inputPerMillion !== undefined && outputPerMillion !== undefined) {
      prices.set(model.id, { inputPerMillion, outputPerMillion });
    }
  }
  return prices;
}

export async function fetchOpenRouterPrices(fetchImplementation: typeof fetch = fetch): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), OPENROUTER_PRICE_TIMEOUT_MS);
  try {
    const response = await fetchImplementation(FIFTY_TURN_ESTIMATE.sourceUrl, {
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`OpenRouter pricing request failed (${response.status})`);
    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}

export class OpenRouterPricingCatalog {
  private readonly prices = new Map(DEFAULT_OPENROUTER_PRICE_MAP);
  private checkedAt: string = FIFTY_TURN_ESTIMATE.checkedAt;
  private lastRefreshStarted = 0;
  private refreshPromise: Promise<void> | undefined;

  constructor(private readonly fetchPrices?: () => Promise<unknown>) {}

  basis(): FiftyTurnEstimateBasis {
    return { ...FIFTY_TURN_ESTIMATE, checkedAt: this.checkedAt };
  }

  estimate(provider: string, modelId: string): ModelPriceEstimate | undefined {
    return estimateModelPrice(provider, modelId, this.prices);
  }

  refreshInBackground(): void {
    if (!this.fetchPrices || this.refreshPromise || Date.now() - this.lastRefreshStarted < OPENROUTER_PRICE_REFRESH_MS) return;
    this.lastRefreshStarted = Date.now();
    this.refreshPromise = this.fetchPrices()
      .then((value) => {
        for (const [model, price] of parseOpenRouterPrices(value)) this.prices.set(model, price);
        this.checkedAt = new Date().toISOString().slice(0, 10);
      })
      .catch(() => {})
      .finally(() => { this.refreshPromise = undefined; });
  }
}

export function roundUsd(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

export function estimateTokenCost(usage: Usage | undefined, price: TokenPrice): number {
  if (!usage) return 0;
  return roundUsd(
    ((usage.inputTokens ?? 0) * price.inputPerMillion
      + (usage.outputTokens ?? 0) * price.outputPerMillion)
      / 1_000_000,
  );
}

export function openRouterModelId(provider: string, modelId: string): string {
  if (provider === "openrouter") return modelId;
  if (provider === "xai") return `x-ai/${modelId}`;
  if (provider === "gemini") return `google/${modelId}`;
  if (provider === "openai") return `openai/${modelId}`;
  if (provider === "deepseek") return `deepseek/${modelId}`;
  if (provider === "anthropic") {
    return `anthropic/${modelId.replace(/-(\d+)-(\d+)$/, "-$1.$2")}`;
  }
  return modelId;
}

export function estimateModelPrice(
  provider: string,
  modelId: string,
  prices: ReadonlyMap<string, TokenPrice> = DEFAULT_OPENROUTER_PRICE_MAP,
): ModelPriceEstimate | undefined {
  const sourceModel = openRouterModelId(provider, modelId);
  const price = prices.get(sourceModel);
  if (!price) return undefined;
  return {
    ...price,
    sourceModel,
    estimated50TurnsUsd: estimateTokenCost({
      inputTokens: FIFTY_TURN_ESTIMATE.inputTokens,
      outputTokens: FIFTY_TURN_ESTIMATE.outputTokens,
    }, price),
  };
}

/** Built-in standard-tier prices used when a provider does not return billed cost. */
export function inferTokenPrice(provider: string, modelId: string): TokenPrice | undefined {
  const current = estimateModelPrice(provider, modelId);
  if (current) {
    return {
      inputPerMillion: current.inputPerMillion,
      outputPerMillion: current.outputPerMillion,
    };
  }
  if (provider === "gemini" && modelId.toLowerCase() === "gemini-3-flash-preview") {
    return { inputPerMillion: 0.5, outputPerMillion: 3 };
  }
  return undefined;
}
