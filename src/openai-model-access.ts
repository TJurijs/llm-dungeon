import { z } from "zod";

const OpenAiModelsResponseSchema = z.object({
  data: z.array(z.object({
    id: z.string().min(1),
  }).passthrough()),
}).passthrough();

export type OpenAiModelsFetcher = (apiKey: string) => Promise<ReadonlySet<string>>;

export async function fetchOpenAiModels(apiKey: string): Promise<ReadonlySet<string>> {
  const response = await fetch("https://api.openai.com/v1/models", {
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
  });
  if (!response.ok) throw new Error(`OpenAI model discovery failed (${response.status})`);
  const payload = OpenAiModelsResponseSchema.parse(await response.json());
  return new Set(payload.data.map((model) => model.id));
}
