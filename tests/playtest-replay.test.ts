import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  DEFAULT_MODEL_EXECUTION_PROFILE_DRAFTS,
  freezeModelExecutionProfile,
  type FrozenModelExecutionProfile,
} from "../src/model-execution-profile.js";
import type { LlmProvider, StructuredRequest, StructuredResult } from "../src/types.js";
import { PlaytestCostManager } from "../tools/playtest/harness/cost.js";
import { attributePlaytestFailure } from "../tools/playtest/harness/failure-attribution.js";
import {
  FocusedReplayRunner,
  createDiagnosticBundle,
  readDiagnosticBundle,
  readFocusedReplayManifest,
  writeDiagnosticBundle,
} from "../tools/playtest/harness/replay.js";
import { PlaytestProviderScheduler } from "../tools/playtest/harness/scheduler.js";

const AnswerSchema = z.object({ answer: z.string() }).strict();
const PRICE = { inputPerMillion: 1, outputPerMillion: 1 } as const;

class ReplayProvider implements LlmProvider {
  readonly id = "gemini";
  readonly model = "gemini-3.5-flash";
  calls = 0;
  requests: StructuredRequest<unknown>[] = [];

  async generateStructured<T>(request: StructuredRequest<T>): Promise<StructuredResult<T>> {
    this.calls += 1;
    this.requests.push(request as StructuredRequest<unknown>);
    return {
      data: request.schema.parse({ answer: "replayed" }),
      provider: this.id,
      model: this.model,
      usage: { billedCostUsd: 0.005 },
    };
  }
}

class DelayedReplayProvider implements LlmProvider {
  readonly id = "gemini";
  readonly model = "gemini-3.5-flash";

  constructor(private readonly activity: { active: number; maximum: number }) {}

  async generateStructured<T>(request: StructuredRequest<T>): Promise<StructuredResult<T>> {
    this.activity.active += 1;
    this.activity.maximum = Math.max(this.activity.maximum, this.activity.active);
    await new Promise((resolve) => setTimeout(resolve, 15));
    this.activity.active -= 1;
    return {
      data: request.schema.parse({ answer: "replayed" }),
      provider: this.id,
      model: this.model,
      usage: { billedCostUsd: 0.005 },
    };
  }
}

function profile(): FrozenModelExecutionProfile {
  return freezeModelExecutionProfile({
    ...DEFAULT_MODEL_EXECUTION_PROFILE_DRAFTS[0]!,
    calibratedAt: "2026-07-19T00:00:00.000Z",
    evidenceRef: "calibrations/test-run",
  });
}

function diagnostic(executionProfile = profile()) {
  const request: StructuredRequest<{ answer: string }> = {
    schemaName: "answer",
    schema: AnswerSchema,
    system: "Repair the response",
    prompt: "Return an answer",
    protocolVersion: 1,
    temperature: 0.25,
    maxOutputTokens: 4_000,
    generationPhase: "repair",
    repairOfPhase: "decision",
    attemptKind: "schema_repair",
    retryBackoffMs: 125,
  };
  return createDiagnosticBundle({
    expectedPhase: "repair",
    profile: executionProfile,
    stateSnapshot: "turn 7",
    request,
    responseMetadata: { finishReason: "malformed" },
    attribution: attributePlaytestFailure(new Error("malformed response"), { lane: "candidate" }),
    failureKind: "malformed_json",
    failureMessage: "malformed response",
    now: new Date("2026-07-19T00:00:00.000Z"),
  });
}

describe("focused diagnostic replay", () => {
  it("redacts credentials, preserves exact attempt metadata, accounts cost, and never commits state", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "llm-dungeon-replay-"));
    const statePath = path.join(root, "manifest.json");
    await writeFile(statePath, '{"turn":7}\n', "utf8");
    const secret = "secret-provider-key";
    const executionProfile = profile();
    const request: StructuredRequest<{ answer: string }> = {
      schemaName: "answer",
      schema: AnswerSchema,
      system: `Never reveal ${secret}`,
      prompt: `Return an answer; credential=${secret}`,
      maxOutputTokens: 4_000,
      generationPhase: "repair",
      repairOfPhase: "locked_resolution",
      attemptKind: "domain_repair",
      retryBackoffMs: 250,
    };
    const originalFailure = new Error("malformed response");
    const bundle = createDiagnosticBundle({
      expectedPhase: "repair",
      profile: executionProfile,
      stateSnapshot: `turn 7; credential ${secret}`,
      request,
      responseMetadata: { detail: secret },
      attribution: attributePlaytestFailure(originalFailure, { lane: "candidate" }),
      failureKind: "malformed_json",
      failureMessage: `failure near ${secret}`,
      secrets: [secret],
      now: new Date("2026-07-19T00:00:00.000Z"),
    });
    const target = path.join(root, "diagnostic.json");
    await writeDiagnosticBundle(target, bundle);
    expect(await readFile(target, "utf8")).not.toContain(secret);
    expect((await readDiagnosticBundle(target)).request).toMatchObject({
      generationPhase: "repair",
      repairOfPhase: "locked_resolution",
      attemptKind: "domain_repair",
      retryBackoffMs: 250,
    });

    const provider = new ReplayProvider();
    const result = await new FocusedReplayRunner().run(
      bundle,
      { schema: AnswerSchema },
      [DEFAULT_MODEL_EXECUTION_PROFILE_DRAFTS[0]!],
      () => provider,
      {
        costManager: new PlaytestCostManager(1),
        price: PRICE,
        scheduler: new PlaytestProviderScheduler(1, { gemini: 1 }),
        artifactsRoot: path.join(root, "replays"),
        replayId: "replay-exact-metadata",
      },
    );
    expect(result).toMatchObject({
      status: "completed",
      totalEstimatedCostUsd: 0.005,
      results: [{ success: true, response: { answer: "replayed" } }],
    });
    expect(provider.requests[0]).toMatchObject({
      schemaName: "answer",
      generationPhase: "repair",
      repairOfPhase: "locked_resolution",
      attemptKind: "domain_repair",
      retryBackoffMs: 250,
    });
    expect(await readFile(statePath, "utf8")).toBe('{"turn":7}\n');
    expect(await readFocusedReplayManifest(path.join(result.directory, "manifest.json")))
      .toMatchObject({ status: "completed", totalEstimatedCostUsd: 0.005 });
    expect(await readFile(path.join(result.directory, "attempts.jsonl"), "utf8"))
      .not.toContain("replayed");
  });

  it("does not call a provider after cancellation or when reservation exceeds the ceiling", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "llm-dungeon-replay-stop-"));
    const bundle = diagnostic();
    const cancelledProvider = new ReplayProvider();
    const controller = new AbortController();
    controller.abort();
    const cancelled = await new FocusedReplayRunner().run(
      bundle,
      { schema: AnswerSchema },
      [DEFAULT_MODEL_EXECUTION_PROFILE_DRAFTS[0]!],
      () => cancelledProvider,
      {
        costManager: new PlaytestCostManager(1),
        price: PRICE,
        scheduler: new PlaytestProviderScheduler(1),
        artifactsRoot: root,
        replayId: "cancelled",
        signal: controller.signal,
      },
    );
    expect(cancelled.status).toBe("cancelled");
    expect(cancelledProvider.calls).toBe(0);

    const limitedProvider = new ReplayProvider();
    const limited = await new FocusedReplayRunner().run(
      bundle,
      { schema: AnswerSchema },
      [DEFAULT_MODEL_EXECUTION_PROFILE_DRAFTS[0]!],
      () => limitedProvider,
      {
        costManager: new PlaytestCostManager(0.001),
        price: { inputPerMillion: 1, outputPerMillion: 1_000 },
        scheduler: new PlaytestProviderScheduler(1),
        artifactsRoot: root,
        replayId: "cost-limited",
      },
    );
    expect(limited).toMatchObject({
      status: "cost_limit",
      totalEstimatedCostUsd: 0,
      results: [{ outcome: "cost_limit", estimatedCostUsd: 0 }],
    });
    expect(limitedProvider.calls).toBe(0);
  });

  it("resumes completed evidence without repeating a paid physical call", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "llm-dungeon-replay-resume-"));
    const bundle = diagnostic();
    const firstProvider = new ReplayProvider();
    const first = await new FocusedReplayRunner().run(
      bundle,
      { schema: AnswerSchema },
      [DEFAULT_MODEL_EXECUTION_PROFILE_DRAFTS[0]!],
      () => firstProvider,
      {
        costManager: new PlaytestCostManager(1),
        price: PRICE,
        scheduler: new PlaytestProviderScheduler(1),
        artifactsRoot: root,
        replayId: "resume-safe",
      },
    );
    expect(firstProvider.calls).toBe(1);

    const resumedProvider = new ReplayProvider();
    const resumed = await new FocusedReplayRunner().run(
      bundle,
      { schema: AnswerSchema },
      [DEFAULT_MODEL_EXECUTION_PROFILE_DRAFTS[0]!],
      () => resumedProvider,
      {
        costManager: new PlaytestCostManager(1, first.totalEstimatedCostUsd),
        price: PRICE,
        scheduler: new PlaytestProviderScheduler(1),
        artifactsRoot: root,
        replayId: "resume-safe",
      },
    );
    expect(resumed).toMatchObject({
      status: "completed",
      totalEstimatedCostUsd: 0.005,
      results: [{ outcome: "success" }],
    });
    expect(resumed.results[0]).not.toHaveProperty("response");
    expect(resumedProvider.calls).toBe(0);
  });

  it("stops conservatively when a prior process may have left an unrecorded call in flight", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "llm-dungeon-replay-interrupted-"));
    const bundle = diagnostic();
    const controller = new AbortController();
    controller.abort();
    const initial = await new FocusedReplayRunner().run(
      bundle,
      { schema: AnswerSchema },
      [DEFAULT_MODEL_EXECUTION_PROFILE_DRAFTS[0]!],
      () => new ReplayProvider(),
      {
        costManager: new PlaytestCostManager(1),
        price: PRICE,
        scheduler: new PlaytestProviderScheduler(1),
        artifactsRoot: root,
        replayId: "interrupted-safe",
        signal: controller.signal,
      },
    );
    const manifestPath = path.join(initial.directory, "manifest.json");
    const rawManifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
      status: string;
      completedAt?: string;
      variants: Array<{ status: string }>;
    };
    rawManifest.status = "running";
    delete rawManifest.completedAt;
    rawManifest.variants[0]!.status = "running";
    await writeFile(manifestPath, `${JSON.stringify(rawManifest, null, 2)}\n`, "utf8");

    const provider = new ReplayProvider();
    const resumed = await new FocusedReplayRunner().run(
      bundle,
      { schema: AnswerSchema },
      [DEFAULT_MODEL_EXECUTION_PROFILE_DRAFTS[0]!],
      () => provider,
      {
        costManager: new PlaytestCostManager(1),
        price: PRICE,
        scheduler: new PlaytestProviderScheduler(1),
        artifactsRoot: root,
        replayId: "interrupted-safe",
      },
    );
    expect(resumed).toMatchObject({
      status: "interrupted",
      results: [{ outcome: "interrupted", costBasis: "unknown" }],
    });
    expect(provider.calls).toBe(0);
  });

  it("upgrades v1 bundles to their original initial-attempt replay semantics", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "llm-dungeon-replay-v1-"));
    const current = diagnostic();
    const {
      generationPhase: _generationPhase,
      repairOfPhase: _repairOfPhase,
      attemptKind: _attemptKind,
      retryBackoffMs: _retryBackoffMs,
      ...legacyRequest
    } = current.request;
    const target = path.join(root, "legacy-diagnostic.json");
    await writeFile(target, `${JSON.stringify({
      ...current,
      schemaVersion: 1,
      request: legacyRequest,
    }, null, 2)}\n`, "utf8");

    await expect(readDiagnosticBundle(target)).resolves.toMatchObject({
      schemaVersion: 2,
      request: { generationPhase: "repair", attemptKind: "initial" },
    });
  });

  it("uses the provider scheduler across independent replay IDs", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "llm-dungeon-replay-scheduled-"));
    const bundle = diagnostic();
    const scheduler = new PlaytestProviderScheduler(2, { gemini: 1 });
    const activity = { active: 0, maximum: 0 };
    const run = (replayId: string) => new FocusedReplayRunner().run(
      bundle,
      { schema: AnswerSchema },
      [DEFAULT_MODEL_EXECUTION_PROFILE_DRAFTS[0]!],
      () => new DelayedReplayProvider(activity),
      {
        costManager: new PlaytestCostManager(1),
        price: PRICE,
        scheduler,
        artifactsRoot: root,
        replayId,
      },
    );

    await Promise.all([run("scheduled-a"), run("scheduled-b")]);
    expect(activity.maximum).toBe(1);
  });
});
