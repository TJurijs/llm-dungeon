import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import path from "node:path";
import { z } from "zod";
import { CampaignCatalog, type CampaignCatalogSummary } from "./campaign-catalog.js";
import { campaignMarkdownFilename, renderCampaignMarkdown } from "./campaign-export.js";
import { probeProviderConnection } from "./connection-probe.js";
import { DungeonEngine } from "./engine.js";
import { campaignSetupDefaults, LANGUAGES, LanguageCodeSchema, loadAppConfig, saveAppConfig, type LanguageCode } from "./language.js";
import { parseAppealCommand } from "./appeal.js";
import { readCampaignMetadata } from "./persistence/campaign-catalog.js";
import { LlmProviderIdSchema, ModelSelectionSchema } from "./llm-model-catalog.js";
import type { OpenAiModelsFetcher } from "./openai-model-access.js";
import { parseQuestionCommand } from "./question.js";
import {
  ProviderConfigSchema,
  SafeIdSchema,
  type GameState,
  type ProviderConfig,
  type SetupResult,
} from "./schemas.js";
import { StateStore } from "./store.js";
import type { CampaignCostSummary } from "./campaign-cost.js";
import type { GenerationMetadata, StateView } from "./types.js";
import { resolveWorldProfile, saveWorldProfile } from "./world-profile.js";
import { CampaignOperationCoordinator } from "./web/campaign-operations.js";
import { asError, readJsonBody, rejectUnsafeMutation, rejectUntrustedHost, sendJson, sendTextDownload, statusFor, WebApiError } from "./web/http.js";
import { serveStaticAsset } from "./web/static-assets.js";
import {
  ModelSettingsService,
  type BrowserModelSelection,
  type ProviderConnectionTester,
  type ProviderFactory,
} from "./web/model-settings.js";
import { pendingStatus, playerTurnResponse, setupPreview } from "./web/presentation.js";

export type { ProviderFactory, ProviderConnectionTester } from "./web/model-settings.js";

export interface WebServerOptions {
  root: string;
  host?: string;
  environment?: NodeJS.ProcessEnv;
  providerFactory?: ProviderFactory;
  maxConcurrentCampaignOperations?: number;
  pricingFetcher?: (() => Promise<unknown>) | false;
  openAiModelsFetcher?: OpenAiModelsFetcher | false;
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
}

interface CampaignPresentation extends Omit<CampaignCatalogSummary, "providerConfig"> {
  busy: boolean;
  pending: unknown;
  campaignCost: CampaignCostSummary | null;
  config: BrowserModelSelection | null;
}

const SetupModelConfigSchema = z.union([
  ModelSelectionSchema,
  ProviderConfigSchema.strict(),
]);

const SetupDraftRequestSchema = z.object({
  premise: z.string().max(100_000).default(""),
  character: z.string().max(100_000).default(""),
  language: LanguageCodeSchema.optional(),
  worldRules: z.string().min(1).max(500_000).optional(),
  config: SetupModelConfigSchema.optional(),
}).strict();

const ModelEnabledRequestSchema = ModelSelectionSchema.extend({ enabled: z.boolean() }).strict();
const ModelTestRequestSchema = ModelSelectionSchema.extend({ language: LanguageCodeSchema.optional() }).strict();
const SessionProviderKeyRequestSchema = z.object({
  provider: LlmProviderIdSchema,
  key: z.string().max(10_000),
}).strict();

const STATE_VIEWS: StateView[] = ["character", "location", "threads"];
const MAX_DRAFTS = 20;

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
  const match = /^\/api\/campaigns\/([^/]+)\/(status|play|retry|discard|archive|delete|inspect|transcript|export|config|setup|title)$/.exec(pathname);
  if (!match) return undefined;
  return { campaignId: decodeCampaignId(match[1]!), action: match[2]! };
}

export class DungeonWebController {
  readonly dataRoot: string;
  readonly webRoot: string;
  readonly settings: ModelSettingsService;
  private readonly operations: CampaignOperationCoordinator;
  private readonly drafts = new Map<string, SetupDraft>();
  private readonly costCache = new Map<string, { updatedAt: string; cost: CampaignCostSummary }>();
  private campaignCatalog: CampaignCatalog | undefined;

  constructor(readonly root: string, options: Omit<WebServerOptions, "root"> = {}) {
    this.dataRoot = path.join(root, "data");
    this.webRoot = path.join(root, "web");
    this.settings = new ModelSettingsService(root, options);
    this.operations = new CampaignOperationCoordinator(options.maxConcurrentCampaignOperations ?? 3);
  }

  safeError(error: unknown, fallback?: string): string {
    return this.settings.safeError(error, fallback);
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
    const summary = (await (await this.catalog()).listCampaigns())
      .find((candidate) => candidate.campaignId === campaignId);
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

  private async campaignCost(summary: CampaignCatalogSummary, store: StateStore): Promise<CampaignCostSummary | null> {
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

  private async campaignPresentation(summary: CampaignCatalogSummary): Promise<CampaignPresentation> {
    const store = await this.readStore(summary);
    const { providerConfig, ...manifest } = summary;
    return {
      ...manifest,
      busy: this.operations.isBusy(summary.campaignId),
      pending: pendingStatus(await store.getPending()),
      campaignCost: await this.campaignCost(summary, store),
      config: providerConfig === undefined ? null : this.settings.presentedSelection(providerConfig),
    };
  }

  private async activeStore(campaignId: string): Promise<StateStore> {
    const summary = await this.requireSummary(campaignId);
    if (summary.archived) throw new WebApiError(409, `Campaign ${campaignId} is archived and cannot be resumed`);
    return (await this.catalog()).openCampaign(campaignId);
  }

  private async confirmedCampaignResponse(requestId: string): Promise<{
    state: GameState;
    playerName: string;
    openingNarration: string;
    config: BrowserModelSelection | null;
  } | undefined> {
    const catalog = await this.catalog();
    const created = await catalog.findCampaignByCreationRequest(requestId);
    if (created === undefined) return undefined;
    const snapshot = await created.store.campaignLogSnapshot();
    const opening = snapshot.turns.find((turn) => turn.turn === 0);
    return {
      state: created.state,
      playerName: snapshot.playerName,
      openingNarration: opening?.narration ?? "",
      config: await catalog.providerConfig(created.campaignId).then((config) => (
        config === undefined ? null : this.settings.presentedSelection(config)
      )),
    };
  }

  private async runCampaign<T>(campaignId: string, operation: (engine: DungeonEngine, store: StateStore) => Promise<T>): Promise<T> {
    if (this.operations.isBusy(campaignId)) {
      throw new WebApiError(409, "Another operation is still running for this campaign");
    }
    try {
      return await this.operations.run(campaignId, async () => {
        const store = await this.activeStore(campaignId);
        return store.withCampaignLock(async () => {
          const metadata = await readCampaignMetadata(store.dataRoot);
          if (metadata.archived) throw new WebApiError(409, `Campaign ${campaignId} is archived and cannot be resumed`);
          const config = metadata.providerConfig;
          if (!config) throw new WebApiError(409, "Choose a provider and model for this campaign before playing");
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

  private async handleStatusApi(method: string, response: ServerResponse, url: URL): Promise<boolean> {
    if (method !== "GET" || url.pathname !== "/api/status") return false;
    const config = await this.settings.defaultConfig().catch(() => null);
    const presentedConfig = config === null ? null : this.settings.presentedSelection(config);
    const language = (await loadAppConfig(this.root)).language;
    const summaries = await (await this.catalog()).listCampaigns();
    const llm = await this.settings.llmPresentation();
    sendJson(response, 200, {
      language,
      languages: Object.entries(LANGUAGES).map(([code, value]) => ({
        code,
        name: value.nativeName,
        setupDefaults: value.setupDefaults,
      })),
      config: presentedConfig,
      defaults: { language, config: presentedConfig },
      keyStatus: this.settings.keyStatus(),
      llm,
      campaigns: await Promise.all(summaries.map((summary) => this.campaignPresentation(summary))),
    });
    return true;
  }

  private async handleConfigurationApi(
    method: string,
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
  ): Promise<boolean> {
    if (url.pathname === "/api/config/language" && method === "PUT") {
      const body = z.object({ language: LanguageCodeSchema }).strict().parse(await readJsonBody(request));
      await saveAppConfig(this.root, { language: body.language });
      sendJson(response, 200, { language: body.language });
      return true;
    }

    if (url.pathname === "/api/llm" && method === "GET") {
      sendJson(response, 200, { llm: await this.settings.llmPresentation() });
      return true;
    }

    if (url.pathname === "/api/llm/keys" && method === "PUT") {
      const body = SessionProviderKeyRequestSchema.parse(await readJsonBody(request));
      this.settings.setSessionKey(body.provider, body.key.trim());
      sendJson(response, 200, { llm: await this.settings.llmPresentation() });
      return true;
    }

    if (url.pathname === "/api/llm/models/test" && method === "POST") {
      const body = ModelTestRequestSchema.parse(await readJsonBody(request));
      const selection = this.settings.selection(body);
      this.settings.requirePublicSelection(selection);
      const languages = body.language === undefined
        ? Object.keys(LANGUAGES) as LanguageCode[]
        : [body.language];
      this.settings.requireProviderKey(selection);
      const config = await this.settings.configForSelection(selection);
      const operationId = `probe:${randomUUID()}`;
      const provider = this.settings.bareProvider(config);
      const passed: LanguageCode[] = [];
      const failed: Array<{ language: LanguageCode; error: string }> = [];
      const results: Awaited<ReturnType<typeof probeProviderConnection>>[] = [];
      await this.operations.run(operationId, async () => {
        for (const language of languages) {
          try {
            const result = await probeProviderConnection(provider, [language]);
            await this.settings.modelCatalog.recordTestSuccess(selection, { testedLanguages: [language] });
            passed.push(language);
            results.push(result);
          } catch (error) {
            const summary = this.safeError(error, "Provider compatibility test failed");
            await this.settings.modelCatalog.recordTestFailure(selection, {
              failedLanguages: [language],
              failureSummary: summary,
            });
            failed.push({ language, error: summary });
          }
        }
      });
      const first = results[0];
      sendJson(response, 200, {
        ok: passed.length > 0,
        provider: first?.provider ?? selection.provider,
        model: first?.model ?? selection.model,
        ...(body.language === undefined ? {} : { language: body.language }),
        usage: results.length === 1 ? results[0]?.usage ?? null : null,
        testedLanguages: passed,
        failedLanguages: failed.map((result) => result.language),
        failures: failed,
        protocolVersion: first?.protocolVersion ?? null,
        ...(passed.length > 0 || failed[0] === undefined ? {} : { error: failed[0].error }),
      });
      return true;
    }

    if (url.pathname === "/api/llm/environment/reload" && method === "POST") {
      this.settings.reloadEnvironment();
      sendJson(response, 200, { reloaded: true, llm: await this.settings.llmPresentation() });
      return true;
    }

    if (url.pathname === "/api/llm/connections/test" && method === "POST") {
      const results = await this.settings.testConnections();
      sendJson(response, 200, { results, llm: await this.settings.llmPresentation() });
      return true;
    }

    if (url.pathname === "/api/llm/models" && method === "POST") {
      const selection = ModelSelectionSchema.parse(await readJsonBody(request));
      this.settings.requirePublicSelection(selection);
      const snapshot = await this.settings.modelCatalog.addModel(selection);
      sendJson(response, 200, { saved: true, defaultModel: snapshot.defaultModel });
      return true;
    }

    if (url.pathname === "/api/llm/models" && method === "PUT") {
      const body = ModelEnabledRequestSchema.parse(await readJsonBody(request));
      const selection = this.settings.selection(body);
      this.settings.requirePublicSelection(selection);
      const snapshot = await this.settings.modelCatalog.setEnabled(selection, body.enabled);
      sendJson(response, 200, { saved: true, defaultModel: snapshot.defaultModel });
      return true;
    }

    if (url.pathname === "/api/llm/models" && method === "DELETE") {
      const selection = ModelSelectionSchema.parse(await readJsonBody(request));
      const snapshot = await this.settings.modelSnapshot();
      const registered = snapshot.providers
        .find((provider) => provider.id === selection.provider)
        ?.models.find((model) => model.model === selection.model);
      if (registered === undefined) throw new WebApiError(404, `Model ${selection.provider}/${selection.model} was not found`);
      if (registered.candidate) throw new WebApiError(400, "Known models cannot be removed");
      if (snapshot.defaultModel?.provider === selection.provider && snapshot.defaultModel.model === selection.model) {
        throw new WebApiError(409, "Choose a different default model before removing this model");
      }
      const campaign = (await (await this.catalog()).listCampaigns()).find((entry) =>
        entry.providerConfig?.provider === selection.provider && entry.providerConfig.model === selection.model);
      if (campaign) throw new WebApiError(409, `Model is used by campaign ${campaign.title} and cannot be removed`);
      const draftUsesModel = [...this.drafts.values()].some((draft) =>
        draft.config.provider === selection.provider && draft.config.model === selection.model);
      if (draftUsesModel) throw new WebApiError(409, "Model is used by a campaign preview and cannot be removed");
      const saved = await this.settings.modelCatalog.removeModel(selection);
      sendJson(response, 200, { saved: true, defaultModel: saved.defaultModel });
      return true;
    }

    if (url.pathname === "/api/llm/default" && method === "PUT") {
      const selection = ModelSelectionSchema.parse(await readJsonBody(request));
      this.settings.requirePublicSelection(selection);
      this.settings.requireProviderKey(selection);
      await this.settings.modelCatalog.setDefault(selection);
      sendJson(response, 200, { saved: true, defaultModel: selection });
      return true;
    }

    if (url.pathname === "/api/config/world" && method === "GET") {
      const configured = (await loadAppConfig(this.root)).language;
      const language = LanguageCodeSchema.parse(url.searchParams.get("language") ?? configured);
      const profile = await resolveWorldProfile(this.root, language);
      sendJson(response, 200, { language, markdown: profile.markdown, source: profile.source });
      return true;
    }

    if (url.pathname === "/api/config/world" && method === "PUT") {
      const body = z.object({
        language: LanguageCodeSchema.optional(),
        markdown: z.string().min(1).max(500_000),
      }).strict().parse(await readJsonBody(request));
      const language = body.language ?? (await loadAppConfig(this.root)).language;
      await saveWorldProfile(this.root, language, body.markdown);
      sendJson(response, 200, { saved: true, language, source: "localized_override" });
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
    if (url.pathname === "/api/campaigns/draft" && method === "POST") {
      const body = SetupDraftRequestSchema.parse(await readJsonBody(request));
      const language = body.language ?? (await loadAppConfig(this.root)).language;
      const requestedSelection = body.config === undefined
        ? this.settings.effectivePublicDefault(await this.settings.modelSnapshot())
        : this.settings.selection(body.config);
      if (requestedSelection === null) {
        throw new WebApiError(409, "Test a compatible model and choose it as the default before creating a campaign");
      }
      const config = await this.settings.availableConfig(requestedSelection, language);
      const worldRules = body.worldRules ?? (await resolveWorldProfile(this.root, language)).markdown;
      const defaults = campaignSetupDefaults(language);
      const premise = body.premise.trim() || defaults.premise;
      const character = body.character.trim() || defaults.characterConcept;
      const operationId = `draft:${randomUUID()}`;
      const draft = await this.operations.run(operationId, async (): Promise<SetupDraft> => {
        const engine = new DungeonEngine(
          new StateStore(path.join(this.dataRoot, ".drafts", operationId)),
          await this.settings.provider(config, language),
        );
        const generated = await engine.generateSetupWithMetadata({
          premise,
          character,
          language,
          worldRules,
        });
        return { setup: generated.setup, generation: generated.generation, language, worldRules, config, premise, character };
      });
      const draftId = randomUUID();
      this.drafts.set(draftId, draft);
      while (this.drafts.size > MAX_DRAFTS) this.drafts.delete(this.drafts.keys().next().value!);
      sendJson(response, 200, {
        draftId,
        setup: setupPreview(draft.setup),
        config: this.settings.presentedSelection(config),
        language,
      });
      return true;
    }

    if (url.pathname === "/api/campaigns/confirm" && method === "POST") {
      const body = z.object({ draftId: z.string().uuid() }).strict().parse(await readJsonBody(request));
      const draft = this.drafts.get(body.draftId);
      if (!draft) {
        const replay = await this.confirmedCampaignResponse(body.draftId);
        if (!replay) throw new WebApiError(404, "Campaign draft was not found; generate it again");
        sendJson(response, 200, replay);
        return true;
      }
      const created = await (await this.catalog()).createCampaign({
        setup: draft.setup,
        openingGeneration: draft.generation,
        language: draft.language,
        worldRules: draft.worldRules,
        setupInput: { premise: draft.premise, character: draft.character },
      }, {
        providerConfig: draft.config,
        requestId: body.draftId,
      });
      if (this.drafts.get(body.draftId) === draft) this.drafts.delete(body.draftId);
      sendJson(response, 200, {
        state: created.state,
        playerName: draft.setup.player.name,
        openingNarration: draft.setup.openingNarration,
        config: this.settings.presentedSelection(draft.config),
      });
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
      sendJson(response, 200, { campaign: await this.campaignPresentation(await this.requireSummary(campaignId)) });
      return true;
    }

    if (action === "setup" && method === "GET") {
      const summary = await this.requireSummary(campaignId);
      const store = await this.readStore(summary);
      sendJson(response, 200, { setup: await store.campaignStartSettings() ?? null });
      return true;
    }

    if (action === "play" && method === "POST") {
      const body = z.object({ action: z.string().trim().min(1).max(10_000) }).strict().parse(await readJsonBody(request));
      const result = await this.runCampaign(campaignId, async (engine) => {
        const question = parseQuestionCommand(body.action);
        if (question) return engine.ask(question);
        const appeal = parseAppealCommand(body.action);
        return appeal ? engine.appeal(appeal) : engine.play(body.action);
      });
      this.costCache.delete(campaignId);
      sendJson(response, 200, playerTurnResponse(result));
      return true;
    }

    if (action === "retry" && method === "POST") {
      const result = await this.runCampaign(campaignId, (engine) => engine.resumePendingTurn());
      this.costCache.delete(campaignId);
      sendJson(response, 200, playerTurnResponse(result));
      return true;
    }

    if (action === "discard" && method === "POST") {
      await this.runCampaign(campaignId, async (engine) => { await engine.discardPendingTurn(); });
      sendJson(response, 200, { discarded: true });
      return true;
    }

    if (action === "archive" && method === "POST") {
      if (this.operations.isBusy(campaignId)) throw new WebApiError(409, "Another operation is still running for this campaign");
      await this.operations.run(campaignId, async () => { await (await this.catalog()).archiveCampaign(campaignId); });
      sendJson(response, 200, { archived: true });
      return true;
    }

    if (action === "title" && method === "PUT") {
      const body = z.object({ title: z.string().trim().min(1).max(200) }).strict().parse(await readJsonBody(request));
      if (this.operations.isBusy(campaignId)) throw new WebApiError(409, "Another operation is still running for this campaign");
      const campaign = await this.operations.run(campaignId, async () =>
        (await this.catalog()).renameCampaign(campaignId, body.title));
      sendJson(response, 200, { campaign: await this.campaignPresentation(campaign) });
      return true;
    }

    if (action === "delete" && method === "DELETE") {
      const body = z.object({ title: z.string().min(1) }).strict().parse(await readJsonBody(request));
      if (this.operations.isBusy(campaignId)) throw new WebApiError(409, "Another operation is still running for this campaign");
      const summary = await this.requireSummary(campaignId);
      if (!summary.archived) throw new WebApiError(409, "Archive the campaign before permanently deleting it");
      if (body.title !== summary.title) throw new WebApiError(409, "Campaign title confirmation does not match");
      await this.operations.run(campaignId, async () => { await (await this.catalog()).deleteArchivedCampaign(campaignId); });
      this.costCache.delete(campaignId);
      sendJson(response, 200, { deleted: true });
      return true;
    }

    if (action === "config" && method === "PUT") {
      const requested = SetupModelConfigSchema.parse(await readJsonBody(request));
      const selection = this.settings.selection(requested);
      if (this.operations.isBusy(campaignId)) throw new WebApiError(409, "Another operation is still running for this campaign");
      const saved = await this.operations.run(campaignId, async () => {
        const store = await this.activeStore(campaignId);
        if (await store.getPending()) {
          throw new WebApiError(409, "Resolve or discard the pending turn before changing the model");
        }
        const manifest = await store.readManifest();
        const config = await this.settings.availableConfig(selection, manifest.language);
        const catalog = await this.catalog();
        return catalog.updateProviderConfig(campaignId, config);
      });
      sendJson(response, 200, { config: this.settings.presentedSelection(saved) });
      return true;
    }

    if (action === "inspect" && method === "GET") {
      const view = url.searchParams.get("view") as StateView | null;
      if (!view || !STATE_VIEWS.includes(view)) throw new WebApiError(400, "Invalid inspection view");
      const summary = await this.requireSummary(campaignId);
      if (this.operations.isBusy(campaignId)) throw new WebApiError(409, "Campaign state is temporarily busy");
      const inspection = await (await this.readStore(summary)).inspect(view);
      sendJson(response, 200, { inspection });
      return true;
    }

    if (action === "transcript" && method === "GET") {
      const summary = await this.requireSummary(campaignId);
      if (this.operations.isBusy(campaignId)) throw new WebApiError(409, "Campaign transcript is temporarily busy");
      const snapshot = await (await this.readStore(summary)).campaignLogSnapshot();
      sendJson(response, 200, { playerName: snapshot.playerName, turns: snapshot.turns });
      return true;
    }

    if (action === "export" && method === "GET") {
      const format = url.searchParams.get("format") ?? "markdown";
      if (format !== "markdown") throw new WebApiError(400, `Unsupported campaign export format: ${format}`);
      const summary = await this.requireSummary(campaignId);
      if (this.operations.isBusy(campaignId)) throw new WebApiError(409, "Campaign export is temporarily busy");
      const snapshot = await (await this.readStore(summary)).campaignLogSnapshot();
      sendTextDownload(
        response,
        200,
        renderCampaignMarkdown(snapshot),
        campaignMarkdownFilename(snapshot.state.title),
      );
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
      sendJson(response, statusFor(error), { error: controller.safeError(error) });
    }
  };
  return createServer((request, response) => { void handle(request, response); });
}

export async function startDungeonWebServer(options: WebServerOptions & { port?: number }): Promise<Server> {
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 4317;
  const server = createDungeonWebServer(options);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve());
  });
  return server;
}
