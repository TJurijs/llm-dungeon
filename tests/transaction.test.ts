import { describe, expect, it } from "vitest";
import {
  TransactionValidationError,
  applyTransaction,
} from "../src/domain/transaction.js";
import type { Entity, StateOperation } from "../src/schemas.js";
import { createTestStore } from "./helpers.js";

describe("transaction boundary", () => {
  it("resolves a suffix-only first owner for a newly created item", async () => {
    const store = await createTestStore();
    const result = await store.commitTurnWithResult({
      action: "I accept the brass key.",
      resolved: {
        narration: "Mara places a brass key in your hand.",
        turnSummary: "The hero received a brass key.",
        operations: [{
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
        }],
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

  it("wraps domain violations but lets parsing and programming failures escape", async () => {
    const loaded = await (await createTestStore()).load();
    const apply = (operations: StateOperation[], entities = loaded.entities) => applyTransaction(
      operations,
      1,
      loaded.manifest,
      entities,
      loaded.threads,
      loaded.chronicle,
    );

    expect(() => apply([{
      type: "change_inventory",
      ownerId: "player:hero",
      itemId: "item:missing",
      quantityDelta: -1,
    }])).toThrow(TransactionValidationError);

    const malformed = [{ type: "unknown_operation" }] as unknown as StateOperation[];
    expect(() => apply(malformed)).toThrow(expect.objectContaining({ name: "ZodError" }));
    expect(() => apply(malformed)).not.toThrow(TransactionValidationError);

    const brokenEntities = new Map<string, Entity>(loaded.entities);
    brokenEntities.set("broken", undefined as unknown as Entity);
    expect(() => apply([], brokenEntities)).toThrow(TypeError);
    expect(() => apply([], brokenEntities)).not.toThrow(TransactionValidationError);
  });
});
