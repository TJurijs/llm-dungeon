import { readFile } from "node:fs/promises";
import { ProviderConfigSchema, type ProviderConfig } from "./schemas.js";
import { MODEL_EXECUTION_ADAPTER_REVISION } from "./model-execution-profile.js";
import type { LlmProvider } from "./types.js";
import {
  AnthropicProvider,
  DeepSeekProvider,
  GeminiProvider,
  OpenAIProvider,
  OpenRouterProvider,
  XaiProvider,
} from "./providers/adapters.js";
import type { FetchLike, ProviderExecutionOptions } from "./providers/transport.js";

/**
 * Provider facade: adapter construction and persisted configuration. The
 * transport, schema projections, and concrete adapters live in ./providers/.
 */

export {
  AnthropicProvider,
  DeepSeekProvider,
  GeminiProvider,
  OpenAIProvider,
  OpenRouterProvider,
  XaiProvider,
} from "./providers/adapters.js";
export { providerSupportsTemperature, type ProviderExecutionOptions } from "./providers/transport.js";

/** Increment when provider transport or schema projection changes compatibility. */
export const PROVIDER_ADAPTER_COMPATIBILITY_REVISION = MODEL_EXECUTION_ADAPTER_REVISION;

export async function loadProviderConfig(configPath: string): Promise<ProviderConfig> {
  const raw = await readFile(configPath, "utf8");
  return ProviderConfigSchema.parse(JSON.parse(raw));
}

export function createProvider(
  config: ProviderConfig,
  environment: NodeJS.ProcessEnv = process.env,
  fetchImpl: FetchLike = fetch,
  options: ProviderExecutionOptions = {},
): LlmProvider {
  switch (config.provider) {
    case "openrouter": {
      const key = environment.OPENROUTER_API_KEY;
      if (!key) throw new Error("OPENROUTER_API_KEY is not set");
      return new OpenRouterProvider(
        config.model,
        key,
        config,
        config.endpoint ?? "https://openrouter.ai/api/v1/chat/completions",
        fetchImpl,
        options.executionProfile,
      );
    }
    case "xai": {
      const key = environment.XAI_API_KEY;
      if (!key) throw new Error("XAI_API_KEY is not set");
      return new XaiProvider(
        config.model,
        key,
        config,
        config.endpoint ?? "https://api.x.ai/v1/chat/completions",
        fetchImpl,
        options.executionProfile,
      );
    }
    case "gemini": {
      const key = environment.GEMINI_API_KEY;
      if (!key) throw new Error("GEMINI_API_KEY is not set");
      return new GeminiProvider(
        config.model,
        key,
        config,
        config.endpoint ?? "https://generativelanguage.googleapis.com/v1beta",
        fetchImpl,
        options.executionProfile,
      );
    }
    case "openai": {
      const key = environment.OPENAI_API_KEY;
      if (!key) throw new Error("OPENAI_API_KEY is not set");
      return new OpenAIProvider(
        config.model,
        key,
        config,
        config.endpoint ?? "https://api.openai.com/v1/chat/completions",
        fetchImpl,
        options.executionProfile,
      );
    }
    case "anthropic": {
      const key = environment.ANTHROPIC_API_KEY;
      if (!key) throw new Error("ANTHROPIC_API_KEY is not set");
      return new AnthropicProvider(
        config.model,
        key,
        config,
        config.endpoint ?? "https://api.anthropic.com/v1/messages",
        fetchImpl,
        options.executionProfile,
      );
    }
    case "deepseek": {
      const key = environment.DEEPSEEK_API_KEY;
      if (!key) throw new Error("DEEPSEEK_API_KEY is not set");
      return new DeepSeekProvider(
        config.model,
        key,
        config,
        config.endpoint ?? "https://api.deepseek.com/chat/completions",
        fetchImpl,
        options.executionProfile,
      );
    }
  }
}

