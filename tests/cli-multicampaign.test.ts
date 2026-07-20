import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { CampaignCatalog, type CampaignCatalogSummary } from "../src/campaign-catalog.js";
import { PROVIDER_COMPATIBILITY_FINGERPRINT } from "../src/connection-probe.js";
import { HumanGameCli } from "../src/cli/game.js";
import { createCliProgram } from "../src/cli/program.js";
import { CliProjectContext, type CliCampaignSession } from "../src/cli/project-context.js";
import { LlmModelCatalog } from "../src/llm-model-catalog.js";
import { ModelAssessmentCatalog } from "../src/model-assessment-catalog.js";
import { ModelExecutionProfileStore } from "../src/model-execution-profile-store.js";
import {
  DEFAULT_MODEL_EXECUTION_PROFILE_DRAFTS,
  MODEL_EXECUTION_ADAPTER_REVISION,
  freezeModelExecutionProfile,
} from "../src/model-execution-profile.js";
import type { GameEngine } from "../src/types.js";
import type { ProviderConfig } from "../src/schemas.js";
import { setupFixture } from "./helpers.js";

const gemini: ProviderConfig = {
  provider: "gemini",
  model: "gemini-default",
  temperature: 0.8,
  maxOutputTokens: 4000,
};

const openRouter: ProviderConfig = {
  provider: "openrouter",
  model: "vendor/campaign-model",
  temperature: 0.7,
  maxOutputTokens: 3000,
};

function modelSelection(config: ProviderConfig) {
  return { provider: config.provider, model: config.model };
}

async function projectFixture(): Promise<{ root: string; project: CliProjectContext }> {
  const root = await mkdtemp(path.join(tmpdir(), "llm-dungeon-cli-campaigns-"));
  const paths = {
    root,
    providerConfig: path.join(root, "config", "provider.json"),
    dataRoot: path.join(root, "data"),
    evaluationsRoot: path.join(root, "evaluations"),
  };
  await mkdir(path.dirname(paths.providerConfig), { recursive: true });
  await writeFile(paths.providerConfig, `${JSON.stringify(gemini, null, 2)}\n`, "utf8");
  const modelCatalog = new LlmModelCatalog(root, {
    testFingerprint: PROVIDER_COMPATIBILITY_FINGERPRINT,
  });
  await modelCatalog.recordTestSuccess(modelSelection(gemini), { testedLanguages: ["en", "ru"] });
  await modelCatalog.recordTestSuccess(modelSelection(openRouter), { testedLanguages: ["en", "ru"] });
  return {
    root,
    project: new CliProjectContext(paths, {
      GEMINI_API_KEY: "test-gemini-key",
      OPENROUTER_API_KEY: "test-openrouter-key",
    }),
  };
}

function setup(title: string) {
  return { ...structuredClone(setupFixture), campaignTitle: title };
}

function summary(
  campaignId: string,
  overrides: Partial<CampaignCatalogSummary> = {},
): CampaignCatalogSummary {
  return {
    campaignId,
    title: campaignId,
    turn: 2,
    status: "active",
    timeLabel: "Day 1",
    language: "en",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    archived: false,
    ...overrides,
  };
}

describe("multi-campaign terminal integration", () => {
  it("rejects an unverified terminal default with browser verification guidance", async () => {
    const { root, project } = await projectFixture();
    const unverified = { ...gemini, model: "new-unverified-model" };
    await writeFile(
      path.join(root, "config", "provider.json"),
      `${JSON.stringify(unverified, null, 2)}\n`,
      "utf8",
    );

    await expect(project.providerConfig()).rejects.toThrow(
      /Open the browser Settings page, test it for en, and enable it/,
    );
  });

  it("requires browser verification only for the configured gameplay language", async () => {
    const { root, project } = await projectFixture();
    const englishOnly = { ...gemini, model: "english-only-model" };
    const modelCatalog = new LlmModelCatalog(root, {
      testFingerprint: PROVIDER_COMPATIBILITY_FINGERPRINT,
    });
    await modelCatalog.recordTestSuccess(modelSelection(englishOnly), { testedLanguages: ["en"] });
    await writeFile(
      path.join(root, "config", "provider.json"),
      `${JSON.stringify(englishOnly, null, 2)}\n`,
      "utf8",
    );

    await expect(project.providerConfig()).resolves.toMatchObject(englishOnly);
    await project.setLanguage("ru");
    await expect(project.providerConfig()).rejects.toThrow(/test it for ru/);
  });

  it("opens each campaign with its persisted model while defaults affect only new campaigns", async () => {
    const { root, project } = await projectFixture();
    const dataRoot = path.join(root, "data");
    const catalog = new CampaignCatalog(dataRoot, { defaultProviderConfig: openRouter });
    const existing = await catalog.createCampaign({
      setup: setup("Existing Campaign"),
      worldRules: "Existing rules.",
      language: "en",
    }, { providerConfig: openRouter });

    await project.setLanguage("ru");
    expect((await (await catalog.openCampaign(existing.campaignId)).readManifest()).language).toBe("en");

    const existingEngine = await project.createEngine(existing.campaignId);
    expect(existingEngine.provider).toMatchObject({ id: "openrouter", model: openRouter.model });

    const added = await project.createCampaignSession({
      setup: setup("Added Campaign"),
      worldRules: "New default rules.",
      language: await project.language(),
    });
    expect(added.engine.provider).toMatchObject({ id: "gemini", model: gemini.model });

    const campaigns = await project.campaigns();
    expect(campaigns).toEqual(expect.arrayContaining([
      expect.objectContaining({
        campaignId: existing.campaignId,
        archived: false,
        language: "en",
        providerConfig: openRouter,
      }),
      expect.objectContaining({
        campaignId: added.campaignId,
        archived: false,
        language: "ru",
        providerConfig: gemini,
      }),
    ]));
  });

  it("reuses the current calibrated execution profile for ordinary campaign gameplay", async () => {
    const { root, project } = await projectFixture();
    const catalog = new CampaignCatalog(path.join(root, "data"), { defaultProviderConfig: gemini });
    const created = await catalog.createCampaign({
      setup: setup("Calibrated Campaign"),
      worldRules: "Calibrated rules.",
      language: "en",
    }, { providerConfig: gemini });
    const baseline = DEFAULT_MODEL_EXECUTION_PROFILE_DRAFTS.find((draft) => draft.key.provider === "gemini")!;
    const profile = freezeModelExecutionProfile({
      ...baseline,
      key: { provider: gemini.provider, model: gemini.model, route: "direct" },
      calibratedAt: "2026-07-19T12:00:00.000Z",
      evidenceRef: "playtests/calibration/cli-fixture",
    });
    await new ModelExecutionProfileStore(root).put(profile);
    await new ModelAssessmentCatalog(root).recordCalibration({
      provider: gemini.provider,
      model: gemini.model,
      route: "direct",
      status: "calibrated",
      adapterRevision: MODEL_EXECUTION_ADAPTER_REVISION,
      profileFingerprint: profile.fingerprint,
      evidence: { source: "calibration", reference: "playtests/calibration/cli-fixture" },
    });
    const providerSpy = vi.spyOn(project, "createProvider");

    await project.createEngine(created.campaignId);

    expect(providerSpy).toHaveBeenCalledWith(gemini, expect.objectContaining({
      fingerprint: profile.fingerprint,
    }));
  });

  it("refuses to construct a play engine for an archived campaign", async () => {
    const { root, project } = await projectFixture();
    const catalog = new CampaignCatalog(path.join(root, "data"), { defaultProviderConfig: gemini });
    const created = await catalog.createCampaign({ setup: setup("Archived"), worldRules: "Rules." });
    await catalog.archiveCampaign(created.campaignId);

    await expect(project.createEngine(created.campaignId)).rejects.toThrow(/archived and cannot be resumed/);
    expect(await project.campaigns()).toContainEqual(expect.objectContaining({
      campaignId: created.campaignId,
      archived: true,
    }));
  });

  it("lists and opens a pinned campaign without demanding a global default configuration", async () => {
    const { root, project } = await projectFixture();
    const catalog = new CampaignCatalog(path.join(root, "data"), { defaultProviderConfig: openRouter });
    const created = await catalog.createCampaign(
      { setup: setup("Pinned"), worldRules: "Rules." },
      { providerConfig: openRouter },
    );
    await rm(path.join(root, "config", "provider.json"));
    const configure = vi.spyOn(project, "configureProvider").mockRejectedValue(new Error("must not prompt"));

    expect(await project.campaigns()).toContainEqual(expect.objectContaining({
      campaignId: created.campaignId,
      providerConfig: openRouter,
    }));
    expect((await project.createEngine(created.campaignId)).provider).toMatchObject({
      id: "openrouter",
      model: openRouter.model,
    });
    expect(configure).not.toHaveBeenCalled();
  });

  it("pins a missing legacy model once and carries setup's exact model through acceptance", async () => {
    const { root, project } = await projectFixture();
    const dataRoot = path.join(root, "data");
    const unpinnedCatalog = new CampaignCatalog(dataRoot);
    const legacy = await unpinnedCatalog.createCampaign({ setup: setup("Unpinned"), worldRules: "Rules." });
    await legacy.store.setPendingRequest({ kind: "action", action: "Continue", phase: "requested" });

    expect((await project.createEngine(legacy.campaignId)).provider).toMatchObject({ model: gemini.model });
    expect(await unpinnedCatalog.providerConfig(legacy.campaignId)).toEqual(gemini);
    await writeFile(path.join(root, "config", "provider.json"), `${JSON.stringify(openRouter, null, 2)}\n`, "utf8");
    expect((await project.createEngine(legacy.campaignId)).provider).toMatchObject({ model: gemini.model });

    const setupSession = await project.createSetupSession();
    await writeFile(path.join(root, "config", "provider.json"), `${JSON.stringify(gemini, null, 2)}\n`, "utf8");
    const created = await project.createCampaignSession({
      setup: setup("Captured Model"),
      worldRules: "Rules.",
    }, setupSession.config);
    expect(created.engine.provider).toMatchObject({ model: openRouter.model });
    expect(await new CampaignCatalog(dataRoot).providerConfig(created.campaignId)).toEqual(openRouter);
  });

  it("chooses among unarchived campaigns and excludes the current campaign when switching", async () => {
    const campaigns = [
      summary("campaign:first", { title: "First" }),
      summary("campaign:second", { title: "Second" }),
      summary("campaign:third", { title: "Third" }),
      summary("campaign:archived", { title: "Archived", archived: true, archivedAt: "2026-01-02T00:00:00.000Z" }),
    ];
    const engines = new Map(campaigns.map((campaign) => [campaign.campaignId, {} as GameEngine]));
    const project = {
      campaigns: vi.fn(async () => campaigns),
      createEngine: vi.fn(async (campaignId: string) => engines.get(campaignId)!),
    } as unknown as CliProjectContext;
    const choose = vi.fn(async (choices: CampaignCatalogSummary[]) => choices.at(-1)!.campaignId);
    const cli = new HumanGameCli(project, choose);
    const select = (campaignId?: string, excludedCampaignId?: string) => (
      cli as unknown as {
        selectCampaign(id?: string, excluded?: string): Promise<CliCampaignSession | undefined>;
      }
    ).selectCampaign(campaignId, excludedCampaignId);

    expect((await select())?.campaignId).toBe("campaign:third");
    expect(choose.mock.calls[0]![0].map((campaign) => campaign.campaignId)).toEqual([
      "campaign:first",
      "campaign:second",
      "campaign:third",
    ]);

    expect((await select(undefined, "campaign:first"))?.campaignId).toBe("campaign:third");
    expect(choose.mock.calls[1]![0].map((campaign) => campaign.campaignId)).toEqual([
      "campaign:second",
      "campaign:third",
    ]);
    await expect(select("campaign:archived")).rejects.toThrow(/Unarchived campaign/);
  });

  it("routes an explicit campaign argument and describes configuration as future defaults", async () => {
    const { project } = await projectFixture();
    const play = vi.spyOn(HumanGameCli.prototype, "play").mockResolvedValue();
    try {
      const program = createCliProgram(project);
      await program.parseAsync(["node", "llm-dungeon", "play", "campaign:chosen"]);
      expect(play).toHaveBeenCalledWith("campaign:chosen");

      expect(program.commands.find((command) => command.name() === "configure")?.description())
        .toContain("default provider and model for new campaigns");
      expect(program.commands.find((command) => command.name() === "language")?.description())
        .toContain("default language for new campaigns");
      const commandNames = program.commands.map((command) => command.name());
      expect(commandNames).toContain("campaigns");
      expect(commandNames).not.toContain("playtest");
      expect(commandNames).not.toContain("evaluate");
    } finally {
      play.mockRestore();
    }
  });
});
