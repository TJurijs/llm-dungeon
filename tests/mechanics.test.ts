import { describe, expect, it } from "vitest";
import { formatCheck, resolveCheck } from "../src/mechanics.js";

const check = {
  name: "Climb",
  difficulty: 60,
  modifiers: [{ label: "Good rope", value: 10 }],
  successStakes: "Reach the roof.",
  failureStakes: "Fall and become injured.",
};

describe("d100 mechanics", () => {
  it("formats visible checks in Russian", () => {
    const result = resolveCheck({ name: "Скрытность", difficulty: 50, modifiers: [], successStakes: "Пройти.", failureStakes: "Быть замеченным." }, 60);
    expect(formatCheck(result, "ru")).toContain("Нет модификаторов");
    expect(formatCheck(result, "ru")).toContain("Итого 60, сложность 50 — УСПЕХ");
  });

  it("uses margin bands", () => {
    expect(resolveCheck(check, 80).outcome).toBe("exceptional_success");
    expect(resolveCheck(check, 50).outcome).toBe("success");
    expect(resolveCheck(check, 30).outcome).toBe("failure");
    expect(resolveCheck(check, 10).outcome).toBe("severe_failure");
  });

  it("makes natural 1 and 100 critical regardless of total", () => {
    expect(resolveCheck({ ...check, difficulty: 5, modifiers: [{ label: "Easy", value: 30 }] }, 1).outcome).toBe("severe_failure");
    expect(resolveCheck({ ...check, difficulty: 95, modifiers: [{ label: "Hard", value: -30 }] }, 100).outcome).toBe("exceptional_success");
  });

  it("rejects an excessive combined modifier", () => {
    expect(() => resolveCheck({ ...check, modifiers: [{ label: "A", value: 30 }, { label: "B", value: 30 }] }, 50)).toThrow(/combined modifiers/);
  });
});
