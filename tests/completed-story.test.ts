import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { CampaignCatalog } from "../src/campaign-catalog.js";
import { DungeonEngine } from "../src/engine.js";
import { campaignStateRevision } from "../src/inspection.js";
import { GenerationFailure } from "../src/llm/failures.js";
import { attachStructuredFailure } from "../src/llm/structured-error.js";
import { COMPLETED_STORY_SYSTEM_PROMPT, completedStoryPromptDocument } from "../src/prompts.js";
import {
  COMPLETED_STORY_MAX_WORDS,
  COMPLETED_STORY_MIN_WORDS,
  COMPLETED_STORY_SCHEMA_VERSION,
  COMPLETED_STORY_TARGET_MAX_WORDS,
  COMPLETED_STORY_TARGET_MIN_WORDS,
  COMPLETED_STORY_TARGET_WORDS,
  CompletedStoryOutputSchema,
  completedStoryWordCount,
  type CompletedStoryArtifact,
  type GameState,
  type ProviderConfig,
} from "../src/schemas.js";
import { StateStore } from "../src/store.js";
import { BudgetedProvider } from "../src/spending.js";
import type { LlmProvider, StructuredRequest, StructuredResult } from "../src/types.js";
import { createTestStore, setupFixture } from "./helpers.js";

const providerConfig: ProviderConfig = {
  provider: "gemini",
  model: "gemini-test",
  temperature: 0.8,
  maxOutputTokens: 4_000,
};

function words(count: number): string {
  return Array.from({ length: count }, (_, index) => `word${index + 1}`).join(" ");
}

const terminalTurn = {
  kind: "resolved" as const,
  narration:
    "Arlen lays the sealed letter on the tavern hearth. Its wax curls in the flame, and he chooses a quiet life beyond the northern road.",
  turnSummary: "Arlen destroyed the letter and ended his journey.",
  operations: [
    {
      type: "end_campaign" as const,
      status: "ended" as const,
      reason: "Arlen retired after destroying the sealed letter.",
    },
  ],
};

class StoryProvider implements LlmProvider {
  readonly id = "fake";
  readonly model = "fake-model";
  readonly requests: StructuredRequest<unknown>[] = [];

  constructor(
    private readonly queue: unknown[],
    private readonly successUsage: StructuredResult<unknown>["usage"] = {
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15,
    },
  ) {}

  async generateStructured<T>(request: StructuredRequest<T>): Promise<StructuredResult<T>> {
    this.requests.push(request as StructuredRequest<unknown>);
    const next = this.queue.shift();
    if (next instanceof Error) throw next;
    return {
      data: request.schema.parse(next),
      provider: this.id,
      model: this.model,
      ...(this.successUsage ? { usage: this.successUsage } : {}),
    };
  }
}

function truncatedStoryFailure(
  rawText: string,
  usage: NonNullable<StructuredResult<unknown>["usage"]>,
): GenerationFailure {
  const failure = new GenerationFailure(
    "malformed_json",
    "Provider response was truncated before the root JSON value completed",
    true,
  );
  attachStructuredFailure(failure, {
    rawText,
    parsedResponse: null,
    usage,
    structuredMode: "exact_schema",
    attemptMetadata: {
      provider: "fake",
      model: "fake-model",
      route: "direct",
      generationPhase: "decision",
      attemptKind: "initial",
      structuredMode: "exact_schema",
      schemaProjection: "gemini_compatible_v1",
      outputTokenField: "maxOutputTokens",
      outputTokenBudget: 8_000,
      retryBackoffMs: 0,
      finishReason: "MAX_TOKENS",
      truncated: true,
    },
  });
  return failure;
}

async function temporaryDataRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "llm-dungeon-completed-story-"));
  return path.join(root, "data");
}

function artifactFor(state: GameState, story = words(450)): CompletedStoryArtifact {
  return {
    schemaVersion: COMPLETED_STORY_SCHEMA_VERSION,
    campaignId: state.campaignId,
    sourceRevision: campaignStateRevision(state),
    sourceTurn: state.turn,
    campaignStatus: state.status,
    provider: "fake",
    model: "fake-model",
    generatedAt: "2026-07-29T12:00:00.000Z",
    story,
  };
}

describe("completed campaign story", () => {
  it("preserves chronology and unresolved state for a settled active snapshot", () => {
    expect(COMPLETED_STORY_SYSTEM_PROMPT).toContain("settled single-player campaign snapshot");
    expect(COMPLETED_STORY_SYSTEM_PROMPT).toContain(
      "Preserve causal chronology and participant identity exactly",
    );
    expect(COMPLETED_STORY_SYSTEM_PROMPT).toContain(
      "Do not move a companion into an expedition they did not join",
    );
    expect(COMPLETED_STORY_SYSTEM_PROMPT).toContain(
      "turn a plan, promise, departure, transit state, or unresolved objective into completed delivery or resolution",
    );
    expect(COMPLETED_STORY_SYSTEM_PROMPT).toContain(
      "reconstruct events in their displayed turn order",
    );
    expect(COMPLETED_STORY_SYSTEM_PROMPT).toContain(
      "If source passages conflict, invent no bridge or correction",
    );
    expect(COMPLETED_STORY_SYSTEM_PROMPT).toContain(
      "If the supplied campaign status is active or any goal or thread remains unresolved",
    );
    expect(COMPLETED_STORY_SYSTEM_PROMPT).toContain(
      "without closure language that implies the campaign, mystery, rescue, journey, or delivery is finished",
    );
    expect(COMPLETED_STORY_SYSTEM_PROMPT).toContain(
      "an active record must keep its documented uncertainty and unfinished business open",
    );

    const prompt = completedStoryPromptDocument(
      "Campaign status: active. Mara remains in transit. The destination is undecided.",
      "en",
    );
    expect(prompt.text).toContain("PLAYER-VISIBLE SETTLED CAMPAIGN SNAPSHOT");
    expect(prompt.text).toContain(
      "preserving its exact chronology, companions, campaign status, and unresolved goals",
    );
  });

  it("targets one direct safety-margin draft while accepting the full public range", () => {
    expect({
      accepted: [COMPLETED_STORY_MIN_WORDS, COMPLETED_STORY_MAX_WORDS],
      target: [
        COMPLETED_STORY_TARGET_MIN_WORDS,
        COMPLETED_STORY_TARGET_WORDS,
        COMPLETED_STORY_TARGET_MAX_WORDS,
      ],
    }).toEqual({ accepted: [400, 600], target: [450, 500, 550] });
    const providerStorySchema = z.toJSONSchema(CompletedStoryOutputSchema, {
      target: "draft-7",
    }).properties?.story;
    expect(providerStorySchema?.description).toContain(
      "accepted length is 400-600 whitespace-delimited words",
    );
    expect(providerStorySchema?.description).toContain("one direct draft of about 500 words");
    expect(providerStorySchema?.description).toContain("targeting 450-550 words");
    expect(providerStorySchema?.description).not.toContain("privately count");
    expect(COMPLETED_STORY_SYSTEM_PROMPT).toContain(
      "The accepted contract is 400-600 whitespace-delimited words",
    );
    expect(COMPLETED_STORY_SYSTEM_PROMPT).toContain("one direct draft of about 500 words");
    expect(COMPLETED_STORY_SYSTEM_PROMPT).toContain(
      "targeting 450-550 words so it remains safely inside the accepted range",
    );
    expect(COMPLETED_STORY_SYSTEM_PROMPT).toContain("Write one direct draft");
    expect(COMPLETED_STORY_SYSTEM_PROMPT).not.toContain("privately count");
    expect(COMPLETED_STORY_SYSTEM_PROMPT).not.toContain("revise it until");

    const prompt = completedStoryPromptDocument("Campaign status: ended.", "en");
    expect(prompt.text).toContain("accepted 400-600-word range");
    expect(prompt.text).toContain("one direct draft of about 500 words");
    expect(prompt.text).toContain("targeting 450-550 words as a safety margin");
    expect(prompt.text).not.toContain("privately count");
    expect(prompt.text).not.toContain("revise it until");

    expect(CompletedStoryOutputSchema.safeParse({ story: words(400) }).success).toBe(true);
    expect(CompletedStoryOutputSchema.safeParse({ story: words(600) }).success).toBe(true);
  });

  it("uses one separate post-terminal call and persists only player-safe snapshot prose", async () => {
    const store = await createTestStore();
    const provider = new StoryProvider([terminalTurn, { story: words(450) }]);
    const result = await new DungeonEngine(store, provider).play("I burn the letter and retire.");

    expect(result.state).toMatchObject({ turn: 1, status: "ended" });
    expect(provider.requests.map((request) => request.schemaName)).toEqual([
      "turn_decision_v3",
      "completed_campaign_story_v1",
    ]);
    const storyRequest = provider.requests[1]!;
    expect(storyRequest).toMatchObject({
      generationPhase: "decision",
      maxOutputTokens: 8_000,
      outputTokenCeiling: 8_000,
    });
    expect(storyRequest.prompt).toContain("I burn the letter and retire.");
    expect(storyRequest.prompt).toContain("Arlen lays the sealed letter on the tavern hearth");
    expect(storyRequest.prompt).not.toContain("Mara suspects the watch captain takes bribes");
    expect(storyRequest.prompt).not.toContain("## State Operations");
    expect(storyRequest.prompt).not.toContain("npc:mara-venn");

    const artifact = await store.completedStory();
    const finalManifest = (await store.load()).manifest;
    expect(artifact).toMatchObject({
      schemaVersion: COMPLETED_STORY_SCHEMA_VERSION,
      campaignId: finalManifest.campaignId,
      sourceRevision: campaignStateRevision(finalManifest),
      sourceTurn: 1,
      campaignStatus: "ended",
      provider: "fake",
      model: "fake-model",
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    });
    expect(completedStoryWordCount(artifact!.story)).toBe(450);
    expect((await store.campaignLogSnapshot()).completedStory).toEqual(artifact);
    expect((await store.recentTranscript()).map((turn) => turn.turn)).toEqual([0, 1]);
    expect(await store.campaignCost()).toMatchObject({ unpricedTurns: 3 });
    expect(await store.getPending()).toBeUndefined();
    expect(await readFile(store.completedStoryPath, "utf8")).toContain(
      "# Completed Campaign Story",
    );
  });

  it("releases the logical-turn envelope before reserving the terminal story", async () => {
    const store = await createTestStore();
    await store.updateCampaignBudget({ campaignUsd: 1.001, logicalTurnUsd: 1 });
    const base = new StoryProvider([terminalTurn, { story: words(450) }]);
    const provider = new BudgetedProvider(base, store.spendingController(), {
      price: { inputPerMillion: 1, outputPerMillion: 1 },
    });

    const result = await new DungeonEngine(store, provider).play(
      "I burn the letter and retire under a tightly reserved campaign cap.",
    );

    expect(result.state.status).toBe("ended");
    expect(await store.completedStory()).toMatchObject({ story: words(450) });
    expect(base.requests.map((request) => request.schemaName)).toEqual([
      "turn_decision_v3",
      "completed_campaign_story_v1",
    ]);
    expect(await store.campaignBudget()).toMatchObject({
      reservedUsd: 0,
      settledAttempts: 2,
      paused: false,
    });
  });

  it.each(["network", "content_block"] as const)(
    "keeps a terminal commit after a failed %s story call and retries with one fresh call",
    async (failureKind) => {
      const store = await createTestStore();
      const provider = new StoryProvider([
        terminalTurn,
        new GenerationFailure(
          failureKind,
          `story ${failureKind} failure`,
          failureKind === "network",
        ),
        { story: words(500) },
      ]);
      const engine = new DungeonEngine(store, provider);

      const result = await engine.play("I burn the letter and retire.");
      expect(result.state).toMatchObject({ turn: 1, status: "ended" });
      expect(provider.requests).toHaveLength(2);
      expect(await engine.completedStory()).toBeUndefined();
      const manifestBeforeRetry = await readFile(
        path.join(store.currentDir, "manifest.json"),
        "utf8",
      );
      const transcriptBeforeRetry = await store.recentTranscript();

      const artifact = await engine.generateCompletedStory();

      expect(completedStoryWordCount(artifact.story)).toBe(500);
      expect(
        provider.requests.filter((request) => request.schemaName === "completed_campaign_story_v1"),
      ).toHaveLength(2);
      expect(provider.requests).toHaveLength(3);
      expect(await readFile(path.join(store.currentDir, "manifest.json"), "utf8")).toBe(
        manifestBeforeRetry,
      );
      expect(await store.recentTranscript()).toEqual(transcriptBeforeRetry);
      expect((await store.load()).manifest).toMatchObject({ turn: 1, status: "ended" });
    },
  );

  it("rejects out-of-range prose locally and never performs an automatic repair call", async () => {
    expect(CompletedStoryOutputSchema.safeParse({ story: words(399) }).success).toBe(false);
    expect(CompletedStoryOutputSchema.safeParse({ story: words(400) }).success).toBe(true);
    expect(CompletedStoryOutputSchema.safeParse({ story: words(600) }).success).toBe(true);
    expect(CompletedStoryOutputSchema.safeParse({ story: words(601) }).success).toBe(false);

    const store = await createTestStore();
    const provider = new StoryProvider([
      terminalTurn,
      { story: words(399) },
      { story: words(400) },
    ]);
    const engine = new DungeonEngine(store, provider);
    await engine.play("I burn the letter and retire.");

    expect(provider.requests).toHaveLength(2);
    expect(await engine.completedStory()).toBeUndefined();
    await expect(engine.generateCompletedStory()).resolves.toMatchObject({ story: words(400) });
    expect(provider.requests.map((request) => request.schemaName)).toEqual([
      "turn_decision_v3",
      "completed_campaign_story_v1",
      "completed_campaign_story_v1",
    ]);
  });

  it("retries one explicitly truncated story with a fresh request and combines usage", async () => {
    const failedRawText = '{"story":"PARTIAL_OUTPUT_MUST_NOT_ENTER_THE_RETRY';
    const firstUsage = {
      inputTokens: 31,
      outputTokens: 7_983,
      totalTokens: 8_014,
      billedCostUsd: 0.04,
    };
    const secondUsage = {
      inputTokens: 29,
      outputTokens: 517,
      totalTokens: 546,
      billedCostUsd: 0.02,
    };
    const store = await createTestStore();
    const provider = new StoryProvider(
      [truncatedStoryFailure(failedRawText, firstUsage), { story: words(500) }],
      secondUsage,
    );

    const artifact = await new DungeonEngine(store, provider).generateCompletedStory({
      settledSnapshot: true,
    });

    expect(provider.requests).toHaveLength(2);
    expect(provider.requests.map((request) => request.schemaName)).toEqual([
      "completed_campaign_story_v1",
      "completed_campaign_story_v1",
    ]);
    expect(provider.requests[1]?.prompt).toBe(provider.requests[0]?.prompt);
    expect(provider.requests[1]?.prompt).not.toContain("PARTIAL_OUTPUT_MUST_NOT_ENTER_THE_RETRY");
    expect(artifact).toMatchObject({
      story: words(500),
      usage: {
        inputTokens: 60,
        outputTokens: 8_500,
        totalTokens: 8_560,
      },
    });
    expect(artifact.usage?.billedCostUsd).toBeCloseTo(0.06);
  });

  it("bounds an explicitly truncated story retry to one fresh second attempt", async () => {
    const usage = { inputTokens: 10, outputTokens: 8_000, totalTokens: 8_010 };
    const store = await createTestStore();
    const provider = new StoryProvider([
      truncatedStoryFailure('{"story":"first partial', usage),
      truncatedStoryFailure('{"story":"second partial', usage),
      { story: words(500) },
    ]);

    await expect(
      new DungeonEngine(store, provider).generateCompletedStory({ settledSnapshot: true }),
    ).rejects.toThrow(/truncated/i);
    expect(provider.requests).toHaveLength(2);
    expect(await store.completedStory()).toBeUndefined();
  });

  it("requires an explicit settled-snapshot assertion for active finalized games", async () => {
    const store = await createTestStore();
    const observingStore = new StateStore(store.dataRoot);
    const provider = new StoryProvider([{ story: words(450) }]);
    const engine = new DungeonEngine(store, provider);

    expect(await store.campaignCost()).toMatchObject({ unpricedTurns: 1 });
    expect(await observingStore.campaignCost()).toMatchObject({ unpricedTurns: 1 });
    await expect(engine.generateCompletedStory()).rejects.toThrow(/still active.*settledSnapshot/i);
    expect(provider.requests).toHaveLength(0);
    const generated = await engine.generateCompletedStory({ settledSnapshot: true });
    expect(generated).toMatchObject({ campaignStatus: "active", sourceTurn: 0 });
    expect(provider.requests).toHaveLength(1);
    await expect(engine.generateCompletedStory({ settledSnapshot: true })).resolves.toEqual(
      generated,
    );
    expect(provider.requests).toHaveLength(1);
    expect(await store.campaignCost()).toMatchObject({ unpricedTurns: 2 });
    expect(await observingStore.campaignCost()).toMatchObject({ unpricedTurns: 2 });
  });

  it("does not attach a stale artifact after the source revision advances", async () => {
    const store = await createTestStore();
    const provider = new StoryProvider([{ story: words(450) }, { story: words(475) }]);
    const engine = new DungeonEngine(store, provider);
    const first = await engine.generateCompletedStory({ settledSnapshot: true });
    expect(first.sourceTurn).toBe(0);

    await store.commitTurn({
      action: "I reconsider and remain for one more evening.",
      resolved: {
        narration: "Arlen remains beside the hearth for one more quiet evening.",
        turnSummary: "Arlen postponed his departure for an evening.",
        operations: [],
      },
      provider: "fake",
      model: "fake-model",
    });

    expect(await store.completedStory()).toBeUndefined();
    expect((await store.campaignLogSnapshot()).completedStory).toBeUndefined();
    const replacement = await engine.generateCompletedStory({ settledSnapshot: true });
    expect(replacement).toMatchObject({ sourceTurn: 1, story: words(475) });
    expect(replacement.sourceRevision).not.toBe(first.sourceRevision);
    expect(provider.requests).toHaveLength(2);
  });

  it("keeps automatic generation optional for playtest telemetry and explicit afterward", async () => {
    const store = await createTestStore();
    const provider = new StoryProvider([terminalTurn, { story: words(450) }]);
    const engine = new DungeonEngine(store, provider, undefined, {
      automaticCompletedStory: false,
    });

    await engine.play("I burn the letter and retire.");
    expect(provider.requests.map((request) => request.schemaName)).toEqual(["turn_decision_v3"]);
    expect(await engine.completedStory()).toBeUndefined();
    await engine.generateCompletedStory();
    expect(provider.requests.map((request) => request.schemaName)).toEqual([
      "turn_decision_v3",
      "completed_campaign_story_v1",
    ]);
  });

  it("keeps a representative one-hundred-turn autoplay story input within the fixed budget", async () => {
    const store = await createTestStore();
    for (let turn = 1; turn <= 100; turn += 1) {
      await store.commitTurn({
        action: `I follow documented lead ${turn} while preserving earlier evidence.`,
        resolved: {
          narration: `Arlen follows lead ${turn}, compares it with the road journal, and returns with a concrete but nonterminal result.`,
          turnSummary: `Lead ${turn} was investigated and its nonterminal result was recorded for the continuing journey.`,
          operations: [],
        },
        provider: "fake",
        model: "fake-model",
      });
    }
    const provider = new StoryProvider([{ story: words(450) }]);
    const artifact = await new DungeonEngine(store, provider).generateCompletedStory({
      settledSnapshot: true,
    });

    expect(artifact.sourceTurn).toBe(100);
    expect(provider.requests).toHaveLength(1);
    expect(provider.requests[0]?.schemaName).toBe("completed_campaign_story_v1");
    expect(provider.requests[0]?.prompt).toContain("Lead 1 was investigated");
    expect(provider.requests[0]?.prompt).toContain("Lead 100 was investigated");
    // One hundred sequential commits to a real temporary store take well under a
    // second alone, but the default five is wall clock and this file runs beside
    // sixty others. The assertions above are about what survives the budget, not
    // about speed, so a contention timeout was only ever a false failure.
  }, 30_000);

  it("allows an archived read-only campaign to retry only the independent artifact", async () => {
    const dataRoot = await temporaryDataRoot();
    const catalog = new CampaignCatalog(dataRoot, { defaultProviderConfig: providerConfig });
    const created = await catalog.createCampaign({
      setup: structuredClone(setupFixture),
      worldRules: "Classic fantasy test rules.",
    });
    await catalog.archiveCampaign(created.campaignId);
    const archivedStore = await catalog.readCampaign(created.campaignId);
    const engine = new DungeonEngine(archivedStore, new StoryProvider([{ story: words(450) }]));

    await expect(archivedStore.setTitle("Forbidden change")).rejects.toThrow(/read-only/i);
    await expect(engine.generateCompletedStory({ settledSnapshot: true })).resolves.toMatchObject({
      campaignId: created.campaignId,
      campaignStatus: "active",
    });
    expect(await archivedStore.completedStory()).toBeDefined();
    expect((await archivedStore.load()).manifest).toEqual(created.state);
  });

  it("copies an existing artifact when an autoplay snapshot is published", async () => {
    const dataRoot = await temporaryDataRoot();
    const sourceRoot = path.join(path.dirname(dataRoot), "playtest-source");
    const source = new StateStore(sourceRoot);
    const state = await source.createGame({
      setup: structuredClone(setupFixture),
      worldRules: "Autoplay rules.",
    });
    const artifact = await source.saveCompletedStory(artifactFor(state));
    const catalog = new CampaignCatalog(dataRoot, { defaultProviderConfig: providerConfig });

    const published = await catalog.publishArchivedCampaign(sourceRoot, {
      source: {
        kind: "autoplay",
        runId: "story-run",
        jobId: "job-story",
        packageId: "campaign-autoplay-v1",
        packageVersion: 1,
      },
      tags: ["Autoplay"],
      providerConfig,
    });

    expect(published.archived).toBe(true);
    expect(await (await catalog.readCampaign(published.campaignId)).completedStory()).toEqual(
      artifact,
    );
  });
});
