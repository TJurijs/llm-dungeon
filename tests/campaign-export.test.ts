import { describe, expect, it } from "vitest";
import { campaignMarkdownFilename, renderCampaignMarkdown } from "../src/campaign-export.js";
import type { GameState } from "../src/schemas.js";
import type { CampaignLogSnapshot } from "../src/types.js";

function state(overrides: Partial<GameState> = {}): GameState {
  return {
    schemaVersion: 1,
    campaignId: "campaign:test",
    title: "The Crooked Crown",
    turn: 2,
    status: "active",
    playerId: "player:hero",
    currentLocationId: "location:tavern",
    elapsedMinutes: 15,
    timeLabel: "Day 1, 20:15",
    language: "en",
    createdAt: "2026-07-17T10:00:00.000Z",
    updatedAt: "2026-07-17T10:15:00.000Z",
    ...overrides,
  };
}

describe("campaign Markdown export", () => {
  it("renders the complete player-visible story, checks, and appeals", () => {
    const snapshot: CampaignLogSnapshot = {
      state: state(),
      playerName: "Elian Voss",
      turns: [
        {
          turn: 0,
          kind: "opening",
          action: "Campaign begins.",
          narration: "Rain needles the tavern windows.",
          summary: "A sealed letter arrived.",
        },
        {
          turn: 1,
          kind: "gameplay",
          action: "I inspect the seal.\nCarefully.",
          narration: "The wax bears a split crown. <script>bad()</script>",
          summary: "The seal was identified.",
          checkText: "Investigation: d100 = 42 vs difficulty 55 — SUCCESS",
        },
        {
          turn: 2,
          kind: "appeal",
          appealTargetTurn: 1,
          action: ":appeal --turn 1 The clue should be in my notes.",
          narration: "The review confirms that the clue is already recorded.",
          summary: "The appeal was confirmed without changing state.",
        },
      ],
    };

    const markdown = renderCampaignMarkdown(snapshot);

    expect(markdown).toContain("# The Crooked Crown");
    expect(markdown).toContain("## Opening");
    expect(markdown).toContain("## Turn 1");
    expect(markdown).toContain("> I inspect the seal.\n> Carefully.");
    expect(markdown).toContain("### D100 check");
    expect(markdown).toContain("&lt;script&gt;bad()&lt;/script&gt;");
    expect(markdown).not.toContain("<script>");
    expect(markdown).toContain("## Appeal 2");
    expect(markdown).toContain("**Reviewed turn:** 1");
    expect(markdown).toContain("### Decision");
  });

  it("uses campaign-language copy and creates filesystem-safe Unicode filenames", () => {
    const markdown = renderCampaignMarkdown({
      state: state({ title: "Эхо: Чужих / Мыслей", language: "ru", status: "ended" }),
      playerName: "Элиан Восс",
      turns: [],
    });

    expect(markdown).toContain("# Эхо: Чужих / Мыслей");
    expect(markdown).toContain("**Статус:** Завершена");
    expect(markdown).toContain("**Текущий ход:** 2");
    expect(campaignMarkdownFilename("Эхо: Чужих / Мыслей")).toBe("Эхо- Чужих - Мыслей.md");
    expect(campaignMarkdownFilename("... ")).toBe("llm-dungeon-campaign.md");
  });
});
