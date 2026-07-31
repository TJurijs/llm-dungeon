import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  BrowserApiCall,
  BrowserApiContract,
  BrowserApiOperation,
} from "../src/web/contracts.js";
import { browserApi, buildBrowserApiRequest } from "../web/api-client.js";

interface RouteFixture<Operation extends BrowserApiOperation> {
  call: BrowserApiCall<Operation>;
  method: BrowserApiContract[Operation]["method"];
  url: string;
}

type RouteFixtures = {
  [Operation in BrowserApiOperation]: RouteFixture<Operation>;
};

const campaignId = "campaign:contract/path";
const campaign = { params: { campaignId } };
const selection = { provider: "gemini", model: "gemini-test" } as const;

const ROUTES = {
  bootstrap: { call: {}, method: "GET", url: "/api/status" },
  readWorldProfile: {
    call: { query: { language: "ru" } },
    method: "GET",
    url: "/api/config/world?language=ru",
  },
  saveWorldProfile: {
    call: { body: { language: "ru", markdown: "# Мир" } },
    method: "PUT",
    url: "/api/config/world",
  },
  saveLanguage: {
    call: { body: { language: "ru" } },
    method: "PUT",
    url: "/api/config/language",
  },
  listScenarioSeeds: { call: {}, method: "GET", url: "/api/scenario-seeds" },
  readScenarioSeed: {
    call: { params: { seedId: "seed/with spaces" }, query: { language: "en" } },
    method: "GET",
    url: "/api/scenario-seeds/seed%2Fwith%20spaces?language=en",
  },
  createDraft: {
    call: {
      body: {
        premise: "A road has gone quiet.",
        character: "A patient scout.",
        language: "en",
        config: selection,
        requestId: "00000000-0000-4000-8000-000000000001",
      },
    },
    method: "POST",
    url: "/api/campaigns/draft",
  },
  detachDraft: {
    call: { body: { requestId: "00000000-0000-4000-8000-000000000001" } },
    method: "POST",
    url: "/api/campaigns/draft/detach",
  },
  confirmDraft: {
    call: { body: { draftId: "00000000-0000-4000-8000-000000000001" } },
    method: "POST",
    url: "/api/campaigns/confirm",
  },
  testModel: {
    call: { body: { ...selection, language: "en" } },
    method: "POST",
    url: "/api/llm/models/test",
  },
  addModel: { call: { body: selection }, method: "POST", url: "/api/llm/models" },
  setModelEnabled: {
    call: { body: { ...selection, enabled: true } },
    method: "PUT",
    url: "/api/llm/models",
  },
  removeModel: { call: { body: selection }, method: "DELETE", url: "/api/llm/models" },
  setDefaultModel: {
    call: { body: selection },
    method: "PUT",
    url: "/api/llm/default",
  },
  setSessionKey: {
    call: { body: { provider: "gemini", key: "session-key" } },
    method: "PUT",
    url: "/api/llm/keys",
  },
  testProviderConnection: {
    call: { body: { provider: "gemini" } },
    method: "POST",
    url: "/api/llm/connections/test",
  },
  reloadEnvironment: {
    call: {},
    method: "POST",
    url: "/api/llm/environment/reload",
  },
  campaignStatus: {
    call: campaign,
    method: "GET",
    url: "/api/campaigns/campaign%3Acontract%2Fpath/status",
  },
  campaignBudget: {
    call: campaign,
    method: "GET",
    url: "/api/campaigns/campaign%3Acontract%2Fpath/budget",
  },
  updateCampaignBudget: {
    call: { ...campaign, body: { campaignUsd: 10, logicalTurnUsd: null } },
    method: "PUT",
    url: "/api/campaigns/campaign%3Acontract%2Fpath/budget",
  },
  renameCampaign: {
    call: { ...campaign, body: { title: "Renamed" } },
    method: "PUT",
    url: "/api/campaigns/campaign%3Acontract%2Fpath/title",
  },
  campaignTranscript: {
    call: campaign,
    method: "GET",
    url: "/api/campaigns/campaign%3Acontract%2Fpath/transcript",
  },
  play: {
    call: { ...campaign, body: { action: "Listen at the door." } },
    method: "POST",
    url: "/api/campaigns/campaign%3Acontract%2Fpath/play",
  },
  retry: {
    call: campaign,
    method: "POST",
    url: "/api/campaigns/campaign%3Acontract%2Fpath/retry",
  },
  discard: {
    call: campaign,
    method: "POST",
    url: "/api/campaigns/campaign%3Acontract%2Fpath/discard",
  },
  setCampaignModel: {
    call: { ...campaign, body: selection },
    method: "PUT",
    url: "/api/campaigns/campaign%3Acontract%2Fpath/config",
  },
  campaignInspection: {
    call: campaign,
    method: "GET",
    url: "/api/campaigns/campaign%3Acontract%2Fpath/inspect",
  },
  archiveCampaign: {
    call: campaign,
    method: "POST",
    url: "/api/campaigns/campaign%3Acontract%2Fpath/archive",
  },
  campaignSetup: {
    call: campaign,
    method: "GET",
    url: "/api/campaigns/campaign%3Acontract%2Fpath/setup",
  },
  campaignStory: {
    call: campaign,
    method: "GET",
    url: "/api/campaigns/campaign%3Acontract%2Fpath/story",
  },
  generateCampaignStory: {
    call: campaign,
    method: "POST",
    url: "/api/campaigns/campaign%3Acontract%2Fpath/story",
  },
  deleteCampaign: {
    call: { ...campaign, body: { title: "Archived" } },
    method: "DELETE",
    url: "/api/campaigns/campaign%3Acontract%2Fpath/delete",
  },
} satisfies RouteFixtures;

describe("private browser JSON client", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("maps every declared operation to its method, encoded route, and JSON body", () => {
    for (const operation of Object.keys(ROUTES) as BrowserApiOperation[]) {
      const fixture = ROUTES[operation];
      const request = buildBrowserApiRequest(operation, fixture.call as never);
      expect(request.url, operation).toBe(fixture.url);
      expect(request.options.method, operation).toBe(fixture.method);
      expect(request.options.headers, operation).toEqual({ "Content-Type": "application/json" });
      expect(request.options.body, operation).toBe(
        "body" in fixture.call ? JSON.stringify(fixture.call.body) : undefined,
      );
    }
  });

  it("preserves cancellation signals and rejects missing dynamic identifiers", () => {
    const controller = new AbortController();
    expect(
      buildBrowserApiRequest("play", {
        params: { campaignId: "campaign:one" },
        body: { action: "Wait." },
        signal: controller.signal,
      }).options.signal,
    ).toBe(controller.signal);
    expect(() =>
      buildBrowserApiRequest("campaignStatus", {
        params: { campaignId: "" },
      }),
    ).toThrow("Campaign ID is required");
  });

  it("keeps draft detach alive and sends JSON headers for bodyless mutations", () => {
    const detach = buildBrowserApiRequest("detachDraft", {
      body: { requestId: "00000000-0000-4000-8000-000000000001" },
    });
    expect(detach.options.keepalive).toBe(true);

    const reload = buildBrowserApiRequest("reloadEnvironment", {});
    expect(reload.options.headers).toEqual({ "Content-Type": "application/json" });
    expect(reload.options.body).toBeUndefined();
  });

  it("preserves server error messages and HTTP status", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 409,
        json: vi.fn().mockResolvedValue({ error: "Campaign is busy" }),
      }),
    );

    await expect(browserApi("bootstrap", {})).rejects.toMatchObject({
      message: "Campaign is busy",
      status: 409,
    });
  });

  it("preserves typed campaign budget exhaustion details", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 409,
        json: vi.fn().mockResolvedValue({
          error: "Campaign spending limit reached",
          code: "campaign_budget_exhausted",
          scope: "campaign",
        }),
      }),
    );

    await expect(browserApi("campaignStatus", { params: { campaignId } })).rejects.toMatchObject({
      message: "Campaign spending limit reached",
      status: 409,
      code: "campaign_budget_exhausted",
      scope: "campaign",
    });
  });

  it("rejects malformed successful JSON without swallowing body-read aborts", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: vi.fn().mockRejectedValueOnce(new SyntaxError("Unexpected end of JSON input")),
      }),
    );
    await expect(browserApi("bootstrap", {})).rejects.toThrow(
      "Server returned an invalid JSON response",
    );

    const abort = Object.assign(new Error("The operation was aborted"), { name: "AbortError" });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: vi.fn().mockRejectedValueOnce(abort),
      }),
    );
    await expect(browserApi("bootstrap", {})).rejects.toBe(abort);
  });
});
