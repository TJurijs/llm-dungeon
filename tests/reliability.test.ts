import { createHash } from "node:crypto";
import { access, mkdtemp, readFile, rename, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { canonicalEntityName } from "../src/domain/ids.js";
import { resolveCheck } from "../src/mechanics.js";
import { entityFilename, renderEntity, renderTurnLog } from "../src/persistence/markdown.js";
import { StateStore, validateInitialSetup } from "../src/store.js";
import { createTestStore, setupFixture } from "./helpers.js";

describe("V1 reliability boundaries", () => {
  it("rejects moving a carried item into the world without transferring ownership", async () => {
    const store = await createTestStore();
    await expect(store.commitTurn({
      action: "I drop my sword.",
      resolved: {
        narration: "The sword is described as lying on the tavern floor.",
        turnSummary: "The attempted drop was inconsistent.",
        operations: [{
          type: "move_entity",
          targetId: "item:travel-sword",
          locationId: "location:crooked-crown",
        }],
      },
      provider: "fake",
      model: "fake-model",
    })).rejects.toThrow(/carried by player:hero and also has world location/);

    const loaded = await store.load();
    expect(loaded.manifest.turn).toBe(0);
    expect(loaded.entities.get("player:hero")?.inventory).toContainEqual({
      entityId: "item:travel-sword",
      quantity: 1,
    });
    expect(loaded.entities.get("item:travel-sword")?.location).toBeUndefined();
  });

  it("does not allow a closed thread outcome to be rewritten", async () => {
    const store = await createTestStore();
    const threadId = (await store.load()).threads[0]!.id;
    await store.commitTurn({
      action: "I settle the road mystery.",
      resolved: {
        narration: "The mystery is settled.",
        turnSummary: "The road mystery ended.",
        operations: [{ type: "resolve_thread", threadId, status: "resolved", outcome: "Settled." }],
      },
      provider: "fake",
      model: "fake-model",
    });

    await expect(store.commitTurn({
      action: "I contradict the settled result.",
      resolved: {
        narration: "Nothing can rewrite the established outcome.",
        turnSummary: "The outcome remained settled.",
        operations: [{ type: "resolve_thread", threadId, status: "failed", outcome: "Rewritten." }],
      },
      provider: "fake",
      model: "fake-model",
    })).rejects.toThrow(/is not active/);
    expect((await store.load()).threads[0]).toMatchObject({ status: "resolved", summary: "Settled." });
  });

  it("rejects renaming a location into an established canonical alias", async () => {
    const store = await createTestStore();
    await expect(store.commitTurn({
      action: "I try to establish a confusing alias.",
      resolved: {
        narration: "The proposed duplicate location cannot become authoritative.",
        turnSummary: "No duplicate alias was created.",
        operations: [
          {
            type: "create_entity",
            entity: {
              id: "location:market-hint",
              kind: "location",
              name: "Market Square",
              status: "open",
              tags: [],
              description: "A public square.",
              establishedFacts: [],
              secrets: [],
              playerKnowledge: [],
            },
          },
          { type: "set_entity_state", targetId: "location:market-hint", name: "The Crooked Crown" },
        ],
      },
      provider: "fake",
      model: "fake-model",
    })).rejects.toThrow(/duplicates established location/);

    const loaded = await store.load();
    expect(loaded.manifest.turn).toBe(0);
    expect([...loaded.entities.values()].filter((entity) => entity.kind === "location")).toHaveLength(1);
  });

  it("rejects multiple campaign endings atomically", async () => {
    const store = await createTestStore();
    await expect(store.commitTurn({
      action: "I attempt two incompatible endings.",
      resolved: {
        narration: "The contradictory ending cannot be committed.",
        turnSummary: "No ending was committed.",
        operations: [
          { type: "end_campaign", status: "ended", reason: "Retired." },
          { type: "end_campaign", status: "dead", reason: "Died." },
        ],
      },
      provider: "fake",
      model: "fake-model",
    })).rejects.toThrow(/end only once/);
    expect((await store.load()).manifest).toMatchObject({ turn: 0, status: "active" });
  });

  it("preserves superseded secret history without exposing it in a public entity view", async () => {
    const store = await createTestStore();
    const before = await store.load();
    const secret = before.entities.get("npc:mara-venn")!.facts.find((fact) => fact.section === "secrets")!;
    await store.commitTurn({
      action: "The hidden arrangement changes.",
      resolved: {
        narration: "Events privately alter Mara's arrangement.",
        turnSummary: "Mara's hidden arrangement changed.",
        operations: [{
          type: "supersede_fact",
          targetId: "npc:mara-venn",
          factId: secret.id,
          replacementText: "Mara now refuses the watch captain's bribes.",
        }],
      },
      provider: "fake",
      model: "fake-model",
    });

    const mara = (await store.load()).entities.get("npc:mara-venn")!;
    expect(mara.facts).toContainEqual({ ...secret, active: false });
    expect(renderEntity(mara, true)).toContain(secret.text);
    expect(renderEntity(mara, false)).not.toContain(secret.text);
    expect(renderEntity(mara, false)).not.toContain("refuses the watch captain");
  });

  it("validates setup graph ownership and thread references before creating files", () => {
    const danglingThread = structuredClone(setupFixture);
    danglingThread.threads[0]!.relatedEntityIds = ["npc:missing"];
    expect(() => validateInitialSetup(danglingThread)).toThrow(/references unknown entity/);

    const doubleLocatedItem = structuredClone(setupFixture);
    doubleLocatedItem.entities.find((entity) => entity.id === "item:travel-sword")!.location = "location:crooked-crown";
    expect(() => validateInitialSetup(doubleLocatedItem)).toThrow(/must not also have a world location/);

    const selfNested = structuredClone(setupFixture);
    selfNested.entities.find((entity) => entity.id === "location:crooked-crown")!.location = "location:crooked-crown";
    expect(() => validateInitialSetup(selfNested)).toThrow(/cannot be located inside itself/);
  });

  it("canonicalizes non-Latin names distinctly and maps every safe ID to one filename", () => {
    expect(canonicalEntityName("Москва")).toBe("москва");
    expect(canonicalEntityName("Рига")).toBe("рига");
    expect(entityFilename("npc:a--b")).not.toBe(entityFilename("npc--a:b"));
  });

  it("allocates distinct persisted fact IDs for entity IDs with the same slug", async () => {
    const setup = structuredClone(setupFixture);
    setup.entities.push(
      {
        id: "npc:a-b",
        kind: "person",
        name: "First Similar ID",
        status: "alive",
        location: "location:crooked-crown",
        tags: [],
        description: "First.",
        establishedFacts: ["First fact."],
        secrets: [],
        playerKnowledge: [],
        traits: [],
        conditions: [],
        inventory: [],
      },
      {
        id: "npc-a:b",
        kind: "person",
        name: "Second Similar ID",
        status: "alive",
        location: "location:crooked-crown",
        tags: [],
        description: "Second.",
        establishedFacts: ["Second fact."],
        secrets: [],
        playerKnowledge: [],
        traits: [],
        conditions: [],
        inventory: [],
      },
    );
    const root = await mkdtemp(path.join(tmpdir(), "llm-dungeon-fact-ids-"));
    const store = new StateStore(path.join(root, "data"));
    await store.createGame({ setup, worldRules: "Classic fantasy." });

    const factIds = [...(await store.load()).entities.values()].flatMap((entity) => entity.facts.map((fact) => fact.id));
    expect(new Set(factIds).size).toBe(factIds.length);
  });

  it("rejects a tampered locked roll instead of trusting persisted derived fields", async () => {
    const store = await createTestStore();
    const checkResult = resolveCheck({
      name: "Stealth",
      difficulty: 50,
      modifiers: [{ label: "Cover", value: 10 }],
      successStakes: "Pass unseen.",
      failureStakes: "Be noticed.",
      failureCampaignStatus: "none",
    }, 40);
    await writeFile(store.pendingPath, JSON.stringify({
      kind: "action",
      action: "I sneak past.",
      phase: "rolled",
      checkResult: { ...checkResult, outcome: "failure" },
    }), "utf8");
    await expect(store.getPending()).rejects.toThrow(/locked natural roll/);
  });

  it("rejects traversal in a prepared commit before writing outside the campaign", async () => {
    const store = await createTestStore();
    const manifestPath = path.join(store.currentDir, "manifest.json");
    const before = await readFile(manifestPath, "utf8");
    const entityPath = path.join(store.currentDir, "entities", entityFilename("player:hero"));
    const entityBefore = await readFile(entityPath, "utf8");
    const manifest = JSON.parse(before) as Record<string, unknown>;
    const escapePath = path.join(store.dataRoot, "escaped.txt");
    await writeFile(store.pendingPath, JSON.stringify({
      kind: "commit",
      campaignId: manifest.campaignId,
      expectedPreviousTurn: 0,
      targetTurn: 1,
      preManifestHash: createHash("sha256").update(before).digest("hex"),
      writes: {
        "entities/player@hero.md": "would corrupt an authoritative file if validation were incremental",
        "turns/../../escaped.txt": "unsafe",
        "turns/000001.md": renderTurnLog(1, {
          action: "Recovery fixture.",
          resolved: { narration: "Fixture.", turnSummary: "Fixture.", operations: [] },
          provider: "fake",
          model: "fake-model",
        }),
        "manifest.json": `${JSON.stringify({ ...manifest, turn: 1 }, null, 2)}\n`,
      },
    }), "utf8");
    await expect(store.recoverCommit()).rejects.toThrow(/Unsafe or unsupported path/);
    await expect(access(escapePath)).rejects.toThrow();
    expect(await readFile(entityPath, "utf8")).toBe(entityBefore);
  });

  it("requires exactly the target turn log and never rewrites earlier turns", async () => {
    const store = await createTestStore();
    const manifestPath = path.join(store.currentDir, "manifest.json");
    const manifestText = await readFile(manifestPath, "utf8");
    const manifest = JSON.parse(manifestText) as Record<string, unknown>;
    const targetManifest = `${JSON.stringify({ ...manifest, turn: 1 }, null, 2)}\n`;
    const metadata = {
      kind: "commit",
      campaignId: manifest.campaignId,
      expectedPreviousTurn: 0,
      targetTurn: 1,
      preManifestHash: createHash("sha256").update(manifestText).digest("hex"),
    };

    await writeFile(store.pendingPath, JSON.stringify({
      ...metadata,
      writes: { "manifest.json": targetManifest },
    }), "utf8");
    await expect(store.recoverCommit()).rejects.toThrow(/must write its target turn log/);
    expect(await readFile(manifestPath, "utf8")).toBe(manifestText);

    const turnZeroPath = path.join(store.currentDir, "turns", "000000.md");
    const turnZero = await readFile(turnZeroPath, "utf8");
    await writeFile(store.pendingPath, JSON.stringify({
      ...metadata,
      writes: {
        "turns/000000.md": "corrupt an already committed turn",
        "turns/000001.md": renderTurnLog(1, {
          action: "Recovery fixture.",
          resolved: { narration: "Fixture.", turnSummary: "Fixture.", operations: [] },
          provider: "fake",
          model: "fake-model",
        }),
        "manifest.json": targetManifest,
      },
    }), "utf8");
    await expect(store.recoverCommit()).rejects.toThrow(/only its target turn log/);
    expect(await readFile(turnZeroPath, "utf8")).toBe(turnZero);
    expect(await readFile(manifestPath, "utf8")).toBe(manifestText);
  });

  it("keeps the active campaign when replacement setup validation fails", async () => {
    const store = await createTestStore();
    const campaignId = (await store.load()).manifest.campaignId;
    const invalid = structuredClone(setupFixture);
    invalid.threads[0]!.relatedEntityIds = ["npc:missing"];
    await expect(store.replaceGame({ setup: invalid, worldRules: "Classic fantasy." })).rejects.toThrow();
    expect((await store.load()).manifest.campaignId).toBe(campaignId);
  });

  it("recovers an accepted campaign replacement after the durable intent is written", async () => {
    const store = await createTestStore();
    const previousCampaignId = (await store.load()).manifest.campaignId;
    const temporaryRoot = await mkdtemp(path.join(tmpdir(), "llm-dungeon-replacement-stage-"));
    const stagedStore = new StateStore(path.join(temporaryRoot, "data"));
    const replacementSetup = structuredClone(setupFixture);
    replacementSetup.campaignTitle = "Recovered Replacement";
    const replacement = await stagedStore.createGame({ setup: replacementSetup, worldRules: "Classic fantasy." });
    const stagedDirectory = ".new-recovery-fixture";
    const stagedPath = path.join(store.dataRoot, stagedDirectory);
    await rename(stagedStore.currentDir, stagedPath);
    const archivedDirectory = "recovery-fixture-archive";
    await writeFile(store.replacementIntentPath, JSON.stringify({
      schemaVersion: 1,
      stagedDirectory,
      stagedCampaignId: replacement.campaignId,
      archivedDirectory,
      previousCampaignId,
    }), "utf8");

    expect(await store.hasCurrentGame()).toBe(true);
    expect((await store.load()).manifest).toMatchObject({
      campaignId: replacement.campaignId,
      title: "Recovered Replacement",
    });
    const archivedManifest = JSON.parse(await readFile(
      path.join(store.archiveDir, archivedDirectory, "manifest.json"),
      "utf8",
    )) as { campaignId: string };
    expect(archivedManifest.campaignId).toBe(previousCampaignId);
    await expect(access(store.replacementIntentPath)).rejects.toThrow();
  });

  it("serializes campaign mutations across independent store instances", async () => {
    const store = await createTestStore();
    const other = new StateStore(store.dataRoot);
    let unlock!: () => void;
    let acquired!: () => void;
    const acquiredPromise = new Promise<void>((resolve) => { acquired = resolve; });
    const gate = new Promise<void>((resolve) => { unlock = resolve; });
    const holding = store.withCampaignLock(async () => {
      acquired();
      await gate;
    });
    await acquiredPromise;

    await expect(other.setLanguage("ru")).rejects.toThrow(/locked by another running process/);
    unlock();
    await holding;
    await expect(access(store.lockPath)).rejects.toThrow();
    expect((await other.setLanguage("ru")).language).toBe("ru");
  });
});
