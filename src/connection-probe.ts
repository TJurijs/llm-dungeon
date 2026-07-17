import { createHash } from "node:crypto";
import { z } from "zod";
import {
  GAMEPLAY_WIRE_JSON_SCHEMA,
  GAMEPLAY_PROTOCOL_VERSION,
  GAMEPLAY_SCHEMA_NAMES,
  decodeTurnDecision,
  gameplayRequest,
} from "./llm/gameplay-protocol.js";
import { combineUsage } from "./llm/structured-generation.js";
import {
  CONNECTION_SYSTEM_PROMPT,
  connectionGameplayPrompt,
  connectionProbeForLanguage,
  connectionSetupPrompt,
} from "./prompts/connection.js";
import { PROVIDER_ADAPTER_COMPATIBILITY_REVISION } from "./providers.js";
import { LANGUAGES, type LanguageCode } from "./language.js";
import { SetupResultSchema, TurnDecisionSchema } from "./schemas.js";
import { GenerationFailure } from "./llm/failures.js";
import type { LlmProvider, StructuredResult } from "./types.js";

export const PROVIDER_COMPATIBILITY_PROBE_REVISION = 2 as const;

export const PROVIDER_COMPATIBILITY_FINGERPRINT = createHash("sha256")
  .update(JSON.stringify({
    adapterRevision: PROVIDER_ADAPTER_COMPATIBILITY_REVISION,
    probeRevision: PROVIDER_COMPATIBILITY_PROBE_REVISION,
    protocolVersion: GAMEPLAY_PROTOCOL_VERSION,
    systemPrompt: CONNECTION_SYSTEM_PROMPT,
    setupSchema: z.toJSONSchema(SetupResultSchema, { target: "draft-7" }),
    gameplaySchema: GAMEPLAY_WIRE_JSON_SCHEMA,
    languages: (Object.keys(LANGUAGES) as LanguageCode[]).map((language) => ({
      language,
      probe: connectionProbeForLanguage(language),
      setupPrompt: connectionSetupPrompt(connectionProbeForLanguage(language).setup),
      gameplayPrompt: connectionGameplayPrompt(connectionProbeForLanguage(language).gameplayMarker),
    })),
  }))
  .digest("hex");

export interface ConnectionProbeResult {
  provider: string;
  model: string;
  usage?: StructuredResult<unknown>["usage"];
  structuredMode: NonNullable<StructuredResult<unknown>["structuredMode"]>;
  protocolVersion: typeof GAMEPLAY_PROTOCOL_VERSION;
  testedLanguages: LanguageCode[];
}

function requireProbeValue(actual: string, expected: string, language: LanguageCode, field: string): void {
  if (actual !== expected) {
    throw new GenerationFailure(
      "provider",
      `Provider compatibility test did not preserve the ${language} ${field} marker`,
      false,
    );
  }
}

/** Exercise both schemas and deterministic language markers required by the application. */
export async function probeProviderConnection(provider: LlmProvider): Promise<ConnectionProbeResult> {
  let usage: StructuredResult<unknown>["usage"];
  let lastGameplay: StructuredResult<unknown> | undefined;
  const testedLanguages = Object.keys(LANGUAGES) as LanguageCode[];

  for (const language of testedLanguages) {
    const probe = connectionProbeForLanguage(language);
    const setup = await provider.generateStructured({
      schemaName: `connection_campaign_setup_${language}`,
      schema: SetupResultSchema,
      system: CONNECTION_SYSTEM_PROMPT,
      prompt: connectionSetupPrompt(probe.setup),
      temperature: 0,
      maxOutputTokens: 2_000,
    });
    requireProbeValue(setup.data.campaignTitle, probe.setup.campaignTitle, language, "campaign setup");
    usage = combineUsage(usage, setup.usage);

    const gameplay = await provider.generateStructured(gameplayRequest({
      schemaName: `${GAMEPLAY_SCHEMA_NAMES.connectionProbe}_${language}`,
      schema: TurnDecisionSchema,
      decodeResponse: decodeTurnDecision,
      system: CONNECTION_SYSTEM_PROMPT,
      prompt: connectionGameplayPrompt(probe.gameplayMarker),
      temperature: 0,
      maxOutputTokens: 2_000,
    }));
    if (gameplay.data.kind !== "resolved") {
      throw new GenerationFailure("provider", `Provider compatibility test returned a check for ${language}`, false);
    }
    requireProbeValue(gameplay.data.narration, probe.gameplayMarker, language, "gameplay narration");
    requireProbeValue(gameplay.data.turnSummary, probe.gameplayMarker, language, "gameplay summary");
    usage = combineUsage(usage, gameplay.usage);
    lastGameplay = gameplay;
  }

  if (!lastGameplay) throw new Error("No gameplay languages are registered");
  return {
    provider: lastGameplay.provider,
    model: lastGameplay.model,
    ...(usage ? { usage } : {}),
    structuredMode: lastGameplay.structuredMode ?? "exact_schema",
    protocolVersion: GAMEPLAY_PROTOCOL_VERSION,
    testedLanguages,
  };
}
