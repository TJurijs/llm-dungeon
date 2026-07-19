import * as p from "@clack/prompts";
import path from "node:path";
import {
  FocusedReplayRunner,
  PlaytestRunConfigSchema,
  PlaytestRunIdSchema,
  ProfileIdSchema,
  comparePlaytestRuns,
  defaultPlaytestRoute,
  generatePlaytestReport,
  getPlaytestPackage,
  listPlaytestPackages,
  readCalibrationVariants,
  readDiagnosticBundle,
  readFocusedReplayManifest,
  type FocusedReplayCodec,
  type PlaytestModelTarget,
  type PlaytestProgressEvent,
  type PlaytestRunConfig,
  type ProfileId,
} from "../playtest.js";
import {
  WireResolvedTurnSchema,
  WireTurnSchema,
  decodeResolvedTurn,
  decodeTurnDecision,
} from "../llm/gameplay-protocol.js";
import { LanguageCodeSchema, type LanguageCode } from "../language.js";
import {
  ResolvedTurnSchema,
  SetupResultSchema,
  TurnDecisionSchema,
  ProviderConfigSchema,
  type ProviderConfig,
} from "../schemas.js";
import {
  freezeModelExecutionProfile,
  type FrozenModelExecutionProfile,
  type ModelExecutionProfileDraft,
} from "../model-execution-profile.js";
import { inferTokenPrice } from "../pricing.js";
import { PlaytestCostManager } from "../playtest/cost.js";
import { PlaytestProviderScheduler } from "../playtest/scheduler.js";
import type { CliProjectContext } from "./project-context.js";

export interface ParsedModelSpec {
  config: ProviderConfig;
  route: string;
}

/** One blinded, non-mutating judge target keeps scores comparable across candidates. */
export const DEFAULT_PLAYTEST_JUDGE_SPEC = "gemini:gemini-3.5-flash@direct";

/** Parses `provider:model[@route]`; model IDs may contain slashes. */
export function modelSpec(value: string): ParsedModelSpec {
  const separator = value.indexOf(":");
  if (separator < 1 || separator === value.length - 1) {
    throw new Error(`${value} must use provider:model[@route]`);
  }
  const provider = value.slice(0, separator);
  const modelAndRoute = value.slice(separator + 1);
  const routeSeparator = modelAndRoute.lastIndexOf("@");
  const model = routeSeparator < 0 ? modelAndRoute : modelAndRoute.slice(0, routeSeparator);
  const parsedProvider = ProviderConfigSchema.shape.provider.parse(provider);
  const route = routeSeparator < 0
    ? defaultPlaytestRoute(parsedProvider)
    : modelAndRoute.slice(routeSeparator + 1).trim();
  if (!model.trim() || !route) throw new Error(`${value} must use provider:model[@route]`);
  return {
    config: ProviderConfigSchema.parse({ provider: parsedProvider, model }),
    route,
  };
}

export function languageList(value: string): LanguageCode[] {
  return LanguageCodeSchema.array().min(1).parse(
    value.split(",").map((language) => language.trim().toLowerCase()).filter(Boolean),
  ).filter((language, index, all) => all.indexOf(language) === index);
}

export function collectValue(value: string, previous: string[] = []): string[] {
  return [...previous, value];
}

export function providerConcurrency(
  value: string,
  previous: Record<string, number> = {},
): Record<string, number> {
  const separator = value.lastIndexOf("=");
  const provider = value.slice(0, separator).trim();
  const limit = Number(value.slice(separator + 1));
  if (separator < 1 || !Number.isInteger(limit) || limit < 1) {
    throw new Error(`${value} must use provider=positive-integer`);
  }
  ProviderConfigSchema.shape.provider.parse(provider);
  return { ...previous, [provider]: limit };
}

export interface ModelPriceOverride {
  inputPerMillion: number;
  outputPerMillion: number;
}

export function modelPrice(
  value: string,
  previous: Record<string, ModelPriceOverride> = {},
): Record<string, ModelPriceOverride> {
  const separator = value.lastIndexOf("=");
  const rates = value.slice(separator + 1).split(",").map((item) => Number(item.trim()));
  if (separator < 1
    || rates.length !== 2
    || rates.some((rate) => !Number.isFinite(rate) || rate < 0)) {
    throw new Error(`${value} must use provider:model[@route]=input-usd-per-million,output-usd-per-million`);
  }
  const spec = modelSpec(value.slice(0, separator));
  return {
    ...previous,
    [targetLabel(spec)]: { inputPerMillion: rates[0]!, outputPerMillion: rates[1]! },
  };
}

export interface PlaytestRunOptions {
  candidate?: string | string[] | undefined;
  candidates?: string[] | undefined;
  languages?: LanguageCode[] | undefined;
  turns?: number | undefined;
  repetitions?: number | undefined;
  concurrency?: number | undefined;
  latencyMode?: "canonical" | "loaded" | undefined;
  providerConcurrency?: Record<string, number> | undefined;
  modelPrice?: Record<string, ModelPriceOverride> | undefined;
  maxCost?: number | undefined;
  maxDurationMinutes?: number | undefined;
  seed?: string | undefined;
  player?: string | undefined;
  playerProfile?: ProfileId | undefined;
  judge?: string | undefined;
  checkpointEvery?: number | undefined;
  tuningVariable?: string | undefined;
}

export interface CalibrationOptions {
  target?: string | undefined;
  variants?: string[] | undefined;
  evidenceId?: string | undefined;
  maxCost: number;
  inputCost?: number | undefined;
  outputCost?: number | undefined;
}

export interface CompatibilityProbeOptions {
  target?: string | undefined;
  languages?: LanguageCode[] | undefined;
  maxCost: number;
}

export interface ReplayOptions {
  variants?: string[] | undefined;
  replayId?: string | undefined;
  maxCost: number;
  inputCost?: number | undefined;
  outputCost?: number | undefined;
}

export interface LegacyEvaluateOptions {
  sessions?: number | undefined;
  turns?: number | undefined;
  concurrency: number;
  maxCost: number;
  playerProfiles?: ProfileId[] | undefined;
  playerProvider?: string | undefined;
  playerModel?: string | undefined;
  judge?: string | undefined;
}

function targetLabel(target: ParsedModelSpec): string {
  return `${target.config.provider}:${target.config.model}@${target.route}`;
}

function replayDraft(profile: FrozenModelExecutionProfile): ModelExecutionProfileDraft {
  return {
    schemaVersion: profile.schemaVersion,
    key: profile.key,
    structuredOutput: profile.structuredOutput,
    temperature: profile.temperature,
    reasoning: profile.reasoning,
    outputTokenField: profile.outputTokenField,
    outputBudgets: profile.outputBudgets,
    timeout: profile.timeout,
    adapterRevision: profile.adapterRevision,
  };
}

function replayCodec(
  bundle: Awaited<ReturnType<typeof readDiagnosticBundle>>,
): FocusedReplayCodec<unknown> {
  const phase = bundle.expectedPhase === "repair"
    ? bundle.request.repairOfPhase ?? "decision"
    : bundle.expectedPhase;
  if (phase === "setup") return { schema: SetupResultSchema };
  if (/playtest_(judgment|player_action)/u.test(bundle.request.schemaName)) {
    throw new Error(
      "This diagnostic uses a run-specific judge/player schema; replay it programmatically with its persisted codec",
    );
  }
  if (phase === "locked_resolution") {
    return {
      schema: ResolvedTurnSchema,
      wireSchema: WireResolvedTurnSchema,
      decodeResponse: decodeResolvedTurn,
    };
  }
  return {
    schema: TurnDecisionSchema,
    wireSchema: WireTurnSchema,
    decodeResponse: decodeTurnDecision,
  };
}

class PlaytestProgressRenderer {
  private readonly last = new Map<string, string>();

  readonly update = (event: PlaytestProgressEvent): void => {
    const state = `${event.phase}:${event.completedTurns}:${event.estimatedCostUsd}`;
    if (this.last.get(event.jobId) === state) return;
    this.last.set(event.jobId, state);
    p.log.info(
      `${event.jobId}: ${event.message} · ${event.completedTurns}/${event.totalTurns} turns · $${event.estimatedCostUsd.toFixed(4)}`,
    );
  };
}

export class PlaytestCli {
  constructor(private readonly project: CliProjectContext) {}

  packages(): void {
    const lines = listPlaytestPackages().map((playtestPackage) => [
      `${playtestPackage.id}@${playtestPackage.version}`,
      playtestPackage.purpose,
      `${playtestPackage.turns.minimum}-${playtestPackage.turns.maximum} turns`,
      playtestPackage.turnDriver.kind,
    ].join("\t"));
    console.log(lines.join("\n"));
  }

  async calibrate(options: CalibrationOptions): Promise<void> {
    const selected = options.target
      ? modelSpec(options.target)
      : await this.defaultModelSpec();
    const variants = options.variants?.length
      ? await readCalibrationVariants(options.variants, this.project.paths.root)
      : undefined;
    if ((options.inputCost === undefined) !== (options.outputCost === undefined)) {
      throw new Error("Custom calibration pricing requires both --input-cost and --output-cost");
    }
    p.intro(`Adapter calibration: ${targetLabel(selected)}`);
    p.log.info("This command makes live provider calls. Calibration is non-scored and does not certify gameplay quality.");
    const result = await this.project.calibrateModel(selected.config, {
      route: selected.route,
      maxCostUsd: options.maxCost,
      ...(variants ? { variants } : {}),
      ...(options.evidenceId ? { evidenceId: options.evidenceId } : {}),
      ...(options.inputCost === undefined ? {} : {
        cost: {
          inputPerMillion: options.inputCost,
          outputPerMillion: options.outputCost!,
        },
      }),
    });
    for (const [index, attempt] of result.attempts.entries()) {
      const passed = attempt.probe.cases.filter((probe) => probe.success).length;
      p.log.info(
        `Variant ${index + 1}: ${passed}/${attempt.probe.cases.length} probes; ${attempt.probe.passed ? "compatible" : "not compatible"}`,
      );
    }
    if (!result.selected) {
      throw new Error(`No compatible execution profile was found. Evidence: playtests/calibration/${result.evidenceId}`);
    }
    p.outro(
      `Frozen profile ${result.selected.fingerprint}. Cost: $${result.totalEstimatedCostUsd.toFixed(4)}. Evidence: playtests/calibration/${result.evidenceId}`,
    );
  }

  async probe(options: CompatibilityProbeOptions): Promise<void> {
    const selected = options.target
      ? modelSpec(options.target)
      : await this.defaultModelSpec();
    const languages = options.languages ?? ["en", "ru"];
    p.intro(`Protocol compatibility: ${targetLabel(selected)}`);
    p.log.info(`Strict setup and gameplay probes for ${languages.map((language) => language.toUpperCase()).join(", ")}.`);
    const result = await this.project.probeModelCompatibility(
      selected.config,
      languages,
      options.maxCost,
    );
    for (const language of result.passed) p.log.success(`${language.toUpperCase()}: compatible`);
    for (const failure of result.failed) p.log.error(`${failure.language.toUpperCase()}: ${failure.error}`);
    if (result.failed.length) {
      throw new Error(`Compatibility failed for ${result.failed.map((failure) => failure.language.toUpperCase()).join(", ")}`);
    }
    p.outro(`Compatibility current. Cost: $${result.costUsd.toFixed(4)}.`);
  }

  async replay(bundleFile: string, options: ReplayOptions): Promise<void> {
    if ((options.inputCost === undefined) !== (options.outputCost === undefined)) {
      throw new Error("Custom replay pricing requires both --input-cost and --output-cost");
    }
    const bundlePath = path.resolve(this.project.paths.root, bundleFile);
    const bundle = await readDiagnosticBundle(bundlePath);
    const variants = options.variants?.length
      ? await readCalibrationVariants(options.variants, this.project.paths.root)
      : [replayDraft(bundle.executionProfile)];
    const price = options.inputCost === undefined
      ? inferTokenPrice(bundle.provider as ProviderConfig["provider"], bundle.model)
      : { inputPerMillion: options.inputCost, outputPerMillion: options.outputCost! };
    if (!price) {
      throw new Error("Focused replay requires explicit --input-cost and --output-cost for an unpriced model");
    }
    const replayId = options.replayId === undefined
      ? undefined
      : PlaytestRunIdSchema.parse(options.replayId);
    const artifactsRoot = path.join(this.project.playtestsRoot(), "replays");
    let historicalCost = 0;
    if (replayId) {
      try {
        historicalCost = (await readFocusedReplayManifest(
          path.join(artifactsRoot, replayId, "manifest.json"),
        )).totalEstimatedCostUsd;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    const runner = new FocusedReplayRunner();
    const result = await runner.run(
      bundle,
      replayCodec(bundle),
      variants,
      (draft) => {
        const frozen = freezeModelExecutionProfile({
          ...draft,
          calibratedAt: bundle.executionProfile.calibratedAt,
          evidenceRef: `focused-replay:${replayId ?? "new"}`,
        });
        return this.project.createProvider(ProviderConfigSchema.parse({
          provider: bundle.provider as ProviderConfig["provider"],
          model: bundle.model,
        }), frozen);
      },
      {
        costManager: new PlaytestCostManager(options.maxCost, historicalCost),
        price,
        scheduler: new PlaytestProviderScheduler(1, { [bundle.provider]: 1 }),
        artifactsRoot,
        ...(replayId ? { replayId } : {}),
      },
    );
    p.outro(
      `Focused replay ${result.replayId}: ${result.status}; ${result.results.length} variants; $${result.totalEstimatedCostUsd.toFixed(4)}. Evidence: ${result.directory}`,
    );
  }

  async run(packageId: string, options: PlaytestRunOptions): Promise<void> {
    const config = await this.buildRunConfig(packageId, options, false);
    await this.execute(config);
  }

  async certify(options: PlaytestRunOptions): Promise<void> {
    const languages = options.languages ?? ["en", "ru"];
    const config = await this.buildRunConfig(
      "certification-v1",
      { ...options, languages },
      false,
    );
    await this.execute(config);
  }

  async matrix(packageId: string, options: PlaytestRunOptions): Promise<void> {
    const candidates = options.candidates
      ?? (Array.isArray(options.candidate)
        ? options.candidate
        : options.candidate ? [options.candidate] : []);
    if (candidates.length < 2) {
      throw new Error("A matrix requires at least two --candidate provider:model[@route] values");
    }
    const config = await this.buildRunConfig(
      packageId,
      { ...options, candidate: undefined, candidates },
      true,
    );
    await this.execute(config);
  }

  async resume(runId: string): Promise<void> {
    runId = PlaytestRunIdSchema.parse(runId);
    const renderer = new PlaytestProgressRenderer();
    const result = await this.project.createPlaytestRunner(renderer.update).resume(runId);
    p.outro(`Playtest ${result.manifest.status}. Report: ${result.reportPath}`);
  }

  async judge(runId: string): Promise<void> {
    runId = PlaytestRunIdSchema.parse(runId);
    const renderer = new PlaytestProgressRenderer();
    const result = await this.project.createPlaytestRunner(renderer.update).judge(runId);
    p.outro(`Judgment ${result.manifest.status}. Report: ${result.reportPath}`);
  }

  async report(runId: string): Promise<void> {
    const runDir = this.runDir(runId);
    const reportPath = await generatePlaytestReport(runDir);
    p.outro(`Report generated: ${reportPath}`);
  }

  async compare(leftRunId: string, rightRunId: string): Promise<void> {
    const comparison = await comparePlaytestRuns(this.runDir(leftRunId), this.runDir(rightRunId));
    console.log(comparison.markdown);
  }

  async legacyEvaluate(options: LegacyEvaluateOptions): Promise<void> {
    p.log.warn("`llm-dungeon evaluate` is deprecated; use `llm-dungeon playtest run campaign-autoplay-v1`.");
    const profiles = options.playerProfiles ?? ["curious-explorer"];
    if (profiles.length !== 1) {
      throw new Error("The deprecated evaluate alias accepts one fixed player profile per run");
    }
    const playerProvider = ProviderConfigSchema.shape.provider.parse(options.playerProvider ?? "gemini");
    const playerModel = options.playerModel
      ?? (playerProvider === "gemini"
        ? "gemini-3.1-flash-lite"
        : playerProvider === "openrouter" ? "google/gemini-3.1-flash-lite" : undefined);
    if (!playerModel) throw new Error("--player-model is required for the selected player provider");
    await this.run("campaign-autoplay-v1", {
      repetitions: options.sessions ?? 1,
      turns: options.turns ?? 25,
      concurrency: options.concurrency,
      latencyMode: options.concurrency === 1 ? "canonical" : "loaded",
      maxCost: options.maxCost,
      player: `${playerProvider}:${playerModel}@${defaultPlaytestRoute(playerProvider)}`,
      playerProfile: profiles[0],
      judge: options.judge,
    });
  }

  private async execute(config: PlaytestRunConfig): Promise<void> {
    const renderer = new PlaytestProgressRenderer();
    const jobs = config.candidates.length * config.languages.length * config.repetitions;
    p.intro(`Playtest ${config.package.id}@${config.package.version}`);
    p.log.info(
      `${jobs} jobs; ${config.globalWorkerLimit} workers; ${config.latencyMode} latency; hard cost ceiling $${config.maxCostUsd.toFixed(2)}`,
    );
    const result = await this.project.createPlaytestRunner(renderer.update).run(config);
    p.outro(`Playtest ${result.manifest.status}. Report: ${result.reportPath}`);
  }

  private async buildRunConfig(
    packageId: string,
    options: PlaytestRunOptions,
    matrix: boolean,
  ): Promise<PlaytestRunConfig> {
    const playtestPackage = getPlaytestPackage(packageId);
    const candidateSpecs = matrix
      ? options.candidates!.map(modelSpec)
      : [typeof options.candidate === "string"
        ? modelSpec(options.candidate)
        : await this.defaultModelSpec()];
    const candidates = await Promise.all(candidateSpecs.map((candidate) =>
      this.target(candidate, options.modelPrice)));
    const languages = options.languages ?? [await this.project.language()];
    const workers = options.concurrency ?? 1;
    const player = playtestPackage.turnDriver.kind === "scripted"
      ? undefined
      : await this.playerConfiguration(playtestPackage.playerProfiles, options);
    const judge = await this.judgeConfiguration(
      playtestPackage,
      options.judge,
      options.checkpointEvery,
      options.modelPrice,
    );
    return PlaytestRunConfigSchema.parse({
      package: { id: playtestPackage.id, version: playtestPackage.version },
      candidates,
      languages,
      ...(options.turns ? { turns: options.turns } : {}),
      ...(options.seed ? { seed: options.seed } : {}),
      ...(options.tuningVariable ? { tuningVariable: options.tuningVariable } : {}),
      repetitions: options.repetitions ?? 1,
      globalWorkerLimit: workers,
      latencyMode: options.latencyMode ?? (workers === 1 ? "canonical" : "loaded"),
      providerConcurrency: options.providerConcurrency ?? {},
      maxCostUsd: options.maxCost ?? playtestPackage.limits.maxCostUsd,
      ...(options.maxDurationMinutes
        ? { maxDurationMs: Math.round(options.maxDurationMinutes * 60_000) }
        : {}),
      ...(player ? { player } : {}),
      judge,
    });
  }

  private async playerConfiguration(
    allowedProfiles: readonly ProfileId[],
    options: PlaytestRunOptions,
  ): Promise<PlaytestRunConfig["player"]> {
    if (!options.player) {
      throw new Error("This package requires --player provider:model[@route] and a frozen player profile");
    }
    const profile = ProfileIdSchema.parse(options.playerProfile ?? allowedProfiles[0]);
    if (!allowedProfiles.includes(profile)) {
      throw new Error(`Player profile ${profile} is not supported by this package`);
    }
    return { target: await this.target(modelSpec(options.player), options.modelPrice), profile };
  }

  private async judgeConfiguration(
    playtestPackage: ReturnType<typeof getPlaytestPackage>,
    judgeSpec: string | undefined,
    checkpointEvery: number | undefined,
    prices?: Record<string, ModelPriceOverride>,
  ): Promise<PlaytestRunConfig["judge"]> {
    if (playtestPackage.judgePolicy.kind === "none") {
      if (judgeSpec) throw new Error(`${playtestPackage.id} does not define a judge rubric`);
      if (checkpointEvery !== undefined) throw new Error("--checkpoint-every requires a judged package");
      return {
        policy: "none",
        rubricVersion: 1,
      };
    }
    const target = await this.target(modelSpec(judgeSpec ?? DEFAULT_PLAYTEST_JUDGE_SPEC), prices);
    if (playtestPackage.judgePolicy.kind === "final") {
      if (checkpointEvery !== undefined) {
        throw new Error(`${playtestPackage.id} uses final-only judging`);
      }
      return { policy: "final", rubricVersion: playtestPackage.judgePolicy.rubricVersion, target };
    }
    return {
      policy: "checkpoints_and_final",
      rubricVersion: playtestPackage.judgePolicy.rubricVersion,
      target,
      checkpointEvery: checkpointEvery ?? playtestPackage.judgePolicy.everyTurns,
    };
  }

  private async defaultModelSpec(): Promise<ParsedModelSpec> {
    const config = await this.project.providerConfig();
    return { config, route: defaultPlaytestRoute(config.provider) };
  }

  private target(
    spec: ParsedModelSpec,
    prices?: Record<string, ModelPriceOverride>,
  ): Promise<PlaytestModelTarget> {
    return this.project.resolvePlaytestTarget(spec.config, spec.route, prices?.[targetLabel(spec)]);
  }

  private runDir(runId: string): string {
    return path.join(
      this.project.playtestsRoot(),
      "runs",
      PlaytestRunIdSchema.parse(runId),
    );
  }
}
