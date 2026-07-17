import { describe, expect, it } from "vitest";
import { DungeonEngine } from "../src/engine.js";
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

  it("corrects an initial location that contains itself", async () => {
    const store = await createTestStore();
    const invalid = structuredClone(setupFixture);
    invalid.entities.find((entity) => entity.id === "location:crooked-crown")!.location = "location:crooked-crown";
    const provider = new FakeProvider([invalid, setupFixture]);
    const setup = await new DungeonEngine(store, provider).generateSetup({
      worldRules: "Classic fantasy.",
      premise: "A tavern opening.",
      character: "A scout.",
    });

    expect(provider.calls).toBe(2);
    expect(provider.requests[1]?.schemaName).toBe("domain_repair_campaign_setup");
    expect(provider.requests[1]?.prompt).toContain("cannot be located inside itself");
    const startingLocation = setup.entities.find((entity) => entity.id === setup.player.location);
    expect(startingLocation?.location).toBeUndefined();
  });

  it("uses one call for a turn without a check", async () => {
    const store = await createTestStore();
    const provider = new FakeProvider([resolved]);
    const result = await new DungeonEngine(store, provider, () => 50).play("I greet Mara.");
    expect(provider.calls).toBe(1);
    expect(result.turn).toBe(1);
    expect(result.check).toBeUndefined();
  });

  it("answers an explicit question without rolling, persisting, or advancing a turn", async () => {
    const store = await createTestStore();
    const provider = new FakeProvider([{ answer: "You can attempt one primary action while under immediate pressure." }]);
    let rolls = 0;
    const engine = new DungeonEngine(store, provider, () => { rolls += 1; return 50; });
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
    const provider = new FakeProvider([{
      kind: "resolved",
      narration: "Mara adds a fresh detail about the northern road.",
      turnSummary: "The northern-road lead advanced.",
      operations: [{ type: "update_thread", threadId: threadSuffix, summary: "Mara supplied a fresh detail." }],
    }]);

    const result = await new DungeonEngine(store, provider).play("Ask Mara about the northern road.");
    expect(provider.calls).toBe(1);
    expect(result.operations[0]).toMatchObject({ type: "update_thread", threadId: thread.id });
    expect((await store.load()).threads[0]?.summary).toBe("Mara supplied a fresh detail.");
  });

  it("corrects one structurally invalid turn response before committing", async () => {
    const store = await createTestStore();
    const provider = new FakeProvider([[], resolved]);
    const result = await new DungeonEngine(store, provider).play("I greet Mara.");
    expect(provider.calls).toBe(2);
    expect(provider.requests[1]?.schemaName).toBe("repair_turn_decision_v1");
    expect(result.turn).toBe(1);
  });

  it("deterministically reuses an existing location instead of spending a correction call", async () => {
    const store = await createTestStore();
    await store.commitTurn({
      action: "The northern road already exists beyond the tavern.",
      resolved: {
        narration: "The northern road lies beyond the tavern.",
        turnSummary: "The northern road was established.",
        operations: [{
          type: "create_entity",
          entity: { id: "location:northern-road", kind: "location", name: "Northern Road", status: "open", tags: ["road"], description: "A road leading north.", establishedFacts: [], secrets: [], playerKnowledge: [] },
        }],
      },
      provider: "fake",
      model: "fake-model",
    });
    const existingRoad = [...(await store.load()).entities.values()].find((entity) => entity.name === "Northern Road")!;
    const provider = new FakeProvider([
      {
        kind: "resolved",
        narration: "You step onto the existing northern road.",
        turnSummary: "The hero reached the northern road.",
        operations: [
          { type: "create_entity", entity: { id: "location:model-road", kind: "location", name: "The Northern Road", status: "rainy", tags: [], description: "A redundant description.", establishedFacts: [], secrets: [], playerKnowledge: [] } },
          { type: "move_entity", targetId: "player:hero", locationId: "location:model-road" },
        ],
      },
    ]);

    const result = await new DungeonEngine(store, provider).play("I leave for the northern road.");
    expect(provider.calls).toBe(1);
    expect(result.state.currentLocationId).toBe(existingRoad.id);
    const locations = [...(await store.load()).entities.values()].filter((entity) => entity.kind === "location" && entity.name.includes("Northern Road"));
    expect(locations).toHaveLength(1);
  });

  it("normalizes an idempotent move without spending a corrective call", async () => {
    const store = await createTestStore();
    const provider = new FakeProvider([
      {
        kind: "resolved",
        narration: "You remain at the Crooked Crown's bar while Mara waits nearby.",
        turnSummary: "Arlen remained at the tavern bar.",
        operations: [{ type: "move_entity", targetId: "player:hero", locationId: "location:crooked-crown" }],
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
        narration: "Mara wraps trail rations in oilskin, and you tuck the parcel securely into your pack.",
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
    const provider = new FakeProvider([{
      kind: "resolved",
      narration: "You slip your travel sword from your satchel as someone shouts that the watch has arrived at the door.",
      turnSummary: "Arlen readied his owned sword while the watch arrived outside.",
      operations: [],
    }]);
    const result = await new DungeonEngine(store, provider).play("I take my travel sword from my satchel and ready it.");
    expect(provider.calls).toBe(1);
    expect(result.turn).toBe(1);
  });

  it("makes inventory authority, graceful nonsense handling, and lethal limits explicit", async () => {
    const store = await createTestStore();
    const provider = new FakeProvider([{
      kind: "resolved",
      narration: "You reach for a dragon sword, but you do not possess one.",
      turnSummary: "The unsupported item claim changed nothing.",
      operations: [],
    }]);
    await new DungeonEngine(store, provider).play("I use my dragon sword to fly across the ordinary bridge. xyzzy@@@");
    const request = provider.requests[0]!;
    expect(request.system).toContain("Player input proposes an action");
    expect(request.system).toContain("If no coherent in-fiction action can be derived");
    expect(request.system).toContain("Low-stakes uncertainty cannot become campaign-ending");
    expect(request.system).toContain("Apply the restart test");
    expect(request.system).toContain("Historical operations are already applied and must never be repeated");
    expect(request.system).toContain("application assigns durable IDs");
    expect(request.prompt).toContain("PLAYER INVENTORY — AUTHORITATIVE CLOSED LIST");
    expect(request.prompt).toContain("[item:travel-sword] Travel Sword");
    expect(request.prompt).toContain("Any absent item is not carried");
    expect(request.prompt).toContain("distinct current-turn source and explicit receipt");
    expect(request.prompt).toContain("do not create semantic duplicates");
    expect(request.prompt).toContain("For decision=resolved");
    expect(request.prompt).toContain("CHECK DIFFICULTY POLICY");
    expect(request.prompt).toContain("Positive values help the player character");
    expect(request.prompt).toContain("social, informational, temporal, relational");
    expect(request.prompt).toContain("CURRENT STATE RECONCILIATION");
    expect(request.prompt).toContain("Do not infer expiration");
    expect(request.prompt).toContain("Do not repeat an already-applied operation");
    expect(request.protocolVersion).toBe(1);
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
          { type: "add_fact", targetId: "player:hero", section: "knowledge", factId: "player-hero-5", text: "A hooded stranger is watching from the corner." },
        ],
      },
    ]);
    const result = await new DungeonEngine(store, provider, () => 60).play("I scan the room for anyone watching me.");
    expect(provider.calls).toBe(2);
    expect(provider.requests[1]?.jsonSchema?.properties).toMatchObject({
      decision: { enum: ["resolved"] },
    });
    expect(result.check).toMatchObject({ roll: 60, modifierTotal: 10, total: 70, outcome: "success" });
    expect((await store.load()).entities.get("player:hero")?.facts.some((fact) => fact.text === "A hooded stranger is watching from the corner.")).toBe(true);
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

    const result = await new DungeonEngine(store, provider, () => 80).play("I investigate the noise.");

    expect(provider.calls).toBe(3);
    expect(provider.requests[2]?.schemaName).toBe("domain_repair_turn_resolution_v1");
    expect(result.state.status).toBe("active");
    expect((await store.load()).entities.get("player:hero")?.status).toBe("alive");
  });

  it("reuses a persisted roll when the resolution call is retried", async () => {
    const store = await createTestStore();
    let rolls = 0;
    class FailingOnceProvider extends FakeProvider {
      override async generateStructured<T>(request: StructuredRequest<T>): Promise<StructuredResult<T>> {
        if (this.calls === 1) { this.calls += 1; throw new Error("temporary provider failure"); }
        return super.generateStructured(request);
      }
    }
    const provider = new FailingOnceProvider([
      {
        kind: "check_required",
        check: { name: "Stealth", difficulty: 50, modifiers: [], successStakes: "Pass unseen.", failureStakes: "Be noticed." },
      },
      { narration: "You slip past.", turnSummary: "The hero passed unseen.", operations: [] },
    ]);
    const engine = new DungeonEngine(store, provider, () => { rolls += 1; return 73; });
    await expect(engine.play("I sneak past the door.")).rejects.toThrow("temporary provider failure");
    const pending = await store.getPending();
    expect(pending).toMatchObject({ kind: "action", phase: "rolled", checkResult: { roll: 73 } });
    const result = await engine.resumePendingTurn();
    expect(result.check?.roll).toBe(73);
    expect(rolls).toBe(1);
  });
});
