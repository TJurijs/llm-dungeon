import { describe, expect, it } from "vitest";
import {
  campaignHtmlFilename,
  campaignMarkdownFilename,
  renderCampaignHtml,
  renderCampaignMarkdown,
} from "../src/campaign-export.js";
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

function completedStory(
  story = ["A", ...Array.from({ length: 399 }, () => "memory")].join(" "),
): NonNullable<CampaignLogSnapshot["completedStory"]> {
  return {
    schemaVersion: 1,
    campaignId: "campaign:test",
    sourceRevision: "completed-revision",
    sourceTurn: 2,
    campaignStatus: "ended",
    provider: "test",
    model: "test-model",
    generatedAt: "2026-07-17T10:16:00.000Z",
    story,
  };
}

describe("campaign Markdown export", () => {
  it("renders the complete player-visible story, checks, and appeals", () => {
    const snapshot: CampaignLogSnapshot = {
      state: state(),
      playerName: "Elian Voss",
      setup: {
        premise: "A royal courier disappears.",
        character: "**Elian Voss**, a disgraced investigator.",
        language: "en",
        worldRules: "# The Crownlands\n\n- **Intrigue** has consequences.",
      },
      completedStory: completedStory(),
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
    expect(markdown).toContain("## Campaign setup");
    expect(markdown).toContain("### Character concept");
    expect(markdown).toContain("**Elian Voss**, a disgraced investigator.");
    expect(markdown).toContain("### Language\n\nEnglish");
    expect(markdown.indexOf("### World and DM style")).toBeLessThan(
      markdown.indexOf("### Language"),
    );
    expect(markdown).toContain("## Campaign story\n\nA memory memory");
    expect(markdown.indexOf("## Campaign story")).toBeLessThan(markdown.indexOf("## Turn log"));
    expect(markdown).toContain("## Turn log");
    expect(markdown).toContain("### Opening");
    expect(markdown).toContain("### Turn 1");
    expect(markdown).toContain("#### Elian Voss");
    expect(markdown).toContain("> I inspect the seal.\n> Carefully.");
    expect(markdown).toContain("#### D100 check");
    expect(markdown).toContain("&lt;script&gt;bad()&lt;/script&gt;");
    expect(markdown).not.toContain("<script>");
    expect(markdown).toContain("### Appeal 2");
    expect(markdown).toContain("**Reviewed turn:** 1");
    expect(markdown).toContain("#### Decision");
    expect(markdown).not.toContain("A sealed letter arrived.");
    expect(markdown).not.toContain("The seal was identified.");
    expect(markdown).not.toContain("Summary");
  });

  it("renders a safe standalone reading page with chat-like turns and setup dialog", () => {
    const snapshot: CampaignLogSnapshot = {
      state: state(),
      playerName: "Elian <Voss>",
      setup: {
        premise: "Find the **missing courier**.",
        character: "A careful investigator.",
        language: "en",
        worldRules: "# Crownlands\n- Never trust raw <script>alert(1)</script> markup.",
      },
      completedStory: completedStory(
        ["<script>alert('story')</script>", ...Array.from({ length: 399 }, () => "memory")].join(
          " ",
        ),
      ),
      turns: [
        {
          turn: 0,
          kind: "opening",
          action: "Campaign begins.",
          narration: "Rain needles the windows.",
          summary: "Do not export this summary.",
        },
        {
          turn: 1,
          kind: "gameplay",
          action: "Inspect <the seal>.",
          narration: "The wax bears a split crown.",
          summary: "Nor this one.",
          checkText: "Investigation succeeds.",
        },
      ],
    };

    const html = renderCampaignHtml(snapshot);

    expect(html).toContain("<!doctype html>");
    expect(html).toContain('class="setup-button"');
    expect(html).toContain('<dialog id="campaign-setup">');
    expect(html).toContain('class="entry player"');
    expect(html).toContain('class="entry check"');
    expect(html).toContain('class="completed-story"');
    expect(html).toContain("Campaign story");
    expect(html).toContain("&lt;script&gt;alert(&#39;story&#39;)&lt;/script&gt;");
    expect(html).not.toContain("<script>alert('story')</script>");
    expect(html).toContain("Elian &lt;Voss&gt;");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).not.toContain("Do not export this summary.");
    expect(html).not.toContain("Nor this one.");
    expect(campaignHtmlFilename("The Crooked Crown")).toBe("The Crooked Crown.html");
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
    expect(markdown).not.toContain("## История кампании");
    expect(campaignMarkdownFilename("Эхо: Чужих / Мыслей")).toBe("Эхо- Чужих - Мыслей.md");
    expect(campaignMarkdownFilename("... ")).toBe("llm-dungeon-campaign.md");
  });

  it("uses localized copy for a persisted completed story", () => {
    const markdown = renderCampaignMarkdown({
      state: state({ language: "ru", status: "ended" }),
      playerName: "Элиан Восс",
      completedStory: completedStory(),
      turns: [],
    });

    expect(markdown).toContain("## История кампании");
    expect(markdown.indexOf("## История кампании")).toBeLessThan(
      markdown.indexOf("## Журнал ходов"),
    );
  });
});
