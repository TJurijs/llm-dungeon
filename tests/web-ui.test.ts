import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { BrowserChatHistory, chatEntryPresentation, generationTooltip } from "../web/chat-ui.js";
import { UI_COPY, localeCopy } from "../web/ui-copy.js";
import {
  campaignCostText,
  llmModelEntries,
  modelChoice,
  modelValue,
  submitShortcut,
} from "../web/ui-utils.js";

describe("web UI copy", () => {
  it("keeps complete English and Russian chat controls and a platform-specific submit shortcut", async () => {
    const app = await readFile(path.join(process.cwd(), "web", "app.js"), "utf8");
    expect(UI_COPY.ru.newCampaign).toBe("Новая кампания");
    expect(UI_COPY.ru.actionPlaceholder).toBe("Что вы делаете?");
    expect(UI_COPY.ru.llmConfiguration).toBe("Настройки LLM");
    expect(UI_COPY.en.llmConfigurationHint).toContain(".env");
    expect(UI_COPY.en.workingHint).not.toContain(":retry");
    expect(Object.keys(UI_COPY.ru).sort()).toEqual(Object.keys(UI_COPY.en).sort());
    expect(submitShortcut({ platform: "MacIntel" })).toBe("⌘ + Enter");
    expect(submitShortcut({ platform: "Win32" })).toBe("Ctrl + Enter");
    expect(UI_COPY.ru.submitHint).not.toContain("Ctrl/⌘");
    expect(localeCopy("ru", "exportCampaign")).toBe("Экспорт журнала");
    expect(localeCopy("unsupported", "newCampaign")).toBe("New campaign");
    expect(app).toContain('campaignApiPath(campaignId, "export")');
  });

  it("uses a semantic campaign sidebar, streamlined setup, settings, and state dock", async () => {
    const html = await readFile(path.join(process.cwd(), "web", "index.html"), "utf8");
    expect(html).toContain('id="campaign-sidebar" class="sidebar"');
    expect(html).toContain('id="new-campaign"');
    expect(html).toContain('id="campaign-list"');
    expect(html).toContain('id="chat-log" class="chat-log" role="log"');
    expect(html).toContain('id="campaign-setup-form"');
    expect(html).not.toContain('id="setup-advanced"');
    expect(html).toContain('id="setup-world-settings" class="advanced-settings"');
    expect(html).toContain('id="setup-world"');
    expect(html).not.toContain('id="setup-temperature"');
    expect(html).not.toContain('id="setup-max-tokens"');
    expect(html).not.toContain('id="settings-temperature"');
    expect(html).not.toContain('id="settings-max-tokens"');
    expect(html).toContain('id="setup-model-settings" class="advanced-settings"');
    expect(html).toContain('id="setup-provider"');
    expect(html).toContain('id="setup-model"');
    expect(html).toContain('id="campaign-model"');
    const composerStart = html.indexOf('<div class="composer">');
    const composerEnd = html.indexOf("</footer>", composerStart);
    const campaignModel = html.indexOf('id="campaign-model"');
    expect(campaignModel).toBeGreaterThan(composerStart);
    expect(campaignModel).toBeLessThan(composerEnd);
    expect(html.slice(0, composerStart)).not.toContain('id="campaign-model"');
    expect(html).toContain('id="open-campaign-setup"');
    expect(html).toContain('id="campaign-setup-dialog"');
    expect(html).toContain('id="archive-campaign-dialog"');
    expect(html).toContain('data-i18n="globalDefaults"');
    expect(html).toContain('data-i18n="llmProviders"');
    expect(html).toContain('class="settings-navigation"');
    expect(html).toContain('data-settings-section="defaults"');
    expect(html).toContain('data-settings-section="providers"');
    expect(html).toContain('data-settings-panel="defaults"');
    expect(html).toContain('data-settings-panel="providers"');
    expect(html).toContain('id="llm-pricing-hint"');
    expect(html).toContain('data-i18n="qualityLegend"');
    expect(html).toContain('id="llm-providers" class="llm-provider-list"');
    expect(html).not.toContain('id="settings-api-key"');
    expect(html).not.toContain('id="settings-provider"');
    expect(html).toContain('id="open-inspection" class="icon-button" type="button" aria-label="Campaign state" title="Campaign state"');
    expect(html).toContain('id="close-sidebar" class="icon-button"');
    expect(html).toContain('class="icon-button sidebar-opener sidebar-open-button"');
    expect(html).toContain('<path d="M8.5 4v16"></path>');
    expect(html).toContain('<path d="M15.5 4v16"></path>');
    expect(html).toContain('id="inspection-panel" class="state-dock"');
    expect(html).toContain('id="sidebar-resizer"');
    expect(html).toContain('id="inspection-resizer"');
    expect(html).toContain('data-view="character"');
    expect(html).toContain('data-view="location"');
    expect(html).toContain('data-view="threads"');
  });

  it("leaves developer evaluation and prompt inspection tools out of the Web surface", async () => {
    const [app, html] = await Promise.all([
      readFile(path.join(process.cwd(), "web", "app.js"), "utf8"),
      readFile(path.join(process.cwd(), "web", "index.html"), "utf8"),
    ]);
    for (const removed of ["/api/evaluations", "/api/config/prompts", "Self-play auto-runs", "Prompt inspector"]) {
      expect(app).not.toContain(removed);
      expect(html).not.toContain(removed);
    }
  });

  it("keeps every concurrently running model probe visibly in progress", async () => {
    const setup = await readFile(path.join(process.cwd(), "web", "setup-settings.js"), "utf8");
    expect(setup).toContain("const testingModels = new Set()");
    expect(setup).toContain("testingModels.add(testKey)");
    expect(setup).toContain("testingModels.delete(testKey)");
    expect(setup).toContain('status: "testing"');
  });

  it("does not expose or record a browser activity log", async () => {
    const [app, setup, html, copy] = await Promise.all([
      readFile(path.join(process.cwd(), "web", "app.js"), "utf8"),
      readFile(path.join(process.cwd(), "web", "setup-settings.js"), "utf8"),
      readFile(path.join(process.cwd(), "web", "index.html"), "utf8"),
      readFile(path.join(process.cwd(), "web", "ui-copy.js"), "utf8"),
    ]);
    const surface = [app, setup, html, copy].join("\n");
    for (const removed of ["open-activity", "activity-dialog", "ACTIVITY_STORAGE_KEY", "recordActivity", "activityLog"]) {
      expect(surface).not.toContain(removed);
    }
  });

  it("provides a responsive drawer, touch-sized composer controls, and reduced-motion behavior", async () => {
    const styles = await readFile(path.join(process.cwd(), "web", "styles.css"), "utf8");
    expect(styles).toContain("@media (max-width: 760px)");
    expect(styles).toContain("body.sidebar-open .sidebar");
    expect(styles).toContain("min-width: 44px; min-height: 42px");
    expect(styles).toContain("@media (prefers-reduced-motion: reduce)");
    expect(styles).toContain("body.inspection-open .app-shell");
    expect(styles).toContain("body.inspection-open #open-inspection { display: none; }");
    expect(styles).toContain("body.sidebar-collapsed .app-shell");
    expect(styles).toContain("body.sidebar-collapsed .sidebar-open-button");
    expect(styles).toContain(".icon-button.sidebar-open-button { display: none; }");
    expect(styles).toContain("cursor: col-resize");
    expect(styles).toContain(".composer-model-picker");
    expect(styles).toContain(".llm-provider-list");
    expect(styles).toContain(".llm-provider-list { display: grid; grid-template-columns: minmax(0, 1fr);");
    expect(styles).toContain(".llm-model-row");
    expect(styles).toContain(".settings-navigation-item[aria-current=\"page\"]");
    expect(styles).toContain(".llm-provider-card[open]");
    expect(styles).toContain(".llm-provider-tools-panel");
    expect(styles).toContain(".composer-model-picker option");
  });

  it("uses meaningful transcript identities and offers permanent deletion only beside archived campaigns", async () => {
    const [app, chat, styles] = await Promise.all([
      readFile(path.join(process.cwd(), "web", "app.js"), "utf8"),
      readFile(path.join(process.cwd(), "web", "chat-ui.js"), "utf8"),
      readFile(path.join(process.cwd(), "web", "styles.css"), "utf8"),
    ]);
    expect(chatEntryPresentation({ title: "You", text: "Act", mode: "normal" })).toMatchObject({ type: "user", icon: "player" });
    expect(chatEntryPresentation({ title: "D100 check", text: "Roll", mode: "normal" })).toMatchObject({ type: "check", icon: "◆" });
    expect(generationTooltip({ provider: "openrouter", model: "moonshotai/kimi-k2.6", costUsd: 0.0042, costBasis: "exact" }))
      .toBe("openrouter · moonshotai/kimi-k2.6 · $0.0042");
    expect(generationTooltip({ provider: "gemini", model: "gemini-3.5-flash", costUsd: 0.024, costBasis: "estimated" }))
      .toBe("gemini · gemini-3.5-flash · ≈$0.02");
    expect(chat).toContain('presentation.type === "user" && playerName ? playerName : entry.title');
    expect(app).toContain('body.playerName.trim()');
    expect(app).toContain('deleteButton.dataset.deleteCampaignId = campaign.campaignId');
    expect(app).toContain('method: "DELETE"');
    expect(app).toContain('event.target.value !== campaign.title');
    expect(app).not.toContain('confirm(formatTemplate("deleteCampaignConfirm"');
    expect(app).not.toContain("confirm(t(\"archiveConfirm\"))");
    expect(app).toContain('campaignApiPath(campaignId, "setup")');
    expect(app).toContain('$("#archive-campaign-dialog").showModal()');
    expect(styles).toContain(".delete-campaign-button svg");
  });

  it("keeps model IDs reversible and selects only tested, enabled models with keys", () => {
    const value = modelValue("openrouter", "google/gemini-3.5-flash");
    expect(modelChoice(value)).toEqual({ provider: "openrouter", model: "google/gemini-3.5-flash" });
    expect(modelChoice("invalid")).toBeNull();
    const llm = {
      providers: [
        {
          id: "openrouter", label: "OpenRouter", envKey: "OPENROUTER_API_KEY", keyPresent: true,
          models: [
            { id: "ready", label: "Ready", status: "compatible", enabled: true, available: true, testedLanguages: ["en", "ru"] },
            { id: "off", label: "Off", status: "compatible", enabled: false, available: true, testedLanguages: ["en", "ru"] },
            { id: "failed", label: "Failed", status: "failed", enabled: false, available: false, testedLanguages: [] },
            { id: "retired", label: "Retired", status: "compatible", enabled: true, available: true, testedLanguages: ["en", "ru"], hidden: true },
          ],
        },
        {
          id: "openai", label: "OpenAI", envKey: "OPENAI_API_KEY", keyPresent: false,
          models: [{ id: "no-key", label: "No key", status: "compatible", enabled: true, available: true, testedLanguages: ["en", "ru"] }],
        },
      ],
    };
    expect(llmModelEntries(llm)).toHaveLength(4);
    expect(llmModelEntries(llm, { includeHidden: true })).toHaveLength(5);
    expect(llmModelEntries(llm, { availableOnly: true, requireKey: true, language: "ru" }))
      .toEqual([expect.objectContaining({ provider: "openrouter", model: "ready", envKey: "OPENROUTER_API_KEY" })]);
  });

  it("uses global world and tested model defaults for streamlined campaign setup", async () => {
    const [app, setup] = await Promise.all([
      readFile(path.join(process.cwd(), "web", "app.js"), "utf8"),
      readFile(path.join(process.cwd(), "web", "setup-settings.js"), "utf8"),
    ]);
    expect(setup).toContain('$("#setup-world")');
    expect(setup).toContain('...(worldRules.trim() ? { worldRules } : {})');
    expect(setup).toContain('$("#setup-provider")');
    expect(setup).toContain('$("#setup-model")');
    expect(setup).toContain("config,");
    expect(setup).toContain("status.llm?.defaultModel");
    expect(setup).toContain('"/api/llm/models/test"');
    expect(setup).toContain('"/api/llm/models"');
    expect(setup).toContain('"/api/llm/default"');
    expect(setup).toContain("customModelProvider");
    expect(setup).toContain('addEventListener("submit", handleCustomModel)');
    expect(setup).toContain("result.ok === false");
    expect(setup).toContain("estimated50TurnsUsd");
    expect(setup).toContain("pricingEstimateHint");
    expect(setup).toContain('"/api/llm/keys"');
    expect(setup).toContain("dataset.providerKeyForm");
    expect(setup).toContain("modelQualityCopy");
    expect(setup).toContain('`model-recommended ${model.recommended ? "" : "is-empty"}`');
    expect(setup).toContain('createElement("details", "llm-provider-tools")');
    expect(setup).toContain("createOverflowIcon");
    expect(setup).toContain('row.classList.add("is-default")');
    expect(setup).toContain('createElement("details", "llm-provider-card")');
    expect(setup).toContain("* 10) / 10");
    expect(UI_COPY.en.estimated50Turns).toBe("≈{price}");
    expect(UI_COPY.en.qualityLegend).toContain("High — strongest");
    expect(setup).toContain("return status.llm?.defaultModel ?? null");
    expect(setup).not.toContain("status.llm?.defaultModel ?? (status.config");
    expect(setup).not.toContain("apiKey");
    expect(setup).not.toContain("/api/config/provider");
    expect(setup).toContain('runSetupOperation($("#generate-campaign"), t("working"), initializeSetup)');
    expect(setup).toContain("if (requestId !== setupGenerationSequence) return;");
    expect(setup).toContain('$("#campaign-setup-form").addEventListener("input", invalidateDraft)');
    expect(app).toContain("const currentConfig = campaign?.config ?? status.llm?.defaultModel ?? status.config;");
    expect(app).toContain('body: JSON.stringify(choice)');
    expect(app).not.toContain("campaignModelConfig");
  });

  it("keeps composer drafts campaign-scoped and coalesces a fresh post-mutation poll", async () => {
    const app = await readFile(path.join(process.cwd(), "web", "app.js"), "utf8");
    expect(app).toContain("const actionDrafts = new Map();");
    expect(app).toContain("if (selectedCampaignId !== campaignId) saveActionDraft(selectedCampaignId);");
    expect(app).toContain("restoreActionDraft(campaignId);");
    expect(app).toContain("if (ensureFresh) statusRefreshQueued = true;");
    expect(app).toContain("} while (statusRefreshQueued);");
    expect(app).toContain('$(".main-pane").inert = mobile && (open || inspectionOpen);');
  });

  it("isolates locally cached chat history by campaign and presents turn kinds safely", () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); },
      removeItem: (key: string) => { values.delete(key); },
    };
    const history = new BrowserChatHistory(storage);
    history.append("campaign:one", { title: "You", text: "Open the door" });
    history.append("campaign:two", { title: "DM · Answer — no turn", text: "It is oak.", mode: "success" });

    expect(history.entries("campaign:one")).toEqual([expect.objectContaining({ text: "Open the door" })]);
    expect(history.entries("campaign:two")).toEqual([expect.objectContaining({ text: "It is oak." })]);
    expect(values.size).toBe(2);
    expect(chatEntryPresentation(history.entries("campaign:one")[0])).toMatchObject({ type: "user" });
    expect(chatEntryPresentation(history.entries("campaign:two")[0])).toMatchObject({ type: "question" });
    history.replace("campaign:one", [{ title: "DM", text: "Reconciled", kind: "gameplay", turn: 1 }]);
    expect(history.entries("campaign:one")).toEqual([expect.objectContaining({ text: "Reconciled", turn: 1 })]);
    history.remove("campaign:one");
    expect(history.entries("campaign:one")).toEqual([]);
  });

  it("labels only measurable campaign costs and marks estimates", () => {
    expect(campaignCostText(undefined, "Cost")).toBe("");
    expect(campaignCostText({ totalUsd: 0.125, pricedTurns: 2, unpricedTurns: 0, basis: "exact" }, "Cost")).toBe("Cost $0.1250");
    expect(campaignCostText({ totalUsd: 0.125, pricedTurns: 2, unpricedTurns: 1, basis: "estimated" }, "Cost")).toBe("Cost ≈$0.1250");
  });
});
