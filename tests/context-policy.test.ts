import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { conservativeInputTokenEstimate } from "../src/input-budget.js";
import { DungeonEngine } from "../src/engine.js";
import {
  entityFilename,
  renderContextEntities,
  renderEntity,
  renderThreads,
  renderTurnLog,
} from "../src/persistence/markdown.js";
import {
  APPEAL_CONTEXT_TOKEN_TARGET,
  assertNewCampaignImmutableContextFits,
  assertNewCampaignOriginInputFits,
  COMPLETED_STORY_CONTEXT_TOKEN_TARGET,
  GAMEPLAY_CONTEXT_MINIMUM_TOKEN_TARGET,
  GAMEPLAY_CONTEXT_SECTION_BUDGETS,
  GAMEPLAY_CONTEXT_TOKEN_TARGET,
  PLAYER_CONTEXT_TOKEN_TARGET,
} from "../src/store.js";
import type { Entity } from "../src/schemas.js";
import type { LlmProvider, StructuredRequest, StructuredResult } from "../src/types.js";
import { createTestStore, setupFixture } from "./helpers.js";

function denseEntity(): Entity {
  return {
    id: "player:dense",
    kind: "person",
    name: "Dense Memory",
    status: "active",
    tags: [],
    updatedTurn: 1_000,
    description: "A legacy player whose canonical record predates bounded context.",
    traits: [],
    conditions: [],
    inventory: [],
    facts: [
      ...Array.from({ length: 1_000 }, (_, index) => ({
        id: `fact:memory-${String(index).padStart(4, "0")}`,
        section: "knowledge" as const,
        text: `${index === 999 ? "LATEST RELEVANT CLUE" : `Legacy memory ${index}`} ${"x".repeat(100)}`,
        active: true,
      })),
      {
        id: "fact:inactive-secret",
        section: "secrets" as const,
        text: "INACTIVE PRIVATE HISTORY MUST STAY COLD",
        active: false,
      },
    ],
    relationships: [],
  };
}

function syntheticTurn(turn: number): string {
  return renderTurnLog(turn, {
    action: `Synthetic action ${turn}`,
    resolved: {
      narration: `Synthetic narration ${turn}`,
      turnSummary: `Synthetic summary ${turn}`,
      operations: [],
    },
    provider: "fake",
    model: "fake-model",
  });
}

class LongRunProvider implements LlmProvider {
  readonly id = "gemini";
  readonly model = "gemini-3.6-flash";
  calls = 0;

  async generateStructured<T>(request: StructuredRequest<T>): Promise<StructuredResult<T>> {
    this.calls += 1;
    return {
      data: request.schema.parse({
        kind: "resolved",
        narration: "The ten-thousand-turn campaign continues from its durable state.",
        turnSummary: "The long campaign continued without replaying compacted history.",
        operations: [],
      }),
      provider: this.id,
      model: this.model,
      usage: { inputTokens: 8_000, outputTokens: 300, billedCostUsd: 0.001 },
    };
  }
}

describe("bounded campaign context policy", () => {
  it("honors a reduced gameplay target while retaining fixed authority and prioritized origin lanes", async () => {
    const store = await createTestStore();
    const loaded = await store.load();
    const player = loaded.entities.get(loaded.manifest.playerId)!;
    player.facts.push(
      ...Array.from({ length: 300 }, (_, index) => ({
        id: `fact:legacy-dense-${String(index).padStart(3, "0")}`,
        section: "knowledge" as const,
        text: `Legacy durable detail ${index} ${"x".repeat(180)}`,
        active: true,
      })),
    );
    await writeFile(
      path.join(store.currentDir, "entities", entityFilename(player.id)),
      renderEntity(player),
      "utf8",
    );
    await writeFile(
      path.join(store.currentDir, "scenario.md"),
      `# Campaign Rules Snapshot\n\n${"R".repeat(40_000)}\n\n# Scenario\n\n${"S".repeat(20_000)}\n`,
      "utf8",
    );
    await mkdir(path.join(store.currentDir, "setup"), { recursive: true });
    await writeFile(
      path.join(store.currentDir, "setup", "premise.md"),
      `${"P".repeat(20_000)}\n`,
      "utf8",
    );
    await writeFile(
      path.join(store.currentDir, "setup", "character-concept.md"),
      `${"C".repeat(30_000)}\n`,
      "utf8",
    );

    const full = await store.buildContextDocument("I continue the investigation.");
    const reduced = await store.buildContextDocument(
      "I continue the investigation.",
      GAMEPLAY_CONTEXT_MINIMUM_TOKEN_TARGET,
    );
    const section = (document: typeof full, id: string) =>
      document.sections.find((candidate) => candidate.id === id)?.content;

    expect(conservativeInputTokenEstimate(full.text)).toBeGreaterThan(
      conservativeInputTokenEstimate(reduced.text),
    );
    expect(conservativeInputTokenEstimate(reduced.text)).toBeLessThanOrEqual(
      GAMEPLAY_CONTEXT_MINIMUM_TOKEN_TARGET,
    );
    expect(section(reduced, "campaign-state")).toBe(section(full, "campaign-state"));
    expect(section(reduced, "authority")).toBe(section(full, "authority"));
    expect(section(reduced, "campaign-rules")).toContain("campaign rules and scenario abbreviated");
    expect(section(reduced, "campaign-origin-seeds")).toContain("origin evidence abbreviated");
    expect(section(reduced, "relevant-entities")).toContain(`[${setupFixture.player.id}]`);
    expect(section(reduced, "continuity-ledger")).toContain("PLACEMENT:");
    const clamped = await store.buildContextDocument(
      "I continue the investigation.",
      GAMEPLAY_CONTEXT_MINIMUM_TOKEN_TARGET - 1,
    );
    expect(clamped.text).toBe(reduced.text);
    expect(conservativeInputTokenEstimate(clamped.text)).toBeLessThanOrEqual(
      GAMEPLAY_CONTEXT_MINIMUM_TOKEN_TARGET,
    );
  });

  it("ends gameplay context with an authoritative physical-presence and outcome checkpoint", async () => {
    const store = await createTestStore();
    await store.commitTurn({
      action: "Mara leaves for the watch post.",
      resolved: {
        narration: "Mara crosses the road and enters the watch post.",
        turnSummary: "Mara left the tavern and arrived at the watch post.",
        operations: [
          {
            type: "create_entity",
            entity: {
              id: "location:watch-post",
              kind: "location",
              name: "Watch Post",
              status: "open",
              tags: ["guarded"],
              description: "A stone post across the northern road.",
              establishedFacts: [],
              secrets: [],
              playerKnowledge: [],
            },
          },
          {
            type: "move_entity",
            targetId: "npc:mara-venn",
            locationId: "location:watch-post",
          },
        ],
      },
      provider: "fake",
      model: "fake-model",
    });

    const context = await store.buildContextDocument("I ask Mara Venn a question here.");
    const checkpoint = context.sections.at(-1);

    expect(checkpoint?.id).toBe("continuity-ledger");
    expect(checkpoint?.title).toBe("FINAL CONTINUITY CHECKPOINT — AUTHORITATIVE");
    expect(checkpoint?.content).toContain('[npc:mara-venn] "Mara Venn": ABSENT FROM CURRENT SCENE');
    expect(checkpoint?.content).toContain("authoritative location=[location:watch-post]");
    expect(checkpoint?.content).toContain(
      "Last committed outcome (Turn 1): Mara left the tavern and arrived at the watch post.",
    );
    expect(checkpoint?.content).toContain("One durable entity ID is one physical body");
    expect(checkpoint?.content).toContain("CANONICAL LOCATION IDS");
    expect(checkpoint?.content).toContain('[location:watch-post] "Watch Post"');
    expect(checkpoint?.content).toContain("never shorten, reconstruct, or guess");
    expect(checkpoint?.content).toContain(
      "copy only the exact characters inside one bracketed authoritative ID",
    );
    expect(checkpoint?.content).not.toContain("thread:the-empty-colony-turn-0");
    expect(conservativeInputTokenEstimate(context.text)).toBeLessThanOrEqual(
      GAMEPLAY_CONTEXT_TOKEN_TARGET,
    );
    expect(conservativeInputTokenEstimate(checkpoint?.content ?? "")).toBeLessThanOrEqual(
      GAMEPLAY_CONTEXT_SECTION_BUDGETS.continuity,
    );
  });

  it("ends the checkpoint with bounded actor inventory, player capability, and active-thread authority", async () => {
    const store = await createTestStore();
    const activeThread = (await store.load()).threads.find((thread) => thread.status === "active")!;
    await store.commitTurn({
      action: "I begin tracing the missing travelers.",
      resolved: {
        narration: "You compare the last known routes while Mara keeps watch.",
        turnSummary: "The northern-road investigation began with a comparison of routes.",
        operations: [
          {
            type: "update_thread",
            threadId: activeThread.id,
            summary: "Arlen is comparing the missing travelers' last known routes.",
          },
        ],
      },
      provider: "fake",
      model: "fake-model",
    });

    const checkpoint = (await store.buildContextDocument()).sections.at(-1)!;

    expect(checkpoint.content).toContain("FINAL AUTHORITY CAPSULE — READ BEFORE RESOLVING");
    expect(checkpoint.content).toContain("ACTORS — EXACT AUTHORITY FOR EACH LISTED RECORD");
    expect(checkpoint.content).toMatch(
      /\[player:hero\] "Arlen Vale"[^\n]*inventory=1x\[item:travel-sword\] "Travel Sword"/,
    );
    expect(checkpoint.content).toMatch(/\[npc:mara-venn\] "Mara Venn"[^\n]*inventory=EMPTY/);
    expect(checkpoint.content).toContain("PLAYER TRAITS / CAPABILITY CONTRACTS — BOUNDED REMINDER");
    expect(checkpoint.content).toContain('- "Keen-eyed"');
    expect(checkpoint.content).toContain('- "Patient"');
    expect(checkpoint.content).toContain("ACTIVE THREADS — AUDIT EACH BY ITS NUMBER");
    expect(checkpoint.content).toContain(
      `[${activeThread.id}] immutable objective="Travelers have stopped arriving from the north."; current summary="Arlen is comparing the missing travelers' last known routes."; updated@1; newer linked player-known facts=0`,
    );
    expect(checkpoint.content).toContain(
      "Newer linked player-known facts are a review signal, not automatic progress.",
    );
    expect(conservativeInputTokenEstimate(checkpoint.content)).toBeLessThanOrEqual(
      GAMEPLAY_CONTEXT_SECTION_BUDGETS.continuity,
    );
  });

  it("signals newer player-known facts on thread-linked entities until the thread advances", async () => {
    const store = await createTestStore();
    const activeThread = (await store.load()).threads.find((thread) => thread.status === "active")!;
    await store.commitTurn({
      action: "I connect Mara to the northern-road investigation.",
      resolved: {
        narration: "Mara becomes the investigation's local point of contact.",
        turnSummary: "Mara became the local point of contact for the northern road.",
        operations: [
          {
            type: "update_thread",
            threadId: activeThread.id,
            summary: "Mara is the local contact for investigating the missing travelers.",
            relatedEntityIds: ["npc:mara-venn"],
          },
        ],
      },
      provider: "fake",
      model: "fake-model",
    });
    await store.commitTurn({
      action: "I ask Mara what she learned.",
      resolved: {
        narration: "Mara reports fresh wagon tracks continuing north past the old bridge.",
        turnSummary: "Mara reported fresh wagon tracks north of the bridge.",
        operations: [
          {
            type: "add_fact",
            targetId: "npc:mara-venn",
            section: "knowledge",
            factId: "fact:fresh-wagon-tracks",
            text: "Mara reported fresh wagon tracks continuing north past the old bridge.",
          },
        ],
      },
      provider: "fake",
      model: "fake-model",
    });

    const staleCheckpoint = (await store.buildContextDocument()).sections.at(-1)!;
    expect(staleCheckpoint.content).toContain(
      `[${activeThread.id}] immutable objective="Travelers have stopped arriving from the north."; current summary="Mara is the local contact for investigating the missing travelers."; updated@1; newer linked player-known facts=1`,
    );
    expect(staleCheckpoint.content).toContain(
      'newest=turn2 [npc:mara-venn] "Mara reported fresh wagon tracks continuing north past the old bridge."',
    );
    expect(
      (await store.load()).threads.find((thread) => thread.id === activeThread.id),
    ).toMatchObject({
      summary: "Mara is the local contact for investigating the missing travelers.",
      updatedTurn: 1,
    });

    await store.commitTurn({
      action: "I add the tracks to the investigation.",
      resolved: {
        narration: "You add Mara's report to the northern-road investigation.",
        turnSummary: "The fresh wagon tracks became the investigation's next lead.",
        operations: [
          {
            type: "update_thread",
            threadId: activeThread.id,
            summary:
              "Mara reported fresh wagon tracks continuing north past the old bridge, providing the next lead.",
            relatedEntityIds: ["npc:mara-venn"],
          },
        ],
      },
      provider: "fake",
      model: "fake-model",
    });

    const freshCheckpoint = (await store.buildContextDocument()).sections.at(-1)!;
    expect(freshCheckpoint.content).toContain("updated@3; newer linked player-known facts=0");
    expect(freshCheckpoint.content).not.toContain("newest=turn2");
    expect(conservativeInputTokenEstimate(freshCheckpoint.content)).toBeLessThanOrEqual(
      GAMEPLAY_CONTEXT_SECTION_BUDGETS.continuity,
    );
  });

  it("does not turn unknown physical placement into authoritative absence", async () => {
    const store = await createTestStore();
    const loaded = await store.load();
    const mara = loaded.entities.get("npc:mara-venn")!;
    mara.location = undefined;
    await writeFile(
      path.join(store.currentDir, "entities", entityFilename(mara.id)),
      renderEntity(mara),
      "utf8",
    );

    const checkpoint = (
      await store.buildContextDocument("I ask Mara Venn where she is.")
    ).sections.at(-1)!;

    expect(checkpoint.content).toContain(
      '[npc:mara-venn] "Mara Venn": CURRENT PHYSICAL LOCATION UNKNOWN',
    );
    expect(checkpoint.content).not.toContain(
      '[npc:mara-venn] "Mara Venn": ABSENT FROM CURRENT SCENE',
    );
    expect(conservativeInputTokenEstimate(checkpoint.content)).toBeLessThanOrEqual(
      GAMEPLAY_CONTEXT_SECTION_BUDGETS.continuity,
    );
  });

  it("ends with authoritative custody for explicitly referenced items", async () => {
    const store = await createTestStore();
    await store.commitTurn({
      action: "A medicine crate is placed loose in the tavern.",
      resolved: {
        narration: "A medicine crate is placed on the tavern floor.",
        turnSummary: "A medicine crate was left loose in the tavern.",
        operations: [
          {
            type: "create_entity",
            entity: {
              id: "item:medicine-crate",
              kind: "item",
              name: "Medicine Crate",
              status: "sealed",
              tags: ["medical-supplies"],
              description: "A reinforced crate of frontier medicine.",
              establishedFacts: [],
              secrets: [],
              playerKnowledge: [],
            },
          },
          {
            type: "change_inventory",
            ownerId: "location:crooked-crown",
            itemId: "item:medicine-crate",
            quantityDelta: 1,
          },
        ],
      },
      provider: "fake",
      model: "fake-model",
    });

    const checkpoint = (
      await store.buildContextDocument("I follow the evidence to locate Medicine Crate.")
    ).sections.at(-1)!;

    expect(checkpoint.content).toContain("ITEM CUSTODY — PRIORITIZED");
    expect(checkpoint.content).toContain(
      '[item:medicine-crate] "Medicine Crate": status="sealed"',
    );
    expect(checkpoint.content).toContain(
      'authoritative custody=1x[location:crooked-crown] "The Crooked Crown" (location)',
    );
    expect(checkpoint.content).toContain(
      "does not place the item in one of that location's child scenes",
    );
    expect(checkpoint.content).toContain(
      "requires a causally narrated event and its matching inventory effect",
    );
    expect(conservativeInputTokenEstimate(checkpoint.content)).toBeLessThanOrEqual(
      GAMEPLAY_CONTEXT_SECTION_BUDGETS.continuity,
    );
  });

  it("repeats active relevant secrets as final DM-only causal constraints", async () => {
    const store = await createTestStore();
    const loaded = await store.load();
    const player = loaded.entities.get(loaded.manifest.playerId)!;
    player.facts.push(
      {
        id: "fact:active-hidden-chronology",
        section: "secrets",
        text: "The missing medicine was hidden below deck before departure.",
        active: true,
      },
      {
        id: "fact:inactive-hidden-chronology",
        section: "secrets",
        text: "An obsolete hidden account must not constrain the current turn.",
        active: false,
      },
    );
    await writeFile(
      path.join(store.currentDir, "entities", entityFilename(player.id)),
      renderEntity(player),
      "utf8",
    );

    const checkpoint = (
      await store.buildContextDocument("I inspect the missing medicine trail.")
    ).sections.at(-1)!;

    expect(checkpoint.content).toContain(
      "DM-ONLY CAUSAL CONSTRAINTS — AUTHORITATIVE; NEVER REVEAL",
    );
    expect(checkpoint.content).toContain(
      "The missing medicine was hidden below deck before departure.",
    );
    expect(checkpoint.content).not.toContain(
      "An obsolete hidden account must not constrain the current turn.",
    );
    expect(checkpoint.content).toContain("Improvise only compatible player-visible clues");
    expect(await store.buildPlayerContext()).not.toContain(
      "The missing medicine was hidden below deck before departure.",
    );
    expect(conservativeInputTokenEstimate(checkpoint.content)).toBeLessThanOrEqual(
      GAMEPLAY_CONTEXT_SECTION_BUDGETS.continuity,
    );
  });

  it("retains a thread-linked hidden actor's setup-era secret under accumulated knowledge", async () => {
    const store = await createTestStore();
    const loaded = await store.load();
    const hiddenTruth = "The administrator opened the sealed object before the signal died.";

    // A mystery's hidden actor is reached only through the active thread's
    // private links, which makes it the last entity selected into context.
    const hiddenActor: Entity = {
      id: "npc:hidden-actor",
      kind: "person",
      name: "Hidden Actor",
      status: "unaccounted for",
      // Deliberately elsewhere: the actor enters context only through the
      // active thread's private links, which is the last selection pass.
      location: "location:far-hollow",
      tags: [],
      updatedTurn: 0,
      description: "A presence behind the disappearance.",
      traits: [],
      conditions: [],
      inventory: [],
      facts: [
        {
          id: "fact:hidden-chronology",
          section: "secrets",
          text: hiddenTruth,
          active: true,
          createdTurn: 0,
        },
      ],
      relationships: [],
    };
    await writeFile(
      path.join(store.currentDir, "entities", entityFilename(hiddenActor.id)),
      renderEntity(hiddenActor),
      "utf8",
    );

    // Investigation accumulates player knowledge and incidental secrets every
    // turn. A newest-first projection would evict the setup-era constraint the
    // campaign must stay compatible with, and insertion order would drop the
    // thread-linked actor first because it is selected last.
    const mara = loaded.entities.get("npc:mara-venn")!;
    for (let turn = 1; turn <= 40; turn += 1) {
      mara.facts.push({
        id: `fact:investigation-note-${turn}`,
        section: "knowledge",
        text: `Investigation note ${turn}: a further detail recorded while questioning witnesses about the northern road and the missing travelers.`,
        active: true,
        createdTurn: turn,
      });
      mara.facts.push({
        id: `fact:incidental-secret-${turn}`,
        section: "secrets",
        text: `Incidental secret ${turn}: a later minor concealment that does not constrain the central chronology of the disappearance at all.`,
        active: true,
        createdTurn: turn,
      });
    }
    await writeFile(
      path.join(store.currentDir, "entities", entityFilename(mara.id)),
      renderEntity(mara),
      "utf8",
    );

    const farHollow: Entity = {
      id: "location:far-hollow",
      kind: "location",
      name: "Far Hollow",
      status: "quiet",
      tags: [],
      updatedTurn: 0,
      description: "A hollow well away from the tavern road.",
      traits: [],
      conditions: [],
      inventory: [],
      facts: [],
      relationships: [],
    };
    await writeFile(
      path.join(store.currentDir, "entities", entityFilename(farHollow.id)),
      renderEntity(farHollow),
      "utf8",
    );

    await writeFile(
      path.join(store.currentDir, "threads.md"),
      renderThreads(
        loaded.threads.map((thread) => ({ ...thread, relatedEntityIds: [hiddenActor.id] })),
      ),
      "utf8",
    );

    const checkpoint = (
      await store.buildContextDocument("I press on with the investigation.")
    ).sections.at(-1)!.content;

    expect(checkpoint).toContain(hiddenTruth);
    // The central constraint must outrank later incidental secrets, not merely
    // appear when the budget happens to be generous.
    const centralOffset = checkpoint.indexOf(hiddenTruth);
    const incidentalOffset = checkpoint.indexOf("Incidental secret");
    expect(centralOffset).toBeGreaterThanOrEqual(0);
    if (incidentalOffset >= 0) expect(centralOffset).toBeLessThan(incidentalOffset);
    expect(await store.buildPlayerContext()).not.toContain(hiddenTruth);
  });

  it("exposes the authoritative campaign clock instead of leaving intervals to improvisation", async () => {
    const store = await createTestStore();
    const state = (await store.buildContextDocument("I wait and listen.")).sections.find(
      (section) => section.id === "campaign-state",
    )!;

    expect(state.content).toContain("Campaign clock:");
    expect(state.content).toContain("minutes elapsed since the opening turn");
    expect(state.content).toContain("Derive every stated interval from this clock");
  });

  it("keeps an explicitly referenced absent actor in a crowded-scene checkpoint", async () => {
    const store = await createTestStore();
    const loaded = await store.load();
    const mara = loaded.entities.get("npc:mara-venn")!;
    const watchPost: Entity = {
      id: "location:watch-post",
      kind: "location",
      name: "Watch Post",
      status: "open",
      tags: [],
      updatedTurn: 0,
      description: "A post beyond the tavern.",
      traits: [],
      conditions: [],
      inventory: [],
      facts: [],
      relationships: [],
    };
    mara.location = watchPost.id;
    const crowd: Entity[] = Array.from({ length: 20 }, (_, index) => ({
      id: `npc:patron-${String(index).padStart(2, "0")}`,
      kind: "person",
      name: `Patron ${String(index).padStart(2, "0")}`,
      status: "drinking quietly",
      location: loaded.manifest.currentLocationId,
      tags: [],
      updatedTurn: 0,
      description: "A tavern patron.",
      traits: [],
      conditions: [],
      inventory: [],
      facts: [],
      relationships: [],
    }));
    await Promise.all(
      [mara, watchPost, ...crowd].map((entity) =>
        writeFile(
          path.join(store.currentDir, "entities", entityFilename(entity.id)),
          renderEntity(entity),
          "utf8",
        ),
      ),
    );

    const checkpoint = (await store.buildContextDocument("I call Mara Venn by name.")).sections.at(
      -1,
    )!;

    expect(checkpoint.content).toContain('[npc:mara-venn] "Mara Venn": ABSENT FROM CURRENT SCENE');
    expect(checkpoint.content).toContain("authoritative location=[location:watch-post]");
    expect(conservativeInputTokenEstimate(checkpoint.content)).toBeLessThanOrEqual(
      GAMEPLAY_CONTEXT_SECTION_BUDGETS.continuity,
    );
  });

  it("keeps core and newest active facts while excluding inactive history within a hard entity budget", () => {
    const entity = denseEntity();
    entity.facts.unshift({
      id: "fact:core-identity",
      section: "established",
      text: "CORE IDENTITY FACT",
      active: true,
    });
    entity.facts.unshift({
      id: "fact:timestamp-newest",
      section: "knowledge",
      text: "TIMESTAMP NEWEST CLUE",
      active: true,
      // A stamped post-migration fact is newer than every legacy fact even
      // when its turn number is smaller than their array positions.
      createdTurn: 1,
    });
    const rendered = renderContextEntities([entity], new Set([entity.id]), 2_000);

    expect(conservativeInputTokenEstimate(rendered)).toBeLessThanOrEqual(2_000);
    expect(rendered).toContain("CORE IDENTITY FACT");
    expect(rendered).toContain("LATEST RELEVANT CLUE");
    expect(rendered).toContain("TIMESTAMP NEWEST CLUE");
    expect(rendered).not.toContain("INACTIVE PRIVATE HISTORY MUST STAY COLD");
    expect(rendered).toMatch(/\d+ additional active facts omitted/);
    expect(rendered).not.toContain("fact:memory-0500");
  });

  it("protects a setup-era DM-only constraint from newer accumulated knowledge", () => {
    const entity = denseEntity();
    entity.facts.unshift({
      id: "fact:setup-constraint",
      section: "secrets",
      text: "SETUP ERA HIDDEN CHRONOLOGY",
      active: true,
      createdTurn: 0,
    });
    // Knowledge accumulates every turn and would otherwise win a newest-first
    // sweep. Hidden truth is written once and constrains every later turn.
    for (let turn = 1; turn <= 60; turn += 1) {
      entity.facts.push({
        id: `fact:later-knowledge-${turn}`,
        section: "knowledge",
        text: `LATER KNOWLEDGE ${turn} recorded while investigating the disappearance in detail.`,
        active: true,
        createdTurn: turn,
      });
    }

    const rendered = renderContextEntities([entity], new Set([entity.id]), 2_000);

    expect(conservativeInputTokenEstimate(rendered)).toBeLessThanOrEqual(2_000);
    expect(rendered).toContain("SETUP ERA HIDDEN CHRONOLOGY");
  });

  it("reactivates an exact cold entity reference without fuzzy substring matching", async () => {
    const store = await createTestStore();
    await store.commitTurn({
      action: "An archivist is established elsewhere.",
      resolved: {
        narration: "Archivist Nera remains in the distant records hall.",
        turnSummary: "Archivist Nera was established.",
        operations: [
          {
            type: "create_entity",
            entity: {
              id: "npc:archivist-nera",
              kind: "person",
              name: "Archivist Nera",
              status: "working",
              tags: ["archivist"],
              description: "A keeper of sealed municipal records.",
              establishedFacts: ["Nera knows the old registry."],
              secrets: [],
              playerKnowledge: [],
            },
          },
        ],
      },
      provider: "fake",
      model: "fake-model",
    });
    for (let turn = 0; turn < 9; turn += 1) {
      await store.commitTurn({
        action: `I wait ${turn}.`,
        resolved: { narration: "Time passes.", turnSummary: "Time passed.", operations: [] },
        provider: "fake",
        model: "fake-model",
      });
    }
    const plain = await store.buildContextDocument();
    const fuzzy = await store.buildContextDocument("I consider a long archivist narration.");
    const idPrefix = await store.buildContextDocument(
      "I inspect the unrelated id npc:archivist-nera-copy.",
    );
    const exact = await store.buildContextDocument("I seek Archivist Nera by name.");
    const uniqueShortName = await store.buildContextDocument("I ask Nera for the registry.");
    const plainObservation = await store.buildContextObservation();
    const exactObservation = await store.buildContextObservation("I ask Nera for the registry.");

    expect(plain.text).not.toContain("ENTITY [npc:archivist-nera]");
    expect(fuzzy.text).not.toContain("ENTITY [npc:archivist-nera]");
    expect(idPrefix.text).not.toContain("ENTITY [npc:archivist-nera]");
    expect(exact.text).toContain("ENTITY [npc:archivist-nera]");
    expect(exact.text).toContain("Nera knows the old registry.");
    expect(uniqueShortName.text).toContain("ENTITY [npc:archivist-nera]");
    expect(plainObservation.durableEntityIds).not.toContain("npc:archivist-nera");
    expect(exactObservation.durableEntityIds).toContain("npc:archivist-nera");
  });

  it("does not reactivate an ambiguous natural-name alias", async () => {
    const store = await createTestStore();
    const loaded = await store.load();
    const recordsHall: Entity = {
      id: "location:records-hall",
      kind: "location",
      name: "Records Hall",
      status: "quiet",
      tags: [],
      updatedTurn: 0,
      description: "A distant archive.",
      traits: [],
      conditions: [],
      inventory: [],
      facts: [],
      relationships: [],
    };
    const first: Entity = {
      id: "npc:nera-vale",
      kind: "person",
      name: "Nera Vale",
      status: "working",
      location: recordsHall.id,
      tags: ["clerk"],
      updatedTurn: 0,
      description: "A municipal clerk.",
      traits: [],
      conditions: [],
      inventory: [],
      facts: [],
      relationships: [],
    };
    const second: Entity = {
      ...first,
      id: "npc:nera-cole",
      name: "Nera Cole",
      description: "A shipping clerk.",
    };
    await Promise.all(
      [recordsHall, first, second].map((entity) =>
        writeFile(
          path.join(store.currentDir, "entities", entityFilename(entity.id)),
          renderEntity(entity),
          "utf8",
        ),
      ),
    );

    const ambiguous = await store.buildContextDocument("I ask Nera for help.");
    const exact = await store.buildContextDocument("I ask Nera Vale for help.");

    expect(ambiguous.text).not.toContain("ENTITY [npc:nera-vale]");
    expect(ambiguous.text).not.toContain("ENTITY [npc:nera-cole]");
    expect(exact.text).toContain("ENTITY [npc:nera-vale]");
    expect(exact.text).not.toContain("ENTITY [npc:nera-cole]");
  });

  it("keeps gameplay, appeal, player, and completed-story projections bounded at turn 1000", async () => {
    const store = await createTestStore();
    const loaded = await store.load();
    const player = loaded.entities.get(loaded.manifest.playerId)!;
    player.facts.push(...denseEntity().facts);
    player.updatedTurn = 1_000;
    await writeFile(
      path.join(store.currentDir, "entities", entityFilename(player.id)),
      renderEntity(player),
      "utf8",
    );

    for (let start = 1; start <= 1_000; start += 100) {
      await Promise.all(
        Array.from({ length: Math.min(100, 1_001 - start) }, (_, index) => start + index).map(
          (turn) =>
            writeFile(
              path.join(store.currentDir, "turns", `${String(turn).padStart(6, "0")}.md`),
              syntheticTurn(turn),
              "utf8",
            ),
        ),
      );
    }
    const manifestPath = path.join(store.currentDir, "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
    manifest.turn = 1_000;
    manifest.updatedAt = new Date().toISOString();
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

    const gameplay = await store.buildContextDocument();
    const appeal = await store.buildAppealContextDocument();
    const playerContext = await store.buildPlayerContext();
    const story = await store.buildCompletedStoryContextDocument();

    expect(conservativeInputTokenEstimate(gameplay.text)).toBeLessThanOrEqual(
      GAMEPLAY_CONTEXT_TOKEN_TARGET,
    );
    expect(conservativeInputTokenEstimate(appeal.text)).toBeLessThanOrEqual(
      APPEAL_CONTEXT_TOKEN_TARGET,
    );
    expect(conservativeInputTokenEstimate(playerContext)).toBeLessThanOrEqual(
      PLAYER_CONTEXT_TOKEN_TARGET,
    );
    expect(conservativeInputTokenEstimate(story.text)).toBeLessThanOrEqual(
      COMPLETED_STORY_CONTEXT_TOKEN_TARGET,
    );
    expect(gameplay.text).toContain("LATEST RELEVANT CLUE");
    expect(gameplay.text).not.toContain("INACTIVE PRIVATE HISTORY MUST STAY COLD");
    expect(story.text).toContain("Synthetic summary 1000");
    expect(story.text).toContain("turn records omitted");
  });

  it("derives Known Details from player-visible facts on their real subjects", async () => {
    const store = await createTestStore();
    await store.commitTurn({
      action: "I learn Mara's durable clue.",
      resolved: {
        narration: "Mara reveals that the north gate closes at midnight.",
        turnSummary: "The north gate closing time was learned.",
        operations: [
          {
            type: "add_fact",
            targetId: "npc:mara-venn",
            section: "knowledge",
            factId: "fact:gate-time",
            text: "The north gate closes at midnight.",
          },
        ],
      },
      provider: "fake",
      model: "fake-model",
    });

    const loaded = await store.load();
    expect(loaded.entities.get("player:hero")?.facts).not.toContainEqual(
      expect.objectContaining({ text: "The north gate closes at midnight." }),
    );
    const learned = loaded.entities
      .get("npc:mara-venn")
      ?.facts.find((fact) => fact.text === "The north gate closes at midnight.");
    expect(learned).toMatchObject({ active: true, createdTurn: 1 });
    const inspection = await store.inspect("character");
    expect(inspection.view).toBe("character");
    if (inspection.view !== "character") throw new Error("Expected character inspection");
    expect(inspection.facts.knowledge).toContain("Mara Venn: The north gate closes at midnight.");

    await store.commitTurn({
      action: "I learn the corrected gate time.",
      resolved: {
        narration: "Mara corrects the closing time to eleven.",
        turnSummary: "The north gate closing time was corrected.",
        operations: [
          {
            type: "supersede_fact",
            targetId: "npc:mara-venn",
            factId: learned!.id,
            replacementFactId: "fact:corrected-gate-time",
            replacementText: "The north gate closes at eleven.",
          },
        ],
      },
      provider: "fake",
      model: "fake-model",
    });
    const corrected = await store.load();
    const maraFacts = corrected.entities.get("npc:mara-venn")!.facts;
    expect(maraFacts.find((fact) => fact.id === learned!.id)).toMatchObject({
      active: false,
      createdTurn: 1,
      supersededTurn: 2,
    });
    expect(
      maraFacts.find((fact) => fact.text === "The north gate closes at eleven."),
    ).toMatchObject({ active: true, createdTurn: 2 });
  });

  it("resumes and commits beyond turn 10,000 while the working projection stays flat", async () => {
    const store = await createTestStore();
    await store.updateCampaignBudget({ campaignUsd: 1, logicalTurnUsd: 0.2 });
    for (let start = 1; start <= 10_000; start += 250) {
      await Promise.all(
        Array.from({ length: Math.min(250, 10_001 - start) }, (_, index) => start + index).map(
          (turn) =>
            writeFile(
              path.join(store.currentDir, "turns", `${String(turn).padStart(6, "0")}.md`),
              syntheticTurn(turn),
              "utf8",
            ),
        ),
      );
    }
    const manifestPath = path.join(store.currentDir, "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
    manifest.turn = 10_000;
    manifest.updatedAt = new Date().toISOString();
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

    const before = await store.buildContextDocument("I continue the current investigation.");
    expect(conservativeInputTokenEstimate(before.text)).toBeLessThanOrEqual(
      GAMEPLAY_CONTEXT_TOKEN_TARGET,
    );
    expect(before.text).toContain("Synthetic summary 10000");

    await store.setPendingRequest({
      kind: "action",
      action: "I continue the current investigation.",
      operationId: "00000000-0000-4000-8000-000000010000",
      phase: "requested",
    });
    const provider = new LongRunProvider();
    const result = await new DungeonEngine(store, provider).resumePendingTurn();

    expect(result.turn).toBe(10_001);
    expect(provider.calls).toBe(1);
    expect(await store.getPending()).toBeUndefined();
    expect(await store.campaignBudget()).toMatchObject({
      spentUsd: 0.001,
      reservedUsd: 0,
      settledAttempts: 1,
    });
    expect(conservativeInputTokenEstimate(await store.buildContext())).toBeLessThanOrEqual(
      GAMEPLAY_CONTEXT_TOKEN_TARGET,
    );
  }, 30_000);

  it("rejects overlong new durable writes and oversized immutable seeds while reading legacy text", async () => {
    const store = await createTestStore();
    const loaded = await store.load();
    const player = loaded.entities.get(loaded.manifest.playerId)!;
    player.facts.push({
      id: "fact:legacy-long",
      section: "knowledge",
      text: "l".repeat(2_000),
      active: true,
    });
    await writeFile(
      path.join(store.currentDir, "entities", entityFilename(player.id)),
      renderEntity(player),
      "utf8",
    );
    await expect(store.load()).resolves.toBeDefined();
    expect(
      (await store.load()).entities
        .get("player:hero")
        ?.facts.find((fact) => fact.id === "fact:legacy-long")?.createdTurn,
    ).toBeUndefined();
    expect(conservativeInputTokenEstimate(await store.buildContext())).toBeLessThanOrEqual(
      GAMEPLAY_CONTEXT_TOKEN_TARGET,
    );

    await expect(
      store.commitTurn({
        action: "I record an excessive note.",
        resolved: {
          narration: "The attempted note is excessive.",
          turnSummary: "The excessive note was rejected.",
          operations: [
            {
              type: "add_fact",
              targetId: "player:hero",
              section: "knowledge",
              factId: "fact:too-long",
              text: "x".repeat(801),
            },
          ],
        },
        provider: "fake",
        model: "fake-model",
      }),
    ).rejects.toThrow(/800-character durable-state limit/);
    expect((await store.load()).manifest.turn).toBe(0);

    await expect(
      store.commitTurn({
        action: "I end the campaign with an excessive chronicle reason.",
        resolved: {
          narration: "The attempted ending reason is excessive.",
          turnSummary: "The excessive ending was rejected.",
          operations: [
            {
              type: "end_campaign",
              status: "ended",
              reason: "r".repeat(1_201),
            },
          ],
        },
        provider: "fake",
        model: "fake-model",
      }),
    ).rejects.toThrow(/Campaign ending reason exceeds the 1200-character durable-state limit/);
    expect((await store.load()).manifest).toMatchObject({ turn: 0, status: "active" });
    expect(() =>
      assertNewCampaignOriginInputFits({
        worldRules: "w".repeat(5_001),
        premise: "Short premise",
        character: "Short character",
      }),
    ).toThrow(/World and DM style requires/);
    expect(() =>
      assertNewCampaignOriginInputFits({
        worldRules: "Short world",
        premise: "p".repeat(3_000),
        character: "c".repeat(5_500),
      }),
    ).toThrow(/Combined premise and character concept requires/);
    expect(() =>
      assertNewCampaignImmutableContextFits({
        worldRules: "w".repeat(4_000),
        scenario: "s".repeat(2_000),
        premise: "Short premise",
        character: "Short character",
      }),
    ).toThrow(/Combined world rules and generated scenario requires/);
  });
});
