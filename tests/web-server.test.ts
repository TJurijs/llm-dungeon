import { existsSync } from "node:fs";
import { access, mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { CampaignCatalog } from "../src/campaign-catalog.js";
import { PROVIDER_COMPATIBILITY_FINGERPRINT } from "../src/connection-probe.js";
import { LlmModelCatalog, type LlmProviderId } from "../src/llm-model-catalog.js";
import type { ProviderConnectionResult } from "../src/provider-connection.js";
import { ModelAssessmentCatalog } from "../src/model-assessment-catalog.js";
import { MODEL_EXECUTION_ADAPTER_REVISION } from "../src/model-execution-profile.js";
import { campaignScopePath } from "../src/persistence/campaign-catalog.js";
import { withSerializedFileLock } from "../src/persistence/lock.js";
import { createDungeonWebServer } from "../src/web-server.js";
import { StateStore } from "../src/store.js";
import type { ProviderConfig } from "../src/schemas.js";
import type { LlmProvider, StructuredRequest, StructuredResult } from "../src/types.js";
import { setupFixture } from "./helpers.js";

type RequestHook = (request: StructuredRequest<unknown>, model: string) => void | Promise<void>;

const COMPLETED_STORY_FIXTURE = Array.from(
  { length: 420 },
  (_, index) => `chronicle${index + 1}`,
).join(" ");

class WebFakeProvider implements LlmProvider {
  readonly id = "fake";

  constructor(
    readonly model: string,
    private readonly hook: RequestHook = () => undefined,
  ) {}

  async generateStructured<T>(request: StructuredRequest<T>): Promise<StructuredResult<T>> {
    await this.hook(request as StructuredRequest<unknown>, this.model);
    let data: unknown;
    if (request.schemaName === "campaign_setup") {
      data = structuredClone(setupFixture);
      (data as typeof setupFixture).campaignTitle = `Campaign ${this.model}`;
    } else if (request.schemaName.startsWith("connection_campaign_setup_")) {
      data = JSON.parse(request.prompt.slice(request.prompt.indexOf("{")));
    } else if (request.schemaName.startsWith("connection_gameplay_contract_v3_")) {
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
    } else if (request.schemaName === "completed_campaign_story_v1") {
      data = { story: COMPLETED_STORY_FIXTURE };
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
  override async generateStructured<T>(
    request: StructuredRequest<T>,
  ): Promise<StructuredResult<T>> {
    if (request.schemaName === "turn_decision_v3") {
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
    if (request.schemaName === "turn_resolution_v3") {
      return {
        data: request.schema.parse({
          narration: "Mara gives you a guarded but useful answer.",
          turnSummary: "Mara supplied a guarded clue.",
          operations: [
            {
              type: "add_fact",
              targetId: "npc:mara-venn",
              section: "secrets",
              text: PRIVATE_OPERATION_FACT,
            },
          ],
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
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
});

async function fixtureRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "llm-dungeon-web-"));
  await mkdir(path.join(root, "config"), { recursive: true });
  await mkdir(path.join(root, "web"), { recursive: true });
  await writeFile(
    path.join(root, "config", "provider.json"),
    JSON.stringify(DEFAULT_CONFIG),
    "utf8",
  );
  await writeFile(path.join(root, "config", "world.md"), "# Classic Fantasy\n", "utf8");
  await writeFile(
    path.join(root, "web", "index.html"),
    "<!doctype html><title>Dungeon</title>",
    "utf8",
  );
  await writeFile(
    path.join(root, "web", "terminal-history.js"),
    "export const marker = true;\n",
    "utf8",
  );
  for (const module of [
    "ui-copy.js",
    "ui-utils.js",
    "chat-ui.js",
    "campaign-state.js",
    "inspection-ui.js",
    "setup-settings.js",
  ]) {
    await writeFile(
      path.join(root, "web", module),
      `export const moduleName = ${JSON.stringify(module)};\n`,
      "utf8",
    );
  }
  return root;
}

interface StartOptions {
  environment?: NodeJS.ProcessEnv;
  providerFactory?: (config: ProviderConfig, environment: NodeJS.ProcessEnv) => LlmProvider;
  maxConcurrentCampaignOperations?: number;
  openAiModelsFetcher?: ((apiKey: string) => Promise<ReadonlySet<string>>) | false;
  openAiModelsTimeoutMs?: number;
  connectionTester?: (provider: LlmProviderId, apiKey: string) => Promise<ProviderConnectionResult>;
}

async function start(root: string, options: StartOptions = {}) {
  const environments: NodeJS.ProcessEnv[] = [];
  const server = createDungeonWebServer({
    root,
    environment: options.environment ?? DEFAULT_TEST_ENVIRONMENT,
    maxConcurrentCampaignOperations: options.maxConcurrentCampaignOperations,
    openAiModelsFetcher: options.openAiModelsFetcher ?? false,
    ...(options.openAiModelsTimeoutMs === undefined
      ? {}
      : { openAiModelsTimeoutMs: options.openAiModelsTimeoutMs }),
    ...(options.connectionTester === undefined
      ? {}
      : { connectionTester: options.connectionTester }),
    providerFactory:
      options.providerFactory ??
      ((config, environment) => {
        environments.push(environment);
        return new WebFakeProvider(config.model);
      }),
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  const address = server.address() as AddressInfo;
  return { base: `http://127.0.0.1:${address.port}`, environments };
}

async function responseJson(
  base: string,
  route: string,
  method = "GET",
  body?: unknown,
): Promise<Response> {
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

async function bodylessJsonMutation(base: string, route: string): Promise<Response> {
  return fetch(`${base}${route}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
  });
}

async function rawRequest(
  base: string,
  route: string,
  options: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<{ status: number; body: string }> {
  const target = new URL(route, base);
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        hostname: target.hostname,
        port: target.port,
        path: `${target.pathname}${target.search}`,
        method: options.method ?? "GET",
        headers: options.headers,
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        response.on("end", () =>
          resolve({
            status: response.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    request.on("error", reject);
    if (options.body) request.write(options.body);
    request.end();
  });
}

const testedModels = new Set<string>();

async function ensureModelAvailable(
  base: string,
  config: Pick<ProviderConfig, "provider" | "model">,
  language: "en" | "ru" = "en",
): Promise<void> {
  const key = `${base}\u0000${config.provider}\u0000${config.model}\u0000${language}`;
  if (testedModels.has(key)) return;
  const result = await json(base, "/api/llm/models/test", "POST", {
    provider: config.provider,
    model: config.model,
    language,
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
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
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
    for (const module of [
      "ui-copy.js",
      "ui-utils.js",
      "chat-ui.js",
      "campaign-state.js",
      "inspection-ui.js",
      "setup-settings.js",
    ]) {
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
      xai: false,
      openai: false,
      anthropic: false,
      deepseek: false,
    });
    expect(status.llm.providers.map((provider: any) => provider.id)).toEqual([
      "gemini",
      "openrouter",
      "xai",
      "openai",
      "anthropic",
      "deepseek",
    ]);
    expect(status.llm.pricingBasis).toMatchObject({
      source: "OpenRouter",
      turns: 50,
      inputTokens: 480_000,
      outputTokens: 110_000,
    });
    expect(status.llm.providers.find((provider: any) => provider.id === "gemini")).toMatchObject({
      envKey: "GEMINI_API_KEY",
      recommended: true,
      keyPresent: true,
      keySource: "environment",
    });
    expect(
      status.llm.providers
        .filter((provider: any) => provider.recommended)
        .map((provider: any) => provider.id),
    ).toEqual(["gemini"]);
    expect(
      status.llm.providers
        .find((provider: any) => provider.id === "anthropic")
        .models.map((model: any) => model.id),
    ).toEqual(["claude-sonnet-5"]);
    expect(
      status.llm.providers
        .find((provider: any) => provider.id === "gemini")
        .models.map((model: any) => model.id),
    ).toEqual(["gemini-3.6-flash", "gemini-3.5-flash-lite"]);
    expect(
      status.llm.providers
        .find((provider: any) => provider.id === "openrouter")
        .models.map((model: any) => model.id),
    ).toEqual(["qwen/qwen3.7-plus", "moonshotai/kimi-k3"]);
    expect(
      status.llm.providers
        .find((provider: any) => provider.id === "xai")
        .models.map((model: any) => model.id),
    ).toEqual(["grok-4.5"]);
    expect(
      status.llm.providers
        .find((provider: any) => provider.id === "openai")
        .models.map((model: any) => model.id),
    ).toEqual(["gpt-5.4"]);
    expect(
      status.llm.providers
        .find((provider: any) => provider.id === "deepseek")
        .models.map((model: any) => model.id),
    ).toEqual(["deepseek-v4-flash", "deepseek-v4-pro"]);
    expect(status.languages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "en", name: "English", setupDefaults: expect.any(Object) }),
        expect.objectContaining({ code: "ru", name: "Русский", setupDefaults: expect.any(Object) }),
      ]),
    );
  });

  it("reads and explicitly generates a player-safe story only after campaign completion", async () => {
    const root = await fixtureRoot();
    const catalog = new CampaignCatalog(path.join(root, "data"), {
      defaultProviderConfig: DEFAULT_CONFIG,
    });
    const created = await catalog.createCampaign(
      {
        setup: { ...structuredClone(setupFixture), campaignTitle: "Completed Chronicle" },
        worldRules: "# Test World\n",
        language: "en",
      },
      { providerConfig: DEFAULT_CONFIG },
    );
    let storyCalls = 0;
    const { base } = await start(root, {
      providerFactory: (config) =>
        new WebFakeProvider(config.model, (request) => {
          if (request.schemaName === "completed_campaign_story_v1") storyCalls += 1;
        }),
    });
    const route = campaignRoute(created.campaignId, "story");

    expect(await json(base, route)).toEqual({ status: "missing" });
    const activeResponse = await bodylessJsonMutation(base, route);
    expect(activeResponse.status).toBe(409);
    expect(await activeResponse.json()).toEqual({
      error: "Finish or archive the campaign before generating its short story",
    });
    expect(storyCalls).toBe(0);

    await created.store.commitTurn({
      action: "I accept the final page.",
      resolved: {
        narration: "The road ends beneath a clear dawn.",
        turnSummary: "The campaign reached its ending.",
        operations: [{ type: "end_campaign", status: "ended", reason: "The quest is complete." }],
      },
      provider: "fake",
      model: "fake-model",
    });
    const before = await created.store.campaignLogSnapshot();

    const generatedResponse = await bodylessJsonMutation(base, route);
    expect(generatedResponse.status).toBe(200);
    const generated = await generatedResponse.json();
    expect(generated).toMatchObject({
      status: "ready",
      story: COMPLETED_STORY_FIXTURE,
      sourceTurn: 1,
    });
    expect(generated.generatedAt).toEqual(expect.any(String));
    expect(JSON.stringify(generated)).not.toMatch(/provider|model|usage/i);
    expect(storyCalls).toBe(1);
    expect(await json(base, route)).toEqual(generated);

    const idempotentResponse = await bodylessJsonMutation(base, route);
    expect(await idempotentResponse.json()).toEqual(generated);
    expect(storyCalls).toBe(1);
    const after = await created.store.campaignLogSnapshot();
    expect(after.state).toEqual(before.state);
    expect(after.turns).toEqual(before.turns);
  });

  it("generates a settled story for an archived active campaign without resuming gameplay", async () => {
    const root = await fixtureRoot();
    const catalog = new CampaignCatalog(path.join(root, "data"), {
      defaultProviderConfig: DEFAULT_CONFIG,
    });
    const created = await catalog.createCampaign(
      {
        setup: { ...structuredClone(setupFixture), campaignTitle: "Archived Chronicle" },
        worldRules: "# Test World\n",
        language: "en",
      },
      { providerConfig: DEFAULT_CONFIG },
    );
    await catalog.archiveCampaign(created.campaignId);
    const readable = await catalog.readCampaign(created.campaignId);
    const before = await readable.campaignLogSnapshot();
    const { base } = await start(root);
    const route = campaignRoute(created.campaignId, "story");

    const response = await bodylessJsonMutation(base, route);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      status: "ready",
      story: COMPLETED_STORY_FIXTURE,
      sourceTurn: 0,
    });
    const after = await readable.campaignLogSnapshot();
    expect(after.state).toEqual(before.state);
    expect(after.turns).toEqual(before.turns);
    expect(after.completedStory).toMatchObject({
      provider: "fake",
      model: DEFAULT_CONFIG.model,
      story: COMPLETED_STORY_FIXTURE,
    });
  });

  it("ships the recommended Gemini model as the default independently of key presence", async () => {
    const root = await fixtureRoot();
    const { base } = await start(root, { environment: {} });
    const status = await json(base, "/api/status");
    const gemini = status.llm.providers.find((provider: any) => provider.id === "gemini");
    const recommended = gemini.models.find((model: any) => model.id === "gemini-3.6-flash");

    expect(gemini).toMatchObject({ recommended: true, keyPresent: false, keySource: "missing" });
    // A protocol change retires shipped compatibility evidence: the browser
    // must show the recommended default awaiting a fresh probe rather than
    // claiming results from a schema that no longer exists.
    expect(recommended).toMatchObject({
      recommended: true,
      known: true,
      compatibilityStatus: "untested",
      enabled: true,
      available: false,
      adapterStatus: "uncalibrated",
      recommendationEligibility: {
        eligible: true,
        reasons: ["product_recommended_default"],
      },
      evidence: {
        compatibility: null,
        assessment: expect.arrayContaining([expect.objectContaining({ source: "calibration" })]),
      },
    });
    expect(status.llm.defaultModel).toEqual({ provider: "gemini", model: "gemini-3.6-flash" });
  });

  it("projects calibration evidence without letting the browser rewrite it", async () => {
    const root = await fixtureRoot();
    const assessments = new ModelAssessmentCatalog(root);
    const profileFingerprint = "a".repeat(64);
    const calibrationEvidence = {
      source: "calibration" as const,
      reference: "calibration-run-qwen",
      packageId: "calibration-v1",
      packageVersion: "1",
      executionProfileFingerprint: profileFingerprint,
      recordedAt: "2026-07-19T08:00:00.000Z",
    };
    await assessments.recordCalibration({
      provider: "openrouter",
      model: "qwen/qwen3.7-plus",
      route: "openrouter",
      status: "calibrated",
      adapterRevision: MODEL_EXECUTION_ADAPTER_REVISION,
      profileFingerprint,
      evidence: calibrationEvidence,
    });
    const assessmentPath = path.join(root, "config", "model-assessments.json");
    const before = await readFile(assessmentPath, "utf8");
    const { base } = await start(root);

    const status = await json(base, "/api/status");
    const qwen = status.llm.providers
      .find((provider: any) => provider.id === "openrouter")
      .models.find((candidate: any) => candidate.id === "qwen/qwen3.7-plus");
    expect(qwen).toMatchObject({
      adapterStatus: "calibrated",
      recommendationEligibility: { eligible: true, reasons: [] },
      evidence: {
        assessment: expect.arrayContaining([calibrationEvidence]),
        profileFingerprint,
      },
    });
    // Reading status must never write to the durable catalog.
    expect(await readFile(assessmentPath, "utf8")).toBe(before);
  });

  it("keeps an existing Anthropic campaign playable while still blocking its retired model from new selection", async () => {
    const root = await fixtureRoot();
    const legacyConfig: ProviderConfig = {
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      temperature: 0.8,
      maxOutputTokens: 4_000,
    };
    const catalog = new CampaignCatalog(path.join(root, "data"));
    const created = await catalog.createCampaign(
      { setup: setupFixture, worldRules: "Legacy campaign rules." },
      { providerConfig: legacyConfig },
    );
    const usedModels: string[] = [];
    const { base } = await start(root, {
      environment: { ANTHROPIC_API_KEY: "legacy-anthropic-key" },
      providerFactory: (config) => {
        usedModels.push(`${config.provider}/${config.model}`);
        return new WebFakeProvider(config.model);
      },
    });

    const status = await json(base, "/api/status");
    expect(status.llm.providers.some((provider: any) => provider.id === "anthropic")).toBe(true);
    expect(status.campaigns).toContainEqual(
      expect.objectContaining({
        campaignId: created.campaignId,
        config: { provider: "anthropic", model: "claude-sonnet-4-6" },
      }),
    );
    expect(
      (
        await responseJson(base, campaignRoute(created.campaignId, "play"), "POST", {
          action: "Continue the legacy campaign.",
        })
      ).status,
    ).toBe(200);
    expect(usedModels).toContain("anthropic/claude-sonnet-4-6");

    const addRetired = await responseJson(base, "/api/llm/models", "POST", {
      provider: "anthropic",
      model: "claude-sonnet-4-6",
    });
    expect(addRetired.status).toBe(400);
    expect(await addRetired.json()).toMatchObject({
      error: expect.stringContaining("legacy use only"),
    });
  });

  it("keeps multiple accepted drafts and snapshots each language, world, and model", async () => {
    const root = await fixtureRoot();
    const { base } = await start(root);
    const firstConfig = { ...DEFAULT_CONFIG, model: "model-first" };
    const secondConfig = {
      ...DEFAULT_CONFIG,
      provider: "openrouter" as const,
      model: "model-second",
    };
    await ensureModelAvailable(base, firstConfig);
    await ensureModelAvailable(base, secondConfig, "ru");
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
    const first = await json(base, "/api/campaigns/confirm", "POST", {
      draftId: firstDraft.draftId,
    });
    const second = await json(base, "/api/campaigns/confirm", "POST", {
      draftId: secondDraft.draftId,
    });

    expect(firstDraft.config).toEqual({ provider: firstConfig.provider, model: firstConfig.model });
    expect(secondDraft.config).toEqual({
      provider: secondConfig.provider,
      model: secondConfig.model,
    });
    expect(first.config).toEqual({ provider: firstConfig.provider, model: firstConfig.model });
    expect(first.state.language).toBe("en");
    expect(second.config).toEqual({ provider: secondConfig.provider, model: secondConfig.model });
    expect(second.state.language).toBe("ru");
    expect(first.state.campaignId).not.toBe(second.state.campaignId);
    const catalog = new CampaignCatalog(path.join(root, "data"), {
      defaultProviderConfig: DEFAULT_CONFIG,
    });
    expect(
      await readFile(
        (await catalog.openCampaign(first.state.campaignId)).currentDir + "/scenario.md",
        "utf8",
      ),
    ).toContain("# First World");
    expect(
      await readFile(
        (await catalog.openCampaign(second.state.campaignId)).currentDir + "/scenario.md",
        "utf8",
      ),
    ).toContain("# Second World");
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
    expect(status.campaigns).toEqual(
      expect.arrayContaining([
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
      ]),
    );
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
    const draftRoot = path.join(root, "data", ".drafts", `draft:${draft.draftId}`);
    expect(existsSync(draftRoot)).toBe(true);
    expect(await new StateStore(draftRoot).campaignBudget()).toMatchObject({
      spentUsd: 0.0006,
      settledAttempts: 1,
    });

    const confirmations = await Promise.all([
      responseJson(base, "/api/campaigns/confirm", "POST", { draftId: draft.draftId }),
      responseJson(base, "/api/campaigns/confirm", "POST", { draftId: draft.draftId }),
    ]);
    expect(confirmations.map((response) => response.status)).toEqual([200, 200]);
    const bodies = await Promise.all(confirmations.map((response) => response.json()));
    expect(bodies[0].state.campaignId).toBe(bodies[1].state.campaignId);
    expect(existsSync(draftRoot)).toBe(false);
    const acceptedStore = await new CampaignCatalog(path.join(root, "data")).openCampaign(
      bodies[0].state.campaignId,
    );
    expect(await acceptedStore.campaignBudget()).toMatchObject({
      spentUsd: 0.0006,
      settledAttempts: 1,
    });
    const acceptedAttempts = (
      await readFile(path.join(acceptedStore.dataRoot, "spending-attempts.jsonl"), "utf8")
    )
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(acceptedAttempts).toEqual([
      expect.objectContaining({ lane: "setup", schemaName: "campaign_setup", costUsd: 0.0006 }),
    ]);
    const replay = await json(base, "/api/campaigns/confirm", "POST", { draftId: draft.draftId });
    expect(replay.state.campaignId).toBe(bodies[0].state.campaignId);
    expect((await json(base, "/api/status")).campaigns).toHaveLength(1);
    const restarted = await start(root);
    const replayAfterRestart = await json(restarted.base, "/api/campaigns/confirm", "POST", {
      draftId: draft.draftId,
    });
    expect(replayAfterRestart.state.campaignId).toBe(bodies[0].state.campaignId);
    expect((await json(restarted.base, "/api/status")).campaigns).toHaveLength(1);
  });

  it("reports isolated persisted cost and the complete player-safe transcript", async () => {
    const root = await fixtureRoot();
    const { base } = await start(root);
    const campaign = await createCampaign(base);
    for (let turn = 1; turn <= 9; turn += 1) {
      await json(base, campaignRoute(campaign.state.campaignId, "play"), "POST", {
        action: `Action ${turn}`,
      });
    }

    const transcript = await json(base, campaignRoute(campaign.state.campaignId, "transcript"));
    expect(transcript.playerName).toBe(setupFixture.player.name);
    expect(transcript.turns).toHaveLength(10);
    expect(transcript.turns[0]).toMatchObject({
      turn: 0,
      kind: "opening",
      generation: {
        provider: "fake",
        model: "gemini-default",
        costUsd: 0.0006,
        costBasis: "exact",
      },
    });
    expect(transcript.turns.at(-1)).toMatchObject({
      turn: 9,
      action: "Action 9",
      generation: {
        provider: "fake",
        model: "gemini-default",
        costUsd: 0.0006,
        costBasis: "exact",
      },
    });
    const status = await json(base, "/api/status");
    expect(status.campaigns[0].campaignCost).toEqual({
      totalUsd: 0.006,
      basis: "exact",
      pricedTurns: 10,
      unpricedTurns: 0,
    });
  });

  it("updates operational spending limits for archives while keeping their narrative immutable", async () => {
    const root = await fixtureRoot();
    const { base } = await start(root);
    const campaign = await createCampaign(base);
    const route = campaignRoute(campaign.state.campaignId, "budget");

    expect(await json(base, route)).toMatchObject({
      budget: {
        limits: { campaignUsd: null, logicalTurnUsd: null },
        spentUsd: expect.any(Number),
        reservedUsd: expect.any(Number),
        paused: false,
      },
    });
    const updated = await json(base, route, "PUT", {
      campaignUsd: 10,
      logicalTurnUsd: 0.5,
    });
    expect(updated.budget.limits).toEqual({ campaignUsd: 10, logicalTurnUsd: 0.5 });
    expect((await json(base, "/api/status")).campaigns[0].budget.limits).toEqual({
      campaignUsd: 10,
      logicalTurnUsd: 0.5,
    });
    expect((await responseJson(base, route, "PUT", { campaignUsd: 0 })).status).toBe(400);

    await json(base, campaignRoute(campaign.state.campaignId, "archive"), "POST", {});
    expect((await json(base, route)).budget.limits).toEqual({
      campaignUsd: 10,
      logicalTurnUsd: 0.5,
    });
    const archivedUpdate = await json(base, route, "PUT", {
      campaignUsd: null,
      logicalTurnUsd: 1,
    });
    expect(archivedUpdate.budget.limits).toEqual({ campaignUsd: null, logicalTurnUsd: 1 });
    expect((await json(base, route)).budget.limits).toEqual({
      campaignUsd: null,
      logicalTurnUsd: 1,
    });
    expect(
      (
        await responseJson(base, campaignRoute(campaign.state.campaignId, "play"), "POST", {
          action: "Continue the archived story",
        })
      ).status,
    ).toBe(409);
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
      providerFactory: (config) =>
        new WebFakeProvider(config.model, async (request) => {
          if (!holdTurns || request.schemaName !== "turn_decision_v3") return;
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
      responseJson(base, campaignRoute(campaign.state.campaignId, "play"), "POST", {
        action: `Action ${index}`,
      }),
    );
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
    expect(
      (await json(base, "/api/status")).campaigns.every((campaign: any) => !campaign.busy),
    ).toBe(true);
  });

  it("keeps provider/model configuration campaign-scoped while API keys remain global and secret", async () => {
    const root = await fixtureRoot();
    const turnModels: string[] = [];
    const { base } = await start(root, {
      environment: {
        GEMINI_API_KEY: "environment-key",
        OPENROUTER_API_KEY: "openrouter-environment-key",
      },
      providerFactory: (config, environment) =>
        new WebFakeProvider(config.model, (request) => {
          if (request.schemaName === "turn_decision_v3") {
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
    await json(base, campaignRoute(first.state.campaignId, "play"), "POST", {
      action: "First action",
    });
    await json(base, campaignRoute(second.state.campaignId, "play"), "POST", {
      action: "Second action",
    });

    expect(turnModels).toEqual(["model-c:environment-key", "model-b:environment-key"]);
    expect(
      JSON.parse(await readFile(path.join(root, "config", "provider.json"), "utf8")),
    ).toMatchObject(DEFAULT_CONFIG);
    const statusText = JSON.stringify(await json(base, "/api/status"));
    expect(statusText).not.toContain("environment-key");
    const rejectedKey = await responseJson(
      base,
      campaignRoute(first.state.campaignId, "config"),
      "PUT",
      {
        ...DEFAULT_CONFIG,
        apiKey: "must-not-persist",
      },
    );
    expect(rejectedKey.status).toBe(400);

    const staleEndpoint = await responseJson(
      base,
      campaignRoute(first.state.campaignId, "config"),
      "PUT",
      {
        ...DEFAULT_CONFIG,
        provider: "openrouter",
        model: "vendor/new-model",
        endpoint: "https://generativelanguage.googleapis.com/v1beta",
      },
    );
    expect(staleEndpoint.status).toBe(400);
    await ensureModelAvailable(base, {
      provider: "openrouter",
      model: "vendor/new-model",
      temperature: 0.8,
      maxOutputTokens: 4000,
    });
    expect(
      await json(base, campaignRoute(first.state.campaignId, "config"), "PUT", {
        provider: "openrouter",
        model: "vendor/new-model",
      }),
    ).toMatchObject({
      config: { provider: "openrouter", model: "vendor/new-model" },
    });
  });

  it("blocks a model change while a recoverable request exists and redacts pending content", async () => {
    const root = await fixtureRoot();
    const { base } = await start(root);
    const campaign = await createCampaign(base);
    const catalog = new CampaignCatalog(path.join(root, "data"), {
      defaultProviderConfig: DEFAULT_CONFIG,
    });
    const store = await catalog.openCampaign(campaign.state.campaignId);
    const privateAction = "I whisper a private plan that must not appear in status.";
    await store.setPendingRequest({ kind: "action", action: privateAction, phase: "requested" });

    const status = await json(base, "/api/status");
    expect(status.campaigns[0].pending).toEqual({
      kind: "action",
      phase: "requested",
      lockedRoll: false,
    });
    expect(JSON.stringify(status)).not.toContain(privateAction);
    const response = await responseJson(
      base,
      campaignRoute(campaign.state.campaignId, "config"),
      "PUT",
      {
        ...DEFAULT_CONFIG,
        model: "new-model",
      },
    );
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
    expect(
      status.campaigns.find((item: any) => item.campaignId === first.state.campaignId).archived,
    ).toBe(true);
    expect(
      status.campaigns.find((item: any) => item.campaignId === second.state.campaignId).archived,
    ).toBe(false);
    expect(
      (await json(base, campaignRoute(first.state.campaignId, "transcript"))).turns,
    ).toHaveLength(1);
    expect(
      (
        await responseJson(base, campaignRoute(first.state.campaignId, "play"), "POST", {
          action: "Continue",
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await responseJson(
          base,
          campaignRoute(first.state.campaignId, "config"),
          "PUT",
          DEFAULT_CONFIG,
        )
      ).status,
    ).toBe(409);
    expect(
      (
        await responseJson(base, campaignRoute(second.state.campaignId, "play"), "POST", {
          action: "Continue",
        })
      ).status,
    ).toBe(200);

    expect(
      (
        await responseJson(base, campaignRoute(second.state.campaignId, "delete"), "DELETE", {
          title: second.state.title,
        })
      ).status,
    ).toBe(409);
    expect(
      (await responseJson(base, campaignRoute(first.state.campaignId, "delete"), "DELETE", {}))
        .status,
    ).toBe(409);
    expect(
      (
        await responseJson(base, campaignRoute(first.state.campaignId, "delete"), "DELETE", {
          title: "Wrong title",
        })
      ).status,
    ).toBe(409);
    expect(
      await json(base, campaignRoute(first.state.campaignId, "delete"), "DELETE", {
        title: first.state.title,
      }),
    ).toEqual({ deleted: true });
    expect(
      (await json(base, "/api/status")).campaigns.some(
        (item: any) => item.campaignId === first.state.campaignId,
      ),
    ).toBe(false);
    expect(
      (await fetch(`${base}${campaignRoute(first.state.campaignId, "transcript")}`)).status,
    ).toBe(404);
  });

  it("deletes an archived autoplay publication without accepting a title-confirmation bypass", async () => {
    const root = await fixtureRoot();
    const sourceRoot = path.join(root, "playtests", "runs", "autoplay-delete", "campaign");
    const source = new StateStore(sourceRoot);
    await source.createGame({
      setup: { ...structuredClone(setupFixture), campaignTitle: "Disposable Autoplay" },
      worldRules: "Autoplay deletion fixture rules.",
      language: "en",
    });
    const catalog = new CampaignCatalog(path.join(root, "data"));
    const published = await catalog.publishArchivedCampaign(sourceRoot, {
      source: {
        kind: "autoplay",
        runId: "autoplay-delete",
        jobId: "job-001",
        packageId: "campaign-autoplay-v1",
        packageVersion: 1,
      },
      tags: ["Autoplay"],
      providerConfig: DEFAULT_CONFIG,
    });
    const { base } = await start(root);

    expect((await json(base, "/api/status")).campaigns).toContainEqual(
      expect.objectContaining({
        campaignId: published.campaignId,
        archived: true,
        deleteRequiresTitleConfirmation: false,
      }),
    );
    expect(await json(base, campaignRoute(published.campaignId, "delete"), "DELETE", {})).toEqual({
      deleted: true,
    });
    expect(
      (await json(base, "/api/status")).campaigns.some(
        (campaign: { campaignId: string }) => campaign.campaignId === published.campaignId,
      ),
    ).toBe(false);
  });

  it("renames a started campaign and rejects invalid or archived renames", async () => {
    const root = await fixtureRoot();
    const { base } = await start(root);
    const created = await createCampaign(base);
    const route = campaignRoute(created.state.campaignId, "title");

    expect(await json(base, route, "PUT", { title: "  Renamed Adventure  " })).toMatchObject({
      campaign: { campaignId: created.state.campaignId, title: "Renamed Adventure" },
    });
    expect((await json(base, "/api/status")).campaigns[0].title).toBe("Renamed Adventure");
    expect((await responseJson(base, route, "PUT", { title: "   " })).status).toBe(400);

    await json(base, campaignRoute(created.state.campaignId, "archive"), "POST", {});
    expect((await responseJson(base, route, "PUT", { title: "Too late" })).status).toBe(409);
    expect((await json(base, "/api/status")).campaigns[0].title).toBe("Renamed Adventure");
  });

  it("can permanently delete an archived campaign with any valid persisted title", async () => {
    const root = await fixtureRoot();
    const title = `${"Long campaign title ".repeat(600)}\r\nFinal line`;
    const setup = structuredClone(setupFixture);
    setup.campaignTitle = title;
    const catalog = new CampaignCatalog(path.join(root, "data"), {
      defaultProviderConfig: DEFAULT_CONFIG,
    });
    const created = await catalog.createCampaign(
      { setup, worldRules: "# Long title test\n" },
      { providerConfig: DEFAULT_CONFIG },
    );
    await catalog.archiveCampaign(created.campaignId);
    const { base } = await start(root);

    expect(
      await json(base, campaignRoute(created.campaignId, "delete"), "DELETE", { title }),
    ).toEqual({ deleted: true });
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

    const state = await json(base, campaignRoute(campaign.state.campaignId, "inspect"));
    expect(state.state).toMatchObject({
      character: { view: "character" },
      location: { view: "location", name: "The Crooked Crown" },
      threads: { view: "threads" },
    });
    expect(state.state.revision).toEqual(expect.any(String));
    expect(JSON.stringify(state)).not.toContain(PRIVATE_OPERATION_FACT);
    expect(JSON.stringify(state)).not.toContain("Mara Venn");
    expect((await json(base, "/api/status")).campaigns[0].stateRevision).toBe(state.state.revision);

    const location = await json(
      base,
      campaignRoute(campaign.state.campaignId, "inspect") + "?view=location",
    );
    expect(location.revision).toBe(state.state.revision);
    expect(location.inspection).toMatchObject({ view: "location", name: "The Crooked Crown" });
    expect(location.inspection).not.toHaveProperty("present");
    expect(location.inspection).not.toHaveProperty("inventory");
    expect(JSON.stringify(location)).not.toContain("Mara Venn");
    const transcript = await json(base, campaignRoute(campaign.state.campaignId, "transcript"));
    expect(JSON.stringify(transcript)).not.toContain(PRIVATE_CHECK_STAKE);
    expect(JSON.stringify(transcript)).not.toContain(PRIVATE_OPERATION_FACT);
    const exported = await fetch(
      `${base}${campaignRoute(campaign.state.campaignId, "export")}?format=markdown`,
    );
    expect(exported.status).toBe(200);
    expect(exported.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
    expect(exported.headers.get("content-disposition")).toContain("attachment");
    const markdown = await exported.text();
    expect(markdown).toContain("## Campaign setup");
    expect(markdown).toContain("A scout.");
    expect(markdown).toContain("# Test World");
    expect(markdown).toContain("## Turn log");
    expect(markdown).not.toContain("**Summary:**");
    expect(markdown).not.toContain(PRIVATE_OPERATION_FACT);

    const htmlExport = await fetch(
      `${base}${campaignRoute(campaign.state.campaignId, "export")}?format=html`,
    );
    expect(htmlExport.status).toBe(200);
    expect(htmlExport.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(htmlExport.headers.get("content-disposition")).toContain(".html");
    const html = await htmlExport.text();
    expect(html).toContain('class="setup-button"');
    expect(html).toContain('<dialog id="campaign-setup">');
    expect(html).toContain("A scout.");
    expect(html).toContain('class="entry player"');
    expect(html).not.toContain(PRIVATE_OPERATION_FACT);
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
      generation: {
        provider: "fake",
        model: "gemini-default",
        costUsd: 0.0006,
        costBasis: "exact",
      },
    });
    expect(await json(base, campaignRoute(campaign.state.campaignId, "transcript"))).toEqual(
      before,
    );
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
    expect(status.campaigns).toContainEqual(
      expect.objectContaining({
        campaignId: state.campaignId,
        archived: false,
        config: { provider: DEFAULT_CONFIG.provider, model: DEFAULT_CONFIG.model },
        pending: { kind: "action", phase: "requested", lockedRoll: false },
      }),
    );
    expect(JSON.stringify(status)).not.toContain(privateAction);
    await expect(access(path.join(root, "data", "current"))).rejects.toThrow();
    expect(
      await access(
        path.join(
          campaignScopePath(path.join(root, "data"), state.campaignId),
          "current",
          "manifest.json",
        ),
      ),
    ).toBeUndefined();
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
    expect(
      (
        await responseJson(base, "/api/config/provider", "PUT", {
          ...DEFAULT_CONFIG,
          apiKey: "browser-key",
        })
      ).status,
    ).toBe(404);
  });

  it("projects OpenAI key model access separately from compatibility without exposing the key", async () => {
    const root = await fixtureRoot();
    const secret = "openai-project-secret";
    const discoveredKeys: string[] = [];
    const { base } = await start(root, {
      environment: { OPENAI_API_KEY: secret },
      openAiModelsFetcher: async (apiKey) => {
        discoveredKeys.push(apiKey);
        return new Set(["gpt-5.4"]);
      },
    });

    const status = await json(base, "/api/status");
    const openai = status.llm.providers.find((provider: any) => provider.id === "openai");
    expect(discoveredKeys).toEqual([secret]);
    expect(openai.models.find((model: any) => model.id === "gpt-5.4")).toMatchObject({
      keyAccess: "allowed",
      compatibilityStatus: "untested",
    });
    expect(status.llm.providers.find((provider: any) => provider.id === "gemini").models).toEqual(
      expect.not.arrayContaining([expect.objectContaining({ keyAccess: expect.anything() })]),
    );
    expect(JSON.stringify(status)).not.toContain(secret);
  });

  it("leaves OpenAI key model access unknown when discovery cannot produce a result", async () => {
    const root = await fixtureRoot();
    const { base } = await start(root, {
      environment: { OPENAI_API_KEY: "failing-openai-key" },
      openAiModelsFetcher: async () => {
        throw new Error("raw provider failure");
      },
    });

    const status = await json(base, "/api/status");
    const openai = status.llm.providers.find((provider: any) => provider.id === "openai");
    expect(openai.models.every((model: any) => model.keyAccess === undefined)).toBe(true);
    expect(JSON.stringify(status)).not.toContain("raw provider failure");
  });

  it("bounds and shares advisory OpenAI model discovery so status cannot hang or duplicate work", async () => {
    const root = await fixtureRoot();
    let calls = 0;
    let markDiscoveryStarted!: () => void;
    const discoveryStarted = new Promise<void>((resolve) => {
      markDiscoveryStarted = resolve;
    });
    let releaseDiscovery!: () => void;
    const discoveryBlocked = new Promise<ReadonlySet<string>>((resolve) => {
      releaseDiscovery = () => resolve(new Set(["gpt-5.4"]));
    });
    const first = await start(root, {
      environment: { OPENAI_API_KEY: "openai-key" },
      openAiModelsFetcher: async () => {
        calls += 1;
        markDiscoveryStarted();
        return discoveryBlocked;
      },
      openAiModelsTimeoutMs: 500,
    });

    const statuses = [
      responseJson(first.base, "/api/status"),
      responseJson(first.base, "/api/status"),
    ];
    await discoveryStarted;
    expect(calls).toBe(1);
    releaseDiscovery();
    expect((await Promise.all(statuses)).map((response) => response.status)).toEqual([200, 200]);

    const hangingRoot = await fixtureRoot();
    const hanging = await start(hangingRoot, {
      environment: { OPENAI_API_KEY: "openai-key" },
      openAiModelsFetcher: async () => new Promise<ReadonlySet<string>>(() => {}),
      openAiModelsTimeoutMs: 20,
    });
    const response = await Promise.race([
      responseJson(hanging.base, "/api/status"),
      new Promise<never>((_resolve, reject) =>
        setTimeout(() => reject(new Error("status remained blocked")), 1_000),
      ),
    ]);
    expect(response.status).toBe(200);
    const status = (await response.json()) as any;
    const openai = status.llm.providers.find((provider: any) => provider.id === "openai");
    expect(openai.models.every((model: any) => model.keyAccess === undefined)).toBe(true);
  });

  it("keeps an English-compatible model available when its Russian probe fails", async () => {
    const root = await fixtureRoot();
    const { base } = await start(root, {
      providerFactory: (config) =>
        new WebFakeProvider(config.model, (request) => {
          if (request.schemaName.endsWith("_ru")) throw new Error("Russian compatibility failure");
        }),
    });
    const selection = { provider: "gemini", model: "split-language-model" };

    expect(
      await json(base, "/api/llm/models/test", "POST", { ...selection, language: "en" }),
    ).toMatchObject({ ok: true, language: "en", testedLanguages: ["en"] });
    expect(
      await json(base, "/api/llm/models/test", "POST", { ...selection, language: "ru" }),
    ).toMatchObject({ ok: false, language: "ru", error: "Russian compatibility failure" });

    const status = await json(base, "/api/status");
    const model = status.llm.providers
      .find((provider: any) => provider.id === "gemini")
      .models.find((candidate: any) => candidate.id === selection.model);
    expect(model).toMatchObject({
      status: "compatible",
      enabled: true,
      available: true,
      testedLanguages: ["en"],
      failedLanguages: ["ru"],
    });
  });

  it("tests every registered language for a custom model when no language is specified", async () => {
    const root = await fixtureRoot();
    const { base } = await start(root, {
      providerFactory: (config) =>
        new WebFakeProvider(config.model, (request) => {
          if (request.schemaName.endsWith("_ru")) throw new Error("Russian compatibility failure");
        }),
    });
    const selection = { provider: "gemini", model: "custom-all-language-model" };

    expect(await json(base, "/api/llm/models/test", "POST", selection)).toMatchObject({
      ok: true,
      testedLanguages: ["en"],
      failedLanguages: ["ru"],
      failures: [{ language: "ru", error: "Russian compatibility failure" }],
    });

    const status = await json(base, "/api/status");
    const custom = status.llm.providers
      .find((provider: any) => provider.id === "gemini")
      .models.find((candidate: any) => candidate.id === selection.model);
    expect(custom).toMatchObject({
      known: false,
      status: "compatible",
      enabled: true,
      testedLanguages: ["en"],
      failedLanguages: ["ru"],
    });
  });

  it("adds custom models without testing and removes only unused non-default custom models", async () => {
    const root = await fixtureRoot();
    let providerCalls = 0;
    const { base } = await start(root, {
      providerFactory: (config) => {
        providerCalls += 1;
        return new WebFakeProvider(config.model);
      },
    });
    const removable = { provider: "gemini", model: "custom-removable-model" };

    expect(await json(base, "/api/llm/models", "POST", removable)).toMatchObject({ saved: true });
    expect(providerCalls).toBe(0);
    let status = await json(base, "/api/status");
    expect(
      status.llm.providers
        .find((provider: any) => provider.id === "gemini")
        .models.find((model: any) => model.id === removable.model),
    ).toMatchObject({
      known: false,
      status: "untested",
      enabled: false,
    });

    expect(await json(base, "/api/llm/models", "DELETE", removable)).toMatchObject({ saved: true });
    status = await json(base, "/api/status");
    expect(
      status.llm.providers
        .find((provider: any) => provider.id === "gemini")
        .models.some((model: any) => model.id === removable.model),
    ).toBe(false);

    const knownRemoval = await responseJson(base, "/api/llm/models", "DELETE", {
      provider: "openrouter",
      model: "moonshotai/kimi-k3",
    });
    expect(knownRemoval.status).toBe(400);
    expect(await knownRemoval.json()).toEqual({ error: "Known models cannot be removed" });
  });

  it("does not remove a custom model while its compatibility probe is in flight", async () => {
    const root = await fixtureRoot();
    let releaseProbe!: () => void;
    const probeBlocked = new Promise<void>((resolve) => {
      releaseProbe = resolve;
    });
    let markProbeStarted!: () => void;
    const probeStarted = new Promise<void>((resolve) => {
      markProbeStarted = resolve;
    });
    let blocked = false;
    const selection = { provider: "gemini", model: "custom-probe-race-model" };
    const { base } = await start(root, {
      providerFactory: (config) =>
        new WebFakeProvider(config.model, async (request) => {
          if (!blocked && request.schemaName.startsWith("connection_campaign_setup_")) {
            blocked = true;
            markProbeStarted();
            await probeBlocked;
          }
        }),
    });
    await json(base, "/api/llm/models", "POST", selection);

    const probe = responseJson(base, "/api/llm/models/test", "POST", selection);
    await probeStarted;
    const removal = await responseJson(base, "/api/llm/models", "DELETE", selection);

    expect(removal.status).toBe(409);
    expect(await removal.json()).toEqual({
      error: "Model is being tested or used by a campaign preview",
    });
    releaseProbe();
    expect((await probe).status).toBe(200);
    const status = await json(base, "/api/status");
    expect(
      status.llm.providers
        .find((provider: any) => provider.id === selection.provider)
        .models.some((model: any) => model.id === selection.model),
    ).toBe(true);
  });

  it("does not recreate a custom model when another Web process removes it during a probe", async () => {
    const root = await fixtureRoot();
    let releaseProbe!: () => void;
    const probeBlocked = new Promise<void>((resolve) => {
      releaseProbe = resolve;
    });
    let markProbeStarted!: () => void;
    const probeStarted = new Promise<void>((resolve) => {
      markProbeStarted = resolve;
    });
    let blocked = false;
    const selection = { provider: "gemini", model: "custom-cross-process-probe-race" };
    const first = await start(root, {
      providerFactory: (config) =>
        new WebFakeProvider(config.model, async (request) => {
          if (!blocked && request.schemaName.startsWith("connection_campaign_setup_")) {
            blocked = true;
            markProbeStarted();
            await probeBlocked;
          }
        }),
    });
    const second = await start(root);
    await json(first.base, "/api/llm/models", "POST", selection);

    const probe = responseJson(first.base, "/api/llm/models/test", "POST", selection);
    await probeStarted;
    expect(await json(second.base, "/api/llm/models", "DELETE", selection)).toMatchObject({
      saved: true,
    });
    releaseProbe();

    const probeResponse = await probe;
    expect(probeResponse.status).toBe(409);
    expect(await probeResponse.json()).toEqual({
      error: "Model was removed while its compatibility test was running",
    });
    const status = await json(second.base, "/api/status");
    expect(
      status.llm.providers
        .find((provider: any) => provider.id === selection.provider)
        .models.some((model: any) => model.id === selection.model),
    ).toBe(false);
  });

  it("does not remove a custom model while a campaign preview is being generated", async () => {
    const root = await fixtureRoot();
    let releaseDraft!: () => void;
    const draftBlocked = new Promise<void>((resolve) => {
      releaseDraft = resolve;
    });
    let markDraftStarted!: () => void;
    const draftStarted = new Promise<void>((resolve) => {
      markDraftStarted = resolve;
    });
    const selection = { provider: "gemini", model: "custom-draft-race-model" };
    const { base } = await start(root, {
      providerFactory: (config) =>
        new WebFakeProvider(config.model, async (request) => {
          if (request.schemaName === "campaign_setup") {
            markDraftStarted();
            await draftBlocked;
          }
        }),
    });
    await json(base, "/api/llm/models", "POST", selection);
    await json(base, "/api/llm/models/test", "POST", { ...selection, language: "en" });

    const draft = responseJson(base, "/api/campaigns/draft", "POST", {
      premise: "A race-safe preview.",
      character: "A patient scout.",
      language: "en",
      config: selection,
    });
    await draftStarted;
    const removal = await responseJson(base, "/api/llm/models", "DELETE", selection);

    expect(removal.status).toBe(409);
    expect(await removal.json()).toEqual({
      error: "Model is being tested or used by a campaign preview",
    });
    releaseDraft();
    expect((await draft).status).toBe(200);
  });

  it("discards a detached setup result instead of retaining an unreachable preview", async () => {
    const root = await fixtureRoot();
    const draftBlocked = deferred();
    const draftStarted = deferred();
    const selection = { provider: "gemini", model: "custom-detached-draft" };
    const requestId = "11111111-1111-4111-8111-111111111111";
    const { base } = await start(root, {
      providerFactory: (config) =>
        new WebFakeProvider(config.model, async (request) => {
          if (request.schemaName === "campaign_setup") {
            draftStarted.resolve();
            await draftBlocked.promise;
          }
        }),
    });
    await json(base, "/api/llm/models", "POST", selection);
    await json(base, "/api/llm/models/test", "POST", { ...selection, language: "en" });

    const draft = responseJson(base, "/api/campaigns/draft", "POST", {
      requestId,
      premise: "A preview the browser stopped awaiting.",
      character: "A patient scout.",
      language: "en",
      config: selection,
    });
    await draftStarted.promise;
    expect(await json(base, "/api/campaigns/draft/detach", "POST", { requestId })).toEqual({
      detached: true,
    });
    draftBlocked.resolve();

    const completed = await draft;
    expect(completed.status).toBe(200);
    expect((await completed.json()).draftId).toBe(requestId);
    expect(existsSync(path.join(root, "data", ".drafts", `draft:${requestId}`))).toBe(false);
    const confirmation = await responseJson(base, "/api/campaigns/confirm", "POST", {
      draftId: requestId,
    });
    expect(confirmation.status).toBe(404);
    expect(await json(base, "/api/llm/models", "DELETE", selection)).toMatchObject({
      saved: true,
    });
  });

  it("releases a completed preview when the browser abandons it", async () => {
    const root = await fixtureRoot();
    const selection = { provider: "gemini", model: "custom-abandoned-preview" };
    const requestId = "33333333-3333-4333-8333-333333333333";
    const { base } = await start(root);
    await json(base, "/api/llm/models", "POST", selection);
    await json(base, "/api/llm/models/test", "POST", { ...selection, language: "en" });

    const draft = await json(base, "/api/campaigns/draft", "POST", {
      requestId,
      premise: "A completed preview the player edits instead of accepting.",
      character: "A patient scout.",
      language: "en",
      config: selection,
    });
    expect(draft.draftId).toBe(requestId);
    expect((await responseJson(base, "/api/llm/models", "DELETE", selection)).status).toBe(409);

    await json(base, "/api/campaigns/draft/detach", "POST", { requestId });
    expect(existsSync(path.join(root, "data", ".drafts", `draft:${requestId}`))).toBe(false);
    expect(
      (
        await responseJson(base, "/api/campaigns/confirm", "POST", {
          draftId: requestId,
        })
      ).status,
    ).toBe(404);
    expect(await json(base, "/api/llm/models", "DELETE", selection)).toMatchObject({
      saved: true,
    });
  });

  it("honors a detach that races ahead of setup request registration", async () => {
    const root = await fixtureRoot();
    const selection = { provider: "gemini", model: "custom-early-detach" };
    const requestId = "44444444-4444-4444-8444-444444444444";
    const { base } = await start(root);
    await json(base, "/api/llm/models", "POST", selection);
    await json(base, "/api/llm/models/test", "POST", { ...selection, language: "en" });

    await json(base, "/api/campaigns/draft/detach", "POST", { requestId });
    const draft = await json(base, "/api/campaigns/draft", "POST", {
      requestId,
      premise: "The cleanup request arrived before the generation request.",
      character: "A patient scout.",
      language: "en",
      config: selection,
    });
    expect(draft.draftId).toBe(requestId);
    expect(
      (
        await responseJson(base, "/api/campaigns/confirm", "POST", {
          draftId: requestId,
        })
      ).status,
    ).toBe(404);
    expect(await json(base, "/api/llm/models", "DELETE", selection)).toMatchObject({
      saved: true,
    });
  });

  it("does not retain a setup preview when its original response connection closes", async () => {
    const root = await fixtureRoot();
    const draftBlocked = deferred();
    const draftStarted = deferred();
    const selection = { provider: "gemini", model: "custom-closed-draft-response" };
    const requestId = "22222222-2222-4222-8222-222222222222";
    const { base } = await start(root, {
      providerFactory: (config) =>
        new WebFakeProvider(config.model, async (request) => {
          if (request.schemaName === "campaign_setup") {
            draftStarted.resolve();
            await draftBlocked.promise;
          }
        }),
    });
    await json(base, "/api/llm/models", "POST", selection);
    await json(base, "/api/llm/models/test", "POST", { ...selection, language: "en" });

    const target = new URL("/api/campaigns/draft", base);
    let settleClient!: () => void;
    const clientSettled = new Promise<void>((resolve) => {
      settleClient = resolve;
    });
    const client = httpRequest({
      hostname: target.hostname,
      port: target.port,
      path: target.pathname,
      method: "POST",
      headers: { "Content-Type": "application/json" },
    });
    client.once("error", settleClient);
    client.once("close", settleClient);
    client.end(
      JSON.stringify({
        requestId,
        premise: "A preview whose tab closes.",
        character: "A patient scout.",
        language: "en",
        config: selection,
      }),
    );
    await draftStarted.promise;
    client.destroy();
    await clientSettled;

    const activeRemoval = await responseJson(base, "/api/llm/models", "DELETE", selection);
    expect(activeRemoval.status).toBe(409);
    draftBlocked.resolve();

    let removal: Response | undefined;
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline) {
      removal = await responseJson(base, "/api/llm/models", "DELETE", selection);
      if (removal.status === 200) break;
      expect(removal.status).toBe(409);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(removal?.status).toBe(200);
  });

  it("does not confirm a draft whose custom model was removed by another Web process", async () => {
    const root = await fixtureRoot();
    const first = await start(root);
    const second = await start(root);
    const selection = { provider: "gemini", model: "custom-cross-process-draft-race" };
    await json(first.base, "/api/llm/models", "POST", selection);
    await json(first.base, "/api/llm/models/test", "POST", {
      ...selection,
      language: "en",
    });
    const draft = await json(first.base, "/api/campaigns/draft", "POST", {
      premise: "A preview awaiting confirmation.",
      character: "A patient scout.",
      language: "en",
      config: selection,
    });

    expect(await json(second.base, "/api/llm/models", "DELETE", selection)).toMatchObject({
      saved: true,
    });
    const confirmation = await responseJson(first.base, "/api/campaigns/confirm", "POST", {
      draftId: draft.draftId,
    });

    expect(confirmation.status).toBe(409);
    expect(await confirmation.json()).toEqual({
      error: "Model was removed while the campaign preview was awaiting confirmation",
    });
    const status = await json(second.base, "/api/status");
    expect(status.campaigns).toEqual([]);
  });

  it("serializes draft confirmation ahead of overlapping cross-process model removal", async () => {
    const root = await fixtureRoot();
    const first = await start(root);
    const second = await start(root);
    const selection = { provider: "gemini", model: "custom-confirm-removal-lock-race" };
    await json(first.base, "/api/llm/models", "POST", selection);
    await json(first.base, "/api/llm/models/test", "POST", {
      ...selection,
      language: "en",
    });
    const draft = await json(first.base, "/api/campaigns/draft", "POST", {
      premise: "A preview crossing an atomic boundary.",
      character: "A patient scout.",
      language: "en",
      config: selection,
    });

    const campaignLockHeld = deferred();
    const releaseCampaignLock = deferred();
    const campaignLock = withSerializedFileLock(
      path.join(root, "data", ".campaign-catalog.lock"),
      "test campaign catalog",
      async () => {
        campaignLockHeld.resolve();
        await releaseCampaignLock.promise;
      },
    );
    await campaignLockHeld.promise;
    const confirmation = responseJson(first.base, "/api/campaigns/confirm", "POST", {
      draftId: draft.draftId,
    });
    await waitFor(() => existsSync(path.join(root, "config", ".llm-models.lock")));
    let removalSettled = false;
    const removal = responseJson(second.base, "/api/llm/models", "DELETE", selection).then(
      (response) => {
        removalSettled = true;
        return response;
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(removalSettled).toBe(false);

    releaseCampaignLock.resolve();
    await campaignLock;
    expect((await confirmation).status).toBe(200);
    const removalResponse = await removal;
    expect(removalResponse.status).toBe(409);
    expect(await removalResponse.json()).toMatchObject({
      error: expect.stringContaining("is used by campaign"),
    });
    const status = await json(second.base, "/api/status");
    expect(status.campaigns).toHaveLength(1);
    expect(
      status.llm.providers
        .find((provider: any) => provider.id === selection.provider)
        .models.some((model: any) => model.id === selection.model),
    ).toBe(true);
  });

  it("serializes campaign model changes ahead of overlapping cross-process removal", async () => {
    const root = await fixtureRoot();
    const first = await start(root);
    const second = await start(root);
    const campaign = await createCampaign(first.base);
    const selection = { provider: "gemini", model: "custom-config-removal-lock-race" };
    await json(first.base, "/api/llm/models", "POST", selection);
    await json(first.base, "/api/llm/models/test", "POST", {
      ...selection,
      language: "en",
    });

    const campaignLockHeld = deferred();
    const releaseCampaignLock = deferred();
    const campaignLock = withSerializedFileLock(
      path.join(root, "data", ".campaign-catalog.lock"),
      "test campaign catalog",
      async () => {
        campaignLockHeld.resolve();
        await releaseCampaignLock.promise;
      },
    );
    await campaignLockHeld.promise;
    const configuration = responseJson(
      first.base,
      campaignRoute(campaign.state.campaignId, "config"),
      "PUT",
      selection,
    );
    await waitFor(() => existsSync(path.join(root, "config", ".llm-models.lock")));
    const removal = responseJson(second.base, "/api/llm/models", "DELETE", selection);

    releaseCampaignLock.resolve();
    await campaignLock;
    expect((await configuration).status).toBe(200);
    const removalResponse = await removal;
    expect(removalResponse.status).toBe(409);
    expect(await removalResponse.json()).toMatchObject({
      error: expect.stringContaining("is used by campaign"),
    });
    const status = await json(second.base, "/api/status");
    expect(
      status.campaigns.find((entry: any) => entry.campaignId === campaign.state.campaignId).config,
    ).toEqual(selection);
  });

  it("accepts an unpersisted browser session key and clears back to the environment fallback", async () => {
    const root = await fixtureRoot();
    const { base, environments } = await start(root, { environment: {} });
    const secret = "temporary-browser-secret";

    const missing = await responseJson(base, "/api/llm/models/test", "POST", {
      provider: "openai",
      model: "gpt-5.4",
    });
    expect(missing.status).toBe(409);
    expect(await missing.json()).toEqual({
      error: "Configure OPENAI_API_KEY in Settings, or add it to .env and reload it in Settings",
    });

    const saved = await json(base, "/api/llm/keys", "PUT", { provider: "openai", key: secret });
    expect(JSON.stringify(saved)).not.toContain(secret);
    expect(saved.llm.providers.find((provider: any) => provider.id === "openai")).toMatchObject({
      keyPresent: true,
      keySource: "session",
      keyConnectionStatus: "unknown",
    });

    const tested = await json(base, "/api/llm/models/test", "POST", {
      provider: "openai",
      model: "gpt-5.4",
    });
    expect(tested.ok).toBe(true);
    expect(environments.at(-1)?.OPENAI_API_KEY).toBe(secret);
    expect(await readFile(path.join(root, "config", "llm-models.json"), "utf8")).not.toContain(
      secret,
    );

    const cleared = await json(base, "/api/llm/keys", "PUT", { provider: "openai", key: "" });
    expect(cleared.llm.providers.find((provider: any) => provider.id === "openai")).toMatchObject({
      keyPresent: false,
      keySource: "missing",
      keyConnectionStatus: "unknown",
    });
  });

  it("checks one provider on demand and persists the result across restarts unless the key changes", async () => {
    const root = await fixtureRoot();
    const calls: Array<{ provider: string; apiKey: string }> = [];
    const tester =
      (status: "connected" | "unauthorized") => async (provider: LlmProviderId, apiKey: string) => {
        calls.push({ provider, apiKey });
        return { provider, status };
      };

    const first = await start(root, {
      environment: { GEMINI_API_KEY: "gemini-secret", OPENAI_API_KEY: "openai-secret" },
      connectionTester: tester("connected"),
    });
    const checked = await json(first.base, "/api/llm/connections/test", "POST", {
      provider: "gemini",
    });
    expect(checked.results).toEqual([{ provider: "gemini", status: "connected" }]);
    expect(calls).toEqual([{ provider: "gemini", apiKey: "gemini-secret" }]);
    expect(checked.llm.providers.find((provider: any) => provider.id === "gemini")).toMatchObject({
      keyConnectionStatus: "connected",
    });
    expect(checked.llm.providers.find((provider: any) => provider.id === "openai")).toMatchObject({
      keyConnectionStatus: "unknown",
    });
    const persisted = await readFile(
      path.join(root, "config", "provider-connections.json"),
      "utf8",
    );
    expect(persisted).not.toContain("gemini-secret");

    // Restart with the same key: the persisted "connected" result is restored without re-testing.
    const restart = await start(root, {
      environment: { GEMINI_API_KEY: "gemini-secret" },
      connectionTester: tester("connected"),
    });
    const afterRestart = await json(restart.base, "/api/llm");
    expect(
      afterRestart.llm.providers.find((provider: any) => provider.id === "gemini"),
    ).toMatchObject({ keyConnectionStatus: "connected" });

    // Restart with a changed key: the fingerprint no longer matches, so status falls back to unknown.
    const changed = await start(root, {
      environment: { GEMINI_API_KEY: "rotated-secret" },
      connectionTester: tester("connected"),
    });
    const afterChange = await json(changed.base, "/api/llm");
    expect(
      afterChange.llm.providers.find((provider: any) => provider.id === "gemini"),
    ).toMatchObject({ keyConnectionStatus: "unknown" });
  });

  it("checks configured provider connections without persisting credentials or model evidence", async () => {
    const root = await fixtureRoot();
    const calls: Array<{ provider: string; apiKey: string }> = [];
    const { base } = await start(root, {
      environment: { GEMINI_API_KEY: "gemini-secret", OPENAI_API_KEY: "openai-secret" },
      connectionTester: async (provider, apiKey) => {
        calls.push({ provider, apiKey });
        return { provider, status: provider === "gemini" ? "connected" : "unauthorized" };
      },
    });

    const checked = await json(base, "/api/llm/connections/test", "POST", {});
    expect(checked.results).toEqual([
      { provider: "gemini", status: "connected" },
      { provider: "openai", status: "unauthorized" },
    ]);
    expect(checked.llm.providers.find((provider: any) => provider.id === "gemini")).toMatchObject({
      keySource: "environment",
      keyConnectionStatus: "connected",
    });
    expect(checked.llm.providers.find((provider: any) => provider.id === "openai")).toMatchObject({
      keySource: "environment",
      keyConnectionStatus: "failed",
    });
    expect(checked).toMatchObject({
      results: [
        { provider: "gemini", status: "connected" },
        { provider: "openai", status: "unauthorized" },
      ],
    });
    expect(calls).toEqual([
      { provider: "gemini", apiKey: "gemini-secret" },
      { provider: "openai", apiKey: "openai-secret" },
    ]);
    expect(JSON.stringify(checked)).not.toContain("secret");

    const changed = await json(base, "/api/llm/keys", "PUT", {
      provider: "gemini",
      key: "replacement-secret",
    });
    expect(changed.llm.providers.find((provider: any) => provider.id === "gemini")).toMatchObject({
      keySource: "session",
      keyConnectionStatus: "unknown",
    });
  });

  it("reloads project .env keys without replacing injected shell values", async () => {
    const root = await fixtureRoot();
    await writeFile(
      path.join(root, ".env"),
      "GEMINI_API_KEY=from-file\nOPENAI_API_KEY=old-value\n",
      "utf8",
    );
    const environment: NodeJS.ProcessEnv = { GEMINI_API_KEY: "from-shell" };
    const { base } = await start(root, { environment });

    await writeFile(
      path.join(root, ".env"),
      "OPENAI_API_KEY=new-value\nDEEPSEEK_API_KEY=added\n",
      "utf8",
    );
    const reloaded = await json(base, "/api/llm/environment/reload", "POST", {});
    expect(reloaded.reloaded).toBe(true);
    expect(environment).toMatchObject({
      GEMINI_API_KEY: "from-shell",
      OPENAI_API_KEY: "new-value",
      DEEPSEEK_API_KEY: "added",
    });
  });

  it("does not carry a saved endpoint override across providers during a connection test", async () => {
    const root = await fixtureRoot();
    const configs: ProviderConfig[] = [];
    await writeFile(
      path.join(root, "config", "provider.json"),
      JSON.stringify({
        ...DEFAULT_CONFIG,
        provider: "openrouter",
        model: "vendor/old-model",
        endpoint: "https://old-provider.invalid/v1",
      }),
      "utf8",
    );
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
    expect(
      (
        await rawRequest(base, "/api/status", {
          headers: { Host: `localhost:${port}` },
        })
      ).status,
    ).toBe(200);
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
    const unsafeDelete = await fetch(
      `${base}/api/campaigns/${encodeURIComponent("campaign:missing")}/delete`,
      {
        method: "DELETE",
        headers: { "Content-Type": "text/plain" },
        body: "{}",
      },
    );
    expect(unsafeDelete.status).toBe(415);

    expect((await fetch(`${base}/api/campaigns/not-safe/transcript`)).status).toBe(400);
    expect(
      (await fetch(`${base}/api/campaigns/${encodeURIComponent("campaign:missing")}/transcript`))
        .status,
    ).toBe(404);
    const traversal = await fetch(
      `${base}/api/campaigns/${encodeURIComponent("campaign:../../secret")}/transcript`,
    );
    expect(traversal.status).toBe(400);
  });

  it("redacts and caps unexpected errors at the final browser boundary", async () => {
    const root = await fixtureRoot();
    const secret = "unexpected-secret+/=";
    const { base } = await start(root, {
      environment: { GEMINI_API_KEY: secret, ANTHROPIC_API_KEY: "\ud800" },
      providerFactory: (config) =>
        new WebFakeProvider(config.model, (request) => {
          if (request.schemaName === "campaign_setup") {
            throw new Error(
              [secret, encodeURIComponent(secret), root, "internal detail ".repeat(80)].join("\n"),
            );
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
    const body = (await failure.json()) as { error: string };
    expect(body.error).toContain("[redacted]");
    expect(body.error).toContain("[project]");
    expect(body.error).not.toContain(secret);
    expect(body.error).not.toContain(encodeURIComponent(secret));
    expect(body.error).not.toContain("\n");
    expect(body.error.length).toBeLessThanOrEqual(500);

    const modelCatalog = new LlmModelCatalog(root, {
      testFingerprint: PROVIDER_COMPATIBILITY_FINGERPRINT,
    });
    await modelCatalog.recordTestFailure(
      {
        provider: DEFAULT_CONFIG.provider,
        model: DEFAULT_CONFIG.model,
      },
      {
        failureSummary: [
          root,
          encodeURIComponent(secret),
          "https://user:private@example.invalid/v1?token=private#details",
        ].join(" "),
      },
    );
    const status = await json(base, "/api/status");
    const storedError = status.llm.providers
      .find((provider: any) => provider.id === DEFAULT_CONFIG.provider)
      .models.find((model: any) => model.id === DEFAULT_CONFIG.model).error as string;
    expect(storedError).toContain("[project]");
    expect(storedError).toContain("?[redacted]");
    for (const hidden of [root, encodeURIComponent(secret), "user", "private", "token=private"]) {
      expect(storedError).not.toContain(hidden);
    }

    const missingAsset = await fetch(`${base}/styles.css`);
    const missingBody = (await missingAsset.json()) as { error: string };
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
    await writeFile(
      path.join(root, "config", "provider.json"),
      JSON.stringify(internalConfig),
      "utf8",
    );
    const catalog = new CampaignCatalog(path.join(root, "data"), {
      defaultProviderConfig: internalConfig,
    });
    const created = await catalog.createCampaign(
      { setup: setupFixture, worldRules: "# Internal config test\n" },
      { providerConfig: internalConfig },
    );
    const { base } = await start(root);

    const status = await json(base, "/api/status");
    const selection = { provider: internalConfig.provider, model: internalConfig.model };
    expect(status.config).toEqual(selection);
    expect(status.defaults.config).toEqual(selection);
    expect(
      status.campaigns.find((campaign: any) => campaign.campaignId === created.campaignId).config,
    ).toEqual(selection);
    const serialized = JSON.stringify(status);
    for (const hidden of [
      "temperature",
      "maxOutputTokens",
      "endpoint",
      "user:private",
      "token=private",
    ]) {
      expect(serialized).not.toContain(hidden);
    }
  });
});
