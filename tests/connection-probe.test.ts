import { describe, expect, it } from "vitest";
import { probeProviderConnection } from "../src/connection-probe.js";
import type { LlmProvider, StructuredRequest, StructuredResult } from "../src/types.js";

function resolvedWire(marker: string) {
  return {
    decision: "resolved",
    narration: marker,
    effects: [],
    summary: marker,
    checkName: "",
    difficulty: 0,
    modifiers: [],
    exceptionalSuccessStakes: "",
    successStakes: "",
    failureStakes: "",
    severeFailureStakes: "",
    failureCampaignStatus: "none",
  };
}

class LanguageProbeProvider implements LlmProvider {
  readonly id = "fake";
  readonly model = "fake-model";
  readonly schemaNames: string[] = [];

  constructor(private readonly breakRussian = false) {}

  async generateStructured<T>(request: StructuredRequest<T>): Promise<StructuredResult<T>> {
    this.schemaNames.push(request.schemaName);
    let value: unknown;
    if (request.schemaName.startsWith("connection_campaign_setup_")) {
      const encoded = request.prompt.slice(request.prompt.indexOf("{") );
      value = JSON.parse(encoded);
      if (this.breakRussian && request.schemaName.endsWith("_ru")) {
        (value as { campaignTitle: string }).campaignTitle = "Wrong language";
      }
    } else {
      const marker = request.schemaName.endsWith("_ru")
        ? "Проверка схемы выполнена."
        : "Schema enforcement verified.";
      const wire = resolvedWire(marker);
      value = request.decodeResponse ? request.decodeResponse(wire) : wire;
    }
    return {
      data: request.schema.parse(value),
      provider: this.id,
      model: this.model,
      structuredMode: "exact_schema",
      protocolVersion: request.protocolVersion,
      usage: { inputTokens: 2, outputTokens: 3, totalTokens: 5 },
    };
  }
}

describe("provider compatibility probe", () => {
  it("exercises setup and gameplay schemas in every registered language", async () => {
    const provider = new LanguageProbeProvider();
    const result = await probeProviderConnection(provider);

    expect(provider.schemaNames).toEqual([
      "connection_campaign_setup_en",
      "connection_gameplay_contract_v1_en",
      "connection_campaign_setup_ru",
      "connection_gameplay_contract_v1_ru",
    ]);
    expect(result).toMatchObject({
      provider: "fake",
      model: "fake-model",
      protocolVersion: 1,
      testedLanguages: ["en", "ru"],
      usage: { inputTokens: 8, outputTokens: 12, totalTokens: 20 },
    });
  });

  it("rejects schema-valid output that does not preserve a language marker", async () => {
    await expect(probeProviderConnection(new LanguageProbeProvider(true)))
      .rejects.toThrow("did not preserve the ru campaign setup marker");
  });

  it("can probe one gameplay language independently", async () => {
    const provider = new LanguageProbeProvider(true);
    const result = await probeProviderConnection(provider, ["en"]);

    expect(provider.schemaNames).toEqual([
      "connection_campaign_setup_en",
      "connection_gameplay_contract_v1_en",
    ]);
    expect(result.testedLanguages).toEqual(["en"]);
  });
});
