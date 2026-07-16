import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("web UI copy", () => {
  it("uses a meaningful Russian prompt label and platform-specific submit shortcut", async () => {
    const source = await readFile(path.join(process.cwd(), "web", "app.js"), "utf8");
    expect(source).toContain('promptPhase: "Шаблон промпта"');
    expect(source).not.toContain('promptPhase: "Этап промпта"');
    expect(source).toContain('return /mac/i.test(platform) ? "⌘ + Enter" : "Ctrl + Enter"');
    expect(source).not.toContain("Ctrl/⌘ + Enter отправляет действие");
    expect(source).toContain('exportCampaign: "Экспорт журнала кампании (.md)"');
    expect(source).toContain('link.href = "/api/game/export?format=markdown"');
  });
});
