import { describe, expect, it } from "vitest";
import { DungeonEngine } from "../src/engine.js";
import { GenerationFailure } from "../src/llm/failures.js";
import { NEW_CAMPAIGN_IMMUTABLE_CONTEXT_LIMITS } from "../src/store.js";
import { playerTurnResponse } from "../src/web/presentation.js";
import type { LlmProvider, StructuredRequest, StructuredResult } from "../src/types.js";
import { createTestStore, setupFixture } from "./helpers.js";

class FakeProvider implements LlmProvider {
  readonly id = "fake";
  readonly model = "fake-model";
  calls = 0;
  requests: StructuredRequest<unknown>[] = [];

  constructor(private readonly queue: unknown[]) {}

  async generateStructured<T>(request: StructuredRequest<T>): Promise<StructuredResult<T>> {
    this.calls += 1;
    this.requests.push(request as StructuredRequest<unknown>);
    const value = this.queue.shift();
    if (value instanceof Error) throw value;
    return { data: request.schema.parse(value), provider: this.id, model: this.model };
  }
}

const resolved = {
  kind: "resolved" as const,
  narration: "The innkeeper nods and returns to her work.",
  turnSummary: "The hero greeted Mara.",
  operations: [],
};

describe("turn engine", () => {
  it("retries one structurally incomplete setup response", async () => {
    const store = await createTestStore();
    const provider = new FakeProvider([{}, setupFixture]);
    const setup = await new DungeonEngine(store, provider).generateSetup({
      worldRules: "Classic fantasy.",
      premise: "A tavern opening.",
      character: "A scout.",
    });
    expect({ ...setup, threads: setupFixture.threads }).toEqual(setupFixture);
    expect(setup.threads[0]?.id).toMatch(/^thread:/);
    expect(provider.calls).toBe(2);
    expect(provider.requests[0]?.maxOutputTokens).toBe(8_000);
    expect(provider.requests[1]?.maxOutputTokens).toBe(8_000);
    expect(provider.requests[1]?.schemaName).toBe("repair_campaign_setup");
    expect(
      provider.requests.map((request) => ({
        phase: request.generationPhase,
        repairOf: request.repairOfPhase,
        kind: request.attemptKind,
      })),
    ).toEqual([
      { phase: "setup", repairOf: undefined, kind: "initial" },
      { phase: "repair", repairOf: "setup", kind: "schema_repair" },
    ]);
  });

  it("repairs an empty optional setup location by requiring the key to be omitted", async () => {
    const store = await createTestStore();
    const invalid = structuredClone(setupFixture);
    invalid.entities.find((entity) => entity.id === "location:crooked-crown")!.location = "";
    const provider = new FakeProvider([invalid, setupFixture]);

    await new DungeonEngine(store, provider).generateSetup({
      worldRules: "Classic fantasy.",
      premise: "A tavern opening.",
      character: "A scout.",
    });

    expect(provider.calls).toBe(2);
    expect(provider.requests[1]?.schemaName).toBe("repair_campaign_setup");
    expect(provider.requests[1]?.prompt).toContain("remove that entire optional key");
    expect(provider.requests[1]?.prompt).toContain(
      'Never use "" or null as an optional-reference placeholder',
    );
  });

  it("instructs setup generation to produce Russian player-facing content", async () => {
    const store = await createTestStore();
    const provider = new FakeProvider([setupFixture]);
    await new DungeonEngine(store, provider).generateSetup({
      worldRules: "Classic fantasy.",
      premise: "A tavern opening.",
      character: "A scout.",
      language: "ru",
    });
    expect(provider.requests[0]?.prompt).toContain("natural Russian");
    expect(provider.requests[0]?.prompt).toContain("small spendable currency inventory item");
  });

  it("uses the documented campaign defaults when optional guidance is blank", async () => {
    const store = await createTestStore();
    const provider = new FakeProvider([setupFixture]);
    await new DungeonEngine(store, provider).generateSetup({
      worldRules: "Classic fantasy.",
      premise: "  ",
      character: "",
    });

    expect(provider.requests[0]?.prompt).toContain(
      "PREMISE: A classical opening in a tavern, with immediate but optional possibilities.",
    );
    expect(provider.requests[0]?.prompt).toContain(
      "CHARACTER: Create a grounded adventurer with two useful traits and one complicating trait.",
    );
  });

  it("corrects a structurally valid setup with broken world references", async () => {
    const store = await createTestStore();
    const invalid = structuredClone(setupFixture);
    invalid.entities.find((entity) => entity.id === "item:travel-sword")!.location = "player:hero";
    const provider = new FakeProvider([invalid, setupFixture]);
    const setup = await new DungeonEngine(store, provider).generateSetup({
      worldRules: "Classic fantasy.",
      premise: "A tavern opening.",
      character: "A scout.",
    });

    expect({ ...setup, threads: setupFixture.threads }).toEqual(setupFixture);
    expect(setup.threads[0]?.id).toMatch(/^thread:/);
    expect(provider.calls).toBe(2);
  });

  it("schema-repairs an oversized setup produced by the one domain correction", async () => {
    const store = await createTestStore();
    const danglingInventory = structuredClone(setupFixture);
    danglingInventory.player.inventory.push(
      { entityId: "item:omitted-rope", quantity: 1 },
      { entityId: "item:omitted-rations", quantity: 1 },
    );
    const oversizedCorrection = structuredClone(setupFixture);
    oversizedCorrection.scenarioMarkdown = "s".repeat(
      NEW_CAMPAIGN_IMMUTABLE_CONTEXT_LIMITS.scenario + 1,
    );
    const provider = new FakeProvider([danglingInventory, oversizedCorrection, setupFixture]);
    const input = {
      worldRules: "Classic fantasy.",
      premise: "A tavern opening.",
      character: "A scout.",
    };
    const engine = new DungeonEngine(store, provider);

    const setup = await engine.generateSetup(input);

    expect(provider.requests.map((request) => request.schemaName)).toEqual([
      "campaign_setup",
      "domain_repair_campaign_setup",
      "repair_domain_repair_campaign_setup",
    ]);
    expect(provider.requests.map((request) => request.attemptKind)).toEqual([
      "initial",
      "domain_repair",
      "schema_repair",
    ]);
    expect(provider.requests[1]?.prompt).toContain(
      "Initial inventory item item:omitted-rope does not exist",
    );
    expect(provider.requests[2]?.prompt).toContain(
      `Generated campaign scenario requires ${(
        NEW_CAMPAIGN_IMMUTABLE_CONTEXT_LIMITS.scenario + 1
      ).toLocaleString("en-US")} conservative context units`,
    );
    expect(setup.scenarioMarkdown).toBe(setupFixture.scenarioMarkdown);

    await engine.replaceGame({
      setup,
      worldRules: input.worldRules,
      language: "en",
      setupInput: { premise: input.premise, character: input.character },
    });
    expect((await store.load()).manifest.title).toBe(setupFixture.campaignTitle);
  });

  it("corrects an initial location that contains itself", async () => {
    const store = await createTestStore();
    const invalid = structuredClone(setupFixture);
    invalid.entities.find((entity) => entity.id === "location:crooked-crown")!.location =
      "location:crooked-crown";
    const provider = new FakeProvider([invalid, setupFixture]);
    const setup = await new DungeonEngine(store, provider).generateSetup({
      worldRules: "Classic fantasy.",
      premise: "A tavern opening.",
      character: "A scout.",
    });

    expect(provider.calls).toBe(2);
    expect(provider.requests[1]?.schemaName).toBe("domain_repair_campaign_setup");
    expect(provider.requests[1]).toMatchObject({
      generationPhase: "repair",
      repairOfPhase: "setup",
      attemptKind: "domain_repair",
      domainRepairCause: {
        validationStage: "setup",
        errorName: "Error",
      },
    });
    // Redaction comes from the rule declarations, so both violated rules stay
    // identifiable without any pattern branch for either message.
    expect(provider.requests[1]?.domainRepairCause?.errorMessage).toContain(
      "[setup_self_containment] An initial entity was placed inside itself",
    );
    expect(provider.requests[1]?.domainRepairCause?.errorMessage).toContain(
      "[setup_location_hierarchy_cycle] Initial location containment formed a cycle",
    );
    expect(provider.requests[1]?.domainRepairCause?.logicalOperationId).toMatch(/^[0-9a-f-]{36}$/u);
    expect(provider.requests[1]?.domainRepairCause?.errorFingerprint).toMatch(/^[a-f0-9]{64}$/u);
    expect(provider.requests[1]?.domainRepairCause?.errorMessage).not.toContain(
      "location:crooked-crown",
    );
    expect(provider.requests[1]?.prompt).toContain("cannot be located inside itself");
    const startingLocation = setup.entities.find((entity) => entity.id === setup.player.location);
    expect(startingLocation?.location).toBeUndefined();
  });

  it("repairs a setup that encodes mutable current state as an entity tag", async () => {
    const store = await createTestStore();
    const invalid = structuredClone(setupFixture);
    invalid.entities.find((entity) => entity.id === "npc:mara-venn")!.tags = ["armed"];
    const provider = new FakeProvider([invalid, setupFixture]);

    await new DungeonEngine(store, provider).generateSetup({
      worldRules: "Classic fantasy.",
      premise: "A tavern opening.",
      character: "A scout.",
    });

    expect(provider.calls).toBe(2);
    expect(provider.requests[1]?.prompt).toContain(
      'Initial entity npc:mara-venn uses reserved mutable-state tag "armed"',
    );
    expect(provider.requests[1]?.domainRepairCause?.errorMessage).toContain(
      "A new tag encoded mutable or epistemic state",
    );
    expect(provider.requests[1]?.domainRepairCause?.errorMessage).not.toContain("npc:mara-venn");
    expect(provider.requests[1]?.domainRepairCause?.errorMessage).not.toContain("armed");
  });

  it("uses one call for a turn without a check", async () => {
    const store = await createTestStore();
    const provider = new FakeProvider([resolved]);
    const result = await new DungeonEngine(store, provider, () => 50).play("I greet Mara.");
    expect(provider.calls).toBe(1);
    expect(result.turn).toBe(1);
    expect(result.check).toBeUndefined();
    expect(playerTurnResponse(result)).toMatchObject({ checkText: null });
    expect(provider.requests[0]?.generationPhase).toBe("decision");
  });

  it("commits one turn after one bounded content-safe recovery", async () => {
    const store = await createTestStore();
    const provider = new FakeProvider([
      new GenerationFailure("content_block", "blocked fictional output", false),
      resolved,
    ]);

    const result = await new DungeonEngine(store, provider, () => 50).play(
      "I bypass the fictional airlock relay.",
    );

    expect(result.turn).toBe(1);
    expect(provider.calls).toBe(2);
    expect(provider.requests.map((request) => request.attemptKind)).toEqual([
      "initial",
      "content_repair",
    ]);
    expect(provider.requests[1]?.prompt).toContain("I bypass the fictional airlock relay.");
    expect(provider.requests[1]?.prompt).toContain("outcome-focused, non-procedural level");
    expect(await store.getPending()).toBeUndefined();
    expect((await store.load()).manifest.turn).toBe(1);
  });

  it.each([
    ["automatic_success" as const, "success" as const, "The captive is already restrained."],
    ["automatic_failure" as const, "failure" as const, "The stone wall has no opening."],
  ])(
    "commits %s without rolling and preserves its player-visible reason",
    async (kind, outcome, reason) => {
      const store = await createTestStore();
      const provider = new FakeProvider([
        {
          kind,
          reason,
          narration:
            kind === "automatic_success" ? "You secure the captive." : "The wall does not yield.",
          turnSummary: "The certain outcome was resolved.",
          operations: [],
        },
      ]);
      let rolls = 0;
      const result = await new DungeonEngine(store, provider, () => {
        rolls += 1;
        return 50;
      }).play("I attempt it.");

      expect(provider.calls).toBe(1);
      expect(rolls).toBe(0);
      expect(result.check).toBeUndefined();
      expect(result.automaticOutcome).toEqual({ outcome, reason });
      expect(playerTurnResponse(result)).toMatchObject({
        checkText: `${outcome === "success" ? "AUTOMATIC SUCCESS" : "AUTOMATIC FAILURE"} — ${reason}`,
      });
      expect((await store.recentTranscript()).at(-1)?.checkText).toContain(
        outcome === "success" ? "AUTOMATIC SUCCESS" : "AUTOMATIC FAILURE",
      );
      expect((await store.recentTranscript()).at(-1)?.checkText).toContain(reason);
    },
  );

  it("answers an explicit question without rolling, persisting, or advancing a turn", async () => {
    const store = await createTestStore();
    const provider = new FakeProvider([
      { answer: "You can attempt one primary action while under immediate pressure." },
    ]);
    let rolls = 0;
    const engine = new DungeonEngine(store, provider, () => {
      rolls += 1;
      return 50;
    });
    const before = await store.load();
    const beforeTranscript = await store.recentTranscript();

    const result = await engine.ask("Can I attack three enemies and protect myself in one turn?");

    expect(result).toEqual({
      kind: "question",
      answer: "You can attempt one primary action while under immediate pressure.",
      generation: { provider: "fake", model: "fake-model" },
    });
    expect(rolls).toBe(0);
    expect(provider.requests).toHaveLength(1);
    expect(provider.requests[0]?.schemaName).toBe("campaign_question");
    expect(provider.requests[0]?.system).toContain("This is not a gameplay turn");
    expect(provider.requests[0]?.system).toContain("Never reveal DM-only secrets");
    expect(provider.requests[0]?.prompt).toContain("PLAYER QUESTION — UNTRUSTED");
    expect((await store.load()).manifest).toEqual(before.manifest);
    expect(await store.recentTranscript()).toEqual(beforeTranscript);
    expect(await store.getPending()).toBeUndefined();
  });

  it("repairs an unambiguous omitted thread namespace before committing", async () => {
    const store = await createTestStore();
    const thread = (await store.load()).threads[0]!;
    const threadSuffix = thread.id.slice(thread.id.indexOf(":") + 1);
    const provider = new FakeProvider([
      {
        kind: "resolved",
        narration: "Mara adds a fresh detail about the northern road.",
        turnSummary: "The northern-road lead advanced.",
        operations: [
          {
            type: "update_thread",
            threadId: threadSuffix,
            summary: "Mara supplied a fresh detail.",
          },
        ],
      },
    ]);

    const result = await new DungeonEngine(store, provider).play(
      "Ask Mara about the northern road.",
    );
    expect(provider.calls).toBe(1);
    expect(result.operations[0]).toMatchObject({ type: "update_thread", threadId: thread.id });
    expect((await store.load()).threads[0]?.summary).toBe("Mara supplied a fresh detail.");
  });

  it("domain-repairs bracket display delimiters instead of silently accepting them as ID text", async () => {
    const store = await createTestStore();
    const thread = (await store.load()).threads[0]!;
    const response = (threadId: string) => ({
      kind: "resolved",
      narration: "Mara adds a fresh detail about the northern road.",
      turnSummary: "The northern-road lead advanced.",
      operations: [
        {
          type: "update_thread",
          threadId,
          summary: "Mara supplied a fresh detail.",
        },
      ],
    });
    const provider = new FakeProvider([response(`[${thread.id}]`), response(thread.id)]);

    const result = await new DungeonEngine(store, provider).play(
      "Ask Mara about the northern road.",
    );

    expect(provider.calls).toBe(2);
    expect(provider.requests[1]).toMatchObject({
      generationPhase: "repair",
      attemptKind: "domain_repair",
      domainRepairCause: {
        validationStage: "turn_commit",
        errorName: "TransactionValidationError",
        // Redacted from the rule declaration, not from the rendered message.
        errorMessage:
          // The closed-vocabulary classification survives redaction, so a
          // bracket slip stays distinguishable from an invented ID without ever
          // persisting the rejected response.
          "[unknown_thread_reference] An effect referenced a thread that does not exist (stem_shared)",
      },
    });
    expect(provider.requests[1]?.domainRepairCause?.logicalOperationId).toMatch(/^[0-9a-f-]{36}$/u);
    expect(provider.requests[1]?.domainRepairCause?.errorFingerprint).toMatch(/^[a-f0-9]{64}$/u);
    expect(provider.requests[1]?.domainRepairCause?.errorMessage).not.toContain(thread.id);
    expect(provider.requests[1]?.prompt).toContain(`Unknown thread reference [${thread.id}]`);
    expect(provider.requests[1]?.prompt).toContain(
      "AUTHORITATIVE EXISTING THREAD IDS — CLOSED SET",
    );
    expect(provider.requests[1]?.prompt).toContain(`- ${thread.id}`);
    expect(provider.requests[1]?.prompt).not.toContain("thread:the-empty-colony-turn-0");
    expect(result.turn).toBe(1);
    expect(result.operations[0]).toMatchObject({ type: "update_thread", threadId: thread.id });
    expect((await store.load()).threads[0]?.summary).toBe("Mara supplied a fresh detail.");
  });

  it("domain-repairs a generated setup that misses application-owned seed structure", async () => {
    const store = await createTestStore();
    const corrected = structuredClone(setupFixture);
    corrected.threads[0]!.relatedEntityIds = ["npc:mara-venn"];
    const provider = new FakeProvider([setupFixture, corrected]);

    const setup = await new DungeonEngine(store, provider).generateSetup({
      worldRules: "Classic fantasy.",
      premise: "A tavern opening.",
      character: "A scout.",
      setupRequirements: {
        schemaVersion: 1,
        entities: [
          {
            id: "npc:mara-venn",
            kinds: ["person"],
            purpose: "the named innkeeper",
            minimumTraits: 0,
            mustHaveCustody: false,
            mustHaveLocation: true,
            mustHavePlacement: false,
          },
        ],
        locationParents: [],
        inventory: [{ ownerId: "player:hero", itemId: "item:travel-sword" }],
        threadLinks: [{ label: "Northern road", relatedEntityIds: ["npc:mara-venn"] }],
      },
    });

    expect(provider.calls).toBe(2);
    expect(provider.requests[0]?.prompt).toContain("APPLICATION-ENFORCED SEED STRUCTURE");
    expect(provider.requests[0]?.prompt).toContain("npc:mara-venn");
    expect(provider.requests[1]?.schemaName).toBe("domain_repair_campaign_setup");
    expect(provider.requests[1]?.prompt).toContain("Seed setup requirements failed");
    expect(setup.threads[0]?.relatedEntityIds).toEqual(["npc:mara-venn"]);
  });

  it("corrects one structurally invalid turn response before committing", async () => {
    const store = await createTestStore();
    const provider = new FakeProvider([[], resolved]);
    const result = await new DungeonEngine(store, provider).play("I greet Mara.");
    expect(provider.calls).toBe(2);
    expect(provider.requests[1]?.schemaName).toBe("repair_turn_decision_v3");
    expect(result.turn).toBe(1);
  });

  it("deterministically reuses an existing location instead of spending a correction call", async () => {
    const store = await createTestStore();
    await store.commitTurn({
      action: "The northern road already exists beyond the tavern.",
      resolved: {
        narration: "The northern road lies beyond the tavern.",
        turnSummary: "The northern road was established.",
        operations: [
          {
            type: "create_entity",
            entity: {
              id: "location:northern-road",
              kind: "location",
              name: "Northern Road",
              status: "open",
              tags: ["road"],
              description: "A road leading north.",
              establishedFacts: [],
              secrets: [],
              playerKnowledge: [],
            },
          },
        ],
      },
      provider: "fake",
      model: "fake-model",
    });
    const existingRoad = [...(await store.load()).entities.values()].find(
      (entity) => entity.name === "Northern Road",
    )!;
    const provider = new FakeProvider([
      {
        kind: "resolved",
        narration: "You step onto the existing northern road.",
        turnSummary: "The hero reached the northern road.",
        operations: [
          {
            type: "create_entity",
            entity: {
              id: "location:model-road",
              kind: "location",
              name: "The Northern Road",
              status: "rainy",
              tags: [],
              description: "A redundant description.",
              establishedFacts: [],
              secrets: [],
              playerKnowledge: [],
            },
          },
          { type: "move_entity", targetId: "player:hero", locationId: "location:model-road" },
        ],
      },
    ]);

    const result = await new DungeonEngine(store, provider).play("I leave for the northern road.");
    expect(provider.calls).toBe(1);
    expect(result.state.currentLocationId).toBe(existingRoad.id);
    const locations = [...(await store.load()).entities.values()].filter(
      (entity) => entity.kind === "location" && entity.name.includes("Northern Road"),
    );
    expect(locations).toHaveLength(1);
  });

  it("normalizes an idempotent move without spending a corrective call", async () => {
    const store = await createTestStore();
    const provider = new FakeProvider([
      {
        kind: "resolved",
        narration: "You remain at the Crooked Crown's bar while Mara waits nearby.",
        turnSummary: "Arlen remained at the tavern bar.",
        operations: [
          { type: "move_entity", targetId: "player:hero", locationId: "location:crooked-crown" },
        ],
      },
    ]);
    const result = await new DungeonEngine(store, provider).play("I remain at the bar for now.");
    expect(provider.calls).toBe(1);
    expect(result.state.currentLocationId).toBe("location:crooked-crown");
    expect(result.operations).toEqual([]);
  });

  it("does not block a turn based on prose-only acquisition analysis", async () => {
    const store = await createTestStore();
    const provider = new FakeProvider([
      {
        kind: "resolved",
        narration:
          "Mara wraps trail rations in oilskin, and you tuck the parcel securely into your pack.",
        turnSummary: "Arlen bought and packed trail rations.",
        operations: [],
      },
    ]);
    const result = await new DungeonEngine(store, provider).play("I buy trail rations from Mara.");
    expect(provider.calls).toBe(1);
    expect(result.turn).toBe(1);
  });

  it("does not mistake an NPC arrival or taking out owned gear for player state changes", async () => {
    const store = await createTestStore();
    const provider = new FakeProvider([
      {
        kind: "resolved",
        narration:
          "You slip your travel sword from your satchel as someone shouts that the watch has arrived at the door.",
        turnSummary: "Arlen readied his owned sword while the watch arrived outside.",
        operations: [],
      },
    ]);
    const result = await new DungeonEngine(store, provider).play(
      "I take my travel sword from my satchel and ready it.",
    );
    expect(provider.calls).toBe(1);
    expect(result.turn).toBe(1);
  });

  it("makes inventory authority, graceful nonsense handling, and lethal limits explicit", async () => {
    const store = await createTestStore();
    const provider = new FakeProvider([
      {
        kind: "resolved",
        narration: "You reach for a dragon sword, but you do not possess one.",
        turnSummary: "The unsupported item claim changed nothing.",
        operations: [],
      },
    ]);
    await new DungeonEngine(store, provider).play(
      "I use my dragon sword to fly across the ordinary bridge. xyzzy@@@",
    );
    const request = provider.requests[0]!;
    expect(request.system).toContain("Player input proposes an action");
    expect(request.system).toContain("If no coherent in-fiction action can be derived");
    expect(request.system).toContain("Low-stakes uncertainty cannot become campaign-ending");
    expect(request.system).toContain("Apply the restart test");
    expect(request.system).toContain(
      "Historical operations are already applied and must never be repeated",
    );
    expect(request.system).toContain("application assigns durable IDs");
    expect(request.prompt).toContain("PLAYER INVENTORY — AUTHORITATIVE CLOSED LIST");
    expect(request.prompt).toContain("[item:travel-sword] Travel Sword");
    expect(request.prompt).toContain("Any absent item is not carried");
    expect(request.prompt).toContain("distinct current-turn source and explicit receipt");
    expect(request.prompt).toContain("do not create semantic duplicates");
    expect(request.prompt).toContain("For ordinary decision=resolved");
    expect(request.prompt).toContain("CHECK DIFFICULTY POLICY");
    expect(request.prompt).toContain("Positive values help the player character");
    expect(request.prompt).toContain("social, informational, temporal, relational");
    expect(request.prompt).toContain("CURRENT STATE RECONCILIATION");
    expect(request.prompt).toContain("Do not infer expiration");
    expect(request.prompt).toContain("Do not repeat an already-applied operation");
    expect(request.protocolVersion).toBe(3);
    expect(request.wireSchema).toBeDefined();
    expect(request.jsonSchema).toBeDefined();
    expect(request.decodeResponse).toBeDefined();
  });

  it("uses two calls for a checked turn and locks the application roll", async () => {
    const store = await createTestStore();
    const provider = new FakeProvider([
      {
        kind: "check_required",
        check: {
          name: "Perception",
          difficulty: 55,
          modifiers: [{ label: "Keen-eyed", value: 10 }],
          successStakes: "Notice who is watching.",
          failureStakes: "The watcher remains hidden.",
        },
      },
      {
        narration: "You catch the hooded stranger watching you in the mirror.",
        turnSummary: "The hero noticed a watcher.",
        operations: [
          {
            type: "add_fact",
            targetId: "player:hero",
            section: "knowledge",
            factId: "player-hero-5",
            text: "A hooded stranger is watching from the corner.",
          },
        ],
      },
    ]);
    const result = await new DungeonEngine(store, provider, () => 60).play(
      "I scan the room for anyone watching me.",
    );
    expect(provider.calls).toBe(2);
    expect(provider.requests[1]?.jsonSchema?.properties).toMatchObject({
      decision: { enum: ["resolved"] },
    });
    expect(provider.requests.map((request) => request.generationPhase)).toEqual([
      "decision",
      "locked_resolution",
    ]);
    expect(result.check).toMatchObject({
      roll: 60,
      modifierTotal: 10,
      total: 70,
      outcome: "success",
    });
    expect(
      (await store.load()).entities
        .get("player:hero")
        ?.facts.some((fact) => fact.text === "A hooded stranger is watching from the corner."),
    ).toBe(true);
  });

  it("represents a locked consequence on a newly introduced item and its exact owner", async () => {
    const store = await createTestStore();
    const provider = new FakeProvider([
      {
        kind: "check_required",
        check: {
          name: "Disable the trapped relay",
          difficulty: 50,
          modifiers: [],
          successStakes: "Mara disables the relay safely.",
          failureStakes: "The relay shorts and the tavern lights fail.",
          severeFailureStakes:
            "The relay charge melts Mara's previously unrecorded precision multi-tool and kills the tavern lights.",
        },
      },
      {
        narration:
          "The relay charge flashes through Mara's precision multi-tool, melting it into an unusable lump in her hand as the tavern lights fail.",
        turnSummary: "The relay charge melted Mara's multi-tool and killed the lights.",
        operations: [
          {
            type: "create_entity",
            entity: {
              id: "item:mara-precision-multitool",
              kind: "item",
              name: "Mara's Precision Multi-tool",
              status: "melted and unusable",
              tags: ["tool", "destroyed"],
              description: "A compact precision tool ruined by the relay charge.",
              establishedFacts: [],
              secrets: [],
              playerKnowledge: [],
            },
          },
          {
            type: "change_inventory",
            ownerId: "npc:mara-venn",
            itemId: "item:mara-precision-multitool",
            quantityDelta: 1,
          },
          {
            type: "set_entity_state",
            targetId: "location:crooked-crown",
            status: "dark after the relay short",
          },
        ],
      },
    ]);

    const result = await new DungeonEngine(store, provider, () => 1).play(
      "I ask Mara to disable the trapped relay.",
    );
    const loaded = await store.load();
    const tool = [...loaded.entities.values()].find(
      (entity) => entity.name === "Mara's Precision Multi-tool",
    )!;

    expect(result.check?.outcome).toBe("severe_failure");
    expect(provider.requests[0]?.prompt).toContain("STAKE REPRESENTABILITY AUDIT");
    expect(provider.requests[1]?.prompt).toContain("LOCKED-CONSEQUENCE ENTITY AUDIT");
    expect(tool).toMatchObject({ kind: "item", status: "melted and unusable" });
    expect(loaded.entities.get("npc:mara-venn")?.inventory).toContainEqual({
      entityId: tool.id,
      quantity: 1,
    });
    expect(loaded.entities.get("location:crooked-crown")?.status).toBe(
      "dark after the relay short",
    );
  });

  it("repairs a checked resolution whose summary completes events missing from narration", async () => {
    const store = await createTestStore();
    const provider = new FakeProvider([
      {
        kind: "check_required",
        check: {
          name: "Pursue Varag through the Beast Pens",
          difficulty: 35,
          modifiers: [{ label: "martial power", value: 15 }],
          successStakes:
            "Kroll corners Varag against the outer fence, allowing Kroll and Vael to block his flight.",
          failureStakes: "Varag escapes through the crowded pens.",
        },
      },
      {
        narration: '"Vael, cut him off!" you roar over the skittish pack beasts.',
        turnSummary:
          "Kroll and Guard Vael chased Varag through the beast pens and trapped him against the outer fence.",
        operations: [],
      },
      {
        narration:
          '"Vael, cut him off!" you roar over the skittish pack beasts. You drive Varag down the narrowing lane while Vael circles the pens. Varag reaches the outer fence with nowhere left to run, and you and Vael close in from either side, trapping him there.',
        turnSummary: "Kroll and Vael chased down Varag and cornered him at the outer fence.",
        operations: [],
      },
    ]);

    const result = await new DungeonEngine(store, provider, () => 27).play(
      "Chase the man, tell Vael to do the same.",
    );

    expect(provider.calls).toBe(3);
    expect(provider.requests[2]).toMatchObject({
      schemaName: "domain_repair_turn_resolution_v3",
      generationPhase: "repair",
      repairOfPhase: "locked_resolution",
      attemptKind: "domain_repair",
    });
    expect(provider.requests[2]?.prompt).toContain(
      "Checked resolution narration must be more detailed than its summary",
    );
    expect(result.narration).toContain("Varag reaches the outer fence with nowhere left to run");
    expect((await store.load()).manifest.turn).toBe(1);
  });

  it("repairs a checked resolution that tries to bypass the locked ending with player status", async () => {
    const store = await createTestStore();
    const provider = new FakeProvider([
      {
        kind: "check_required",
        check: {
          name: "Perception",
          difficulty: 55,
          modifiers: [],
          successStakes: "Notice the loose shutter.",
          failureStakes: "The noise remains unexplained.",
          failureCampaignStatus: "none",
        },
      },
      {
        narration: "You notice that a loose shutter caused the noise.",
        turnSummary: "The harmless noise was explained.",
        operations: [{ type: "set_entity_state", targetId: "player:hero", status: "dead" }],
      },
      {
        narration: "You notice that a loose shutter caused the noise, and remain unharmed.",
        turnSummary: "The harmless noise was explained.",
        operations: [],
      },
    ]);

    const result = await new DungeonEngine(store, provider, () => 80).play(
      "I investigate the noise.",
    );

    expect(provider.calls).toBe(3);
    expect(provider.requests[2]?.schemaName).toBe("domain_repair_turn_resolution_v3");
    expect(provider.requests[2]).toMatchObject({
      generationPhase: "repair",
      repairOfPhase: "locked_resolution",
      attemptKind: "domain_repair",
    });
    expect(result.state.status).toBe("active");
    expect((await store.load()).entities.get("player:hero")?.status).toBe("alive");
  });

  it("reuses a persisted roll when the resolution call is retried", async () => {
    const store = await createTestStore();
    let rolls = 0;
    class FailingOnceProvider extends FakeProvider {
      override async generateStructured<T>(
        request: StructuredRequest<T>,
      ): Promise<StructuredResult<T>> {
        if (this.calls === 1) {
          this.calls += 1;
          throw new Error("temporary provider failure");
        }
        return super.generateStructured(request);
      }
    }
    const provider = new FailingOnceProvider([
      {
        kind: "check_required",
        check: {
          name: "Stealth",
          difficulty: 50,
          modifiers: [],
          successStakes: "Pass unseen.",
          failureStakes: "Be noticed.",
        },
      },
      {
        narration: "You slip quietly past the guarded door without drawing notice.",
        turnSummary: "The hero passed unseen.",
        operations: [],
      },
    ]);
    const engine = new DungeonEngine(store, provider, () => {
      rolls += 1;
      return 73;
    });
    await expect(engine.play("I sneak past the door.")).rejects.toThrow(
      "temporary provider failure",
    );
    const pending = await store.getPending();
    expect(pending).toMatchObject({ kind: "action", phase: "rolled", checkResult: { roll: 73 } });
    const result = await engine.resumePendingTurn();
    expect(result.check?.roll).toBe(73);
    expect(rolls).toBe(1);
  });
});

describe("discarded turn feedback", () => {
  it("tells the next attempt which rule the discarded one tripped, in redacted form", async () => {
    const store = await createTestStore();
    const bad = {
      kind: "resolved" as const,
      narration: "You reach for a ledger that was never established here.",
      turnSummary: "The hero reached for an absent record.",
      operations: [
        { type: "add_condition" as const, targetId: "npc:nobody-at-all", condition: "wary" },
      ],
    };
    const good = {
      kind: "resolved" as const,
      narration: "You take stock of the room instead, and note the shuttered window.",
      turnSummary: "The hero took stock of the room.",
      operations: [],
    };
    // Attempt, bounded correction, both bad: the turn is discarded. Then a
    // second player action succeeds.
    const provider = new FakeProvider([bad, bad, good]);
    const engine = new DungeonEngine(store, provider);

    await expect(engine.play("I grab the ledger.")).rejects.toThrow();
    // What the harness does with an uncommittable turn: nothing was committed,
    // so drop the pending request and carry on.
    await engine.discardPendingTurn();
    await engine.play("I look around.");

    const retryPrompt = provider.requests.at(-1)?.prompt ?? "";
    expect(retryPrompt).toContain("PREVIOUS ATTEMPT AT THIS TURN WAS DISCARDED");
    // The registry's redacted text, which is a fixed token by construction.
    expect(retryPrompt).toContain("An effect referenced an entity that does not exist");
    // Never the rejected response, the bad ID, or any generated prose.
    expect(retryPrompt).not.toContain("npc:nobody-at-all");
    expect(retryPrompt).not.toContain("never established here");
  });

  it("stops mentioning a discarded attempt once a turn commits", async () => {
    const store = await createTestStore();
    const bad = {
      kind: "resolved" as const,
      narration: "You reach for a ledger that was never established here.",
      turnSummary: "The hero reached for an absent record.",
      operations: [
        { type: "add_condition" as const, targetId: "npc:nobody-at-all", condition: "wary" },
      ],
    };
    const good = (n: number) => ({
      kind: "resolved" as const,
      narration: `You take stock of the room, noting detail ${n} without changing anything.`,
      turnSummary: `The hero took stock, pass ${n}.`,
      operations: [],
    });
    const provider = new FakeProvider([bad, bad, good(1), good(2)]);
    const engine = new DungeonEngine(store, provider);

    await expect(engine.play("I grab the ledger.")).rejects.toThrow();
    // What the harness does with an uncommittable turn: nothing was committed,
    // so drop the pending request and carry on.
    await engine.discardPendingTurn();
    await engine.play("I look around.");
    await engine.play("I look again.");

    expect(provider.requests.at(-1)?.prompt ?? "").not.toContain(
      "PREVIOUS ATTEMPT AT THIS TURN WAS DISCARDED",
    );
  });
});
