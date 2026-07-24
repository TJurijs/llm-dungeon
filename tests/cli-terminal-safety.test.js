import { beforeEach, describe, expect, it, vi } from "vitest";

const promptMocks = vi.hoisted(() => ({
  select: vi.fn(),
}));

vi.mock("@clack/prompts", () => ({
  cancel: vi.fn(),
  isCancel: () => false,
  select: promptMocks.select,
}));

import { HumanGameCli } from "../src/cli/game.js";
import { createCliProgram } from "../src/cli/program.js";

function campaign(campaignId, title) {
  return {
    campaignId,
    title,
    turn: 2,
    status: "active",
    timeLabel: "Day 1",
    language: "en",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    archived: false,
  };
}

beforeEach(() => {
  promptMocks.select.mockReset();
});

describe("terminal output boundaries", () => {
  it("sanitizes campaign titles before presenting the interactive selector", async () => {
    const campaigns = [
      campaign("campaign:one", "\u001b]52;c;clipboard\u0007First"),
      campaign("campaign:two", "Second"),
    ];
    promptMocks.select.mockResolvedValue("campaign:one");
    const project = {
      campaigns: vi.fn(async () => campaigns),
      createEngine: vi.fn(async () => ({})),
    };

    const selected = await new HumanGameCli(project).selectCampaign();

    expect(selected.campaignId).toBe("campaign:one");
    const options = promptMocks.select.mock.calls[0][0].options;
    expect(options[0].label).not.toContain("\u001b");
    expect(options[0].label).not.toContain("\u0007");
  });

  it("sanitizes stored campaign and world-profile text printed by commands", async () => {
    const project = {
      campaigns: vi.fn(async () => [campaign("campaign:one", "\u001b]0;spoof\u0007Adventure")]),
      worldProfile: vi.fn(async () => ({
        source: "default",
        markdown: "\u001b]52;c;clipboard\u0007World rules",
      })),
    };
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      await createCliProgram(project).parseAsync(["node", "llm-dungeon", "campaigns"]);
      const campaignOutput = log.mock.calls.flat().join("\n");
      expect(campaignOutput).toContain("Adventure");
      expect(campaignOutput).not.toContain("\u001b]0;");
      expect(campaignOutput).not.toContain("\u0007");

      log.mockClear();
      await createCliProgram(project).parseAsync(["node", "llm-dungeon", "world", "show"]);
      const worldOutput = log.mock.calls.flat().join("\n");
      expect(worldOutput).toContain("World rules");
      expect(worldOutput).not.toContain("\u001b]52;");
      expect(worldOutput).not.toContain("\u0007");
    } finally {
      log.mockRestore();
    }
  });
});
