import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import { open, readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  APPLICATION_SCHEMA_FRAMING_TOKEN_RESERVE,
  conservativeInputTokenEstimate,
  resolveEffectiveOutputTokenBudget,
} from "./input-budget.js";
import { attemptMetadataFor, structuredFailureDetails } from "./llm/structured-error.js";
import {
  ModelGenerationPhaseSchema,
  OutputTokenFieldSchema,
  SchemaProjectionIdSchema,
} from "./model-execution-profile.js";
import { atomicWriteJson, pathExists } from "./persistence/files.js";
import { withSerializedFileLock } from "./persistence/lock.js";
import { estimateTokenCost, inferTokenPrice, roundUsd, type TokenPrice } from "./pricing.js";
import type {
  LlmProvider,
  ProviderAttemptMetadata,
  StructuredOutputBudgetRequest,
  StructuredRequest,
  StructuredResult,
} from "./types.js";
import type { Usage } from "./usage.js";

export type CampaignBudgetBasis = "exact" | "estimated" | "reserved" | "mixed" | "unpriced";
export type CampaignBudgetPauseReason =
  "campaign_limit" | "logical_turn_limit" | "pricing_unavailable";

export interface CampaignBudgetLimits {
  campaignUsd: number | null;
  logicalTurnUsd: number | null;
}

export interface CampaignBudgetUpdate {
  /** Null removes a limit; an omitted field preserves its current value. */
  campaignUsd?: number | null;
  /** Null removes a limit; an omitted field preserves its current value. */
  logicalTurnUsd?: number | null;
}

export interface CampaignBudgetSnapshot {
  limits: CampaignBudgetLimits;
  spentUsd: number;
  reservedUsd: number;
  remainingUsd: number | null;
  basis: CampaignBudgetBasis;
  projectedNextTurnUsd: number | null;
  projected100TurnsUsd: number | null;
  warningThreshold: 0.5 | 0.75 | 0.9 | 1 | null;
  paused: boolean;
  pauseReason: CampaignBudgetPauseReason | null;
  settledAttempts: number;
  unsettledAttempts: number;
}

export interface SpendingOperation {
  operationId?: string;
  lane: string;
}

interface ActiveSpendingOperation {
  operationId: string;
  lane: string;
}

const operationStorage = new AsyncLocalStorage<ActiveSpendingOperation>();

/**
 * Give every physical call made by one logical action the same durable cost
 * identity. Structured retries and repairs inherit this context automatically.
 */
export function runWithSpendingOperation<T>(operation: SpendingOperation, callback: () => T): T {
  const active = {
    operationId: operation.operationId ?? randomUUID(),
    lane: operation.lane,
  };
  return operationStorage.run(active, callback);
}

export function currentSpendingOperation(): Readonly<ActiveSpendingOperation> | undefined {
  return operationStorage.getStore();
}

/**
 * Reserve a complete logical-turn envelope before its first physical call and
 * release the unused remainder when the operation settles. This prevents a
 * checked turn from exhausting the campaign cap between decision and locked
 * resolution.
 */
export async function runWithReservedSpendingOperation<T>(
  controller: CampaignSpendingController,
  operation: SpendingOperation & { reservationUsd?: number },
  callback: () => Promise<T>,
): Promise<T> {
  const active = {
    operationId: operation.operationId ?? randomUUID(),
    lane: operation.lane,
  };
  await controller.beginOperation(active, operation.reservationUsd);
  try {
    return await operationStorage.run(active, callback);
  } finally {
    await controller.completeOperation(active.operationId);
  }
}

const CostBasisSchema = z.enum(["exact", "estimated", "reserved", "unpriced"]);
const AttemptKindSchema = z.enum([
  "initial",
  "schema_repair",
  "content_repair",
  "transient_retry",
  "domain_repair",
]);
const StructuredModeSchema = z.enum(["exact_schema", "json_object_local_schema"]);

const AttemptMetadataFields = {
  route: z.string().min(1).max(256).optional(),
  profileFingerprint: z.string().min(1).max(256).optional(),
  structuredMode: StructuredModeSchema.optional(),
  schemaProjection: SchemaProjectionIdSchema.optional(),
  outputTokenField: OutputTokenFieldSchema.optional(),
  outputTokenBudget: z.number().int().nonnegative().optional(),
  timeoutMs: z.number().int().nonnegative().optional(),
  retryBackoffMs: z.number().int().nonnegative().optional(),
  finishReason: z.string().max(256).optional(),
  truncated: z.boolean().optional(),
} as const;

const AttemptSchema = z
  .object({
    id: z.string().uuid(),
    operationId: z.string().min(1),
    lane: z.string().min(1),
    provider: z.string().min(1),
    model: z.string().min(1),
    schemaName: z.string().min(1),
    generationPhase: ModelGenerationPhaseSchema.optional(),
    attemptKind: AttemptKindSchema.optional(),
    ...AttemptMetadataFields,
    sessionId: z.string().min(1),
    reservedAt: z.string().datetime(),
    reservedUsd: z.number().nonnegative(),
    status: z.enum(["reserved", "settled"]),
    settledAt: z.string().datetime().optional(),
    costUsd: z.number().nonnegative().optional(),
    costBasis: CostBasisSchema.optional(),
    success: z.boolean().optional(),
  })
  .strict();

type SpendingAttempt = z.infer<typeof AttemptSchema>;

const TransferAttemptSchema = z
  .object({
    id: z.string().uuid(),
    operationId: z.string().min(1).max(256),
    lane: z.string().min(1).max(128),
    provider: z.string().min(1).max(128),
    model: z.string().min(1).max(256),
    schemaName: z.string().min(1).max(256),
    generationPhase: ModelGenerationPhaseSchema.optional(),
    attemptKind: AttemptKindSchema.optional(),
    ...AttemptMetadataFields,
    reservedAt: z.string().datetime(),
    reservedUsd: z.number().nonnegative(),
    settledAt: z.string().datetime(),
    costUsd: z.number().nonnegative(),
    costBasis: CostBasisSchema,
    success: z.boolean(),
  })
  .strict();

const OperationReservationSchema = z
  .object({
    operationId: z.string().min(1),
    lane: z.string().min(1),
    sessionId: z.string().min(1),
    reservedAt: z.string().datetime(),
    reservedUsd: z.number().nonnegative(),
    costUsd: z.number().nonnegative(),
  })
  .strict();

const RecentOperationSchema = z
  .object({
    operationId: z.string().min(1),
    lane: z.string().min(1),
    costUsd: z.number().nonnegative(),
    settledAt: z.string().datetime(),
  })
  .strict();

const SettledTotalsSchema = z
  .object({
    costUsd: z.number().nonnegative(),
    attempts: z.number().int().nonnegative(),
    exactAttempts: z.number().int().nonnegative(),
    estimatedAttempts: z.number().int().nonnegative(),
    reservedAttempts: z.number().int().nonnegative(),
    unpricedAttempts: z.number().int().nonnegative(),
  })
  .strict();

function totalsForTransferAttempts(
  attempts: readonly z.infer<typeof TransferAttemptSchema>[],
): z.infer<typeof SettledTotalsSchema> {
  const totals = {
    costUsd: 0,
    attempts: attempts.length,
    exactAttempts: 0,
    estimatedAttempts: 0,
    reservedAttempts: 0,
    unpricedAttempts: 0,
  };
  for (const attempt of attempts) {
    totals.costUsd = roundUsd(totals.costUsd + attempt.costUsd);
    if (attempt.costBasis === "exact") totals.exactAttempts += 1;
    else if (attempt.costBasis === "estimated") totals.estimatedAttempts += 1;
    else if (attempt.costBasis === "reserved") totals.reservedAttempts += 1;
    else totals.unpricedAttempts += 1;
  }
  return totals;
}

/**
 * Self-contained, secret-free spending history suitable for durable creation
 * intents and root-to-root campaign publication. Raw prompts, responses,
 * request headers, and provider errors are intentionally not representable.
 */
export const CampaignSpendingTransferPayloadSchema = z
  .object({
    schemaVersion: z.literal(1),
    limits: z
      .object({
        campaignUsd: z.number().positive().optional(),
        logicalTurnUsd: z.number().positive().optional(),
      })
      .strict(),
    baseline: z
      .object({
        costUsd: z.number().nonnegative(),
        basis: z.enum(["exact", "estimated", "mixed", "unpriced"]),
      })
      .strict(),
    settled: SettledTotalsSchema,
    attempts: z.array(TransferAttemptSchema),
  })
  .strict()
  .superRefine((payload, context) => {
    const seenIds = new Set<string>();
    let duplicateId: string | undefined;
    for (const attempt of payload.attempts) {
      if (seenIds.has(attempt.id)) {
        duplicateId = attempt.id;
        break;
      }
      seenIds.add(attempt.id);
    }
    if (duplicateId !== undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["attempts"],
        message: `Duplicate transferred physical attempt ID ${duplicateId}`,
      });
    }
    const computed = totalsForTransferAttempts(payload.attempts);
    for (const key of Object.keys(computed) as Array<keyof typeof computed>) {
      if (computed[key] !== payload.settled[key]) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["settled", key],
          message: `Transferred settled ${key} does not match the physical attempts`,
        });
      }
    }
  });

export type CampaignSpendingTransferPayload = z.infer<typeof CampaignSpendingTransferPayloadSchema>;

const LedgerSchema = z
  .object({
    schemaVersion: z.literal(1),
    limits: z
      .object({
        campaignUsd: z.number().positive().optional(),
        logicalTurnUsd: z.number().positive().optional(),
      })
      .strict(),
    baseline: z
      .object({
        costUsd: z.number().nonnegative(),
        basis: z.enum(["exact", "estimated", "mixed", "unpriced"]),
      })
      .strict(),
    settled: SettledTotalsSchema,
    operations: z.array(OperationReservationSchema).default([]),
    recentOperations: z.array(RecentOperationSchema).max(16),
    /** Only in-flight physical attempts live in the hot snapshot. */
    attempts: z.array(AttemptSchema),
    importedTransfer: z
      .object({
        digest: z.string().regex(/^[a-f0-9]{64}$/),
        attemptCount: z.number().int().nonnegative(),
        importedAt: z.string().datetime(),
      })
      .strict()
      .optional(),
    pause: z
      .object({
        reason: z.enum(["campaign_limit", "logical_turn_limit", "pricing_unavailable"]),
        operationId: z.string().min(1).optional(),
        at: z.string().datetime(),
      })
      .strict()
      .optional(),
  })
  .strict();

type SpendingLedger = z.infer<typeof LedgerSchema>;

export interface HistoricalCampaignCost {
  totalUsd: number;
  basis: "exact" | "estimated" | "mixed";
}

export interface CampaignSpendingControllerOptions {
  /** Frozen once when a ledger is first created, preventing later double counting. */
  historicalCost?: () => Promise<HistoricalCampaignCost>;
  /** Test seam for simulating a process restart. */
  sessionId?: string;
  now?: () => Date;
}

interface ReservationInput {
  provider: string;
  model: string;
  schemaName: string;
  generationPhase?: NonNullable<StructuredRequest<unknown>["generationPhase"]>;
  attemptKind?: NonNullable<StructuredRequest<unknown>["attemptKind"]>;
  outputTokenBudget?: number;
  retryBackoffMs?: number;
  reservedUsd: number;
  priced: boolean;
}

interface CostSettlement {
  costUsd: number;
  basis: Exclude<CampaignBudgetBasis, "mixed">;
  attemptMetadata?: ProviderAttemptMetadata;
}

interface Reservation {
  id: string;
  reservedUsd: number;
}

const PROCESS_SPENDING_SESSION_ID = randomUUID();
/** Settlements appended but not yet reflected by an atomic hot-ledger write. */
const processPendingJournalSettlements = new Map<string, SpendingAttempt>();
const NON_TURN_LANES = new Set([
  "setup",
  "question",
  "ask",
  "story",
  "completed_story",
  "autoplay_player",
  "player",
  "judge",
  "probe",
  "calibration",
  "unscoped",
]);

function isLogicalTurnLane(lane: string): boolean {
  return !NON_TURN_LANES.has(lane);
}

function optionalPositiveUsd(value: number | null | undefined, label: string): void {
  if (value === undefined || value === null) return;
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${label} must be a positive number`);
}

function journalKey(campaignRoot: string, attemptId: string): string {
  return `${path.resolve(campaignRoot)}\0${attemptId}`;
}

function settledAttemptForTransfer(
  attempt: SpendingAttempt,
): z.infer<typeof TransferAttemptSchema> {
  if (
    attempt.status !== "settled" ||
    attempt.settledAt === undefined ||
    attempt.costUsd === undefined ||
    attempt.costBasis === undefined ||
    attempt.success === undefined
  ) {
    throw new Error(`Physical attempt ${attempt.id} is not a complete settlement`);
  }
  const { sessionId: _sessionId, status: _status, ...transfer } = attempt;
  return TransferAttemptSchema.parse(transfer);
}

function spendingAttemptFromTransfer(
  attempt: z.infer<typeof TransferAttemptSchema>,
): SpendingAttempt {
  return AttemptSchema.parse({
    ...attempt,
    sessionId: "transferred",
    status: "settled",
  });
}

function normalizedTransferPayload(value: unknown): CampaignSpendingTransferPayload {
  const parsed = CampaignSpendingTransferPayloadSchema.parse(value);
  return CampaignSpendingTransferPayloadSchema.parse({
    ...parsed,
    attempts: [...parsed.attempts].sort(
      (left, right) =>
        left.reservedAt.localeCompare(right.reservedAt) || left.id.localeCompare(right.id),
    ),
  });
}

function transferDigest(payload: CampaignSpendingTransferPayload): string {
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

function attemptsMatch(left: SpendingAttempt, right: SpendingAttempt): boolean {
  return (
    JSON.stringify(settledAttemptForTransfer(left)) ===
    JSON.stringify(settledAttemptForTransfer(right))
  );
}

function allowlistedAttemptMetadata(
  metadata: ProviderAttemptMetadata | undefined,
): Partial<SpendingAttempt> {
  if (!metadata) return {};
  return {
    ...(metadata.generationPhase === undefined
      ? {}
      : { generationPhase: metadata.generationPhase }),
    attemptKind: metadata.attemptKind,
    route: metadata.route.slice(0, 256),
    ...(metadata.profileFingerprint === undefined
      ? {}
      : { profileFingerprint: metadata.profileFingerprint.slice(0, 256) }),
    structuredMode: metadata.structuredMode,
    schemaProjection: metadata.schemaProjection,
    outputTokenField: metadata.outputTokenField,
    outputTokenBudget: metadata.outputTokenBudget,
    ...(metadata.timeoutMs === undefined ? {} : { timeoutMs: metadata.timeoutMs }),
    retryBackoffMs: metadata.retryBackoffMs,
    ...(metadata.finishReason === undefined
      ? {}
      : { finishReason: metadata.finishReason.slice(0, 256) }),
    truncated: metadata.truncated,
  };
}

function totalSettled(ledger: SpendingLedger): number {
  return roundUsd(ledger.baseline.costUsd + ledger.settled.costUsd);
}

function totalReserved(ledger: SpendingLedger): number {
  const activeOperationIds = new Set(ledger.operations.map((operation) => operation.operationId));
  const operationReservations = ledger.operations.reduce((sum, operation) => {
    return sum + Math.max(operation.reservedUsd - operation.costUsd, 0);
  }, 0);
  return roundUsd(
    operationReservations +
      ledger.attempts.reduce(
        (sum, attempt) =>
          !activeOperationIds.has(attempt.operationId) ? sum + attempt.reservedUsd : sum,
        0,
      ),
  );
}

function operationExposure(ledger: SpendingLedger, operationId: string): number {
  const activeOperation = ledger.operations.find(
    (operation) => operation.operationId === operationId,
  );
  return roundUsd(
    (activeOperation?.costUsd ??
      ledger.recentOperations.find((operation) => operation.operationId === operationId)?.costUsd ??
      0) +
      ledger.attempts.reduce(
        (sum, attempt) => (attempt.operationId === operationId ? sum + attempt.reservedUsd : sum),
        0,
      ),
  );
}

function snapshotBasis(ledger: SpendingLedger): CampaignBudgetBasis {
  const bases = new Set<string>();
  if (ledger.baseline.costUsd > 0) bases.add(ledger.baseline.basis);
  if (ledger.settled.exactAttempts > 0) bases.add("exact");
  if (ledger.settled.estimatedAttempts > 0) bases.add("estimated");
  if (ledger.settled.reservedAttempts > 0) bases.add("reserved");
  if (ledger.settled.unpricedAttempts > 0) bases.add("unpriced");
  if (bases.size === 0) return "unpriced";
  if (bases.size === 1) return [...bases][0] as CampaignBudgetBasis;
  return "mixed";
}

function projection(ledger: SpendingLedger): number | null {
  const excluded = new Set(["setup", "story", "question", "autoplay_player", "judge"]);
  let candidates = ledger.recentOperations.filter((item) => !excluded.has(item.lane));
  if (candidates.length === 0) candidates = ledger.recentOperations;
  candidates.sort((left, right) => left.settledAt.localeCompare(right.settledAt));
  const recent = candidates.slice(-8);
  if (recent.length === 0) return null;
  return roundUsd(recent.reduce((sum, item) => sum + item.costUsd, 0) / recent.length);
}

function warningThreshold(
  exposure: number,
  limit: number | undefined,
): 0.5 | 0.75 | 0.9 | 1 | null {
  if (limit === undefined) return null;
  const fraction = exposure / limit;
  if (fraction >= 1) return 1;
  if (fraction >= 0.9) return 0.9;
  if (fraction >= 0.75) return 0.75;
  if (fraction >= 0.5) return 0.5;
  return null;
}

export class CampaignBudgetExhaustedError extends Error {
  readonly code = "campaign_budget_exhausted" as const;

  constructor(
    readonly reason: CampaignBudgetPauseReason,
    readonly requiredUsd: number,
    readonly availableUsd: number | null,
    readonly operationId: string,
    readonly lane: string,
  ) {
    const scope = reason === "logical_turn_limit" ? "logical-turn" : "campaign";
    const detail =
      reason === "pricing_unavailable"
        ? "The model has no known token price, so the configured USD cap cannot be guaranteed"
        : `The ${scope} budget has $${Math.max(availableUsd ?? 0, 0).toFixed(6)} remaining but this provider attempt requires a $${requiredUsd.toFixed(6)} reservation`;
    super(`${detail}; no provider request was made`);
    this.name = "CampaignBudgetExhaustedError";
  }
}

/** Durable per-campaign authority for physical provider attempt spending. */
export class CampaignSpendingController {
  readonly ledgerPath: string;
  readonly archivePath: string;
  readonly lockPath: string;
  private readonly sessionId: string;
  private readonly now: () => Date;

  constructor(
    readonly campaignRoot: string,
    private readonly options: CampaignSpendingControllerOptions = {},
  ) {
    this.ledgerPath = path.join(campaignRoot, "spending.json");
    this.archivePath = path.join(campaignRoot, "spending-attempts.jsonl");
    this.lockPath = path.join(campaignRoot, ".spending.lock");
    this.sessionId = options.sessionId ?? PROCESS_SPENDING_SESSION_ID;
    this.now = options.now ?? (() => new Date());
  }

  async campaignBudget(): Promise<CampaignBudgetSnapshot> {
    return this.withLedger((ledger) => this.toSnapshot(ledger), false);
  }

  async updateCampaignBudget(update: CampaignBudgetUpdate): Promise<CampaignBudgetSnapshot> {
    optionalPositiveUsd(update.campaignUsd, "Campaign budget");
    optionalPositiveUsd(update.logicalTurnUsd, "Logical-turn budget");
    return this.withLedger(async (ledger, persist) => {
      if (Object.hasOwn(update, "campaignUsd")) {
        if (update.campaignUsd === null) delete ledger.limits.campaignUsd;
        else if (update.campaignUsd !== undefined) ledger.limits.campaignUsd = update.campaignUsd;
      }
      if (Object.hasOwn(update, "logicalTurnUsd")) {
        if (update.logicalTurnUsd === null) delete ledger.limits.logicalTurnUsd;
        else if (update.logicalTurnUsd !== undefined)
          ledger.limits.logicalTurnUsd = update.logicalTurnUsd;
        if (ledger.pause?.reason === "logical_turn_limit") delete ledger.pause;
      }
      this.refreshPause(ledger);
      await persist();
      return this.toSnapshot(ledger);
    });
  }

  /**
   * A successful model change invalidates only a stale unknown-pricing pause.
   * Campaign and logical-turn limit pauses remain authoritative, and the next
   * unpriced physical request will establish a fresh pricing pause safely.
   */
  async acknowledgePricingChange(): Promise<CampaignBudgetSnapshot> {
    return this.withLedger(async (ledger, persist) => {
      if (ledger.pause?.reason === "pricing_unavailable") {
        delete ledger.pause;
        this.refreshPause(ledger);
        await persist();
      }
      return this.toSnapshot(ledger);
    }, false);
  }

  /** Export all settled physical calls plus the frozen historical baseline. */
  async exportTransferPayload(): Promise<CampaignSpendingTransferPayload> {
    return this.withLedger(async (ledger) => {
      if (ledger.operations.length > 0 || ledger.attempts.length > 0) {
        throw new Error("Spending cannot be transferred while provider work is unfinished");
      }
      const { attempts, duplicateIds } = await this.readArchivedAttempts();
      if (duplicateIds.size > 0) {
        throw new Error(
          `Spending cannot be transferred because physical attempt ${[...duplicateIds][0]} is duplicated`,
        );
      }
      const transferAttempts = [...attempts.values()].map(settledAttemptForTransfer);
      const payload = normalizedTransferPayload({
        schemaVersion: 1,
        limits: ledger.limits,
        baseline: ledger.baseline,
        settled: ledger.settled,
        attempts: transferAttempts,
      });
      return payload;
    });
  }

  /**
   * Initialize a fresh root from an immutable payload. Repeating the identical
   * import is a no-op; archive entries are deduplicated by physical attempt ID
   * so recovery after append-before-ledger-write is also idempotent.
   */
  async importTransferPayload(value: unknown): Promise<CampaignBudgetSnapshot> {
    const payload = normalizedTransferPayload(value);
    const digest = transferDigest(payload);
    return withSerializedFileLock(this.lockPath, "Campaign spending", async () => {
      const exists = await pathExists(this.ledgerPath);
      const ledger = exists
        ? LedgerSchema.parse(JSON.parse(await readFile(this.ledgerPath, "utf8")))
        : this.newLedger(undefined);
      if (ledger.importedTransfer) {
        if (ledger.importedTransfer.digest !== digest) {
          throw new Error("A different spending transfer was already imported into this campaign");
        }
        return this.toSnapshot(ledger);
      }
      if (
        ledger.settled.attempts !== 0 ||
        ledger.operations.length !== 0 ||
        ledger.recentOperations.length !== 0 ||
        ledger.attempts.length !== 0
      ) {
        throw new Error("Spending can only be imported before this campaign records provider work");
      }

      const archived = await this.readArchivedAttempts();
      if (archived.duplicateIds.size > 0) {
        throw new Error("Spending transfer recovery found an inconsistent destination archive");
      }
      const payloadIds = new Set(payload.attempts.map((attempt) => attempt.id));
      for (const id of archived.attempts.keys()) {
        if (!payloadIds.has(id)) {
          throw new Error(`Destination spending archive already contains unrelated attempt ${id}`);
        }
      }

      ledger.limits = { ...payload.limits };
      ledger.baseline = { ...payload.baseline };
      const importedAttempts: SpendingAttempt[] = [];
      const missingAttempts: SpendingAttempt[] = [];
      for (const transferred of payload.attempts) {
        const attempt = spendingAttemptFromTransfer(transferred);
        importedAttempts.push(attempt);
        const existing = archived.attempts.get(attempt.id);
        if (existing && !attemptsMatch(existing, attempt)) {
          throw new Error(`Transferred physical attempt ${attempt.id} conflicts with the archive`);
        }
        if (!existing) missingAttempts.push(attempt);
      }
      await this.appendSettledAttempts(missingAttempts);
      for (const attempt of importedAttempts) {
        this.recordSettledAttempt(ledger, attempt);
      }
      ledger.importedTransfer = {
        digest,
        attemptCount: payload.attempts.length,
        importedAt: this.now().toISOString(),
      };
      this.refreshPause(ledger);
      await atomicWriteJson(this.ledgerPath, LedgerSchema.parse(ledger));
      for (const attempt of payload.attempts) {
        processPendingJournalSettlements.delete(journalKey(this.campaignRoot, attempt.id));
      }
      return this.toSnapshot(ledger);
    });
  }

  async beginOperation(
    operation: ActiveSpendingOperation,
    requestedReservationUsd?: number,
  ): Promise<void> {
    optionalPositiveUsd(requestedReservationUsd, "Logical-operation reservation");
    await this.withLedger(async (ledger, persist) => {
      const existing = ledger.operations.find(
        (candidate) => candidate.operationId === operation.operationId,
      );
      if (existing) return;
      const reservedUsd = roundUsd(
        requestedReservationUsd ??
          (isLogicalTurnLane(operation.lane) ? (ledger.limits.logicalTurnUsd ?? 0) : 0),
      );
      const prior = ledger.recentOperations.find(
        (candidate) => candidate.operationId === operation.operationId,
      );
      const priorCostUsd = prior?.costUsd ?? 0;
      const requiredHoldUsd = roundUsd(Math.max(reservedUsd - priorCostUsd, 0));
      const exposure = roundUsd(totalSettled(ledger) + totalReserved(ledger));
      const available =
        ledger.limits.campaignUsd === undefined
          ? null
          : roundUsd(ledger.limits.campaignUsd - exposure);
      if (available !== null && requiredHoldUsd > available) {
        ledger.pause = { reason: "campaign_limit", at: this.now().toISOString() };
        await persist();
        throw new CampaignBudgetExhaustedError(
          "campaign_limit",
          requiredHoldUsd,
          available,
          operation.operationId,
          operation.lane,
        );
      }
      ledger.recentOperations = ledger.recentOperations.filter(
        (candidate) => candidate.operationId !== operation.operationId,
      );
      ledger.operations.push({
        operationId: operation.operationId,
        lane: operation.lane,
        sessionId: this.sessionId,
        reservedAt: this.now().toISOString(),
        reservedUsd,
        costUsd: priorCostUsd,
      });
      delete ledger.pause;
      await persist();
    });
  }

  async completeOperation(operationId: string): Promise<void> {
    await this.withLedger(async (ledger, persist) => {
      const operation = ledger.operations.find(
        (candidate) => candidate.operationId === operationId,
      );
      if (!operation) return;
      this.recordRecentOperation(ledger, operation.operationId, operation.lane, operation.costUsd);
      ledger.operations = ledger.operations.filter(
        (candidate) => candidate.operationId !== operationId,
      );
      this.refreshPause(ledger);
      await persist();
    });
  }

  async reserve(input: ReservationInput): Promise<Reservation> {
    const active = currentSpendingOperation() ?? {
      operationId: randomUUID(),
      lane: "unscoped",
    };
    return this.withLedger(async (ledger, persist) => {
      if (
        ledger.pause?.reason === "logical_turn_limit" &&
        ledger.pause.operationId !== active.operationId
      )
        delete ledger.pause;

      const hasUsdLimit =
        ledger.limits.campaignUsd !== undefined ||
        (isLogicalTurnLane(active.lane) && ledger.limits.logicalTurnUsd !== undefined);
      if (hasUsdLimit && !input.priced) {
        ledger.pause = {
          reason: "pricing_unavailable",
          operationId: active.operationId,
          at: this.now().toISOString(),
        };
        await persist();
        throw new CampaignBudgetExhaustedError(
          "pricing_unavailable",
          input.reservedUsd,
          null,
          active.operationId,
          active.lane,
        );
      }

      const campaignExposure = roundUsd(totalSettled(ledger) + totalReserved(ledger));
      const campaignAvailable =
        ledger.limits.campaignUsd === undefined
          ? null
          : roundUsd(ledger.limits.campaignUsd - campaignExposure);
      const activeEnvelope = ledger.operations.find(
        (operation) => operation.operationId === active.operationId,
      );
      const uncoveredReservation = activeEnvelope
        ? roundUsd(
            Math.max(
              operationExposure(ledger, active.operationId) +
                input.reservedUsd -
                activeEnvelope.reservedUsd,
              0,
            ),
          )
        : input.reservedUsd;
      if (campaignAvailable !== null && uncoveredReservation > campaignAvailable) {
        ledger.pause = { reason: "campaign_limit", at: this.now().toISOString() };
        await persist();
        throw new CampaignBudgetExhaustedError(
          "campaign_limit",
          uncoveredReservation,
          campaignAvailable,
          active.operationId,
          active.lane,
        );
      }

      const operationSpent = operationExposure(ledger, active.operationId);
      const logicalAvailable =
        !isLogicalTurnLane(active.lane) || ledger.limits.logicalTurnUsd === undefined
          ? null
          : roundUsd(ledger.limits.logicalTurnUsd - operationSpent);
      if (logicalAvailable !== null && input.reservedUsd > logicalAvailable) {
        ledger.pause = {
          reason: "logical_turn_limit",
          operationId: active.operationId,
          at: this.now().toISOString(),
        };
        await persist();
        throw new CampaignBudgetExhaustedError(
          "logical_turn_limit",
          input.reservedUsd,
          logicalAvailable,
          active.operationId,
          active.lane,
        );
      }

      const attempt: SpendingAttempt = {
        id: randomUUID(),
        operationId: active.operationId,
        lane: active.lane,
        provider: input.provider,
        model: input.model,
        schemaName: input.schemaName,
        ...(input.generationPhase === undefined ? {} : { generationPhase: input.generationPhase }),
        attemptKind: input.attemptKind ?? "initial",
        ...(input.outputTokenBudget === undefined
          ? {}
          : { outputTokenBudget: input.outputTokenBudget }),
        ...(input.retryBackoffMs === undefined ? {} : { retryBackoffMs: input.retryBackoffMs }),
        sessionId: this.sessionId,
        reservedAt: this.now().toISOString(),
        reservedUsd: roundUsd(input.reservedUsd),
        status: "reserved",
      };
      ledger.attempts.push(attempt);
      delete ledger.pause;
      await persist();
      return { id: attempt.id, reservedUsd: attempt.reservedUsd };
    });
  }

  async settle(reservationId: string, settlement: CostSettlement, success: boolean): Promise<void> {
    await this.withLedger(async (ledger, persist) => {
      const attempt = ledger.attempts.find((candidate) => candidate.id === reservationId);
      if (!attempt) return;
      const archivedAttempt = AttemptSchema.parse({
        ...attempt,
        ...allowlistedAttemptMetadata(settlement.attemptMetadata),
        status: "settled",
        settledAt: this.now().toISOString(),
        costUsd: roundUsd(settlement.costUsd),
        costBasis: settlement.basis,
        success,
      });
      // The journal is the recovery source for the narrow window before the
      // aggregate snapshot is replaced. Never acknowledge a settlement whose
      // audit record could not be made durable.
      const pendingKey = journalKey(this.campaignRoot, archivedAttempt.id);
      const pending = processPendingJournalSettlements.get(pendingKey);
      if (pending) {
        if (!attemptsMatch(pending, archivedAttempt)) {
          throw new Error(`Physical attempt ${reservationId} has a conflicting settlement`);
        }
      } else {
        await this.appendSettledAttempt(archivedAttempt);
      }
      this.recordSettledAttempt(ledger, archivedAttempt);
      ledger.attempts = ledger.attempts.filter((candidate) => candidate.id !== reservationId);
      this.refreshPause(ledger);
      await persist();
      processPendingJournalSettlements.delete(pendingKey);
    });
  }

  private newLedger(historical: HistoricalCampaignCost | undefined): SpendingLedger {
    return LedgerSchema.parse({
      schemaVersion: 1,
      limits: {},
      baseline: historical
        ? { costUsd: roundUsd(historical.totalUsd), basis: historical.basis }
        : { costUsd: 0, basis: "unpriced" },
      settled: {
        costUsd: 0,
        attempts: 0,
        exactAttempts: 0,
        estimatedAttempts: 0,
        reservedAttempts: 0,
        unpricedAttempts: 0,
      },
      operations: [],
      recentOperations: [],
      attempts: [],
    });
  }

  private async readArchivedAttempts(): Promise<{
    attempts: Map<string, SpendingAttempt>;
    malformedLines: number;
    duplicateIds: Set<string>;
  }> {
    const attempts = new Map<string, SpendingAttempt>();
    const duplicateIds = new Set<string>();
    let malformedLines = 0;
    if (!(await pathExists(this.archivePath))) return { attempts, malformedLines, duplicateIds };
    const text = await readFile(this.archivePath, "utf8");
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      const parsedJson = (() => {
        try {
          return JSON.parse(line) as unknown;
        } catch {
          return undefined;
        }
      })();
      const parsed = AttemptSchema.safeParse(parsedJson);
      if (
        !parsed.success ||
        parsed.data.status !== "settled" ||
        parsed.data.settledAt === undefined ||
        parsed.data.costUsd === undefined ||
        parsed.data.costBasis === undefined ||
        parsed.data.success === undefined
      ) {
        malformedLines += 1;
        continue;
      }
      if (attempts.has(parsed.data.id)) duplicateIds.add(parsed.data.id);
      else attempts.set(parsed.data.id, parsed.data);
    }
    return { attempts, malformedLines, duplicateIds };
  }

  private async appendSettledAttempts(attempts: readonly SpendingAttempt[]): Promise<void> {
    if (attempts.length === 0) return;
    const settledAttempts = attempts.map((attempt) => {
      const settled = AttemptSchema.parse(attempt);
      settledAttemptForTransfer(settled);
      return settled;
    });
    const handle = await open(this.archivePath, "a+", 0o600);
    try {
      const stat = await handle.stat();
      let separator = "";
      if (stat.size > 0) {
        const finalByte = Buffer.allocUnsafe(1);
        await handle.read(finalByte, 0, 1, stat.size - 1);
        // Preserve a torn final record for Doctor while ensuring it cannot be
        // concatenated with the new valid JSON line.
        if (finalByte[0] !== 0x0a) separator = "\n";
      }
      const lines = settledAttempts.map((attempt) => JSON.stringify(attempt)).join("\n");
      await handle.writeFile(`${separator}${lines}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    for (const settled of settledAttempts) {
      processPendingJournalSettlements.set(journalKey(this.campaignRoot, settled.id), settled);
    }
  }

  private appendSettledAttempt(attempt: SpendingAttempt): Promise<void> {
    return this.appendSettledAttempts([attempt]);
  }

  private reservationMatchesSettlement(
    reservation: SpendingAttempt,
    settlement: SpendingAttempt,
  ): boolean {
    const fields = [
      "id",
      "operationId",
      "lane",
      "provider",
      "model",
      "schemaName",
      "generationPhase",
      "attemptKind",
      "reservedAt",
      "reservedUsd",
      "outputTokenBudget",
      "retryBackoffMs",
    ] as const;
    return fields.every((field) => reservation[field] === settlement[field]);
  }

  private async reconcileInterruptedAttempts(ledger: SpendingLedger): Promise<{
    changed: boolean;
    journalKeys: string[];
  }> {
    let changed = false;
    const journalKeys: string[] = [];
    const interruptedOperationIds = new Set(
      ledger.operations
        .filter((operation) => operation.sessionId !== this.sessionId)
        .map((operation) => operation.operationId),
    );
    const needsArchive = ledger.attempts.some((attempt) => attempt.sessionId !== this.sessionId);
    const archived = needsArchive ? await this.readArchivedAttempts() : undefined;
    for (const attempt of [...ledger.attempts]) {
      const key = journalKey(this.campaignRoot, attempt.id);
      let settled = processPendingJournalSettlements.get(key);
      if (!settled && attempt.sessionId !== this.sessionId) {
        if (archived?.duplicateIds.has(attempt.id)) {
          throw new Error(`Physical attempt archive has duplicate settlement ${attempt.id}`);
        }
        settled = archived?.attempts.get(attempt.id);
      }
      if (!settled && attempt.sessionId === this.sessionId) continue;
      if (settled && !this.reservationMatchesSettlement(attempt, settled)) {
        throw new Error(`Archived settlement ${attempt.id} conflicts with its reservation`);
      }
      if (!settled) {
        settled = AttemptSchema.parse({
          ...attempt,
          status: "settled",
          settledAt: this.now().toISOString(),
          costUsd: attempt.reservedUsd,
          costBasis: attempt.reservedUsd > 0 ? "reserved" : "unpriced",
          success: false,
        });
        await this.appendSettledAttempt(settled);
      }
      this.recordSettledAttempt(ledger, settled);
      ledger.attempts = ledger.attempts.filter((candidate) => candidate.id !== attempt.id);
      journalKeys.push(key);
      changed = true;
    }
    for (const operationId of interruptedOperationIds) {
      const operation = ledger.operations.find(
        (candidate) => candidate.operationId === operationId,
      );
      if (operation) {
        this.recordRecentOperation(
          ledger,
          operation.operationId,
          operation.lane,
          operation.costUsd,
        );
      }
      ledger.operations = ledger.operations.filter(
        (candidate) => candidate.operationId !== operationId,
      );
      changed = true;
    }
    if (changed) this.refreshPause(ledger);
    return { changed, journalKeys };
  }

  private recordSettledAttempt(ledger: SpendingLedger, attempt: SpendingAttempt): void {
    const costUsd = attempt.costUsd ?? 0;
    ledger.settled.costUsd = roundUsd(ledger.settled.costUsd + costUsd);
    ledger.settled.attempts += 1;
    const basis = attempt.costBasis ?? "unpriced";
    if (basis === "exact") ledger.settled.exactAttempts += 1;
    else if (basis === "estimated") ledger.settled.estimatedAttempts += 1;
    else if (basis === "reserved") ledger.settled.reservedAttempts += 1;
    else ledger.settled.unpricedAttempts += 1;
    const operation = ledger.operations.find(
      (candidate) => candidate.operationId === attempt.operationId,
    );
    if (operation) {
      operation.costUsd = roundUsd(operation.costUsd + costUsd);
    } else {
      this.recordRecentOperation(
        ledger,
        attempt.operationId,
        attempt.lane,
        costUsd,
        attempt.settledAt,
      );
    }
  }

  private recordRecentOperation(
    ledger: SpendingLedger,
    operationId: string,
    lane: string,
    costUsd: number,
    settledAt = this.now().toISOString(),
  ): void {
    const existing = ledger.recentOperations.find(
      (operation) => operation.operationId === operationId,
    );
    if (existing) {
      existing.costUsd = roundUsd(existing.costUsd + costUsd);
      existing.settledAt = settledAt;
    } else {
      ledger.recentOperations.push({ operationId, lane, costUsd: roundUsd(costUsd), settledAt });
    }
    ledger.recentOperations.sort((left, right) => left.settledAt.localeCompare(right.settledAt));
    ledger.recentOperations = ledger.recentOperations.slice(-16);
  }

  private refreshPause(ledger: SpendingLedger): void {
    const limit = ledger.limits.campaignUsd;
    if (limit !== undefined && totalSettled(ledger) + totalReserved(ledger) >= limit) {
      ledger.pause = { reason: "campaign_limit", at: this.now().toISOString() };
      return;
    }
    if (ledger.pause?.reason === "campaign_limit") delete ledger.pause;
    if (
      ledger.pause?.reason === "pricing_unavailable" &&
      ledger.limits.campaignUsd === undefined &&
      ledger.limits.logicalTurnUsd === undefined
    ) {
      delete ledger.pause;
    }
  }

  private toSnapshot(ledger: SpendingLedger): CampaignBudgetSnapshot {
    const spentUsd = totalSettled(ledger);
    const reservedUsd = totalReserved(ledger);
    const exposure = roundUsd(spentUsd + reservedUsd);
    const remainingUsd =
      ledger.limits.campaignUsd === undefined
        ? null
        : roundUsd(Math.max(ledger.limits.campaignUsd - exposure, 0));
    const projectedNextTurnUsd = projection(ledger);
    const campaignPaused =
      ledger.limits.campaignUsd !== undefined && exposure >= ledger.limits.campaignUsd;
    return {
      limits: {
        campaignUsd: ledger.limits.campaignUsd ?? null,
        logicalTurnUsd: ledger.limits.logicalTurnUsd ?? null,
      },
      spentUsd,
      reservedUsd,
      remainingUsd,
      basis: snapshotBasis(ledger),
      projectedNextTurnUsd,
      projected100TurnsUsd:
        projectedNextTurnUsd === null ? null : roundUsd(projectedNextTurnUsd * 100),
      warningThreshold: warningThreshold(exposure, ledger.limits.campaignUsd),
      paused: campaignPaused || ledger.pause !== undefined,
      pauseReason: campaignPaused ? "campaign_limit" : (ledger.pause?.reason ?? null),
      settledAttempts: ledger.settled.attempts,
      unsettledAttempts: ledger.attempts.length,
    };
  }

  private async withLedger<T>(
    operation: (ledger: SpendingLedger, persist: () => Promise<void>) => Promise<T> | T,
    createIfMissing = true,
  ): Promise<T> {
    const ledgerExists = await pathExists(this.ledgerPath);
    // Do not invoke a campaign-locking historical reader while holding the
    // spending lock; gameplay intentionally acquires those locks in the other order.
    const historical = ledgerExists ? undefined : await this.options.historicalCost?.();
    return withSerializedFileLock(this.lockPath, "Campaign spending", async () => {
      const ledger = (await pathExists(this.ledgerPath))
        ? LedgerSchema.parse(JSON.parse(await readFile(this.ledgerPath, "utf8")))
        : this.newLedger(historical);
      let persisted = false;
      const persist = async (): Promise<void> => {
        await atomicWriteJson(this.ledgerPath, LedgerSchema.parse(ledger));
        persisted = true;
      };
      const reconciled = await this.reconcileInterruptedAttempts(ledger);
      if (reconciled.changed) {
        await persist();
        for (const key of reconciled.journalKeys) processPendingJournalSettlements.delete(key);
      }
      const result = await operation(ledger, persist);
      if (createIfMissing && !(await pathExists(this.ledgerPath)) && !persisted) await persist();
      return result;
    });
  }
}

export interface BudgetedProviderOptions {
  /** Explicit price for custom or nonstandard routes; built-ins are inferred otherwise. */
  price?: TokenPrice;
}

function settlementForUsage(
  usage: Usage | undefined,
  price: TokenPrice | undefined,
  reservedUsd: number,
  attemptMetadata?: ProviderAttemptMetadata,
): CostSettlement {
  if (usage?.billedCostUsd !== undefined) {
    return {
      costUsd: roundUsd(usage.billedCostUsd),
      basis: "exact",
      ...(attemptMetadata ? { attemptMetadata } : {}),
    };
  }
  if (price && (usage?.inputTokens !== undefined || usage?.outputTokens !== undefined)) {
    return {
      costUsd: estimateTokenCost(usage, price),
      basis: "estimated",
      ...(attemptMetadata ? { attemptMetadata } : {}),
    };
  }
  if (price) {
    return {
      costUsd: reservedUsd,
      basis: "reserved",
      ...(attemptMetadata ? { attemptMetadata } : {}),
    };
  }
  return {
    costUsd: 0,
    basis: "unpriced",
    ...(attemptMetadata ? { attemptMetadata } : {}),
  };
}

/** Wraps the physical provider boundary so repairs and retries cannot evade caps. */
export class BudgetedProvider implements LlmProvider {
  readonly id: string;
  readonly model: string;
  private readonly price: TokenPrice | undefined;

  constructor(
    private readonly base: LlmProvider,
    private readonly spending: CampaignSpendingController,
    options: BudgetedProviderOptions = {},
  ) {
    this.id = base.id;
    this.model = base.model;
    this.price = options.price ?? inferTokenPrice(base.id, base.model);
  }

  effectiveOutputTokenBudget(request: StructuredOutputBudgetRequest): number {
    return resolveEffectiveOutputTokenBudget(this.base, request);
  }

  async generateStructured<T>(request: StructuredRequest<T>): Promise<StructuredResult<T>> {
    const inputTokens =
      conservativeInputTokenEstimate(`${request.system}\n\n${request.prompt}`) +
      APPLICATION_SCHEMA_FRAMING_TOKEN_RESERVE;
    const outputTokens = this.effectiveOutputTokenBudget(request);
    const reservedUsd = this.price
      ? estimateTokenCost({ inputTokens, outputTokens }, this.price)
      : 0;
    const reservation = await this.spending.reserve({
      provider: this.id,
      model: this.model,
      schemaName: request.schemaName,
      ...(request.generationPhase === undefined
        ? {}
        : { generationPhase: request.generationPhase }),
      ...(request.attemptKind === undefined ? {} : { attemptKind: request.attemptKind }),
      outputTokenBudget: outputTokens,
      retryBackoffMs: request.retryBackoffMs ?? 0,
      reservedUsd,
      priced: this.price !== undefined,
    });
    let result: StructuredResult<T>;
    try {
      result = await this.base.generateStructured(request);
    } catch (error) {
      const details = structuredFailureDetails(error);
      await this.spending.settle(
        reservation.id,
        settlementForUsage(
          details?.usage,
          this.price,
          reservation.reservedUsd,
          details?.attemptMetadata ?? attemptMetadataFor(error),
        ),
        false,
      );
      throw error;
    }
    await this.spending.settle(
      reservation.id,
      settlementForUsage(result.usage, this.price, reservation.reservedUsd, result.attemptMetadata),
      true,
    );
    return result;
  }
}
