import { createHash } from "node:crypto";
import { access, mkdtemp, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { canonicalEntityName } from "../src/domain/ids.js";
import { resolveCheck } from "../src/mechanics.js";
import {
  entityFilename,
  renderChronicle,
  renderEntity,
  renderThreads,
  renderTurnLog,
} from "../src/persistence/markdown.js";
import { StateStore, validateInitialSetup, type LoadedCampaign } from "../src/store.js";
import { createTestStore, setupFixture } from "./helpers.js";

async function snapshotFiles(root: string): Promise<Record<string, string>> {
  const snapshot: Record<string, string> = {};
  const visit = async (directory: string, prefix: string): Promise<void> => {
    const entries = (await readdir(directory, { withFileTypes: true }))
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(target, relative);
      } else {
        snapshot[relative] = await readFile(target, "utf8");
      }
    }
  };
  await visit(root, "");
  return snapshot;
}

async function writePreparedCommitFixture(
  store: StateStore,
  loaded: LoadedCampaign,
  additionalWrites: Record<string, string>,
): Promise<{ targetManifestText: string; targetTurnPath: string; targetTurnText: string }> {
  const manifestPath = path.join(store.currentDir, "manifest.json");
  const manifestText = await readFile(manifestPath, "utf8");
  const targetTurn = loaded.manifest.turn + 1;
  const targetTurnPath = `turns/${String(targetTurn).padStart(6, "0")}.md`;
  const targetTurnText = renderTurnLog(targetTurn, {
    action: "Recovery validation fixture.",
    resolved: { narration: "Fixture narration.", turnSummary: "Fixture summary.", operations: [] },
    provider: "fake",
    model: "fake-model",
  });
  const targetManifestText = `${JSON.stringify({ ...loaded.manifest, turn: targetTurn }, null, 2)}\n`;
  await writeFile(store.pendingPath, JSON.stringify({
    kind: "commit",
    campaignId: loaded.manifest.campaignId,
    expectedPreviousTurn: loaded.manifest.turn,
    targetTurn,
    preManifestHash: createHash("sha256").update(manifestText).digest("hex"),
    writes: {
      [targetTurnPath]: targetTurnText,
      "manifest.json": targetManifestText,
      ...additionalWrites,
    },
  }), "utf8");
  return { targetManifestText, targetTurnPath, targetTurnText };
}

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
    selfNested.entities.find((entity) => entity.id === "item:travel-sword")!.location = "location:crooked-crown";
    expect(() => validateInitialSetup(selfNested)).toThrow(/cannot be located inside itself/);
    expect(() => validateInitialSetup(selfNested)).toThrow(/must not also have a world location/);
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

  it("rejects malformed or inconsistent planned documents without any filesystem mutation", async () => {
    const corruptions: Array<{
      name: string;
      expected: RegExp;
      writes: (loaded: LoadedCampaign) => Record<string, string>;
    }> = [
      {
        name: "malformed entity",
        expected: /contentCodec/,
        writes: (loaded) => ({
          [`entities/${loaded.entityFiles.get("player:hero")!}`]: "not an entity document",
        }),
      },
      {
        name: "entity missing generated body sections",
        expected: /missing generated Description section/,
        writes: (loaded) => {
          const locationId = loaded.manifest.currentLocationId;
          const rendered = renderEntity(loaded.entities.get(locationId)!);
          const frontmatterEnd = rendered.indexOf("\n---\n", 4);
          return {
            [`entities/${loaded.entityFiles.get(locationId)!}`]: `${rendered.slice(0, frontmatterEnd + 5)}# Metadata only\n`,
          };
        },
      },
      {
        name: "entity missing defaulted metadata",
        expected: /missing structured status metadata/,
        writes: (loaded) => {
          const locationId = loaded.manifest.currentLocationId;
          return {
            [`entities/${loaded.entityFiles.get(locationId)!}`]: renderEntity(
              loaded.entities.get(locationId)!,
            ).replace(/^status:.*\n/m, ""),
          };
        },
      },
      {
        name: "null entity collection metadata",
        expected: /expected array/i,
        writes: (loaded) => {
          const locationId = loaded.manifest.currentLocationId;
          return {
            [`entities/${loaded.entityFiles.get(locationId)!}`]: renderEntity(
              loaded.entities.get(locationId)!,
            ).replace(/^traits:.*$/m, "traits: null"),
          };
        },
      },
      {
        name: "null entity tags metadata",
        expected: /expected array/i,
        writes: (loaded) => {
          const locationId = loaded.manifest.currentLocationId;
          const location = loaded.entities.get(locationId)!;
          return {
            [`entities/${loaded.entityFiles.get(locationId)!}`]: renderEntity({
              ...location,
              tags: [],
            }).replace(/^tags:.*$/m, "tags: null"),
          };
        },
      },
      {
        name: "durable entity fact erasure",
        expected: /drops durable fact/,
        writes: (loaded) => {
          const locationId = loaded.manifest.currentLocationId;
          return {
            [`entities/${loaded.entityFiles.get(locationId)!}`]: renderEntity({
              ...loaded.entities.get(locationId)!,
              facts: [],
            }),
          };
        },
      },
      {
        name: "existing entity ID replacement",
        expected: /cannot change durable ID/,
        writes: (loaded) => {
          const existingId = "npc:mara-venn";
          return {
            [`entities/${loaded.entityFiles.get(existingId)!}`]: renderEntity({
              ...loaded.entities.get(existingId)!,
              id: "npc:replacement",
            }),
          };
        },
      },
      {
        name: "application-generated entity filename",
        expected: /must use generated filename/,
        writes: (loaded) => ({
          "entities/model-chosen-name.md": renderEntity({
            id: "npc:new-witness",
            kind: "person",
            name: "New Witness",
            status: "alive",
            location: loaded.manifest.currentLocationId,
            tags: [],
            updatedTurn: loaded.manifest.turn + 1,
            description: "A recovery fixture.",
            traits: [],
            conditions: [],
            inventory: [],
            facts: [],
            relationships: [],
          }),
        }),
      },
      {
        name: "immutable entity description rewrite",
        expected: /cannot rewrite immutable description/,
        writes: (loaded) => {
          const locationId = loaded.manifest.currentLocationId;
          return {
            [`entities/${loaded.entityFiles.get(locationId)!}`]: renderEntity({
              ...loaded.entities.get(locationId)!,
              description: "A corrupted replacement description.",
            }),
          };
        },
      },
      {
        name: "established trait erasure",
        expected: /drops established trait/,
        writes: (loaded) => ({
          [`entities/${loaded.entityFiles.get(loaded.manifest.playerId)!}`]: renderEntity({
            ...loaded.entities.get(loaded.manifest.playerId)!,
            traits: [],
          }),
        }),
      },
      {
        name: "malformed threads",
        expected: /missing structured thread metadata/,
        writes: () => ({ "threads.md": "# Story Threads without durable metadata\n" }),
      },
      {
        name: "null thread metadata",
        expected: /expected array/i,
        writes: () => ({ "threads.md": "---\nthreads: null\n---\n# Story Threads\n" }),
      },
      {
        name: "existing thread erasure",
        expected: /drops existing thread/,
        writes: () => ({ "threads.md": renderThreads([]) }),
      },
      {
        name: "malformed chronicle",
        expected: /missing structured event metadata/,
        writes: () => ({ "chronicle.md": "# Chronicle without durable metadata\n" }),
      },
      {
        name: "null chronicle metadata",
        expected: /expected array/i,
        writes: () => ({ "chronicle.md": "---\nevents: null\n---\n# Chronicle\n" }),
      },
      {
        name: "inconsistent entity graph",
        expected: /does not match manifest location/,
        writes: (loaded) => {
          const player = { ...loaded.entities.get("player:hero")!, location: "location:missing", updatedTurn: 1 };
          return { [`entities/${loaded.entityFiles.get(player.id)!}`]: renderEntity(player) };
        },
      },
      {
        name: "inconsistent thread graph",
        expected: /references unknown entity npc:missing/,
        writes: (loaded) => ({
          "threads.md": renderThreads(loaded.threads.map((thread, index) => index === 0
            ? { ...thread, relatedEntityIds: ["npc:missing"] }
            : thread)),
        }),
      },
      {
        name: "inconsistent chronicle graph",
        expected: /from future turn 2/,
        writes: () => ({
          "chronicle.md": renderChronicle([{ id: "event:future", text: "Not committed yet.", turn: 2 }]),
        }),
      },
      {
        name: "missing durable turn sections",
        expected: /missing nonempty Player Action/,
        writes: (loaded) => {
          const targetTurn = loaded.manifest.turn + 1;
          return {
            [`turns/${String(targetTurn).padStart(6, "0")}.md`]: [
              "---",
              `turn: ${targetTurn}`,
              "turnKind: gameplay",
              "---",
              `# Turn ${targetTurn}`,
              "",
              "## State Operations",
              "",
              "```json",
              "[]",
              "```",
              "",
            ].join("\n"),
          };
        },
      },
      {
        name: "opening kind after turn zero",
        expected: /Only turn zero may be an opening turn/,
        writes: (loaded) => {
          const targetTurn = loaded.manifest.turn + 1;
          return {
            [`turns/${String(targetTurn).padStart(6, "0")}.md`]: renderTurnLog(targetTurn, {
              action: "Invalid opening fixture.",
              resolved: { narration: "Invalid opening.", turnSummary: "Invalid opening.", operations: [] },
              provider: "fake",
              model: "fake-model",
            }).replace("turnKind: gameplay", "turnKind: opening"),
          };
        },
      },
      {
        name: "invalid private check metadata",
        expected: /Unexpected token|JSON/i,
        writes: (loaded) => {
          const targetTurn = loaded.manifest.turn + 1;
          return {
            [`turns/${String(targetTurn).padStart(6, "0")}.md`]: renderTurnLog(targetTurn, {
              action: "Invalid check fixture.",
              resolved: { narration: "Invalid check.", turnSummary: "Invalid check.", operations: [] },
              provider: "fake",
              model: "fake-model",
            }).replace("_No check._", "```json\nnot-json\n```"),
          };
        },
      },
      {
        name: "appeal targeting its own turn",
        expected: /invalid appeal target metadata/,
        writes: (loaded) => {
          const targetTurn = loaded.manifest.turn + 1;
          return {
            [`turns/${String(targetTurn).padStart(6, "0")}.md`]: renderTurnLog(targetTurn, {
              kind: "appeal",
              action: ":appeal Invalid target fixture.",
              resolved: { narration: "Invalid target.", turnSummary: "Invalid target.", operations: [] },
              provider: "fake",
              model: "fake-model",
            }).replace("turnKind: appeal", `turnKind: appeal\nappealTargetTurn: ${targetTurn}`),
          };
        },
      },
      {
        name: "manifest missing defaulted language",
        expected: /target manifest is missing language/,
        writes: (loaded) => {
          const manifest: Record<string, unknown> = { ...loaded.manifest };
          delete manifest.language;
          return {
            "manifest.json": `${JSON.stringify({
              ...manifest,
              turn: loaded.manifest.turn + 1,
            }, null, 2)}\n`,
          };
        },
      },
      {
        name: "immutable campaign title rewrite",
        expected: /changes immutable campaign manifest fields/,
        writes: (loaded) => ({
          "manifest.json": `${JSON.stringify({
            ...loaded.manifest,
            title: "Corrupted Campaign Title",
            turn: loaded.manifest.turn + 1,
          }, null, 2)}\n`,
        }),
      },
    ];

    for (const corruption of corruptions) {
      const store = await createTestStore();
      const loaded = await store.load();
      await writePreparedCommitFixture(store, loaded, corruption.writes(loaded));
      const before = await snapshotFiles(store.currentDir);
      await expect(store.recoverCommit(), corruption.name).rejects.toThrow(corruption.expected);
      expect(await snapshotFiles(store.currentDir), corruption.name).toEqual(before);
    }
  });

  it("does not clear a manifest-committed recovery record until every planned write exists", async () => {
    const store = await createTestStore();
    const loaded = await store.load();
    const newEntityPath = `entities/${entityFilename("npc:unwritten")}`;
    const newEntity = renderEntity({
      id: "npc:unwritten",
      kind: "person",
      name: "Unwritten Witness",
      status: "alive",
      location: loaded.manifest.currentLocationId,
      tags: [],
      updatedTurn: 1,
      description: "A recovery fixture.",
      traits: [],
      conditions: [],
      inventory: [],
      facts: [],
      relationships: [],
    });
    const prepared = await writePreparedCommitFixture(store, loaded, { [newEntityPath]: newEntity });
    await writeFile(path.join(store.currentDir, prepared.targetTurnPath), prepared.targetTurnText, "utf8");
    await writeFile(path.join(store.currentDir, "manifest.json"), prepared.targetManifestText, "utf8");

    await expect(store.recoverCommit()).rejects.toThrow(`missing planned write ${newEntityPath}`);
    expect(await readFile(store.pendingPath, "utf8")).toContain('"kind":"commit"');
    await expect(access(path.join(store.currentDir, newEntityPath))).rejects.toThrow();
  });

  it("rejects a planned chronicle that erases committed history without mutating files", async () => {
    const store = await createTestStore();
    await store.commitTurn({
      action: "I record the warning.",
      resolved: {
        narration: "The warning is entered into the chronicle.",
        turnSummary: "A warning was recorded.",
        operations: [{ type: "record_major_event", eventId: "event:warning", text: "The warning was recorded." }],
      },
      provider: "fake",
      model: "fake-model",
    });
    const loaded = await store.load();
    await writePreparedCommitFixture(store, loaded, { "chronicle.md": renderChronicle([]) });
    const before = await snapshotFiles(store.currentDir);

    await expect(store.recoverCommit()).rejects.toThrow(/does not preserve event/);
    expect(await snapshotFiles(store.currentDir)).toEqual(before);
  });

  it("rejects a planned entity that erases an established relationship without mutating files", async () => {
    const store = await createTestStore();
    await store.commitTurn({
      action: "I establish a working arrangement with Mara.",
      resolved: {
        narration: "Mara agrees to a cautious working arrangement.",
        turnSummary: "The hero and Mara established a working arrangement.",
        operations: [{
          type: "set_relationship",
          sourceId: "player:hero",
          targetId: "npc:mara-venn",
          summary: "A cautious working arrangement.",
        }],
      },
      provider: "fake",
      model: "fake-model",
    });
    const loaded = await store.load();
    const player = loaded.entities.get(loaded.manifest.playerId)!;
    await writePreparedCommitFixture(store, loaded, {
      [`entities/${loaded.entityFiles.get(player.id)!}`]: renderEntity({ ...player, relationships: [] }),
    });
    const before = await snapshotFiles(store.currentDir);

    await expect(store.recoverCommit()).rejects.toThrow(/drops relationship/);
    expect(await snapshotFiles(store.currentDir)).toEqual(before);
  });

  it("rejects a planned rewrite of a terminal story thread without mutating files", async () => {
    const store = await createTestStore();
    const initial = await store.load();
    const threadId = initial.threads[0]!.id;
    await store.commitTurn({
      action: "I resolve the silence on the northern road.",
      resolved: {
        narration: "The northern road is made safe again.",
        turnSummary: "The northern-road mystery was resolved.",
        operations: [{
          type: "resolve_thread",
          threadId,
          status: "resolved",
          outcome: "The road is safe again.",
        }],
      },
      provider: "fake",
      model: "fake-model",
    });
    const loaded = await store.load();
    await writePreparedCommitFixture(store, loaded, {
      "threads.md": renderThreads(loaded.threads.map((thread) =>
        thread.id === threadId ? { ...thread, summary: "Corrupted resolved history." } : thread)),
    });
    const before = await snapshotFiles(store.currentDir);

    await expect(store.recoverCommit()).rejects.toThrow(/rewrites terminal thread/);
    expect(await snapshotFiles(store.currentDir)).toEqual(before);
  });

  it("rejects a pending commit that rewinds elapsed campaign time without mutating files", async () => {
    const store = await createTestStore();
    await store.commitTurn({
      action: "I wait ten minutes.",
      resolved: {
        narration: "Ten minutes pass.",
        turnSummary: "Ten minutes elapsed.",
        operations: [{ type: "advance_time", minutes: 10, timeLabel: "Day 1, 20:10" }],
      },
      provider: "fake",
      model: "fake-model",
    });
    const loaded = await store.load();
    await writePreparedCommitFixture(store, loaded, {
      "manifest.json": `${JSON.stringify({
        ...loaded.manifest,
        turn: loaded.manifest.turn + 1,
        elapsedMinutes: 0,
      }, null, 2)}\n`,
    });
    const before = await snapshotFiles(store.currentDir);

    await expect(store.recoverCommit()).rejects.toThrow(/cannot rewind elapsed campaign time/);
    expect(await snapshotFiles(store.currentDir)).toEqual(before);
  });

  it("rejects a new pending commit for a terminal campaign without mutating files", async () => {
    const store = await createTestStore();
    await store.commitTurn({
      action: "I accept the final ending.",
      resolved: {
        narration: "The campaign reaches its final ending.",
        turnSummary: "The campaign ended.",
        operations: [{ type: "end_campaign", status: "ended", reason: "The story is complete." }],
      },
      provider: "fake",
      model: "fake-model",
    });
    const loaded = await store.load();
    await writePreparedCommitFixture(store, loaded, {});
    const before = await snapshotFiles(store.currentDir);

    await expect(store.recoverCommit()).rejects.toThrow(/terminal campaign cannot prepare another turn/);
    expect(await snapshotFiles(store.currentDir)).toEqual(before);
  });

  it("does not clear a manifest-committed recovery record when a planned write differs", async () => {
    const store = await createTestStore();
    const loaded = await store.load();
    const plannedThreads = renderThreads(loaded.threads.map((thread, index) => index === 0
      ? { ...thread, summary: "A planned recovered summary." }
      : thread));
    const prepared = await writePreparedCommitFixture(store, loaded, { "threads.md": plannedThreads });
    await writeFile(path.join(store.currentDir, prepared.targetTurnPath), prepared.targetTurnText, "utf8");
    await writeFile(path.join(store.currentDir, "manifest.json"), prepared.targetManifestText, "utf8");

    await expect(store.recoverCommit()).rejects.toThrow(/differs from planned write threads\.md/);
    expect(await readFile(store.pendingPath, "utf8")).toContain('"kind":"commit"');
    expect(await readFile(path.join(store.currentDir, "threads.md"), "utf8")).not.toBe(plannedThreads);
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
