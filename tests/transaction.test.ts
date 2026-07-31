import { describe, expect, it } from "vitest";
import {
  assertCampaignStateConsistency,
  inventoryCycleEdges,
  inventoryOwnershipSnapshot,
} from "../src/domain/state-consistency.js";
import { TransactionValidationError, applyTransaction } from "../src/domain/transaction.js";
import type { Entity, StateOperation } from "../src/schemas.js";
import { createTestStore } from "./helpers.js";

describe("transaction boundary", () => {
  it("rejects enlarged duplicate ownership at the whole-state boundary", async () => {
    const loaded = await (await createTestStore()).load();
    const projected = new Map(
      [...loaded.entities.entries()].map(([id, entity]) => [id, structuredClone(entity)]),
    );
    projected.get("location:crooked-crown")!.inventory.push({
      entityId: "item:travel-sword",
      quantity: 1,
    });

    expect(() =>
      assertCampaignStateConsistency(loaded.manifest, projected, loaded.threads, loaded.chronicle, {
        allowedInventoryCycleEdges: inventoryCycleEdges(loaded.entities),
        baselineInventoryOwnership: inventoryOwnershipSnapshot(loaded.entities),
      }),
    ).toThrow(/increases total quantity from 1 to 2/);

    const legacyBaseline = new Map(
      [...loaded.entities.entries()].map(([id, entity]) => [id, structuredClone(entity)]),
    );
    legacyBaseline
      .get("player:hero")!
      .inventory.find((entry) => entry.entityId === "item:travel-sword")!.quantity = 2;
    legacyBaseline.get("npc:mara-venn")!.inventory.push({
      entityId: "item:travel-sword",
      quantity: 1,
    });
    const spreadLegacyDuplicate = new Map(
      [...legacyBaseline.entries()].map(([id, entity]) => [id, structuredClone(entity)]),
    );
    spreadLegacyDuplicate
      .get("player:hero")!
      .inventory.find((entry) => entry.entityId === "item:travel-sword")!.quantity = 1;
    spreadLegacyDuplicate.get("location:crooked-crown")!.inventory.push({
      entityId: "item:travel-sword",
      quantity: 1,
    });

    expect(() =>
      assertCampaignStateConsistency(
        loaded.manifest,
        spreadLegacyDuplicate,
        loaded.threads,
        loaded.chronicle,
        {
          allowedInventoryCycleEdges: inventoryCycleEdges(legacyBaseline),
          baselineInventoryOwnership: inventoryOwnershipSnapshot(legacyBaseline),
        },
      ),
    ).toThrow(/spreads a legacy duplicate to a new owner/);
  });

  it("resolves a suffix-only first owner for a newly created item", async () => {
    const store = await createTestStore();
    const result = await store.commitTurnWithResult({
      action: "I accept the brass key.",
      resolved: {
        narration: "Mara places a brass key in your hand.",
        turnSummary: "The hero received a brass key.",
        operations: [
          {
            type: "create_entity",
            entity: {
              id: "item:brass-key",
              kind: "item",
              name: "Brass Key",
              status: "intact",
              location: "hero",
              tags: ["key"],
              description: "A small brass key.",
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

    const created = result.operations.find((operation) => operation.type === "create_entity");
    const credit = result.operations.find((operation) => operation.type === "change_inventory");
    expect(created?.entity.location).toBeUndefined();
    expect(credit).toMatchObject({
      ownerId: "player:hero",
      itemId: created?.entity.id,
      quantityDelta: 1,
    });

    const loaded = await store.load();
    expect(loaded.entities.get("player:hero")?.inventory).toContainEqual({
      entityId: created?.entity.id,
      quantity: 1,
    });
  });

  it("prunes newly introduced mutable or localized tags while retaining legacy tags", async () => {
    const loaded = await (await createTestStore()).load();
    const apply = (operations: StateOperation[], entities = loaded.entities) =>
      applyTransaction(operations, 1, loaded.manifest, entities, loaded.threads, loaded.chronicle);

    // A tag is optional machine taxonomy, so a forbidden one is removed and the
    // rest of the record commits. Rejecting the turn spent its one bounded
    // correction on the only part of the response that carried no meaning.
    const created = apply([
      {
        type: "create_entity",
        entity: {
          id: "npc:new-scout",
          kind: "person",
          name: "New Scout",
          status: "watchful",
          tags: ["frontier", "missing"],
          description: "A frontier scout.",
          establishedFacts: [],
          secrets: [],
          playerKnowledge: [],
        },
      },
    ]);
    const scout = [...created.entities.values()].find((entity) => entity.name === "New Scout");
    expect(scout?.tags).toEqual(["frontier"]);

    for (const tag of ["unknown", "known", "hidden", "discovered", "undiscovered"]) {
      const result = apply([
        { type: "set_entity_state", targetId: "npc:mara-venn", tags: ["innkeeper", tag] },
      ]);
      // Pruning leaves exactly the tags the entity already had, so the effect is
      // satisfied and never reaches the committed ledger.
      expect(result.operations).toEqual([]);
      expect(result.entities.get("npc:mara-venn")?.tags).toEqual(["innkeeper"]);
    }

    const nonMachine = apply([
      { type: "set_entity_state", targetId: "npc:mara-venn", tags: ["innkeeper", "\u0412\u043e\u043e\u0440\u0443\u0436\u0435\u043d\u0430"] },
    ]);
    expect(nonMachine.entities.get("npc:mara-venn")?.tags).toEqual(["innkeeper"]);

    // Pruning must never clear an established tag list it was not asked to
    // change: dropping the only supplied tag removes the field, not the tags.
    const soleForbidden = apply([
      { type: "set_entity_state", targetId: "npc:mara-venn", tags: ["hidden"] },
    ]);
    expect(soleForbidden.entities.get("npc:mara-venn")?.tags).toEqual(["innkeeper"]);
    expect(soleForbidden.operations).toEqual([]);

    const legacy = new Map(
      [...loaded.entities].map(([id, entity]) => [id, structuredClone(entity)]),
    );
    legacy.get("npc:mara-venn")!.tags.push("missing", "unknown");
    expect(() =>
      apply(
        [
          {
            type: "set_entity_state",
            targetId: "mara-venn",
            tags: ["innkeeper", "missing", "unknown", "community-leader"],
          },
        ],
        legacy,
      ),
    ).not.toThrow();
  });

  it("reports every admission fault in one collected correction", async () => {
    const loaded = await (await createTestStore()).load();
    let thrown: unknown;
    try {
      applyTransaction(
        [
          { type: "add_trait", targetId: "npc:nobody", trait: "Watchful" },
          { type: "transfer_item", fromId: "npc:mara-venn", toId: "npc:nobody-else", itemId: "item:travel-sword", quantity: 1 },
          {
            type: "add_fact",
            targetId: "player:hero",
            section: "established",
            factId: "generated:auto",
            text: "x".repeat(900),
          },
        ],
        1,
        loaded.manifest,
        loaded.entities,
        loaded.threads,
        loaded.chronicle,
      );
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(TransactionValidationError);
    const message = (thrown as Error).message;
    expect(message).toContain("Transaction validation failed:");
    // Each independent fault must be actionable from one correction rather
    // than consuming the whole bounded repair budget one at a time.
    expect(message).toContain("[durable_text_limit]");
    expect(message).toContain("[unknown_entity_reference]");
  });

  it("reports each unresolvable reference once instead of cascading", async () => {
    const loaded = await (await createTestStore()).load();
    let thrown: unknown;
    try {
      applyTransaction(
        [
          { type: "move_entity", targetId: "npc:mara-venn", locationId: "location:nowhere" },
          {
            type: "add_fact",
            targetId: "location:nowhere",
            section: "established",
            factId: "generated:auto",
            text: "A place that was never established.",
          },
          { type: "add_condition", targetId: "location:nowhere", condition: "sealed" },
          { type: "add_trait", targetId: "npc:also-missing", trait: "Watchful" },
        ],
        1,
        loaded.manifest,
        loaded.entities,
        loaded.threads,
        loaded.chronicle,
      );
    } catch (error) {
      thrown = error;
    }

    const message = (thrown as Error).message;
    // Both unknown IDs are named so one correction can fix the whole response,
    // but the three operations sharing one bad ID report it only once.
    expect(message).toContain("location:nowhere");
    expect(message).toContain("npc:also-missing");
    expect(message.match(/location:nowhere/gu)).toHaveLength(1);
  });

  it("drops already-satisfied operations from the ledger instead of failing the turn", async () => {
    const store = await createTestStore();
    const loaded = await store.load();
    const existingFact = loaded.entities
      .get("npc:mara-venn")!
      .facts.find((fact) => fact.section === "established")!;
    const thread = loaded.threads[0]!;

    const result = await store.commitTurnWithResult({
      action: "I confirm what I already know about Mara.",
      resolved: {
        narration: "Mara repeats what you already knew, and nothing about the room changes.",
        turnSummary: "Nothing new was established.",
        operations: [
          // Every one of these already holds; none should reject the turn.
          {
            type: "add_fact",
            targetId: "npc:mara-venn",
            section: "established",
            factId: "generated:auto",
            text: existingFact.text,
          },
          { type: "remove_condition", targetId: "npc:mara-venn", condition: "shaken" },
          {
            type: "set_relationship",
            sourceId: "npc:mara-venn",
            targetId: "player:hero",
            summary: "Wary but cooperative.",
          },
          {
            type: "set_relationship",
            sourceId: "npc:mara-venn",
            targetId: "player:hero",
            summary: "Wary but cooperative.",
          },
          {
            type: "update_thread",
            threadId: thread.id,
            summary: thread.summary,
          },
        ],
      },
      provider: "fake",
      model: "fake-model",
    });

    // The one genuine change survives; the rest never enter the durable ledger.
    expect(result.operations).toHaveLength(1);
    expect(result.operations[0]).toMatchObject({ type: "set_relationship" });

    const after = await store.load();
    expect(after.threads.find((candidate) => candidate.id === thread.id)?.summary).toBe(
      thread.summary,
    );
    expect(after.entities.get("npc:mara-venn")?.facts.filter((fact) => fact.active).length).toBe(
      loaded.entities.get("npc:mara-venn")!.facts.filter((fact) => fact.active).length,
    );
  });

  it("moves an actor only when the turn says so with move_entity", async () => {
    const store = await createTestStore();
    const loaded = await store.load();
    const origin = loaded.manifest.currentLocationId;

    const result = await store.commitTurnWithResult({
      action: "I lead Mara out to the watch post.",
      resolved: {
        narration: "You cross the road with Mara and stop at the old watch post.",
        turnSummary: "The hero and Mara reached the watch post.",
        operations: [
          {
            type: "create_entity",
            entity: {
              id: "location:watch-post",
              kind: "location",
              name: "Watch Post",
              status: "open",
              tags: [],
              description: "A stone post across the northern road.",
              establishedFacts: [],
              secrets: [],
              playerKnowledge: [],
            },
          },
          { type: "move_entity", targetId: "player:hero", locationId: "location:watch-post" },
          { type: "move_entity", targetId: "npc:mara-venn", locationId: "location:watch-post" },
        ],
      },
      provider: "fake",
      model: "fake-model",
    });

    const moves = result.operations.filter((operation) => operation.type === "move_entity");
    const destination = result.operations.find((operation) => operation.type === "create_entity")
      ?.entity.id;
    expect(moves.map((move) => move.targetId).sort()).toEqual(["npc:mara-venn", "player:hero"]);
    expect(new Set(moves.map((move) => move.locationId))).toEqual(new Set([destination]));

    const after = await store.load();
    expect(after.manifest.currentLocationId).toBe(destination);
    expect(after.entities.get("npc:mara-venn")?.location).toBe(destination);
    expect(after.manifest.currentLocationId).not.toBe(origin);
  });

  it("observes a closure that leaves no successor without blocking the turn", async () => {
    const loaded = await (await createTestStore()).load();
    const declarations = { threads: loaded.threads, playerId: loaded.manifest.playerId };
    const closure: StateOperation = {
      type: "resolve_thread",
      threadId: "$thread:1",
      outcome: "Answered.",
      status: "resolved",
    };
    const apply = (operations: StateOperation[]) =>
      applyTransaction(
        operations,
        1,
        loaded.manifest,
        loaded.entities,
        loaded.threads,
        loaded.chronicle,
        [],
        declarations,
      );

    // A campaign with no active thread is perfectly readable by a later turn, so
    // whether the fiction left something open is a judgment recorded for review
    // rather than a reason to spend the turn's one bounded correction.
    expect(apply([closure]).signals.map((signal) => signal.code)).toEqual([
      "thread_successor_required",
    ]);
    expect(
      apply([
        closure,
        {
          type: "create_thread",
          threadId: "generated:auto",
          title: "Who silenced the road",
          summary: "The answer exposed a new pursuit.",
          relatedEntityIds: [],
        },
      ]).signals,
    ).toEqual([]);
  });

  it("persists fact provenance and observes reported evidence with no source", async () => {
    const store = await createTestStore();
    const loaded = await store.load();
    const thread = loaded.threads[0]!;

    await store.commitTurnWithResult({
      action: "I ask Mara what she heard.",
      resolved: {
        narration: "Mara says a courier told her the north road bridge is out.",
        turnSummary: "Mara relayed a courier's report.",
        operations: [
          {
            type: "add_fact",
            targetId: "npc:mara-venn",
            section: "knowledge",
            factId: "generated:auto",
            text: "A courier told Mara the north road bridge is out.",
            basis: "reported",
            sourceId: "npc:mara-venn",
          },
        ],
      },
      provider: "fake",
      model: "fake-model",
    });

    // Provenance must survive the Markdown round trip, or evidence strength is
    // unmeasurable on every later turn.
    const after = await store.load();
    const persisted = after.entities
      .get("npc:mara-venn")!
      .facts.find((fact) => fact.text.startsWith("A courier told Mara"))!;
    expect(persisted).toMatchObject({ basis: "reported", sourceId: "npc:mara-venn" });

    // An unsourced inference is fully readable state; the missing provenance is
    // an evidence-discipline judgment, so it is observed instead of blocking.
    const unsourced = applyTransaction(
      [
        {
          type: "add_fact",
          targetId: "npc:mara-venn",
          section: "knowledge",
          factId: "generated:auto",
          text: "Someone must have sabotaged the bridge.",
          basis: "inferred",
        },
      ],
      1,
      loaded.manifest,
      loaded.entities,
      loaded.threads,
      loaded.chronicle,
      [],
      { threads: loaded.threads, playerId: loaded.manifest.playerId },
    );
    expect(unsourced.signals.map((signal) => signal.code)).toContain("fact_source_required");
  });

  it("resolves a thread ordinal to its ID so an ID can never be mistyped", async () => {
    const store = await createTestStore();
    const loaded = await store.load();
    const thread = loaded.threads[0]!;

    const result = await store.commitTurnWithResult({
      action: "I follow the lead north.",
      resolved: {
        narration: "The road gives up one more detail.",
        turnSummary: "The hero narrowed the lead.",
        // No thread ID anywhere in the model's output: only its number in the
        // active-thread list the context printed.
        operations: [
          { type: "update_thread", threadId: "$thread:1", summary: "A courier was seen." },
        ],
      },
      provider: "fake",
      model: "fake-model",
    });

    expect(result.operations).toEqual([
      expect.objectContaining({
        type: "update_thread",
        threadId: thread.id,
        summary: "A courier was seen.",
      }),
    ]);
    expect((await store.load()).threads[0]?.summary).toBe("A courier was seen.");
  });

  it("rejects a thread number that context never listed", async () => {
    const loaded = await (await createTestStore()).load();

    expect(() =>
      applyTransaction(
        [{ type: "update_thread", threadId: "$thread:9", summary: "Nowhere." }],
        1,
        loaded.manifest,
        loaded.entities,
        loaded.threads,
        loaded.chronicle,
        [],
        { threads: loaded.threads, playerId: loaded.manifest.playerId },
      ),
    ).toThrow(/outside the 1 active thread\(s\) supplied in context/u);
  });

  it("reports an out-of-range ordinal once instead of also as an unknown thread", async () => {
    const loaded = await (await createTestStore()).load();
    let violations: readonly { code: string }[] = [];
    try {
      applyTransaction(
        [{ type: "update_thread", threadId: "$thread:9", summary: "Nowhere." }],
        1,
        loaded.manifest,
        loaded.entities,
        loaded.threads,
        loaded.chronicle,
        [],
        { threads: loaded.threads, playerId: loaded.manifest.playerId },
      );
    } catch (error) {
      violations = (error as { violations?: readonly { code: string }[] }).violations ?? [];
    }

    // The unresolved hint stays on the operation so admission sees the whole
    // transaction, which puts it in front of reference normalization too. A
    // turn gets one bounded correction, so one fault must cost one message.
    expect(violations.map((violation) => violation.code)).toEqual([
      "thread_ordinal_out_of_range",
    ]);
  });

  it("classifies how a reference missed without repeating what it said", async () => {
    const loaded = await (await createTestStore()).load();
    const thread = loaded.threads[0]!;
    const stem = thread.id.replace(/-turn-\d+$/u, "");
    const classify = (threadId: string): string | undefined => {
      try {
        applyTransaction(
          [{ type: "update_thread", threadId, summary: "Progress." }],
          1,
          loaded.manifest,
          loaded.entities,
          loaded.threads,
          loaded.chronicle,
        );
        return undefined;
      } catch (error) {
        return (error as { violations?: { detail?: string }[] }).violations?.[0]?.detail;
      }
    };

    // Dropping the application's own turn suffix resolves to the one record it
    // can mean, so it is no longer reported at all.
    expect(classify(stem)).toBeUndefined();

    // It still has to be nameable where resolution cannot apply: the same stem
    // under the wrong namespace is a near miss, not an invention.
    expect(classify(stem.replace(/^thread:/u, "npc:"))).toBe("generated_suffix_variant");
    expect(classify(`${thread.id}-extra`)).toBe("stem_shared");
    expect(classify("npc:not-a-thread-namespace")).toBe("namespace_mismatch");
    expect(classify("thread:zzz")).toBe("unrecognized");
  });

  it("resolves a reference that drops the application's own generated suffix", async () => {
    const loaded = await (await createTestStore()).load();
    const thread = loaded.threads[0]!;

    const result = applyTransaction(
      [
        {
          type: "update_thread",
          threadId: thread.id.replace(/-turn-\d+$/u, ""),
          summary: "Progress.",
        },
      ],
      1,
      loaded.manifest,
      loaded.entities,
      loaded.threads,
      loaded.chronicle,
    );

    expect(result.threads.find((candidate) => candidate.id === thread.id)?.summary).toBe(
      "Progress.",
    );
  });

  it("wraps domain violations but lets parsing and programming failures escape", async () => {
    const loaded = await (await createTestStore()).load();
    const apply = (operations: StateOperation[], entities = loaded.entities) =>
      applyTransaction(operations, 1, loaded.manifest, entities, loaded.threads, loaded.chronicle);

    expect(() =>
      apply([
        {
          type: "change_inventory",
          ownerId: "player:hero",
          itemId: "item:missing",
          quantityDelta: -1,
        },
      ]),
    ).toThrow(TransactionValidationError);

    const malformed = [{ type: "unknown_operation" }] as unknown as StateOperation[];
    expect(() => apply(malformed)).toThrow(expect.objectContaining({ name: "ZodError" }));
    expect(() => apply(malformed)).not.toThrow(TransactionValidationError);

    const brokenEntities = new Map<string, Entity>(loaded.entities);
    brokenEntities.set("broken", undefined as unknown as Entity);
    expect(() => apply([], brokenEntities)).toThrow(TypeError);
    expect(() => apply([], brokenEntities)).not.toThrow(TransactionValidationError);
  });
});
