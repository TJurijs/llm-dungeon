import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createDungeonWebServer } from "../src/web-server.js";
import { GenerationFailure } from "../src/llm/failures.js";
import type { LlmProvider, StructuredRequest, StructuredResult } from "../src/types.js";
import type { ProviderConfig } from "../src/schemas.js";
import { setupFixture } from "./helpers.js";

class WebFakeProvider implements LlmProvider {
  readonly id = "fake";
  constructor(
    readonly model: string,
    private readonly onRequest: (request: StructuredRequest<unknown>) => void = () => undefined,
  ) {}

  async generateStructured<T>(request: StructuredRequest<T>): Promise<StructuredResult<T>> {
    this.onRequest(request as StructuredRequest<unknown>);
    let data: unknown;
    if (request.schemaName === "campaign_setup" || request.schemaName === "connection_campaign_setup") data = structuredClone(setupFixture);
    else if (request.schemaName === "simulated_player_action") {
      data = { action: "I ask the innkeeper about the old road.", approach: "investigation" };
    } else if (request.schemaName === "connection_gameplay_contract_v1") {
      data = { kind: "resolved", narration: "Schema enforcement verified.", turnSummary: "Schema enforcement verified.", operations: [] };
    } else if (request.schemaName === "campaign_question") {
      data = { answer: "Use one primary consequential action while under immediate pressure." };
    } else if (request.schemaName.includes("session_judgment")) {
      data = {
        verdict: "good",
        overallScore: 8,
        narrativeScore: 8,
        agencyScore: 8,
        persistenceScore: 8,
        checksScore: 8,
        technicalScore: 8,
        turnAudits: [{ turn: 1, durableConsequences: [] }],
        executiveSummary: "The session was coherent and persistent.",
        strengths: ["The clue remained grounded in the world."],
        issues: [],
        persistenceAssessment: "State and narration agree.",
        checkAssessment: "No unnecessary check occurred.",
        sandboxAssessment: "The player retained agency.",
        recommendedChanges: ["Test a longer session."],
      };
    }
    else {
      data = {
        kind: "resolved",
        narration: "The innkeeper lowers her voice and tells you that wagons have vanished near the old bridge.",
        turnSummary: "The innkeeper shared news about vanished wagons.",
        operations: [],
      };
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

const PRIVATE_CHECK_STAKE = "A private alternate consequence that must stay server-side.";
const PRIVATE_OPERATION_FACT = "Mara privately knows who sabotaged the northern road.";

class SensitiveWebProvider extends WebFakeProvider {
  override async generateStructured<T>(request: StructuredRequest<T>): Promise<StructuredResult<T>> {
    if (request.schemaName === "turn_decision_v1") {
      return {
        data: request.schema.parse({
          kind: "check_required",
          check: {
            name: "Investigation",
            difficulty: 50,
            modifiers: [],
            exceptionalSuccessStakes: "Find the strongest clue.",
            successStakes: "Find a useful clue.",
            failureStakes: PRIVATE_CHECK_STAKE,
            severeFailureStakes: "A second private alternate consequence.",
            failureCampaignStatus: "none",
          },
        }),
        provider: this.id,
        model: this.model,
      };
    }
    if (request.schemaName === "turn_resolution_v1") {
      return {
        data: request.schema.parse({
          narration: "Mara gives you a guarded but useful answer.",
          turnSummary: "Mara supplied a guarded clue.",
          operations: [{
            type: "add_fact",
            targetId: "npc:mara-venn",
            section: "secrets",
            text: PRIVATE_OPERATION_FACT,
          }],
        }),
        provider: this.id,
        model: this.model,
      };
    }
    return super.generateStructured(request);
  }
}

class SetupRejectingProvider extends WebFakeProvider {
  override async generateStructured<T>(request: StructuredRequest<T>): Promise<StructuredResult<T>> {
    if (request.schemaName === "connection_campaign_setup") {
      throw new GenerationFailure("schema_rejected", "Campaign setup schema rejected", false, 400);
    }
    return super.generateStructured(request);
  }
}

const servers: ReturnType<typeof createDungeonWebServer>[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

async function fixtureRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "llm-dungeon-web-"));
  await mkdir(path.join(root, "config"), { recursive: true });
  await mkdir(path.join(root, "web"), { recursive: true });
  await writeFile(path.join(root, "config", "provider.json"), JSON.stringify({
    provider: "gemini",
    model: "gemini-3.5-flash",
    temperature: 0.8,
    maxOutputTokens: 4000,
  }), "utf8");
  await writeFile(path.join(root, "config", "world.md"), "# Classic Fantasy\n", "utf8");
  await writeFile(path.join(root, "web", "index.html"), "<!doctype html><title>Dungeon</title>", "utf8");
  return root;
}

async function start(root: string, environment: NodeJS.ProcessEnv = {}) {
  const environments: NodeJS.ProcessEnv[] = [];
  const server = createDungeonWebServer({
    root,
    environment,
    providerFactory: (config: ProviderConfig, effectiveEnvironment: NodeJS.ProcessEnv) => {
      environments.push(effectiveEnvironment);
      return new WebFakeProvider(config.model);
    },
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  const address = server.address() as AddressInfo;
  return { base: `http://127.0.0.1:${address.port}`, environments };
}

async function json(base: string, route: string, method = "GET", body?: unknown): Promise<any> {
  const response = await fetch(`${base}${route}`, {
    method,
    ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
  });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error);
  return value;
}

describe("web-cli server", () => {
  it("serves the browser's extracted terminal-history module under the static allowlist", async () => {
    const root = await fixtureRoot();
    await writeFile(path.join(root, "web", "terminal-history.js"), "export const marker = true;\n", "utf8");
    const { base } = await start(root);

    const response = await fetch(`${base}/terminal-history.js`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
    expect(await response.text()).toBe("export const marker = true;\n");
  });

  it("publishes registry-driven language metadata for future presentation clients", async () => {
    const root = await fixtureRoot();
    const { base } = await start(root);

    const status = await json(base, "/api/status");
    expect(status.languages).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: "en",
        name: "English",
        setupDefaults: expect.objectContaining({ premise: expect.any(String), characterConcept: expect.any(String) }),
      }),
      expect.objectContaining({
        code: "ru",
        name: "Русский",
        setupDefaults: expect.objectContaining({ premise: expect.stringMatching(/[А-Яа-яЁё]/) }),
      }),
    ]));
  });

  it("reports cumulative persisted campaign cost including setup and gameplay", async () => {
    const root = await fixtureRoot();
    const { base } = await start(root, { GEMINI_API_KEY: "test-key" });
    const draft = await json(base, "/api/campaign/draft", "POST", { premise: "A tavern.", character: "A scout." });
    await json(base, "/api/campaign/confirm", "POST", { draftId: draft.draftId, archiveCurrent: false });

    expect((await json(base, "/api/status")).game.campaignCost).toEqual({
      totalUsd: 0.0006,
      basis: "exact",
      pricedTurns: 1,
      unpricedTurns: 0,
    });

    await json(base, "/api/game/play", "POST", { action: "I greet the innkeeper." });
    expect((await json(base, "/api/status")).game.campaignCost).toEqual({
      totalUsd: 0.0012,
      basis: "exact",
      pricedTurns: 2,
      unpricedTurns: 0,
    });
  });

  it("stores language-specific world guidance without rewriting the legacy profile", async () => {
    const root = await fixtureRoot();
    const { base } = await start(root);
    const legacyPath = path.join(root, "config", "world.md");
    const legacy = await readFile(legacyPath, "utf8");

    await json(base, "/api/config/world", "PUT", {
      language: "ru",
      markdown: "# Русский стиль\n",
    });

    expect(await readFile(path.join(root, "config", "worlds", "ru.md"), "utf8")).toBe("# Русский стиль\n");
    expect(await readFile(legacyPath, "utf8")).toBe(legacy);
    expect(await json(base, "/api/config/world?language=ru")).toMatchObject({
      language: "ru",
      markdown: "# Русский стиль\n",
      source: "localized_override",
    });
    expect((await json(base, "/api/config/world?language=en")).markdown).toBe(legacy);
  });

  it("exposes static prompt templates without live campaign context or hidden state", async () => {
    const root = await fixtureRoot();
    const { base } = await start(root, { GEMINI_API_KEY: "test-key" });
    const draft = await json(base, "/api/campaign/draft", "POST", { premise: "A tavern.", character: "A scout." });
    await json(base, "/api/campaign/confirm", "POST", { draftId: draft.draftId, archiveCurrent: false });

    const preview = await json(base, "/api/config/prompts?phase=adjudication&language=en");
    expect(preview).toMatchObject({ phase: "adjudication", version: 1, containsLiveCampaignData: false });
    expect(preview.sourceFiles).toEqual([
      "src/prompts/gameplay.ts",
      "src/prompts/difficulty.ts",
      "src/prompts/blocks.ts",
    ]);
    expect(preview.sharedSystemSource).toBe("src/prompts/blocks.ts");
    expect(preview.sections).toContain("check-difficulty");
    expect(preview.prompt).toContain("AUTHORITATIVE CAMPAIGN CONTEXT — supplied at runtime");
    expect(JSON.stringify(preview)).not.toContain("Mara suspects the watch captain takes bribes.");
    expect(JSON.stringify(preview)).not.toContain("Schema enforcement verified.");
  });

  it("persists language selection and applies it to new and current campaigns", async () => {
    const root = await fixtureRoot();
    const { base } = await start(root, { GEMINI_API_KEY: "test-key" });
    const changed = await json(base, "/api/config/language", "PUT", { language: "ru", applyToCurrent: true });
    expect(changed.language).toBe("ru");
    expect(JSON.parse(await readFile(path.join(root, "config", "app.json"), "utf8"))).toEqual({ language: "ru" });

    const draft = await json(base, "/api/campaign/draft", "POST", { premise: "Таверна.", character: "Разведчик." });
    const created = await json(base, "/api/campaign/confirm", "POST", { draftId: draft.draftId, archiveCurrent: false });
    expect(created.state.language).toBe("ru");
    expect((await json(base, "/api/status")).language).toBe("ru");

    await json(base, "/api/config/language", "PUT", { language: "en", applyToCurrent: true });
    expect((await json(base, "/api/status")).game.campaign.language).toBe("en");
  });

  it("returns a friendly campaign message instead of filesystem errors before setup", async () => {
    const root = await fixtureRoot();
    const { base } = await start(root, { GEMINI_API_KEY: "test-key" });
    const response = await fetch(`${base}/api/game/inspect?view=character`);
    expect(response.status).toBe(400);
    const body = await response.json() as { error: string };
    expect(body.error).toBe("No current campaign. Create one in the New campaign panel first.");
    expect(body.error).not.toContain("ENOENT");
  });

  it("accepts blank campaign guidance and rejects the removed setup-mode contract", async () => {
    const root = await fixtureRoot();
    const { base } = await start(root, { GEMINI_API_KEY: "test-key" });

    const draft = await json(base, "/api/campaign/draft", "POST", { premise: "", character: "" });
    expect(draft.setup.campaignTitle).toBe(setupFixture.campaignTitle);

    const response = await fetch(`${base}/api/campaign/draft`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "generated", premise: "", character: "" }),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: expect.stringContaining("Unrecognized key") });
  });

  it("keeps malformed evaluation runs visible as inspection failures", async () => {
    const root = await fixtureRoot();
    const brokenRun = path.join(root, "evaluations", "runs", "broken-run");
    await mkdir(brokenRun, { recursive: true });
    await writeFile(path.join(brokenRun, "manifest.json"), "{broken json", "utf8");
    const { base } = await start(root, { GEMINI_API_KEY: "test-key" });

    const body = await json(base, "/api/evaluations/runs");
    expect(body.runs).toContainEqual(expect.objectContaining({
      runId: "broken-run",
      status: "inspection_failed",
      totalEstimatedCostUsd: 0,
      sessions: [],
    }));
  });

  it("keeps browser-entered provider keys in memory and out of provider.json", async () => {
    const root = await fixtureRoot();
    const { base, environments } = await start(root);
    await json(base, "/api/config/provider", "PUT", {
      provider: "gemini",
      model: "gemini-3.5-flash",
      temperature: 0.7,
      maxOutputTokens: 5000,
      apiKey: "super-secret-key",
    });
    const saved = await readFile(path.join(root, "config", "provider.json"), "utf8");
    expect(saved).not.toContain("super-secret-key");
    expect(JSON.parse(saved)).not.toHaveProperty("apiKey");
    expect((await json(base, "/api/config/provider")).keyStatus.gemini).toBe(true);
    await json(base, "/api/config/provider/test", "POST", {});
    expect(environments.at(-1)?.GEMINI_API_KEY).toBe("super-secret-key");
  });

  it("clears a blank browser session key and falls back to the environment", async () => {
    const root = await fixtureRoot();
    let usedEnvironmentKey = false;
    const server = createDungeonWebServer({
      root,
      environment: { GEMINI_API_KEY: "environment-key" },
      providerFactory: (config, environment) => {
        usedEnvironmentKey = environment.GEMINI_API_KEY === "environment-key";
        return new WebFakeProvider(config.model);
      },
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    servers.push(server);
    const address = server.address() as AddressInfo;
    const base = `http://127.0.0.1:${address.port}`;
    const provider = {
      provider: "gemini",
      model: "gemini-3.5-flash",
      temperature: 0.7,
      maxOutputTokens: 5000,
    };

    await json(base, "/api/config/provider", "PUT", { ...provider, apiKey: "session-key" });
    const cleared = await json(base, "/api/config/provider", "PUT", { ...provider, apiKey: "" });
    expect(cleared.keyStorage).toBe("environment");
    expect(cleared.keyStatus.gemini).toBe(true);

    await json(base, "/api/config/provider/test", "POST", { ...provider, apiKey: "" });
    expect(usedEnvironmentKey).toBe(true);
  });

  it("rejects simple cross-site mutation requests before changing local files", async () => {
    const root = await fixtureRoot();
    const { base } = await start(root, { GEMINI_API_KEY: "test-key" });
    const worldPath = path.join(root, "config", "world.md");
    const original = await readFile(worldPath, "utf8");

    const simple = await fetch(`${base}/api/config/world`, {
      method: "PUT",
      headers: { "Content-Type": "text/plain" },
      body: JSON.stringify({ markdown: "# Cross-site overwrite\n" }),
    });
    expect(simple.status).toBe(415);

    const foreign = await fetch(`${base}/api/config/world`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Origin: "https://malicious.example" },
      body: JSON.stringify({ markdown: "# Foreign-origin overwrite\n" }),
    });
    expect(foreign.status).toBe(403);
    expect(await readFile(worldPath, "utf8")).toBe(original);
  });

  it("tests the provider and model submitted by the UI without replacing the saved config", async () => {
    const root = await fixtureRoot();
    const requested: ProviderConfig[] = [];
    const providerRequests: StructuredRequest<unknown>[] = [];
    const server = createDungeonWebServer({
      root,
      environment: { OPENROUTER_API_KEY: "test-openrouter-key" },
      providerFactory: (config) => {
        requested.push(config);
        return new WebFakeProvider(config.model, (request) => providerRequests.push(request));
      },
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    servers.push(server);
    const address = server.address() as AddressInfo;
    const base = `http://127.0.0.1:${address.port}`;

    const result = await json(base, "/api/config/provider/test", "POST", {
      provider: "openrouter",
      model: "google/gemini-3.5-flash",
      temperature: 0.6,
      maxOutputTokens: 900,
      endpoint: "",
    });
    expect(result.model).toBe("google/gemini-3.5-flash");
    expect(result.ok).toBe(true);
    expect(result.structuredOutput).toMatchObject({
      required: true,
      mode: "exact_schema",
      testedSchemas: ["campaign_setup", "gameplay_contract_v1"],
      protocolVersion: 1,
    });
    expect(providerRequests[0]?.schemaName).toBe("connection_campaign_setup");
    expect(providerRequests[1]?.wireSchema).toBeDefined();
    expect(providerRequests[1]?.jsonSchema).toBeDefined();
    expect(providerRequests[1]?.decodeResponse).toBeTypeOf("function");
    expect(providerRequests[1]?.maxOutputTokens).toBe(2000);
    expect(requested.at(-1)).toMatchObject({ provider: "openrouter", model: "google/gemini-3.5-flash" });
    expect(JSON.parse(await readFile(path.join(root, "config", "provider.json"), "utf8"))).toMatchObject({
      provider: "gemini",
      model: "gemini-3.5-flash",
    });
  });

  it("fails the connection test when campaign setup is rejected even if gameplay would pass", async () => {
    const root = await fixtureRoot();
    const requests: string[] = [];
    const server = createDungeonWebServer({
      root,
      environment: { OPENROUTER_API_KEY: "test-openrouter-key" },
      providerFactory: (config) => new SetupRejectingProvider(config.model, (request) => requests.push(request.schemaName)),
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    servers.push(server);
    const address = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${address.port}/api/config/provider/test`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider: "openrouter",
        model: "google/gemini-3.5-flash",
        temperature: 0.6,
        maxOutputTokens: 900,
      }),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "Campaign setup schema rejected" });
    expect(requests).toEqual([]);
  });

  it("can run a first-use provider test before provider.json exists", async () => {
    const root = await fixtureRoot();
    await rm(path.join(root, "config", "provider.json"));
    const { base, environments } = await start(root);

    const result = await json(base, "/api/config/provider/test", "POST", {
      provider: "gemini",
      model: "gemini-3.5-flash",
      temperature: 0.6,
      maxOutputTokens: 900,
      apiKey: "first-use-key",
    });

    expect(result).toMatchObject({ ok: true, provider: "fake", model: "gemini-3.5-flash" });
    expect(environments.at(-1)?.GEMINI_API_KEY).toBe("first-use-key");
    await expect(readFile(path.join(root, "config", "provider.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("confirms a draft with the language and world rules used to generate it", async () => {
    const root = await fixtureRoot();
    const { base } = await start(root, { GEMINI_API_KEY: "test-key" });
    const draft = await json(base, "/api/campaign/draft", "POST", {
      premise: "A tavern.",
      character: "A scout.",
    });

    await json(base, "/api/config/world", "PUT", { markdown: "# Changed World\n" });
    await json(base, "/api/config/language", "PUT", { language: "ru", applyToCurrent: false });
    const created = await json(base, "/api/campaign/confirm", "POST", {
      draftId: draft.draftId,
      archiveCurrent: false,
    });

    expect(created.state.language).toBe("en");
    const scenario = await readFile(path.join(root, "data", "current", "scenario.md"), "utf8");
    expect(scenario).toContain("# Classic Fantasy");
    expect(scenario).not.toContain("# Changed World");
  });

  it("reports pending state without exposing the saved player action", async () => {
    const root = await fixtureRoot();
    const { base } = await start(root, { GEMINI_API_KEY: "test-key" });
    const draft = await json(base, "/api/campaign/draft", "POST", {
      premise: "A tavern.",
      character: "A scout.",
    });
    await json(base, "/api/campaign/confirm", "POST", { draftId: draft.draftId, archiveCurrent: false });
    const privateAction = "I whisper a private plan that should not appear in status.";
    await writeFile(path.join(root, "data", "current", "pending-turn.json"), JSON.stringify({
      kind: "action",
      action: privateAction,
      phase: "requested",
    }), "utf8");

    const status = await json(base, "/api/status");
    expect(status.game.pending).toEqual({ kind: "action", phase: "requested", lockedRoll: false });
    expect(JSON.stringify(status)).not.toContain(privateAction);
  });

  it("reports pending appeal metadata without exposing its claim", async () => {
    const root = await fixtureRoot();
    const { base } = await start(root, { GEMINI_API_KEY: "test-key" });
    const draft = await json(base, "/api/campaign/draft", "POST", { premise: "A tavern.", character: "A scout." });
    await json(base, "/api/campaign/confirm", "POST", { draftId: draft.draftId, archiveCurrent: false });
    const privateClaim = "The private appeal explanation must not appear in status.";
    await writeFile(path.join(root, "data", "current", "pending-turn.json"), JSON.stringify({
      kind: "appeal",
      claim: privateClaim,
      targetTurn: 1,
      phase: "requested",
    }), "utf8");

    const status = await json(base, "/api/status");
    expect(status.game.pending).toEqual({ kind: "appeal", phase: "requested", targetTurn: 1 });
    expect(JSON.stringify(status)).not.toContain(privateClaim);
  });

  it("routes explicit appeal syntax through an administrative commit", async () => {
    const root = await fixtureRoot();
    const requests: string[] = [];
    const server = createDungeonWebServer({
      root,
      environment: { GEMINI_API_KEY: "test-key" },
      providerFactory: (config) => new WebFakeProvider(config.model, (request) => requests.push(request.schemaName)),
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    servers.push(server);
    const address = server.address() as AddressInfo;
    const base = `http://127.0.0.1:${address.port}`;
    const draft = await json(base, "/api/campaign/draft", "POST", { premise: "A tavern.", character: "A scout." });
    await json(base, "/api/campaign/confirm", "POST", { draftId: draft.draftId, archiveCurrent: false });
    await json(base, "/api/game/play", "POST", { action: "I greet Mara." });

    const appeal = await json(base, "/api/game/play", "POST", {
      action: ":appeal --turn 1 The greeting changed no state; please verify that is correct.",
    });
    expect(appeal).toMatchObject({ kind: "appeal", appealTargetTurn: 1, turn: 2, checkText: null });
    expect(requests.at(-1)).toBe("appeal_resolution_v1");
    const transcript = await json(base, "/api/game/transcript");
    expect(transcript.turns.at(-1)).toMatchObject({
      kind: "appeal",
      appealTargetTurn: 1,
      action: ":appeal --turn 1 The greeting changed no state; please verify that is correct.",
    });
  });

  it("answers explicit questions without exposing turn fields or advancing the campaign", async () => {
    const root = await fixtureRoot();
    const requests: string[] = [];
    const server = createDungeonWebServer({
      root,
      environment: { GEMINI_API_KEY: "test-key" },
      providerFactory: (config) => new WebFakeProvider(config.model, (request) => requests.push(request.schemaName)),
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    servers.push(server);
    const address = server.address() as AddressInfo;
    const base = `http://127.0.0.1:${address.port}`;
    const draft = await json(base, "/api/campaign/draft", "POST", { premise: "A tavern.", character: "A scout." });
    await json(base, "/api/campaign/confirm", "POST", { draftId: draft.draftId, archiveCurrent: false });
    const beforeStatus = await json(base, "/api/status");
    const beforeTranscript = await json(base, "/api/game/transcript");

    const answer = await json(base, "/api/game/play", "POST", {
      action: ":ask Can I attack three enemies and protect myself in one turn?",
    });

    expect(answer).toEqual({
      kind: "question",
      answer: "Use one primary consequential action while under immediate pressure.",
    });
    expect(requests.at(-1)).toBe("campaign_question");
    expect((await json(base, "/api/status")).game.campaign.turn).toBe(beforeStatus.game.campaign.turn);
    expect(await json(base, "/api/game/transcript")).toEqual(beforeTranscript);
  });

  it("returns only player-visible turn, transcript, and structured inspection fields", async () => {
    const root = await fixtureRoot();
    const server = createDungeonWebServer({
      root,
      environment: { GEMINI_API_KEY: "test-key" },
      providerFactory: (config) => new SensitiveWebProvider(config.model),
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    servers.push(server);
    const address = server.address() as AddressInfo;
    const base = `http://127.0.0.1:${address.port}`;
    const draft = await json(base, "/api/campaign/draft", "POST", {
      premise: "A tavern.",
      character: "A scout.",
    });
    await json(base, "/api/campaign/confirm", "POST", { draftId: draft.draftId, archiveCurrent: false });

    const turn = await json(base, "/api/game/play", "POST", { action: "I investigate Mara's story." });
    expect(turn.kind).toBe("gameplay");
    expect(turn.checkText).toContain("Investigation: d100 =");
    expect(turn).not.toHaveProperty("check");
    expect(turn).not.toHaveProperty("operations");
    expect(JSON.stringify(turn)).not.toContain(PRIVATE_CHECK_STAKE);
    expect(JSON.stringify(turn)).not.toContain(PRIVATE_OPERATION_FACT);

    const character = await json(base, "/api/game/inspect?view=character");
    expect(character.inspection).toMatchObject({ view: "character", name: "Arlen Vale" });
    expect(JSON.stringify(character)).not.toContain(PRIVATE_CHECK_STAKE);
    expect(JSON.stringify(character)).not.toContain(PRIVATE_OPERATION_FACT);
    expect(JSON.stringify(character)).not.toContain("State Operations");
    expect(JSON.stringify(character)).not.toContain("player:hero");

    const location = await json(base, "/api/game/inspect?view=location");
    expect(location.inspection).toMatchObject({ view: "location", name: "The Crooked Crown" });
    expect(location.inspection).not.toHaveProperty("present");
    expect(location.inspection).not.toHaveProperty("inventory");
    expect(JSON.stringify(location)).not.toContain("Mara Venn");

    for (const removed of ["inventory", "journal"]) {
      const response = await fetch(`${base}/api/game/inspect?view=${removed}`);
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: "Invalid inspection view" });
    }

    const transcript = await json(base, "/api/game/transcript");
    expect(transcript.turns.at(-1)).toMatchObject({
      turn: 1,
      kind: "gameplay",
      action: "I investigate Mara's story.",
      narration: "Mara gives you a guarded but useful answer.",
      checkText: expect.stringContaining("Investigation: d100 ="),
    });
    expect(JSON.stringify(transcript)).not.toContain(PRIVATE_CHECK_STAKE);
    expect(JSON.stringify(transcript)).not.toContain(PRIVATE_OPERATION_FACT);

    const exported = await fetch(`${base}/api/game/export?format=markdown`);
    expect(exported.status).toBe(200);
    expect(exported.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
    expect(exported.headers.get("content-disposition")).toContain("attachment;");
    expect(exported.headers.get("content-disposition")).toContain("The%20Crooked%20Crown.md");
    const markdown = await exported.text();
    expect(markdown).toContain("# The Crooked Crown");
    expect(markdown).toContain("## Opening");
    expect(markdown).toContain("## Turn 1");
    expect(markdown).toContain("I investigate Mara's story.");
    expect(markdown).toContain("Mara gives you a guarded but useful answer.");
    expect(markdown).not.toContain(PRIVATE_CHECK_STAKE);
    expect(markdown).not.toContain(PRIVATE_OPERATION_FACT);
    expect(markdown).not.toContain("State Operations");
    expect(markdown).not.toContain("Input Tokens");
    expect(markdown).not.toContain("fake");
  });

  it("creates and plays a campaign and runs self-play through HTTP", async () => {
    const root = await fixtureRoot();
    const { base } = await start(root, { GEMINI_API_KEY: "test-key" });
    const draft = await json(base, "/api/campaign/draft", "POST", { premise: "A tavern.", character: "A scout." });
    expect(draft.setup.campaignTitle).toBe(setupFixture.campaignTitle);
    expect(JSON.stringify(draft)).not.toContain("Mara suspects the watch captain takes bribes.");
    expect(draft.setup).not.toHaveProperty("entities");
    expect(draft.setup.player).not.toHaveProperty("secrets");
    const created = await json(base, "/api/campaign/confirm", "POST", { draftId: draft.draftId, archiveCurrent: false });
    expect(created.state.turn).toBe(0);
    const turn = await json(base, "/api/game/play", "POST", { action: "I greet the innkeeper." });
    expect(turn.turn).toBe(1);
    expect(turn.narration).toContain("old bridge");
    expect((await json(base, "/api/game/transcript")).turns.at(-1)).toMatchObject({
      action: "I greet the innkeeper.",
      kind: "gameplay",
    });

    const started = await json(base, "/api/evaluations/start", "POST", {
      sessions: 1,
      turns: 1,
      concurrency: 2,
      playerProfiles: ["social-manipulator"],
    });
    expect(started.task.status).toBe("running");
    expect(started.config).toMatchObject({ maxCostUsd: 5, concurrency: 2, playerProfiles: ["social-manipulator"] });
    let task = started.task;
    for (let attempt = 0; attempt < 50 && task.status === "running"; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      task = (await json(base, "/api/status")).evaluationTask;
    }
    expect(task.status).toBe("completed");
    expect(task.sessionProgress["session-001"]).toMatchObject({ phase: "completed", completedTurns: 1, totalTurns: 1 });
    const runs = await json(base, "/api/evaluations/runs");
    expect(runs.runs[0].status).toBe("completed");
    expect(runs.runs[0].sessions[0].metrics.turnsCompleted).toBe(1);
    expect(runs.runs[0].sessions[0].profile).toBe("social-manipulator");
    const transcript = await json(base, `/api/evaluations/artifact?runId=${runs.runs[0].runId}&sessionId=session-001&kind=transcript`);
    expect(transcript.presentation).toMatchObject({
      profile: "social-manipulator",
      opening: setupFixture.openingNarration,
      turns: [{
        turn: 1,
        action: "I ask the innkeeper about the old road.",
        approach: "investigation",
        narration: "The innkeeper lowers her voice and tells you that wagons have vanished near the old bridge.",
        status: "completed",
      }],
    });
    expect(transcript.presentation.turns[0]).not.toHaveProperty("operations");
    const evaluation = await json(base, `/api/evaluations/artifact?runId=${runs.runs[0].runId}&sessionId=session-001&kind=evaluation`);
    expect(evaluation.text).toContain("AI Game Evaluation");
  });
});
