import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { classifyFailure } from "../../../src/llm/failures.js";
import { requestDiagnosticsFor } from "../../../src/llm/request-diagnostics.js";
import {
  attemptMetadataFor,
  structuredFailureDetails,
} from "../../../src/llm/structured-error.js";
import {
  outputBudgetForPhase,
  type FrozenModelExecutionProfile,
} from "../../../src/model-execution-profile.js";
import type {
  LlmProvider,
  ProviderAttemptMetadata,
  StructuredRequest,
  StructuredResult,
} from "../../../src/types.js";
import {
  estimatePlaytestCost,
  estimatePlaytestReservation,
  type PlaytestModelCost,
  PlaytestCostLimitError,
  PlaytestCostManager,
} from "./cost.js";
import {
  reservationLedgerPathForCalls,
  reservePlaytestCallCost,
  settlePlaytestCallCost,
} from "./cost-ledger.js";
import {
  PlaytestCallRecordSchema,
  type PlaytestCallRecord,
} from "./contracts.js";
import {
  attributePlaytestFailure,
  type FailureAttribution,
  type PlaytestCallLane,
} from "./failure-attribution.js";
import { appendPlaytestJsonLine, hashPlaytestValue } from "./files.js";
import {
  createDiagnosticBundle,
  writeDiagnosticBundle,
} from "./replay.js";
import {
  PlaytestProviderScheduler,
  scheduledCallTimingFor,
} from "./scheduler.js";

export type PlaytestTelemetryActor = "calibration" | "candidate" | "player_driver" | "judge";
export type PlaytestTelemetryPhase = PlaytestCallRecord["phase"];

export interface PlaytestTelemetryProviderOptions {
  actor: PlaytestTelemetryActor;
  lane: PlaytestCallLane;
  jobId: string;
  route: string;
  profile: FrozenModelExecutionProfile;
  phase?: PlaytestTelemetryPhase;
  base: LlmProvider;
  price: PlaytestModelCost;
  costManager: PlaytestCostManager;
  scheduler: PlaytestProviderScheduler;
  callsPath: string;
  diagnosticsDir: string;
  /** Distinguishes independently rerunnable judge/checkpoint providers. */
  callNamespace?: string | undefined;
  initialSequence?: number | undefined;
  signal?: AbortSignal | undefined;
  secrets?: readonly string[] | undefined;
  onRecord?: ((record: PlaytestCallRecord) => void | Promise<void>) | undefined;
  deadlineAt?: number | undefined;
}

export class PlaytestDurationLimitError extends Error {
  constructor() {
    super("Playtest duration limit reached");
    this.name = "PlaytestDurationLimitError";
  }
}

function providerPhase(
  request: StructuredRequest<unknown>,
  fallback: PlaytestTelemetryPhase | undefined,
): PlaytestTelemetryPhase {
  if (fallback) return fallback;
  if (request.generationPhase === "setup") return "setup";
  if (request.generationPhase === "locked_resolution") return "locked_resolution";
  if (request.generationPhase === "repair") return "repair";
  return "decision";
}

function requestSchema(request: StructuredRequest<unknown>): Record<string, unknown> {
  return request.jsonSchema
    ?? z.toJSONSchema(request.wireSchema ?? request.schema, { target: "draft-7" }) as Record<string, unknown>;
}

function outputBudget(
  request: StructuredRequest<unknown>,
  metadata: ProviderAttemptMetadata | undefined,
  profile: FrozenModelExecutionProfile,
): number {
  if (metadata) return metadata.outputTokenBudget;
  const profiled = outputBudgetForPhase(
    profile,
    request.generationPhase ?? "decision",
    request.repairOfPhase,
  );
  return request.outputTokenCeiling === undefined
    ? profiled
    : Math.min(profiled, request.outputTokenCeiling);
}

function timeoutFor(
  request: StructuredRequest<unknown>,
  metadata: ProviderAttemptMetadata | undefined,
  profile: FrozenModelExecutionProfile,
): number {
  if (metadata?.timeoutMs !== undefined) return metadata.timeoutMs;
  if (request.generationPhase === "setup") return profile.timeout.setupMs;
  if (request.generationPhase === "locked_resolution") return profile.timeout.lockedResolutionMs;
  if (request.generationPhase === "repair") return profile.timeout.repairMs;
  return profile.timeout.decisionMs;
}

function safeError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 2_000);
}

function redactSecrets(value: string, secrets: readonly string[]): string {
  let redacted = value;
  for (const secret of secrets) {
    if (secret) redacted = redacted.replaceAll(secret, "[redacted]");
  }
  return redacted;
}

/**
 * The single playtest call boundary. It owns scheduling, reservations, lane-
 * specific telemetry, failure attribution, and non-committing replay evidence.
 */
export class PlaytestTelemetryProvider implements LlmProvider {
  readonly id: string;
  readonly model: string;
  private sequence = 0;
  private stateSnapshot = "";

  constructor(private readonly options: PlaytestTelemetryProviderOptions) {
    this.id = options.base.id;
    this.model = options.base.model;
    if (options.profile.key.provider !== this.id || options.profile.key.model !== this.model) {
      throw new Error("Telemetry execution profile does not match its provider/model");
    }
    this.sequence = options.initialSequence ?? 0;
  }

  /** Capture the authoritative pre-turn state used by any calls in that turn. */
  setPreCallStateSnapshot(snapshot: string): void {
    this.stateSnapshot = snapshot;
  }

  async generateStructured<T>(request: StructuredRequest<T>): Promise<StructuredResult<T>> {
    const assertDurationBudget = (): void => {
      if (this.options.deadlineAt === undefined) return;
      const timeoutMs = timeoutFor(
        request as StructuredRequest<unknown>,
        undefined,
        this.options.profile,
      );
      if (Date.now() + timeoutMs > this.options.deadlineAt) {
        throw new PlaytestDurationLimitError();
      }
    };
    assertDurationBudget();
    this.sequence += 1;
    const sequence = this.sequence;
    const namespace = this.options.callNamespace ? `-${this.options.callNamespace}` : "";
    const callId = `${this.options.jobId}-${this.options.actor}${namespace}-${String(sequence).padStart(5, "0")}`;
    const costReservationId = randomUUID();
    const reservationsPath = reservationLedgerPathForCalls(this.options.callsPath);
    const budgetQueuedAt = Date.now();
    const reservationRequest = {
      ...request,
      maxOutputTokens: outputBudget(
        request as StructuredRequest<unknown>,
        undefined,
        this.options.profile,
      ),
    } as StructuredRequest<unknown>;
    const reservationEstimate = estimatePlaytestReservation(reservationRequest, this.options.price);
    const reservation = await this.options.costManager.acquire(reservationEstimate);
    const costWaitMs = Date.now() - budgetQueuedAt;
    try {
      assertDurationBudget();
    } catch (error) {
      this.options.costManager.release(reservation);
      throw error;
    }
    try {
      await reservePlaytestCallCost(reservationsPath, {
        reservationId: costReservationId,
        callId,
        estimatedCostUsd: reservationEstimate,
      });
    } catch (error) {
      this.options.costManager.release(reservation);
      throw error;
    }
    const schema = requestSchema(request as StructuredRequest<unknown>);
    let costCommitted = false;

    try {
      const scheduled = await this.options.scheduler.schedule(
        this.id,
        () => {
          assertDurationBudget();
          return this.options.base.generateStructured(request);
        },
        this.options.signal,
      );
      const result = scheduled.value;
      const metadata = result.attemptMetadata;
      const hasReportedUsage = result.usage?.billedCostUsd !== undefined
        || result.usage?.inputTokens !== undefined
        || result.usage?.outputTokens !== undefined;
      const cost = estimatePlaytestCost(result.usage, this.options.price, reservationEstimate);
      this.options.costManager.commit(reservation, cost);
      costCommitted = true;
      const record = PlaytestCallRecordSchema.parse({
        id: callId,
        timestamp: new Date().toISOString(),
        jobId: this.options.jobId,
        actor: this.options.actor,
        phase: providerPhase(request as StructuredRequest<unknown>, this.options.phase),
        sequence,
        schemaName: request.schemaName,
        provider: result.provider,
        model: result.model,
        route: this.options.route,
        executionProfileFingerprint: this.options.profile.fingerprint,
        costReservationId,
        costWaitMs,
        queueWaitMs: scheduled.queueWaitMs,
        providerDurationMs: scheduled.providerCallMs,
        retryBackoffMs: metadata?.retryBackoffMs ?? request.retryBackoffMs ?? 0,
        promptHash: hashPlaytestValue(request.prompt),
        systemHash: hashPlaytestValue(request.system),
        schemaHash: hashPlaytestValue(schema),
        structuredMode: metadata?.structuredMode ?? result.structuredMode,
        schemaProjection: metadata?.schemaProjection ?? this.options.profile.structuredOutput.projection,
        outputTokenField: metadata?.outputTokenField ?? this.options.profile.outputTokenField,
        outputTokenBudget: outputBudget(request as StructuredRequest<unknown>, metadata, this.options.profile),
        timeoutMs: timeoutFor(request as StructuredRequest<unknown>, metadata, this.options.profile),
        finishReason: metadata?.finishReason,
        truncated: metadata?.truncated,
        requestDiagnostics: result.requestDiagnostics,
        success: true,
        estimatedCostUsd: cost,
        costBasis: hasReportedUsage ? "reported_usage" : "reserved_estimate",
        inputTokens: result.usage?.inputTokens,
        outputTokens: result.usage?.outputTokens,
        repairKind: request.attemptKind === "schema_repair"
          ? "schema"
          : request.attemptKind === "transient_retry"
            ? "transient"
            : request.attemptKind === "domain_repair" ? "domain" : undefined,
      });
      await this.persist(record);
      await settlePlaytestCallCost(reservationsPath, costReservationId);
      return result;
    } catch (error) {
      if (costCommitted) throw error;
      if (error instanceof PlaytestCostLimitError || error instanceof PlaytestDurationLimitError) {
        this.options.costManager.release(reservation);
        await settlePlaytestCallCost(reservationsPath, costReservationId);
        throw error;
      }
      const scheduledTiming = scheduledCallTimingFor(error);
      if (this.options.signal?.aborted && (scheduledTiming?.providerCallMs ?? 0) === 0) {
        this.options.costManager.release(reservation);
        await settlePlaytestCallCost(reservationsPath, costReservationId);
        throw error;
      }
      const failed = structuredFailureDetails(error);
      const metadata = failed?.attemptMetadata ?? attemptMetadataFor(error);
      const timing = scheduledTiming ?? { queueWaitMs: 0, providerCallMs: 0 };
      const hasReportedUsage = failed?.usage?.billedCostUsd !== undefined
        || failed?.usage?.inputTokens !== undefined
        || failed?.usage?.outputTokens !== undefined;
      const cost = estimatePlaytestCost(failed?.usage, this.options.price, reservationEstimate);
      this.options.costManager.commit(reservation, cost);
      costCommitted = true;
      const attribution = attributePlaytestFailure(error, {
        lane: this.options.lane,
        stage: "provider_call",
        ...(metadata ? { attemptMetadata: metadata } : {}),
      });
      const diagnostics = requestDiagnosticsFor(error);
      const failureKind = classifyFailure(error).kind;
      const failureFingerprint = hashPlaytestValue({
        actor: this.options.actor,
        phase: providerPhase(request as StructuredRequest<unknown>, this.options.phase),
        provider: this.id,
        model: this.model,
        route: this.options.route,
        schemaName: request.schemaName,
        failureKind,
        failureOwner: attribution.owner,
        httpStatus: diagnostics?.httpStatus,
      });
      const record = PlaytestCallRecordSchema.parse({
        id: callId,
        timestamp: new Date().toISOString(),
        jobId: this.options.jobId,
        actor: this.options.actor,
        phase: providerPhase(request as StructuredRequest<unknown>, this.options.phase),
        sequence,
        schemaName: request.schemaName,
        provider: this.id,
        model: this.model,
        route: this.options.route,
        executionProfileFingerprint: this.options.profile.fingerprint,
        costReservationId,
        costWaitMs,
        queueWaitMs: timing.queueWaitMs,
        providerDurationMs: timing.providerCallMs,
        retryBackoffMs: metadata?.retryBackoffMs ?? request.retryBackoffMs ?? 0,
        promptHash: hashPlaytestValue(request.prompt),
        systemHash: hashPlaytestValue(request.system),
        schemaHash: hashPlaytestValue(schema),
        structuredMode: metadata?.structuredMode ?? failed?.structuredMode,
        schemaProjection: metadata?.schemaProjection ?? this.options.profile.structuredOutput.projection,
        outputTokenField: metadata?.outputTokenField ?? this.options.profile.outputTokenField,
        outputTokenBudget: outputBudget(request as StructuredRequest<unknown>, metadata, this.options.profile),
        timeoutMs: timeoutFor(request as StructuredRequest<unknown>, metadata, this.options.profile),
        finishReason: metadata?.finishReason,
        truncated: metadata?.truncated,
        requestDiagnostics: diagnostics,
        success: false,
        estimatedCostUsd: cost,
        costBasis: hasReportedUsage ? "reported_usage" : "reserved_estimate",
        inputTokens: failed?.usage?.inputTokens,
        outputTokens: failed?.usage?.outputTokens,
        repairKind: request.attemptKind === "schema_repair"
          ? "schema"
          : request.attemptKind === "transient_retry"
            ? "transient"
            : request.attemptKind === "domain_repair" ? "domain" : undefined,
        failureKind,
        failureOwner: attribution.owner,
        failureFingerprint,
        error: redactSecrets(safeError(error), this.options.secrets ?? []),
      });
      await this.persist(record);
      await settlePlaytestCallCost(reservationsPath, costReservationId);
      try {
        await this.persistDiagnostic(
          callId,
          request as StructuredRequest<unknown>,
          schema,
          metadata,
          attribution,
          error,
          diagnostics,
        );
      } catch {
        // Diagnostics are best-effort evidence and never replace the typed call failure.
      }
      throw error;
    }
  }

  private async persist(record: PlaytestCallRecord): Promise<void> {
    await appendPlaytestJsonLine(this.options.callsPath, record);
    await this.options.onRecord?.(record);
  }

  private async persistDiagnostic(
    callId: string,
    request: StructuredRequest<unknown>,
    schema: Record<string, unknown>,
    metadata: ProviderAttemptMetadata | undefined,
    attribution: FailureAttribution,
    error: unknown,
    requestDiagnostics: ReturnType<typeof requestDiagnosticsFor>,
  ): Promise<void> {
    await mkdir(this.options.diagnosticsDir, { recursive: true });
    const bundle = createDiagnosticBundle({
      expectedPhase: request.generationPhase ?? "decision",
      profile: this.options.profile,
      stateSnapshot: this.stateSnapshot,
      request: { ...request, jsonSchema: schema },
      responseMetadata: {
        ...(metadata ? { attemptMetadata: metadata } : {}),
        ...(requestDiagnostics ? { requestDiagnostics } : {}),
      },
      attribution,
      failureKind: classifyFailure(error).kind,
      failureMessage: safeError(error),
      secrets: this.options.secrets ?? [],
    });
    await writeDiagnosticBundle(path.join(this.options.diagnosticsDir, `${callId}.json`), bundle);
  }
}
