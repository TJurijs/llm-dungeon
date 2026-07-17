import path from "node:path";
import * as p from "@clack/prompts";
import { CampaignCatalog, type CampaignCatalogSummary } from "../campaign-catalog.js";
import { DungeonEngine } from "../engine.js";
import { loadProjectEnv } from "../env.js";
import { loadAppConfig, saveAppConfig, type LanguageCode } from "../language.js";
import { PROVIDER_COMPATIBILITY_FINGERPRINT } from "../connection-probe.js";
import { LlmModelCatalog, ModelUnavailableError } from "../llm-model-catalog.js";
import { createProvider as createLlmProvider, loadProviderConfig } from "../providers.js";
import { ProviderConfigSchema, type ProviderConfig } from "../schemas.js";
import { StateStore } from "../store.js";
import { atomicWriteJson } from "../persistence/files.js";
import type { GameEngine, LlmProvider, NewGameInput } from "../types.js";
import { resolveWorldProfile, saveWorldProfile, type ResolvedWorldProfile } from "../world-profile.js";
import { takePrompt } from "./prompt.js";

interface CliProjectPaths {
  root: string;
  providerConfig: string;
  dataRoot: string;
  evaluationsRoot: string;
}

export interface CliCampaignSession {
  campaignId: string;
  engine: GameEngine;
}

export interface CliSetupSession {
  config: ProviderConfig;
  engine: GameEngine;
}

function projectPaths(root: string): CliProjectPaths {
  const resolvedRoot = path.resolve(root);
  return {
    root: resolvedRoot,
    providerConfig: path.join(resolvedRoot, "config", "provider.json"),
    dataRoot: path.join(resolvedRoot, "data"),
    evaluationsRoot: path.join(resolvedRoot, "evaluations"),
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
          { value: "openai", label: "OpenAI", hint: "OPENAI_API_KEY" },
          { value: "anthropic", label: "Anthropic", hint: "ANTHROPIC_API_KEY" },
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

  createProvider(config: ProviderConfig): LlmProvider {
    return createLlmProvider(config, this.environment);
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
    return new DungeonEngine(store, this.createProvider(config));
  }

  async createCampaignSession(input: NewGameInput, config?: ProviderConfig): Promise<CliCampaignSession> {
    const selectedConfig = ProviderConfigSchema.parse(config ?? await this.providerConfig());
    await this.assertTerminalModelAvailable(selectedConfig);
    const created = await (await this.campaignCatalog(selectedConfig)).createCampaign(input, {
      providerConfig: selectedConfig,
    });
    return {
      campaignId: created.campaignId,
      engine: new DungeonEngine(created.store, this.createProvider(selectedConfig)),
    };
  }

  async createSetupSession(): Promise<CliSetupSession> {
    const config = await this.providerConfig();
    // Setup generation does not read or mutate campaign state. The disposable
    // store keeps the engine boundary intact without reserving a campaign that
    // the user may reject during preview.
    return {
      config,
      engine: new DungeonEngine(
        new StateStore(path.join(this.paths.dataRoot, ".setup-preview")),
        this.createProvider(config),
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

  private async assertTerminalModelAvailable(config: ProviderConfig): Promise<void> {
    const selection = { provider: config.provider, model: config.model };
    const catalog = new LlmModelCatalog(this.paths.root, {
      testFingerprint: PROVIDER_COMPATIBILITY_FINGERPRINT,
      legacySelection: selection,
    });
    try {
      await catalog.assertAvailable(selection, "en");
      await catalog.assertAvailable(selection, "ru");
    } catch (error) {
      if (!(error instanceof ModelUnavailableError)) throw error;
      throw new Error(
        `Model ${config.provider}/${config.model} is not available for terminal use. `
        + "Open the browser Settings page, test it in English and Russian, and enable it before selecting it in the terminal.",
        { cause: error },
      );
    }
  }
}

export function createCliProjectContext(root: string): CliProjectContext {
  loadProjectEnv(root);
  return new CliProjectContext(projectPaths(root), process.env);
}
