import {
  GAMEPLAY_PROTOCOL_VERSION,
  GAMEPLAY_SCHEMA_NAMES,
  decodeTurnDecision,
  gameplayRequest,
} from "./llm/gameplay-protocol.js";
import { combineUsage } from "./llm/structured-generation.js";
import {
  CONNECTION_GAMEPLAY_PROMPT,
  CONNECTION_SETUP_PROBE,
  CONNECTION_SYSTEM_PROMPT,
  connectionSetupPrompt,
} from "./prompts/connection.js";
import { SetupResultSchema, TurnDecisionSchema } from "./schemas.js";
import type { LlmProvider, StructuredResult } from "./types.js";

export interface ConnectionProbeResult {
  provider: string;
  model: string;
  usage?: StructuredResult<unknown>["usage"];
  structuredMode: "exact_schema";
  protocolVersion: typeof GAMEPLAY_PROTOCOL_VERSION;
}

/** Exercise both schemas required to create and play a campaign. */
export async function probeProviderConnection(provider: LlmProvider): Promise<ConnectionProbeResult> {
  const setup = await provider.generateStructured({
    schemaName: "connection_campaign_setup",
    schema: SetupResultSchema,
    system: CONNECTION_SYSTEM_PROMPT,
    prompt: connectionSetupPrompt(CONNECTION_SETUP_PROBE),
    temperature: 0,
    maxOutputTokens: 2_000,
  });
  const gameplay = await provider.generateStructured(gameplayRequest({
    schemaName: GAMEPLAY_SCHEMA_NAMES.connectionProbe,
    schema: TurnDecisionSchema,
    decodeResponse: decodeTurnDecision,
    system: CONNECTION_SYSTEM_PROMPT,
    prompt: CONNECTION_GAMEPLAY_PROMPT,
    temperature: 0,
    maxOutputTokens: 2_000,
  }));
  const usage = combineUsage(setup.usage, gameplay.usage);
  return {
    provider: gameplay.provider,
    model: gameplay.model,
    ...(usage ? { usage } : {}),
    structuredMode: gameplay.structuredMode ?? "exact_schema",
    protocolVersion: GAMEPLAY_PROTOCOL_VERSION,
  };
}
