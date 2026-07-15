import type { SetupResult } from "../schemas.js";

export const CONNECTION_SYSTEM_PROMPT = "Return the requested structured response exactly. This is a provider compatibility test; do not add commentary.";

export const CONNECTION_SETUP_PROBE: SetupResult = {
  campaignTitle: "Schema Probe",
  scenarioMarkdown: "Schema enforcement verified.",
  openingNarration: "You stand in a quiet room, ready to act.",
  timeLabel: "Noon",
  player: {
    id: "player:hero",
    kind: "person",
    name: "Probe Hero",
    status: "active",
    location: "location:probe-room",
    tags: [],
    description: "A test adventurer.",
    establishedFacts: [],
    secrets: [],
    playerKnowledge: [],
    traits: [],
    conditions: [],
    inventory: [],
  },
  entities: [{
    id: "location:probe-room",
    kind: "location",
    name: "Probe Room",
    status: "active",
    tags: [],
    description: "A test location.",
    establishedFacts: [],
    secrets: [],
    playerKnowledge: [],
    traits: [],
    conditions: [],
    inventory: [],
  }],
  threads: [],
};

export function connectionSetupPrompt(setup: unknown): string {
  return `Return exactly this campaign setup object: ${JSON.stringify(setup)}`;
}

export const CONNECTION_GAMEPLAY_PROMPT = "Return decision=resolved, narration and summary set to \"Schema enforcement verified.\", effects=[], modifiers=[], every other string empty, difficulty=0, and failureCampaignStatus=none. Include every schema field exactly once and never use null.";
