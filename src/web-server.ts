import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import path from "node:path";
import { z } from "zod";
import { CampaignCatalog, type CampaignCatalogSummary } from "./campaign-catalog.js";
import { campaignMarkdownFilename, renderCampaignMarkdown } from "./campaign-export.js";
import {
  PROVIDER_COMPATIBILITY_FINGERPRINT,
  probeProviderConnection,
} from "./connection-probe.js";
import { DungeonEngine } from "./engine.js";
import { loadProjectEnv, reloadProjectEnv } from "./env.js";
import { campaignSetupDefaults, LANGUAGES, LanguageCodeSchema, loadAppConfig, saveAppConfig, type LanguageCode } from "./language.js";
import { parseAppealCommand } from "./appeal.js";
import { readCampaignMetadata } from "./persistence/campaign-catalog.js";
import { createProvider, loadProviderConfig } from "./providers.js";
import {
  PUBLIC_LLM_PROVIDER_DEFINITIONS,
  RECOMMENDED_MODEL_SELECTION,
  SUPPORTED_LLM_PROVIDER_DEFINITIONS,
  LlmProviderIdSchema,
  LlmModelCatalog,
  ModelSelectionSchema,
  isRetiredCuratedModel,
  type LlmModelCatalogSnapshot,
  type LlmProviderId,
  type ModelSelection,
} from "./llm-model-catalog.js";
import type { ModelLanguageQualityRatings } from "./model-quality.js";
import { ModelAssessmentCatalog } from "./model-assessment-catalog.js";
import { ModelExecutionProfileStore } from "./model-execution-profile-store.js";
import type { FrozenModelExecutionProfile } from "./model-execution-profile.js";
import {
  modelSpeedEstimate,
  modelSpeedRating,
  type ModelSpeedEstimate,
  type ModelSpeedRating,
} from "./model-speed.js";
import { modelCostRating, type ModelCostRating } from "./model-cost.js";
import type {
  ModelAdapterStatus,
  ModelEvidenceReference,
  ModelLanguageTechnicalStatuses,
  ModelRecommendationEligibility,
} from "./model-status.js";
import { fetchOpenAiModels, type OpenAiModelsFetcher } from "./openai-model-access.js";
import { checkProviderConnection, type ProviderConnectionResult } from "./provider-connection.js";
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
import {
  fetchOpenRouterPrices,
  OpenRouterPricingCatalog,
  type FiftyTurnEstimateBasis,
  type ModelPriceEstimate,
} from "./pricing.js";
import type { GenerationMetadata, LlmProvider, StateView } from "./types.js";
import { resolveWorldProfile, saveWorldProfile } from "./world-profile.js";
import { CampaignOperationCoordinator } from "./web/campaign-operations.js";
import { asError, readJsonBody, rejectUnsafeMutation, rejectUntrustedHost, sendJson, sendTextDownload } from "./web/http.js";
import { pendingStatus, playerTurnResponse, setupPreview } from "./web/presentation.js";

type ProviderFactory = (
  config: ProviderConfig,
  environment: NodeJS.ProcessEnv,
  executionProfile?: FrozenModelExecutionProfile,
) => LlmProvider;
type BrowserModelSelection = Pick<ProviderConfig, "provider" | "model">;
type ProviderConnectionTester = (provider: LlmProviderId, apiKey: string) => Promise<ProviderConnectionResult>;
type ProviderConnectionStatus = "unknown" | "connected" | "failed";

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

class WebApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "WebApiError";
  }
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

function statusFor(error: unknown): number {
  if (error instanceof WebApiError) return error.status;
  if (error instanceof z.ZodError) return 400;
  const message = asError(error);
  if (/was not found/i.test(message)) return 404;
  if (/locked by another running process|another operation is still running|archived and cannot|read-only|unfinished request|uncommitted turn|campaign has ended/i.test(message)) {
    return 409;
  }
  return 400;
}

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
  readonly providerConfigPath: string;
  readonly dataRoot: string;
  readonly webRoot: string;
  private readonly environment: NodeJS.ProcessEnv;
  private projectEnvKeys: string[];
  private readonly providerFactory: ProviderFactory;
  private readonly operations: CampaignOperationCoordinator;
  private readonly modelCatalog: LlmModelCatalog;
  private readonly modelAssessments: ModelAssessmentCatalog;
  private readonly executionProfiles: ModelExecutionProfileStore;
  private readonly modelPricing: OpenRouterPricingCatalog;
  private readonly openAiModelsFetcher: OpenAiModelsFetcher | undefined;
  private readonly connectionTester: ProviderConnectionTester;
  private openAiModelAccessCache: {
    apiKey: string;
    allowedModels: ReadonlySet<string> | undefined;
    expiresAt: number;
  } | undefined;
  private readonly sessionKeys = new Map<LlmProviderId, string>();
  private readonly connectionStatuses = new Map<LlmProviderId, { keyFingerprint: string; status: Exclude<ProviderConnectionStatus, "unknown"> }>();
  private readonly drafts = new Map<string, SetupDraft>();
  private readonly costCache = new Map<string, { updatedAt: string; cost: CampaignCostSummary }>();
  private campaignCatalog: CampaignCatalog | undefined;

  constructor(readonly root: string, options: Omit<WebServerOptions, "root"> = {}) {
    this.providerConfigPath = path.join(root, "config", "provider.json");
    this.dataRoot = path.join(root, "data");
    this.webRoot = path.join(root, "web");
    this.environment = options.environment ?? process.env;
    this.projectEnvKeys = loadProjectEnv(root, this.environment);
    this.providerFactory = options.providerFactory ?? ((config, environment, executionProfile) => createProvider(
      config,
      environment,
      fetch,
      executionProfile ? { executionProfile } : {},
    ));
    this.operations = new CampaignOperationCoordinator(options.maxConcurrentCampaignOperations ?? 3);
    this.modelCatalog = new LlmModelCatalog(root, {
      testFingerprint: PROVIDER_COMPATIBILITY_FINGERPRINT,
    });
    this.modelAssessments = new ModelAssessmentCatalog(root);
    this.executionProfiles = new ModelExecutionProfileStore(root);
    const pricingFetcher = options.pricingFetcher === false
      ? undefined
      : options.pricingFetcher ?? (options.environment === undefined ? () => fetchOpenRouterPrices() : undefined);
    this.modelPricing = new OpenRouterPricingCatalog(pricingFetcher);
    this.openAiModelsFetcher = options.openAiModelsFetcher === false
      ? undefined
      : options.openAiModelsFetcher ?? (options.environment === undefined ? fetchOpenAiModels : undefined);
    this.connectionTester = options.connectionTester ?? checkProviderConnection;
  }

  private effectiveEnvironment(): NodeJS.ProcessEnv {
    const environment = { ...this.environment };
    for (const provider of SUPPORTED_LLM_PROVIDER_DEFINITIONS) {
      const sessionKey = this.sessionKeys.get(provider.id);
      if (sessionKey) environment[provider.envKey] = sessionKey;
    }
    return environment;
  }

  private async defaultConfig(): Promise<ProviderConfig> {
    return loadProviderConfig(this.providerConfigPath);
  }

  private async provider(config: ProviderConfig, language: LanguageCode): Promise<LlmProvider> {
    const route = config.provider === "openrouter" ? "openrouter" : "direct";
    const profile = await this.executionProfiles.get({
      provider: config.provider,
      model: config.model,
      route,
    });
    const assessment = profile === undefined
      ? undefined
      : await this.modelAssessments.effective({
        provider: config.provider,
        model: config.model,
        route,
      }, language);
    const currentProfile = assessment?.adapterStatus === "calibrated"
      && assessment.profileFingerprint === profile?.fingerprint
      ? profile
      : undefined;
    return this.providerFactory(config, this.effectiveEnvironment(), currentProfile);
  }

  private async catalog(): Promise<CampaignCatalog> {
    if (!this.campaignCatalog) {
      const defaultProviderConfig = await this.defaultConfig().catch(() => undefined);
      this.campaignCatalog = new CampaignCatalog(this.dataRoot, {
        ...(defaultProviderConfig === undefined ? {} : { defaultProviderConfig }),
      });
      await this.campaignCatalog.ensureReady();
    }
    return this.campaignCatalog;
  }

  private keyStatus(): Record<string, boolean> {
    const environment = this.effectiveEnvironment();
    return Object.fromEntries(SUPPORTED_LLM_PROVIDER_DEFINITIONS.map((provider) => [
      provider.id,
      Boolean(environment[provider.envKey]),
    ]));
  }

  private selection(config: Pick<ProviderConfig, "provider" | "model">): ModelSelection {
    return ModelSelectionSchema.parse({ provider: config.provider, model: config.model });
  }

  private presentedSelection(config: Pick<ProviderConfig, "provider" | "model">): BrowserModelSelection {
    return { provider: config.provider, model: config.model };
  }

  private async modelSnapshot(): Promise<LlmModelCatalogSnapshot> {
    // config/provider.json remains terminal configuration, not a second
    // authority for the browser model catalog. Campaign-owned legacy models
    // are projected by the campaign response and synthesized by the UI.
    return this.modelCatalog.snapshot();
  }

  private keyFingerprint(apiKey: string): string {
    return createHash("sha256").update(apiKey).digest("hex");
  }

  private connectionStatus(provider: LlmProviderId, apiKey: string | undefined): ProviderConnectionStatus {
    const key = apiKey?.trim();
    if (!key) return "unknown";
    const checked = this.connectionStatuses.get(provider);
    return checked?.keyFingerprint === this.keyFingerprint(key) ? checked.status : "unknown";
  }

  private isPublicSelection(selection: ModelSelection): boolean {
    return PUBLIC_LLM_PROVIDER_DEFINITIONS.some((provider) => provider.id === selection.provider)
      && !isRetiredCuratedModel(selection);
  }

  private requirePublicSelection(selection: ModelSelection): void {
    if (!this.isPublicSelection(selection)) {
      throw new WebApiError(400, `Model ${selection.provider}/${selection.model} is retained for legacy use only`);
    }
  }

  private effectivePublicDefault(snapshot: LlmModelCatalogSnapshot): ModelSelection | null {
    const available = (selection: ModelSelection | null): selection is ModelSelection => {
      if (selection === null || !this.isPublicSelection(selection)) return false;
      const model = snapshot.providers
        .find((provider) => provider.id === selection.provider)
        ?.models.find((candidate) => candidate.model === selection.model);
      return model?.enabled === true && (
        model.state === "compatible"
        || (model.state === "untested"
          && selection.provider === RECOMMENDED_MODEL_SELECTION.provider
          && selection.model === RECOMMENDED_MODEL_SELECTION.model)
      );
    };
    if (available(snapshot.defaultModel)) return snapshot.defaultModel;
    return available(RECOMMENDED_MODEL_SELECTION) ? RECOMMENDED_MODEL_SELECTION : null;
  }

  private async presentedAssessment(selection: ModelSelection): Promise<{
    adapterStatus: ModelAdapterStatus;
    technicalStatus: ModelLanguageTechnicalStatuses;
    technicalRecoveries: Partial<Record<LanguageCode, number>>;
    quality: ModelLanguageQualityRatings;
    recommendationEligibility: ModelRecommendationEligibility;
    evidence: ModelEvidenceReference[];
    certificationCurrent: Partial<Record<LanguageCode, boolean>>;
    profileFingerprint?: string;
  }> {
    const languages = Object.keys(LANGUAGES) as LanguageCode[];
    const route = selection.provider === "openrouter" ? "openrouter" : "direct";
    const assessments = await Promise.all(languages.map(async (language) => ({
      language,
      assessment: await this.modelAssessments.effective({
        provider: selection.provider,
        model: selection.model,
        route,
      }, language),
    })));
    const first = assessments[0]?.assessment;
    const eligible = assessments.length > 0
      && assessments.every(({ assessment }) => assessment.recommendation.eligible);
    const reasons = [...new Set(assessments.flatMap(({ assessment }) => assessment.recommendation.reasons))];
    const evidence = [...new Map(
      assessments.flatMap(({ assessment }) => assessment.evidence)
        .map((item) => [JSON.stringify(item), item]),
    ).values()];
    const recommendationEvidence = assessments
      .map(({ assessment }) => assessment.recommendation.evidence)
      .find((item) => item !== undefined);
    return {
      adapterStatus: first?.adapterStatus ?? "uncalibrated",
      technicalStatus: Object.fromEntries(assessments.map(({ language, assessment }) => [
        language,
        assessment.technicalStatus,
      ])) as ModelLanguageTechnicalStatuses,
      technicalRecoveries: Object.fromEntries(assessments.map(({ language, assessment }) => [
        language,
        assessment.recoveryCount,
      ])),
      quality: Object.fromEntries(assessments.map(({ language, assessment }) => [
        language,
        assessment.qualityStatus,
      ])) as ModelLanguageQualityRatings,
      recommendationEligibility: {
        eligible,
        reasons,
        ...(recommendationEvidence === undefined ? {} : { evidence: recommendationEvidence }),
      },
      evidence,
      certificationCurrent: Object.fromEntries(assessments.map(({ language, assessment }) => [
        language,
        assessment.certificationCurrent,
      ])),
      ...(first?.profileFingerprint === undefined ? {} : { profileFingerprint: first.profileFingerprint }),
    };
  }

  private async openAiModelAccess(): Promise<ReadonlySet<string> | undefined> {
    const apiKey = this.effectiveEnvironment().OPENAI_API_KEY?.trim();
    if (!apiKey || !this.openAiModelsFetcher) return undefined;
    const cached = this.openAiModelAccessCache;
    if (cached?.apiKey === apiKey && cached.expiresAt > Date.now()) return cached.allowedModels;
    try {
      const allowedModels = await this.openAiModelsFetcher(apiKey);
      this.openAiModelAccessCache = {
        apiKey,
        allowedModels: new Set(allowedModels),
        expiresAt: Date.now() + 30_000,
      };
      return this.openAiModelAccessCache.allowedModels;
    } catch {
      // Discovery is advisory. A missing key or provider error must not make a model look denied.
      this.openAiModelAccessCache = { apiKey, allowedModels: undefined, expiresAt: Date.now() + 30_000 };
      return undefined;
    }
  }

  private async llmPresentation(): Promise<{
    defaultModel: ModelSelection | null;
    pricingBasis: FiftyTurnEstimateBasis;
    providers: Array<{
      id: string;
      label: string;
      envKey: string;
      recommended: boolean;
      keyPresent: boolean;
      keySource: "session" | "environment" | "missing";
      keyConnectionStatus: ProviderConnectionStatus;
      models: Array<{
        id: string;
        label: string;
        compatibilityStatus: string;
        status: string;
        adapterStatus: ModelAdapterStatus;
        technicalStatus: ModelLanguageTechnicalStatuses;
        technicalRecoveries: Partial<Record<LanguageCode, number>>;
        enabled: boolean;
        available: boolean;
        known: boolean;
        testedLanguages: LanguageCode[];
        failedLanguages: LanguageCode[];
        pricing?: ModelPriceEstimate;
        quality: ModelLanguageQualityRatings;
        speed?: ModelSpeedRating;
        speedEstimate?: ModelSpeedEstimate;
        cost?: ModelCostRating;
        recommended: boolean;
        recommendationEligibility: ModelRecommendationEligibility;
        evidence: {
          compatibility: {
            testedAt: string;
            protocolVersion: number;
            fingerprint: string;
          } | null;
          assessment: ModelEvidenceReference[];
          certificationCurrent: Partial<Record<LanguageCode, boolean>>;
          profileFingerprint?: string;
        };
        hidden: boolean;
        keyAccess?: "allowed" | "not_allowed";
        error?: string;
      }>;
    }>;
  }> {
    const snapshot = await this.modelSnapshot();
    const keys = this.keyStatus();
    const environment = this.effectiveEnvironment();
    const openAiModels = await this.openAiModelAccess();
    this.modelPricing.refreshInBackground();
    return {
      defaultModel: this.effectivePublicDefault(snapshot),
      pricingBasis: this.modelPricing.basis(),
      providers: await Promise.all(snapshot.providers.filter((provider) => provider.public).map(async (provider) => ({
        id: provider.id,
        label: provider.label,
        envKey: provider.envKey,
        recommended: provider.recommended,
        keyPresent: Boolean(keys[provider.id]),
        keySource: this.sessionKeys.has(provider.id)
          ? "session"
          : keys[provider.id] ? "environment" : "missing",
        keyConnectionStatus: this.connectionStatus(provider.id, environment[provider.envKey]),
        models: await Promise.all(provider.models.map(async (model) => {
          const pricing = this.modelPricing.estimate(provider.id, model.model);
          const speed = modelSpeedRating(provider.id, model.model);
          const speedEstimate = modelSpeedEstimate(provider.id, model.model);
          const cost = modelCostRating(pricing);
          const assessment = await this.presentedAssessment(model);
          return {
            id: model.model,
            label: model.model,
            compatibilityStatus: model.state,
            status: model.state,
            adapterStatus: assessment.adapterStatus,
            technicalStatus: assessment.technicalStatus,
            technicalRecoveries: assessment.technicalRecoveries,
            enabled: model.enabled,
            available: model.state === "compatible" && model.enabled && Boolean(keys[provider.id]),
            known: model.candidate,
            testedLanguages: model.test?.testedLanguages ?? [],
            failedLanguages: model.test?.failedLanguages ?? [],
            recommended: provider.id === RECOMMENDED_MODEL_SELECTION.provider
              && model.model === RECOMMENDED_MODEL_SELECTION.model,
            recommendationEligibility: assessment.recommendationEligibility,
            evidence: {
              compatibility: model.test === undefined ? null : {
                testedAt: model.test.testedAt,
                protocolVersion: model.test.protocolVersion,
                fingerprint: model.test.testFingerprint,
              },
              assessment: assessment.evidence,
              certificationCurrent: assessment.certificationCurrent,
              ...(assessment.profileFingerprint === undefined
                ? {}
                : { profileFingerprint: assessment.profileFingerprint }),
            },
            hidden: isRetiredCuratedModel(model),
            ...(provider.id !== "openai" || openAiModels === undefined
              ? {}
              : { keyAccess: openAiModels.has(model.model) ? "allowed" as const : "not_allowed" as const }),
            ...(pricing === undefined ? {} : { pricing }),
            quality: assessment.quality,
            ...(speed === undefined ? {} : { speed }),
            ...(speedEstimate === undefined ? {} : { speedEstimate }),
            ...(cost === undefined ? {} : { cost }),
            ...(model.test?.failureSummary === undefined
              ? {}
              : { error: this.safeError(model.test.failureSummary, "Provider compatibility test failed") }),
          };
        })),
      }))),
    };
  }

  private requireProviderKey(selection: ModelSelection): void {
    const definition = SUPPORTED_LLM_PROVIDER_DEFINITIONS.find((provider) => provider.id === selection.provider);
    if (!definition || !this.effectiveEnvironment()[definition.envKey]) {
      const keyName = definition?.envKey ?? "the provider API key";
      throw new WebApiError(
        409,
        `Configure ${keyName} in Settings, or add it to .env and reload it in Settings`,
      );
    }
  }

  private async configForSelection(selection: ModelSelection): Promise<ProviderConfig> {
    const parsed = ModelSelectionSchema.parse(selection);
    const current = await this.defaultConfig().catch(() => undefined);
    return ProviderConfigSchema.parse({
      provider: parsed.provider,
      model: parsed.model,
      temperature: current?.temperature ?? 0.8,
      maxOutputTokens: current?.maxOutputTokens ?? 4_000,
      ...(current?.provider === parsed.provider && current.endpoint !== undefined
        ? { endpoint: current.endpoint }
        : {}),
    });
  }

  private async availableConfig(selection: ModelSelection, language: LanguageCode): Promise<ProviderConfig> {
    const parsed = ModelSelectionSchema.parse(selection);
    this.requirePublicSelection(parsed);
    await this.modelCatalog.assertAvailable(parsed, language);
    this.requireProviderKey(parsed);
    return this.configForSelection(parsed);
  }

  safeError(error: unknown, fallback = "Request failed"): string {
    let message = asError(error);
    const environment = this.effectiveEnvironment();
    for (const definition of SUPPORTED_LLM_PROVIDER_DEFINITIONS) {
      const key = environment[definition.envKey];
      if (key) {
        message = message.replaceAll(key, "[redacted]");
        try {
          message = message.replaceAll(encodeURIComponent(key), "[redacted]");
        } catch {
          // Environment strings can contain invalid surrogate pairs.
        }
      }
    }
    const resolvedRoot = path.resolve(this.root);
    if (path.dirname(resolvedRoot) !== resolvedRoot) {
      message = message.replaceAll(resolvedRoot, "[project]");
    }
    message = message.replace(/https?:\/\/[^\s"'<>]+/gi, (value) => {
      try {
        const url = new URL(value);
        if (!url.username && !url.password && !url.search && !url.hash) return value;
        return `${url.protocol}//${url.host}${url.pathname}${url.search ? "?[redacted]" : ""}${url.hash ? "#[redacted]" : ""}`;
      } catch {
        return value;
      }
    });
    return message.replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 500)
      || fallback;
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
      config: providerConfig === undefined ? null : this.presentedSelection(providerConfig),
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
        config === undefined ? null : this.presentedSelection(config)
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
          const engine = new DungeonEngine(store, await this.provider(config, language));
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
    const config = await this.defaultConfig().catch(() => null);
    const presentedConfig = config === null ? null : this.presentedSelection(config);
    const language = (await loadAppConfig(this.root)).language;
    const summaries = await (await this.catalog()).listCampaigns();
    const llm = await this.llmPresentation();
    sendJson(response, 200, {
      language,
      languages: Object.entries(LANGUAGES).map(([code, value]) => ({
        code,
        name: value.nativeName,
        setupDefaults: value.setupDefaults,
      })),
      config: presentedConfig,
      defaults: { language, config: presentedConfig },
      keyStatus: this.keyStatus(),
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
      sendJson(response, 200, { llm: await this.llmPresentation() });
      return true;
    }

    if (url.pathname === "/api/llm/keys" && method === "PUT") {
      const body = SessionProviderKeyRequestSchema.parse(await readJsonBody(request));
      const key = body.key.trim();
      if (key) this.sessionKeys.set(body.provider, key);
      else this.sessionKeys.delete(body.provider);
      this.connectionStatuses.delete(body.provider);
      if (body.provider === "openai") this.openAiModelAccessCache = undefined;
      sendJson(response, 200, { llm: await this.llmPresentation() });
      return true;
    }

    if (url.pathname === "/api/llm/models/test" && method === "POST") {
      const body = ModelTestRequestSchema.parse(await readJsonBody(request));
      const selection = this.selection(body);
      this.requirePublicSelection(selection);
      const languages = body.language === undefined
        ? Object.keys(LANGUAGES) as LanguageCode[]
        : [body.language];
      this.requireProviderKey(selection);
      const config = await this.configForSelection(selection);
      const operationId = `probe:${randomUUID()}`;
      const provider = this.providerFactory(config, this.effectiveEnvironment());
      const passed: LanguageCode[] = [];
      const failed: Array<{ language: LanguageCode; error: string }> = [];
      const results: Awaited<ReturnType<typeof probeProviderConnection>>[] = [];
      await this.operations.run(operationId, async () => {
        for (const language of languages) {
          try {
            const result = await probeProviderConnection(provider, [language]);
            await this.modelCatalog.recordTestSuccess(selection, { testedLanguages: [language] });
            passed.push(language);
            results.push(result);
          } catch (error) {
            const summary = this.safeError(error, "Provider compatibility test failed");
            await this.modelCatalog.recordTestFailure(selection, {
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
      const previousEnvironment = this.effectiveEnvironment();
      this.projectEnvKeys = reloadProjectEnv(this.root, this.environment, this.projectEnvKeys);
      const nextEnvironment = this.effectiveEnvironment();
      for (const provider of PUBLIC_LLM_PROVIDER_DEFINITIONS) {
        if (previousEnvironment[provider.envKey]?.trim() !== nextEnvironment[provider.envKey]?.trim()) {
          this.connectionStatuses.delete(provider.id);
        }
      }
      this.openAiModelAccessCache = undefined;
      sendJson(response, 200, { reloaded: true, llm: await this.llmPresentation() });
      return true;
    }

    if (url.pathname === "/api/llm/connections/test" && method === "POST") {
      const environment = this.effectiveEnvironment();
      const checks = PUBLIC_LLM_PROVIDER_DEFINITIONS
        .filter((provider) => Boolean(environment[provider.envKey]?.trim()))
        .map((provider) => ({ provider, apiKey: environment[provider.envKey]!.trim() }));
      const results = await Promise.all(checks.map(({ provider, apiKey }) => this.connectionTester(provider.id, apiKey)));
      if (!results.length) throw new WebApiError(409, "Configure at least one provider API key before checking connections");
      for (const [index, result] of results.entries()) {
        const check = checks[index]!;
        this.connectionStatuses.set(result.provider, {
          keyFingerprint: this.keyFingerprint(check.apiKey),
          status: result.status === "connected" ? "connected" : "failed",
        });
      }
      sendJson(response, 200, { results, llm: await this.llmPresentation() });
      return true;
    }

    if (url.pathname === "/api/llm/models" && method === "POST") {
      const selection = ModelSelectionSchema.parse(await readJsonBody(request));
      this.requirePublicSelection(selection);
      const snapshot = await this.modelCatalog.addModel(selection);
      sendJson(response, 200, { saved: true, defaultModel: snapshot.defaultModel });
      return true;
    }

    if (url.pathname === "/api/llm/models" && method === "PUT") {
      const body = ModelEnabledRequestSchema.parse(await readJsonBody(request));
      const selection = this.selection(body);
      this.requirePublicSelection(selection);
      const snapshot = await this.modelCatalog.setEnabled(selection, body.enabled);
      sendJson(response, 200, { saved: true, defaultModel: snapshot.defaultModel });
      return true;
    }

    if (url.pathname === "/api/llm/models" && method === "DELETE") {
      const selection = ModelSelectionSchema.parse(await readJsonBody(request));
      const snapshot = await this.modelSnapshot();
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
      const saved = await this.modelCatalog.removeModel(selection);
      sendJson(response, 200, { saved: true, defaultModel: saved.defaultModel });
      return true;
    }

    if (url.pathname === "/api/llm/default" && method === "PUT") {
      const selection = ModelSelectionSchema.parse(await readJsonBody(request));
      this.requirePublicSelection(selection);
      this.requireProviderKey(selection);
      await this.modelCatalog.setDefault(selection);
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
        ? this.effectivePublicDefault(await this.modelSnapshot())
        : this.selection(body.config);
      if (requestedSelection === null) {
        throw new WebApiError(409, "Test a compatible model and choose it as the default before creating a campaign");
      }
      const config = await this.availableConfig(requestedSelection, language);
      const worldRules = body.worldRules ?? (await resolveWorldProfile(this.root, language)).markdown;
      const defaults = campaignSetupDefaults(language);
      const premise = body.premise.trim() || defaults.premise;
      const character = body.character.trim() || defaults.characterConcept;
      const operationId = `draft:${randomUUID()}`;
      const draft = await this.operations.run(operationId, async (): Promise<SetupDraft> => {
        const engine = new DungeonEngine(
          new StateStore(path.join(this.dataRoot, ".drafts", operationId)),
          await this.provider(config, language),
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
        config: this.presentedSelection(config),
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
        config: this.presentedSelection(draft.config),
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
      const selection = this.selection(requested);
      if (this.operations.isBusy(campaignId)) throw new WebApiError(409, "Another operation is still running for this campaign");
      const saved = await this.operations.run(campaignId, async () => {
        const store = await this.activeStore(campaignId);
        if (await store.getPending()) {
          throw new WebApiError(409, "Resolve or discard the pending turn before changing the model");
        }
        const manifest = await store.readManifest();
        const config = await this.availableConfig(selection, manifest.language);
        const catalog = await this.catalog();
        return catalog.updateProviderConfig(campaignId, config);
      });
      sendJson(response, 200, { config: this.presentedSelection(saved) });
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
    const files: Record<string, { name: string; type: string }> = {
      "/": { name: "index.html", type: "text/html; charset=utf-8" },
      "/index.html": { name: "index.html", type: "text/html; charset=utf-8" },
      "/app.js": { name: "app.js", type: "text/javascript; charset=utf-8" },
      "/ui-copy.js": { name: "ui-copy.js", type: "text/javascript; charset=utf-8" },
      "/ui-utils.js": { name: "ui-utils.js", type: "text/javascript; charset=utf-8" },
      "/chat-ui.js": { name: "chat-ui.js", type: "text/javascript; charset=utf-8" },
      "/inspection-ui.js": { name: "inspection-ui.js", type: "text/javascript; charset=utf-8" },
      "/setup-settings.js": { name: "setup-settings.js", type: "text/javascript; charset=utf-8" },
      "/terminal-history.js": { name: "terminal-history.js", type: "text/javascript; charset=utf-8" },
      "/styles.css": { name: "styles.css", type: "text/css; charset=utf-8" },
    };
    const asset = files[pathname];
    if (!asset) { sendJson(response, 404, { error: "Not found" }); return; }
    const content = await readFile(path.join(this.webRoot, asset.name));
    response.writeHead(200, {
      "Content-Type": asset.type,
      "Cache-Control": "no-cache",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'",
    });
    response.end(content);
  }
}

export function createDungeonWebServer(options: WebServerOptions): Server {
  const controller = new DungeonWebController(options.root, options);
  const trustedHost = options.host ?? "127.0.0.1";
  return createServer(async (request, response) => {
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
  });
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
