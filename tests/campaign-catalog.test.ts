import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, rename, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CampaignCatalog } from "../src/campaign-catalog.js";
import {
  CAMPAIGN_CREATION_INTENT_FILE,
  CAMPAIGN_METADATA_FILE,
  CAMPAIGN_MIGRATION_INTENT_FILE,
  CampaignCreationIntentSchema,
  CampaignMetadataSchema,
  CampaignMigrationIntentSchema,
  campaignScopePath,
  writeCampaignMetadata,
} from "../src/persistence/campaign-catalog.js";
import { renderTurnLog } from "../src/persistence/markdown.js";
import { acquireFileLock } from "../src/persistence/lock.js";
import type { ProviderConfig } from "../src/schemas.js";
import { StateStore } from "../src/store.js";
import type { NewGameInput } from "../src/types.js";
import { setupFixture } from "./helpers.js";

const gemini: ProviderConfig = {
  provider: "gemini",
  model: "gemini-test",
  temperature: 0.8,
  maxOutputTokens: 4000,
};

const openRouter: ProviderConfig = {
  provider: "openrouter",
  model: "test/model",
  temperature: 0.7,
  maxOutputTokens: 3000,
};

async function temporaryDataRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "llm-dungeon-catalog-"));
  return path.join(root, "data");
}

function setup(title: string) {
  return { ...structuredClone(setupFixture), campaignTitle: title };
}

describe("campaign catalog", () => {
  it("briefly waits for another process to finish a catalog operation", async () => {
    const dataRoot = await temporaryDataRoot();
    const catalog = new CampaignCatalog(dataRoot, { defaultProviderConfig: gemini });
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const release = await acquireFileLock(catalog.lockPath, "Test catalog");
      const listing = catalog.listCampaigns();
      await new Promise((resolve) => setTimeout(resolve, 50));
      await release();
      await expect(listing).resolves.toEqual([]);
    }
  });

  it("queues overlapping in-process catalog access across instances", async () => {
    const dataRoot = await temporaryDataRoot();
    const firstCatalog = new CampaignCatalog(dataRoot, { defaultProviderConfig: gemini });
    const secondCatalog = new CampaignCatalog(dataRoot, { defaultProviderConfig: gemini });

    const created = await Promise.all([
      firstCatalog.createCampaign({ setup: setup("Concurrent 1"), worldRules: "Rules." }),
      secondCatalog.createCampaign({ setup: setup("Concurrent 2"), worldRules: "Rules." }),
    ]);

    await expect(Promise.all([
      firstCatalog.listCampaigns(),
      secondCatalog.listCampaigns(),
    ])).resolves.toEqual([
      expect.arrayContaining([expect.objectContaining({ title: "Concurrent 1" }), expect.objectContaining({ title: "Concurrent 2" })]),
      expect.arrayContaining([expect.objectContaining({ title: "Concurrent 1" }), expect.objectContaining({ title: "Concurrent 2" })]),
    ]);
  });

  it("finishes campaign creation from a durable secret-free intent", async () => {
    const dataRoot = await temporaryDataRoot();
    const campaignId = "campaign:interrupted-creation";
    const input: NewGameInput = {
      setup: setup("Recovered Creation"),
      worldRules: "Recovered rules.",
      language: "ru",
      openingGeneration: {
        provider: "openrouter",
        model: "test/recovery-model",
      },
    };
    const metadata = CampaignMetadataSchema.parse({
      schemaVersion: 1,
      campaignId,
      registeredAt: new Date().toISOString(),
      archived: false,
      providerConfig: openRouter,
    });
    const intent = CampaignCreationIntentSchema.parse({
      schemaVersion: 1,
      metadata,
      input,
    });
    await mkdir(dataRoot, { recursive: true });
    await writeFile(
      path.join(dataRoot, CAMPAIGN_CREATION_INTENT_FILE),
      `${JSON.stringify(intent, null, 2)}\n`,
      "utf8",
    );

    const catalog = new CampaignCatalog(dataRoot);
    expect(await catalog.listCampaigns()).toEqual([
      expect.objectContaining({
        campaignId,
        title: "Recovered Creation",
        language: "ru",
        providerConfig: openRouter,
      }),
    ]);
    const recovered = await catalog.openCampaign(campaignId);
    const opening = await readFile(path.join(recovered.currentDir, "turns", "000000.md"), "utf8");
    expect(opening).toContain("provider: openrouter");
    expect(opening).toContain("model: test/recovery-model");
    await expect(access(path.join(dataRoot, CAMPAIGN_CREATION_INTENT_FILE))).rejects.toThrow();
  });

  it("returns the recovered campaign when an accepted setup is retried", async () => {
    const dataRoot = await temporaryDataRoot();
    const campaignId = "campaign:retried-creation";
    const requestId = "9fa0b790-845d-43c4-94cf-f214ef489a20";
    const input: NewGameInput = {
      setup: setup("Recovered Retry"),
      worldRules: "Recovered rules.",
      language: "en",
    };
    const metadata = CampaignMetadataSchema.parse({
      schemaVersion: 1,
      campaignId,
      registeredAt: new Date().toISOString(),
      creationRequestId: requestId,
      archived: false,
      providerConfig: gemini,
    });
    await mkdir(dataRoot, { recursive: true });
    await writeFile(
      path.join(dataRoot, CAMPAIGN_CREATION_INTENT_FILE),
      `${JSON.stringify(CampaignCreationIntentSchema.parse({
        schemaVersion: 1,
        metadata,
        input,
      }), null, 2)}\n`,
      "utf8",
    );

    const catalog = new CampaignCatalog(dataRoot);
    const retried = await catalog.createCampaign(input, {
      providerConfig: gemini,
      requestId,
    });

    expect(retried.campaignId).toBe(campaignId);
    expect(await catalog.listCampaigns()).toHaveLength(1);
  });

  it("clears a creation intent after validating an already-promoted campaign", async () => {
    const dataRoot = await temporaryDataRoot();
    const campaignId = "campaign:promoted-before-crash";
    const scopeRoot = campaignScopePath(dataRoot, campaignId);
    const input: NewGameInput = {
      setup: setup("Already Promoted"),
      worldRules: "Rules.",
    };
    const metadata = CampaignMetadataSchema.parse({
      schemaVersion: 1,
      campaignId,
      registeredAt: new Date().toISOString(),
      archived: false,
      providerConfig: gemini,
    });
    await mkdir(scopeRoot, { recursive: true });
    await writeCampaignMetadata(scopeRoot, metadata);
    const store = new StateStore(scopeRoot, {
      campaignId,
      catalogMetadataPath: path.join(scopeRoot, CAMPAIGN_METADATA_FILE),
    });
    await store.createGame(input);
    const manifestBeforeRecovery = await readFile(path.join(store.currentDir, "manifest.json"), "utf8");
    await writeFile(
      path.join(dataRoot, CAMPAIGN_CREATION_INTENT_FILE),
      `${JSON.stringify(CampaignCreationIntentSchema.parse({
        schemaVersion: 1,
        metadata,
        input,
      }), null, 2)}\n`,
      "utf8",
    );

    const campaigns = await new CampaignCatalog(dataRoot).listCampaigns();
    expect(campaigns).toEqual([
      expect.objectContaining({ campaignId, title: "Already Promoted" }),
    ]);
    expect(await readFile(path.join(store.currentDir, "manifest.json"), "utf8"))
      .toBe(manifestBeforeRecovery);
    await expect(access(path.join(dataRoot, CAMPAIGN_CREATION_INTENT_FILE))).rejects.toThrow();
  });

  it("promotes a complete legacy creation stage without regenerating it", async () => {
    const dataRoot = await temporaryDataRoot();
    const campaignId = "campaign:legacy-staged";
    const scopeRoot = campaignScopePath(dataRoot, campaignId);
    const metadata = CampaignMetadataSchema.parse({
      schemaVersion: 1,
      campaignId,
      registeredAt: new Date().toISOString(),
      archived: false,
    });
    await mkdir(scopeRoot, { recursive: true });
    await writeCampaignMetadata(scopeRoot, metadata);
    const stagingRoot = await temporaryDataRoot();
    const stagingStore = new StateStore(stagingRoot, { campaignId });
    await stagingStore.createGame({
      setup: setup("Legacy Staged"),
      worldRules: "Legacy rules.",
    });
    const stagedManifest = await readFile(path.join(stagingStore.currentDir, "manifest.json"), "utf8");
    const stagedPath = path.join(scopeRoot, ".new-legacy");
    await rename(stagingStore.currentDir, stagedPath);

    expect(await new CampaignCatalog(dataRoot).listCampaigns()).toEqual([
      expect.objectContaining({ campaignId, title: "Legacy Staged" }),
    ]);
    expect(await readFile(path.join(scopeRoot, "current", "manifest.json"), "utf8"))
      .toBe(stagedManifest);
    await expect(access(stagedPath)).rejects.toThrow();
  });

  it("preserves incomplete legacy staging whether or not the scope has other files", async () => {
    const dataRoot = await temporaryDataRoot();
    const cleanId = "campaign:legacy-incomplete";
    const cleanScope = campaignScopePath(dataRoot, cleanId);
    await mkdir(path.join(cleanScope, ".new-incomplete", "entities"), { recursive: true });
    await writeCampaignMetadata(cleanScope, CampaignMetadataSchema.parse({
      schemaVersion: 1,
      campaignId: cleanId,
      registeredAt: new Date().toISOString(),
      archived: false,
    }));

    const preserveId = "campaign:legacy-unknown";
    const preserveScope = campaignScopePath(dataRoot, preserveId);
    await mkdir(path.join(preserveScope, ".new-incomplete"), { recursive: true });
    await writeCampaignMetadata(preserveScope, CampaignMetadataSchema.parse({
      schemaVersion: 1,
      campaignId: preserveId,
      registeredAt: new Date().toISOString(),
      archived: false,
    }));
    await writeFile(path.join(preserveScope, "manual-note.txt"), "keep me", "utf8");

    expect(await new CampaignCatalog(dataRoot).listCampaigns()).toEqual([]);
    await expect(access(path.join(cleanScope, CAMPAIGN_METADATA_FILE))).resolves.toBeUndefined();
    await expect(access(path.join(cleanScope, ".new-incomplete"))).resolves.toBeUndefined();
    await expect(access(path.join(preserveScope, CAMPAIGN_METADATA_FILE))).resolves.toBeUndefined();
    await expect(access(path.join(preserveScope, ".new-incomplete"))).resolves.toBeUndefined();
    expect(await readFile(path.join(preserveScope, "manual-note.txt"), "utf8")).toBe("keep me");
  });

  it("binds a creation request to its original setup and provider configuration", async () => {
    const dataRoot = await temporaryDataRoot();
    const catalog = new CampaignCatalog(dataRoot);
    const requestId = "8b4c3ea8-71b7-4c7f-ad51-d57e73cd67a4";
    const input: NewGameInput = { setup: setup("Bound Setup"), worldRules: "Rules." };
    const first = await catalog.createCampaign(input, { providerConfig: gemini, requestId });
    const replay = await catalog.createCampaign(input, { providerConfig: gemini, requestId });

    expect(replay.campaignId).toBe(first.campaignId);
    await expect(catalog.createCampaign(
      { setup: setup("Different Setup"), worldRules: "Different rules." },
      { providerConfig: openRouter, requestId },
    )).rejects.toThrow(/reused with different setup data/);
    expect(await catalog.listCampaigns()).toHaveLength(1);
  });

  it("fails closed when catalog metadata duplicates a creation request", async () => {
    const dataRoot = await temporaryDataRoot();
    const catalog = new CampaignCatalog(dataRoot);
    const first = await catalog.createCampaign({ setup: setup("First Claim"), worldRules: "Rules." });
    const second = await catalog.createCampaign({ setup: setup("Second Claim"), worldRules: "Rules." });
    const requestId = "749a86b9-2280-4871-95c7-6e320cd5ce31";
    for (const campaignId of [first.campaignId, second.campaignId]) {
      const scopeRoot = campaignScopePath(dataRoot, campaignId);
      const metadata = CampaignMetadataSchema.parse(JSON.parse(
        await readFile(path.join(scopeRoot, CAMPAIGN_METADATA_FILE), "utf8"),
      ));
      await writeCampaignMetadata(scopeRoot, CampaignMetadataSchema.parse({
        ...metadata,
        creationRequestId: requestId,
      }));
    }

    await expect(catalog.findCampaignByCreationRequest(requestId)).rejects.toThrow(/Multiple campaigns claim/);
  });

  it("creates identity-bound campaign stores with independent saves and locks", async () => {
    const dataRoot = await temporaryDataRoot();
    const catalog = new CampaignCatalog(dataRoot, { defaultProviderConfig: gemini });
    const first = await catalog.createCampaign({
      setup: setup("First Campaign"),
      worldRules: "First rules.",
    });
    const second = await catalog.createCampaign({
      setup: setup("Second Campaign"),
      worldRules: "Second rules.",
    }, { providerConfig: openRouter });

    expect(first.state.campaignId).toBe(first.campaignId);
    expect(second.state.campaignId).toBe(second.campaignId);
    expect(first.store.currentDir).not.toBe(second.store.currentDir);
    expect(first.store.pendingPath).not.toBe(second.store.pendingPath);
    expect(first.store.lockPath).not.toBe(second.store.lockPath);

    let releaseFirst!: () => void;
    let signalFirst!: () => void;
    const firstLocked = new Promise<void>((resolve) => { signalFirst = resolve; });
    const holdFirst = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const held = first.store.withCampaignLock(async () => {
      signalFirst();
      await holdFirst;
    });
    await firstLocked;
    expect((await second.store.setLanguage("ru")).language).toBe("ru");
    releaseFirst();
    await held;

    expect(await catalog.listCampaigns()).toEqual(expect.arrayContaining([
      expect.objectContaining({
        campaignId: first.campaignId,
        title: "First Campaign",
        archived: false,
        providerConfig: gemini,
      }),
      expect.objectContaining({
        campaignId: second.campaignId,
        title: "Second Campaign",
        archived: false,
        language: "ru",
        providerConfig: openRouter,
      }),
    ]));
  });

  it("persists provider selection and makes archival irreversible for cached and reopened stores", async () => {
    const dataRoot = await temporaryDataRoot();
    const catalog = new CampaignCatalog(dataRoot, { defaultProviderConfig: gemini });
    const created = await catalog.createCampaign({ setup: setup("One Way"), worldRules: "Rules." });

    await created.store.setPendingRequest({
      kind: "action",
      action: "An unfinished action.",
      phase: "requested",
    });
    await expect(catalog.updateProviderConfig(created.campaignId, openRouter))
      .rejects.toThrow(/unfinished request/);
    expect(await catalog.providerConfig(created.campaignId)).toEqual(gemini);
    await created.store.discardPendingRequest();

    expect(await catalog.updateProviderConfig(created.campaignId, openRouter)).toEqual(openRouter);
    expect(await catalog.providerConfig(created.campaignId)).toEqual(openRouter);
    await expect(created.store.replaceGame({
      setup: setup("Replacement"),
      worldRules: "Replacement rules.",
    })).rejects.toThrow(/create a separate campaign/);
    await expect(created.store.archiveAndReset()).rejects.toThrow(/campaign catalog/);

    const archived = await catalog.archiveCampaign(created.campaignId);
    expect(archived).toMatchObject({ campaignId: created.campaignId, archived: true });
    expect(archived.archivedAt).toBeTruthy();
    expect((await catalog.archiveCampaign(created.campaignId)).archivedAt).toBe(archived.archivedAt);

    await expect(catalog.openCampaign(created.campaignId)).rejects.toThrow(/archived and cannot be resumed/);
    await expect(catalog.updateProviderConfig(created.campaignId, gemini)).rejects.toThrow(/cannot be changed/);
    await expect(created.store.setLanguage("ru")).rejects.toThrow(/read-only/);

    const readable = await catalog.readCampaign(created.campaignId);
    expect((await readable.load()).manifest.title).toBe("One Way");
    await expect(readable.commitTurn({
      action: "Continue anyway.",
      resolved: { narration: "No.", turnSummary: "No change.", operations: [] },
      provider: "fake",
      model: "fake",
    })).rejects.toThrow(/read-only/);

    await catalog.deleteArchivedCampaign(created.campaignId);
    expect((await catalog.listCampaigns()).some((campaign) => campaign.campaignId === created.campaignId)).toBe(false);
    await expect(catalog.readCampaign(created.campaignId)).rejects.toThrow(/not found/);
  });

  it("refuses to permanently delete an active campaign", async () => {
    const dataRoot = await temporaryDataRoot();
    const catalog = new CampaignCatalog(dataRoot, { defaultProviderConfig: gemini });
    const created = await catalog.createCampaign({ setup: setup("Still Active"), worldRules: "Rules." });

    await expect(catalog.deleteArchivedCampaign(created.campaignId)).rejects.toThrow(/must be archived/);
    expect((await catalog.listCampaigns()).map((campaign) => campaign.campaignId)).toContain(created.campaignId);
  });

  it("migrates the legacy current save and archives without resurrecting archived campaigns", async () => {
    const dataRoot = await temporaryDataRoot();
    const legacy = new StateStore(dataRoot);
    const current = await legacy.createGame({
      setup: setup("Legacy Current"),
      worldRules: "Current rules.",
    });
    const currentManifest = await readFile(path.join(legacy.currentDir, "manifest.json"), "utf8");

    const archivedRoot = await temporaryDataRoot();
    const archivedStore = new StateStore(archivedRoot);
    const archived = await archivedStore.createGame({
      setup: setup("Legacy Archive"),
      worldRules: "Archived rules.",
    });
    const archivedManifest = await readFile(path.join(archivedStore.currentDir, "manifest.json"), "utf8");
    await mkdir(legacy.archiveDir, { recursive: true });
    await rename(archivedStore.currentDir, path.join(legacy.archiveDir, "old-campaign"));

    const catalog = new CampaignCatalog(dataRoot, { defaultProviderConfig: gemini });
    const campaigns = await catalog.listCampaigns();
    expect(campaigns).toEqual(expect.arrayContaining([
      expect.objectContaining({ campaignId: current.campaignId, archived: false, providerConfig: gemini }),
      expect.objectContaining({ campaignId: archived.campaignId, archived: true, providerConfig: gemini }),
    ]));
    await expect(access(path.join(dataRoot, "current"))).rejects.toThrow();
    await expect(access(path.join(dataRoot, "archive", "old-campaign"))).rejects.toThrow();

    const currentStore = await catalog.openCampaign(current.campaignId);
    const oldStore = await catalog.readCampaign(archived.campaignId);
    expect(await readFile(path.join(currentStore.currentDir, "manifest.json"), "utf8")).toBe(currentManifest);
    expect(await readFile(path.join(oldStore.currentDir, "manifest.json"), "utf8")).toBe(archivedManifest);
    await expect(catalog.openCampaign(archived.campaignId)).rejects.toThrow(/archived/);
  });

  it("finishes a migration interrupted after the campaign directory move", async () => {
    const dataRoot = await temporaryDataRoot();
    const legacy = new StateStore(dataRoot);
    const state = await legacy.createGame({
      setup: setup("Interrupted Migration"),
      worldRules: "Rules.",
    });
    const createdAt = new Date().toISOString();
    const metadata = CampaignMetadataSchema.parse({
      schemaVersion: 1,
      campaignId: state.campaignId,
      registeredAt: createdAt,
      archived: false,
      providerConfig: gemini,
    });
    const intent = CampaignMigrationIntentSchema.parse({
      schemaVersion: 1,
      createdAt,
      entries: [{ source: { kind: "current" }, metadata }],
    });
    const scopeRoot = campaignScopePath(dataRoot, state.campaignId);
    await mkdir(scopeRoot, { recursive: true });
    await rename(legacy.currentDir, path.join(scopeRoot, "current"));
    await writeFile(
      path.join(dataRoot, CAMPAIGN_MIGRATION_INTENT_FILE),
      `${JSON.stringify(intent, null, 2)}\n`,
      "utf8",
    );

    const catalog = new CampaignCatalog(dataRoot);
    expect(await catalog.listCampaigns()).toContainEqual(expect.objectContaining({
      campaignId: state.campaignId,
      archived: false,
    }));
    expect(JSON.parse(await readFile(path.join(scopeRoot, CAMPAIGN_METADATA_FILE), "utf8"))).toEqual(metadata);
    await expect(access(path.join(dataRoot, CAMPAIGN_MIGRATION_INTENT_FILE))).rejects.toThrow();
  });

  it("recovers a prepared commit before sealing a migrated archive read-only", async () => {
    const dataRoot = await temporaryDataRoot();
    const sourceRoot = await temporaryDataRoot();
    const source = new StateStore(sourceRoot);
    const state = await source.createGame({
      setup: setup("Recover Then Archive"),
      worldRules: "Rules.",
    });
    const manifestPath = path.join(source.currentDir, "manifest.json");
    const before = await readFile(manifestPath, "utf8");
    const targetManifest = `${JSON.stringify({ ...state, turn: 1, timeLabel: "Recovered" }, null, 2)}\n`;
    await writeFile(source.pendingPath, JSON.stringify({
      kind: "commit",
      campaignId: state.campaignId,
      expectedPreviousTurn: 0,
      targetTurn: 1,
      preManifestHash: createHash("sha256").update(before).digest("hex"),
      writes: {
        "turns/000001.md": renderTurnLog(1, {
          action: "Interrupted.",
          resolved: { narration: "Recovered.", turnSummary: "Recovered.", operations: [] },
          provider: "fake",
          model: "fake",
        }),
        "manifest.json": targetManifest,
      },
    }), "utf8");
    await mkdir(path.join(dataRoot, "archive"), { recursive: true });
    await rename(source.currentDir, path.join(dataRoot, "archive", "prepared"));

    const catalog = new CampaignCatalog(dataRoot);
    expect(await catalog.listCampaigns()).toContainEqual(expect.objectContaining({
      campaignId: state.campaignId,
      archived: true,
      turn: 1,
      timeLabel: "Recovered",
    }));
    const readable = await catalog.readCampaign(state.campaignId);
    expect((await readable.load()).manifest.turn).toBe(1);
    await expect(access(readable.pendingPath)).rejects.toThrow();
  });

  it("fails closed when a catalog directory manifest has another campaign identity", async () => {
    const dataRoot = await temporaryDataRoot();
    const catalog = new CampaignCatalog(dataRoot);
    const created = await catalog.createCampaign({ setup: setup("Identity"), worldRules: "Rules." });
    const manifestPath = path.join(created.store.currentDir, "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
    await writeFile(manifestPath, `${JSON.stringify({ ...manifest, campaignId: "campaign:another" }, null, 2)}\n`, "utf8");

    await expect(catalog.listCampaigns()).rejects.toThrow(/identity mismatch/);
    await expect(catalog.openCampaign(created.campaignId)).rejects.toThrow(/identity mismatch/);
  });

  it("rejects conflicting durable migration metadata instead of overwriting it", async () => {
    const dataRoot = await temporaryDataRoot();
    const legacy = new StateStore(dataRoot);
    const state = await legacy.createGame({ setup: setup("Conflict"), worldRules: "Rules." });
    const createdAt = new Date().toISOString();
    const scopeRoot = campaignScopePath(dataRoot, state.campaignId);
    await mkdir(scopeRoot, { recursive: true });
    await rename(legacy.currentDir, path.join(scopeRoot, "current"));
    const intended = CampaignMetadataSchema.parse({
      schemaVersion: 1,
      campaignId: state.campaignId,
      registeredAt: createdAt,
      archived: false,
      providerConfig: gemini,
    });
    await writeCampaignMetadata(scopeRoot, CampaignMetadataSchema.parse({
      ...intended,
      providerConfig: openRouter,
    }));
    await writeFile(path.join(dataRoot, CAMPAIGN_MIGRATION_INTENT_FILE), JSON.stringify({
      schemaVersion: 1,
      createdAt,
      entries: [{ source: { kind: "current" }, metadata: intended }],
    }), "utf8");

    await expect(new CampaignCatalog(dataRoot).listCampaigns()).rejects.toThrow(/metadata conflicts/);
    expect(JSON.parse(await readFile(path.join(scopeRoot, CAMPAIGN_METADATA_FILE), "utf8"))).toMatchObject({
      providerConfig: openRouter,
    });
  });
});
