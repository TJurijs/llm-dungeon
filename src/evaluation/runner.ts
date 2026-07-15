import { randomUUID } from "node:crypto";
import { appendFile, cp, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { DungeonEngine } from "../engine.js";
import { generateStructured } from "../llm/structured-generation.js";
import { atomicWriteJson as writeJson } from "../persistence/files.js";
import { acquireFileLock } from "../persistence/lock.js";
import { simulatedPlayerPrompt, simulatedPlayerSystemPrompt } from "../prompts/evaluation.js";
import { StateStore } from "../store.js";
import type { LlmProvider, StructuredRequest, StructuredResult, TurnResult } from "../types.js";
import {
  EvaluationConfigSchema,
  EvaluationRunIdSchema,
  PLAYER_PROFILES,
  SimulatedPlayerActionSchema,
  type CallRecord,
  type EvaluationConfig,
  type EvaluationManifest,
  type EvaluationProgressEvent,
  type EvaluationProgressPhase,
  type EvaluationRunResult,
  type EvaluationTurnRecord,
  type PlayerProfile,
  type SessionMetrics,
} from "./contracts.js";
import {
  completedJsonLineCost,
  EvaluationBudget,
  EvaluationCostLimitError,
  roundMoney,
} from "./cost.js";
import { hashText } from "./hash.js";
import {
  judgePrompt,
  judgeSystemPrompt,
  judgmentSchemaFor,
  renderJudgment,
  type SessionJudgment,
  type TechnicalHealthStats,
} from "./judge.js";
import { codeVersion, readOptionalEvaluationManifest } from "./manifest.js";
import { collectMetrics, technicalHealthStats } from "./metrics.js";
import { generateEvaluationReport } from "./report.js";
import { TelemetryProvider } from "./telemetry.js";

function messageForProgress(
  phase: EvaluationProgressPhase,
  currentTurn: number,
  totalTurns: number,
): string {
  if (phase === "setup") return "Generating campaign setup";
  if (phase === "playing") return `Playing turn ${currentTurn} of ${totalTurns}`;
  if (phase === "judging") return "Judging completed gameplay";
  return phase.replace("_", " ");
}

async function appendJsonLine(target: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(target), { recursive: true });
  await appendFile(target, `${JSON.stringify(value)}\n`, "utf8");
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
      worldPromptHash: hashText(this.worldRules),
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
    if (existing && existing.worldPromptHash !== hashText(this.worldRules)) {
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
          system: simulatedPlayerSystemPrompt(profile, this.config.language),
          prompt: simulatedPlayerPrompt(visibleContext),
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
