import { describe, expect, it } from "vitest";
import {
  committedTerminalTurns,
  hasUnpairedPlayerAction,
  migrateTerminalEntries,
  normalizeTerminalEntry,
  parseTerminalHistory,
  serializeTerminalHistory,
  terminalStorageKey,
} from "../web/terminal-history.js";

describe("browser terminal history", () => {
  it("normalizes untrusted local storage entries conservatively", () => {
    expect(normalizeTerminalEntry(null)).toBeNull();
    expect(normalizeTerminalEntry({
      title: "x".repeat(600),
      text: "y".repeat(50_100),
      mode: "unknown",
      channel: "unknown",
      kind: "unknown",
      turn: -1,
      appealTargetTurn: 0,
    })).toEqual({
      title: "x".repeat(500),
      text: "y".repeat(50_000),
      mode: "normal",
      channel: "game",
    });
  });

  it("migrates legacy entries into their presentation channels and turn metadata", () => {
    const entries = migrateTerminalEntries([
      { title: "AUTO-RUN — session-001", text: "start" },
      { title: "Explorer — OPENING", text: "opening" },
      { title: "YOU — TURN 1", text: "action" },
      { title: "D100 CHECK", text: "roll" },
      { title: "DUNGEON MASTER — TURN 1", text: "result" },
      { title: "CAMPAIGN PREVIEW — Example", text: "preview" },
      { title: "CONNECTION + REQUIRED SCHEMAS OK", text: "provider" },
      { title: "WORLD RULES SAVED", text: "world" },
      { title: "CAMPAIGN BEGINS — Example", text: "game" },
    ]);

    expect(entries.map((entry) => entry.channel)).toEqual([
      "evaluations",
      "evaluations",
      "evaluations",
      "evaluations",
      "evaluations",
      "campaign",
      "provider",
      "world",
      "game",
    ]);
    expect(entries.at(-1)).toMatchObject({ kind: "opening", turn: 0 });
  });

  it("drops obsolete transcript and inspection cache entries during parsing", () => {
    const parsed = parseTerminalHistory(JSON.stringify({
      version: 2,
      entries: [
        { title: "TRANSCRIPT — session-001", text: "# Self-Play Transcript: old", channel: "evaluations" },
        { title: "CHARACTER", text: "old inspection", channel: "game" },
        { title: "DUNGEON MASTER — TURN 2", text: "kept", channel: "game" },
      ],
    }));

    expect(parsed).toEqual({
      entries: [expect.objectContaining({ title: "DUNGEON MASTER — TURN 2", kind: "gameplay", turn: 2 })],
      migrated: true,
    });
    expect(parseTerminalHistory("not-json")).toEqual({ entries: [], migrated: false });
    expect(parseTerminalHistory(JSON.stringify({ version: 99, entries: [] }))).toEqual({ entries: [], migrated: false });
  });

  it("bounds persisted history by entry count and storage size", () => {
    const many = Array.from({ length: 310 }, (_, index) => ({ title: String(index), text: "ok" }));
    const capped = serializeTerminalHistory(many);
    expect(capped.entries).toHaveLength(300);
    expect(capped.entries[0].title).toBe("10");

    const large = serializeTerminalHistory(Array.from(
      { length: 20 },
      (_, index) => ({ title: String(index), text: "x".repeat(50_000) }),
    ));
    expect(large.serialized.length).toBeLessThanOrEqual(750_000);
    expect(large.entries.length).toBeLessThan(20);
    expect(JSON.parse(large.serialized)).toEqual({ version: 3, entries: large.entries });
  });

  it("reconciles only committed game turns and pending matching player actions", () => {
    const entries = [
      { channel: "game", title: "CAMPAIGN", text: "opening", kind: "opening", turn: 0 },
      { channel: "evaluations", title: "DM", text: "not a game turn", kind: "gameplay", turn: 8 },
      { channel: "game", title: "DM", text: "reply", kind: "gameplay", turn: 1 },
      { channel: "game", title: "YOU", text: "Ask about the bridge" },
    ];

    expect([...committedTerminalTurns(entries)]).toEqual([0, 1]);
    expect(hasUnpairedPlayerAction(entries, "Ask about the bridge")).toBe(true);
    expect(hasUnpairedPlayerAction(entries, "Open the door")).toBe(false);
    expect(terminalStorageKey(null)).toBe("llm-dungeon:web-cli-terminal:no-campaign");
  });
});
