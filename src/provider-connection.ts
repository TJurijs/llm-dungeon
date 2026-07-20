import type { LlmProviderId } from "./llm-model-catalog.js";

type FetchLike = typeof fetch;

export type ProviderConnectionStatus = "connected" | "unauthorized" | "unavailable";

export interface ProviderConnectionResult {
  provider: LlmProviderId;
  status: ProviderConnectionStatus;
}

const CONNECTION_REQUESTS: Record<LlmProviderId, { url: string; headers: (apiKey: string) => HeadersInit }> = {
  gemini: { url: "https://generativelanguage.googleapis.com/v1beta/models?pageSize=1", headers: (apiKey) => ({ "x-goog-api-key": apiKey }) },
  openrouter: { url: "https://openrouter.ai/api/v1/key", headers: (apiKey) => ({ Authorization: `Bearer ${apiKey}` }) },
  xai: { url: "https://api.x.ai/v1/language-models", headers: (apiKey) => ({ Authorization: `Bearer ${apiKey}` }) },
  openai: { url: "https://api.openai.com/v1/models", headers: (apiKey) => ({ Authorization: `Bearer ${apiKey}` }) },
  anthropic: { url: "https://api.anthropic.com/v1/models", headers: (apiKey) => ({ "x-api-key": apiKey, "anthropic-version": "2023-06-01" }) },
  deepseek: { url: "https://api.deepseek.com/models", headers: (apiKey) => ({ Authorization: `Bearer ${apiKey}` }) },
};

/** A no-generation credential/reachability check that never changes model evidence. */
export async function checkProviderConnection(
  provider: LlmProviderId,
  apiKey: string,
  fetchImpl: FetchLike = fetch,
): Promise<ProviderConnectionResult> {
  const request = CONNECTION_REQUESTS[provider];
  try {
    const response = await fetchImpl(request.url, {
      headers: request.headers(apiKey),
      signal: AbortSignal.timeout(10_000),
    });
    return {
      provider,
      status: response.ok ? "connected" : response.status === 401 || response.status === 403 ? "unauthorized" : "unavailable",
    };
  } catch {
    return { provider, status: "unavailable" };
  }
}
