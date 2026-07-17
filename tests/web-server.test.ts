import { access, mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { CampaignCatalog } from "../src/campaign-catalog.js";
import { PROVIDER_COMPATIBILITY_FINGERPRINT } from "../src/connection-probe.js";
import { LlmModelCatalog } from "../src/llm-model-catalog.js";
import { campaignScopePath } from "../src/persistence/campaign-catalog.js";
import { createDungeonWebServer } from "../src/web-server.js";
import { StateStore } from "../src/store.js";
import type { ProviderConfig } from "../src/schemas.js";
import type { LlmProvider, StructuredRequest, StructuredResult } from "../src/types.js";
import { setupFixture } from "./helpers.js";

type RequestHook = (request: StructuredRequest<unknown>, model: string) => void | Promise<void>;

class WebFakeProvider implements LlmProvider {
  readonly id = "fake";

  constructor(readonly model: string, private readonly hook: RequestHook = () => undefined) {}

  async generateStructured<T>(request: StructuredRequest<T>): Promise<StructuredResult<T>> {
    await this.hook(request as StructuredRequest<unknown>, this.model);
    let data: unknown;
    if (request.schemaName === "campaign_setup") {
      data = structuredClone(setupFixture);
      (data as typeof setupFixture).campaignTitle = `Campaign ${this.model}`;
    } else if (request.schemaName.startsWith("connection_campaign_setup_")) {
      data = JSON.parse(request.prompt.slice(request.prompt.indexOf("{")));
    } else if (request.schemaName.startsWith("connection_gameplay_contract_v1_")) {
      const marker = request.schemaName.endsWith("_ru")
        ? "Проверка схемы выполнена."
        : "Schema enforcement verified.";
      data = {
        kind: "resolved",
        narration: marker,
        turnSummary: marker,
        operations: [],
      };
    } else if (request.schemaName === "campaign_question") {
      data = { answer: "Use one primary consequential action while under immediate pressure." };
    } else {
      data = {
        kind: "resolved",
        narration: `The ${this.model} dungeon master answers without changing hidden state.`,
        turnSummary: `${this.model} advanced the scene.`,
        operations: [],
      };
    }
    return {
      data: request.schema.parse(data),
      provider: this.id,
      model: this.model,
      rawText: JSON.stringify(data),
      structuredMode: "exact_schema",
      usage: {
        inputTokens: 100,
        outputTokens: 50,
        totalTokens: 150,
        billedCostUsd: 0.0006,
      },
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

const DEFAULT_CONFIG: ProviderConfig = {
  provider: "gemini",
  model: "gemini-default",
  temperature: 0.8,
  maxOutputTokens: 4000,
};

const DEFAULT_TEST_ENVIRONMENT: NodeJS.ProcessEnv = {
  GEMINI_API_KEY: "test-gemini-key",
  OPENROUTER_API_KEY: "test-openrouter-key",
  OPENAI_API_KEY: "test-openai-key",
  ANTHROPIC_API_KEY: "test-anthropic-key",
  DEEPSEEK_API_KEY: "test-deepseek-key",
};

const servers: ReturnType<typeof createDungeonWebServer>[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) =>
    new Promise<void>((resolve) => server.close(() => resolve()))));
});

async function fixtureRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "llm-dungeon-web-"));
  await mkdir(path.join(root, "config"), { recursive: true });
  await mkdir(path.join(root, "web"), { recursive: true });
  await writeFile(path.join(root, "config", "provider.json"), JSON.stringify(DEFAULT_CONFIG), "utf8");
  await writeFile(path.join(root, "config", "world.md"), "# Classic Fantasy\n", "utf8");
  await writeFile(path.join(root, "web", "index.html"), "<!doctype html><title>Dungeon</title>", "utf8");
  await writeFile(path.join(root, "web", "terminal-history.js"), "export const marker = true;\n", "utf8");
  for (const module of ["ui-copy.js", "ui-utils.js", "chat-ui.js", "inspection-ui.js", "setup-settings.js"]) {
    await writeFile(path.join(root, "web", module), `export const moduleName = ${JSON.stringify(module)};\n`, "utf8");
  }
  return root;
}

interface StartOptions {
  environment?: NodeJS.ProcessEnv;
  providerFactory?: (config: ProviderConfig, environment: NodeJS.ProcessEnv) => LlmProvider;
  maxConcurrentCampaignOperations?: number;
}

async function start(root: string, options: StartOptions = {}) {
  const environments: NodeJS.ProcessEnv[] = [];
  const server = createDungeonWebServer({
    root,
    environment: options.environment ?? DEFAULT_TEST_ENVIRONMENT,
    maxConcurrentCampaignOperations: options.maxConcurrentCampaignOperations,
    providerFactory: options.providerFactory ?? ((config, environment) => {
      environments.push(environment);
      return new WebFakeProvider(config.model);
    }),
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  const address = server.address() as AddressInfo;
  return { base: `http://127.0.0.1:${address.port}`, environments };
}

async function responseJson(base: string, route: string, method = "GET", body?: unknown): Promise<Response> {
  return fetch(`${base}${route}`, {
    method,
    ...(body === undefined
      ? {}
      : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
  });
}

async function json(base: string, route: string, method = "GET", body?: unknown): Promise<any> {
  const response = await responseJson(base, route, method, body);
  const value = await response.json();
  if (!response.ok) throw new Error(value.error);
  return value;
}

async function rawRequest(
  base: string,
  route: string,
  options: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<{ status: number; body: string }> {
  const target = new URL(route, base);
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      hostname: target.hostname,
      port: target.port,
      path: `${target.pathname}${target.search}`,
      method: options.method ?? "GET",
      headers: options.headers,
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      response.on("end", () => resolve({
        status: response.statusCode ?? 0,
        body: Buffer.concat(chunks).toString("utf8"),
      }));
    });
    request.on("error", reject);
    if (options.body) request.write(options.body);
    request.end();
  });
}

const testedModels = new Set<string>();

async function ensureModelAvailable(
  base: string,
  config: Pick<ProviderConfig, "provider" | "model">,
): Promise<void> {
  const key = `${base}\u0000${config.provider}\u0000${config.model}`;
  if (testedModels.has(key)) return;
  const result = await json(base, "/api/llm/models/test", "POST", {
    provider: config.provider,
    model: config.model,
  });
  if (!result.ok) throw new Error(result.error);
  testedModels.add(key);
}

function campaignRoute(campaignId: string, action: string): string {
  return `/api/campaigns/${encodeURIComponent(campaignId)}/${action}`;
}

async function createCampaign(
  base: string,
  overrides: Partial<{
    premise: string;
    character: string;
    language: "en" | "ru";
    worldRules: string;
    config: ProviderConfig;
  }> = {},
): Promise<{
  state: { campaignId: string; title: string; turn: number; language: string };
  config: Pick<ProviderConfig, "provider" | "model">;
}> {
  const config = overrides.config ?? DEFAULT_CONFIG;
  await ensureModelAvailable(base, config);
  const draft = await json(base, "/api/campaigns/draft", "POST", {
    premise: overrides.premise ?? "A tavern.",
    character: overrides.character ?? "A scout.",
    language: overrides.language ?? "en",
    worldRules: overrides.worldRules ?? "# Test World\n",
    config,
  });
  return json(base, "/api/campaigns/confirm", "POST", { draftId: draft.draftId });
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

describe("multi-campaign Web server", () => {
  it("serves only explicitly allowed browser assets and removes developer-only HTTP tools", async () => {
    const root = await fixtureRoot();
    const { base } = await start(root);

    const asset = await fetch(`${base}/terminal-history.js`);
    expect(asset.status).toBe(200);
    expect(asset.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
    expect(await asset.text()).toBe("export const marker = true;\n");
    for (const module of ["ui-copy.js", "ui-utils.js", "chat-ui.js", "inspection-ui.js", "setup-settings.js"]) {
      const response = await fetch(`${base}/${module}`);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
    }
    expect((await fetch(`${base}/package.json`)).status).toBe(404);
    expect((await fetch(`${base}/api/config/prompts?phase=adjudication`)).status).toBe(404);
    expect((await fetch(`${base}/api/evaluations/runs`)).status).toBe(404);
  });

  it("publishes campaign setup defaults and starts with an empty campaign catalog", async () => {
    const root = await fixtureRoot();
    const { base } = await start(root, { environment: { GEMINI_API_KEY: "test-key" } });
    const status = await json(base, "/api/status");

    expect(status.campaigns).toEqual([]);
    expect(status.defaults).toEqual({
      language: "en",
      config: { provider: DEFAULT_CONFIG.provider, model: DEFAULT_CONFIG.model },
    });
    expect(JSON.stringify(status)).not.toContain('"temperature"');
    expect(JSON.stringify(status)).not.toContain('"maxOutputTokens"');
    expect(JSON.stringify(status)).not.toContain('"endpoint"');
    expect(status.keyStatus).toEqual({
      gemini: true,
      openrouter: false,
      openai: false,
      anthropic: false,
      deepseek: false,
    });
    expect(status.llm.providers).toHaveLength(5);
    expect(status.llm.pricingBasis).toMatchObject({
      source: "OpenRouter",
      turns: 50,
      inputTokens: 480_000,
      outputTokens: 110_000,
    });
    expect(status.llm.providers.find((provider: any) => provider.id === "gemini"))
      .toMatchObject({ envKey: "GEMINI_API_KEY", recommended: true, keyPresent: true, keySource: "environment" });
    expect(status.llm.providers.filter((provider: any) => provider.recommended).map((provider: any) => provider.id))
      .toEqual(["gemini"]);
    expect(status.llm.providers.find((provider: any) => provider.id === "gemini").models
      .find((model: any) => model.id === "gemini-3.5-flash").pricing).toMatchObject({
        sourceModel: "google/gemini-3.5-flash",
        estimated50TurnsUsd: 1.71,
      });
    expect(status.llm.providers.find((provider: any) => provider.id === "gemini").models
      .find((model: any) => model.id === "gemini-3.5-flash").quality).toBe("high");
    expect(status.llm.providers.find((provider: any) => provider.id === "gemini").models
      .find((model: any) => model.id === "gemini-3.5-flash").speed).toBe("fast");
    expect(status.llm.providers.find((provider: any) => provider.id === "gemini").models
      .find((model: any) => model.id === "gemini-3.5-flash").recommended).toBe(true);
    expect(status.llm.providers.find((provider: any) => provider.id === "openrouter").models
      .map((model: any) => model.id)).toEqual([
        "moonshotai/kimi-k2.6",
        "qwen/qwen3.7-plus",
        "x-ai/grok-4.5",
      ]);
    expect(status.llm.providers.find((provider: any) => provider.id === "anthropic").models
      .map((model: any) => model.id)).toContain("claude-opus-4-8");
    expect(status.llm.providers.find((provider: any) => provider.id === "deepseek").models
      .map((model: any) => model.id)).toContain("deepseek-v4-pro");
    expect(status.languages).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "en", name: "English", setupDefaults: expect.any(Object) }),
      expect.objectContaining({ code: "ru", name: "Русский", setupDefaults: expect.any(Object) }),
    ]));
  });

  it("pre-enables the recommended Gemini model without a key but keeps it unavailable until tested", async () => {
    const root = await fixtureRoot();
    const { base } = await start(root, { environment: {} });
    const status = await json(base, "/api/status");
    const gemini = status.llm.providers.find((provider: any) => provider.id === "gemini");
    const recommended = gemini.models.find((model: any) => model.id === "gemini-3.5-flash");

    expect(gemini).toMatchObject({ recommended: true, keyPresent: false, keySource: "missing" });
    expect(recommended).toMatchObject({
      recommended: true,
      status: "untested",
      enabled: true,
      available: false,
    });
    expect(status.llm.defaultModel).toBeNull();
  });

  it("keeps multiple accepted drafts and snapshots each language, world, and model", async () => {
    const root = await fixtureRoot();
    const { base } = await start(root);
    const firstConfig = { ...DEFAULT_CONFIG, model: "model-first" };
    const secondConfig = { ...DEFAULT_CONFIG, provider: "openrouter" as const, model: "model-second" };
    await ensureModelAvailable(base, firstConfig);
    await ensureModelAvailable(base, secondConfig);
    const firstDraft = await json(base, "/api/campaigns/draft", "POST", {
      premise: "First premise",
      character: "First hero",
      language: "en",
      worldRules: "# First World\n",
      config: firstConfig,
    });
    const secondDraft = await json(base, "/api/campaigns/draft", "POST", {
      premise: "Second premise",
      character: "Second hero",
      language: "ru",
      worldRules: "# Second World\n",
      config: secondConfig,
    });

    const changedDefault = { ...DEFAULT_CONFIG, model: "changed-default" };
    await ensureModelAvailable(base, changedDefault);
    await json(base, "/api/llm/default", "PUT", {
      provider: changedDefault.provider,
      model: changedDefault.model,
    });
    const first = await json(base, "/api/campaigns/confirm", "POST", { draftId: firstDraft.draftId });
    const second = await json(base, "/api/campaigns/confirm", "POST", { draftId: secondDraft.draftId });

    expect(firstDraft.config).toEqual({ provider: firstConfig.provider, model: firstConfig.model });
    expect(secondDraft.config).toEqual({ provider: secondConfig.provider, model: secondConfig.model });
    expect(first.config).toEqual({ provider: firstConfig.provider, model: firstConfig.model });
    expect(first.state.language).toBe("en");
    expect(second.config).toEqual({ provider: secondConfig.provider, model: secondConfig.model });
    expect(second.state.language).toBe("ru");
    expect(first.state.campaignId).not.toBe(second.state.campaignId);
    const catalog = new CampaignCatalog(path.join(root, "data"), { defaultProviderConfig: DEFAULT_CONFIG });
    expect(await readFile((await catalog.openCampaign(first.state.campaignId)).currentDir + "/scenario.md", "utf8"))
      .toContain("# First World");
    expect(await readFile((await catalog.openCampaign(second.state.campaignId)).currentDir + "/scenario.md", "utf8"))
      .toContain("# Second World");
    expect(await json(base, campaignRoute(first.state.campaignId, "setup"))).toEqual({
      setup: {
        premise: "First premise",
        character: "First hero",
        language: "en",
        worldRules: "# First World",
      },
    });
    expect(await json(base, campaignRoute(second.state.campaignId, "setup"))).toEqual({
      setup: {
        premise: "Second premise",
        character: "Second hero",
        language: "ru",
        worldRules: "# Second World",
      },
    });
    const status = await json(base, "/api/status");
    expect(status.campaigns).toEqual(expect.arrayContaining([
      expect.objectContaining({
        campaignId: first.state.campaignId,
        config: { provider: firstConfig.provider, model: firstConfig.model },
        archived: false,
      }),
      expect.objectContaining({
        campaignId: second.state.campaignId,
        config: { provider: secondConfig.provider, model: secondConfig.model },
        archived: false,
      }),
    ]));
  });

  it("replays duplicate confirmations without creating duplicate campaigns", async () => {
    const root = await fixtureRoot();
    const { base } = await start(root);
    await ensureModelAvailable(base, DEFAULT_CONFIG);
    const draft = await json(base, "/api/campaigns/draft", "POST", {
      premise: "One preview",
      character: "One hero",
      language: "en",
      worldRules: "# One World\n",
      config: { provider: DEFAULT_CONFIG.provider, model: DEFAULT_CONFIG.model },
    });

    const confirmations = await Promise.all([
      responseJson(base, "/api/campaigns/confirm", "POST", { draftId: draft.draftId }),
      responseJson(base, "/api/campaigns/confirm", "POST", { draftId: draft.draftId }),
    ]);
    expect(confirmations.map((response) => response.status)).toEqual([200, 200]);
    const bodies = await Promise.all(confirmations.map((response) => response.json()));
    expect(bodies[0].state.campaignId).toBe(bodies[1].state.campaignId);
    const replay = await json(base, "/api/campaigns/confirm", "POST", { draftId: draft.draftId });
    expect(replay.state.campaignId).toBe(bodies[0].state.campaignId);
    expect((await json(base, "/api/status")).campaigns).toHaveLength(1);
    const restarted = await start(root);
    const replayAfterRestart = await json(restarted.base, "/api/campaigns/confirm", "POST", { draftId: draft.draftId });
    expect(replayAfterRestart.state.campaignId).toBe(bodies[0].state.campaignId);
    expect((await json(restarted.base, "/api/status")).campaigns).toHaveLength(1);
  });

  it("reports isolated persisted cost and the complete player-safe transcript", async () => {
    const root = await fixtureRoot();
    const { base } = await start(root);
    const campaign = await createCampaign(base);
    for (let turn = 1; turn <= 9; turn += 1) {
      await json(base, campaignRoute(campaign.state.campaignId, "play"), "POST", { action: `Action ${turn}` });
    }

    const transcript = await json(base, campaignRoute(campaign.state.campaignId, "transcript"));
    expect(transcript.playerName).toBe(setupFixture.player.name);
    expect(transcript.turns).toHaveLength(10);
    expect(transcript.turns[0]).toMatchObject({
      turn: 0,
      kind: "opening",
      generation: { provider: "fake", model: "gemini-default", costUsd: 0.0006, costBasis: "exact" },
    });
    expect(transcript.turns.at(-1)).toMatchObject({
      turn: 9,
      action: "Action 9",
      generation: { provider: "fake", model: "gemini-default", costUsd: 0.0006, costBasis: "exact" },
    });
    const status = await json(base, "/api/status");
    expect(status.campaigns[0].campaignCost).toEqual({
      totalUsd: 0.006,
      basis: "exact",
      pricedTurns: 10,
      unpricedTurns: 0,
    });
  });

  it("runs different campaigns concurrently, rejects same-campaign overlap, and enforces the global bound", async () => {
    const root = await fixtureRoot();
    const gate = deferred();
    let holdTurns = false;
    let active = 0;
    let maximumActive = 0;
    let started = 0;
    const { base } = await start(root, {
      maxConcurrentCampaignOperations: 2,
      providerFactory: (config) => new WebFakeProvider(config.model, async (request) => {
        if (!holdTurns || request.schemaName !== "turn_decision_v1") return;
        started += 1;
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await gate.promise;
        active -= 1;
      }),
    });
    const campaigns = await Promise.all([
      createCampaign(base, { config: { ...DEFAULT_CONFIG, model: "model-a" } }),
      createCampaign(base, { config: { ...DEFAULT_CONFIG, model: "model-b" } }),
      createCampaign(base, { config: { ...DEFAULT_CONFIG, model: "model-c" } }),
    ]);
    holdTurns = true;
    const requests = campaigns.map((campaign, index) =>
      responseJson(base, campaignRoute(campaign.state.campaignId, "play"), "POST", { action: `Action ${index}` }));
    await waitFor(() => started === 2);
    expect(maximumActive).toBe(2);

    const duplicate = await responseJson(
      base,
      campaignRoute(campaigns[0]!.state.campaignId, "play"),
      "POST",
      { action: "Overlapping action" },
    );
    expect(duplicate.status).toBe(409);
    const status = await json(base, "/api/status");
    expect(status.campaigns.filter((campaign: any) => campaign.busy)).toHaveLength(3);
    gate.resolve();
    const responses = await Promise.all(requests);
    expect(responses.map((response) => response.status)).toEqual([200, 200, 200]);
    expect(maximumActive).toBe(2);
    expect((await json(base, "/api/status")).campaigns.every((campaign: any) => !campaign.busy)).toBe(true);
  });

  it("keeps provider/model configuration campaign-scoped while API keys remain global and secret", async () => {
    const root = await fixtureRoot();
    const turnModels: string[] = [];
    const { base } = await start(root, {
      environment: {
        GEMINI_API_KEY: "environment-key",
        OPENROUTER_API_KEY: "openrouter-environment-key",
      },
      providerFactory: (config, environment) => new WebFakeProvider(config.model, (request) => {
        if (request.schemaName === "turn_decision_v1") {
          turnModels.push(`${config.model}:${environment.GEMINI_API_KEY ?? "missing"}`);
        }
      }),
    });
    const first = await createCampaign(base, { config: { ...DEFAULT_CONFIG, model: "model-a" } });
    const second = await createCampaign(base, { config: { ...DEFAULT_CONFIG, model: "model-b" } });
    await ensureModelAvailable(base, { ...DEFAULT_CONFIG, model: "model-c" });
    await json(base, campaignRoute(first.state.campaignId, "config"), "PUT", {
      provider: DEFAULT_CONFIG.provider,
      model: "model-c",
    });
    await json(base, campaignRoute(first.state.campaignId, "play"), "POST", { action: "First action" });
    await json(base, campaignRoute(second.state.campaignId, "play"), "POST", { action: "Second action" });

    expect(turnModels).toEqual(["model-c:environment-key", "model-b:environment-key"]);
    expect(JSON.parse(await readFile(path.join(root, "config", "provider.json"), "utf8")))
      .toMatchObject(DEFAULT_CONFIG);
    const statusText = JSON.stringify(await json(base, "/api/status"));
    expect(statusText).not.toContain("environment-key");
    const rejectedKey = await responseJson(base, campaignRoute(first.state.campaignId, "config"), "PUT", {
      ...DEFAULT_CONFIG,
      apiKey: "must-not-persist",
    });
    expect(rejectedKey.status).toBe(400);

    const staleEndpoint = await responseJson(base, campaignRoute(first.state.campaignId, "config"), "PUT", {
      ...DEFAULT_CONFIG,
      provider: "openrouter",
      model: "vendor/new-model",
      endpoint: "https://generativelanguage.googleapis.com/v1beta",
    });
    expect(staleEndpoint.status).toBe(400);
    await ensureModelAvailable(base, { provider: "openrouter", model: "vendor/new-model", temperature: 0.8, maxOutputTokens: 4000 });
    expect(await json(base, campaignRoute(first.state.campaignId, "config"), "PUT", {
      provider: "openrouter",
      model: "vendor/new-model",
    })).toMatchObject({
      config: { provider: "openrouter", model: "vendor/new-model" },
    });
  });

  it("blocks a model change while a recoverable request exists and redacts pending content", async () => {
    const root = await fixtureRoot();
    const { base } = await start(root);
    const campaign = await createCampaign(base);
    const catalog = new CampaignCatalog(path.join(root, "data"), { defaultProviderConfig: DEFAULT_CONFIG });
    const store = await catalog.openCampaign(campaign.state.campaignId);
    const privateAction = "I whisper a private plan that must not appear in status.";
    await store.setPendingRequest({ kind: "action", action: privateAction, phase: "requested" });

    const status = await json(base, "/api/status");
    expect(status.campaigns[0].pending).toEqual({ kind: "action", phase: "requested", lockedRoll: false });
    expect(JSON.stringify(status)).not.toContain(privateAction);
    const response = await responseJson(base, campaignRoute(campaign.state.campaignId, "config"), "PUT", {
      ...DEFAULT_CONFIG,
      model: "new-model",
    });
    expect(response.status).toBe(409);
    expect(await catalog.providerConfig(campaign.state.campaignId)).toEqual(DEFAULT_CONFIG);
  });

  it("archives only the selected campaign and keeps its transcript inspectable but immutable", async () => {
    const root = await fixtureRoot();
    const { base } = await start(root);
    const first = await createCampaign(base, { config: { ...DEFAULT_CONFIG, model: "model-a" } });
    const second = await createCampaign(base, { config: { ...DEFAULT_CONFIG, model: "model-b" } });
    await json(base, campaignRoute(first.state.campaignId, "archive"), "POST", {});

    const status = await json(base, "/api/status");
    expect(status.campaigns.find((item: any) => item.campaignId === first.state.campaignId).archived).toBe(true);
    expect(status.campaigns.find((item: any) => item.campaignId === second.state.campaignId).archived).toBe(false);
    expect((await json(base, campaignRoute(first.state.campaignId, "transcript"))).turns).toHaveLength(1);
    expect((await responseJson(base, campaignRoute(first.state.campaignId, "play"), "POST", { action: "Continue" })).status).toBe(409);
    expect((await responseJson(base, campaignRoute(first.state.campaignId, "config"), "PUT", DEFAULT_CONFIG)).status).toBe(409);
    expect((await responseJson(base, campaignRoute(second.state.campaignId, "play"), "POST", { action: "Continue" })).status).toBe(200);

    expect((await responseJson(base, campaignRoute(second.state.campaignId, "delete"), "DELETE", { title: second.state.title })).status).toBe(409);
    expect((await responseJson(base, campaignRoute(first.state.campaignId, "delete"), "DELETE", { title: "Wrong title" })).status).toBe(409);
    expect(await json(base, campaignRoute(first.state.campaignId, "delete"), "DELETE", { title: first.state.title })).toEqual({ deleted: true });
    expect((await json(base, "/api/status")).campaigns.some((item: any) => item.campaignId === first.state.campaignId)).toBe(false);
    expect((await fetch(`${base}${campaignRoute(first.state.campaignId, "transcript")}`)).status).toBe(404);
  });

  it("can permanently delete an archived campaign with any valid persisted title", async () => {
    const root = await fixtureRoot();
    const title = `${"Long campaign title ".repeat(600)}\r\nFinal line`;
    const setup = structuredClone(setupFixture);
    setup.campaignTitle = title;
    const catalog = new CampaignCatalog(path.join(root, "data"), { defaultProviderConfig: DEFAULT_CONFIG });
    const created = await catalog.createCampaign(
      { setup, worldRules: "# Long title test\n" },
      { providerConfig: DEFAULT_CONFIG },
    );
    await catalog.archiveCampaign(created.campaignId);
    const { base } = await start(root);

    expect(await json(base, campaignRoute(created.campaignId, "delete"), "DELETE", { title }))
      .toEqual({ deleted: true });
  });

  it("keeps turn, transcript, inspection, and export responses player-safe", async () => {
    const root = await fixtureRoot();
    const { base } = await start(root, {
      providerFactory: (config) => new SensitiveWebProvider(config.model),
    });
    const campaign = await createCampaign(base);
    const turn = await json(base, campaignRoute(campaign.state.campaignId, "play"), "POST", {
      action: "I investigate Mara's story.",
    });
    expect(turn.checkText).toContain("Investigation: d100 =");
    expect(turn).not.toHaveProperty("check");
    expect(turn).not.toHaveProperty("operations");
    expect(JSON.stringify(turn)).not.toContain(PRIVATE_CHECK_STAKE);
    expect(JSON.stringify(turn)).not.toContain(PRIVATE_OPERATION_FACT);

    const location = await json(base, campaignRoute(campaign.state.campaignId, "inspect") + "?view=location");
    expect(location.inspection).toMatchObject({ view: "location", name: "The Crooked Crown" });
    expect(location.inspection).not.toHaveProperty("present");
    expect(location.inspection).not.toHaveProperty("inventory");
    expect(JSON.stringify(location)).not.toContain("Mara Venn");
    const transcript = await json(base, campaignRoute(campaign.state.campaignId, "transcript"));
    expect(JSON.stringify(transcript)).not.toContain(PRIVATE_CHECK_STAKE);
    expect(JSON.stringify(transcript)).not.toContain(PRIVATE_OPERATION_FACT);
    const exported = await fetch(`${base}${campaignRoute(campaign.state.campaignId, "export")}?format=markdown`);
    expect(exported.status).toBe(200);
    expect(exported.headers.get("content-disposition")).toContain("attachment");
    expect(await exported.text()).not.toContain(PRIVATE_OPERATION_FACT);
  });

  it("answers explicit questions without advancing or persisting a turn", async () => {
    const root = await fixtureRoot();
    const { base } = await start(root);
    const campaign = await createCampaign(base);
    const before = await json(base, campaignRoute(campaign.state.campaignId, "transcript"));
    const answer = await json(base, campaignRoute(campaign.state.campaignId, "play"), "POST", {
      action: ":ask Can I attack three enemies and protect myself in one turn?",
    });

    expect(answer).toEqual({
      kind: "question",
      answer: "Use one primary consequential action while under immediate pressure.",
      generation: { provider: "fake", model: "gemini-default", costUsd: 0.0006, costBasis: "exact" },
    });
    expect(await json(base, campaignRoute(campaign.state.campaignId, "transcript"))).toEqual(before);
    expect((await json(base, "/api/status")).campaigns[0].turn).toBe(0);
  });

  it("migrates the legacy active save with its pending request and default model intact", async () => {
    const root = await fixtureRoot();
    const legacy = new StateStore(path.join(root, "data"));
    const state = await legacy.createGame({ setup: setupFixture, worldRules: "Legacy world." });
    const privateAction = "A private interrupted legacy action.";
    await legacy.setPendingRequest({ kind: "action", action: privateAction, phase: "requested" });
    const { base } = await start(root);

    const status = await json(base, "/api/status");
    expect(status.campaigns).toContainEqual(expect.objectContaining({
      campaignId: state.campaignId,
      archived: false,
      config: { provider: DEFAULT_CONFIG.provider, model: DEFAULT_CONFIG.model },
      pending: { kind: "action", phase: "requested", lockedRoll: false },
    }));
    expect(JSON.stringify(status)).not.toContain(privateAction);
    await expect(access(path.join(root, "data", "current"))).rejects.toThrow();
    expect(await access(path.join(campaignScopePath(path.join(root, "data"), state.campaignId), "current", "manifest.json")))
      .toBeUndefined();
  });

  it("reads provider keys only from the environment and never exposes or persists them", async () => {
    const root = await fixtureRoot();
    const environments: NodeJS.ProcessEnv[] = [];
    const { base } = await start(root, {
      environment: { GEMINI_API_KEY: "super-secret-key" },
      providerFactory: (config, environment) => {
        environments.push(environment);
        return new WebFakeProvider(config.model);
      },
    });
    const tested = await json(base, "/api/llm/models/test", "POST", {
      provider: "gemini",
      model: "gemini-default",
    });
    expect(tested.ok).toBe(true);

    const saved = [
      await readFile(path.join(root, "config", "provider.json"), "utf8"),
      await readFile(path.join(root, "config", "llm-models.json"), "utf8"),
    ].join("\n");
    expect(saved).not.toContain("super-secret-key");
    expect(environments.at(-1)?.GEMINI_API_KEY).toBe("super-secret-key");
    expect(JSON.stringify(await json(base, "/api/status"))).not.toContain("super-secret-key");
    expect((await responseJson(base, "/api/config/provider", "PUT", {
      ...DEFAULT_CONFIG,
      apiKey: "browser-key",
    })).status).toBe(404);
  });

  it("accepts an unpersisted browser session key and clears back to the environment fallback", async () => {
    const root = await fixtureRoot();
    const { base, environments } = await start(root, { environment: {} });
    const secret = "temporary-browser-secret";

    const missing = await responseJson(base, "/api/llm/models/test", "POST", {
      provider: "openai",
      model: "gpt-5.4-mini",
    });
    expect(missing.status).toBe(409);
    expect(await missing.json()).toEqual({
      error: "Configure OPENAI_API_KEY in Settings, or add it to .env and restart the server",
    });

    const saved = await json(base, "/api/llm/keys", "PUT", { provider: "openai", key: secret });
    expect(JSON.stringify(saved)).not.toContain(secret);
    expect(saved.llm.providers.find((provider: any) => provider.id === "openai"))
      .toMatchObject({ keyPresent: true, keySource: "session" });

    const tested = await json(base, "/api/llm/models/test", "POST", {
      provider: "openai",
      model: "gpt-5.4-mini",
    });
    expect(tested.ok).toBe(true);
    expect(environments.at(-1)?.OPENAI_API_KEY).toBe(secret);
    expect(await readFile(path.join(root, "config", "llm-models.json"), "utf8")).not.toContain(secret);

    const cleared = await json(base, "/api/llm/keys", "PUT", { provider: "openai", key: "" });
    expect(cleared.llm.providers.find((provider: any) => provider.id === "openai"))
      .toMatchObject({ keyPresent: false, keySource: "missing" });
  });

  it("does not carry a saved endpoint override across providers during a connection test", async () => {
    const root = await fixtureRoot();
    const configs: ProviderConfig[] = [];
    await writeFile(path.join(root, "config", "provider.json"), JSON.stringify({
      ...DEFAULT_CONFIG,
      provider: "openrouter",
      model: "vendor/old-model",
      endpoint: "https://old-provider.invalid/v1",
    }), "utf8");
    const { base } = await start(root, {
      environment: {
        GEMINI_API_KEY: "gemini-key",
        OPENROUTER_API_KEY: "openrouter-key",
      },
      providerFactory: (config) => {
        configs.push(config);
        return new WebFakeProvider(config.model);
      },
    });
    const tested = await json(base, "/api/llm/models/test", "POST", {
      provider: "gemini",
      model: "gemini-new-model",
    });
    expect(tested.ok).toBe(true);

    expect(configs.at(-1)).toEqual({
      provider: "gemini",
      model: "gemini-new-model",
      temperature: 0.8,
      maxOutputTokens: 4000,
    });
  });

  it("preserves JSON/same-origin mutation protection and returns useful campaign ID errors", async () => {
    const root = await fixtureRoot();
    const { base } = await start(root);
    const port = new URL(base).port;
    const originalWorld = await readFile(path.join(root, "config", "world.md"), "utf8");
    const reboundRead = await rawRequest(base, "/api/status", {
      headers: { Host: `attacker.example:${port}` },
    });
    expect(reboundRead.status).toBe(421);
    const reboundMutation = await rawRequest(base, "/api/config/world", {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Host: `attacker.example:${port}`,
        Origin: `http://attacker.example:${port}`,
        "Sec-Fetch-Site": "same-origin",
      },
      body: JSON.stringify({ markdown: "# Rebound overwrite" }),
    });
    expect(reboundMutation.status).toBe(421);
    expect(await readFile(path.join(root, "config", "world.md"), "utf8")).toBe(originalWorld);
    expect((await rawRequest(base, "/api/status", {
      headers: { Host: `localhost:${port}` },
    })).status).toBe(200);
    const foreign = await fetch(`${base}/api/config/world`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Origin: "https://malicious.example" },
      body: JSON.stringify({ markdown: "# Cross-site overwrite" }),
    });
    expect(foreign.status).toBe(403);
    const simple = await fetch(`${base}/api/config/world`, {
      method: "PUT",
      headers: { "Content-Type": "text/plain" },
      body: JSON.stringify({ markdown: "# Simple overwrite" }),
    });
    expect(simple.status).toBe(415);
    const unsafeDelete = await fetch(`${base}/api/campaigns/${encodeURIComponent("campaign:missing")}/delete`, {
      method: "DELETE",
      headers: { "Content-Type": "text/plain" },
      body: "{}",
    });
    expect(unsafeDelete.status).toBe(415);

    expect((await fetch(`${base}/api/campaigns/not-safe/transcript`)).status).toBe(400);
    expect((await fetch(`${base}/api/campaigns/${encodeURIComponent("campaign:missing")}/transcript`)).status).toBe(404);
    const traversal = await fetch(`${base}/api/campaigns/${encodeURIComponent("campaign:../../secret")}/transcript`);
    expect(traversal.status).toBe(400);
  });

  it("redacts and caps unexpected errors at the final browser boundary", async () => {
    const root = await fixtureRoot();
    const secret = "unexpected-secret+/=";
    const { base } = await start(root, {
      environment: { GEMINI_API_KEY: secret, ANTHROPIC_API_KEY: "\ud800" },
      providerFactory: (config) => new WebFakeProvider(config.model, (request) => {
        if (request.schemaName === "campaign_setup") {
          throw new Error([
            secret,
            encodeURIComponent(secret),
            root,
            "internal detail ".repeat(80),
          ].join("\n"));
        }
      }),
    });
    await ensureModelAvailable(base, DEFAULT_CONFIG);

    const failure = await responseJson(base, "/api/campaigns/draft", "POST", {
      premise: "A tavern.",
      character: "A scout.",
      language: "en",
      worldRules: "# Test World\n",
      config: DEFAULT_CONFIG,
    });
    expect(failure.status).toBe(400);
    const body = await failure.json() as { error: string };
    expect(body.error).toContain("[redacted]");
    expect(body.error).toContain("[project]");
    expect(body.error).not.toContain(secret);
    expect(body.error).not.toContain(encodeURIComponent(secret));
    expect(body.error).not.toContain("\n");
    expect(body.error.length).toBeLessThanOrEqual(500);

    const modelCatalog = new LlmModelCatalog(root, {
      testFingerprint: PROVIDER_COMPATIBILITY_FINGERPRINT,
    });
    await modelCatalog.recordTestFailure({
      provider: DEFAULT_CONFIG.provider,
      model: DEFAULT_CONFIG.model,
    }, {
      failureSummary: [
        root,
        encodeURIComponent(secret),
        "https://user:private@example.invalid/v1?token=private#details",
      ].join(" "),
    });
    const status = await json(base, "/api/status");
    const storedError = status.llm.providers
      .find((provider: any) => provider.id === DEFAULT_CONFIG.provider).models
      .find((model: any) => model.id === DEFAULT_CONFIG.model).error as string;
    expect(storedError).toContain("[project]");
    expect(storedError).toContain("?[redacted]");
    for (const hidden of [root, encodeURIComponent(secret), "user", "private", "token=private"]) {
      expect(storedError).not.toContain(hidden);
    }

    const missingAsset = await fetch(`${base}/styles.css`);
    const missingBody = await missingAsset.json() as { error: string };
    expect(missingBody.error).toContain("[project]");
    expect(missingBody.error).not.toContain(root);
  });

  it("projects internal provider configuration out of every status response", async () => {
    const root = await fixtureRoot();
    const internalConfig: ProviderConfig = {
      ...DEFAULT_CONFIG,
      model: "m".repeat(301),
      endpoint: "https://user:private@example.invalid/v1?token=private",
    };
    await writeFile(path.join(root, "config", "provider.json"), JSON.stringify(internalConfig), "utf8");
    const catalog = new CampaignCatalog(path.join(root, "data"), { defaultProviderConfig: internalConfig });
    const created = await catalog.createCampaign(
      { setup: setupFixture, worldRules: "# Internal config test\n" },
      { providerConfig: internalConfig },
    );
    const { base } = await start(root);

    const status = await json(base, "/api/status");
    const selection = { provider: internalConfig.provider, model: internalConfig.model };
    expect(status.config).toEqual(selection);
    expect(status.defaults.config).toEqual(selection);
    expect(status.campaigns.find((campaign: any) => campaign.campaignId === created.campaignId).config)
      .toEqual(selection);
    const serialized = JSON.stringify(status);
    for (const hidden of ["temperature", "maxOutputTokens", "endpoint", "user:private", "token=private"]) {
      expect(serialized).not.toContain(hidden);
    }
  });
});
