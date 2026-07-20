import { describe, expect, it } from "vitest";
import { checkProviderConnection } from "../src/provider-connection.js";

describe("provider connection checks", () => {
  it("uses provider authentication endpoints without generation", async () => {
    const requests: Array<{ url: string; authorization: string | null }> = [];
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      requests.push({ url: String(input), authorization: headers.get("authorization") });
      return new Response("{}", { status: 200 });
    }) as typeof fetch;

    await expect(checkProviderConnection("openrouter", "private-key", fetchImpl))
      .resolves.toEqual({ provider: "openrouter", status: "connected" });
    expect(requests).toEqual([{
      url: "https://openrouter.ai/api/v1/key",
      authorization: "Bearer private-key",
    }]);
  });

  it("distinguishes rejected credentials from provider availability failures", async () => {
    const rejected = (async () => new Response("{}", { status: 401 })) as typeof fetch;
    const unavailable = (async () => new Response("{}", { status: 404 })) as typeof fetch;
    await expect(checkProviderConnection("openai", "key", rejected))
      .resolves.toEqual({ provider: "openai", status: "unauthorized" });
    await expect(checkProviderConnection("deepseek", "key", unavailable))
      .resolves.toEqual({ provider: "deepseek", status: "unavailable" });
  });
});
