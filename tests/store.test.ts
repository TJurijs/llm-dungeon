import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { renderTurnLog } from "../src/persistence/markdown.js";
import { createTestStore } from "./helpers.js";

function recoveryTurnLog(): string {
  return renderTurnLog(1, {
    action: "Recovery fixture.",
    resolved: { narration: "The interrupted turn is recovered.", turnSummary: "Recovery completed.", operations: [] },
    provider: "fake",
    model: "fake-model",
  });
}

describe("Markdown state store", () => {
  it("migrates old manifests to English and can switch the current campaign to Russian", async () => {
    const store = await createTestStore();
    const manifestPath = path.join(store.currentDir, "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
    delete manifest.language;
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    expect((await store.load()).manifest.language).toBe("en");

    await store.setLanguage("ru");
    expect((await store.load()).manifest.language).toBe("ru");
    expect(await store.inspect("character")).toMatchObject({
      view: "character",
      language: "ru",
      name: "Arlen Vale",
    });
    expect(await store.buildContext()).toContain("natural Russian");
  });

  it("persists valid world changes and hides secrets from inspection", async () => {
    const store = await createTestStore();
    const state = await store.commitTurn({
      action: "I accept the letter.",
      resolved: {
        narration: "Mara watches as you take the letter.",
        turnSummary: "The hero accepted a sealed letter.",
        operations: [
          {
            type: "create_entity",
            entity: {
              id: "item:sealed-letter",
              kind: "item",
              name: "Sealed Letter",
              status: "sealed",
              tags: ["quest-item"],
              description: "Blue wax seals the folded parchment.",
              establishedFacts: [],
              secrets: ["The seal belongs to the missing prince."],
              playerKnowledge: ["The wax bears an unfamiliar crest."],
            },
          },
          { type: "change_inventory", ownerId: "player:hero", itemId: "item:sealed-letter", quantityDelta: 1 },
          { type: "add_condition", targetId: "player:hero", condition: "watched by a hooded stranger" },
          { type: "advance_time", minutes: 5, timeLabel: "Day 1, 20:05" },
        ],
      },
      provider: "fake",
      model: "fake-model",
    });
    expect(state.turn).toBe(1);
    expect(state.elapsedMinutes).toBe(5);
    const reloaded = await store.load();
    const letter = [...reloaded.entities.values()].find((entity) => entity.name === "Sealed Letter");
    expect(letter?.id).toMatch(/^item:sealed-letter-turn-1/);
    expect(reloaded.entities.get("player:hero")?.inventory).toContainEqual({ entityId: letter?.id, quantity: 1 });
    expect(letter?.location).toBeUndefined();
    expect(reloaded.entities.get("player:hero")?.conditions).toContain("watched by a hooded stranger");
    const character = await store.inspect("character");
    expect(character.view).toBe("character");
    if (character.view !== "character") throw new Error("Expected character inspection");
    expect(character.inventory).toContainEqual(expect.objectContaining({ name: "Sealed Letter", quantity: 1 }));
    expect(JSON.stringify(character)).not.toContain("item:sealed-letter");
    expect(JSON.stringify(character)).not.toContain("contentCodec");
    const location = await store.inspect("location");
    expect(JSON.stringify(location)).not.toContain("watch captain takes bribes");
    expect(JSON.stringify(location)).not.toContain("Mara Venn");
    expect(location).not.toHaveProperty("present");
    expect(location).not.toHaveProperty("inventory");
    expect(await store.buildContext()).toContain("watch captain takes bribes");
  });

  it("turns a new item's invalid person location into inventory ownership", async () => {
    const store = await createTestStore();
    await store.commitTurn({
      action: "I buy a lantern.",
      resolved: {
        narration: "Mara hands you a lantern.",
        turnSummary: "The hero acquired a lantern.",
        operations: [
          { type: "create_entity", entity: { id: "item:lantern", kind: "item", name: "Lantern", status: "filled", location: "player:hero", tags: ["light"], description: "A sturdy lantern.", establishedFacts: [], secrets: [], playerKnowledge: [] } },
        ],
      },
      provider: "fake",
      model: "fake-model",
    });
    const loaded = await store.load();
    const lantern = [...loaded.entities.values()].find((entity) => entity.name === "Lantern")!;
    expect(lantern.location).toBeUndefined();
    expect(loaded.entities.get("player:hero")?.inventory).toContainEqual({ entityId: lantern.id, quantity: 1 });
  });

  it("turns a new loose item's location into location inventory ownership", async () => {
    const store = await createTestStore();
    await store.commitTurn({
      action: "I find a pry tool on the tavern floor.",
      resolved: {
        narration: "A pry tool lies loose on the tavern floor.",
        turnSummary: "A loose pry tool was found.",
        operations: [{
          type: "create_entity",
          entity: {
            id: "item:pry-tool",
            kind: "item",
            name: "Pry Tool",
            status: "loose",
            location: "location:crooked-crown",
            tags: ["tool"],
            description: "A short iron levering tool.",
            establishedFacts: [],
            secrets: [],
            playerKnowledge: [],
          },
        }],
      },
      provider: "fake",
      model: "fake-model",
    });

    const loaded = await store.load();
    const tool = [...loaded.entities.values()].find((entity) => entity.name === "Pry Tool")!;
    expect(tool.location).toBeUndefined();
    expect(loaded.entities.get("location:crooked-crown")?.inventory)
      .toContainEqual({ entityId: tool.id, quantity: 1 });
  });

  it("commits nothing when an operation is invalid", async () => {
    const store = await createTestStore();
    await expect(
      store.commitTurn({
        action: "I drop an imaginary key.",
        resolved: {
          narration: "Nothing happens.",
          turnSummary: "Nothing changed.",
          operations: [{ type: "change_inventory", ownerId: "player:hero", itemId: "item:missing-key", quantityDelta: -1 }],
        },
        provider: "fake",
        model: "fake-model",
      }),
    ).rejects.toThrow(/Unknown item reference/);
    expect((await store.load()).manifest.turn).toBe(0);
  });

  it("repairs uniquely matching type-compatible references with an omitted namespace", async () => {
    const store = await createTestStore();
    const initial = await store.load();
    const thread = initial.threads[0]!;
    const threadSuffix = thread.id.slice(thread.id.indexOf(":") + 1);
    const maraFact = initial.entities.get("npc:mara-venn")!.facts.find((fact) => fact.text.includes("owns"))!;
    const factSuffix = maraFact.id.slice(maraFact.id.indexOf(":") + 1);

    await store.commitTurn({
      action: "I earn Mara's confidence and revisit the northern-road mystery.",
      resolved: {
        narration: "Mara shares what she knows.",
        turnSummary: "Mara trusted the hero with a new lead.",
        operations: [
          { type: "add_condition", targetId: "hero", condition: "trusted by Mara" },
          { type: "set_relationship", sourceId: "mara-venn", targetId: "hero", summary: "Mara trusts the hero." },
          { type: "update_thread", threadId: threadSuffix, summary: "Mara revealed a new lead." },
          { type: "supersede_fact", targetId: "mara-venn", factId: factSuffix, replacementText: "Mara still owns the Crooked Crown and now trusts the hero." },
        ],
      },
      provider: "fake",
      model: "fake-model",
    });

    const loaded = await store.load();
    expect(loaded.entities.get("player:hero")?.conditions).toContain("trusted by Mara");
    expect(loaded.entities.get("npc:mara-venn")?.relationships).toContainEqual({
      targetId: "player:hero",
      summary: "Mara trusts the hero.",
    });
    expect(loaded.threads.find((candidate) => candidate.id === thread.id)?.summary).toBe("Mara revealed a new lead.");
    expect(loaded.entities.get("npc:mara-venn")?.facts.some((fact) => fact.text.includes("now trusts the hero"))).toBe(true);
  });

  it("rejects duplicate temporary references and unknown references without committing", async () => {
    const duplicateStore = await createTestStore();
    await expect(duplicateStore.commitTurn({
      action: "I address the shared reference.",
      resolved: {
        narration: "The reference is unclear.",
        turnSummary: "Nothing changed.",
        operations: [
          { type: "create_entity", entity: { id: "entity:new", kind: "person", name: "Shared Person", status: "alive", tags: [], description: "A person.", establishedFacts: [], secrets: [], playerKnowledge: [] } },
          { type: "create_entity", entity: { id: "entity:new", kind: "item", name: "Shared Item", status: "intact", tags: [], description: "An item.", establishedFacts: [], secrets: [], playerKnowledge: [] } },
        ],
      },
      provider: "fake",
      model: "fake-model",
    })).rejects.toThrow(/Duplicate new entity reference hint entity:new/);
    expect((await duplicateStore.load()).manifest.turn).toBe(0);

    const unknownStore = await createTestStore();
    await expect(unknownStore.commitTurn({
      action: "I pursue a nonexistent lead.",
      resolved: {
        narration: "There is no such lead.",
        turnSummary: "Nothing changed.",
        operations: [{ type: "update_thread", threadId: "does-not-exist", summary: "Impossible." }],
      },
      provider: "fake",
      model: "fake-model",
    })).rejects.toThrow(/Unknown thread reference does-not-exist/);
    expect((await unknownStore.load()).manifest.turn).toBe(0);
  });

  it("applies movement, relationships, threads, fact replacement, and campaign endings", async () => {
    const store = await createTestStore();
    const initial = await store.load();
    const maraFact = initial.entities.get("npc:mara-venn")!.facts.find((fact) => fact.text.includes("owns"))!;
    const northernRoadThreadId = initial.threads[0]!.id;
    await store.commitTurn({
      action: "The tavern changes hands after the confrontation.",
      resolved: {
        narration: "By dawn, the old balance has broken.",
        turnSummary: "The tavern changed hands and the road mystery ended.",
        operations: [
          { type: "create_entity", entity: { id: "location:tavern-yard", kind: "location", name: "Tavern Yard", status: "open", location: "location:crooked-crown", tags: ["yard"], description: "A muddy yard.", establishedFacts: [], secrets: [], playerKnowledge: [] } },
          { type: "move_entity", targetId: "player:hero", locationId: "location:tavern-yard" },
          { type: "set_relationship", sourceId: "npc:mara-venn", targetId: "player:hero", summary: "Mara trusts the hero with her livelihood." },
          { type: "supersede_fact", targetId: "npc:mara-venn", factId: maraFact.id, replacementFactId: "fact:mara-former-owner", replacementText: "Mara formerly owned the Crooked Crown." },
          { type: "resolve_thread", threadId: northernRoadThreadId, outcome: "The disappearances were explained.", status: "resolved" },
          { type: "record_major_event", eventId: "event:tavern-changed-hands", text: "The Crooked Crown changed hands." },
          { type: "end_campaign", status: "ended", reason: "The hero retired from the road." },
        ],
      },
      provider: "fake",
      model: "fake-model",
    });
    const loaded = await store.load();
    const tavernYard = [...loaded.entities.values()].find((entity) => entity.name === "Tavern Yard");
    expect(loaded.manifest.currentLocationId).toBe(tavernYard?.id);
    expect(loaded.manifest.status).toBe("ended");
    expect(loaded.entities.get("player:hero")?.status).toBe("ended");
    expect(loaded.entities.get("npc:mara-venn")?.relationships[0]?.summary).toContain("trusts");
    expect(loaded.entities.get("npc:mara-venn")?.facts.some((fact) => fact.text === "Mara formerly owned the Crooked Crown.")).toBe(true);
    expect(loaded.threads[0]?.status).toBe("resolved");
    expect(loaded.chronicle.some((event) => event.text === "The Crooked Crown changed hands.")).toBe(true);
  });

  it("assigns safe generated IDs instead of trusting model-provided fact, thread, and event IDs", async () => {
    const store = await createTestStore();
    await store.commitTurn({
      action: "I record the discovery.",
      resolved: {
        narration: "The discovery is recorded.",
        turnSummary: "A discovery and new lead were recorded.",
        operations: [
          { type: "add_fact", targetId: "player:hero", section: "knowledge", factId: "player-hero-5", text: "A blue mark points north." },
          { type: "create_thread", threadId: "new lead", title: "The Blue Mark", summary: "The blue mark points north." },
          { type: "record_major_event", eventId: "major discovery", text: "The hero found the blue mark." },
        ],
      },
      provider: "fake",
      model: "fake-model",
    });
    const loaded = await store.load();
    const fact = loaded.entities.get("player:hero")?.facts.find((entry) => entry.text === "A blue mark points north.");
    expect(fact?.id).toMatch(/^fact:/);
    expect(fact?.id).not.toBe("player-hero-5");
    expect(loaded.threads.find((thread) => thread.title === "The Blue Mark")?.id).toMatch(/^thread:/);
    expect(loaded.chronicle.find((event) => event.text === "The hero found the blue mark.")?.id).toMatch(/^event:/);
  });

  it("coalesces duplicate location names and rejects contradictory physical item destinations", async () => {
    const duplicateStore = await createTestStore();
    await duplicateStore.commitTurn({
      action: "I return to the inn.",
      resolved: {
        narration: "You return to the inn.",
        turnSummary: "The hero returned.",
        operations: [{
          type: "create_entity",
          entity: { id: "location:the-crooked-crown", kind: "location", name: "Crooked Crown", status: "open", tags: [], description: "The same tavern.", establishedFacts: [], secrets: [], playerKnowledge: [] },
        }],
      },
      provider: "fake",
      model: "fake-model",
    });
    const duplicateLoaded = await duplicateStore.load();
    expect(duplicateLoaded.manifest.turn).toBe(1);
    expect([...duplicateLoaded.entities.values()].filter((entity) => entity.kind === "location")).toHaveLength(1);

    const ownershipStore = await createTestStore();
    await expect(ownershipStore.commitTurn({
      action: "I drop my sword near Mara.",
      resolved: {
        narration: "The sword lands on the floor.",
        turnSummary: "The sword was dropped.",
        operations: [
          { type: "change_inventory", ownerId: "player:hero", itemId: "item:travel-sword", quantityDelta: -1 },
          { type: "move_entity", targetId: "item:travel-sword", locationId: "location:crooked-crown" },
          { type: "change_inventory", ownerId: "npc:mara-venn", itemId: "item:travel-sword", quantityDelta: 1 },
        ],
      },
      provider: "fake",
      model: "fake-model",
    })).rejects.toThrow(/both moved to a location and added to inventory/);
    expect((await ownershipStore.load()).manifest.turn).toBe(0);
  });

  it("repairs an unambiguous near-miss reference to a location created in the same transaction", async () => {
    const store = await createTestStore();
    await store.commitTurn({
      action: "I am escorted into the Oakhaven streets.",
      resolved: {
        narration: "The tavern door closes behind you in the Oakhaven streets.",
        turnSummary: "The hero entered the Oakhaven streets.",
        operations: [
          {
            type: "create_entity",
            entity: { id: "location:oakhaven-streets", kind: "location", name: "Oakhaven Streets", status: "open", tags: ["public"], description: "The muddy town streets.", establishedFacts: [], secrets: [], playerKnowledge: [] },
          },
          { type: "move_entity", targetId: "player:hero", locationId: "location:oaven-streets" },
        ],
      },
      provider: "fake",
      model: "fake-model",
    });
    const loaded = await store.load();
    const streets = [...loaded.entities.values()].find((entity) => entity.name === "Oakhaven Streets");
    expect(loaded.manifest.turn).toBe(1);
    expect(loaded.manifest.currentLocationId).toBe(streets?.id);
  });

  it("transfers inventory atomically and normalizes an exact split debit-credit pair", async () => {
    const store = await createTestStore();
    await store.commitTurn({
      action: "I give Mara my travel sword.",
      resolved: {
        narration: "Mara accepts the sword.",
        turnSummary: "The hero gave Mara the travel sword.",
        operations: [{
          type: "transfer_item",
          fromId: "player:hero",
          toId: "npc:mara-venn",
          itemId: "item:travel-sword",
          quantity: 1,
        }],
      },
      provider: "fake",
      model: "fake-model",
    });
    const loaded = await store.load();
    expect(loaded.entities.get("player:hero")?.inventory).not.toContainEqual({ entityId: "item:travel-sword", quantity: 1 });
    expect(loaded.entities.get("npc:mara-venn")?.inventory).toContainEqual({ entityId: "item:travel-sword", quantity: 1 });

    const splitStore = await createTestStore();
    await splitStore.commitTurn({
      action: "I give Mara my travel sword.",
      resolved: {
        narration: "Mara accepts the sword.",
        turnSummary: "The hero gave Mara the travel sword.",
        operations: [
          { type: "change_inventory", ownerId: "player:hero", itemId: "item:travel-sword", quantityDelta: -1 },
          { type: "change_inventory", ownerId: "npc:mara-venn", itemId: "item:travel-sword", quantityDelta: 1 },
        ],
      },
      provider: "fake",
      model: "fake-model",
    });
    const splitLoaded = await splitStore.load();
    expect(splitLoaded.manifest.turn).toBe(1);
    expect(splitLoaded.entities.get("player:hero")?.inventory).not.toContainEqual({ entityId: "item:travel-sword", quantity: 1 });
    expect(splitLoaded.entities.get("npc:mara-venn")?.inventory).toContainEqual({ entityId: "item:travel-sword", quantity: 1 });
  });

  it("blocks an exact repeated abstract inventory credit from the preceding turn", async () => {
    const store = await createTestStore();
    await store.commitTurn({
      action: "Mara pays me five silver shillings.",
      resolved: {
        narration: "Mara pays you five silver shillings.",
        turnSummary: "Mara paid five shillings.",
        operations: [
          { type: "create_entity", entity: { id: "item:silver-shillings", kind: "item", name: "Silver Shillings", status: "current", tags: ["currency"], description: "Silver trade coins.", establishedFacts: [], secrets: [], playerKnowledge: [] } },
          { type: "change_inventory", ownerId: "player:hero", itemId: "item:silver-shillings", quantityDelta: 5 },
        ],
      },
      provider: "fake",
      model: "fake-model",
    });
    const afterPayment = await store.load();
    const silverId = [...afterPayment.entities.values()].find((entity) => entity.name === "Silver Shillings")!.id;
    const repeatedCredit = { type: "change_inventory" as const, ownerId: "player:hero", itemId: silverId, quantityDelta: 5 };
    await expect(store.commitTurn({
      action: "I pocket the five silver shillings.",
      resolved: { narration: "You pocket the payment.", turnSummary: "The payment was pocketed.", operations: [repeatedCredit] },
      provider: "fake",
      model: "fake-model",
    })).rejects.toThrow(/Repeated abstract inventory credit/);
    const loaded = await store.load();
    expect(loaded.manifest.turn).toBe(1);
    expect(loaded.entities.get("player:hero")?.inventory).toContainEqual({ entityId: silverId, quantity: 5 });
    expect(await store.buildContext()).toContain("LAST COMMITTED STATE OPERATIONS — ALREADY APPLIED");
  });

  it("includes entities explicitly linked from active threads even when they are elsewhere", async () => {
    const store = await createTestStore();
    await store.commitTurn({
      action: "Mara tells me who watches the northern gate.",
      resolved: {
        narration: "Mara names the distant gate warden.",
        turnSummary: "The gate warden became relevant to the northern-road mystery.",
        operations: [
          { type: "create_entity", entity: { id: "location:new", kind: "location", name: "Northern Gate", status: "open", tags: ["gate"], description: "A gate beyond the tavern.", establishedFacts: [], secrets: [], playerKnowledge: [] } },
          { type: "create_entity", entity: { id: "npc:new", kind: "person", name: "Gate Warden", status: "alive", location: "location:new", tags: ["warden"], description: "The distant gate warden.", establishedFacts: [], secrets: ["The warden secretly marks certain wagons."], playerKnowledge: [] } },
          { type: "create_thread", threadId: "thread:new", title: "The Marked Wagons", summary: "Learn why wagons are marked.", relatedEntityIds: ["npc:new"] },
        ],
      },
      provider: "fake",
      model: "fake-model",
    });
    const context = await store.buildContext();
    expect(context).toContain("# Gate Warden");
    expect(context).toContain("The warden secretly marks certain wagons.");
  });

  it("includes parent locations and a compact authoritative location directory", async () => {
    const store = await createTestStore();
    await store.commitTurn({
      action: "The tavern's district is established.",
      resolved: {
        narration: "The Crooked Crown stands in Lantern Ward.",
        turnSummary: "Lantern Ward became the tavern's parent location.",
        operations: [
          { type: "create_entity", entity: { id: "location:lantern-ward", kind: "location", name: "Lantern Ward", status: "quiet", tags: ["district"], description: "A rain-dark district around the tavern.", establishedFacts: ["Lantern Ward surrounds the Crooked Crown."], secrets: [], playerKnowledge: [] } },
          { type: "move_entity", targetId: "location:crooked-crown", locationId: "location:lantern-ward" },
        ],
      },
      provider: "fake",
      model: "fake-model",
    });
    const context = await store.buildContext();
    expect(context).toContain("AUTHORITATIVE LOCATION DIRECTORY");
    expect(context).toContain("# Lantern Ward");
    expect(context).toContain("Lantern Ward surrounds the Crooked Crown.");
    expect(context).toContain("parent=[location:lantern-ward-turn-1]");
  });

  it("finishes an interrupted prepared commit idempotently", async () => {
    const store = await createTestStore();
    const manifestPath = path.join(store.currentDir, "manifest.json");
    const before = await readFile(manifestPath, "utf8");
    const manifest = JSON.parse(before) as Record<string, unknown>;
    const campaignId = String(manifest.campaignId);
    manifest.turn = 1;
    manifest.timeLabel = "Recovered time";
    await writeFile(
      store.pendingPath,
      JSON.stringify({
        kind: "commit",
        campaignId,
        expectedPreviousTurn: 0,
        targetTurn: 1,
        preManifestHash: createHash("sha256").update(before).digest("hex"),
        writes: {
          "turns/000001.md": recoveryTurnLog(),
          "manifest.json": `${JSON.stringify(manifest, null, 2)}\n`,
        },
      }),
      "utf8",
    );
    await store.recoverCommit();
    await store.recoverCommit();
    expect((await store.load()).manifest.timeLabel).toBe("Recovered time");
  });

  it("refuses to recover a prepared commit against a changed campaign pre-state", async () => {
    const store = await createTestStore();
    const manifestPath = path.join(store.currentDir, "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
    await writeFile(store.pendingPath, JSON.stringify({
      kind: "commit",
      campaignId: manifest.campaignId,
      expectedPreviousTurn: 0,
      targetTurn: 1,
      preManifestHash: "0".repeat(64),
      writes: {
        "turns/000001.md": recoveryTurnLog(),
        "manifest.json": `${JSON.stringify({ ...manifest, turn: 1 }, null, 2)}\n`,
      },
    }), "utf8");
    await expect(store.recoverCommit()).rejects.toThrow(/pre-state manifest hash does not match/);
    expect(JSON.parse(await readFile(manifestPath, "utf8")).turn).toBe(0);
  });

  it("compacts old turn prose while retaining authoritative Markdown facts", async () => {
    const store = await createTestStore();
    for (let turn = 1; turn <= 9; turn += 1) {
      await store.commitTurn({
        action: `Distinct action ${turn}`,
        resolved: {
          narration: `VERBOSE NARRATION ${turn} that should only remain for the latest turn.`,
          turnSummary: `DURABLE SUMMARY ${turn}`,
          operations: [],
        },
        provider: "fake",
        model: "fake-model",
      });
    }
    const context = await store.buildContext();
    expect(context).toContain("watch captain takes bribes");
    expect(context).toContain("PLAYER INVENTORY — AUTHORITATIVE CLOSED LIST");
    expect(context).toContain("DURABLE SUMMARY 2");
    expect(context).not.toContain("VERBOSE NARRATION 2");
    expect(context).toContain("VERBOSE NARRATION 9");
    expect(context).not.toContain("State Operations");
  });

  it("includes inventory-linked entities for every relevant NPC in DM context", async () => {
    const store = await createTestStore();
    await store.commitTurn({
      action: "Mara keeps an existing token in her apron.",
      resolved: {
        narration: "The token remains in Mara's possession.",
        turnSummary: "Mara's token was established.",
        operations: [
          { type: "create_entity", entity: { id: "item:mara-token", kind: "item", name: "Mara's Token", status: "intact", tags: ["token"], description: "A small existing brass token.", establishedFacts: ["The token already exists."], secrets: ["A hidden notch marks its edge."], playerKnowledge: [] } },
          { type: "change_inventory", ownerId: "npc:mara-venn", itemId: "item:mara-token", quantityDelta: 1 },
        ],
      },
      provider: "fake",
      model: "fake-model",
    });

    const context = await store.buildContext();
    const loaded = await store.load();
    const token = [...loaded.entities.values()].find((entity) => entity.name === "Mara's Token");
    expect(context).toContain("RELEVANT ENTITY INVENTORIES — AUTHORITATIVE");
    expect(context).toContain(`1 × [${token?.id}] Mara's Token`);
    expect(context).toContain("# Mara's Token");
    expect(context).toContain("A hidden notch marks its edge.");
  });
});
