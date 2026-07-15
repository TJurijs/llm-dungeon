import { describe, expect, it } from "vitest";
import { formatQuestionCommand, parseQuestionCommand } from "../src/question.js";

describe("question command", () => {
  it("parses only explicit :ask syntax", () => {
    expect(parseQuestionCommand(":ask Can I use the environment for cover?")).toBe(
      "Can I use the environment for cover?",
    );
    expect(parseQuestionCommand(":asking an NPC about the road")).toBeUndefined();
    expect(parseQuestionCommand("Can I use the environment for cover?")).toBeUndefined();
    expect(formatQuestionCommand("  How do checks work? ")).toBe(":ask How do checks work?");
  });

  it("rejects empty and oversized questions", () => {
    expect(() => parseQuestionCommand(":ask")).toThrow(/requires text/);
    expect(() => parseQuestionCommand(`:ask ${"x".repeat(10_001)}`)).toThrow(/exceeds 10,000/);
  });
});
