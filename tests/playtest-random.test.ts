import { describe, expect, it } from "vitest";
import { scriptedRollD100, seededRollD100 } from "../tools/playtest/harness/random.js";

describe("playtest roll policies", () => {
  it("replays a seeded stream exactly across resume", () => {
    const first = seededRollD100("campaign-seed");
    const values = Array.from({ length: 8 }, () => first());
    const resumed = seededRollD100("campaign-seed", 5);
    expect([resumed(), resumed(), resumed()]).toEqual(values.slice(5));
    expect(values.every((roll) => roll >= 1 && roll <= 100)).toBe(true);
  });

  it("uses declared certification rolls and fails when they are exhausted", () => {
    const roll = scriptedRollD100([100, 1]);
    expect(roll()).toBe(100);
    expect(roll()).toBe(1);
    expect(() => roll()).toThrow("exhausted");
  });
});
