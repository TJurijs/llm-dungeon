import path from "node:path";
import * as p from "@clack/prompts";
import { CampaignCatalog, type CampaignCatalogSummary } from "../campaign-catalog.js";
import { DungeonEngine } from "../engine.js";
import { loadProjectEnv } from "../env.js";
import { loadAppConfig, saveAppConfig, type LanguageCode } from "../language.js";
import { PROVIDER_COMPATIBILITY_FINGERPRINT } from "../connection-probe.js";
import { probeProviderConnection } from "../connection-probe.js";
import { LlmModelCatalog, ModelUnavailableError } from "../llm-model-catalog.js";
import { ModelAssessmentCatalog } from "../model-assessment-catalog.js";
import { ModelExecutionProfileStore } from "../model-execution-profile-store.js";
import type { FrozenModelExecutionProfile, ModelExecutionProfileDraft } from "../model-execution-profile.js";
import {
  calibrateModel as calibratePlaytestModel,
  createUnifiedPlaytestRunner,
  resolvePlaytestTarget as resolveFrozenPlaytestTarget,
  type CalibrateModelResult,
  type PlaytestModelTarget,
  type PlaytestProgressEvent,
  type PlaytestRunner,
} from "../playtest.js";
import { createProvider as createLlmProvider, loadProviderConfig } from "../providers.js";
import { ProviderConfigSchema, type ProviderConfig } from "../schemas.js";
import { inferTokenPrice } from "../pricing.js";
import {
  PlaytestCostManager,
  estimatePlaytestCost,
  estimatePlaytestReservation,
} from "../playtest/cost.js";
import { StateStore } from "../store.js";
import { atomicWriteJson } from "../persistence/files.js";
import type {
  GameEngine,
  LlmProvider,
  NewGameInput,
  StructuredRequest,
  StructuredResult,
} from "../types.js";
import { resolveWorldProfile, saveWorldProfile, type ResolvedWorldProfile } from "../world-profile.js";
import { takePrompt } from "./prompt.js";

export interface CliProjectPaths {
  root: string;
  providerConfig: string;
  dataRoot: string;
  evaluationsRoot: string;
  playtestsRoot?: string;
}

export interface CliCampaignSession {
  campaignId: string;
  engine: GameEngine;
}

export interface CliSetupSession {
  config: ProviderConfig;
  engine: GameEngine;
}

class CompatibilityCostProvider implements LlmProvider {
  readonly id: string;
  readonly model: string;

  constructor(
    private readonly base: LlmProvider,
    private readonly cost: PlaytestCostManager,
    private readonly price: { inputPerMillion: number; outputPerMillion: number },
  ) {
    this.id = base.id;
    this.model = base.model;
  }

  async generateStructured<T>(request: StructuredRequest<T>): Promise<StructuredResult<T>> {
    const estimate = estimatePlaytestReservation(request as StructuredRequest<unknown>, this.price);
    const reservation = await this.cost.acquire(estimate);
    try {
      const result = await this.base.generateStructured(request);
      this.cost.commit(reservation, estimatePlaytestCost(result.usage, this.price, estimate));
      return result;
    } catch (error) {
      this.cost.commit(reservation, estimate);
      throw error;
    }
  }
}

function projectPaths(root: string): CliProjectPaths {
  const resolvedRoot = path.resolve(root);
  return {
    root: resolvedRoot,
    providerConfig: path.join(resolvedRoot, "config", "provider.json"),
    dataRoot: path.join(resolvedRoot, "data"),
    evaluationsRoot: path.join(resolvedRoot, "evaluations"),
    playtestsRoot: path.join(resolvedRoot, "playtests"),
  };
}

export class CliProjectContext {
  constructor(
    readonly paths: CliProjectPaths,
    private readonly environment: NodeJS.ProcessEnv = process.env,
  ) {}

  async configureProvider(): Promise<ProviderConfig> {
    p.intro("llm-dungeon provider setup");
    const provider = takePrompt(
      await p.select({
        message: "Choose a provider",
        options: [
          { value: "gemini", label: "Google Gemini", hint: "recommended · GEMINI_API_KEY" },
          { value: "openrouter", label: "OpenRouter", hint: "OPENROUTER_API_KEY" },
          { value: "xai", label: "xAI", hint: "XAI_API_KEY" },
          { value: "openai", label: "OpenAI", hint: "OPENAI_API_KEY" },
          { value: "deepseek", label: "DeepSeek", hint: "DEEPSEEK_API_KEY · strict-schema test required" },
        ],
      }),
    ) as ProviderConfig["provider"];
    const model = takePrompt(
      await p.text({
        message: "Model ID",
        placeholder: "google/gemini-3.5-flash (recommended)",
        validate: (value) => (value.trim() ? undefined : "A model ID is required"),
      }),
    );
    const providerModel = provider === "gemini" && model.startsWith("google/gemini-")
      ? model.slice("google/".length)
      : model;
    const config = ProviderConfigSchema.parse({
      provider,
      model: providerModel,
      temperature: 0.8,
      maxOutputTokens: 4000,
    });
    await this.assertTerminalModelAvailable(config);
    if (providerModel === "gemini-3.5-flash" || providerModel === "google/gemini-3.5-flash") {
      p.log.success("gemini-3.5-flash is the playtested, recommended DM model.");
    } else if (providerModel === "gemini-3.1-flash-lite" || providerModel === "google/gemini-3.1-flash-lite") {
      p.log.info("gemini-3.1-flash-lite is playtested as the simulated player; the DM baseline uses gemini-3.5-flash.");
    } else {
      p.log.warn("This model is unverified. It may reject the enforced schemas or behave differently in play.");
    }
    await atomicWriteJson(this.paths.providerConfig, config);
    const keyName: Record<ProviderConfig["provider"], string> = {
      gemini: "GEMINI_API_KEY",
      openrouter: "OPENROUTER_API_KEY",
      xai: "XAI_API_KEY",
      openai: "OPENAI_API_KEY",
      anthropic: "ANTHROPIC_API_KEY",
      deepseek: "DEEPSEEK_API_KEY",
    };
    if (this.environment[keyName[provider]]) p.log.success(`${keyName[provider]} is present.`);
    else p.log.warn(`${keyName[provider]} is not set. Add it to .env before starting a game.`);
    p.outro(`Saved ${path.relative(this.paths.root, this.paths.providerConfig)}`);
    return config;
  }

  async providerConfig(): Promise<ProviderConfig> {
    const config = await this.savedProviderConfig();
    if (config === undefined) return this.configureProvider();
    await this.assertTerminalModelAvailable(config);
    return config;
  }

  private async savedProviderConfig(): Promise<ProviderConfig | undefined> {
    try {
      return await loadProviderConfig(this.paths.providerConfig);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return undefined;
    }
  }

  createProvider(
    config: ProviderConfig,
    executionProfile?: FrozenModelExecutionProfile,
  ): LlmProvider {
    return createLlmProvider(
      config,
      this.environment,
      fetch,
      executionProfile ? { executionProfile } : {},
    );
  }

  playtestsRoot(): string {
    return path.resolve(this.paths.playtestsRoot ?? path.join(this.paths.root, "playtests"));
  }

  executionProfiles(): ModelExecutionProfileStore {
    return new ModelExecutionProfileStore(this.paths.root);
  }

  modelAssessments(): ModelAssessmentCatalog {
    return new ModelAssessmentCatalog(this.paths.root);
  }

  private async calibratedExecutionProfile(
    config: ProviderConfig,
    language: LanguageCode,
  ): Promise<FrozenModelExecutionProfile | undefined> {
    const route = config.provider === "openrouter" ? "openrouter" : "direct";
    const profile = await this.executionProfiles().get({
      provider: config.provider,
      model: config.model,
      route,
    });
    if (!profile) return undefined;
    const assessment = await this.modelAssessments().effective({
      provider: config.provider,
      model: config.model,
      route,
    }, language);
    return assessment.adapterStatus === "calibrated"
      && assessment.profileFingerprint === profile.fingerprint
      ? profile
      : undefined;
  }

  async resolvePlaytestTarget(
    config: ProviderConfig,
    route?: string,
    cost?: { inputPerMillion: number; outputPerMillion: number },
  ): Promise<PlaytestModelTarget> {
    return resolveFrozenPlaytestTarget(this.executionProfiles(), config, route, cost);
  }

  async calibrateModel(
    config: ProviderConfig,
    options: {
      maxCostUsd: number;
      route?: string | undefined;
      variants?: readonly ModelExecutionProfileDraft[] | undefined;
      evidenceId?: string | undefined;
      cost?: { inputPerMillion: number; outputPerMillion: number } | undefined;
    },
  ): Promise<CalibrateModelResult> {
    return calibratePlaytestModel({
      projectRoot: this.paths.root,
      playtestsRoot: this.playtestsRoot(),
      config,
      environment: this.environment,
      ...options,
    });
  }

  async probeModelCompatibility(
    config: ProviderConfig,
    languages: readonly LanguageCode[],
    maxCostUsd: number,
  ): Promise<{ passed: LanguageCode[]; failed: Array<{ language: LanguageCode; error: string }>; costUsd: number }> {
    const route = config.provider === "openrouter" ? "openrouter" : "direct";
    const profile = await this.executionProfiles().require({
      provider: config.provider,
      model: config.model,
      route,
    });
    const price = inferTokenPrice(config.provider, config.model);
    if (!price) throw new Error(`No built-in token price for ${config.provider}/${config.model}`);
    const cost = new PlaytestCostManager(maxCostUsd);
    const provider = new CompatibilityCostProvider(this.createProvider(config, profile), cost, price);
    const catalog = new LlmModelCatalog(this.paths.root, {
      testFingerprint: PROVIDER_COMPATIBILITY_FINGERPRINT,
    });
    const passed: LanguageCode[] = [];
    const failed: Array<{ language: LanguageCode; error: string }> = [];
    for (const language of languages) {
      try {
        await probeProviderConnection(provider, [language]);
        await catalog.recordTestSuccess(
          { provider: config.provider, model: config.model },
          { testedLanguages: [language] },
        );
        passed.push(language);
      } catch (error) {
        const summary = (error instanceof Error ? error.message : "Provider compatibility test failed")
          .replace(/[\r\n\t]+/gu, " ").replace(/\s+/gu, " ").trim().slice(0, 500);
        await catalog.recordTestFailure({ provider: config.provider, model: config.model }, {
          failedLanguages: [language],
          failureSummary: summary || "Provider compatibility test failed",
        });
        failed.push({ language, error: summary || "Provider compatibility test failed" });
      }
    }
    return { passed, failed, costUsd: cost.spentUsd };
  }

  createPlaytestRunner(onProgress?: (event: PlaytestProgressEvent) => void): PlaytestRunner {
    return createUnifiedPlaytestRunner({
      projectRoot: this.paths.root,
      playtestsRoot: this.playtestsRoot(),
      environment: this.environment,
      ...(onProgress ? { onProgress } : {}),
    });
  }

  private async campaignCatalog(defaultProviderConfig?: ProviderConfig): Promise<CampaignCatalog> {
    const config = defaultProviderConfig ?? await this.savedProviderConfig();
    return new CampaignCatalog(this.paths.dataRoot, config === undefined
      ? {}
      : { defaultProviderConfig: config });
  }

  async campaigns(): Promise<CampaignCatalogSummary[]> {
    return (await this.campaignCatalog()).listCampaigns();
  }

  async createEngine(campaignId: string): Promise<GameEngine> {
    const catalog = await this.campaignCatalog();
    const store = await catalog.openCampaign(campaignId);
    let config = await catalog.providerConfig(campaignId);
    if (!config) {
      config = await this.providerConfig();
      await catalog.updateProviderConfig(campaignId, config);
    }
    const language = (await store.readManifest()).language;
    return new DungeonEngine(
      store,
      this.createProvider(config, await this.calibratedExecutionProfile(config, language)),
    );
  }

  async createCampaignSession(input: NewGameInput, config?: ProviderConfig): Promise<CliCampaignSession> {
    const selectedConfig = ProviderConfigSchema.parse(config ?? await this.providerConfig());
    const campaignLanguage = input.language ?? await this.language();
    await this.assertTerminalModelAvailable(selectedConfig, campaignLanguage);
    const created = await (await this.campaignCatalog(selectedConfig)).createCampaign(input, {
      providerConfig: selectedConfig,
    });
    return {
      campaignId: created.campaignId,
      engine: new DungeonEngine(
        created.store,
        this.createProvider(
          selectedConfig,
          await this.calibratedExecutionProfile(selectedConfig, campaignLanguage),
        ),
      ),
    };
  }

  async createSetupSession(): Promise<CliSetupSession> {
    const config = await this.providerConfig();
    const language = await this.language();
    // Setup generation does not read or mutate campaign state. The disposable
    // store keeps the engine boundary intact without reserving a campaign that
    // the user may reject during preview.
    return {
      config,
      engine: new DungeonEngine(
        new StateStore(path.join(this.paths.dataRoot, ".setup-preview")),
        this.createProvider(config, await this.calibratedExecutionProfile(config, language)),
      ),
    };
  }

  async language(): Promise<LanguageCode> {
    return (await loadAppConfig(this.paths.root)).language;
  }

  async setLanguage(language: LanguageCode): Promise<void> {
    await saveAppConfig(this.paths.root, { language });
  }

  async worldProfile(language?: LanguageCode): Promise<ResolvedWorldProfile> {
    return resolveWorldProfile(this.paths.root, language ?? await this.language());
  }

  async saveWorldProfile(markdown: string, language?: LanguageCode): Promise<string> {
    return saveWorldProfile(this.paths.root, language ?? await this.language(), markdown);
  }

  private async assertTerminalModelAvailable(
    config: ProviderConfig,
    language?: LanguageCode,
  ): Promise<void> {
    const selection = { provider: config.provider, model: config.model };
    const requiredLanguage = language ?? await this.language();
    const catalog = new LlmModelCatalog(this.paths.root, {
      testFingerprint: PROVIDER_COMPATIBILITY_FINGERPRINT,
      legacySelection: selection,
    });
    try {
      await catalog.assertAvailable(selection, requiredLanguage);
    } catch (error) {
      if (!(error instanceof ModelUnavailableError)) throw error;
      throw new Error(
        `Model ${config.provider}/${config.model} is not available for terminal use. `
        + `Open the browser Settings page, test it for ${requiredLanguage}, and enable it before selecting it in the terminal.`,
        { cause: error },
      );
    }
  }
}

export function createCliProjectContext(root: string): CliProjectContext {
  loadProjectEnv(root);
  return new CliProjectContext(projectPaths(root), process.env);
}
