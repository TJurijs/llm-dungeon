import { mkdtemp } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import type { SetupResult } from "../src/schemas.js";
import { StateStore } from "../src/store.js";

export const setupFixture: SetupResult = {
  campaignTitle: "The Crooked Crown",
  scenarioMarkdown: "The northern road has gone quiet, and rumors gather in the Crooked Crown tavern.",
  openingNarration: "Rain needles the tavern windows as a hooded traveler sets a sealed letter beside your cup.",
  timeLabel: "Day 1, 20:00",
  player: {
    id: "player:hero",
    kind: "person",
    name: "Arlen Vale",
    status: "alive",
    location: "location:crooked-crown",
    tags: ["adventurer"],
    description: "A road-worn scout with a careful eye.",
    establishedFacts: [],
    secrets: [],
    playerKnowledge: ["The northern road has become dangerous."],
    traits: ["Keen-eyed", "Patient"],
    conditions: [],
    inventory: [{ entityId: "item:travel-sword", quantity: 1 }],
  },
  entities: [
    {
      id: "location:crooked-crown",
      kind: "location",
      name: "The Crooked Crown",
      status: "open",
      tags: ["tavern"],
      description: "A low-beamed roadside tavern warmed by a broad hearth.",
      establishedFacts: ["The tavern stands beside the northern road."],
      secrets: [],
      playerKnowledge: [],
      traits: [],
      conditions: [],
      inventory: [],
    },
    {
      id: "npc:mara-venn",
      kind: "person",
      name: "Mara Venn",
      status: "alive",
      location: "location:crooked-crown",
      tags: ["innkeeper"],
      description: "The guarded innkeeper.",
      establishedFacts: ["Mara owns the Crooked Crown."],
      secrets: ["Mara suspects the watch captain takes bribes."],
      playerKnowledge: [],
      traits: [],
      conditions: [],
      inventory: [],
    },
    {
      id: "item:travel-sword",
      kind: "item",
      name: "Travel Sword",
      status: "intact",
      tags: ["weapon"],
      description: "A plain, serviceable sword.",
      establishedFacts: [],
      secrets: [],
      playerKnowledge: [],
      traits: [],
      conditions: [],
      inventory: [],
    },
  ],
  threads: [
    {
      id: "thread:northern-road",
      title: "Silence on the Northern Road",
      summary: "Travelers have stopped arriving from the north.",
      status: "active",
      relatedEntityIds: [],
    },
  ],
};

export async function createTestStore(): Promise<StateStore> {
  const directory = await mkdtemp(path.join(tmpdir(), "llm-dungeon-test-"));
  const store = new StateStore(path.join(directory, "data"));
  await store.createGame({ setup: setupFixture, worldRules: "Classic fantasy test rules." });
  return store;
}
