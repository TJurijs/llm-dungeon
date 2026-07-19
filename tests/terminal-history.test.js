import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import {
  campaignApiPath,
  chooseCampaignId,
  mergeAuthoritativeTerminalEntries,
  migrateTerminalEntries,
  normalizeTerminalEntry,
  parseTerminalHistory,
  serializeTerminalHistory,
  sortCampaigns,
  terminalStorageKey,
} from "../web/terminal-history.js";
import { actionPrefillValue } from "../web/chat-ui.js";

describe("browser terminal history", () => {
  it("preserves only safe model and reply-cost tooltip metadata", () => {
    expect(normalizeTerminalEntry({
      title: "DM",
      text: "Reply",
      generation: { provider: "openrouter", model: "vendor/model", costUsd: 0.0042, costBasis: "exact", inputTokens: 999 },
    })).toMatchObject({
      generation: { provider: "openrouter", model: "vendor/model", costUsd: 0.0042, costBasis: "exact" },
    });
    expect(normalizeTerminalEntry({ title: "DM", text: "Reply", generation: { provider: "", model: "secret" } }))
      .not.toHaveProperty("generation");
  });

  it("uses the exported normalization helper in the browser entry point", async () => {
    const [app, chat] = await Promise.all([
      readFile(new URL("../web/app.js", import.meta.url), "utf8"),
      readFile(new URL("../web/chat-ui.js", import.meta.url), "utf8"),
    ]);
    expect(app).toContain("normalizeTerminalEntry,");
    expect(chat).toContain('const entry = normalizeTerminalEntry({ channel: "game", ...value });');
    expect(`${app}\n${chat}`).not.toContain("normalizedTerminalEntry");
    expect(app).toContain('if (result.kind === "question")');
    expect(app).toContain('campaignT("answerNoTurn")');
  });

  it("keeps global ask and appeal controls without repeating them on every turn", async () => {
    const [app, chat, html, styles] = await Promise.all([
      readFile(new URL("../web/app.js", import.meta.url), "utf8"),
      readFile(new URL("../web/chat-ui.js", import.meta.url), "utf8"),
      readFile(new URL("../web/index.html", import.meta.url), "utf8"),
      readFile(new URL("../web/styles.css", import.meta.url), "utf8"),
    ]);

    expect(html).toContain('id="ask-generic" class="prefill-button ask-button"');
    expect(html).toContain('id="appeal-generic" class="prefill-button appeal-button"');
    expect(html).toContain('<circle cx="12" cy="12" r="9"></circle>');
    expect(html).toContain('<path d="M12 3 2.7 20h18.6L12 3Z"></path>');
    expect(html).not.toContain('id="retry"');
    expect(html).not.toContain('id="discard"');
    expect(app).toContain('$("#ask-generic").addEventListener("click", () => prefillAsk())');
    expect(app).toContain('$("#appeal-generic").addEventListener("click", () => prefillAppeal())');
    expect(`${app}\n${chat}`).not.toContain("createTurnActions");
    expect(app).not.toContain("data-ask-turn");
    expect(app).not.toContain("data-appeal-turn");
    expect(app).not.toContain("--turn");
    expect(styles).not.toContain(".chat-turn-actions");
    expect(app).toContain('const endpoint = action === ":retry" ? "retry" : "play";');
    expect(app).toContain('if (action === ":discard")');
    expect(styles).toContain(".ask-button:hover");
    expect(styles).toContain(".appeal-button:hover");
  });

  it("makes ask and appeal mutually exclusive while preserving the message", () => {
    expect(actionPrefillValue("", "ask")).toBe(":ask ");
    expect(actionPrefillValue("Is the northern door open?", "appeal")).toBe(":appeal Is the northern door open?");
    expect(actionPrefillValue(":ask Is the northern door open?", "appeal")).toBe(":appeal Is the northern door open?");
    expect(actionPrefillValue(":appeal That result contradicts the map.", "ask")).toBe(":ask That result contradicts the map.");
    expect(actionPrefillValue(":appeal :ask :appeal Why did that happen?", "ask")).toBe(":ask Why did that happen?");
    expect(actionPrefillValue(":appeal --turn 6 Karl was already there.", "appeal")).toBe(":appeal Karl was already there.");
  });

  it("keeps endpoint overrides out and accepts only unpersisted password-style session keys", async () => {
    const [app, html, copy, setup] = await Promise.all([
      readFile(new URL("../web/app.js", import.meta.url), "utf8"),
      readFile(new URL("../web/index.html", import.meta.url), "utf8"),
      readFile(new URL("../web/ui-copy.js", import.meta.url), "utf8"),
      readFile(new URL("../web/setup-settings.js", import.meta.url), "utf8"),
    ]);

    expect(html).not.toContain('id="endpoint"');
    expect(`${app}\n${setup}`).not.toContain('$("#endpoint")');
    expect(html).not.toContain('id="settings-api-key"');
    expect(`${app}\n${setup}`).not.toContain("apiKey:");
    expect(copy).toContain("Kept only in server memory until restart");
    expect(setup).toContain('keyInput.type = "password"');
    expect(setup).toContain('keyInput.autocomplete = "new-password"');
    expect(setup).toContain('"/api/llm/keys"');
    expect(setup).toContain('"/api/llm/models/test"');
  });

  it("builds encoded campaign-scoped paths and chooses a stable available campaign", () => {
    expect(campaignApiPath("campaign:one", "inspect")).toBe("/api/campaigns/campaign%3Aone/inspect");
    expect(campaignApiPath("campaign:one", "/play")).toBe("/api/campaigns/campaign%3Aone/play");
    expect(() => campaignApiPath("", "play")).toThrow("Campaign ID is required");

    const campaigns = [
      { campaignId: "campaign:old", updatedAt: "2026-01-01T00:00:00.000Z", archived: false },
      { campaignId: "campaign:archived", updatedAt: "2026-03-01T00:00:00.000Z", archived: true },
      { campaignId: "campaign:new", updatedAt: "2026-02-01T00:00:00.000Z", archived: false },
    ];
    expect(sortCampaigns(campaigns).map((campaign) => campaign.campaignId)).toEqual([
      "campaign:new",
      "campaign:old",
      "campaign:archived",
    ]);
    expect(chooseCampaignId(campaigns, "campaign:old")).toBe("campaign:old");
    expect(chooseCampaignId(campaigns, "campaign:missing")).toBe("campaign:new");
    expect(chooseCampaignId([], "campaign:missing")).toBeNull();
  });

  it("keeps async gameplay responses scoped to the campaign captured at submission", async () => {
    const source = await readFile(new URL("../web/app.js", import.meta.url), "utf8");
    expect(source).toContain("const campaignId = campaign?.campaignId;");
    expect(source).toContain('api(campaignApiPath(campaignId, endpoint)');
    expect(source).toContain("appendCommittedResponse(campaignId, result)");
    expect(source).toContain("if (selectedCampaignId === campaignId) renderChat({ scroll: true });");
    expect(source).toContain("const inFlightCampaigns = new Set();");
    expect(source).not.toContain("let gameBusy");
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

  it("uses a separate local-storage namespace for every campaign", () => {
    expect(terminalStorageKey(null)).toBe("llm-dungeon:web-terminal:no-campaign");
    expect(terminalStorageKey("campaign:one")).not.toBe(terminalStorageKey("campaign:two"));
  });

  it("merges a truncated cache with the complete transcript without moving old turns after new ones", () => {
    const opening = {
      title: "Campaign begins · Long Road",
      text: "Opening",
      mode: "success",
      channel: "game",
      kind: "opening",
      turn: 0,
    };
    const authoritative = [opening];
    for (let turn = 1; turn <= 220; turn += 1) {
      authoritative.push(
        { title: "You", text: `Action ${turn}`, mode: "normal", channel: "game" },
        { title: `Dungeon Master · Turn ${turn}`, text: `Result ${turn}`, mode: "success", channel: "game", kind: "gameplay", turn },
      );
    }

    const local = [...authoritative];
    const afterTurn210 = local.findIndex((entry) => entry.kind === "gameplay" && entry.turn === 210) + 1;
    local.splice(
      afterTurn210,
      0,
      { title: "You", text: ":ask Is the bridge stable?", mode: "normal", channel: "game" },
      { title: "DM · Answer — no turn", text: "It looks weathered.", mode: "success", channel: "game" },
    );
    const beforeTurn215 = local.findIndex((entry) => entry.kind === "gameplay" && entry.turn === 215);
    local.splice(beforeTurn215, 0, { title: "Error", text: "The first response failed.", mode: "error", channel: "game" });
    local.push(
      { title: "You", text: "Pending action", mode: "normal", channel: "game" },
      { title: "Error", text: "Resume is available.", mode: "error", channel: "game" },
    );

    const truncated = serializeTerminalHistory(local).entries;
    expect(truncated).toHaveLength(300);
    const reconciled = mergeAuthoritativeTerminalEntries(authoritative, truncated);
    const bounded = serializeTerminalHistory(reconciled).entries;
    const committedTurns = bounded
      .filter((entry) => entry.kind && Number.isSafeInteger(entry.turn))
      .map((entry) => entry.turn);

    expect(committedTurns).toEqual([...committedTurns].sort((left, right) => left - right));
    expect(committedTurns.at(-1)).toBe(220);
    expect(bounded.some((entry) => entry.turn === 0)).toBe(false);
    expect(bounded.filter((entry) => entry.text === "Action 215")).toHaveLength(1);

    const texts = bounded.map((entry) => entry.text);
    expect(texts.indexOf("Result 210")).toBeLessThan(texts.indexOf(":ask Is the bridge stable?"));
    expect(texts.indexOf(":ask Is the bridge stable?")).toBeLessThan(texts.indexOf("It looks weathered."));
    expect(texts.indexOf("It looks weathered.")).toBeLessThan(texts.indexOf("Action 211"));
    expect(texts.indexOf("Action 215")).toBeLessThan(texts.indexOf("The first response failed."));
    expect(texts.indexOf("The first response failed.")).toBeLessThan(texts.indexOf("Result 215"));
    expect(texts.indexOf("Result 220")).toBeLessThan(texts.indexOf("Pending action"));
    expect(texts.indexOf("Pending action")).toBeLessThan(texts.indexOf("Resume is available."));
  });
});
