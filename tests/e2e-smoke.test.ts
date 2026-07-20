import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { campaignScopePath } from "../src/persistence/campaign-catalog.js";
import { createDungeonWebServer } from "../src/web-server.js";
import type { ProviderConfig } from "../src/schemas.js";
import type { LlmProvider, StructuredRequest, StructuredResult } from "../src/types.js";
import { setupFixture } from "./helpers.js";

/**
 * One complete player journey over the real HTTP server and real on-disk
 * persistence: compatibility probe, campaign creation, a checked d100 turn,
 * a read-only question, inspection, transcript, export, and finally a full
 * server restart against the same root to prove the campaign reloads from
 * durable state alone.
 */

const CONFIG: ProviderConfig = {
  provider: "gemini",
  model: "gemini-smoke",
  temperature: 0.8,
  maxOutputTokens: 4000,
};

const LEDGER_FACT = "The cellar ledger names the smuggler who bribed the gate clerk.";
const TURN_NARRATION = "Between dusty casks you pry loose a floor plank and lift out the ledger.";
const ASK_ANSWER = "You recall the innkeeper mentioning the cellar has a false floor.";

class SmokeProvider implements LlmProvider {
  readonly id = "fake";

  constructor(readonly model: string) {}

  async generateStructured<T>(request: StructuredRequest<T>): Promise<StructuredResult<T>> {
    let data: unknown;
    if (request.schemaName === "campaign_setup") {
      data = structuredClone(setupFixture);
    } else if (request.schemaName.startsWith("connection_campaign_setup_")) {
      data = JSON.parse(request.prompt.slice(request.prompt.indexOf("{")));
    } else if (request.schemaName.startsWith("connection_gameplay_contract_v1_")) {
      const marker = "Schema enforcement verified.";
      data = { kind: "resolved", narration: marker, turnSummary: marker, operations: [] };
    } else if (request.schemaName === "turn_decision_v1") {
      data = {
        kind: "check_required",
        check: {
          name: "Search",
          difficulty: 50,
          modifiers: [],
          exceptionalSuccessStakes: "Find the ledger and a hidden key.",
          successStakes: "Find the ledger.",
          failureStakes: "Find nothing but disturbed dust.",
          severeFailureStakes: "Knock over a cask and draw attention.",
          failureCampaignStatus: "none",
        },
      };
    } else if (request.schemaName === "turn_resolution_v1") {
      data = {
        narration: TURN_NARRATION,
        turnSummary: "The scout recovered the cellar ledger.",
        operations: [{
          type: "add_fact",
          targetId: "player:hero",
          section: "knowledge",
          text: LEDGER_FACT,
        }],
      };
    } else if (request.schemaName === "campaign_question") {
      data = { answer: ASK_ANSWER };
    } else {
      throw new Error(`Smoke provider received unexpected schema ${request.schemaName}`);
    }
    return {
      data: request.schema.parse(data),
      provider: this.id,
      model: this.model,
      rawText: JSON.stringify(data),
      structuredMode: "exact_schema",
      usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150, billedCostUsd: 0.0006 },
    };
  }
}

const servers: ReturnType<typeof createDungeonWebServer>[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) =>
    new Promise<void>((resolve) => server.close(() => resolve()))));
});

async function fixtureRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "llm-dungeon-smoke-"));
  await mkdir(path.join(root, "config"), { recursive: true });
  await mkdir(path.join(root, "web"), { recursive: true });
  await writeFile(path.join(root, "config", "provider.json"), JSON.stringify(CONFIG), "utf8");
  await writeFile(path.join(root, "web", "index.html"), "<!doctype html><title>Dungeon</title>", "utf8");
  return root;
}

async function start(root: string): Promise<string> {
  const server = createDungeonWebServer({
    root,
    environment: { GEMINI_API_KEY: "test-gemini-key" },
    openAiModelsFetcher: false,
    providerFactory: (config) => new SmokeProvider(config.model),
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

async function json(base: string, route: string, method = "GET", body?: unknown): Promise<any> {
  const response = await fetch(`${base}${route}`, {
    method,
    ...(body === undefined
      ? {}
      : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
  });
  const value = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(value.error ?? `Request failed (${response.status})`);
  return value;
}

describe("end-to-end smoke", () => {
  it("plays a full checked turn over HTTP and survives a server restart from disk", async () => {
    const root = await fixtureRoot();
    const base = await start(root);

    // Probe the model compatible, then create a campaign from a confirmed draft.
    const probe = await json(base, "/api/llm/models/test", "POST", {
      provider: CONFIG.provider,
      model: CONFIG.model,
      language: "en",
    });
    expect(probe.ok).toBe(true);
    const draft = await json(base, "/api/campaigns/draft", "POST", {
      premise: "A tavern with a smuggling problem.",
      character: "A sharp-eyed scout.",
      language: "en",
      worldRules: "# Test World\n",
      config: CONFIG,
    });
    const created = await json(base, "/api/campaigns/confirm", "POST", { draftId: draft.draftId });
    const campaignId: string = created.state.campaignId;
    expect(created.state.turn).toBe(0);
    const route = (action: string) => `/api/campaigns/${encodeURIComponent(campaignId)}/${action}`;

    // A checked gameplay turn: adjudication requires a d100 check, the roll is
    // application-owned, and the locked resolution commits durable state.
    const turn = await json(base, route("play"), "POST", {
      action: "I search the cellar for the smuggler's ledger.",
    });
    expect(turn.turn).toBe(1);
    expect(turn.narration).toBe(TURN_NARRATION);
    expect(turn.checkText).toMatch(/Search/);
    expect(turn.checkText).toMatch(/\d+/);

    // The committed operation is visible through player-safe inspection.
    const inspection = await json(base, route("inspect?view=character"));
    expect(inspection.inspection.facts.knowledge).toContain(LEDGER_FACT);

    // :ask answers without consuming a turn or touching state.
    const ask = await json(base, route("play"), "POST", { action: ":ask What do I know about the cellar?" });
    expect(ask.answer).toBe(ASK_ANSWER);
    expect((await json(base, route("status"))).campaign.turn).toBe(1);

    // Transcript and export reflect the same committed history.
    const transcript = await json(base, route("transcript"));
    expect(transcript.turns).toHaveLength(2);
    expect(transcript.turns[1].narration).toBe(TURN_NARRATION);
    const exported = await fetch(`${base}${route("export")}`);
    expect(exported.status).toBe(200);
    expect(await exported.text()).toContain(TURN_NARRATION);

    // The durable artifacts exist on disk in the documented layout.
    const currentDir = path.join(campaignScopePath(path.join(root, "data"), campaignId), "current");
    const manifest = JSON.parse(await readFile(path.join(currentDir, "manifest.json"), "utf8"));
    expect(manifest.turn).toBe(1);
    await readFile(path.join(currentDir, "turns", "000001.md"), "utf8");

    // A brand-new server over the same root must reload the campaign from
    // disk alone: same turn, same transcript, still playable state.
    await new Promise<void>((resolve) => servers.pop()!.close(() => resolve()));
    const reloadedBase = await start(root);
    const status = await json(reloadedBase, "/api/status");
    const reloaded = status.campaigns.find(
      (campaign: { campaignId: string }) => campaign.campaignId === campaignId,
    );
    expect(reloaded?.turn).toBe(1);
    const reloadedTranscript = await json(reloadedBase, route("transcript").replace(base, reloadedBase));
    expect(reloadedTranscript.turns).toHaveLength(2);
    expect(reloadedTranscript.turns[1].narration).toBe(TURN_NARRATION);
  });
});
