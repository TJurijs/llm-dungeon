import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchOpenAiModels } from "../src/openai-model-access.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("OpenAI model access discovery", () => {
  it("lists model IDs with the provided key without returning the raw response", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      object: "list",
      data: [
        { id: "gpt-5.6-luna", object: "model", owned_by: "openai" },
        { id: "gpt-5.6-sol", object: "model", owned_by: "openai" },
      ],
      sensitive_extra: "must not be projected",
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchOpenAiModels("project-secret"))
      .resolves.toEqual(new Set(["gpt-5.6-luna", "gpt-5.6-sol"]));
    expect(fetchMock).toHaveBeenCalledWith("https://api.openai.com/v1/models", {
      headers: { Authorization: "Bearer project-secret" },
    });
  });

  it("reports only the HTTP status when discovery is rejected", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ error: { message: "sensitive provider response" } }),
      { status: 401 },
    )));

    await expect(fetchOpenAiModels("project-secret"))
      .rejects.toThrow("OpenAI model discovery failed (401)");
  });
});
