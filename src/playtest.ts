import { randomUUID } from "node:crypto";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { ModelAssessmentCatalog } from "./model-assessment-catalog.js";
import { PROVIDER_COMPATIBILITY_FINGERPRINT } from "./connection-probe.js";
import { LlmModelCatalog } from "./llm-model-catalog.js";
import { ModelExecutionProfileStore } from "./model-execution-profile-store.js";
import {
  DEFAULT_MODEL_EXECUTION_PROFILE_DRAFTS,
  MODEL_EXECUTION_ADAPTER_REVISION,
  ModelExecutionProfileDraftSchema,
  freezeModelExecutionProfile,
  outputBudgetForPhase,
  type FrozenModelExecutionProfile,
  type ModelExecutionProfileDraft,
} from "./model-execution-profile.js";
import { inferTokenPrice } from "./pricing.js";
import { createProvider } from "./providers.js";
import { ProviderConfigSchema, type ProviderConfig } from "./schemas.js";
import { structuredFailureDetails } from "./llm/structured-error.js";
import {
  CalibrationEvidenceStore,
  calibrationEvidenceId,
  calibrationFailureStatus,
  runCalibrationVariants,
  selectCalibrationProfile,
  type CalibrationVariantResult,
} from "./playtest/calibration.js";
import {
  PlaytestModelTargetSchema,
  PlaytestRunConfigSchema,
  type PlaytestModelTarget,
  type PlaytestRunConfig,
} from "./playtest/contracts.js";
import {
  estimatePlaytestCost,
  estimatePlaytestReservation,
  PlaytestCostManager,
  type PlaytestModelCost,
} from "./playtest/cost.js";
import { PlaytestRunner, type PlaytestProgressEvent } from "./playtest/runner.js";
import type { LlmProvider, StructuredRequest, StructuredResult } from "./types.js";

export * from "./playtest/contracts.js";
export * from "./playtest/packages.js";
export * from "./playtest/calibration.js";
export * from "./playtest/assessment.js";
export * from "./playtest/audit.js";
export * from "./playtest/failure-attribution.js";
export * from "./playtest/judge.js";
export * from "./playtest/manifest.js";
export * from "./playtest/replay.js";
export * from "./playtest/report.js";
export * from "./playtest/runner.js";

export function defaultPlaytestRoute(provider: ProviderConfig["provider"]): string {
  return provider === "openrouter" ? "openrouter" : "direct";
}

export async function resolvePlaytestTarget(
  profiles: ModelExecutionProfileStore,
  config: ProviderConfig,
  route = defaultPlaytestRoute(config.provider),
  cost?: PlaytestModelCost,
): Promise<PlaytestModelTarget> {
  const parsedConfig = ProviderConfigSchema.parse(config);
  const profile = await profiles.require({
    provider: parsedConfig.provider,
    model: parsedConfig.model,
    route,
  });
  return PlaytestModelTargetSchema.parse({
    config: parsedConfig,
    route,
    executionProfileFingerprint: profile.fingerprint,
    ...(cost ? { cost } : {}),
  });
}

export interface CreateUnifiedPlaytestRunnerOptions {
  projectRoot: string;
  playtestsRoot?: string | undefined;
  environment?: NodeJS.ProcessEnv | undefined;
  onProgress?: ((event: PlaytestProgressEvent) => void) | undefined;
  now?: (() => Date) | undefined;
}

const SECRET_ENVIRONMENT_KEYS = [
  "GEMINI_API_KEY",
  "OPENROUTER_API_KEY",
  "XAI_API_KEY",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "DEEPSEEK_API_KEY",
] as const;

/** Constructs the single playtest engine used by every terminal command. */
export function createUnifiedPlaytestRunner(
  options: CreateUnifiedPlaytestRunnerOptions,
): PlaytestRunner {
  const projectRoot = path.resolve(options.projectRoot);
  const playtestsRoot = path.resolve(options.playtestsRoot ?? path.join(projectRoot, "playtests"));
  const environment = options.environment ?? process.env;
  const profiles = new ModelExecutionProfileStore(projectRoot);
  const assessments = new ModelAssessmentCatalog(projectRoot, options.now ?? (() => new Date()));
  const modelCatalog = new LlmModelCatalog(projectRoot, {
    testFingerprint: PROVIDER_COMPATIBILITY_FINGERPRINT,
    ...(options.now ? { now: options.now } : {}),
  });
  const secrets = SECRET_ENVIRONMENT_KEYS.flatMap((key) => {
    const value = environment[key];
    return value ? [value] : [];
  });
  return new PlaytestRunner(projectRoot, playtestsRoot, {
    profileFor: (target) => profiles.require({
      provider: target.config.provider,
      model: target.config.model,
      route: target.route,
    }),
    preflightTarget: async (target, language) => {
      const effective = await assessments.effective({
        provider: target.config.provider,
        model: target.config.model,
        route: target.route,
      }, language);
      if (effective.adapterStatus !== "calibrated"
        || effective.profileFingerprint !== target.executionProfileFingerprint) {
        throw new Error(
          `Model ${target.config.provider}/${target.config.model} via ${target.route} is not currently calibrated with the selected execution profile`,
        );
      }
      await modelCatalog.assertAvailable({
        provider: target.config.provider,
        model: target.config.model,
      }, language);
    },
    providerFor: (target, profile) => createProvider(
      target.config,
      environment,
      fetch,
      { executionProfile: profile },
    ),
    assessmentCatalog: assessments,
    secrets,
    ...(options.now ? { now: options.now } : {}),
  }, options.onProgress);
}

function safeCalibrationEvidenceId(now: Date): string {
  return `${now.toISOString().replace(/[:.]/g, "-")}-${randomUUID()}`;
}

function defaultDraftFor(config: ProviderConfig, route: string): ModelExecutionProfileDraft {
  const exact = DEFAULT_MODEL_EXECUTION_PROFILE_DRAFTS.find((profile) =>
    profile.key.provider === config.provider
    && profile.key.model === config.model
    && profile.key.route === route);
  if (exact) return structuredClone(exact);
  const providerDefault = DEFAULT_MODEL_EXECUTION_PROFILE_DRAFTS.find((profile) =>
    profile.key.provider === config.provider && profile.key.route === route);
  if (!providerDefault) {
    throw new Error(
      `No starting calibration profile exists for ${config.provider} via ${route}; provide --variant <file>`,
    );
  }
  return ModelExecutionProfileDraftSchema.parse({
    ...structuredClone(providerDefault),
    key: { provider: config.provider, model: config.model, route },
  });
}

export async function readCalibrationVariants(
  files: readonly string[],
  projectRoot: string,
): Promise<ModelExecutionProfileDraft[]> {
  const variants: ModelExecutionProfileDraft[] = [];
  for (const file of files) {
    const value: unknown = JSON.parse(await readFile(path.resolve(projectRoot, file), "utf8"));
    if (Array.isArray(value)) {
      variants.push(...value.map((item) => ModelExecutionProfileDraftSchema.parse(item)));
    } else {
      variants.push(ModelExecutionProfileDraftSchema.parse(value));
    }
  }
  return variants;
}

export interface CalibrateModelOptions {
  projectRoot: string;
  playtestsRoot?: string | undefined;
  config: ProviderConfig;
  route?: string | undefined;
  variants?: readonly ModelExecutionProfileDraft[] | undefined;
  environment?: NodeJS.ProcessEnv | undefined;
  now?: (() => Date) | undefined;
  evidenceId?: string | undefined;
  maxCostUsd: number;
  cost?: PlaytestModelCost | undefined;
}

export interface CalibrateModelResult {
  evidenceId: string;
  attempts: CalibrationVariantResult[];
  selected?: FrozenModelExecutionProfile | undefined;
  totalEstimatedCostUsd: number;
}

class CalibrationCostProvider implements LlmProvider {
  readonly id: string;
  readonly model: string;

  constructor(
    private readonly base: LlmProvider,
    private readonly profile: FrozenModelExecutionProfile,
    private readonly cost: PlaytestCostManager,
    private readonly price: PlaytestModelCost,
  ) {
    this.id = base.id;
    this.model = base.model;
  }

  async generateStructured<T>(request: StructuredRequest<T>): Promise<StructuredResult<T>> {
    const maxOutputTokens = outputBudgetForPhase(
      this.profile,
      request.generationPhase ?? "decision",
      request.repairOfPhase,
    );
    const reservationEstimate = estimatePlaytestReservation({
      ...request,
      maxOutputTokens,
    } as StructuredRequest<unknown>, this.price);
    const reservation = await this.cost.acquire(reservationEstimate);
    try {
      const result = await this.base.generateStructured(request);
      this.cost.commit(
        reservation,
        estimatePlaytestCost(result.usage, this.price, reservationEstimate),
      );
      return result;
    } catch (error) {
      const usage = structuredFailureDetails(error)?.usage;
      this.cost.commit(
        reservation,
        estimatePlaytestCost(usage, this.price, reservationEstimate),
      );
      throw error;
    }
  }
}

/**
 * Runs non-scored adapter probes and freezes only a fully compatible profile.
 * Each provider call is live; callers must invoke this only on explicit user command.
 */
export async function calibrateModel(
  options: CalibrateModelOptions,
): Promise<CalibrateModelResult> {
  const projectRoot = path.resolve(options.projectRoot);
  const playtestsRoot = path.resolve(options.playtestsRoot ?? path.join(projectRoot, "playtests"));
  const environment = options.environment ?? process.env;
  const now = options.now ?? (() => new Date());
  const config = ProviderConfigSchema.parse(options.config);
  if (!Number.isFinite(options.maxCostUsd) || options.maxCostUsd <= 0) {
    throw new Error("Calibration requires an explicit positive cost ceiling");
  }
  const price = options.cost ?? inferTokenPrice(config.provider, config.model);
  if (!price) {
    throw new Error(
      `No built-in token price for ${config.provider}/${config.model}; provide explicit input/output rates so calibration can enforce its cost ceiling`,
    );
  }
  for (const [label, value] of Object.entries(price)) {
    if (!Number.isFinite(value) || value < 0) throw new Error(`${label} must be a nonnegative finite USD-per-million rate`);
  }
  const route = options.route ?? defaultPlaytestRoute(config.provider);
  const baseline = defaultDraftFor(config, route);
  const variants = options.variants?.length
    ? options.variants.map((variant) => ModelExecutionProfileDraftSchema.parse(variant))
    : [baseline];
  if (JSON.stringify(variants[0]!.outputBudgets) !== JSON.stringify(baseline.outputBudgets)) {
    throw new Error(
      "Calibration must begin with the documented phase budgets; larger budgets require confirmed truncation",
    );
  }
  for (const variant of variants) {
    if (variant.key.provider !== config.provider
      || variant.key.model !== config.model
      || variant.key.route !== route) {
      throw new Error("Every calibration variant must target the selected provider, model, and route");
    }
    if (variant.adapterRevision !== MODEL_EXECUTION_ADAPTER_REVISION) {
      throw new Error(
        `Calibration variants must use current adapter revision ${MODEL_EXECUTION_ADAPTER_REVISION}`,
      );
    }
  }
  const evidenceId = calibrationEvidenceId(options.evidenceId ?? safeCalibrationEvidenceId(now()));
  const evidenceStore = new CalibrationEvidenceStore(path.join(playtestsRoot, "calibration"));
  const cost = new PlaytestCostManager(options.maxCostUsd);
  const attempts = await runCalibrationVariants(variants, (variant) => {
    const provisional = freezeModelExecutionProfile({
      ...variant,
      calibratedAt: now().toISOString(),
      evidenceRef: `playtests/calibration/${evidenceId}`,
    });
    const provider = createProvider(
      { ...config, provider: variant.key.provider, model: variant.key.model },
      environment,
      fetch,
      { executionProfile: provisional },
    );
    return new CalibrationCostProvider(provider, provisional, cost, price);
  }, { evidenceId, evidenceStore, now });
  const selectedAttempt = selectCalibrationProfile(attempts);
  const profiles = new ModelExecutionProfileStore(projectRoot);
  const assessments = new ModelAssessmentCatalog(projectRoot, now);
  const reference = `playtests/calibration/${evidenceId}`;
  if (!selectedAttempt?.probe.passed) {
    await assessments.recordCalibration({
      provider: config.provider,
      model: config.model,
      route,
      status: calibrationFailureStatus(attempts),
      evidence: { source: "calibration", reference, recordedAt: now().toISOString() },
    });
    return { evidenceId, attempts, totalEstimatedCostUsd: cost.spentUsd };
  }
  const selected = freezeModelExecutionProfile({
    ...selectedAttempt.profile,
    calibratedAt: now().toISOString(),
    evidenceRef: reference,
  });
  await profiles.put(selected);
  await assessments.recordCalibration({
    provider: config.provider,
    model: config.model,
    route: selected.key.route,
    status: "calibrated",
    adapterRevision: selected.adapterRevision,
    profileFingerprint: selected.fingerprint,
    evidence: {
      source: "calibration",
      reference,
      executionProfileFingerprint: selected.fingerprint,
      recordedAt: now().toISOString(),
    },
  });
  return { evidenceId, attempts, selected, totalEstimatedCostUsd: cost.spentUsd };
}

export function playtestRunConfig(value: PlaytestRunConfig): PlaytestRunConfig {
  return PlaytestRunConfigSchema.parse(value);
}
