import { z } from "zod";

const OpenAiModelsResponseSchema = z
  .object({
    data: z.array(
      z
        .object({
          id: z.string().min(1),
        })
        .passthrough(),
    ),
  })
  .passthrough();

export type OpenAiModelsFetcher = (apiKey: string) => Promise<ReadonlySet<string>>;

export const OPENAI_MODEL_DISCOVERY_TIMEOUT_MS = 3_000;

export async function fetchOpenAiModels(apiKey: string): Promise<ReadonlySet<string>> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), OPENAI_MODEL_DISCOVERY_TIMEOUT_MS);
  try {
    const response = await fetch("https://api.openai.com/v1/models", {
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`OpenAI model discovery failed (${response.status})`);
    const payload = OpenAiModelsResponseSchema.parse(await response.json());
    return new Set(payload.data.map((model) => model.id));
  } finally {
    clearTimeout(timeout);
  }
}
