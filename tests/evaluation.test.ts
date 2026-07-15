import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  buildEvaluationConfig,
  configuredModelCost,
  defaultPlayerConfig,
  EvaluationConfigSchema,
  inferModelCost,
  PLAYER_PROFILES,
  SelfPlayEvaluator,
  type EvaluationConfig,
  type EvaluationManifest,
  type EvaluationProgressEvent,
} from "../src/evaluation.js";
import type { LlmProvider, StructuredRequest, StructuredResult } from "../src/types.js";
import { setupFixture } from "./helpers.js";
import { attachStructuredFailure } from "../src/llm/structured-error.js";
import { judgePrompt, judgmentSchemaFor, type JudgeTurn, type TechnicalHealthStats } from "../src/evaluation/judge.js";
import { acquireFileLock } from "../src/persistence/lock.js";

class EvaluationFakeProvider implements LlmProvider {
  readonly id = "fake";
  readonly model: string;
  calls = 0;

  constructor(model: string, private readonly role: "dm" | "player") {
    this.model = model;
  }

  async generateStructured<T>(request: StructuredRequest<T>): Promise<StructuredResult<T>> {
    this.calls += 1;
    let data: unknown;
    if (this.role === "player") {
      data = { action: "I ask Mara what has changed on the northern road.", approach: "investigation" };
    } else if (request.schemaName === "campaign_setup") {
      data = structuredClone(setupFixture);
    } else if (request.schemaName.includes("session_judgment")) {
      const turnRecords = JSON.parse(
        request.prompt.match(/TURN RECORDS WITH LOCKED CHECKS AND COMMITTED STATE OPERATIONS\n([\s\S]*?)\n\nDETERMINISTIC MECHANICAL AUDIT/)?.[1] ?? "[]",
      ) as Array<{ turn: number; status: string; operations?: unknown[] }>;
      data = {
        verdict: "good",
        overallScore: 8,
        narrativeScore: 8,
        agencyScore: 8,
        persistenceScore: 8,
        checksScore: 8,
        technicalScore: 8,
        turnAudits: turnRecords
          .filter((turn) => turn.status === "completed")
          .map((turn) => ({
            turn: turn.turn,
            durableConsequences: (turn.operations ?? []).map((_, operationIndex) => ({
              consequence: `Committed operation ${operationIndex} was applied.`,
              operationIndexes: [operationIndex],
              persistence: "persisted",
            })),
          })),
        executiveSummary: "The short session remained coherent and preserved the discovered clue.",
        strengths: ["The player retained agency and received a concrete lead."],
        issues: [],
        persistenceAssessment: "The committed state matches the narrated clue.",
        checkAssessment: "No unnecessary check was introduced.",
        sandboxAssessment: "The player could pursue the clue or choose another path.",
        recommendedChanges: ["Continue testing longer consequence chains."],
      };
    } else {
      data = {
        kind: "resolved",
        narration: "Mara sets down her cup and describes an abandoned cart found beyond the old bridge.",
        turnSummary: "Mara shared a clue about an abandoned cart.",
        operations: [],
      };
    }
    return {
      data: request.schema.parse(data),
      provider: this.id,
      model: this.model,
      usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
      rawText: JSON.stringify(data),
    };
  }
}

class DelayedEvaluationProvider extends EvaluationFakeProvider {
  active = 0;
  maxActive = 0;

  override async generateStructured<T>(request: StructuredRequest<T>): Promise<StructuredResult<T>> {
    this.active += 1;
    this.maxActive = Math.max(this.maxActive, this.active);
    await new Promise((resolve) => setTimeout(resolve, 15));
    try {
      return await super.generateStructured(request);
    } finally {
      this.active -= 1;
    }
  }
}

class DiagnosticFailureProvider extends EvaluationFakeProvider {
  private failedSetup = false;

  override async generateStructured<T>(request: StructuredRequest<T>): Promise<StructuredResult<T>> {
    if (request.schemaName === "campaign_setup" && !this.failedSetup) {
      this.failedSetup = true;
      const parsed = [{ unexpected: "array wrapper" }, { duplicate: "candidate" }];
      const failure = z.object({ required: z.string() }).safeParse(parsed);
      if (failure.success) throw new Error("Expected diagnostic fixture to fail");
      attachStructuredFailure(failure.error, {
        rawText: JSON.stringify(parsed),
        parsedResponse: parsed,
        usage: { inputTokens: 20, outputTokens: 10, totalTokens: 30 },
      });
      throw failure.error;
    }
    if (request.schemaName === "repair_campaign_setup") {
      return {
        data: request.schema.parse(structuredClone(setupFixture)),
        provider: this.id,
        model: this.model,
        usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
        rawText: JSON.stringify(setupFixture),
      };
    }
    return super.generateStructured(request);
  }
}

class DeathEndingProvider extends EvaluationFakeProvider {
  override async generateStructured<T>(request: StructuredRequest<T>): Promise<StructuredResult<T>> {
    if (request.schemaName === "turn_decision_v1") {
      const data = {
        kind: "resolved",
        narration: "The established lethal confrontation ends with the adventurer's death.",
        turnSummary: "The adventurer died in the established lethal confrontation.",
        operations: [{ type: "end_campaign", status: "dead", reason: "The adventurer was killed." }],
      };
      return {
        data: request.schema.parse(data),
        provider: this.id,
        model: this.model,
        usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
        rawText: JSON.stringify(data),
      };
    }
    return super.generateStructured(request);
  }
}

class CheckHeavyProvider extends EvaluationFakeProvider {
  override async generateStructured<T>(request: StructuredRequest<T>): Promise<StructuredResult<T>> {
    if (request.schemaName === "turn_decision_v1") {
      const data = {
        kind: "check_required",
        check: {
          name: "Routine conversation",
          difficulty: 50,
          modifiers: [],
          exceptionalSuccessStakes: "Mara answers and offers useful context.",
          successStakes: "Mara answers.",
          failureStakes: "Mara does not answer.",
          severeFailureStakes: "Mara refuses to answer for now.",
          failureCampaignStatus: "none",
        },
      };
      return { data: request.schema.parse(data), provider: this.id, model: this.model };
    }
    if (request.schemaName === "turn_resolution_v1") {
      const data = {
        narration: "Mara answers the ordinary question.",
        turnSummary: "Mara answered.",
        operations: [],
      };
      return { data: request.schema.parse(data), provider: this.id, model: this.model };
    }
    return super.generateStructured(request);
  }
}

class ExhaustedRepairProvider extends EvaluationFakeProvider {
  turnCalls: string[] = [];

  override async generateStructured<T>(request: StructuredRequest<T>): Promise<StructuredResult<T>> {
    if (request.schemaName === "turn_decision_v1" || request.schemaName === "repair_turn_decision_v1") {
      this.turnCalls.push(request.schemaName);
      return { data: request.schema.parse([]), provider: this.id, model: this.model };
    }
    return super.generateStructured(request);
  }
}

function config(): EvaluationConfig {
  return {
    sessions: 2,
    turns: 2,
    maxCostUsd: 1,
    dm: {
      config: { provider: "gemini", model: "gemini-3.5-flash", temperature: 0.8, maxOutputTokens: 4000 },
      cost: { inputPerMillion: 0.75, outputPerMillion: 4.5 },
    },
    player: {
      config: { provider: "gemini", model: "gemini-3.1-flash-lite", temperature: 0.9, maxOutputTokens: 1500 },
      cost: { inputPerMillion: 0.25, outputPerMillion: 1.5 },
    },
  };
}

async function seedInterruptedRun(
  projectRoot: string,
  runId: string,
  inputConfig: EvaluationConfig,
  calls: string,
): Promise<{ evaluationsRoot: string; runDir: string; config: EvaluationConfig }> {
  const evaluationsRoot = path.join(projectRoot, "evaluations");
  const runDir = path.join(evaluationsRoot, "runs", runId);
  const sessionDir = path.join(runDir, "sessions", "session-001");
  const normalizedConfig = EvaluationConfigSchema.parse(inputConfig);
  const now = new Date().toISOString();
  const manifest: EvaluationManifest = {
    schemaVersion: 1,
    runId,
    startedAt: now,
    updatedAt: now,
    status: "running",
    codeVersion: { commit: null, dirty: null, sourceHash: "test-source" },
    config: normalizedConfig,
    worldPromptHash: createHash("sha256").update("Classic fantasy rules.").digest("hex"),
    totalEstimatedCostUsd: 0,
    abandonedCostUsd: 0,
    sessions: [{ id: "session-001", profile: "curious-explorer", status: "running" }],
  };
  await mkdir(sessionDir, { recursive: true });
  await writeFile(path.join(runDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  await writeFile(path.join(sessionDir, "calls.jsonl"), calls, "utf8");
  return { evaluationsRoot, runDir, config: normalizedConfig };
}

describe("self-play evaluation", () => {
  it("builds the shared schema-normalized CLI and Web evaluation configuration", () => {
    const dm = { provider: "gemini" as const, model: "gemini-3.5-flash", temperature: 0.8, maxOutputTokens: 4000 };
    expect(buildEvaluationConfig({
      dmConfig: dm,
      language: "ru",
      sessions: 3,
      turns: 4,
      concurrency: 2,
      maxCostUsd: 2,
      playerProfiles: ["chaotic"],
    })).toEqual({
      language: "ru",
      sessions: 3,
      turns: 4,
      concurrency: 2,
      maxCostUsd: 2,
      playerProfiles: ["chaotic"],
      dm: {
        config: dm,
        cost: { inputPerMillion: 1.5, outputPerMillion: 9 },
      },
      player: {
        config: defaultPlayerConfig(dm),
        cost: { inputPerMillion: 0.25, outputPerMillion: 1.5 },
      },
    });
    expect(() => configuredModelCost({ ...dm, model: "unknown-model" }, "DM"))
      .toThrow("No built-in pricing for DM model unknown-model");
  });

  it("uses Gemini 3.1 Flash-Lite as the default player and current standard prices", () => {
    const dm = { provider: "gemini" as const, model: "gemini-3.5-flash", temperature: 0.8, maxOutputTokens: 4000 };
    expect(defaultPlayerConfig(dm).model).toBe("gemini-3.1-flash-lite");
    expect(defaultPlayerConfig(dm).maxOutputTokens).toBe(1_500);
    expect(inferModelCost(dm)).toEqual({ inputPerMillion: 1.5, outputPerMillion: 9 });
    expect(inferModelCost(defaultPlayerConfig(dm))).toEqual({ inputPerMillion: 0.25, outputPerMillion: 1.5 });
  });

  it("runs isolated sessions and produces same-model AI evaluations without leaking secrets to the player model", async () => {
    const projectRoot = await mkdtemp(path.join(tmpdir(), "llm-dungeon-eval-"));
    const evaluationsRoot = path.join(projectRoot, "evaluations");
    const evaluator = new SelfPlayEvaluator(
      projectRoot,
      evaluationsRoot,
      config(),
      "Classic fantasy rules.",
      new EvaluationFakeProvider("dm", "dm"),
      new EvaluationFakeProvider("player", "player"),
    );
    const result = await evaluator.run("test-run");
    expect(result.manifest.status).toBe("completed");
    expect(result.manifest.sessions).toHaveLength(2);
    expect(result.manifest.sessions.every((session) => session.metrics?.turnsCompleted === 2)).toBe(true);
    await expect(access(path.join(projectRoot, "data", "current"))).rejects.toThrow();
    const transcript = await readFile(path.join(result.runDir, "sessions", "session-001", "transcript.md"), "utf8");
    expect(transcript).toContain("abandoned cart");
    expect(await readFile(result.reportPath, "utf8")).toContain("Turns completed: 4");
    expect(await readFile(result.reportPath, "utf8")).toContain("Checks: 0 (0.0% of completed turns)");
    expect(await readFile(result.reportPath, "utf8")).toContain("AI judge evaluations completed: 2/2");
    expect(await readFile(result.reportPath, "utf8")).toContain("Clean quality gates: 2/2");
    const evaluation = await readFile(path.join(result.runDir, "sessions", "session-001", "evaluation.md"), "utf8");
    expect(evaluation).toContain("AI Game Evaluation");
    expect(evaluation).toContain("Overall score: **8/10**");
    expect(evaluation).toContain("Technical reliability");
    await expect(access(path.join(result.runDir, "sessions", "session-001", "review.md"))).rejects.toThrow();

    const calls = (await readFile(path.join(result.runDir, "sessions", "session-001", "calls.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { role: string; prompt: string });
    const playerPrompts = calls.filter((call) => call.role === "player").map((call) => call.prompt).join("\n");
    const dmPrompts = calls.filter((call) => call.role === "dm").map((call) => call.prompt).join("\n");
    expect(playerPrompts).not.toContain("watch captain takes bribes");
    expect(dmPrompts).toContain("watch captain takes bribes");
    const judgePrompt = calls.find((call) => call.role === "dm" && call.prompt.includes("AUTHORITATIVE STARTING DM STATE"))?.prompt;
    expect(judgePrompt).toContain("AUTHORITATIVE STARTING DM STATE");
    expect(judgePrompt).toContain("DETERMINISTIC CHECK-USAGE SUMMARY");
    expect(judgePrompt).toContain("Check rate: 0.0%");
    expect(judgePrompt).toContain("DETERMINISTIC TECHNICAL-HEALTH SUMMARY");
    expect(judgePrompt).toContain("Failed DM structured calls: 0 (0.0%)");
    expect(judgePrompt).toContain("item:travel-sword");
    expect(judgePrompt).toContain("FINAL PERSISTENT DM STATE");
    await expect(access(path.join(result.runDir, "sessions", "session-001", "starting-state", "manifest.json"))).resolves.toBeUndefined();
  });

  it("runs isolated sessions with bounded parallelism and emits per-session progress", async () => {
    const projectRoot = await mkdtemp(path.join(tmpdir(), "llm-dungeon-parallel-"));
    const dm = new DelayedEvaluationProvider("dm", "dm");
    const player = new DelayedEvaluationProvider("player", "player");
    const progress: EvaluationProgressEvent[] = [];
    const result = await new SelfPlayEvaluator(
      projectRoot,
      path.join(projectRoot, "evaluations"),
      { ...config(), sessions: 4, turns: 1, concurrency: 2 },
      "Classic fantasy rules.",
      dm,
      player,
      0,
      (event) => progress.push(structuredClone(event)),
    ).run("parallel-run");

    expect(result.manifest.status).toBe("completed");
    expect(dm.maxActive).toBe(2);
    expect(player.maxActive).toBeLessThanOrEqual(2);
    expect(result.manifest.sessions.every((session) => session.metrics?.turnsCompleted === 1)).toBe(true);
    for (const session of result.manifest.sessions) {
      const events = progress.filter((event) => event.sessionId === session.id);
      expect(events[0]?.phase).toBe("queued");
      expect(events.some((event) => event.phase === "setup")).toBe(true);
      expect(events.some((event) => event.phase === "playing" && event.currentTurn === 1)).toBe(true);
      expect(events.at(-1)).toMatchObject({ phase: "completed", completedTurns: 1, totalTurns: 1 });
    }
    expect(await readFile(result.reportPath, "utf8")).toContain("Parallel workers: 2");
  });

  it("reports and sends excessive numeric check usage to the judge without prose heuristics", async () => {
    const projectRoot = await mkdtemp(path.join(tmpdir(), "llm-dungeon-check-rate-"));
    const result = await new SelfPlayEvaluator(
      projectRoot,
      path.join(projectRoot, "evaluations"),
      { ...config(), sessions: 1, turns: 2 },
      "Classic fantasy rules.",
      new CheckHeavyProvider("dm", "dm"),
      new EvaluationFakeProvider("player", "player"),
    ).run("check-heavy-run");

    expect(result.manifest.sessions[0]?.metrics).toMatchObject({ checks: 2, checkRate: 1 });
    const report = await readFile(result.reportPath, "utf8");
    expect(report).toContain("Checks: 2 (100.0% of completed turns)");
    expect(report).toContain("Mechanical alert");
    const calls = (await readFile(path.join(result.runDir, "sessions", "session-001", "calls.jsonl"), "utf8"))
      .trim().split("\n").map((line) => JSON.parse(line) as { role: string; prompt: string; system: string });
    const judge = calls.find((call) => call.role === "dm" && call.prompt.includes("DETERMINISTIC CHECK-USAGE SUMMARY"));
    expect(judge?.prompt).toContain("Check rate: 100.0%");
    expect(judge?.prompt).toContain("Longest consecutive run of checked turns: 2");
    expect(judge?.system).toContain("check-rate warning is evidence for review");
  });

  it("uses an explicitly selected profile for a single-session run", async () => {
    const projectRoot = await mkdtemp(path.join(tmpdir(), "llm-dungeon-profile-"));
    const result = await new SelfPlayEvaluator(
      projectRoot,
      path.join(projectRoot, "evaluations"),
      { ...config(), sessions: 1, turns: 1, playerProfiles: ["long-term-planner"] },
      "Classic fantasy rules.",
      new EvaluationFakeProvider("dm", "dm"),
      new EvaluationFakeProvider("player", "player"),
    ).run("profile-run");
    expect(result.manifest.sessions[0]?.profile).toBe("long-term-planner");
  });

  it("rotates only through the selected profile pool in its configured order", async () => {
    const projectRoot = await mkdtemp(path.join(tmpdir(), "llm-dungeon-profile-pool-"));
    const result = await new SelfPlayEvaluator(
      projectRoot,
      path.join(projectRoot, "evaluations"),
      {
        ...config(),
        sessions: 5,
        turns: 1,
        playerProfiles: ["chaotic", "cautious-investigator", "social-manipulator"],
      },
      "Classic fantasy rules.",
      new EvaluationFakeProvider("dm", "dm"),
      new EvaluationFakeProvider("player", "player"),
    ).run("profile-pool-run");
    expect(result.manifest.sessions.map((session) => session.profile)).toEqual([
      "chaotic",
      "cautious-investigator",
      "social-manipulator",
      "chaotic",
      "cautious-investigator",
    ]);
  });

  it("offers a chaotic adversarial profile and records its exact instructions", async () => {
    expect(PLAYER_PROFILES.some((profile) => profile.id === "chaotic")).toBe(true);
    const projectRoot = await mkdtemp(path.join(tmpdir(), "llm-dungeon-chaotic-"));
    const run = await new SelfPlayEvaluator(
      projectRoot,
      path.join(projectRoot, "evaluations"),
      { ...config(), sessions: 1, turns: 1, playerProfiles: ["chaotic"] },
      "Classic fantasy rules.",
      new EvaluationFakeProvider("dm", "dm"),
      new EvaluationFakeProvider("player", "player"),
    ).run("chaotic-run");
    expect(run.manifest.sessions[0]?.profile).toBe("chaotic");
    const calls = (await readFile(path.join(run.runDir, "sessions", "session-001", "calls.jsonl"), "utf8"))
      .trim().split("\n").map((line) => JSON.parse(line) as { role: string; system: string });
    expect(calls.find((call) => call.role === "player")?.system).toContain("Follow the adversarial profile literally");
    expect(calls.find((call) => call.role === "dm" && call.system.includes("quality judge"))?.system).toContain("judge the DM's handling rather than penalizing the supplied player behavior");
  });

  it("records invalid raw structured output and its real cost before correction", async () => {
    const projectRoot = await mkdtemp(path.join(tmpdir(), "llm-dungeon-diagnostics-"));
    const run = await new SelfPlayEvaluator(
      projectRoot,
      path.join(projectRoot, "evaluations"),
      { ...config(), sessions: 1, turns: 1 },
      "Classic fantasy rules.",
      new DiagnosticFailureProvider("dm", "dm"),
      new EvaluationFakeProvider("player", "player"),
    ).run("diagnostic-run");
    const records = (await readFile(path.join(run.runDir, "sessions", "session-001", "calls.jsonl"), "utf8"))
      .trim().split("\n").map((line) => JSON.parse(line) as Record<string, any>);
    expect(records[0]).toMatchObject({
      schemaName: "campaign_setup",
      success: false,
      rawText: '[{"unexpected":"array wrapper"},{"duplicate":"candidate"}]',
      usage: { inputTokens: 20, outputTokens: 10, totalTokens: 30 },
    });
    expect(records[0]?.response).toEqual([{ unexpected: "array wrapper" }, { duplicate: "candidate" }]);
    expect(records[0]?.estimatedCostUsd).toBeGreaterThan(0);
    expect(run.manifest.sessions[0]?.status).toBe("completed");
    const judgePrompt = records.find((record) => record.role === "dm" && String(record.prompt).includes("DETERMINISTIC TECHNICAL-HEALTH SUMMARY"))?.prompt as string;
    expect(judgePrompt).toContain("Failed DM structured calls: 1 (33.3%)");
    expect(judgePrompt).toContain("Schema repair calls: 1");
    expect(await readFile(path.join(run.runDir, "sessions", "session-001", "evaluation.md"), "utf8")).toContain("Failed DM structured calls: 1 (33.3%)");
  });

  it("treats death as game over and judges the completed shortened session", async () => {
    const projectRoot = await mkdtemp(path.join(tmpdir(), "llm-dungeon-death-"));
    const run = await new SelfPlayEvaluator(
      projectRoot,
      path.join(projectRoot, "evaluations"),
      { ...config(), sessions: 1, turns: 20 },
      "Classic fantasy rules.",
      new DeathEndingProvider("dm", "dm"),
      new EvaluationFakeProvider("player", "player"),
    ).run("death-run");
    const metrics = run.manifest.sessions[0]?.metrics;
    expect(metrics?.turnsCompleted).toBe(1);
    expect(metrics?.stopReason).toBe("campaign_ended");
    expect(metrics?.campaignStatus).toBe("dead");
    expect(metrics?.judgeStatus).toBe("completed");
  });

  it("stops before another model call once the estimated cost ceiling is reached", async () => {
    const projectRoot = await mkdtemp(path.join(tmpdir(), "llm-dungeon-cost-"));
    const dm = new EvaluationFakeProvider("dm", "dm");
    const player = new EvaluationFakeProvider("player", "player");
    const result = await new SelfPlayEvaluator(
      projectRoot,
      path.join(projectRoot, "evaluations"),
      { ...config(), sessions: 1, turns: 5, maxCostUsd: 0.0001 },
      "Classic fantasy rules.",
      dm,
      player,
    ).run("cost-limited");
    expect(result.manifest.status).toBe("cost_limit");
    expect(dm.calls).toBe(1);
    expect(player.calls).toBe(0);
    expect(result.manifest.sessions[0]?.metrics?.stopReason).toBe("cost_limit");
  });

  it("does not launch a burst of parallel calls after the shared cost ceiling is consumed", async () => {
    const projectRoot = await mkdtemp(path.join(tmpdir(), "llm-dungeon-parallel-cost-"));
    const dm = new DelayedEvaluationProvider("dm", "dm");
    const player = new DelayedEvaluationProvider("player", "player");
    const result = await new SelfPlayEvaluator(
      projectRoot,
      path.join(projectRoot, "evaluations"),
      { ...config(), sessions: 4, turns: 2, concurrency: 4, maxCostUsd: 0.0001 },
      "Classic fantasy rules.",
      dm,
      player,
    ).run("parallel-cost-limited");

    expect(result.manifest.status).toBe("cost_limit");
    expect(dm.calls).toBe(1);
    expect(player.calls).toBe(0);
  });

  it("retains complete abandoned-call costs when the final JSONL record is truncated", async () => {
    const projectRoot = await mkdtemp(path.join(tmpdir(), "llm-dungeon-truncated-cost-"));
    const runId = "truncated-cost-run";
    const seeded = await seedInterruptedRun(
      projectRoot,
      runId,
      { ...config(), sessions: 1, turns: 1, maxCostUsd: 0.1 },
      `${JSON.stringify({ estimatedCostUsd: 0.04 })}\n${JSON.stringify({ estimatedCostUsd: 0.07 })}\n{"estimatedCostUsd":`,
    );
    const dm = new EvaluationFakeProvider("dm", "dm");
    const result = await new SelfPlayEvaluator(
      projectRoot,
      seeded.evaluationsRoot,
      seeded.config,
      "Classic fantasy rules.",
      dm,
      new EvaluationFakeProvider("player", "player"),
    ).run(runId);

    expect(result.manifest.status).toBe("cost_limit");
    expect(result.manifest.abandonedCostUsd).toBe(0.11);
    expect(result.manifest.totalEstimatedCostUsd).toBe(0.11);
    expect(dm.calls).toBe(0);
  });

  it("fails closed on a malformed saved manifest without replacing run artifacts", async () => {
    const projectRoot = await mkdtemp(path.join(tmpdir(), "llm-dungeon-corrupt-run-"));
    const evaluationsRoot = path.join(projectRoot, "evaluations");
    const runDir = path.join(evaluationsRoot, "runs", "protected-run");
    const sentinel = path.join(runDir, "sessions", "session-001", "sentinel.txt");
    await mkdir(path.dirname(sentinel), { recursive: true });
    await writeFile(sentinel, "preserve me", "utf8");
    await writeFile(path.join(runDir, "manifest.json"), "{not valid json", "utf8");
    const dm = new EvaluationFakeProvider("dm", "dm");

    await expect(new SelfPlayEvaluator(
      projectRoot,
      evaluationsRoot,
      { ...config(), sessions: 1, turns: 1 },
      "Classic fantasy rules.",
      dm,
      new EvaluationFakeProvider("player", "player"),
    ).run("protected-run")).rejects.toThrow();

    expect(await readFile(sentinel, "utf8")).toBe("preserve me");
    expect(await readFile(path.join(runDir, "manifest.json"), "utf8")).toBe("{not valid json");
    expect(dm.calls).toBe(0);
  });

  it("rejects unsafe run IDs before creating or reading evaluation paths", async () => {
    const projectRoot = await mkdtemp(path.join(tmpdir(), "llm-dungeon-run-id-"));
    const dm = new EvaluationFakeProvider("dm", "dm");
    await expect(new SelfPlayEvaluator(
      projectRoot,
      path.join(projectRoot, "evaluations"),
      { ...config(), sessions: 1, turns: 1 },
      "Classic fantasy rules.",
      dm,
      new EvaluationFakeProvider("player", "player"),
    ).run("../../data/current")).rejects.toThrow(/safe evaluation run ID/);
    expect(dm.calls).toBe(0);
    await expect(access(path.join(projectRoot, "data", "current"))).rejects.toThrow();
  });

  it("prevents two processes from resuming the same evaluation run", async () => {
    const projectRoot = await mkdtemp(path.join(tmpdir(), "llm-dungeon-run-lock-"));
    const evaluationsRoot = path.join(projectRoot, "evaluations");
    const runId = "locked-run";
    const release = await acquireFileLock(
      path.join(evaluationsRoot, "runs", runId, ".run.lock"),
      `Evaluation run ${runId}`,
    );
    const dm = new EvaluationFakeProvider("dm", "dm");
    try {
      await expect(new SelfPlayEvaluator(
        projectRoot,
        evaluationsRoot,
        { ...config(), sessions: 1, turns: 1 },
        "Classic fantasy rules.",
        dm,
        new EvaluationFakeProvider("player", "player"),
      ).run(runId)).rejects.toThrow(/locked by another running process/);
      expect(dm.calls).toBe(0);
    } finally {
      await release();
    }
  });

  it("checkpoints interrupted-session normalization before queued workers start", async () => {
    const projectRoot = await mkdtemp(path.join(tmpdir(), "llm-dungeon-resume-checkpoint-"));
    const runId = "resume-checkpoint-run";
    const seeded = await seedInterruptedRun(
      projectRoot,
      runId,
      { ...config(), sessions: 1, turns: 1, maxCostUsd: 0.1 },
      `${JSON.stringify({ estimatedCostUsd: 0.11 })}\n`,
    );
    let queuedSnapshot: EvaluationManifest | undefined;
    await new SelfPlayEvaluator(
      projectRoot,
      seeded.evaluationsRoot,
      seeded.config,
      "Classic fantasy rules.",
      new EvaluationFakeProvider("dm", "dm"),
      new EvaluationFakeProvider("player", "player"),
      0,
      (event) => {
        if (event.phase !== "queued" || queuedSnapshot) return;
        queuedSnapshot = JSON.parse(readFileSync(path.join(seeded.runDir, "manifest.json"), "utf8")) as EvaluationManifest;
      },
    ).run(runId);

    expect(queuedSnapshot?.sessions[0]?.status).toBe("pending");
    expect(queuedSnapshot?.abandonedCostUsd).toBe(0.11);
    expect(queuedSnapshot?.totalEstimatedCostUsd).toBe(0.11);
  });

  it("requires a complete turn-by-turn persistence audit and caps scores when consequences are missing", () => {
    const turns: JudgeTurn[] = [{
      turn: 6,
      action: "I swallow a coin and collide with the door.",
      approach: "rule_challenge",
      narration: "You bruise your shoulder and swallow the coin.",
      summary: "The coin was swallowed.",
      operations: [{ type: "change_inventory", ownerId: "player:hero", itemId: "item:silver-coins", quantityDelta: -1 }],
      status: "completed",
    }];
    const health: TechnicalHealthStats = {
      gameplayDmCalls: 1,
      gameplayPlayerCalls: 1,
      failedDmCalls: 0,
      failedPlayerCalls: 0,
      dmFailureRate: 0,
      schemaRepairCalls: 0,
      transientRetryCalls: 0,
      domainRepairCalls: 0,
      failedCallCostUsd: 0,
    };
    const judgment = {
      verdict: "excellent" as const,
      overallScore: 10,
      narrativeScore: 10,
      agencyScore: 10,
      persistenceScore: 10,
      checksScore: 10,
      technicalScore: 10,
      turnAudits: [{ turn: 6, durableConsequences: [
        { consequence: "Bruised shoulder", operationIndexes: [], persistence: "missing" as const },
        { consequence: "The swallowed coin left the inventory.", operationIndexes: [0], persistence: "persisted" as const },
      ] }],
      executiveSummary: "The run was technically clean but missed an injury.",
      strengths: ["The unsupported claim was rejected."],
      issues: [{
        severity: "medium" as const,
        category: "persistence" as const,
        evidence: "The lasting shoulder injury has no operation.",
        recommendation: "Persist the condition in the same turn.",
      }],
      persistenceAssessment: "The injury was not persisted.",
      checkAssessment: "No check was needed.",
      sandboxAssessment: "The world remained grounded.",
      recommendedChanges: ["Persist lasting injuries."],
    };
    expect(judgmentSchemaFor(turns, health).safeParse(judgment).success).toBe(false);
    expect(judgmentSchemaFor(turns, health).safeParse({
      ...judgment,
      verdict: "good",
      overallScore: 8,
      persistenceScore: 8,
    }).success).toBe(true);
    expect(judgmentSchemaFor(turns, health).safeParse({
      ...judgment,
      verdict: "good",
      overallScore: 8,
      persistenceScore: 8,
      turnAudits: [{ turn: 6, durableConsequences: [{
        consequence: "Bruised shoulder",
        operationIndexes: [],
        persistence: "missing" as const,
      }] }],
    }).success).toBe(false);
    expect(judgmentSchemaFor(turns, health).safeParse({
      ...judgment,
      verdict: "good",
      overallScore: 8,
      persistenceScore: 8,
      turnAudits: [{ turn: 6, durableConsequences: [
        { consequence: "Bruised shoulder", operationIndexes: [0], persistence: "missing" as const },
        { consequence: "The swallowed coin left the inventory.", operationIndexes: [0], persistence: "persisted" as const },
      ] }],
    }).success).toBe(false);
    expect(judgmentSchemaFor(turns, health).safeParse({
      ...judgment,
      verdict: "good",
      overallScore: 8,
      persistenceScore: 8,
      turnAudits: [{ turn: 6, durableConsequences: [
        { consequence: "The inventory operation contradicts narration.", operationIndexes: [], persistence: "contradicted" as const },
        { consequence: "The swallowed coin left the inventory.", operationIndexes: [0], persistence: "persisted" as const },
      ] }],
    }).success).toBe(false);
    expect(judgmentSchemaFor(turns, health).safeParse({
      ...judgment,
      verdict: "good",
      overallScore: 8,
      persistenceScore: 8,
      turnAudits: [],
    }).success).toBe(false);
    expect(judgmentSchemaFor(turns, health).safeParse({
      ...judgment,
      verdict: "good",
      overallScore: 8,
      persistenceScore: 8,
      turnAudits: [{ turn: 6, durableConsequences: [{
        consequence: "The swallowed coin left the inventory.",
        operationIndexes: [0],
        persistence: "persisted" as const,
      }] }],
    }).success).toBe(false);
    expect(judgmentSchemaFor(turns, health).safeParse({
      ...judgment,
      verdict: "good",
      overallScore: 9,
      persistenceScore: 9,
      issues: [{
        severity: "low" as const,
        category: "continuity" as const,
        evidence: "The prose repeats a title, but the operation persisted exactly.",
        recommendation: "Avoid redundant formatting.",
      }],
      turnAudits: [{ turn: 6, durableConsequences: [{
        consequence: "The swallowed coin left the inventory.",
        operationIndexes: [0],
        persistence: "persisted" as const,
      }] }],
    }).success).toBe(true);
    const renderedPrompt = judgePrompt(
      { id: "rule-challenger", instruction: "Challenge unsupported rules." },
      "Transcript",
      turns,
      "Starting state",
      "Final state",
      health,
    );
    expect(renderedPrompt).toContain('"operationIndex": 0');
    expect(renderedPrompt).toContain("operationIndex values restart at 0 for every turn");
    expect(renderedPrompt).toContain("zero operations and zero narrated durable consequences");

    const zeroOperationTurns: JudgeTurn[] = [{
      ...turns[0]!,
      narration: "Nothing changes beyond a brief exchange.",
      summary: "No durable change.",
      operations: [],
    }];
    const zeroOperationJudgment = {
      ...judgment,
      verdict: "excellent" as const,
      overallScore: 10,
      persistenceScore: 10,
      issues: [],
      turnAudits: [{ turn: 6, durableConsequences: [] }],
    };
    expect(judgmentSchemaFor(zeroOperationTurns, health).safeParse(zeroOperationJudgment).success).toBe(true);
    expect(judgmentSchemaFor(zeroOperationTurns, health).safeParse({
      ...zeroOperationJudgment,
      turnAudits: [{ turn: 6, durableConsequences: [{
        consequence: "No state changed.",
        operationIndexes: [],
        persistence: "persisted" as const,
      }] }],
    }).success).toBe(false);

    const zeroOperationMissingJudgment = {
      ...zeroOperationJudgment,
      verdict: "good" as const,
      overallScore: 8,
      persistenceScore: 8,
      issues: [{
        severity: "medium" as const,
        category: "persistence" as const,
        evidence: "Mara narratively left, but no movement operation was committed.",
        recommendation: "Persist the departure with move_entity.",
      }],
      turnAudits: [{ turn: 6, durableConsequences: [{
        consequence: "Mara left the tavern.",
        operationIndexes: [],
        persistence: "missing" as const,
      }] }],
    };
    expect(judgmentSchemaFor(zeroOperationTurns, health).safeParse(zeroOperationMissingJudgment).success).toBe(true);

    const recoveryHeavyHealth = {
      ...health,
      schemaRepairCalls: 1,
      transientRetryCalls: 1,
      domainRepairCalls: 1,
    };
    expect(judgmentSchemaFor(zeroOperationTurns, recoveryHeavyHealth)
      .safeParse(zeroOperationJudgment).success).toBe(false);
    expect(judgmentSchemaFor(zeroOperationTurns, recoveryHeavyHealth).safeParse({
      ...zeroOperationJudgment,
      verdict: "good",
      overallScore: 8,
    }).success).toBe(true);
  });

  it("stops after one centralized repair attempt and never auto-resumes the pending turn", async () => {
    const projectRoot = await mkdtemp(path.join(tmpdir(), "llm-dungeon-pending-retry-"));
    const dm = new ExhaustedRepairProvider("dm", "dm");
    const result = await new SelfPlayEvaluator(
      projectRoot,
      path.join(projectRoot, "evaluations"),
      { ...config(), sessions: 1, turns: 1 },
      "Classic fantasy rules.",
      dm,
      new EvaluationFakeProvider("player", "player"),
    ).run("pending-retry-run");

    expect(result.manifest.sessions[0]?.status).toBe("failed");
    expect(result.manifest.sessions[0]?.metrics?.turnsCompleted).toBe(0);
    expect(dm.turnCalls).toEqual(["turn_decision_v1", "repair_turn_decision_v1"]);
  });
});
