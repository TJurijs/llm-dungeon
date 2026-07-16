import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
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
  it("uses the exported normalization helper in the browser entry point", async () => {
    const source = await readFile(new URL("../web/app.js", import.meta.url), "utf8");
    expect(source).toContain("normalizeTerminalEntry,");
    expect(source).toContain("const entry = normalizeTerminalEntry(");
    expect(source).not.toContain("normalizedTerminalEntry");
    expect(source).toContain('if (result.kind === "question")');
    expect(source).toContain('t("answerHeading")');
  });

  it("uses distinct ask and appeal prefill icons and command-only pending recovery", async () => {
    const [app, html, styles] = await Promise.all([
      readFile(new URL("../web/app.js", import.meta.url), "utf8"),
      readFile(new URL("../web/index.html", import.meta.url), "utf8"),
      readFile(new URL("../web/styles.css", import.meta.url), "utf8"),
    ]);

    expect(html).toContain('id="ask-generic" class="action-prefill-button ask-button"');
    expect(html).toContain('id="appeal-generic" class="action-prefill-button appeal-button"');
    expect(html).toContain('<circle cx="12" cy="12" r="9"></circle>');
    expect(html).toContain('<path d="M12 3 2.7 20h18.6L12 3Z"></path>');
    expect(html).not.toContain('id="retry"');
    expect(html).not.toContain('id="discard"');
    expect(app).toContain('controls.append(createTurnPrefillButton("ask", turn), createTurnPrefillButton("appeal", turn));');
    expect(app).toContain('if (action === ":retry")');
    expect(app).toContain('if (action === ":discard")');
    expect(styles).toContain(".ask-button:hover");
    expect(styles).toContain(".appeal-button:hover");
  });

  it("keeps provider endpoints out of the Web form and explains the .env key fallback", async () => {
    const [app, html] = await Promise.all([
      readFile(new URL("../web/app.js", import.meta.url), "utf8"),
      readFile(new URL("../web/index.html", import.meta.url), "utf8"),
    ]);

    expect(html).not.toContain('id="endpoint"');
    expect(app).not.toContain('$("#endpoint")');
    expect(html).toContain("leave blank to use .env");
    expect(app).toContain("GEMINI_API_KEY or OPENROUTER_API_KEY from .env");
    expect(app).toContain('apiKey: $("#api-key").value.trim()');
  });

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
