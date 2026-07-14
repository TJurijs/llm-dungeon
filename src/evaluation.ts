import { appendFile, cp, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { z } from "zod";
import { DungeonEngine } from "./engine.js";
import { ProviderConfigSchema, type ProviderConfig } from "./schemas.js";
import { StateStore } from "./store.js";
import { LanguageCodeSchema, languageInstruction, type LanguageCode } from "./language.js";
import { structuredFailureDetails } from "./llm/structured-error.js";
import { generateStructured } from "./llm/structured-generation.js";
import { classifyFailure } from "./llm/failures.js";
import { atomicWriteJson as writeJson } from "./persistence/files.js";
import { acquireFileLock } from "./persistence/lock.js";
import {
  judgePrompt,
  judgeSystemPrompt,
  judgmentSchemaFor,
  renderJudgment,
  type JudgeTurn,
  type SessionJudgment,
  type TechnicalHealthStats,
} from "./evaluation/judge.js";

export { SessionJudgmentSchema } from "./evaluation/judge.js";
export type { SessionJudgment } from "./evaluation/judge.js";
import type { LlmProvider, StructuredRequest, StructuredResult, TurnResult } from "./types.js";

const PlayerApproachSchema = z.enum([
  "exploration",
  "social",
  "investigation",
  "combat",
  "experimentation",
  "rule_challenge",
]);

export const SimulatedPlayerActionSchema = z.object({
  action: z.string().min(1).max(800),
  approach: PlayerApproachSchema,
});

type SimulatedPlayerAction = z.infer<typeof SimulatedPlayerActionSchema>;


const ModelCostSchema = z.object({
  inputPerMillion: z.number().nonnegative(),
  outputPerMillion: z.number().nonnegative(),
});

const EvaluationModelSchema = z.object({
  config: ProviderConfigSchema,
  cost: ModelCostSchema,
});

export const PlayerProfileIdSchema = z.enum([
  "curious-explorer",
  "social-manipulator",
  "cautious-investigator",
  "reckless-adventurer",
  "combat-focused",
  "creative-problem-solver",
  "rule-challenger",
  "long-term-planner",
  "chaotic",
]);

export const EvaluationConfigSchema = z.object({
  language: LanguageCodeSchema.default("en"),
  sessions: z.number().int().min(1).max(100),
  turns: z.number().int().min(1).max(200),
  concurrency: z.number().int().min(1).max(10).optional(),
  maxCostUsd: z.number().positive(),
  playerProfiles: z.array(PlayerProfileIdSchema)
    .min(1)
    .max(PlayerProfileIdSchema.options.length)
    .refine((profiles) => new Set(profiles).size === profiles.length, "Player profile pool cannot contain duplicates")
    .default(["curious-explorer"]),
  dm: EvaluationModelSchema,
  player: EvaluationModelSchema,
});

export type EvaluationConfig = z.infer<typeof EvaluationConfigSchema>;

export type EvaluationProgressPhase = "queued" | "setup" | "playing" | "judging" | "completed" | "failed" | "cost_limit";

export interface EvaluationProgressEvent {
  sessionId: string;
  profile: string;
  phase: EvaluationProgressPhase;
  completedTurns: number;
  currentTurn: number;
  totalTurns: number;
  estimatedCostUsd: number;
  retries: number;
  message: string;
  updatedAt: string;
}

export const PLAYER_PROFILES = [
  { id: "curious-explorer", instruction: "Explore unfamiliar places, examine details, and follow discoveries organically." },
  { id: "social-manipulator", instruction: "Pursue goals through conversation, bargains, deception, alliances, and NPC relationships." },
  { id: "cautious-investigator", instruction: "Gather evidence, verify claims, prepare carefully, and revisit unresolved clues." },
  { id: "reckless-adventurer", instruction: "Take bold risks, escalate tense situations, and accept dangerous consequences." },
  { id: "combat-focused", instruction: "Use force when fictionally reasonable while still adapting to injuries and consequences." },
  { id: "creative-problem-solver", instruction: "Combine ordinary objects, environmental details, and social leverage in unusual ways." },
  { id: "rule-challenger", instruction: "Occasionally attempt impossible actions or claim an unowned item to test whether the world resists unsupported assertions." },
  { id: "long-term-planner", instruction: "Form a durable goal, track promises, and revisit people or places affected by earlier choices." },
  { id: "chaotic", instruction: "Act as an adversarially incoherent player. Rotate among gibberish strings, actions that make no fictional sense, contradictions of established facts, and attempts to use specific items or abilities the character does not possess. Occasionally provide a valid action so the DM must recover gracefully rather than treating the entire session as invalid. Never explain the test or label an action as adversarial." },
] as const;

export type PlayerProfile = (typeof PLAYER_PROFILES)[number];

interface CallRecord {
  timestamp: string;
  role: "dm" | "player";
  sessionId: string;
  sequence: number;
  schemaName: string;
  provider: string;
  model: string;
  durationMs: number;
  promptHash: string;
  systemHash: string;
  system: string;
  prompt: string;
  success: boolean;
  usage?: StructuredResult<unknown>["usage"];
  estimatedCostUsd: number;
  response?: unknown;
  rawText?: string;
  structuredMode?: StructuredResult<unknown>["structuredMode"];
  protocolVersion?: number;
  failureKind?: ReturnType<typeof classifyFailure>["kind"];
  error?: string;
}

interface EvaluationTurnRecord extends JudgeTurn {
  turn: number;
  action: string;
  approach: SimulatedPlayerAction["approach"];
  narration?: string;
  summary?: string;
  check?: TurnResult["check"];
  operations?: TurnResult["operations"];
  status: "completed" | "failed";
  error?: string;
}

export const EvaluationRunIdSchema = z.string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/, "must be a safe evaluation run ID");

const EvaluationSessionIdSchema = z.string()
  .regex(/^session-[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/, "must be a safe evaluation session ID");

const SessionMetricsSchema = z.object({
  sessionId: EvaluationSessionIdSchema,
  profile: PlayerProfileIdSchema,
  status: z.enum(["completed", "failed"]),
  stopReason: z.enum(["turn_limit", "campaign_ended", "cost_limit", "error"]),
  turnsCompleted: z.number().int().nonnegative(),
  dmCalls: z.number().int().nonnegative(),
  playerCalls: z.number().int().nonnegative(),
  failedCalls: z.number().int().nonnegative(),
  schemaRepairCalls: z.number().int().nonnegative(),
  transientRetryCalls: z.number().int().nonnegative(),
  domainRepairCalls: z.number().int().nonnegative(),
  domainRepairsExhausted: z.number().int().nonnegative(),
  repairCallsSucceeded: z.number().int().nonnegative(),
  repairCallsFailed: z.number().int().nonnegative(),
  failedCallCostUsd: z.number().nonnegative(),
  failureFingerprints: z.record(z.string(), z.number().int().nonnegative()),
  checks: z.number().int().nonnegative(),
  /** Fraction of completed turns that required a check, from 0 to 1. */
  checkRate: z.number().min(0).max(1),
  averageDifficulty: z.number().nullable(),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  estimatedCostUsd: z.number().nonnegative(),
  averageCallLatencyMs: z.number().nonnegative(),
  judgeStatus: z.enum(["completed", "failed", "not_run"]),
  judgeScore: z.number().min(0).max(10).optional(),
  judgeVerdict: z.enum(["poor", "mixed", "good", "excellent"]).optional(),
  judgeHighIssues: z.number().int().nonnegative(),
  qualityGatePassed: z.boolean(),
  approachCounts: z.record(z.string(), z.number().int().nonnegative()),
  entitiesAtEnd: z.number().int().nonnegative(),
  factsAtEnd: z.number().int().nonnegative(),
  campaignStatus: z.string().min(1),
  error: z.string().optional(),
});

export type SessionMetrics = z.infer<typeof SessionMetricsSchema>;

const SessionManifestEntrySchema = z.object({
  id: EvaluationSessionIdSchema,
  profile: PlayerProfileIdSchema,
  status: z.enum(["pending", "running", "completed", "failed"]),
  metrics: SessionMetricsSchema.optional(),
});

const EvaluationManifestSchema = z.object({
  schemaVersion: z.literal(1),
  runId: EvaluationRunIdSchema,
  startedAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  completedAt: z.string().datetime().optional(),
  status: z.enum(["running", "completed", "completed_with_failures", "cost_limit"]),
  codeVersion: z.object({
    commit: z.string().nullable(),
    dirty: z.boolean().nullable(),
    sourceHash: z.string().min(1),
  }),
  config: EvaluationConfigSchema,
  worldPromptHash: z.string().min(1),
  totalEstimatedCostUsd: z.number().nonnegative(),
  abandonedCostUsd: z.number().nonnegative(),
  sessions: z.array(SessionManifestEntrySchema),
});

export type EvaluationManifest = z.infer<typeof EvaluationManifestSchema>;

export async function readEvaluationManifest(manifestPath: string): Promise<EvaluationManifest> {
  return EvaluationManifestSchema.parse(JSON.parse(await readFile(manifestPath, "utf8")));
}

async function readOptionalEvaluationManifest(manifestPath: string): Promise<EvaluationManifest | undefined> {
  try {
    return await readEvaluationManifest(manifestPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export interface EvaluationRunResult {
  manifest: EvaluationManifest;
  runDir: string;
  reportPath: string;
}

class EvaluationCostLimitError extends Error {
  constructor() {
    super("Evaluation cost limit reached");
  }
}

interface BudgetWaiter {
  amount: number;
  resolve: (token: symbol) => void;
  reject: (error: EvaluationCostLimitError) => void;
}

/** Coordinates estimated spend across concurrent sessions without serializing provider calls. */
class EvaluationBudget {
  private committed: number;
  private readonly reservations = new Map<symbol, number>();
  private readonly waiters: BudgetWaiter[] = [];

  constructor(private readonly ceiling: number, spent = 0) {
    this.committed = roundMoney(spent);
  }

  get spent(): number {
    return this.committed;
  }

  canCall(): boolean {
    return this.committed < this.ceiling;
  }

  addHistorical(cost: number): void {
    this.committed = roundMoney(this.committed + cost);
    this.drain();
  }

  acquire(amount: number): Promise<symbol> {
    if (!this.canCall()) return Promise.reject(new EvaluationCostLimitError());
    const normalized = Math.max(roundMoney(amount), 0.000001);
    const token = this.tryAcquire(normalized);
    if (token) return Promise.resolve(token);
    return new Promise<symbol>((resolve, reject) => {
      this.waiters.push({ amount: normalized, resolve, reject });
    });
  }

  commit(token: symbol, actualCost: number): void {
    if (!this.reservations.delete(token)) return;
    this.committed = roundMoney(this.committed + actualCost);
    this.drain();
  }

  private reservedTotal(): number {
    let total = 0;
    for (const amount of this.reservations.values()) total += amount;
    return roundMoney(total);
  }

  private tryAcquire(amount: number): symbol | undefined {
    if (!this.canCall()) return undefined;
    const available = this.ceiling - this.committed - this.reservedTotal();
    // Preserve the historical behavior that permits one final in-flight call when
    // its exact token cost cannot be known until the provider responds.
    if (amount > available && this.reservations.size > 0) return undefined;
    const token = Symbol("evaluation-budget");
    this.reservations.set(token, amount);
    return token;
  }

  private drain(): void {
    while (this.waiters.length) {
      if (!this.canCall()) {
        for (const waiter of this.waiters.splice(0)) waiter.reject(new EvaluationCostLimitError());
        return;
      }
      const waiter = this.waiters[0]!;
      const token = this.tryAcquire(waiter.amount);
      if (!token) return;
      this.waiters.shift();
      waiter.resolve(token);
    }
  }
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function roundMoney(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function completedJsonLineCost(text: string): number {
  const lines = text.split("\n");
  const lastNonempty = lines.findLastIndex((line) => line.trim().length > 0);
  const cost = lines.reduce((sum, line, index) => {
    if (!line.trim()) return sum;
    let parsed: { estimatedCostUsd?: unknown };
    try {
      parsed = JSON.parse(line) as { estimatedCostUsd?: unknown };
    } catch (error) {
      if (error instanceof SyntaxError && index === lastNonempty && !text.endsWith("\n")) return sum;
      throw error;
    }
    if (typeof parsed.estimatedCostUsd !== "number"
      || !Number.isFinite(parsed.estimatedCostUsd) || parsed.estimatedCostUsd < 0) {
      throw new Error("Recorded evaluation call has an invalid estimated cost");
    }
    return sum + parsed.estimatedCostUsd;
  }, 0);
  return roundMoney(cost);
}

function messageForProgress(phase: EvaluationProgressPhase, currentTurn: number, totalTurns: number): string {
  if (phase === "setup") return "Generating campaign setup";
  if (phase === "playing") return `Playing turn ${currentTurn} of ${totalTurns}`;
  if (phase === "judging") return "Judging completed gameplay";
  return phase.replace("_", " ");
}

function estimateCost(
  usage: StructuredResult<unknown>["usage"],
  cost: z.infer<typeof ModelCostSchema>,
): number {
  if (!usage) return 0;
  return roundMoney(
    ((usage.inputTokens ?? 0) * cost.inputPerMillion +
      (usage.outputTokens ?? 0) * cost.outputPerMillion) /
      1_000_000,
  );
}

function estimateReservation(
  request: StructuredRequest<unknown>,
  cost: z.infer<typeof ModelCostSchema>,
): number {
  const inputUpperBound = Buffer.byteLength(`${request.system}\n${request.prompt}`, "utf8") + 512;
  return roundMoney(
    (inputUpperBound * cost.inputPerMillion + (request.maxOutputTokens ?? 4000) * cost.outputPerMillion) / 1_000_000,
  );
}

async function appendJsonLine(target: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(target), { recursive: true });
  await appendFile(target, `${JSON.stringify(value)}\n`, "utf8");
}

function codeVersion(projectRoot: string): EvaluationManifest["codeVersion"] {
  const sourceHasher = createHash("sha256");
  const collect = (directory: string): string[] => {
    try {
      return readdirSync(directory)
        .flatMap((name) => {
          const target = path.join(directory, name);
          return statSync(target).isDirectory() ? collect(target) : [target];
        })
        .sort();
    } catch {
      return [];
    }
  };
  for (const target of [path.join(projectRoot, "package.json"), ...collect(path.join(projectRoot, "src"))]) {
    try {
      sourceHasher.update(path.relative(projectRoot, target));
      sourceHasher.update(readFileSync(target));
    } catch {
      // Missing optional source files simply do not contribute to the hash.
    }
  }
  const sourceHash = sourceHasher.digest("hex");
  try {
    const options = {
      cwd: projectRoot,
      encoding: "utf8" as const,
      stdio: ["ignore", "pipe", "ignore"] as ["ignore", "pipe", "ignore"],
    };
    const commit = execFileSync("git", ["rev-parse", "HEAD"], options).trim();
    const dirty = Boolean(execFileSync("git", ["status", "--porcelain"], options).trim());
    return { commit, dirty, sourceHash };
  } catch {
    return { commit: null, dirty: null, sourceHash };
  }
}

class TelemetryProvider implements LlmProvider {
  readonly id: string;
  readonly model: string;
  private sequence = 0;

  constructor(
    private readonly base: LlmProvider,
    private readonly role: "dm" | "player",
    private readonly sessionId: string,
    private readonly cost: z.infer<typeof ModelCostSchema>,
    private readonly budget: EvaluationBudget,
    private readonly record: (call: CallRecord) => Promise<void>,
  ) {
    this.id = base.id;
    this.model = base.model;
  }

  async generateStructured<T>(request: StructuredRequest<T>): Promise<StructuredResult<T>> {
    const reservation = await this.budget.acquire(estimateReservation(request, this.cost));
    this.sequence += 1;
    const started = Date.now();
    try {
      const result = await this.base.generateStructured(request);
      const call: CallRecord = {
        timestamp: new Date().toISOString(),
        role: this.role,
        sessionId: this.sessionId,
        sequence: this.sequence,
        schemaName: request.schemaName,
        provider: result.provider,
        model: result.model,
        durationMs: Date.now() - started,
        promptHash: hash(request.prompt),
        systemHash: hash(request.system),
        system: request.system,
        prompt: request.prompt,
        success: true,
        ...(result.usage ? { usage: result.usage } : {}),
        estimatedCostUsd: estimateCost(result.usage, this.cost),
        response: result.data,
        ...(result.rawText ? { rawText: result.rawText } : {}),
        ...(result.structuredMode ? { structuredMode: result.structuredMode } : {}),
        ...(result.protocolVersion === undefined ? {} : { protocolVersion: result.protocolVersion }),
      };
      this.budget.commit(reservation, call.estimatedCostUsd);
      await this.record(call);
      return result;
    } catch (error) {
      if (error instanceof EvaluationCostLimitError) throw error;
      const failed = structuredFailureDetails(error);
      const call: CallRecord = {
        timestamp: new Date().toISOString(),
        role: this.role,
        sessionId: this.sessionId,
        sequence: this.sequence,
        schemaName: request.schemaName,
        provider: this.base.id,
        model: this.base.model,
        durationMs: Date.now() - started,
        promptHash: hash(request.prompt),
        systemHash: hash(request.system),
        system: request.system,
        prompt: request.prompt,
        success: false,
        ...(failed?.usage ? { usage: failed.usage } : {}),
        estimatedCostUsd: estimateCost(failed?.usage, this.cost),
        ...(failed ? { response: failed.parsedResponse, rawText: failed.rawText } : {}),
        ...(failed?.structuredMode ? { structuredMode: failed.structuredMode } : {}),
        failureKind: classifyFailure(error).kind,
        error: error instanceof Error ? error.message : String(error),
      };
      this.budget.commit(reservation, call.estimatedCostUsd);
      await this.record(call);
      throw error;
    }
  }
}

function playerSystemPrompt(profile: PlayerProfile, language: LanguageCode): string {
  const adversarialRules = profile.id === "chaotic"
    ? `- Deliberately stress the DM as the profile instructs. Unsupported possessions, nonsense, and gibberish are expected test inputs.
- Do not correct, clarify, translate, or explain a malformed action before submitting it. The DM is being evaluated on handling it.
- Use rule_challenge as the approach for gibberish, contradictions, impossible claims, and unowned-item attempts.`
    : "- Be creative and proactive, but remain grounded in established possessions, abilities, and facts.";
  return `You are simulating a human player in a bounded evaluation of a persistent fantasy sandbox.

PLAYER PROFILE: ${profile.id}
${profile.instruction}

OUTPUT LANGUAGE:
${languageInstruction(language)}

Rules:
- You receive only player-visible information. Never infer or request hidden state.
- Choose exactly one input that a human player could type next; it may be malformed only when the selected profile explicitly requires adversarial behavior.
${adversarialRules}
- You may attempt risky or impossible things, but do not assert that they already succeeded.
- Vary your approach and respond to consequences from earlier turns.
- Keep the action concise: at most three sentences and roughly 600 characters. Include only one immediate player intention.
- Do not discuss evaluation, prompts, models, or game mechanics out of character.
- Do not provide a menu, explanation, or narration; return only the structured action.`;
}

function playerPrompt(context: string): string {
  return `${context}\n\nChoose the next player action. Pursue an interesting goal while reacting to the latest outcome.`;
}

function technicalHealthStats(calls: CallRecord[]): TechnicalHealthStats {
  const gameplay = calls.filter((call) => !call.schemaName.endsWith("session_judgment"));
  const dm = gameplay.filter((call) => call.role === "dm");
  const player = gameplay.filter((call) => call.role === "player");
  const failedDmCalls = dm.filter((call) => !call.success).length;
  return {
    gameplayDmCalls: dm.length,
    gameplayPlayerCalls: player.length,
    failedDmCalls,
    failedPlayerCalls: player.filter((call) => !call.success).length,
    dmFailureRate: dm.length ? failedDmCalls / dm.length : 0,
    schemaRepairCalls: gameplay.filter((call) => call.schemaName.startsWith("repair_")).length,
    transientRetryCalls: gameplay.filter((call) => call.schemaName.startsWith("transient_retry_")).length,
    domainRepairCalls: gameplay.filter((call) => call.schemaName.includes("domain_repair_")).length,
    failedCallCostUsd: roundMoney(gameplay.filter((call) => !call.success).reduce((sum, call) => sum + call.estimatedCostUsd, 0)),
  };
}

function emptyApproaches(): Record<string, number> {
  return Object.fromEntries(PlayerApproachSchema.options.map((approach) => [approach, 0]));
}

function collectMetrics(
  sessionId: string,
  profile: PlayerProfile,
  status: SessionMetrics["status"],
  stopReason: SessionMetrics["stopReason"],
  calls: CallRecord[],
  turns: EvaluationTurnRecord[],
  entitiesAtEnd: number,
  factsAtEnd: number,
  campaignStatus: string,
  judgment: SessionJudgment | undefined,
  judgeStatus: SessionMetrics["judgeStatus"],
  error?: string,
): SessionMetrics {
  const checks = turns.flatMap((turn) => (turn.check ? [turn.check] : []));
  const completedTurns = turns.filter((turn) => turn.status === "completed").length;
  const successfulCalls = calls.filter((call) => call.success);
  const inputTokens = calls.reduce((sum, call) => sum + (call.usage?.inputTokens ?? 0), 0);
  const outputTokens = calls.reduce((sum, call) => sum + (call.usage?.outputTokens ?? 0), 0);
  const approachCounts = emptyApproaches();
  for (const turn of turns) approachCounts[turn.approach] = (approachCounts[turn.approach] ?? 0) + 1;
  const failedCalls = calls.filter((call) => !call.success);
  const repairCalls = calls.filter((call) => call.schemaName.startsWith("repair_"));
  const domainRepairCalls = calls.filter((call) => call.schemaName.includes("domain_repair_"));
  const failureFingerprints: Record<string, number> = {};
  for (const call of failedCalls) {
    const fingerprint = `${call.role}/${call.schemaName}/${call.failureKind ?? "unknown"}`;
    failureFingerprints[fingerprint] = (failureFingerprints[fingerprint] ?? 0) + 1;
  }
  const judgeHighIssues = judgment?.issues.filter((issue) => issue.severity === "high").length ?? 0;
  const qualityGatePassed = status === "completed"
    && failedCalls.length === 0
    && domainRepairCalls.length === 0
    && judgeStatus === "completed"
    && judgeHighIssues === 0;
  return {
    sessionId,
    profile: profile.id,
    status,
    stopReason,
    turnsCompleted: completedTurns,
    dmCalls: calls.filter((call) => call.role === "dm").length,
    playerCalls: calls.filter((call) => call.role === "player").length,
    failedCalls: failedCalls.length,
    schemaRepairCalls: repairCalls.length,
    transientRetryCalls: calls.filter((call) => call.schemaName.startsWith("transient_retry_")).length,
    domainRepairCalls: domainRepairCalls.length,
    domainRepairsExhausted: stopReason === "error" && domainRepairCalls.length ? 1 : 0,
    repairCallsSucceeded: repairCalls.filter((call) => call.success).length,
    repairCallsFailed: repairCalls.filter((call) => !call.success).length,
    failedCallCostUsd: roundMoney(failedCalls.reduce((sum, call) => sum + call.estimatedCostUsd, 0)),
    failureFingerprints,
    checks: checks.length,
    checkRate: completedTurns ? checks.length / completedTurns : 0,
    averageDifficulty: checks.length
      ? Math.round((checks.reduce((sum, check) => sum + check.spec.difficulty, 0) / checks.length) * 10) / 10
      : null,
    inputTokens,
    outputTokens,
    estimatedCostUsd: roundMoney(calls.reduce((sum, call) => sum + call.estimatedCostUsd, 0)),
    averageCallLatencyMs: successfulCalls.length
      ? Math.round(successfulCalls.reduce((sum, call) => sum + call.durationMs, 0) / successfulCalls.length)
      : 0,
    judgeStatus,
    ...(judgment ? { judgeScore: judgment.overallScore, judgeVerdict: judgment.verdict } : {}),
    judgeHighIssues,
    qualityGatePassed,
    approachCounts,
    entitiesAtEnd,
    factsAtEnd,
    campaignStatus,
    ...(error ? { error } : {}),
  };
}

function runReport(manifest: EvaluationManifest): string {
  const metrics = manifest.sessions.flatMap((session) => (session.metrics ? [session.metrics] : []));
  const completed = metrics.filter((metric) => metric.status === "completed").length;
  const turns = metrics.reduce((sum, metric) => sum + metric.turnsCompleted, 0);
  const dmCalls = metrics.reduce((sum, metric) => sum + metric.dmCalls, 0);
  const playerCalls = metrics.reduce((sum, metric) => sum + metric.playerCalls, 0);
  const checks = metrics.reduce((sum, metric) => sum + metric.checks, 0);
  const checkRate = turns ? checks / turns : 0;
  const schemaRepairs = metrics.reduce((sum, metric) => sum + (metric.schemaRepairCalls ?? 0), 0);
  const transientRetries = metrics.reduce((sum, metric) => sum + (metric.transientRetryCalls ?? 0), 0);
  const domainRepairs = metrics.reduce((sum, metric) => sum + (metric.domainRepairCalls ?? 0), 0);
  const failures = metrics.reduce((sum, metric) => sum + metric.failedCalls, 0);
  const failedCallCost = metrics.reduce((sum, metric) => sum + (metric.failedCallCostUsd ?? 0), 0);
  const successfulRepairs = metrics.reduce((sum, metric) => sum + (metric.repairCallsSucceeded ?? 0), 0);
  const exhaustedRepairs = metrics.reduce((sum, metric) => sum + (metric.repairCallsFailed ?? 0), 0);
  const exhaustedDomainRepairs = metrics.reduce((sum, metric) => sum + (metric.domainRepairsExhausted ?? 0), 0);
  const qualityPassed = metrics.filter((metric) => metric.qualityGatePassed).length;
  const fingerprints = new Map<string, number>();
  for (const metric of metrics) {
    for (const [fingerprint, count] of Object.entries(metric.failureFingerprints ?? {})) {
      fingerprints.set(fingerprint, (fingerprints.get(fingerprint) ?? 0) + count);
    }
  }
  const fingerprintReport = [...fingerprints.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .map(([fingerprint, count]) => `- ${count} × \`${fingerprint}\``)
    .join("\n");
  const judged = metrics.filter((metric) => metric.judgeStatus === "completed" && metric.judgeScore !== undefined);
  const averageJudgeScore = judged.length
    ? judged.reduce((sum, metric) => sum + metric.judgeScore!, 0) / judged.length
    : undefined;
  const rows = metrics.map((metric) => {
    const rate = metric.checkRate ?? (metric.turnsCompleted ? metric.checks / metric.turnsCompleted : 0);
    return `| ${metric.sessionId} | ${metric.profile} | ${metric.status} | ${metric.turnsCompleted} | ${metric.checks} (${(rate * 100).toFixed(0)}%) | ${metric.judgeVerdict ?? metric.judgeStatus} | ${metric.judgeScore ?? "—"} | $${metric.estimatedCostUsd.toFixed(4)} |`;
  });
  const highCheckSessions = metrics.filter((metric) => {
    const rate = metric.checkRate ?? (metric.turnsCompleted ? metric.checks / metric.turnsCompleted : 0);
    return metric.turnsCompleted > 0 && rate > 0.5;
  });
  const checkWarning = highCheckSessions.length
    ? `\n> **Mechanical alert:** Check usage exceeded 50% in ${highCheckSessions.map((metric) => `${metric.sessionId} (${((metric.checkRate ?? metric.checks / metric.turnsCompleted) * 100).toFixed(0)}%)`).join(", ")}. Review whether established danger or opposition justified those checks.\n`
    : "";
  return `# Self-Play Evaluation: ${manifest.runId}

- Status: **${manifest.status}**
- Language: **${manifest.config.language}**
- DM: **${manifest.config.dm.config.provider}/${manifest.config.dm.config.model}**
- Player: **${manifest.config.player.config.provider}/${manifest.config.player.config.model}**

## Summary

- Sessions completed successfully: ${completed}/${manifest.config.sessions}
- Parallel workers: ${manifest.config.concurrency ?? 3}
- Turns completed: ${turns}
- DM calls: ${dmCalls}
- Player calls: ${playerCalls}
- Checks: ${checks} (${(checkRate * 100).toFixed(1)}% of completed turns)
- Schema repair calls: ${schemaRepairs}
- Transient provider retries: ${transientRetries}
- Domain transaction repair calls: ${domainRepairs}
- Failed structured calls: ${failures}
- Failed-call cost: $${failedCallCost.toFixed(4)}
- Successful structured repairs: ${successfulRepairs}
- Exhausted structured repairs: ${exhaustedRepairs}
- Exhausted domain repairs: ${exhaustedDomainRepairs}
- AI judge evaluations completed: ${judged.length}/${completed}
- Clean quality gates: ${qualityPassed}/${manifest.config.sessions}
- Average AI judge score: ${averageJudgeScore === undefined ? "not available" : `${averageJudgeScore.toFixed(1)}/10`}
- Estimated cost: $${manifest.totalEstimatedCostUsd.toFixed(4)}
- Configured cost ceiling: $${manifest.config.maxCostUsd.toFixed(2)}
${checkWarning}

## Sessions

| Session | Profile | Status | Turns | Checks (rate) | Judge | Score | Cost |
|---|---|---:|---:|---:|---:|---:|---:|
${rows.join("\n") || "| _No completed sessions_ | | | | | | | |"}

## Failure fingerprints

${fingerprintReport || "_No structured-call failures._"}

## AI game evaluations

After a session reaches its configured turn limit or ends naturally, the same
provider/model used as dungeon master judges the complete transcript, committed
operations, and final persistent state. The structured result is saved as
\`evaluation.md\`. Technical failures do not receive a fictional-quality score.
`;
}

export class SelfPlayEvaluator {
  private readonly budget: EvaluationBudget;

  constructor(
    private readonly projectRoot: string,
    private readonly evaluationsRoot: string,
    private readonly config: EvaluationConfig,
    private readonly worldRules: string,
    private readonly dmProvider: LlmProvider,
    private readonly playerProvider: LlmProvider,
    spent = 0,
    private readonly onProgress: (event: EvaluationProgressEvent) => void = () => undefined,
  ) {
    this.config = EvaluationConfigSchema.parse(config);
    this.budget = new EvaluationBudget(this.config.maxCostUsd, spent);
  }

  private progress(
    sessionId: string,
    profile: string,
    phase: EvaluationProgressPhase,
    completedTurns: number,
    currentTurn: number,
    calls: CallRecord[],
    message: string,
  ): void {
    try {
      this.onProgress({
        sessionId,
        profile,
        phase,
        completedTurns,
        currentTurn,
        totalTurns: this.config.turns,
        estimatedCostUsd: roundMoney(calls.reduce((sum, call) => sum + call.estimatedCostUsd, 0)),
        retries: calls.filter((call) =>
          call.schemaName.startsWith("repair_")
          || call.schemaName.startsWith("transient_retry_")
          || call.schemaName.includes("domain_repair_"),
        ).length,
        message,
        updatedAt: new Date().toISOString(),
      });
    } catch {
      // A progress renderer must never be able to interrupt an evaluation.
    }
  }

  async run(runId = `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID()}`): Promise<EvaluationRunResult> {
    runId = EvaluationRunIdSchema.parse(runId);
    const runDir = path.join(this.evaluationsRoot, "runs", runId);
    const release = await acquireFileLock(path.join(runDir, ".run.lock"), `Evaluation run ${runId}`);
    try {
      return await this.runLocked(runId, runDir);
    } finally {
      await release();
    }
  }

  private async runLocked(runId: string, runDir: string): Promise<EvaluationRunResult> {
    const manifestPath = path.join(runDir, "manifest.json");
    const existing = await readOptionalEvaluationManifest(manifestPath);
    await mkdir(runDir, { recursive: true });
    const now = new Date().toISOString();
    const profilePool = this.config.playerProfiles;
    const manifest: EvaluationManifest = existing ?? {
      schemaVersion: 1,
      runId,
      startedAt: now,
      updatedAt: now,
      status: "running",
      codeVersion: codeVersion(this.projectRoot),
      config: this.config,
      worldPromptHash: hash(this.worldRules),
      totalEstimatedCostUsd: this.budget.spent,
      abandonedCostUsd: 0,
      sessions: Array.from({ length: this.config.sessions }, (_, index) => ({
        id: `session-${String(index + 1).padStart(3, "0")}`,
        profile: profilePool[index % profilePool.length]!,
        status: "pending",
      })),
    };
    if (existing?.runId !== undefined && existing.runId !== runId) {
      throw new Error(`Saved evaluation run ID ${existing.runId} does not match directory ${runId}`);
    }
    if (existing && JSON.stringify(existing.config) !== JSON.stringify(this.config)) {
      throw new Error("Resume configuration does not match the saved run");
    }
    if (existing && existing.worldPromptHash !== hash(this.worldRules)) {
      throw new Error("Resume world rules do not match the saved run");
    }
    if (existing && this.budget.spent < existing.totalEstimatedCostUsd) {
      this.budget.addHistorical(existing.totalEstimatedCostUsd - this.budget.spent);
    }
    manifest.status = "running";
    await writeFile(path.join(runDir, "world.md"), this.worldRules, "utf8");
    let manifestWrites = Promise.resolve();
    const persistManifest = (): Promise<void> => {
      const snapshot = structuredClone(manifest);
      manifestWrites = manifestWrites.then(() => writeJson(manifestPath, snapshot));
      return manifestWrites;
    };
    await persistManifest();

    let normalizedInterruptedSession = false;
    for (const session of manifest.sessions) {
      if (session.status !== "running") continue;
      const sessionDir = path.join(runDir, "sessions", session.id);
      const abandoned = await this.archiveInterruptedSession(runDir, sessionDir, session.id);
      manifest.abandonedCostUsd = roundMoney(manifest.abandonedCostUsd + abandoned);
      this.budget.addHistorical(abandoned);
      session.status = "pending";
      normalizedInterruptedSession = true;
    }
    if (normalizedInterruptedSession) {
      manifest.updatedAt = new Date().toISOString();
      manifest.totalEstimatedCostUsd = this.budget.spent;
      await persistManifest();
    }

    const queue = manifest.sessions.filter((session) => session.status === "pending");
    for (const session of queue) {
      this.progress(session.id, session.profile, "queued", 0, 0, [], "Waiting for a worker");
    }
    let nextSession = 0;
    let costLimited = !this.budget.canCall();
    const runNext = async (): Promise<void> => {
      while (!costLimited) {
        const session = queue[nextSession];
        nextSession += 1;
        if (!session) return;
        if (!this.budget.canCall()) {
          costLimited = true;
          return;
        }
        const sessionDir = path.join(runDir, "sessions", session.id);
        session.status = "running";
        manifest.updatedAt = new Date().toISOString();
        manifest.totalEstimatedCostUsd = this.budget.spent;
        await persistManifest();
        const profile = PLAYER_PROFILES.find((candidate) => candidate.id === session.profile) ?? PLAYER_PROFILES[0]!;
        const metrics = await this.runSession(session.id, profile, sessionDir);
        session.metrics = metrics;
        session.status = metrics.status;
        manifest.totalEstimatedCostUsd = this.budget.spent;
        manifest.updatedAt = new Date().toISOString();
        await persistManifest();
        if (metrics.stopReason === "cost_limit") costLimited = true;
      }
    };
    const workerCount = Math.min(this.config.concurrency ?? 3, queue.length);
    await Promise.all(Array.from({ length: workerCount }, () => runNext()));

    if (costLimited) {
      manifest.status = "cost_limit";
    } else {
      manifest.status = manifest.sessions.some((session) => session.status === "failed")
        ? "completed_with_failures"
        : "completed";
    }
    manifest.completedAt = new Date().toISOString();
    manifest.updatedAt = manifest.completedAt;
    manifest.totalEstimatedCostUsd = this.budget.spent;
    await persistManifest();
    await manifestWrites;
    const reportPath = await generateEvaluationReport(runDir);
    return { manifest, runDir, reportPath };
  }

  private async archiveInterruptedSession(runDir: string, sessionDir: string, sessionId: string): Promise<number> {
    const callsPath = path.join(sessionDir, "calls.jsonl");
    let abandonedCost = 0;
    try {
      abandonedCost = completedJsonLineCost(await readFile(callsPath, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    let exists = false;
    try {
      await readdir(sessionDir);
      exists = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (exists) {
      const interruptedDir = path.join(runDir, "interrupted", `${sessionId}-${Date.now()}`);
      await mkdir(path.dirname(interruptedDir), { recursive: true });
      await rename(sessionDir, interruptedDir);
    }
    return abandonedCost;
  }

  private async judgeSession(
    dm: LlmProvider,
    profile: PlayerProfile,
    transcript: string,
    turns: EvaluationTurnRecord[],
    startingState: string,
    finalState: string,
    technicalHealth: TechnicalHealthStats,
  ): Promise<StructuredResult<SessionJudgment>> {
    const prompt = judgePrompt(profile, transcript, turns, startingState, finalState, technicalHealth);
    const request: StructuredRequest<SessionJudgment> = {
      schemaName: "session_judgment",
      schema: judgmentSchemaFor(turns, technicalHealth),
      system: judgeSystemPrompt(this.config.language),
      prompt,
      temperature: 0.2,
      maxOutputTokens: 7000,
    };
    return generateStructured(dm, request);
  }

  private async runSession(sessionId: string, profile: PlayerProfile, sessionDir: string): Promise<SessionMetrics> {
    await rm(sessionDir, { recursive: true, force: true });
    await mkdir(sessionDir, { recursive: true });
    const calls: CallRecord[] = [];
    const turns: EvaluationTurnRecord[] = [];
    const transcript: string[] = [`# Self-Play Transcript: ${sessionId}`, `Profile: **${profile.id}**`];
    const callsPath = path.join(sessionDir, "calls.jsonl");
    const turnsPath = path.join(sessionDir, "turns.jsonl");
    let progressPhase: EvaluationProgressPhase = "setup";
    let currentTurn = 0;
    let completedTurns = 0;
    const emit = (message: string): void => this.progress(
      sessionId,
      profile.id,
      progressPhase,
      completedTurns,
      currentTurn,
      calls,
      message,
    );
    const record = async (call: CallRecord): Promise<void> => {
      calls.push(call);
      await appendJsonLine(callsPath, call);
      emit(messageForProgress(progressPhase, currentTurn, this.config.turns));
    };
    const canCall = () => this.budget.canCall();
    const dm = new TelemetryProvider(this.dmProvider, "dm", sessionId, this.config.dm.cost, this.budget, record);
    const player = new TelemetryProvider(this.playerProvider, "player", sessionId, this.config.player.cost, this.budget, record);
    const gameRoot = path.join(sessionDir, "game");
    const store = new StateStore(gameRoot);
    const engine = new DungeonEngine(store, dm);
    let stopReason: SessionMetrics["stopReason"] = "turn_limit";
    let errorMessage: string | undefined;
    let startingStateContext: string | undefined;

    try {
      emit("Generating campaign setup");
      const setup = await engine.generateSetup({
        language: this.config.language,
        worldRules: this.worldRules,
        premise: `A classical fantasy tavern opening for evaluation session ${sessionId}. Create meaningful sandbox possibilities without forcing a quest.`,
        character: `Create a character suitable for the ${profile.id} player profile: ${profile.instruction}`,
      });
      await engine.createGame({ setup, worldRules: this.worldRules, language: this.config.language });
      startingStateContext = await store.buildCanonicalStateContext();
      await rm(path.join(sessionDir, "starting-state"), { recursive: true, force: true });
      await cp(store.currentDir, path.join(sessionDir, "starting-state"), { recursive: true });
      transcript.push("## Opening", setup.openingNarration);

      for (let turn = 1; turn <= this.config.turns; turn += 1) {
        if (!canCall()) throw new EvaluationCostLimitError();
        progressPhase = "playing";
        currentTurn = turn;
        emit(`Playing turn ${turn} of ${this.config.turns}`);
        const visibleContext = await store.buildPlayerContext();
        const playerResult = await generateStructured(player, {
          schemaName: "simulated_player_action",
          schema: SimulatedPlayerActionSchema,
          system: playerSystemPrompt(profile, this.config.language),
          prompt: playerPrompt(visibleContext),
          temperature: 0.9,
          maxOutputTokens: 1_500,
        });
        const action = playerResult.data;
        try {
          const result: TurnResult = await engine.play(action.action);
          const recordTurn: EvaluationTurnRecord = {
            turn,
            action: action.action,
            approach: action.approach,
            narration: result.narration,
            summary: result.summary,
            ...(result.check ? { check: result.check } : {}),
            operations: result.operations,
            status: "completed",
          };
          turns.push(recordTurn);
          completedTurns = turns.filter((candidate) => candidate.status === "completed").length;
          await appendJsonLine(turnsPath, recordTurn);
          emit(`Completed turn ${turn} of ${this.config.turns}`);
          transcript.push(
            `## Turn ${turn}`,
            `**Player (${action.approach}):** ${action.action}`,
            result.check ? `**Check:** ${result.check.spec.name}, ${result.check.roll} + ${result.check.modifierTotal} vs ${result.check.spec.difficulty} — ${result.check.outcome}` : "",
            result.narration,
          );
          if (result.state.status !== "active") { stopReason = "campaign_ended"; break; }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          turns.push({ turn, action: action.action, approach: action.approach, status: "failed", error: message });
          await appendJsonLine(turnsPath, turns.at(-1));
          throw error;
        }
      }
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : String(error);
      stopReason = error instanceof EvaluationCostLimitError ? "cost_limit" : "error";
      await writeFile(path.join(sessionDir, "error.txt"), `${errorMessage}\n`, "utf8");
    }

    let entitiesAtEnd = 0;
    let factsAtEnd = 0;
    let campaignStatus = "not_created";
    let finalStateContext: string | undefined;
    try {
      const loaded = await store.load();
      entitiesAtEnd = loaded.entities.size;
      factsAtEnd = [...loaded.entities.values()].reduce((sum, entity) => sum + entity.facts.length, 0);
      campaignStatus = loaded.manifest.status;
      finalStateContext = await store.buildCanonicalStateContext();
      await rm(path.join(sessionDir, "final-state"), { recursive: true, force: true });
      await cp(store.currentDir, path.join(sessionDir, "final-state"), { recursive: true });
    } catch {
      // A setup failure can legitimately leave no campaign state to snapshot.
    }
    const status: SessionMetrics["status"] = stopReason === "error" ? "failed" : "completed";
    const transcriptText = `${transcript.filter(Boolean).join("\n\n")}\n`;
    await writeFile(path.join(sessionDir, "transcript.md"), transcriptText, "utf8");
    let judgment: SessionJudgment | undefined;
    let judgeStatus: SessionMetrics["judgeStatus"] = "not_run";
    let judgeError: string | undefined;
    if ((stopReason === "turn_limit" || stopReason === "campaign_ended") && startingStateContext && finalStateContext && canCall()) {
      progressPhase = "judging";
      currentTurn = completedTurns;
      emit(`Gameplay complete; judging with ${dm.id}/${dm.model}`);
      try {
        const preJudgeTechnicalHealth = technicalHealthStats(calls);
        const judged = await this.judgeSession(
          dm,
          profile,
          transcriptText,
          turns,
          startingStateContext,
          finalStateContext,
          preJudgeTechnicalHealth,
        );
        judgment = judged.data;
        judgeStatus = "completed";
        await writeFile(
          path.join(sessionDir, "evaluation.md"),
          renderJudgment(sessionId, profile, judgment, judged.provider, judged.model, technicalHealthStats(calls)),
          "utf8",
        );
      } catch (error) {
        judgeStatus = "failed";
        judgeError = error instanceof Error ? error.message : String(error);
      }
    }
    if (!judgment) {
      const reason = judgeError
        ?? (stopReason === "error" ? "Gameplay stopped because of a technical error." : stopReason === "cost_limit" ? "The cost ceiling was reached before judging." : "No final game state was available.");
      await writeFile(
        path.join(sessionDir, "evaluation.md"),
        `# AI Game Evaluation: ${sessionId}\n\nStatus: **${judgeStatus}**\n\n${reason}\n`,
        "utf8",
      );
    }
    const metrics = collectMetrics(
      sessionId,
      profile,
      status,
      stopReason,
      calls,
      turns,
      entitiesAtEnd,
      factsAtEnd,
      campaignStatus,
      judgment,
      judgeStatus,
      errorMessage,
    );
    await writeJson(path.join(sessionDir, "metrics.json"), metrics);
    if (metrics.status === "failed") {
      const fingerprints = Object.entries(metrics.failureFingerprints)
        .map(([fingerprint, count]) => `- ${count} × \`${fingerprint}\``)
        .join("\n") || "- No provider-call failure was recorded; the terminal error occurred during domain application.";
      await writeFile(
        path.join(sessionDir, "failure-analysis.md"),
        `# Technical Failure Analysis: ${sessionId}\n\nProfile: **${profile.id}**  \nCompleted turns: **${metrics.turnsCompleted}/${this.config.turns}**  \nFailed-call cost: **$${metrics.failedCallCostUsd.toFixed(4)}**  \nSuccessful structured repairs: **${metrics.repairCallsSucceeded}**  \nExhausted structured repairs: **${metrics.repairCallsFailed}**  \nExhausted domain repairs: **${metrics.domainRepairsExhausted}**\n\n## Failure fingerprints\n\n${fingerprints}\n\n## Terminal error\n\n\`\`\`text\n${metrics.error ?? "Unknown error"}\n\`\`\`\n`,
        "utf8",
      );
    }
    await writeJson(path.join(sessionDir, "configuration.json"), { sessionId, profile, config: this.config });
    progressPhase = metrics.stopReason === "cost_limit" ? "cost_limit" : metrics.status === "failed" ? "failed" : "completed";
    currentTurn = metrics.turnsCompleted;
    completedTurns = metrics.turnsCompleted;
    emit(`${metrics.status}, ${metrics.turnsCompleted} turns, $${metrics.estimatedCostUsd.toFixed(4)}`);
    return metrics;
  }
}

export async function generateEvaluationReport(runDir: string): Promise<string> {
  const manifest = await readEvaluationManifest(path.join(runDir, "manifest.json"));
  const metrics = manifest.sessions.flatMap((session) => (session.metrics ? [session.metrics] : []));
  await writeJson(path.join(runDir, "metrics.json"), {
    runId: manifest.runId,
    status: manifest.status,
    sessions: metrics,
    totalEstimatedCostUsd: manifest.totalEstimatedCostUsd,
  });
  const reportPath = path.join(runDir, "report.md");
  await writeFile(reportPath, runReport(manifest), "utf8");
  return reportPath;
}

export function defaultPlayerConfig(dmConfig: ProviderConfig): ProviderConfig {
  return ProviderConfigSchema.parse({
    ...dmConfig,
    model: dmConfig.provider === "gemini" ? "gemini-3.1-flash-lite" : "google/gemini-3.1-flash-lite",
    temperature: 0.9,
    maxOutputTokens: 1_500,
  });
}

export function inferModelCost(config: ProviderConfig): z.infer<typeof ModelCostSchema> | undefined {
  const model = config.model.toLowerCase();
  if (config.provider === "gemini" && model === "gemini-3.5-flash") return { inputPerMillion: 1.5, outputPerMillion: 9 };
  if (model.includes("gemini-3.1-flash-lite")) return { inputPerMillion: 0.25, outputPerMillion: 1.5 };
  if (config.provider === "openrouter" && model.includes("gemini-3.5-flash")) return { inputPerMillion: 1.5, outputPerMillion: 9 };
  if (config.provider === "gemini" && model === "gemini-3-flash-preview") return { inputPerMillion: 0.5, outputPerMillion: 3 };
  return undefined;
}
