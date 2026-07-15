import path from "node:path";
import * as p from "@clack/prompts";
import { DungeonEngine } from "../engine.js";
import { loadProjectEnv } from "../env.js";
import { loadAppConfig, saveAppConfig, type LanguageCode } from "../language.js";
import { createProvider as createLlmProvider, loadProviderConfig } from "../providers.js";
import { ProviderConfigSchema, type ProviderConfig } from "../schemas.js";
import { StateStore } from "../store.js";
import { atomicWriteJson } from "../persistence/files.js";
import type { GameEngine, LlmProvider } from "../types.js";
import { resolveWorldProfile, saveWorldProfile, type ResolvedWorldProfile } from "../world-profile.js";
import { takePrompt } from "./prompt.js";

interface CliProjectPaths {
  root: string;
  providerConfig: string;
  dataRoot: string;
  evaluationsRoot: string;
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
          { value: "gemini", label: "Google", hint: "recommended · GEMINI_API_KEY" },
          { value: "openrouter", label: "OpenRouter", hint: "OPENROUTER_API_KEY" },
        ],
      }),
    ) as "openrouter" | "gemini";
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
    if (providerModel === "gemini-3.5-flash" || providerModel === "google/gemini-3.5-flash") {
      p.log.success("gemini-3.5-flash is the playtested, recommended DM model.");
    } else if (providerModel === "gemini-3.1-flash-lite" || providerModel === "google/gemini-3.1-flash-lite") {
      p.log.info("gemini-3.1-flash-lite is playtested as the simulated player; the DM baseline uses gemini-3.5-flash.");
    } else {
      p.log.warn("This model is unverified. It may reject the enforced schemas or behave differently in play.");
    }
    await atomicWriteJson(this.paths.providerConfig, config);
    const keyName = provider === "openrouter" ? "OPENROUTER_API_KEY" : "GEMINI_API_KEY";
    if (this.environment[keyName]) p.log.success(`${keyName} is present.`);
    else p.log.warn(`${keyName} is not set. Export it before starting a game.`);
    p.outro(`Saved ${path.relative(this.paths.root, this.paths.providerConfig)}`);
    return config;
  }

  async providerConfig(): Promise<ProviderConfig> {
    try {
      return await loadProviderConfig(this.paths.providerConfig);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return this.configureProvider();
    }
  }

  createProvider(config: ProviderConfig): LlmProvider {
    return createLlmProvider(config, this.environment);
  }

  async createEngine(): Promise<GameEngine> {
    const config = await this.providerConfig();
    return new DungeonEngine(
      new StateStore(this.paths.dataRoot),
      this.createProvider(config),
    );
  }

  async language(): Promise<LanguageCode> {
    return (await loadAppConfig(this.paths.root)).language;
  }

  async setLanguage(language: LanguageCode): Promise<void> {
    await saveAppConfig(this.paths.root, { language });
    const store = new StateStore(this.paths.dataRoot);
    if (await store.hasCurrentGame()) await store.setLanguage(language);
  }

  async worldProfile(language?: LanguageCode): Promise<ResolvedWorldProfile> {
    return resolveWorldProfile(this.paths.root, language ?? await this.language());
  }

  async saveWorldProfile(markdown: string, language?: LanguageCode): Promise<string> {
    return saveWorldProfile(this.paths.root, language ?? await this.language(), markdown);
  }
}

export function createCliProjectContext(root: string): CliProjectContext {
  loadProjectEnv(root);
  return new CliProjectContext(projectPaths(root), process.env);
}
