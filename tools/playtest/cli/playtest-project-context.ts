import path from "node:path";
import { PROVIDER_COMPATIBILITY_FINGERPRINT, probeProviderConnection } from "../../../src/connection-probe.js";
import { loadProjectEnv } from "../../../src/env.js";
import { LlmModelCatalog } from "../../../src/llm-model-catalog.js";
import type { LanguageCode } from "../../../src/language.js";
import type { ModelExecutionProfileDraft } from "../../../src/model-execution-profile.js";
import {
  calibrateModel as calibratePlaytestModel,
  createUnifiedPlaytestRunner,
  resolvePlaytestTarget as resolveFrozenPlaytestTarget,
  type CalibrateModelResult,
  type PlaytestModelTarget,
  type PlaytestProgressEvent,
  type PlaytestRunner,
} from "../playtest.js";
import {
  estimatePlaytestCost,
  estimatePlaytestReservation,
  PlaytestCostManager,
} from "../harness/cost.js";
import { inferTokenPrice } from "../../../src/pricing.js";
import type { ProviderConfig } from "../../../src/schemas.js";
import type { LlmProvider, StructuredRequest, StructuredResult } from "../../../src/types.js";
import { CliProjectContext, type CliProjectPaths } from "../../../src/cli/project-context.js";

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

export class PlaytestProjectContext extends CliProjectContext {
  playtestsRoot(): string {
    return path.resolve(this.paths.playtestsRoot ?? path.join(this.paths.root, "playtests"));
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
    const profile = await this.executionProfiles().require({ provider: config.provider, model: config.model, route });
    const price = inferTokenPrice(config.provider, config.model);
    if (!price) throw new Error(`No built-in token price for ${config.provider}/${config.model}`);
    const cost = new PlaytestCostManager(maxCostUsd);
    const provider = new CompatibilityCostProvider(this.createProvider(config, profile), cost, price);
    const catalog = new LlmModelCatalog(this.paths.root, { testFingerprint: PROVIDER_COMPATIBILITY_FINGERPRINT });
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
}

function playtestProjectPaths(root: string): CliProjectPaths {
  const resolvedRoot = path.resolve(root);
  return {
    root: resolvedRoot,
    providerConfig: path.join(resolvedRoot, "config", "provider.json"),
    dataRoot: path.join(resolvedRoot, "data"),
    evaluationsRoot: path.join(resolvedRoot, "evaluations"),
    playtestsRoot: path.join(resolvedRoot, "playtests"),
  };
}

export function createPlaytestProjectContext(root: string): PlaytestProjectContext {
  loadProjectEnv(root);
  return new PlaytestProjectContext(playtestProjectPaths(root), process.env);
}
