import type { SetupResult } from "../schemas.js";
import type { LanguageCode } from "../language.js";

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

const RUSSIAN_CONNECTION_SETUP_PROBE: SetupResult = {
  ...CONNECTION_SETUP_PROBE,
  campaignTitle: "Проверка схемы",
  scenarioMarkdown: "Проверка схемы выполнена.",
  openingNarration: "Вы стоите в тихой комнате и готовы действовать.",
  timeLabel: "Полдень",
  player: {
    ...CONNECTION_SETUP_PROBE.player,
    name: "Герой проверки",
    description: "Тестовый искатель приключений.",
  },
  entities: CONNECTION_SETUP_PROBE.entities.map((entity) => ({
    ...entity,
    name: "Комната проверки",
    description: "Тестовая локация.",
  })),
};

export interface LanguageConnectionProbe {
  setup: SetupResult;
  gameplayMarker: string;
}

const LANGUAGE_CONNECTION_PROBES: Record<LanguageCode, LanguageConnectionProbe> = {
  en: {
    setup: CONNECTION_SETUP_PROBE,
    gameplayMarker: "Schema enforcement verified.",
  },
  ru: {
    setup: RUSSIAN_CONNECTION_SETUP_PROBE,
    gameplayMarker: "Проверка схемы выполнена.",
  },
};

export function connectionProbeForLanguage(language: LanguageCode): LanguageConnectionProbe {
  return LANGUAGE_CONNECTION_PROBES[language];
}

export function connectionSetupPrompt(setup: unknown): string {
  return `Return exactly this campaign setup object: ${JSON.stringify(setup)}`;
}

export const CONNECTION_GAMEPLAY_PROMPT = "Return decision=resolved, narration and summary set to \"Schema enforcement verified.\", effects=[], modifiers=[], every other string empty, difficulty=0, and failureCampaignStatus=none. Include every schema field exactly once and never use null.";

export function connectionGameplayPrompt(marker: string): string {
  return `Return decision=resolved, narration and summary set to ${JSON.stringify(marker)}, effects=[], modifiers=[], every other string empty, difficulty=0, and failureCampaignStatus=none. Include every schema field exactly once and never use null.`;
}
