import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { formatAppealCommand, parseAppealCommand } from "../src/appeal.js";
import { DungeonEngine } from "../src/engine.js";
import { parsePlayerVisibleTurn } from "../src/persistence/markdown.js";
import { APPEAL_SYSTEM_PROMPT } from "../src/prompts.js";
import type { LlmProvider, StructuredRequest, StructuredResult } from "../src/types.js";
import { createTestStore } from "./helpers.js";

class AppealProvider implements LlmProvider {
  readonly id = "fake";
  readonly model = "fake-model";
  readonly requests: StructuredRequest<unknown>[] = [];

  constructor(private readonly queue: unknown[]) {}

  async generateStructured<T>(request: StructuredRequest<T>): Promise<StructuredResult<T>> {
    this.requests.push(request as StructuredRequest<unknown>);
    const next = this.queue.shift();
    if (next instanceof Error) throw next;
    return { data: request.schema.parse(next), provider: this.id, model: this.model };
  }
}

const denied = {
  narration: "The committed record does not support this correction, so the appeal is denied.",
  turnSummary: "Appeal denied; no state changed.",
  operations: [],
};

describe("appeal command", () => {
  it("parses generic and targeted syntax without treating adjacent commands as appeals", () => {
    expect(parseAppealCommand(":appeal The lantern is missing.")).toEqual({
      claim: "The lantern is missing.",
    });
    expect(parseAppealCommand(":appeal --turn 12 First line.\nSecond line.")).toEqual({
      claim: "First line.\nSecond line.",
      targetTurn: 12,
    });
    expect(parseAppealCommand(":appealing is roleplay")).toBeUndefined();
    expect(formatAppealCommand({ claim: "State is stale.", targetTurn: 3 })).toBe(
      ":appeal --turn 3 State is stale.",
    );
  });

  it("rejects incomplete or invalid targeted syntax", () => {
    expect(() => parseAppealCommand(":appeal")).toThrow(/requires an explanation/);
    expect(() => parseAppealCommand(":appeal --turn 0 no")).toThrow(/positive committed turn/);
    expect(() => parseAppealCommand(":appeal --turn 2")).toThrow(/Use :appeal --turn/);
  });
});

describe("administrative appeal flow", () => {
  it("uses one non-rolling call and append-only commit to repair a proven missing item", async () => {
    const store = await createTestStore();
    await store.commitTurn({
      action: "I accept the brass key.",
      resolved: {
        narration: "Mara places a small brass key in your palm.",
        turnSummary: "Mara gave the hero a brass key.",
        operations: [],
      },
      provider: "fake",
      model: "fake-model",
    });
    const targetPath = path.join(store.currentDir, "turns", "000001.md");
    const targetBefore = await readFile(targetPath, "utf8");
    const provider = new AppealProvider([{
      narration: "The appeal is upheld. The narrated brass key is added to your inventory.",
      turnSummary: "Appeal upheld; the missing brass key was recorded.",
      operations: [
        {
          type: "create_entity",
          entity: {
            id: "item:brass-key",
            kind: "item",
            name: "Brass Key",
            status: "intact",
            tags: ["key"],
            description: "A small brass key given by Mara.",
            establishedFacts: [],
            secrets: [],
            playerKnowledge: [],
          },
        },
        { type: "change_inventory", ownerId: "player:hero", itemId: "item:brass-key", quantityDelta: 1 },
      ],
    }]);
    let rolls = 0;
    const result = await new DungeonEngine(store, provider, () => { rolls += 1; return 1; }).appeal({
      targetTurn: 1,
      claim: "The key was narrated but never entered in my inventory.",
    });

    expect(provider.requests).toHaveLength(1);
    expect(provider.requests[0]?.schemaName).toBe("appeal_resolution_v1");
    expect(provider.requests[0]?.protocolVersion).toBe(1);
    expect(provider.requests[0]?.system).toBe(APPEAL_SYSTEM_PROMPT);
    expect(provider.requests[0]?.prompt).toContain("Mara places a small brass key in your palm.");
    expect(provider.requests[0]?.prompt).toContain("PLAYER APPEAL — UNTRUSTED CLAIM");
    expect(result).toMatchObject({ turn: 2, kind: "appeal", appealTargetTurn: 1 });
    expect(result.state.timeLabel).toBe("Day 1, 20:00");
    expect(rolls).toBe(0);
    expect(await readFile(targetPath, "utf8")).toBe(targetBefore);
    const loaded = await store.load();
    const key = [...loaded.entities.values()].find((entity) => entity.name === "Brass Key");
    expect(loaded.entities.get("player:hero")?.inventory).toContainEqual({ entityId: key?.id, quantity: 1 });
    const appealLog = await readFile(path.join(store.currentDir, "turns", "000002.md"), "utf8");
    expect(parsePlayerVisibleTurn(appealLog)).toMatchObject({
      kind: "appeal",
      appealTargetTurn: 1,
      action: ":appeal --turn 1 The key was narrated but never entered in my inventory.",
    });
  });

  it("records a denied generic appeal without changing in-world time", async () => {
    const store = await createTestStore();
    const before = await store.load();
    const provider = new AppealProvider([denied]);
    const result = await new DungeonEngine(store, provider).appeal({
      claim: "I think I should own a royal crown.",
    });

    expect(result).toMatchObject({ kind: "appeal", turn: 1, operations: [] });
    expect(result.state.timeLabel).toBe(before.manifest.timeLabel);
    expect(result.state.elapsedMinutes).toBe(before.manifest.elapsedMinutes);
    expect(provider.requests[0]?.prompt).toContain("COMPACT RECENT APPEAL EVIDENCE");
  });

  it("keeps the latest gameplay credit authoritative across a denied appeal", async () => {
    const store = await createTestStore();
    await store.commitTurn({
      action: "Mara pays me five silver shillings.",
      resolved: {
        narration: "Mara pays you five silver shillings.",
        turnSummary: "Mara paid five shillings.",
        operations: [
          {
            type: "create_entity",
            entity: {
              id: "item:silver-shillings",
              kind: "item",
              name: "Silver Shillings",
              status: "current",
              tags: ["currency"],
              description: "Silver trade coins.",
              establishedFacts: [],
              secrets: [],
              playerKnowledge: [],
            },
          },
          { type: "change_inventory", ownerId: "player:hero", itemId: "item:silver-shillings", quantityDelta: 5 },
        ],
      },
      provider: "fake",
      model: "fake-model",
    });
    const afterPayment = await store.load();
    const silver = [...afterPayment.entities.values()].find((entity) => entity.name === "Silver Shillings")!;

    await store.commitTurn({
      kind: "appeal",
      action: ":appeal I think the payment was not recorded.",
      resolved: denied,
      provider: "fake",
      model: "fake-model",
    });

    const context = await store.buildContext();
    expect(context).toContain("Turn 1 (gameplay)");
    expect(context).toContain("Turn 2 (appeal)");
    expect(context).toContain(`\"itemId\": \"${silver.id}\"`);
    expect(context).toContain('"quantityDelta": 5');

    await expect(store.commitTurn({
      action: "I pocket those same five shillings.",
      resolved: {
        narration: "You pocket the already-recorded payment.",
        turnSummary: "The existing payment was handled.",
        operations: [
          { type: "change_inventory", ownerId: "player:hero", itemId: silver.id, quantityDelta: 5 },
        ],
      },
      provider: "fake",
      model: "fake-model",
    })).rejects.toThrow(/Repeated abstract inventory credit/);

    const loaded = await store.load();
    expect(loaded.manifest.turn).toBe(2);
    expect(loaded.entities.get("player:hero")?.inventory).toContainEqual({ entityId: silver.id, quantity: 5 });
  });

  it("keeps an interrupted appeal recoverable with its target and never routes it through adjudication", async () => {
    const store = await createTestStore();
    await store.commitTurn({
      action: "I wait.",
      resolved: { narration: "You wait.", turnSummary: "The hero waited.", operations: [] },
      provider: "fake",
      model: "fake-model",
    });
    const provider = new AppealProvider([new Error("provider stopped"), denied]);
    const engine = new DungeonEngine(store, provider);

    await expect(engine.appeal({ targetTurn: 1, claim: "Please review that turn." })).rejects.toThrow("provider stopped");
    expect(await store.getPending()).toMatchObject({
      kind: "appeal",
      phase: "requested",
      targetTurn: 1,
    });
    const result = await engine.resumePendingTurn();
    expect(result.kind).toBe("appeal");
    expect(provider.requests.map((request) => request.schemaName)).toEqual([
      "appeal_resolution_v1",
      "appeal_resolution_v1",
    ]);
  });

  it("domain-corrects forbidden time changes and terminal-entity restoration", async () => {
    const store = await createTestStore();
    await store.commitTurn({
      action: "Mara dies from an established event.",
      resolved: {
        narration: "Mara is dead.",
        turnSummary: "Mara died.",
        operations: [{ type: "set_entity_state", targetId: "npc:mara-venn", status: "dead" }],
      },
      provider: "fake",
      model: "fake-model",
    });
    const provider = new AppealProvider([
      {
        narration: "The appeal changes time and restores Mara.",
        turnSummary: "Unsafe correction.",
        operations: [
          { type: "set_entity_state", targetId: "npc:mara-venn", status: "alive" },
          { type: "advance_time", minutes: 60, timeLabel: "Later" },
        ],
      },
      denied,
    ]);
    const result = await new DungeonEngine(store, provider).appeal({ targetTurn: 1, claim: "Bring Mara back." });

    expect(provider.requests.map((request) => request.schemaName)).toEqual([
      "appeal_resolution_v1",
      "domain_repair_appeal_resolution_v1",
    ]);
    expect(result.operations).toEqual([]);
    expect(result.state.timeLabel).toBe("Day 1, 20:00");
    expect((await store.load()).entities.get("npc:mara-venn")?.status).toBe("dead");
  });

  it("loads exact targeted evidence even after it falls outside recent context", async () => {
    const store = await createTestStore();
    for (let turn = 1; turn <= 9; turn += 1) {
      await store.commitTurn({
        action: `Action ${turn}`,
        resolved: {
          narration: turn === 1 ? "UNIQUE OLD TARGET NARRATION" : `Narration ${turn}`,
          turnSummary: `Summary ${turn}`,
          operations: [],
        },
        provider: "fake",
        model: "fake-model",
      });
    }
    const provider = new AppealProvider([denied]);
    await new DungeonEngine(store, provider).appeal({ targetTurn: 1, claim: "Review the first turn." });
    expect(provider.requests[0]?.prompt).toContain("UNIQUE OLD TARGET NARRATION");
    expect(provider.requests[0]?.prompt).toContain("TARGET TURN 1");
  });

  it("rejects non-item creation atomically at the store boundary", async () => {
    const store = await createTestStore();
    await expect(store.commitTurn({
      kind: "appeal",
      action: ":appeal Invent an NPC.",
      resolved: {
        narration: "An unsupported NPC is created.",
        turnSummary: "Unsafe appeal.",
        operations: [{
          type: "create_entity",
          entity: {
            id: "npc:invented",
            kind: "person",
            name: "Invented NPC",
            status: "alive",
            tags: [],
            description: "Unsupported.",
            establishedFacts: [],
            secrets: [],
            playerKnowledge: [],
          },
        }],
      },
      provider: "fake",
      model: "fake-model",
    })).rejects.toThrow(/may create only a missing item/);
    expect((await store.load()).manifest.turn).toBe(0);
  });

  it("rejects appeal item renames that bypass canonical duplicate-name checks", async () => {
    const createdItemStore = await createTestStore();
    await expect(createdItemStore.commitTurn({
      kind: "appeal",
      action: ":appeal Add a second travel sword under a temporary name.",
      resolved: {
        narration: "The unsafe duplicate is proposed.",
        turnSummary: "Unsafe duplicate item rename.",
        operations: [
          {
            type: "create_entity",
            entity: {
              id: "item:temporary",
              kind: "item",
              name: "Temporary Blade",
              status: "intact",
              tags: [],
              description: "A temporary item name.",
              establishedFacts: [],
              secrets: [],
              playerKnowledge: [],
            },
          },
          { type: "change_inventory", ownerId: "player:hero", itemId: "item:temporary", quantityDelta: 1 },
          { type: "set_entity_state", targetId: "item:temporary", name: "The Travel Sword" },
        ],
      },
      provider: "fake",
      model: "fake-model",
    })).rejects.toThrow(/rename .* duplicates an existing item/);
    expect((await createdItemStore.load()).manifest.turn).toBe(0);

    const existingItemStore = await createTestStore();
    await existingItemStore.commitTurn({
      action: "A lantern is established on the tavern bar.",
      resolved: {
        narration: "A lantern rests on the tavern bar.",
        turnSummary: "A lantern was established.",
        operations: [{
          type: "create_entity",
          entity: {
            id: "item:lantern",
            kind: "item",
            name: "Lantern",
            status: "intact",
            location: "location:crooked-crown",
            tags: [],
            description: "A plain lantern.",
            establishedFacts: [],
            secrets: [],
            playerKnowledge: [],
          },
        }],
      },
      provider: "fake",
      model: "fake-model",
    });
    await expect(existingItemStore.commitTurn({
      kind: "appeal",
      action: ":appeal Rename my sword to match the lantern.",
      resolved: {
        narration: "The unsafe rename is proposed.",
        turnSummary: "Unsafe existing item rename.",
        operations: [
          { type: "set_entity_state", targetId: "item:travel-sword", name: "A Lantern" },
        ],
      },
      provider: "fake",
      model: "fake-model",
    })).rejects.toThrow(/rename .* duplicates an existing item/);
    expect((await existingItemStore.load()).manifest.turn).toBe(1);
    expect((await existingItemStore.load()).entities.get("item:travel-sword")?.name).toBe("Travel Sword");
  });
});
