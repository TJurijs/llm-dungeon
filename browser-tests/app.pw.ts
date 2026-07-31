import { expect, test, type Page } from "@playwright/test";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ProviderConfig } from "../src/schemas.js";
import { createDungeonWebServer } from "../src/web-server.js";
import { CampaignCatalog } from "../src/campaign-catalog.js";
import { StateStore } from "../src/store.js";
import type { LlmProvider, StructuredRequest, StructuredResult } from "../src/types.js";
import { setupFixture } from "../tests/helpers.js";

const CONFIG: ProviderConfig = {
  provider: "gemini",
  model: "gemini-3.6-flash",
  temperature: 0.8,
  maxOutputTokens: 4_000,
};

let generatedCampaigns = 0;
let providerCalls = 0;
let completedStoryCalls = 0;
let completedStoryFailuresRemaining = 0;

const BROWSER_COMPLETED_STORY = Array.from(
  { length: 420 },
  (_, index) => `browserchronicle${index + 1}`,
).join(" ");

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

class BrowserFakeProvider implements LlmProvider {
  readonly id = CONFIG.provider;

  constructor(readonly model: string) {}

  async generateStructured<T>(request: StructuredRequest<T>): Promise<StructuredResult<T>> {
    providerCalls += 1;
    let data: unknown;
    if (request.schemaName === "campaign_setup") {
      await delay(650);
      generatedCampaigns += 1;
      data = {
        ...structuredClone(setupFixture),
        campaignTitle: `Browser Campaign ${generatedCampaigns}`,
      };
    } else if (request.schemaName === "campaign_question") {
      data = { answer: "The answer is visible without consuming a turn." };
    } else if (request.schemaName === "completed_campaign_story_v1") {
      completedStoryCalls += 1;
      await delay(1_100);
      if (completedStoryFailuresRemaining > 0) {
        completedStoryFailuresRemaining -= 1;
        throw new Error("Browser story generation failed");
      }
      data = { story: BROWSER_COMPLETED_STORY };
    } else {
      await delay(1_100);
      data = {
        kind: "resolved",
        narration: "The browser-tested dungeon master advances the scene safely.",
        turnSummary: "The scene advanced in the browser test.",
        operations: [],
      };
    }
    return {
      data: request.schema.parse(data),
      provider: this.id,
      model: this.model,
      rawText: JSON.stringify(data),
      structuredMode: "exact_schema",
    };
  }
}

let server: Server | undefined;
let fixtureRoot: string | undefined;
let baseUrl = "";

test.beforeEach(async () => {
  generatedCampaigns = 0;
  providerCalls = 0;
  completedStoryCalls = 0;
  completedStoryFailuresRemaining = 0;
  fixtureRoot = await mkdtemp(path.join(tmpdir(), "llm-dungeon-browser-"));
  await Promise.all([
    cp(path.join(process.cwd(), "web"), path.join(fixtureRoot, "web"), { recursive: true }),
    cp(path.join(process.cwd(), "defaults"), path.join(fixtureRoot, "defaults"), {
      recursive: true,
    }),
    mkdir(path.join(fixtureRoot, "config"), { recursive: true }),
  ]);
  await writeFile(
    path.join(fixtureRoot, "config", "provider.json"),
    `${JSON.stringify(CONFIG, null, 2)}\n`,
    "utf8",
  );
  server = createDungeonWebServer({
    root: fixtureRoot,
    environment: { GEMINI_API_KEY: "browser-test-key" },
    pricingFetcher: false,
    openAiModelsFetcher: false,
    providerFactory: (config) => new BrowserFakeProvider(config.model),
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
});

test.afterEach(async () => {
  if (server) {
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
  }
  if (fixtureRoot) {
    await rm(fixtureRoot, { recursive: true, force: true });
    fixtureRoot = undefined;
  }
});

async function openNewCampaign(page: Page): Promise<void> {
  await page.locator("#new-campaign").click();
  await expect(page.locator("#campaign-setup-form")).toBeVisible();
  await expect(page.locator("#generate-campaign")).toBeEnabled();
  await page.locator("#premise").fill("A lighthouse has gone dark above the winter sea.");
  await page.locator("#character").fill("A patient cartographer looking for a missing friend.");
}

async function generateAndAccept(page: Page): Promise<string> {
  await page.locator("#generate-campaign").click();
  await expect(page.locator("#campaign-preview")).toBeVisible();
  const title = (await page.locator("#preview-title").textContent())!;
  await page.locator("#accept-campaign").click();
  await expect(page.locator("#chat-view")).toBeVisible();
  await expect(page.locator("#chat-log")).toContainText(setupFixture.openingNarration);
  return title;
}

async function openCampaignBudget(page: Page): Promise<void> {
  const budgetResponse = page.waitForResponse(
    (response) =>
      response.request().method() === "GET" && new URL(response.url()).pathname.endsWith("/budget"),
  );
  await page.locator("#campaign-menu summary").click();
  await page.locator("#open-campaign-budget").click();
  await expect(page.locator("#campaign-budget-dialog")).toBeVisible();
  expect((await budgetResponse).ok()).toBe(true);
  await expect(page.locator("#campaign-budget-dialog")).toHaveAttribute("aria-busy", "false");
}

test("does not run the old two-second full-status heartbeat while idle", async ({ page }) => {
  let statusRequests = 0;
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/api/status") statusRequests += 1;
  });
  await page.goto(baseUrl);
  await expect(page.locator("#chat-view")).toBeVisible();
  await expect.poll(() => statusRequests).toBe(1);
  await page.waitForTimeout(2_500);
  expect(statusRequests).toBe(1);
});

test("deletes autoplay publications directly but keeps title confirmation for real archives", async ({
  page,
}) => {
  const sourceRoot = path.join(fixtureRoot!, "playtests", "runs", "browser-autoplay", "campaign");
  const source = new StateStore(sourceRoot);
  await source.createGame({
    setup: { ...structuredClone(setupFixture), campaignTitle: "Autoplay Browser Chronicle" },
    worldRules: "Browser autoplay fixture rules.",
    language: "en",
  });
  const catalog = new CampaignCatalog(path.join(fixtureRoot!, "data"));
  await catalog.publishArchivedCampaign(sourceRoot, {
    source: {
      kind: "autoplay",
      runId: "browser-autoplay",
      jobId: "job-001",
      packageId: "campaign-autoplay-v1",
      packageVersion: 1,
    },
    providerConfig: CONFIG,
    tags: ["Autoplay", "Player: in-character", "Model: gemini-3.6-flash"],
  });
  const ordinary = await catalog.createCampaign(
    {
      setup: { ...structuredClone(setupFixture), campaignTitle: "Ordinary Browser Chronicle" },
      worldRules: "Ordinary browser fixture rules.",
      language: "en",
    },
    { providerConfig: CONFIG },
  );
  await catalog.archiveCampaign(ordinary.campaignId);

  await page.goto(baseUrl);
  await page.locator("#archived-campaigns summary").click();
  const autoplayRow = page.locator("#archived-campaign-list .campaign-item-row", {
    hasText: "Autoplay Browser Chronicle",
  });
  const item = autoplayRow.locator(".campaign-item");
  await expect(item).toBeVisible();
  await expect(item.locator(".campaign-item-tag")).toHaveText([
    "Autoplay",
    "Player: in-character",
    "Model: gemini-3.6-flash",
  ]);
  await expect(item).toContainText(/archived/i);

  const ordinaryRow = page.locator("#archived-campaign-list .campaign-item-row", {
    hasText: "Ordinary Browser Chronicle",
  });
  await ordinaryRow.locator(".delete-campaign-button").click();
  await expect(page.locator("#delete-campaign-dialog")).toBeVisible();
  await page.locator("#delete-campaign-confirmation").fill("Wrong title");
  await expect(page.locator("#confirm-delete-campaign")).toBeDisabled();
  await page.locator("#delete-campaign-confirmation").fill("Ordinary Browser Chronicle");
  await expect(page.locator("#confirm-delete-campaign")).toBeEnabled();
  await page.locator("#cancel-delete-campaign").click();

  const deleteRequest = page.waitForRequest(
    (request) =>
      request.method() === "DELETE" && new URL(request.url()).pathname.endsWith("/delete"),
  );
  await autoplayRow.locator(".delete-campaign-button").click();
  expect((await deleteRequest).postDataJSON()).toEqual({});
  await expect(page.locator("#delete-campaign-dialog")).toBeHidden();
  await expect(autoplayRow).toHaveCount(0);
  await expect(ordinaryRow).toBeVisible();
});

test("shows and safely detaches explicit story generation only for settled campaigns", async ({
  page,
}) => {
  const catalog = new CampaignCatalog(path.join(fixtureRoot!, "data"));
  const archived = await catalog.createCampaign(
    {
      setup: { ...structuredClone(setupFixture), campaignTitle: "Archived Story Campaign" },
      worldRules: "Browser archived story fixture rules.",
      language: "en",
    },
    { providerConfig: CONFIG },
  );
  await catalog.archiveCampaign(archived.campaignId);
  const active = await catalog.createCampaign(
    {
      setup: { ...structuredClone(setupFixture), campaignTitle: "Active Story Campaign" },
      worldRules: "Browser active story fixture rules.",
      language: "en",
    },
    { providerConfig: CONFIG },
  );

  await page.goto(baseUrl);
  await page.locator("#campaign-list .campaign-item", { hasText: active.state.title }).click();
  await expect(page.locator("#open-completed-story")).toBeHidden();

  await page.locator("#archived-campaigns summary").click();
  await page
    .locator("#archived-campaign-list .campaign-item", { hasText: archived.state.title })
    .click();
  const storyButton = page.locator("#open-completed-story");
  await expect(storyButton).toBeVisible();
  await storyButton.click();
  const dialog = page.locator("#completed-story-dialog");
  await expect(dialog).toBeVisible();
  await expect(page.locator("#completed-story-output")).toContainText(
    "No short story has been generated",
  );
  await expect(page.locator("#completed-story-cost-warning")).toContainText(
    "may incur provider costs",
  );

  const generate = page.locator("#generate-completed-story");
  await expect(generate).toHaveText("Generate story");
  completedStoryFailuresRemaining = 1;
  await generate.click();
  await expect(generate).toContainText("Stop");
  await expect(page.locator("#completed-story-output")).toContainText(
    "The short story could not be generated",
  );
  await expect(generate).toHaveText("Retry");
  await expect(page.locator("#chat-log .error")).toHaveCount(0);

  const failedRequest = page.waitForEvent("requestfailed", {
    predicate: (request) => new URL(request.url()).pathname.endsWith("/story"),
  });
  await generate.click();
  await expect(generate).toContainText("Stop");
  await expect(generate).toHaveClass(/is-stop/);
  await generate.click();
  expect((await failedRequest).failure()?.errorText).toContain("ERR_ABORTED");
  await expect(dialog).toBeHidden();
  await expect(page.locator("#toast")).toContainText("finish safely in the background");

  await expect(storyButton).toBeEnabled({ timeout: 6_000 });
  expect(completedStoryCalls).toBe(2);
  await storyButton.click();
  await expect(dialog).toBeVisible();
  await expect(page.locator("#completed-story-output .completed-story-text")).toContainText(
    "browserchronicle420",
  );
  await expect(generate).toBeHidden();
  await page.locator("#close-completed-story").click();

  await storyButton.click();
  await expect(page.locator("#completed-story-output .completed-story-text")).toContainText(
    "browserchronicle1",
  );
  expect(completedStoryCalls).toBe(2);
});

test("creates, plays, and inspects a campaign through Chromium", async ({ page }) => {
  await page.goto(baseUrl);
  await openNewCampaign(page);
  await generateAndAccept(page);

  await page.locator("#action").fill("I examine the sealed letter without opening it.");
  await page.locator("#send-action").click();
  await expect(page.locator("#chat-log")).toContainText(
    "The browser-tested dungeon master advances the scene safely.",
  );

  await page.locator("#open-inspection").click();
  await expect(page.locator("#inspection-output .inspection-card")).toContainText("Arlen Vale");
  await page.locator('#inspection-tabs [data-view="location"]').click();
  await expect(page.locator("#inspection-output .inspection-card")).toContainText(
    "The Crooked Crown",
  );
  await page.locator('#inspection-tabs [data-view="threads"]').click();
  await expect(page.locator("#inspection-output .inspection-card")).toContainText(
    "Silence on the Northern Road",
  );
});

test("configures campaign spending and lets archives change only operational limits", async ({
  page,
}) => {
  await page.goto(baseUrl);
  await openNewCampaign(page);
  const campaignTitle = await generateAndAccept(page);

  await openCampaignBudget(page);
  const budgetDialog = page.locator("#campaign-budget-dialog");
  await expect(page.locator("#budget-spent")).toContainText(/\$\d/);
  await expect(page.locator("#budget-remaining")).toHaveText("No limit");

  const initialUpdate = page.waitForResponse(
    (response) =>
      response.request().method() === "PUT" && new URL(response.url()).pathname.endsWith("/budget"),
  );
  await page.locator("#campaign-budget-limit").fill("12.5");
  await page.locator("#logical-turn-budget-limit").fill("0.5");
  await page.locator("#save-campaign-budget").click();
  const initialUpdateResponse = await initialUpdate;
  expect(initialUpdateResponse.ok()).toBe(true);
  const initialBudget = await initialUpdateResponse.json();
  expect(initialBudget).toMatchObject({
    budget: { limits: { campaignUsd: 12.5, logicalTurnUsd: 0.5 } },
  });
  await expect(budgetDialog).toBeHidden();
  await expect(page.locator("#toast")).toContainText("Spending limits updated.");

  await openCampaignBudget(page);
  await expect(page.locator("#campaign-budget-limit")).toHaveValue("12.5");
  await expect(page.locator("#logical-turn-budget-limit")).toHaveValue("0.5");
  await expect(page.locator("#budget-remaining")).toContainText(/\$12\./);

  const tinyCapUpdate = page.waitForResponse(
    (response) =>
      response.request().method() === "PUT" && new URL(response.url()).pathname.endsWith("/budget"),
  );
  const tinyCampaignCap = Math.ceil(initialBudget.budget.spentUsd * 10_000) / 10_000 + 0.0001;
  await page.locator("#campaign-budget-limit").fill(String(tinyCampaignCap));
  await page.locator("#save-campaign-budget").click();
  expect((await tinyCapUpdate).ok()).toBe(true);
  await expect(budgetDialog).toBeHidden();

  const unsentAction = ":ask Is the sealed letter already marked with a known sigil?";
  const action = page.locator("#action");
  const send = page.locator("#send-action");
  await action.fill(unsentAction);
  const providerCallsBeforeRejection = providerCalls;
  const rejectedTurn = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" && new URL(response.url()).pathname.endsWith("/play"),
  );
  await send.click();
  const rejectedTurnResponse = await rejectedTurn;
  expect(rejectedTurnResponse.status()).toBe(409);
  expect(await rejectedTurnResponse.json()).toMatchObject({
    code: "campaign_budget_exhausted",
    scope: "campaign",
  });
  await expect(action).toHaveValue(unsentAction);
  await expect(action).toBeEnabled();
  await expect(send).toBeDisabled();
  await expect(page.locator("#pending-banner")).toContainText("Spending is paused.");
  await expect(page.locator("#pending-banner")).toContainText(
    "The campaign limit has been reached",
  );
  await expect(page.locator("#pending-banner")).toContainText("Your unsent draft is preserved.");
  expect(providerCalls).toBe(providerCallsBeforeRejection);

  await openCampaignBudget(page);
  await expect(page.locator("#campaign-budget-state")).toContainText("Spending is paused.");
  await page.locator("#close-campaign-budget").click();

  await page.locator("#campaign-menu summary").click();
  await page.locator("#archive-campaign").click();
  await expect(page.locator("#archive-campaign-dialog")).toBeVisible();
  const archivedResponse = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname.endsWith("/archive"),
  );
  await page.locator("#confirm-archive-campaign").click();
  expect((await archivedResponse).ok()).toBe(true);
  await expect(page.locator("#campaign-title")).toHaveText(campaignTitle);
  await expect(page.locator("#campaign-meta")).toContainText("archived");

  await openCampaignBudget(page);
  await expect(page.locator("#campaign-budget-limit")).toHaveValue(String(tinyCampaignCap));
  await expect(page.locator("#logical-turn-budget-limit")).toHaveValue("0.5");
  await expect(page.locator("#campaign-budget-limit")).toBeEnabled();
  await expect(page.locator("#logical-turn-budget-limit")).toBeEnabled();
  await expect(page.locator("#save-campaign-budget")).toBeVisible();
  await expect(page.locator("#campaign-budget-read-only")).toContainText(
    "Archived gameplay and story state stay read-only.",
  );
  const archivedUpdate = page.waitForResponse(
    (response) =>
      response.request().method() === "PUT" && new URL(response.url()).pathname.endsWith("/budget"),
  );
  await page.locator("#campaign-budget-limit").fill("20");
  await page.locator("#logical-turn-budget-limit").fill("1");
  await page.locator("#save-campaign-budget").click();
  expect((await archivedUpdate).ok()).toBe(true);
  await expect(budgetDialog).toBeHidden();
  await expect(page.locator("#action")).toBeDisabled();
  await expect(page.locator("#send-action")).toBeDisabled();

  await openCampaignBudget(page);
  await expect(page.locator("#campaign-budget-limit")).toHaveValue("20");
  await expect(page.locator("#logical-turn-budget-limit")).toHaveValue("1");
});

test("stops waiting while paid work finishes and starts unrelated work", async ({ page }) => {
  await page.goto(baseUrl);
  await openNewCampaign(page);

  const generate = page.locator("#generate-campaign");
  await generate.click();
  await expect(generate).toHaveAttribute("data-mode", "stop");
  await expect(generate).toHaveCSS("column-gap", "6.4px");
  await expect(generate).toBeEnabled();
  await expect(page.locator("#premise")).toBeDisabled();
  await expect(page.locator("#character")).toBeDisabled();
  await expect(page.locator("#setup-world")).toBeDisabled();
  await expect(page.locator("#setup-language")).toBeDisabled();
  await expect(page.locator("#setup-provider")).toBeDisabled();
  await expect(page.locator("#setup-model")).toBeDisabled();
  const stoppedDraftRequest = page.waitForEvent("requestfailed", {
    predicate: (request) => new URL(request.url()).pathname === "/api/campaigns/draft",
  });
  await page.waitForTimeout(100);
  await generate.click();
  expect((await stoppedDraftRequest).failure()?.errorText).toContain("ERR_ABORTED");
  await expect(generate).not.toHaveAttribute("data-mode", "stop");
  await expect(page.locator("#premise")).toBeEnabled();
  await page.locator("#premise").fill("A second lighthouse request replaces the detached first.");

  await generate.click();
  const campaignTitle = await generateAndAcceptFromActiveGeneration(page);
  expect(campaignTitle).toBe("Browser Campaign 2");
  await page.locator("#action").fill("I follow the muddy tracks into the rain.");
  const send = page.locator("#send-action");
  await send.click();
  await expect(send).toHaveAttribute("data-mode", "stop");
  await expect(send).toHaveCSS("column-gap", "6.4px");
  await page.waitForTimeout(100);
  await send.click();
  await expect(page.locator("#pending-banner")).toContainText("finishing safely");

  await openNewCampaign(page);
  await page.locator("#generate-campaign").click();
  await expect(page.locator("#campaign-preview")).toBeVisible();

  await page.locator("#campaign-list .campaign-item", { hasText: campaignTitle }).click();
  await expect(page.locator("#chat-view")).toBeVisible();
  await expect(page.locator("#chat-log")).toContainText(
    "The browser-tested dungeon master advances the scene safely.",
  );
  await expect(send).toHaveAttribute("data-mode", "send");
  await expect(send).toBeEnabled();
  await expect(page.locator("#chat-log .error")).toHaveCount(0);
});

test("keeps regeneration stoppable and detaches every abandoned preview", async ({ page }) => {
  await page.goto(baseUrl);
  await openNewCampaign(page);

  const firstDraftResponse = page.waitForResponse(
    (response) => new URL(response.url()).pathname === "/api/campaigns/draft",
  );
  await page.locator("#generate-campaign").click();
  const firstDraft = await (await firstDraftResponse).json();
  await expect(page.locator("#campaign-preview")).toBeVisible();
  const firstDetach = page.waitForRequest((request) => {
    if (new URL(request.url()).pathname !== "/api/campaigns/draft/detach") return false;
    return request.postDataJSON().requestId === firstDraft.draftId;
  });
  await page.locator("#edit-campaign").click();
  await firstDetach;
  await expect(page.locator("#campaign-setup-form")).toBeVisible();

  const secondDraftResponse = page.waitForResponse(
    (response) => new URL(response.url()).pathname === "/api/campaigns/draft",
  );
  await page.locator("#generate-campaign").click();
  const secondDraft = await (await secondDraftResponse).json();
  await expect(page.locator("#campaign-preview")).toBeVisible();
  const secondDetach = page.waitForRequest((request) => {
    if (new URL(request.url()).pathname !== "/api/campaigns/draft/detach") return false;
    return request.postDataJSON().requestId === secondDraft.draftId;
  });
  await page.locator("#regenerate-campaign").click();
  await secondDetach;

  const visibleStop = page.locator("#generate-campaign");
  await expect(page.locator("#campaign-setup-form")).toBeVisible();
  await expect(visibleStop).toBeVisible();
  await expect(visibleStop).toBeEnabled();
  await expect(visibleStop).toHaveAttribute("data-mode", "stop");
  const stoppedRegeneration = page.waitForEvent("requestfailed", {
    predicate: (request) => new URL(request.url()).pathname === "/api/campaigns/draft",
  });
  await visibleStop.click();
  expect((await stoppedRegeneration).failure()?.errorText).toContain("ERR_ABORTED");

  const thirdDraftResponse = page.waitForResponse(
    (response) => new URL(response.url()).pathname === "/api/campaigns/draft",
  );
  await visibleStop.click();
  const thirdDraft = await (await thirdDraftResponse).json();
  await expect(page.locator("#campaign-preview")).toBeVisible();
  const thirdDetach = page.waitForRequest((request) => {
    if (new URL(request.url()).pathname !== "/api/campaigns/draft/detach") return false;
    return request.postDataJSON().requestId === thirdDraft.draftId;
  });
  await page.locator("#new-campaign").click();
  await thirdDetach;
  await expect(page.locator("#campaign-setup-form")).toBeVisible();
});

async function generateAndAcceptFromActiveGeneration(page: Page): Promise<string> {
  await expect(page.locator("#campaign-preview")).toBeVisible();
  const title = (await page.locator("#preview-title").textContent())!;
  await page.locator("#accept-campaign").click();
  await expect(page.locator("#chat-view")).toBeVisible();
  return title;
}
