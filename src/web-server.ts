import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import path from "node:path";
import { z } from "zod";
import { CampaignCatalog, type CampaignCatalogSummary } from "./campaign-catalog.js";
import {
  campaignHtmlFilename,
  campaignMarkdownFilename,
  renderCampaignHtml,
  renderCampaignMarkdown,
} from "./campaign-export.js";
import { probeProviderConnection } from "./connection-probe.js";
import { DungeonEngine } from "./engine.js";
import { campaignStateRevision } from "./inspection.js";
import { INPUT_CHARACTER_LIMITS } from "./input-budget.js";
import {
  campaignSetupDefaults,
  LANGUAGES,
  LanguageCodeSchema,
  loadAppConfig,
  saveAppConfig,
  type LanguageCode,
} from "./language.js";
import { parseAppealCommand } from "./appeal.js";
import { readCampaignMetadata } from "./persistence/campaign-catalog.js";
import {
  LlmProviderIdSchema,
  ModelUnavailableError,
  ModelSelectionSchema,
  type ModelSelection,
} from "./llm-model-catalog.js";
import type { OpenAiModelsFetcher } from "./openai-model-access.js";
import { parseQuestionCommand } from "./question.js";
import { listScenarioSeeds, loadScenarioSeed } from "./scenario-seeds.js";
import {
  ProviderConfigSchema,
  SafeIdSchema,
  type ProviderConfig,
  type SetupResult,
} from "./schemas.js";
import { StateStore } from "./store.js";
import type { CampaignSpendingTransferPayload } from "./spending.js";
import type { CampaignCostSummary } from "./campaign-cost.js";
import type { CampaignStateSnapshot, GenerationMetadata, StateView } from "./types.js";
import { resolveWorldProfile, saveWorldProfile } from "./world-profile.js";
import { CampaignOperationCoordinator } from "./web/campaign-operations.js";
import {
  asError,
  readJsonBody,
  rejectUnsafeMutation,
  rejectUntrustedHost,
  sendJson,
  sendTextDownload,
  statusFor,
  WebApiError,
} from "./web/http.js";
import { serveStaticAsset } from "./web/static-assets.js";
import {
  ModelSettingsService,
  type ProviderConnectionTester,
  type ProviderFactory,
} from "./web/model-settings.js";
import {
  completedStoryResponse,
  pendingStatus,
  playerTurnResponse,
  setupPreview,
} from "./web/presentation.js";
import type {
  BrowserApiOperation,
  BrowserApiResponse,
  BrowserCampaignCreatedResponse,
  BrowserCampaignPresentation,
  BrowserCampaignStatusResponse,
  BrowserSetupDraftResponse,
  BrowserStatusResponse,
} from "./web/contracts.js";

function sendBrowserJson<Operation extends BrowserApiOperation>(
  response: ServerResponse,
  status: number,
  operation: Operation,
  payload: BrowserApiResponse<NoInfer<Operation>>,
): void {
  void operation;
  sendJson(response, status, payload);
}

export type { ProviderFactory, ProviderConnectionTester } from "./web/model-settings.js";

export interface WebServerOptions {
  root: string;
  host?: string;
  environment?: NodeJS.ProcessEnv;
  providerFactory?: ProviderFactory;
  maxConcurrentCampaignOperations?: number;
  pricingFetcher?: (() => Promise<unknown>) | false;
  openAiModelsFetcher?: OpenAiModelsFetcher | false;
  openAiModelsTimeoutMs?: number;
  connectionTester?: ProviderConnectionTester;
}

interface SetupDraft {
  setup: SetupResult;
  generation: GenerationMetadata;
  language: LanguageCode;
  worldRules: string;
  config: ProviderConfig;
  premise: string;
  character: string;
  spending: CampaignSpendingTransferPayload;
}

interface ActiveSetupDraftRequest {
  detached: boolean;
}

const SetupModelConfigSchema = z.union([ModelSelectionSchema, ProviderConfigSchema.strict()]);

const SetupDraftRequestSchema = z
  .object({
    premise: z.string().max(INPUT_CHARACTER_LIMITS.premise).default(""),
    character: z.string().max(INPUT_CHARACTER_LIMITS.character).default(""),
    language: LanguageCodeSchema.optional(),
    worldRules: z.string().min(1).max(INPUT_CHARACTER_LIMITS.worldRules).optional(),
    config: SetupModelConfigSchema.optional(),
    requestId: z.string().uuid().optional(),
  })
  .strict();

const SetupDraftDetachRequestSchema = z.object({ requestId: z.string().uuid() }).strict();

const ModelEnabledRequestSchema = ModelSelectionSchema.extend({ enabled: z.boolean() }).strict();
const ModelTestRequestSchema = ModelSelectionSchema.extend({
  language: LanguageCodeSchema.optional(),
}).strict();
const SessionProviderKeyRequestSchema = z
  .object({
    provider: LlmProviderIdSchema,
    key: z.string().max(10_000),
  })
  .strict();

const STATE_VIEWS: StateView[] = ["character", "location", "threads"];
const MAX_DRAFTS = 20;
const MAX_DETACHED_SETUP_REQUESTS = 100;
const DETACHED_SETUP_REQUEST_TTL_MS = 10 * 60_000;

function decodeCampaignId(segment: string): string {
  let decoded: string;
  try {
    decoded = decodeURIComponent(segment);
  } catch {
    throw new WebApiError(400, "Campaign ID is not valid URL encoding");
  }
  const parsed = SafeIdSchema.safeParse(decoded);
  if (!parsed.success || !parsed.data.startsWith("campaign:")) {
    throw new WebApiError(400, "Campaign ID must be a safe campaign ID");
  }
  return parsed.data;
}

function campaignRoute(pathname: string): { campaignId: string; action: string } | undefined {
  const match =
    /^\/api\/campaigns\/([^/]+)\/(status|budget|play|retry|discard|archive|delete|inspect|transcript|export|config|setup|story|title)$/.exec(
      pathname,
    );
  if (!match) return undefined;
  return { campaignId: decodeCampaignId(match[1]!), action: match[2]! };
}

function campaignBudgetErrorDetails(
  error: unknown,
): { code: "campaign_budget_exhausted"; scope: "campaign" | "logical_turn" } | undefined {
  if (!error || typeof error !== "object") return undefined;
  const value = error as { code?: unknown; reason?: unknown; scope?: unknown };
  if (value.code !== "campaign_budget_exhausted") return undefined;
  const scope =
    value.scope === "logical_turn" || value.reason === "logical_turn_limit"
      ? "logical_turn"
      : value.scope === "campaign" ||
          value.reason === "campaign_limit" ||
          value.reason === "pricing_unavailable"
        ? "campaign"
        : undefined;
  return scope === undefined ? undefined : { code: value.code, scope };
}

export class DungeonWebController {
  readonly dataRoot: string;
  readonly webRoot: string;
  readonly settings: ModelSettingsService;
  private readonly operations: CampaignOperationCoordinator;
  private readonly drafts = new Map<string, SetupDraft>();
  private readonly activeSetupDraftRequests = new Map<string, ActiveSetupDraftRequest>();
  private readonly detachedSetupRequestIds = new Map<string, number>();
  private readonly activeModelUses = new Map<string, number>();
  private readonly activeModelRemovals = new Set<string>();
  private readonly costCache = new Map<string, { updatedAt: string; cost: CampaignCostSummary }>();
  private readonly stateCache = new Map<string, CampaignStateSnapshot>();
  private readonly stateLoads = new Map<string, Promise<CampaignStateSnapshot>>();
  private campaignCatalog: CampaignCatalog | undefined;

  constructor(
    readonly root: string,
    options: Omit<WebServerOptions, "root"> = {},
  ) {
    this.dataRoot = path.join(root, "data");
    this.webRoot = path.join(root, "web");
    this.settings = new ModelSettingsService(root, options);
    this.operations = new CampaignOperationCoordinator(
      options.maxConcurrentCampaignOperations ?? 3,
    );
  }

  safeError(error: unknown, fallback?: string): string {
    return this.settings.safeError(error, fallback);
  }

  private pruneDetachedSetupRequests(now = Date.now()): void {
    const cutoff = now - DETACHED_SETUP_REQUEST_TTL_MS;
    for (const [requestId, detachedAt] of this.detachedSetupRequestIds) {
      if (detachedAt < cutoff) this.detachedSetupRequestIds.delete(requestId);
    }
    while (this.detachedSetupRequestIds.size > MAX_DETACHED_SETUP_REQUESTS) {
      this.detachedSetupRequestIds.delete(this.detachedSetupRequestIds.keys().next().value!);
    }
  }

  private setupDraftRoot(requestId: string): string {
    return path.join(this.dataRoot, ".drafts", `draft:${requestId}`);
  }

  private async removeSetupDraft(requestId: string): Promise<void> {
    this.drafts.delete(requestId);
    await rm(this.setupDraftRoot(requestId), { recursive: true, force: true });
  }

  private async detachSetupDraft(requestId: string): Promise<void> {
    const active = this.activeSetupDraftRequests.get(requestId);
    if (active) active.detached = true;
    const removed = this.drafts.delete(requestId);
    if (!active && !removed) {
      this.detachedSetupRequestIds.set(requestId, Date.now());
      this.pruneDetachedSetupRequests();
    }
    // An active provider request owns this root until its finally block settles
    // the physical attempt. Completed and not-yet-started drafts are disposable.
    if (!active) await rm(this.setupDraftRoot(requestId), { recursive: true, force: true });
  }

  private modelOperationKey(selection: ModelSelection): string {
    return `${selection.provider}\u0000${selection.model}`;
  }

  /**
   * Model use is shared by drafts/probes, but mutually exclusive with removal.
   * Registration is synchronous so two HTTP handlers cannot pass each other
   * between their safety check and first await.
   */
  private reserveModelUse(selection: ModelSelection): () => void {
    const key = this.modelOperationKey(selection);
    if (this.activeModelRemovals.has(key)) {
      throw new WebApiError(409, "Model removal is already in progress");
    }
    this.activeModelUses.set(key, (this.activeModelUses.get(key) ?? 0) + 1);
    return () => {
      const remaining = (this.activeModelUses.get(key) ?? 1) - 1;
      if (remaining > 0) this.activeModelUses.set(key, remaining);
      else this.activeModelUses.delete(key);
    };
  }

  private reserveModelRemoval(selection: ModelSelection): () => void {
    const key = this.modelOperationKey(selection);
    if (this.activeModelRemovals.has(key) || (this.activeModelUses.get(key) ?? 0) > 0) {
      throw new WebApiError(409, "Model is being tested or used by a campaign preview");
    }
    this.activeModelRemovals.add(key);
    return () => {
      this.activeModelRemovals.delete(key);
    };
  }

  private removedModelConflict(error: unknown, activity: string): never {
    if (error instanceof ModelUnavailableError && error.reason === "unregistered") {
      throw new WebApiError(409, `Model was removed while ${activity}`);
    }
    throw error;
  }

  private async catalog(): Promise<CampaignCatalog> {
    if (!this.campaignCatalog) {
      const defaultProviderConfig = await this.settings.defaultConfig().catch(() => undefined);
      this.campaignCatalog = new CampaignCatalog(this.dataRoot, {
        ...(defaultProviderConfig === undefined ? {} : { defaultProviderConfig }),
      });
      await this.campaignCatalog.ensureReady();
    }
    return this.campaignCatalog;
  }

  private async requireSummary(campaignId: string): Promise<CampaignCatalogSummary> {
    const summary = (await (await this.catalog()).listCampaigns()).find(
      (candidate) => candidate.campaignId === campaignId,
    );
    if (!summary) throw new WebApiError(404, `Campaign ${campaignId} was not found`);
    return summary;
  }

  private async readStore(summary: CampaignCatalogSummary): Promise<StateStore> {
    const catalog = await this.catalog();
    if (summary.archived) return catalog.readCampaign(summary.campaignId);
    try {
      return await catalog.openCampaign(summary.campaignId);
    } catch (error) {
      // A read may race with archival after the status summary was captured.
      // Reopen read-only instead of failing the entire status/transcript request.
      if (/archived and cannot be resumed/i.test(asError(error))) {
        return catalog.readCampaign(summary.campaignId);
      }
      throw error;
    }
  }

  private async campaignCost(
    summary: CampaignCatalogSummary,
    store: StateStore,
  ): Promise<CampaignCostSummary | null> {
    const cached = this.costCache.get(summary.campaignId);
    if (cached?.updatedAt === summary.updatedAt) return cached.cost;
    if (this.operations.isBusy(summary.campaignId)) return cached?.cost ?? null;
    try {
      const cost = await store.campaignCost();
      this.costCache.set(summary.campaignId, { updatedAt: summary.updatedAt, cost });
      return cost;
    } catch (error) {
      if (/locked by another running process/i.test(asError(error))) return cached?.cost ?? null;
      throw error;
    }
  }

  private async campaignPresentation(
    summary: CampaignCatalogSummary,
  ): Promise<BrowserCampaignPresentation> {
    const store = await this.readStore(summary);
    const { providerConfig, ...manifest } = summary;
    return {
      ...manifest,
      stateRevision: campaignStateRevision(summary),
      busy: this.operations.isBusy(summary.campaignId),
      pending: pendingStatus(await store.getPending()),
      campaignCost: await this.campaignCost(summary, store),
      budget: await store.campaignBudget(),
      config:
        providerConfig === undefined ? null : this.settings.presentedSelection(providerConfig),
    };
  }

  private async campaignState(summary: CampaignCatalogSummary): Promise<CampaignStateSnapshot> {
    const existingLoad = this.stateLoads.get(summary.campaignId);
    if (existingLoad) return existingLoad;
    const load = (async () => {
      const cached = this.stateCache.get(summary.campaignId);
      const read = await (await this.readStore(summary)).campaignStateSnapshot(cached?.revision);
      if (read.state) {
        this.stateCache.set(summary.campaignId, read.state);
        return read.state;
      }
      if (!cached || cached.revision !== read.revision) {
        throw new Error("Campaign state cache revision is inconsistent");
      }
      return cached;
    })();
    this.stateLoads.set(summary.campaignId, load);
    try {
      return await load;
    } finally {
      if (this.stateLoads.get(summary.campaignId) === load) {
        this.stateLoads.delete(summary.campaignId);
      }
    }
  }

  private async activeStore(campaignId: string): Promise<StateStore> {
    const summary = await this.requireSummary(campaignId);
    if (summary.archived)
      throw new WebApiError(409, `Campaign ${campaignId} is archived and cannot be resumed`);
    return (await this.catalog()).openCampaign(campaignId);
  }

  private async confirmedCampaignResponse(
    requestId: string,
  ): Promise<BrowserCampaignCreatedResponse | undefined> {
    const catalog = await this.catalog();
    const created = await catalog.findCampaignByCreationRequest(requestId);
    if (created === undefined) return undefined;
    const snapshot = await created.store.campaignLogSnapshot();
    const opening = snapshot.turns.find((turn) => turn.turn === 0);
    return {
      state: created.state,
      playerName: snapshot.playerName,
      openingNarration: opening?.narration ?? "",
      config: await catalog
        .providerConfig(created.campaignId)
        .then((config) => (config === undefined ? null : this.settings.presentedSelection(config))),
    };
  }

  private async runCampaign<T>(
    campaignId: string,
    operation: (engine: DungeonEngine, store: StateStore) => Promise<T>,
  ): Promise<T> {
    if (this.operations.isBusy(campaignId)) {
      throw new WebApiError(409, "Another operation is still running for this campaign");
    }
    try {
      return await this.operations.run(campaignId, async () => {
        const store = await this.activeStore(campaignId);
        return store.withCampaignLock(async () => {
          const metadata = await readCampaignMetadata(store.dataRoot);
          if (metadata.archived)
            throw new WebApiError(409, `Campaign ${campaignId} is archived and cannot be resumed`);
          const config = metadata.providerConfig;
          if (!config)
            throw new WebApiError(
              409,
              "Choose a provider and model for this campaign before playing",
            );
          const language = (await store.readManifest()).language;
          const engine = new DungeonEngine(store, await this.settings.provider(config, language));
          return operation(engine, store);
        });
      });
    } catch (error) {
      if (/another operation is still running/i.test(asError(error))) {
        throw new WebApiError(409, "Another operation is still running for this campaign");
      }
      throw error;
    }
  }

  private async handleStatusApi(
    method: string,
    response: ServerResponse,
    url: URL,
  ): Promise<boolean> {
    if (method !== "GET" || url.pathname !== "/api/status") return false;
    const config = await this.settings.defaultConfig().catch(() => null);
    const presentedConfig = config === null ? null : this.settings.presentedSelection(config);
    const language = (await loadAppConfig(this.root)).language;
    const summaries = await (await this.catalog()).listCampaigns();
    const llm = await this.settings.llmPresentation();
    const payload: BrowserStatusResponse = {
      language,
      languages: Object.entries(LANGUAGES).map(([code, value]) => ({
        code: LanguageCodeSchema.parse(code),
        name: value.nativeName,
        setupDefaults: value.setupDefaults,
      })),
      config: presentedConfig,
      defaults: { language, config: presentedConfig },
      keyStatus: this.settings.keyStatus(),
      llm,
      campaigns: await Promise.all(summaries.map((summary) => this.campaignPresentation(summary))),
    };
    sendBrowserJson(response, 200, "bootstrap", payload);
    return true;
  }

  private async handleConfigurationApi(
    method: string,
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
  ): Promise<boolean> {
    if (url.pathname === "/api/config/language" && method === "PUT") {
      const body = z
        .object({ language: LanguageCodeSchema })
        .strict()
        .parse(await readJsonBody(request));
      await saveAppConfig(this.root, { language: body.language });
      sendBrowserJson(response, 200, "saveLanguage", { language: body.language });
      return true;
    }

    if (url.pathname === "/api/llm" && method === "GET") {
      sendJson(response, 200, { llm: await this.settings.llmPresentation() });
      return true;
    }

    if (url.pathname === "/api/llm/keys" && method === "PUT") {
      const body = SessionProviderKeyRequestSchema.parse(await readJsonBody(request));
      this.settings.setSessionKey(body.provider, body.key.trim());
      sendBrowserJson(response, 200, "setSessionKey", {
        llm: await this.settings.llmPresentation(),
      });
      return true;
    }

    if (url.pathname === "/api/llm/models/test" && method === "POST") {
      const body = ModelTestRequestSchema.parse(await readJsonBody(request));
      const selection = this.settings.selection(body);
      this.settings.requirePublicSelection(selection);
      const releaseModel = this.reserveModelUse(selection);
      try {
        const languages =
          body.language === undefined
            ? (Object.keys(LANGUAGES) as LanguageCode[])
            : [body.language];
        this.settings.requireProviderKey(selection);
        // Preserve the historical direct-test API while making every result
        // update require that this registration still exists.
        await this.settings.modelCatalog.addModel(selection);
        const config = await this.settings.configForSelection(selection);
        const operationId = `probe:${randomUUID()}`;
        const provider = this.settings.bareProvider(config);
        const passed: LanguageCode[] = [];
        const failed: Array<{ language: LanguageCode; error: string }> = [];
        const results: Awaited<ReturnType<typeof probeProviderConnection>>[] = [];
        await this.operations.run(operationId, async () => {
          for (const language of languages) {
            let result: Awaited<ReturnType<typeof probeProviderConnection>>;
            try {
              result = await probeProviderConnection(provider, [language]);
            } catch (error) {
              const summary = this.safeError(error, "Provider compatibility test failed");
              try {
                await this.settings.modelCatalog.recordTestFailure(
                  selection,
                  {
                    failedLanguages: [language],
                    failureSummary: summary,
                  },
                  { requireRegistered: true },
                );
              } catch (recordError) {
                this.removedModelConflict(recordError, "its compatibility test was running");
              }
              failed.push({ language, error: summary });
              continue;
            }
            try {
              await this.settings.modelCatalog.recordTestSuccess(
                selection,
                {
                  testedLanguages: [language],
                },
                { requireRegistered: true },
              );
            } catch (recordError) {
              this.removedModelConflict(recordError, "its compatibility test was running");
            }
            passed.push(language);
            results.push(result);
          }
        });
        const first = results[0];
        sendBrowserJson(response, 200, "testModel", {
          ok: passed.length > 0,
          provider: first?.provider ?? selection.provider,
          model: first?.model ?? selection.model,
          ...(body.language === undefined ? {} : { language: body.language }),
          usage: results.length === 1 ? (results[0]?.usage ?? null) : null,
          testedLanguages: passed,
          failedLanguages: failed.map((result) => result.language),
          failures: failed,
          protocolVersion: first?.protocolVersion ?? null,
          ...(passed.length > 0 || failed[0] === undefined ? {} : { error: failed[0].error }),
        });
      } finally {
        releaseModel();
      }
      return true;
    }

    if (url.pathname === "/api/llm/environment/reload" && method === "POST") {
      this.settings.reloadEnvironment();
      sendBrowserJson(response, 200, "reloadEnvironment", {
        reloaded: true,
        llm: await this.settings.llmPresentation(),
      });
      return true;
    }

    if (url.pathname === "/api/llm/connections/test" && method === "POST") {
      const body = z
        .object({ provider: LlmProviderIdSchema.optional() })
        .parse(await readJsonBody(request));
      const results =
        body.provider === undefined
          ? await this.settings.testConnections()
          : [await this.settings.testProviderConnection(body.provider)];
      sendBrowserJson(response, 200, "testProviderConnection", {
        results,
        llm: await this.settings.llmPresentation(),
      });
      return true;
    }

    if (url.pathname === "/api/llm/models" && method === "POST") {
      const selection = ModelSelectionSchema.parse(await readJsonBody(request));
      const releaseModel = this.reserveModelUse(selection);
      try {
        this.settings.requirePublicSelection(selection);
        const snapshot = await this.settings.modelCatalog.addModel(selection);
        sendBrowserJson(response, 200, "addModel", {
          saved: true,
          defaultModel: snapshot.defaultModel,
        });
      } finally {
        releaseModel();
      }
      return true;
    }

    if (url.pathname === "/api/llm/models" && method === "PUT") {
      const body = ModelEnabledRequestSchema.parse(await readJsonBody(request));
      const selection = this.settings.selection(body);
      const releaseModel = this.reserveModelUse(selection);
      try {
        this.settings.requirePublicSelection(selection);
        const snapshot = await this.settings.modelCatalog.setEnabled(selection, body.enabled);
        sendBrowserJson(response, 200, "setModelEnabled", {
          saved: true,
          defaultModel: snapshot.defaultModel,
        });
      } finally {
        releaseModel();
      }
      return true;
    }

    if (url.pathname === "/api/llm/models" && method === "DELETE") {
      const selection = ModelSelectionSchema.parse(await readJsonBody(request));
      const releaseRemoval = this.reserveModelRemoval(selection);
      try {
        const snapshot = await this.settings.modelSnapshot();
        const registered = snapshot.providers
          .find((provider) => provider.id === selection.provider)
          ?.models.find((model) => model.model === selection.model);
        if (registered === undefined)
          throw new WebApiError(
            404,
            `Model ${selection.provider}/${selection.model} was not found`,
          );
        if (registered.candidate) throw new WebApiError(400, "Known models cannot be removed");
        if (
          snapshot.defaultModel?.provider === selection.provider &&
          snapshot.defaultModel.model === selection.model
        ) {
          throw new WebApiError(409, "Choose a different default model before removing this model");
        }
        const saved = await this.settings.modelCatalog.removeModel(selection, async () => {
          const campaign = (await (await this.catalog()).listCampaigns()).find(
            (entry) =>
              entry.providerConfig?.provider === selection.provider &&
              entry.providerConfig.model === selection.model,
          );
          if (campaign)
            throw new WebApiError(
              409,
              `Model is used by campaign ${campaign.title} and cannot be removed`,
            );
          const draftUsesModel = [...this.drafts.values()].some(
            (draft) =>
              draft.config.provider === selection.provider &&
              draft.config.model === selection.model,
          );
          if (draftUsesModel)
            throw new WebApiError(409, "Model is used by a campaign preview and cannot be removed");
        });
        sendBrowserJson(response, 200, "removeModel", {
          saved: true,
          defaultModel: saved.defaultModel,
        });
      } finally {
        releaseRemoval();
      }
      return true;
    }

    if (url.pathname === "/api/llm/default" && method === "PUT") {
      const selection = ModelSelectionSchema.parse(await readJsonBody(request));
      const releaseModel = this.reserveModelUse(selection);
      try {
        this.settings.requirePublicSelection(selection);
        this.settings.requireProviderKey(selection);
        await this.settings.modelCatalog.setDefault(selection);
        sendBrowserJson(response, 200, "setDefaultModel", {
          saved: true,
          defaultModel: selection,
        });
      } finally {
        releaseModel();
      }
      return true;
    }

    if (url.pathname === "/api/config/world" && method === "GET") {
      const configured = (await loadAppConfig(this.root)).language;
      const language = LanguageCodeSchema.parse(url.searchParams.get("language") ?? configured);
      const profile = await resolveWorldProfile(this.root, language);
      sendBrowserJson(response, 200, "readWorldProfile", {
        language,
        markdown: profile.markdown,
        source: profile.source,
      });
      return true;
    }

    if (url.pathname === "/api/config/world" && method === "PUT") {
      const body = z
        .object({
          language: LanguageCodeSchema.optional(),
          markdown: z.string().min(1).max(INPUT_CHARACTER_LIMITS.worldRules),
        })
        .strict()
        .parse(await readJsonBody(request));
      const language = body.language ?? (await loadAppConfig(this.root)).language;
      await saveWorldProfile(this.root, language, body.markdown);
      sendBrowserJson(response, 200, "saveWorldProfile", {
        saved: true,
        language,
        source: "localized_override",
      });
      return true;
    }

    if (url.pathname === "/api/scenario-seeds" && method === "GET") {
      sendBrowserJson(response, 200, "listScenarioSeeds", {
        seeds: await listScenarioSeeds(this.root),
      });
      return true;
    }

    if (url.pathname.startsWith("/api/scenario-seeds/") && method === "GET") {
      const id = decodeURIComponent(url.pathname.slice("/api/scenario-seeds/".length));
      const configured = (await loadAppConfig(this.root)).language;
      const language = LanguageCodeSchema.parse(url.searchParams.get("language") ?? configured);
      const seed = await loadScenarioSeed(this.root, id, language);
      sendBrowserJson(response, 200, "readScenarioSeed", { seed });
      return true;
    }
    return false;
  }

  private async handleCampaignCreationApi(
    method: string,
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
  ): Promise<boolean> {
    if (url.pathname === "/api/campaigns/draft/detach" && method === "POST") {
      const body = SetupDraftDetachRequestSchema.parse(await readJsonBody(request));
      await this.detachSetupDraft(body.requestId);
      sendBrowserJson(response, 200, "detachDraft", { detached: true });
      return true;
    }

    if (url.pathname === "/api/campaigns/draft" && method === "POST") {
      const body = SetupDraftRequestSchema.parse(await readJsonBody(request));
      const requestId = body.requestId ?? randomUUID();
      this.pruneDetachedSetupRequests();
      if (this.activeSetupDraftRequests.has(requestId) || this.drafts.has(requestId)) {
        throw new WebApiError(409, "Campaign preview request ID is already in use");
      }
      const activeRequest: ActiveSetupDraftRequest = {
        detached:
          this.detachedSetupRequestIds.delete(requestId) || request.aborted || response.destroyed,
      };
      this.activeSetupDraftRequests.set(requestId, activeRequest);
      const markRequestAborted = (): void => {
        activeRequest.detached = true;
        this.drafts.delete(requestId);
      };
      const markResponseClosed = (): void => {
        if (!response.writableFinished) {
          activeRequest.detached = true;
          this.drafts.delete(requestId);
        }
      };
      request.once("aborted", markRequestAborted);
      response.once("close", markResponseClosed);
      let releaseModel: (() => void) | undefined;
      try {
        const language = body.language ?? (await loadAppConfig(this.root)).language;
        const requestedSelection =
          body.config === undefined
            ? this.settings.effectivePublicDefault(await this.settings.modelSnapshot())
            : this.settings.selection(body.config);
        if (requestedSelection === null) {
          throw new WebApiError(
            409,
            "Test a compatible model and choose it as the default before creating a campaign",
          );
        }
        releaseModel = this.reserveModelUse(requestedSelection);
        const config = await this.settings.availableConfig(requestedSelection, language);
        const worldRules =
          body.worldRules ?? (await resolveWorldProfile(this.root, language)).markdown;
        const defaults = campaignSetupDefaults(language);
        const premise = body.premise.trim() || defaults.premise;
        const character = body.character.trim() || defaults.characterConcept;
        const operationId = `draft:${requestId}`;
        const draft = await this.operations.run(operationId, async (): Promise<SetupDraft> => {
          const draftStore = new StateStore(this.setupDraftRoot(requestId));
          const engine = new DungeonEngine(
            draftStore,
            await this.settings.provider(config, language),
          );
          const generated = await engine.generateSetupWithMetadata({
            premise,
            character,
            language,
            worldRules,
          });
          return {
            setup: generated.setup,
            generation: generated.generation,
            language,
            worldRules,
            config,
            premise,
            character,
            spending: await draftStore.spendingController().exportTransferPayload(),
          };
        });
        if (!activeRequest.detached) {
          this.drafts.set(requestId, draft);
          while (this.drafts.size > MAX_DRAFTS) {
            const evicted = this.drafts.keys().next().value!;
            await this.removeSetupDraft(evicted);
          }
        } else {
          await this.removeSetupDraft(requestId);
        }
        const payload: BrowserSetupDraftResponse = {
          draftId: requestId,
          setup: setupPreview(draft.setup),
          config: this.settings.presentedSelection(config),
          language,
        };
        if (!response.destroyed && !response.writableEnded)
          sendBrowserJson(response, 200, "createDraft", payload);
      } finally {
        request.off("aborted", markRequestAborted);
        response.off("close", markResponseClosed);
        if (activeRequest.detached || !this.drafts.has(requestId)) {
          await this.removeSetupDraft(requestId);
        }
        this.activeSetupDraftRequests.delete(requestId);
        releaseModel?.();
      }
      return true;
    }

    if (url.pathname === "/api/campaigns/confirm" && method === "POST") {
      const body = z
        .object({ draftId: z.string().uuid() })
        .strict()
        .parse(await readJsonBody(request));
      const draft = this.drafts.get(body.draftId);
      if (!draft) {
        const replay = await this.confirmedCampaignResponse(body.draftId);
        if (!replay) throw new WebApiError(404, "Campaign draft was not found; generate it again");
        sendBrowserJson(response, 200, "confirmDraft", replay);
        return true;
      }
      let created: Awaited<ReturnType<CampaignCatalog["createCampaign"]>>;
      try {
        created = await this.settings.modelCatalog.withRegisteredModel(
          this.settings.selection(draft.config),
          async () =>
            (await this.catalog()).createCampaign(
              {
                setup: draft.setup,
                openingGeneration: draft.generation,
                language: draft.language,
                worldRules: draft.worldRules,
                setupInput: { premise: draft.premise, character: draft.character },
              },
              {
                providerConfig: draft.config,
                requestId: body.draftId,
                setupSpendingRequestId: body.draftId,
                setupSpending: draft.spending,
              },
            ),
        );
      } catch (error) {
        this.removedModelConflict(error, "the campaign preview was awaiting confirmation");
      }
      if (this.drafts.get(body.draftId) === draft) await this.removeSetupDraft(body.draftId);
      const payload: BrowserCampaignCreatedResponse = {
        state: created.state,
        playerName: draft.setup.player.name,
        openingNarration: draft.setup.openingNarration,
        config: this.settings.presentedSelection(draft.config),
      };
      sendBrowserJson(response, 200, "confirmDraft", payload);
      return true;
    }
    return false;
  }

  private async handleScopedCampaignApi(
    method: string,
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
  ): Promise<boolean> {
    const route = campaignRoute(url.pathname);
    if (!route) return false;
    const { campaignId, action } = route;

    if (action === "status" && method === "GET") {
      const payload: BrowserCampaignStatusResponse = {
        campaign: await this.campaignPresentation(await this.requireSummary(campaignId)),
      };
      sendBrowserJson(response, 200, "campaignStatus", payload);
      return true;
    }

    if (action === "budget" && method === "GET") {
      const summary = await this.requireSummary(campaignId);
      const budget = await (await this.readStore(summary)).campaignBudget();
      sendBrowserJson(response, 200, "campaignBudget", { budget });
      return true;
    }

    if (action === "budget" && method === "PUT") {
      const body = z
        .object({
          campaignUsd: z.number().finite().positive().nullable().optional(),
          logicalTurnUsd: z.number().finite().positive().nullable().optional(),
        })
        .strict()
        .parse(await readJsonBody(request));
      if (this.operations.isBusy(campaignId))
        throw new WebApiError(409, "Another operation is still running for this campaign");
      const budget = await this.operations.run(campaignId, async () => {
        const store = await this.readStore(await this.requireSummary(campaignId));
        return store.updateCampaignBudget({
          ...(body.campaignUsd === undefined ? {} : { campaignUsd: body.campaignUsd }),
          ...(body.logicalTurnUsd === undefined ? {} : { logicalTurnUsd: body.logicalTurnUsd }),
        });
      });
      sendBrowserJson(response, 200, "updateCampaignBudget", { budget });
      return true;
    }

    if (action === "setup" && method === "GET") {
      const summary = await this.requireSummary(campaignId);
      const store = await this.readStore(summary);
      sendBrowserJson(response, 200, "campaignSetup", {
        setup: (await store.campaignStartSettings()) ?? null,
      });
      return true;
    }

    if (action === "story" && method === "GET") {
      if (this.operations.isBusy(campaignId))
        throw new WebApiError(409, "Campaign story is temporarily busy");
      const summary = await this.requireSummary(campaignId);
      const store = await this.readStore(summary);
      sendBrowserJson(
        response,
        200,
        "campaignStory",
        completedStoryResponse(await store.completedStory()),
      );
      return true;
    }

    if (action === "story" && method === "POST") {
      if (this.operations.isBusy(campaignId))
        throw new WebApiError(409, "Another operation is still running for this campaign");
      const artifact = await this.operations.run(campaignId, async () => {
        const summary = await this.requireSummary(campaignId);
        const store = await this.readStore(summary);
        return store.withCampaignLock(async () => {
          const metadata = await readCampaignMetadata(store.dataRoot);
          const manifest = await store.readManifest();
          if (!metadata.archived && manifest.status === "active") {
            throw new WebApiError(
              409,
              "Finish or archive the campaign before generating its short story",
            );
          }
          if (await store.getPending()) {
            throw new WebApiError(
              409,
              "Resolve or discard the pending turn before generating its short story",
            );
          }
          const config = metadata.providerConfig;
          if (!config) {
            throw new WebApiError(
              409,
              "Choose a provider and model for this campaign before generating its short story",
            );
          }
          const engine = new DungeonEngine(
            store,
            await this.settings.provider(config, manifest.language),
          );
          const settledActiveSnapshot = metadata.archived && manifest.status === "active";
          return engine.generateCompletedStory(
            settledActiveSnapshot ? { settledSnapshot: true } : undefined,
          );
        });
      });
      this.costCache.delete(campaignId);
      if (!response.destroyed && !response.writableEnded) {
        sendBrowserJson(response, 200, "generateCampaignStory", completedStoryResponse(artifact));
      }
      return true;
    }

    if (action === "play" && method === "POST") {
      const body = z
        .object({ action: z.string().trim().min(1).max(INPUT_CHARACTER_LIMITS.action) })
        .strict()
        .parse(await readJsonBody(request));
      const result = await this.runCampaign(campaignId, async (engine) => {
        const question = parseQuestionCommand(body.action);
        if (question) return engine.ask(question);
        const appeal = parseAppealCommand(body.action);
        return appeal ? engine.appeal(appeal) : engine.play(body.action);
      });
      this.costCache.delete(campaignId);
      sendBrowserJson(response, 200, "play", playerTurnResponse(result));
      return true;
    }

    if (action === "retry" && method === "POST") {
      const result = await this.runCampaign(campaignId, (engine) => engine.resumePendingTurn());
      this.costCache.delete(campaignId);
      sendBrowserJson(response, 200, "retry", playerTurnResponse(result));
      return true;
    }

    if (action === "discard" && method === "POST") {
      await this.runCampaign(campaignId, async (engine) => {
        await engine.discardPendingTurn();
      });
      sendBrowserJson(response, 200, "discard", { discarded: true });
      return true;
    }

    if (action === "archive" && method === "POST") {
      if (this.operations.isBusy(campaignId))
        throw new WebApiError(409, "Another operation is still running for this campaign");
      await this.operations.run(campaignId, async () => {
        await (await this.catalog()).archiveCampaign(campaignId);
      });
      sendBrowserJson(response, 200, "archiveCampaign", { archived: true });
      return true;
    }

    if (action === "title" && method === "PUT") {
      const body = z
        .object({ title: z.string().trim().min(1).max(200) })
        .strict()
        .parse(await readJsonBody(request));
      if (this.operations.isBusy(campaignId))
        throw new WebApiError(409, "Another operation is still running for this campaign");
      const campaign = await this.operations.run(campaignId, async () =>
        (await this.catalog()).renameCampaign(campaignId, body.title),
      );
      sendBrowserJson(response, 200, "renameCampaign", {
        campaign: await this.campaignPresentation(campaign),
      });
      return true;
    }

    if (action === "delete" && method === "DELETE") {
      const body = z
        .object({ title: z.string().min(1).optional() })
        .strict()
        .parse(await readJsonBody(request));
      if (this.operations.isBusy(campaignId))
        throw new WebApiError(409, "Another operation is still running for this campaign");
      const summary = await this.requireSummary(campaignId);
      if (!summary.archived)
        throw new WebApiError(409, "Archive the campaign before permanently deleting it");
      if (summary.deleteRequiresTitleConfirmation && body.title !== summary.title)
        throw new WebApiError(409, "Campaign title confirmation does not match");
      await this.operations.run(campaignId, async () => {
        await (await this.catalog()).deleteArchivedCampaign(campaignId, body.title);
      });
      this.costCache.delete(campaignId);
      this.stateCache.delete(campaignId);
      sendBrowserJson(response, 200, "deleteCampaign", { deleted: true });
      return true;
    }

    if (action === "config" && method === "PUT") {
      const requested = SetupModelConfigSchema.parse(await readJsonBody(request));
      const selection = this.settings.selection(requested);
      const releaseModel = this.reserveModelUse(selection);
      try {
        if (this.operations.isBusy(campaignId))
          throw new WebApiError(409, "Another operation is still running for this campaign");
        let saved: ProviderConfig;
        try {
          this.settings.requirePublicSelection(selection);
          this.settings.requireProviderKey(selection);
          const config = await this.settings.configForSelection(selection);
          saved = await this.settings.modelCatalog.withRegisteredModel(
            selection,
            async (registration) =>
              this.operations.run(campaignId, async () => {
                const store = await this.activeStore(campaignId);
                if (await store.getPending()) {
                  throw new WebApiError(
                    409,
                    "Resolve or discard the pending turn before changing the model",
                  );
                }
                const manifest = await store.readManifest();
                registration.assertAvailable(manifest.language);
                return (await this.catalog()).updateProviderConfig(campaignId, config);
              }),
          );
        } catch (error) {
          // Campaign state conflicts retain priority over selection errors while
          // the mutating path itself keeps one lock order: model, then campaign.
          const store = await this.activeStore(campaignId);
          if (await store.getPending()) {
            throw new WebApiError(
              409,
              "Resolve or discard the pending turn before changing the model",
            );
          }
          throw error;
        }
        sendBrowserJson(response, 200, "setCampaignModel", {
          config: this.settings.presentedSelection(saved),
        });
      } finally {
        releaseModel();
      }
      return true;
    }

    if (action === "inspect" && method === "GET") {
      const view = url.searchParams.get("view") as StateView | null;
      if (view !== null && !STATE_VIEWS.includes(view))
        throw new WebApiError(400, "Invalid inspection view");
      const summary = await this.requireSummary(campaignId);
      if (this.operations.isBusy(campaignId))
        throw new WebApiError(409, "Campaign state is temporarily busy");
      const state = await this.campaignState(summary);
      if (view === null) {
        sendBrowserJson(response, 200, "campaignInspection", { state });
      } else {
        sendJson(response, 200, { revision: state.revision, inspection: state[view] });
      }
      return true;
    }

    if (action === "transcript" && method === "GET") {
      const summary = await this.requireSummary(campaignId);
      if (this.operations.isBusy(campaignId))
        throw new WebApiError(409, "Campaign transcript is temporarily busy");
      const snapshot = await (await this.readStore(summary)).campaignLogSnapshot();
      sendBrowserJson(response, 200, "campaignTranscript", {
        playerName: snapshot.playerName,
        turns: snapshot.turns,
      });
      return true;
    }

    if (action === "export" && method === "GET") {
      const format = url.searchParams.get("format") ?? "markdown";
      if (!["markdown", "md", "html"].includes(format))
        throw new WebApiError(400, `Unsupported campaign export format: ${format}`);
      const summary = await this.requireSummary(campaignId);
      if (this.operations.isBusy(campaignId))
        throw new WebApiError(409, "Campaign export is temporarily busy");
      const snapshot = await (await this.readStore(summary)).campaignLogSnapshot();
      if (format === "html") {
        sendTextDownload(
          response,
          200,
          renderCampaignHtml(snapshot),
          campaignHtmlFilename(snapshot.state.title),
          "text/html; charset=utf-8",
        );
      } else {
        sendTextDownload(
          response,
          200,
          renderCampaignMarkdown(snapshot),
          campaignMarkdownFilename(snapshot.state.title),
        );
      }
      return true;
    }

    return false;
  }

  async api(request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> {
    const method = request.method ?? "GET";
    if (await this.handleStatusApi(method, response, url)) return;
    if (await this.handleConfigurationApi(method, request, response, url)) return;
    if (await this.handleCampaignCreationApi(method, request, response, url)) return;
    if (await this.handleScopedCampaignApi(method, request, response, url)) return;
    sendJson(response, 404, { error: "Not found" });
  }

  async static(response: ServerResponse, pathname: string): Promise<void> {
    await serveStaticAsset(this.webRoot, response, pathname);
  }
}

export function createDungeonWebServer(options: WebServerOptions): Server {
  const controller = new DungeonWebController(options.root, options);
  const trustedHost = options.host ?? "127.0.0.1";
  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    try {
      if (rejectUntrustedHost(request, response, trustedHost)) return;
      const url = new URL(request.url ?? "/", "http://localhost");
      if (url.pathname.startsWith("/api/")) {
        if (rejectUnsafeMutation(request, response)) return;
        await controller.api(request, response, url);
      } else {
        await controller.static(response, url.pathname);
      }
    } catch (error) {
      if (!response.destroyed && !response.writableEnded) {
        const budgetDetails = campaignBudgetErrorDetails(error);
        sendJson(response, budgetDetails ? 409 : statusFor(error), {
          error: controller.safeError(error),
          ...(budgetDetails ?? {}),
        });
      }
    }
  };
  return createServer((request, response) => {
    void handle(request, response);
  });
}

export async function startDungeonWebServer(
  options: WebServerOptions & { port?: number },
): Promise<Server> {
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 4317;
  const server = createDungeonWebServer(options);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve());
  });
  return server;
}
