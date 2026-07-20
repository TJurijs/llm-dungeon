import { randomUUID } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { structuredFailureDetails } from "../../../src/llm/structured-error.js";
import {
  FrozenModelExecutionProfileSchema,
  ModelExecutionProfileDraftSchema,
  assertSingleCalibrationVariableChange,
  outputBudgetForPhase,
  type FrozenModelExecutionProfile,
  type ModelExecutionProfileDraft,
} from "../../../src/model-execution-profile.js";
import { atomicWriteJson } from "../../../src/persistence/files.js";
import { acquireFileLock } from "../../../src/persistence/lock.js";
import type { LlmProvider, StructuredRequest } from "../../../src/types.js";
import {
  estimatePlaytestCost,
  estimatePlaytestReservation,
  PlaytestCostLimitError,
  type PlaytestModelCost,
  PlaytestCostManager,
} from "./cost.js";
import {
  appendPlaytestJsonLine,
  hashPlaytestValue,
  readPlaytestJsonLines,
} from "./files.js";
import {
  FailureAttributionSchema,
  attributePlaytestFailure,
  type FailureAttribution,
} from "./failure-attribution.js";
import {
  PlaytestProviderScheduler,
  scheduledCallTimingFor,
} from "./scheduler.js";

export const DIAGNOSTIC_BUNDLE_VERSION = 2 as const;
export const FOCUSED_REPLAY_MANIFEST_VERSION = 2 as const;

const GenerationPhaseSchema = z.enum(["setup", "decision", "locked_resolution", "repair"]);
const ReplayAttemptKindSchema = z.enum([
  "initial",
  "schema_repair",
  "transient_retry",
  "domain_repair",
]);

const LegacyPersistedReplayRequestSchema = z.object({
  schemaName: z.string().min(1),
  system: z.string(),
  prompt: z.string(),
  jsonSchema: z.record(z.string(), z.unknown()),
  protocolVersion: z.number().int().nonnegative().optional(),
  temperature: z.number().min(0).max(2).optional(),
  maxOutputTokens: z.number().int().positive(),
}).strict();

const PersistedReplayRequestSchema = LegacyPersistedReplayRequestSchema.extend({
  outputTokenCeiling: z.number().int().positive().optional(),
  generationPhase: GenerationPhaseSchema.optional(),
  repairOfPhase: GenerationPhaseSchema.exclude(["repair"]).optional(),
  attemptKind: ReplayAttemptKindSchema.optional(),
  retryBackoffMs: z.number().int().nonnegative().optional(),
}).strict();

const DiagnosticFailureSchema = z.object({
  attribution: FailureAttributionSchema,
  kind: z.string().min(1),
  message: z.string().min(1).max(2_000),
}).strict();

const LegacyDiagnosticBundleSchema = z.object({
  schemaVersion: z.literal(1),
  createdAt: z.string().datetime({ offset: true }),
  expectedPhase: GenerationPhaseSchema,
  provider: z.string().min(1),
  model: z.string().min(1),
  route: z.string().min(1),
  executionProfile: FrozenModelExecutionProfileSchema,
  preCallStateSnapshot: z.string(),
  request: LegacyPersistedReplayRequestSchema,
  promptHash: z.string().regex(/^[a-f0-9]{64}$/),
  schemaHash: z.string().regex(/^[a-f0-9]{64}$/),
  responseMetadata: z.record(z.string(), z.unknown()).default({}),
  failure: DiagnosticFailureSchema,
}).strict();

export const DiagnosticBundleSchema = z.object({
  schemaVersion: z.literal(DIAGNOSTIC_BUNDLE_VERSION),
  createdAt: z.string().datetime({ offset: true }),
  expectedPhase: GenerationPhaseSchema,
  provider: z.string().min(1),
  model: z.string().min(1),
  route: z.string().min(1),
  executionProfile: FrozenModelExecutionProfileSchema,
  preCallStateSnapshot: z.string(),
  request: PersistedReplayRequestSchema,
  promptHash: z.string().regex(/^[a-f0-9]{64}$/),
  schemaHash: z.string().regex(/^[a-f0-9]{64}$/),
  responseMetadata: z.record(z.string(), z.unknown()).default({}),
  failure: DiagnosticFailureSchema,
}).strict();
export type DiagnosticBundle = z.infer<typeof DiagnosticBundleSchema>;

function redactString(value: string, secrets: readonly string[]): string {
  let output = value;
  for (const secret of secrets) {
    if (secret) output = output.replaceAll(secret, "[redacted]");
  }
  return output;
}

function redactValue(value: unknown, secrets: readonly string[]): unknown {
  if (typeof value === "string") return redactString(value, secrets);
  if (Array.isArray(value)) return value.map((item) => redactValue(item, secrets));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .map(([key, item]) => [key, redactValue(item, secrets)]));
}

export interface CreateDiagnosticBundleInput {
  expectedPhase: DiagnosticBundle["expectedPhase"];
  profile: FrozenModelExecutionProfile;
  stateSnapshot: string;
  request: StructuredRequest<unknown>;
  responseMetadata?: Record<string, unknown> | undefined;
  attribution: FailureAttribution;
  failureKind: string;
  failureMessage: string;
  secrets?: readonly string[] | undefined;
  now?: Date | undefined;
}

/** Contains the exact physical-attempt metadata needed for replay, with credentials redacted. */
export function createDiagnosticBundle(input: CreateDiagnosticBundleInput): DiagnosticBundle {
  const profile = FrozenModelExecutionProfileSchema.parse(input.profile);
  const secrets = input.secrets ?? [];
  const jsonSchema = input.request.jsonSchema
    ?? z.toJSONSchema(input.request.wireSchema ?? input.request.schema, { target: "draft-7" }) as Record<string, unknown>;
  const request = PersistedReplayRequestSchema.parse(redactValue({
    schemaName: input.request.schemaName,
    system: input.request.system,
    prompt: input.request.prompt,
    jsonSchema,
    ...(input.request.protocolVersion === undefined ? {} : { protocolVersion: input.request.protocolVersion }),
    ...(input.request.temperature === undefined ? {} : { temperature: input.request.temperature }),
    maxOutputTokens: input.request.maxOutputTokens ?? profile.outputBudgets[
      input.expectedPhase === "locked_resolution" ? "lockedResolution" : input.expectedPhase
    ],
    ...(input.request.outputTokenCeiling === undefined
      ? {}
      : { outputTokenCeiling: input.request.outputTokenCeiling }),
    ...(input.request.generationPhase === undefined ? {} : { generationPhase: input.request.generationPhase }),
    ...(input.request.repairOfPhase === undefined ? {} : { repairOfPhase: input.request.repairOfPhase }),
    ...(input.request.attemptKind === undefined ? {} : { attemptKind: input.request.attemptKind }),
    ...(input.request.retryBackoffMs === undefined ? {} : { retryBackoffMs: input.request.retryBackoffMs }),
  }, secrets));
  const createdAt = (input.now ?? new Date()).toISOString();
  return DiagnosticBundleSchema.parse({
    schemaVersion: DIAGNOSTIC_BUNDLE_VERSION,
    createdAt,
    expectedPhase: input.expectedPhase,
    provider: profile.key.provider,
    model: profile.key.model,
    route: profile.key.route,
    executionProfile: profile,
    preCallStateSnapshot: redactString(input.stateSnapshot, secrets),
    request,
    promptHash: hashPlaytestValue({ system: request.system, prompt: request.prompt }),
    schemaHash: hashPlaytestValue(request.jsonSchema),
    responseMetadata: redactValue(input.responseMetadata ?? {}, secrets),
    failure: {
      attribution: input.attribution,
      kind: input.failureKind,
      message: redactString(input.failureMessage, secrets).slice(0, 2_000),
    },
  });
}

export async function writeDiagnosticBundle(target: string, bundle: DiagnosticBundle): Promise<void> {
  await atomicWriteJson(target, DiagnosticBundleSchema.parse(bundle));
}

function migrateDiagnosticBundle(value: unknown): DiagnosticBundle {
  const version = z.object({ schemaVersion: z.number().int() }).passthrough().parse(value).schemaVersion;
  if (version === DIAGNOSTIC_BUNDLE_VERSION) return DiagnosticBundleSchema.parse(value);
  const legacy = LegacyDiagnosticBundleSchema.parse(value);
  return DiagnosticBundleSchema.parse({
    ...legacy,
    schemaVersion: DIAGNOSTIC_BUNDLE_VERSION,
    request: {
      ...legacy.request,
      generationPhase: legacy.expectedPhase,
      attemptKind: "initial",
    },
  });
}

/** Reads current bundles and conservatively upgrades the original v1 replay semantics in memory. */
export async function readDiagnosticBundle(target: string): Promise<DiagnosticBundle> {
  return migrateDiagnosticBundle(JSON.parse(await readFile(target, "utf8")));
}

function draftOf(profile: FrozenModelExecutionProfile): ModelExecutionProfileDraft {
  return ModelExecutionProfileDraftSchema.parse({
    schemaVersion: profile.schemaVersion,
    key: profile.key,
    structuredOutput: profile.structuredOutput,
    temperature: profile.temperature,
    reasoning: profile.reasoning,
    outputTokenField: profile.outputTokenField,
    outputBudgets: profile.outputBudgets,
    timeout: profile.timeout,
    adapterRevision: profile.adapterRevision,
  });
}

export interface FocusedReplayCodec<T> {
  schema: z.ZodType<T>;
  wireSchema?: z.ZodType<unknown> | undefined;
  decodeResponse?: ((value: unknown) => T) | undefined;
}

const FocusedReplayIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/);
const ReplayVariantStatusSchema = z.enum([
  "pending",
  "running",
  "succeeded",
  "failed",
  "cancelled",
  "cost_limit",
  "interrupted",
]);
const ReplayOutcomeSchema = z.enum(["success", "failure", "cancelled", "cost_limit", "interrupted"]);

export const FocusedReplayRecordSchema = z.object({
  variantIndex: z.number().int().nonnegative(),
  profileHash: z.string().regex(/^[a-f0-9]{64}$/),
  timestamp: z.string().datetime({ offset: true }),
  outcome: ReplayOutcomeSchema,
  success: z.boolean(),
  durationMs: z.number().int().nonnegative(),
  queueWaitMs: z.number().int().nonnegative(),
  providerCallMs: z.number().int().nonnegative(),
  estimatedCostUsd: z.number().nonnegative(),
  costBasis: z.enum(["reported_usage", "reserved_estimate", "no_call", "unknown"]),
  attribution: FailureAttributionSchema.optional(),
  error: z.string().min(1).max(2_000).optional(),
}).strict().superRefine((record, context) => {
  if (record.success !== (record.outcome === "success")) {
    context.addIssue({ code: "custom", path: ["success"], message: "success must match replay outcome" });
  }
  if (!record.success && !record.attribution) {
    context.addIssue({ code: "custom", path: ["attribution"], message: "non-success replay records require attribution" });
  }
});
export type FocusedReplayRecord = z.infer<typeof FocusedReplayRecordSchema>;

export const FocusedReplayManifestSchema = z.object({
  schemaVersion: z.literal(FOCUSED_REPLAY_MANIFEST_VERSION),
  kind: z.literal("focused_replay"),
  replayId: FocusedReplayIdSchema,
  startedAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
  completedAt: z.string().datetime({ offset: true }).optional(),
  status: z.enum([
    "running",
    "completed",
    "completed_with_failures",
    "cancelled",
    "cost_limit",
    "interrupted",
  ]),
  diagnosticBundleHash: z.string().regex(/^[a-f0-9]{64}$/),
  provider: z.string().min(1),
  model: z.string().min(1),
  route: z.string().min(1),
  maxCostUsd: z.number().positive(),
  price: z.object({
    inputPerMillion: z.number().nonnegative(),
    outputPerMillion: z.number().nonnegative(),
  }).strict(),
  totalEstimatedCostUsd: z.number().nonnegative(),
  variants: z.array(z.object({
    index: z.number().int().nonnegative(),
    profile: ModelExecutionProfileDraftSchema,
    profileHash: z.string().regex(/^[a-f0-9]{64}$/),
    status: ReplayVariantStatusSchema,
  }).strict()).min(1).max(8),
}).strict();
export type FocusedReplayManifest = z.infer<typeof FocusedReplayManifestSchema>;

export interface FocusedReplayResult extends FocusedReplayRecord {
  profile: ModelExecutionProfileDraft;
  response?: unknown;
}

export interface FocusedReplayRunResult {
  replayId: string;
  directory: string;
  status: FocusedReplayManifest["status"];
  totalEstimatedCostUsd: number;
  results: FocusedReplayResult[];
}

export interface FocusedReplayRunOptions {
  /** A dedicated manager is required so restart accounting remains authoritative. */
  costManager: PlaytestCostManager;
  price: PlaytestModelCost;
  scheduler: PlaytestProviderScheduler;
  artifactsRoot: string;
  replayId?: string | undefined;
  signal?: AbortSignal | undefined;
  secrets?: readonly string[] | undefined;
  now?: (() => Date) | undefined;
}

async function readReplayManifest(target: string): Promise<FocusedReplayManifest | undefined> {
  try {
    return FocusedReplayManifestSchema.parse(JSON.parse(await readFile(target, "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export async function readFocusedReplayManifest(target: string): Promise<FocusedReplayManifest> {
  return FocusedReplayManifestSchema.parse(JSON.parse(await readFile(target, "utf8")));
}

function resultFromRecord(
  record: FocusedReplayRecord,
  profile: ModelExecutionProfileDraft,
  response?: unknown,
): FocusedReplayResult {
  return { ...record, profile, ...(response === undefined ? {} : { response }) };
}

function safeError(error: unknown, secrets: readonly string[]): string {
  return redactString(error instanceof Error ? error.message : String(error), secrets).slice(0, 2_000);
}

function replayBoundaryAttribution(failureKind: string, reason: string): FailureAttribution {
  return FailureAttributionSchema.parse({
    owner: "inconclusive",
    lane: "calibration",
    failureKind,
    reason,
    candidateStatusImpact: "excluded",
  });
}

function assertCostInputs(options: FocusedReplayRunOptions): void {
  if (!Number.isFinite(options.price.inputPerMillion) || options.price.inputPerMillion < 0
    || !Number.isFinite(options.price.outputPerMillion) || options.price.outputPerMillion < 0) {
    throw new Error("Focused replay token prices must be finite and nonnegative");
  }
}

/**
 * Replays only the recorded provider request. It has no StateStore or engine
 * dependency, so a successful variant cannot commit or mutate campaign state.
 * A replay ID never repeats a completed or possibly-in-flight physical call.
 */
export class FocusedReplayRunner {
  async run<T>(
    bundle: DiagnosticBundle,
    codec: FocusedReplayCodec<T>,
    variants: readonly ModelExecutionProfileDraft[],
    providerFor: (profile: ModelExecutionProfileDraft) => LlmProvider,
    options: FocusedReplayRunOptions,
  ): Promise<FocusedReplayRunResult> {
    const parsed = DiagnosticBundleSchema.parse(bundle);
    assertCostInputs(options);
    if (variants.length < 1 || variants.length > 8) {
      throw new Error("Focused replay requires between one and eight bounded variants");
    }
    const baseline = draftOf(parsed.executionProfile);
    const profiles = variants.map((rawVariant) => {
      const profile = ModelExecutionProfileDraftSchema.parse(rawVariant);
      if (profile.key.provider !== parsed.provider
        || profile.key.model !== parsed.model
        || profile.key.route !== parsed.route) {
        throw new Error("Focused replay variants must match the diagnostic provider, model, and route");
      }
      if (JSON.stringify(profile) !== JSON.stringify(baseline)) {
        assertSingleCalibrationVariableChange(baseline, profile);
      }
      return profile;
    });
    const profileHashes = profiles.map((profile) => hashPlaytestValue(profile));
    if (new Set(profileHashes).size !== profileHashes.length) {
      throw new Error("Focused replay variants must be unique");
    }
    // Provider construction and identity validation are no-call preflight checks.
    const providers = profiles.map((profile) => {
      const provider = providerFor(profile);
      if (provider.id !== parsed.provider || provider.model !== parsed.model) {
        throw new Error("Focused replay provider/model must match the diagnostic bundle");
      }
      return provider;
    });

    const now = options.now ?? (() => new Date());
    const replayId = FocusedReplayIdSchema.parse(options.replayId ?? randomUUID());
    const directory = path.join(path.resolve(options.artifactsRoot), replayId);
    const manifestPath = path.join(directory, "manifest.json");
    const resultsPath = path.join(directory, "attempts.jsonl");
    await mkdir(directory, { recursive: true });
    const releaseLock = await acquireFileLock(path.join(directory, ".replay.lock"), `Focused replay ${replayId}`);
    try {
      const bundleHash = hashPlaytestValue(parsed);
      let manifest = await readReplayManifest(manifestPath);
      const replayBundlePath = path.join(directory, "diagnostic.json");
      try {
        const savedBundle = await readDiagnosticBundle(replayBundlePath);
        if (hashPlaytestValue(savedBundle) !== bundleHash) {
          throw new Error("Focused replay diagnostic copy does not match the requested evidence");
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        await writeDiagnosticBundle(replayBundlePath, parsed);
      }
    if (manifest) {
      if (manifest.diagnosticBundleHash !== bundleHash
        || manifest.maxCostUsd !== options.costManager.ceilingUsd
        || JSON.stringify(manifest.price) !== JSON.stringify(options.price)
        || JSON.stringify(manifest.variants.map((variant) => variant.profileHash)) !== JSON.stringify(profileHashes)) {
        throw new Error("Focused replay ID already belongs to different evidence, variants, pricing, or cost ceiling");
      }
      if (options.costManager.spentUsd !== manifest.totalEstimatedCostUsd) {
        throw new Error("Resuming focused replay requires a dedicated cost manager restored to manifest spend");
      }
    } else {
      if (options.costManager.spentUsd !== 0) {
        throw new Error("A new focused replay requires a dedicated zero-spend cost manager");
      }
      const timestamp = now().toISOString();
      manifest = FocusedReplayManifestSchema.parse({
        schemaVersion: FOCUSED_REPLAY_MANIFEST_VERSION,
        kind: "focused_replay",
        replayId,
        startedAt: timestamp,
        updatedAt: timestamp,
        status: "running",
        diagnosticBundleHash: bundleHash,
        provider: parsed.provider,
        model: parsed.model,
        route: parsed.route,
        maxCostUsd: options.costManager.ceilingUsd,
        price: options.price,
        totalEstimatedCostUsd: 0,
        variants: profiles.map((profile, index) => ({
          index,
          profile,
          profileHash: profileHashes[index]!,
          status: "pending",
        })),
      });
      await atomicWriteJson(manifestPath, manifest);
    }

    const persisted = FocusedReplayRecordSchema.array().parse(await readPlaytestJsonLines(resultsPath));
    const latest = new Map<number, FocusedReplayRecord>();
    for (const record of persisted) latest.set(record.variantIndex, record);
    let interrupted = false;
    for (const variant of manifest.variants) {
      const record = latest.get(variant.index);
      if (record) {
        if (record.profileHash !== variant.profileHash) {
          throw new Error(`Focused replay record ${variant.index} does not match its profile`);
        }
        variant.status = record.outcome === "success" ? "succeeded"
          : record.outcome === "failure" ? "failed"
            : record.outcome;
      } else if (variant.status === "running") {
        const timestamp = now().toISOString();
        const interruptedRecord = FocusedReplayRecordSchema.parse({
          variantIndex: variant.index,
          profileHash: variant.profileHash,
          timestamp,
          outcome: "interrupted",
          success: false,
          durationMs: 0,
          queueWaitMs: 0,
          providerCallMs: 0,
          estimatedCostUsd: 0,
          costBasis: "unknown",
          attribution: replayBoundaryAttribution("interrupted", "unrecorded_replay_call"),
          error: "Replay stopped with an in-flight or unrecorded call; cost is unknown and this replay ID will not call again",
        });
        await appendPlaytestJsonLine(resultsPath, interruptedRecord);
        latest.set(variant.index, interruptedRecord);
        variant.status = "interrupted";
        interrupted = true;
      }
    }
    if (interrupted) {
      manifest.status = "interrupted";
      manifest.updatedAt = now().toISOString();
      manifest.completedAt = manifest.updatedAt;
      await atomicWriteJson(manifestPath, manifest);
    }

    const inMemoryResponses = new Map<number, unknown>();
    if (!interrupted && manifest.status === "running") {
      for (const variant of manifest.variants) {
        if (latest.has(variant.index)) continue;
        if (options.signal?.aborted) {
          manifest.status = "cancelled";
          break;
        }
        variant.status = "running";
        manifest.updatedAt = now().toISOString();
        await atomicWriteJson(manifestPath, manifest);

        const profile = profiles[variant.index]!;
        const provider = providers[variant.index]!;
        const replayRequest: StructuredRequest<T> = {
          schemaName: parsed.request.schemaName,
          schema: codec.schema,
          ...(codec.wireSchema ? { wireSchema: codec.wireSchema } : {}),
          jsonSchema: parsed.request.jsonSchema,
          ...(codec.decodeResponse ? { decodeResponse: codec.decodeResponse } : {}),
          ...(parsed.request.protocolVersion === undefined ? {} : { protocolVersion: parsed.request.protocolVersion }),
          system: parsed.request.system,
          prompt: parsed.request.prompt,
          ...(parsed.request.temperature === undefined ? {} : { temperature: parsed.request.temperature }),
          maxOutputTokens: parsed.request.maxOutputTokens,
          ...(parsed.request.outputTokenCeiling === undefined
            ? {}
            : { outputTokenCeiling: parsed.request.outputTokenCeiling }),
          ...(parsed.request.generationPhase === undefined ? {} : { generationPhase: parsed.request.generationPhase }),
          ...(parsed.request.repairOfPhase === undefined ? {} : { repairOfPhase: parsed.request.repairOfPhase }),
          ...(parsed.request.attemptKind === undefined ? {} : { attemptKind: parsed.request.attemptKind }),
          ...(parsed.request.retryBackoffMs === undefined ? {} : { retryBackoffMs: parsed.request.retryBackoffMs }),
        };
        const reservationEstimate = estimatePlaytestReservation(
          {
            ...replayRequest,
            maxOutputTokens: Math.min(
              outputBudgetForPhase(
                profile,
                parsed.request.generationPhase ?? "decision",
                parsed.request.repairOfPhase,
              ),
              parsed.request.outputTokenCeiling ?? Number.MAX_SAFE_INTEGER,
            ),
          } as StructuredRequest<unknown>,
          options.price,
        );
        let reservation: symbol;
        try {
          reservation = await options.costManager.acquire(reservationEstimate);
        } catch (error) {
          if (!(error instanceof PlaytestCostLimitError)) throw error;
          const record = FocusedReplayRecordSchema.parse({
            variantIndex: variant.index,
            profileHash: variant.profileHash,
            timestamp: now().toISOString(),
            outcome: "cost_limit",
            success: false,
            durationMs: 0,
            queueWaitMs: 0,
            providerCallMs: 0,
            estimatedCostUsd: 0,
            costBasis: "no_call",
            attribution: replayBoundaryAttribution("cost_limit", "hard_cost_ceiling"),
            error: error.message,
          });
          await appendPlaytestJsonLine(resultsPath, record);
          latest.set(variant.index, record);
          variant.status = "cost_limit";
          manifest.status = "cost_limit";
          break;
        }
        if (options.signal?.aborted) {
          options.costManager.release(reservation);
          variant.status = "cancelled";
          manifest.status = "cancelled";
          break;
        }

        const startedAt = Date.now();
        let providerCallStarted = false;
        try {
          const scheduled = await options.scheduler.schedule(parsed.provider, async () => {
            providerCallStarted = true;
            return provider.generateStructured(replayRequest);
          }, options.signal);
          const result = scheduled.value;
          const hasUsage = result.usage?.billedCostUsd !== undefined
            || result.usage?.inputTokens !== undefined
            || result.usage?.outputTokens !== undefined;
          const cost = estimatePlaytestCost(result.usage, options.price, reservationEstimate);
          options.costManager.commit(reservation, cost);
          const record = FocusedReplayRecordSchema.parse({
            variantIndex: variant.index,
            profileHash: variant.profileHash,
            timestamp: now().toISOString(),
            outcome: "success",
            success: true,
            durationMs: Date.now() - startedAt,
            queueWaitMs: scheduled.queueWaitMs,
            providerCallMs: scheduled.providerCallMs,
            estimatedCostUsd: cost,
            costBasis: hasUsage ? "reported_usage" : "reserved_estimate",
          });
          await appendPlaytestJsonLine(resultsPath, record);
          latest.set(variant.index, record);
          inMemoryResponses.set(variant.index, result.data);
          variant.status = "succeeded";
        } catch (error) {
          const timing = scheduledCallTimingFor(error) ?? { queueWaitMs: 0, providerCallMs: 0 };
          if (!providerCallStarted) {
            options.costManager.release(reservation);
          } else {
            const usage = structuredFailureDetails(error)?.usage;
            options.costManager.commit(
              reservation,
              estimatePlaytestCost(usage, options.price, reservationEstimate),
            );
          }
          const cancelled = options.signal?.aborted === true && !providerCallStarted;
          const attribution = cancelled
            ? replayBoundaryAttribution("cancelled", "cancelled_before_provider_call")
            : attributePlaytestFailure(error, { lane: "calibration", stage: "provider_call" });
          const cost = providerCallStarted
            ? estimatePlaytestCost(structuredFailureDetails(error)?.usage, options.price, reservationEstimate)
            : 0;
          const record = FocusedReplayRecordSchema.parse({
            variantIndex: variant.index,
            profileHash: variant.profileHash,
            timestamp: now().toISOString(),
            outcome: cancelled ? "cancelled" : "failure",
            success: false,
            durationMs: Date.now() - startedAt,
            queueWaitMs: timing.queueWaitMs,
            providerCallMs: timing.providerCallMs,
            estimatedCostUsd: cost,
            costBasis: providerCallStarted ? "reserved_estimate" : "no_call",
            attribution,
            error: safeError(error, options.secrets ?? []),
          });
          await appendPlaytestJsonLine(resultsPath, record);
          latest.set(variant.index, record);
          variant.status = cancelled ? "cancelled" : "failed";
          if (cancelled) manifest.status = "cancelled";
        }
        manifest.totalEstimatedCostUsd = options.costManager.spentUsd;
        manifest.updatedAt = now().toISOString();
        await atomicWriteJson(manifestPath, manifest);
        if (manifest.status !== "running") break;
      }
    }

    if (manifest.status === "running") {
      manifest.status = manifest.variants.some((variant) => variant.status === "failed")
        ? "completed_with_failures"
        : "completed";
    }
    manifest.completedAt ??= now().toISOString();
    manifest.totalEstimatedCostUsd = options.costManager.spentUsd;
    manifest.updatedAt = now().toISOString();
    await atomicWriteJson(manifestPath, manifest);

    const results = [...latest.values()]
      .sort((left, right) => left.variantIndex - right.variantIndex)
      .map((record) => resultFromRecord(
        record,
        profiles[record.variantIndex]!,
        inMemoryResponses.get(record.variantIndex),
      ));
      return {
        replayId,
        directory,
        status: manifest.status,
        totalEstimatedCostUsd: manifest.totalEstimatedCostUsd,
        results,
      };
    } finally {
      await releaseLock();
    }
  }
}
