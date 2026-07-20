import { createHash } from "node:crypto";
import path from "node:path";
import { PROVIDER_COMPATIBILITY_FINGERPRINT } from "../connection-probe.js";
import { loadProjectEnv, reloadProjectEnv } from "../env.js";
import { LANGUAGES, type LanguageCode } from "../language.js";
import {
  PUBLIC_LLM_PROVIDER_DEFINITIONS,
  RECOMMENDED_MODEL_SELECTION,
  SUPPORTED_LLM_PROVIDER_DEFINITIONS,
  LlmModelCatalog,
  ModelSelectionSchema,
  isRetiredCuratedModel,
  type LlmModelCatalogSnapshot,
  type LlmProviderId,
  type ModelSelection,
} from "../llm-model-catalog.js";
import type { ModelLanguageQualityRatings } from "../model-quality.js";
import { ModelAssessmentCatalog } from "../model-assessment-catalog.js";
import { ModelExecutionProfileStore } from "../model-execution-profile-store.js";
import type { FrozenModelExecutionProfile } from "../model-execution-profile.js";
import {
  modelSpeedEstimate,
  modelSpeedRating,
  type ModelSpeedEstimate,
  type ModelSpeedRating,
} from "../model-speed.js";
import { modelCostRating, type ModelCostRating } from "../model-cost.js";
import type {
  ModelAdapterStatus,
  ModelEvidenceReference,
  ModelLanguageTechnicalStatuses,
  ModelRecommendationEligibility,
} from "../model-status.js";
import { fetchOpenAiModels, type OpenAiModelsFetcher } from "../openai-model-access.js";
import { checkProviderConnection, type ProviderConnectionResult } from "../provider-connection.js";
import { createProvider, loadProviderConfig } from "../providers.js";
import { ProviderConfigSchema, type ProviderConfig } from "../schemas.js";
import {
  fetchOpenRouterPrices,
  OpenRouterPricingCatalog,
  type FiftyTurnEstimateBasis,
  type ModelPriceEstimate,
} from "../pricing.js";
import type { LlmProvider } from "../types.js";
import { asError, WebApiError } from "./http.js";

export type ProviderFactory = (
  config: ProviderConfig,
  environment: NodeJS.ProcessEnv,
  executionProfile?: FrozenModelExecutionProfile,
) => LlmProvider;
export type BrowserModelSelection = Pick<ProviderConfig, "provider" | "model">;
export type ProviderConnectionTester = (provider: LlmProviderId, apiKey: string) => Promise<ProviderConnectionResult>;
export type ProviderConnectionStatus = "unknown" | "connected" | "failed";

export interface ModelSettingsOptions {
  environment?: NodeJS.ProcessEnv;
  providerFactory?: ProviderFactory;
  pricingFetcher?: (() => Promise<unknown>) | false;
  openAiModelsFetcher?: OpenAiModelsFetcher | false;
  connectionTester?: ProviderConnectionTester;
}

/**
 * Owns every piece of LLM/model-settings state for the Web application:
 * session keys, connection statuses, catalogs, execution profiles, pricing,
 * and their presentation. Campaign lifecycle state stays with the controller;
 * routes access this state only through these methods.
 */
export class ModelSettingsService {
  readonly providerConfigPath: string;
  readonly modelCatalog: LlmModelCatalog;
  private readonly environment: NodeJS.ProcessEnv;
  private projectEnvKeys: string[];
  private readonly providerFactory: ProviderFactory;
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

  constructor(private readonly root: string, options: ModelSettingsOptions = {}) {
    this.providerConfigPath = path.join(root, "config", "provider.json");
    this.environment = options.environment ?? process.env;
    this.projectEnvKeys = loadProjectEnv(root, this.environment);
    this.providerFactory = options.providerFactory ?? ((config, environment, executionProfile) => createProvider(
      config,
      environment,
      fetch,
      executionProfile ? { executionProfile } : {},
    ));
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

  /** Build a provider without an execution profile, e.g. for compatibility probes. */
  bareProvider(config: ProviderConfig): LlmProvider {
    return this.providerFactory(config, this.effectiveEnvironment());
  }

  /** Store or clear a session-scoped provider key and drop stale caches. */
  setSessionKey(provider: LlmProviderId, key: string): void {
    if (key) this.sessionKeys.set(provider, key);
    else this.sessionKeys.delete(provider);
    this.connectionStatuses.delete(provider);
    if (provider === "openai") this.openAiModelAccessCache = undefined;
  }

  /** Re-read .env and invalidate connection state for keys that changed. */
  reloadEnvironment(): void {
    const previousEnvironment = this.effectiveEnvironment();
    this.projectEnvKeys = reloadProjectEnv(this.root, this.environment, this.projectEnvKeys);
    const nextEnvironment = this.effectiveEnvironment();
    for (const provider of PUBLIC_LLM_PROVIDER_DEFINITIONS) {
      if (previousEnvironment[provider.envKey]?.trim() !== nextEnvironment[provider.envKey]?.trim()) {
        this.connectionStatuses.delete(provider.id);
      }
    }
    this.openAiModelAccessCache = undefined;
  }

  /** Probe every configured provider key and record per-key connection status. */
  async testConnections(): Promise<ProviderConnectionResult[]> {
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
    return results;
  }

  effectiveEnvironment(): NodeJS.ProcessEnv {
    const environment = { ...this.environment };
    for (const provider of SUPPORTED_LLM_PROVIDER_DEFINITIONS) {
      const sessionKey = this.sessionKeys.get(provider.id);
      if (sessionKey) environment[provider.envKey] = sessionKey;
    }
    return environment;
  }

  async defaultConfig(): Promise<ProviderConfig> {
    return loadProviderConfig(this.providerConfigPath);
  }

  async provider(config: ProviderConfig, language: LanguageCode): Promise<LlmProvider> {
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

  keyStatus(): Record<string, boolean> {
    const environment = this.effectiveEnvironment();
    return Object.fromEntries(SUPPORTED_LLM_PROVIDER_DEFINITIONS.map((provider) => [
      provider.id,
      Boolean(environment[provider.envKey]),
    ]));
  }

  selection(config: Pick<ProviderConfig, "provider" | "model">): ModelSelection {
    return ModelSelectionSchema.parse({ provider: config.provider, model: config.model });
  }

  presentedSelection(config: Pick<ProviderConfig, "provider" | "model">): BrowserModelSelection {
    return { provider: config.provider, model: config.model };
  }

  async modelSnapshot(): Promise<LlmModelCatalogSnapshot> {
    // config/provider.json remains terminal configuration, not a second
    // authority for the browser model catalog. Campaign-owned legacy models
    // are projected by the campaign response and synthesized by the UI.
    return this.modelCatalog.snapshot();
  }

  keyFingerprint(apiKey: string): string {
    return createHash("sha256").update(apiKey).digest("hex");
  }

  connectionStatus(provider: LlmProviderId, apiKey: string | undefined): ProviderConnectionStatus {
    const key = apiKey?.trim();
    if (!key) return "unknown";
    const checked = this.connectionStatuses.get(provider);
    return checked?.keyFingerprint === this.keyFingerprint(key) ? checked.status : "unknown";
  }

  isPublicSelection(selection: ModelSelection): boolean {
    return PUBLIC_LLM_PROVIDER_DEFINITIONS.some((provider) => provider.id === selection.provider)
      && !isRetiredCuratedModel(selection);
  }

  requirePublicSelection(selection: ModelSelection): void {
    if (!this.isPublicSelection(selection)) {
      throw new WebApiError(400, `Model ${selection.provider}/${selection.model} is retained for legacy use only`);
    }
  }

  effectivePublicDefault(snapshot: LlmModelCatalogSnapshot): ModelSelection | null {
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

  async presentedAssessment(selection: ModelSelection): Promise<{
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

  async openAiModelAccess(): Promise<ReadonlySet<string> | undefined> {
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

  async llmPresentation(): Promise<{
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

  requireProviderKey(selection: ModelSelection): void {
    const definition = SUPPORTED_LLM_PROVIDER_DEFINITIONS.find((provider) => provider.id === selection.provider);
    if (!definition || !this.effectiveEnvironment()[definition.envKey]) {
      const keyName = definition?.envKey ?? "the provider API key";
      throw new WebApiError(
        409,
        `Configure ${keyName} in Settings, or add it to .env and reload it in Settings`,
      );
    }
  }

  async configForSelection(selection: ModelSelection): Promise<ProviderConfig> {
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

  async availableConfig(selection: ModelSelection, language: LanguageCode): Promise<ProviderConfig> {
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
}
