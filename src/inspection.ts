import type { LanguageCode } from "./language.js";
import type { Entity, GameState, Thread } from "./schemas.js";
import type {
  CampaignStateSnapshot,
  CharacterInspection,
  InspectionFacts,
  InspectionInventoryItem,
  LocationInspection,
  PlayerStateInspection,
  StateView,
  ThreadsInspection,
} from "./types.js";

const PLAYER_VISIBLE_FACT_SECTIONS = new Set(["established", "knowledge", "history"]);

export function campaignStateRevision(manifest: Pick<GameState, "turn" | "updatedAt">): string {
  return `${manifest.turn}:${manifest.updatedAt}`;
}

function playerVisibleFacts(entity: Entity): InspectionFacts {
  const established: string[] = [];
  const knowledge: string[] = [];
  const history: string[] = [];
  for (const fact of entity.facts) {
    if (!PLAYER_VISIBLE_FACT_SECTIONS.has(fact.section)) continue;
    if (!fact.active) {
      history.push(fact.text);
    } else if (fact.section === "established") {
      established.push(fact.text);
    } else if (fact.section === "knowledge") {
      knowledge.push(fact.text);
    } else {
      history.push(fact.text);
    }
  }
  return { established, knowledge, history };
}

function subjectOwnedPlayerKnowledge(
  player: Entity,
  entities: Map<string, Entity>,
): Pick<InspectionFacts, "knowledge" | "history"> {
  const knowledge: string[] = [];
  const history: string[] = [];
  for (const entity of [...entities.values()].sort((left, right) =>
    left.id.localeCompare(right.id),
  )) {
    for (const fact of entity.facts) {
      if (fact.section !== "knowledge") continue;
      const text = entity.id === player.id ? fact.text : `${entity.name}: ${fact.text}`;
      (fact.active ? knowledge : history).push(text);
    }
  }
  return { knowledge, history };
}

function inventoryItems(owner: Entity, entities: Map<string, Entity>): InspectionInventoryItem[] {
  return owner.inventory.map((entry) => {
    const item = entities.get(entry.entityId);
    if (!item || item.kind !== "item") {
      throw new Error(`Inspection inventory contains an invalid item reference on ${owner.name}`);
    }
    return {
      name: item.name,
      quantity: entry.quantity,
      status: item.status,
      description: item.description,
    };
  });
}

export function projectPlayerInspection(
  view: "character",
  language: LanguageCode,
  manifest: GameState,
  entities: Map<string, Entity>,
  threads: Thread[],
): CharacterInspection;
export function projectPlayerInspection(
  view: "location",
  language: LanguageCode,
  manifest: GameState,
  entities: Map<string, Entity>,
  threads: Thread[],
): LocationInspection;
export function projectPlayerInspection(
  view: "threads",
  language: LanguageCode,
  manifest: GameState,
  entities: Map<string, Entity>,
  threads: Thread[],
): ThreadsInspection;
export function projectPlayerInspection(
  view: StateView,
  language: LanguageCode,
  manifest: GameState,
  entities: Map<string, Entity>,
  threads: Thread[],
): PlayerStateInspection;
export function projectPlayerInspection(
  view: StateView,
  language: LanguageCode,
  manifest: GameState,
  entities: Map<string, Entity>,
  threads: Thread[],
): PlayerStateInspection {
  const player = entities.get(manifest.playerId);
  if (!player) throw new Error("Player entity is missing");

  if (view === "character") {
    const ownFacts = playerVisibleFacts(player);
    const knownBySubject = subjectOwnedPlayerKnowledge(player, entities);
    return {
      view,
      language,
      name: player.name,
      description: player.description,
      status: player.status,
      traits: [...player.traits],
      conditions: [...player.conditions],
      inventory: inventoryItems(player, entities),
      facts: {
        established: ownFacts.established,
        knowledge: knownBySubject.knowledge,
        history: [
          ...ownFacts.history.filter(
            (text) =>
              !player.facts.some(
                (fact) => fact.section === "knowledge" && !fact.active && fact.text === text,
              ),
          ),
          ...knownBySubject.history,
        ],
      },
      relationships: player.relationships.map((relationship) => {
        const target = entities.get(relationship.targetId);
        if (!target)
          throw new Error(`Inspection relationship on ${player.name} has an invalid target`);
        return { name: target.name, summary: relationship.summary };
      }),
    };
  }

  if (view === "location") {
    const location = entities.get(manifest.currentLocationId);
    if (!location || location.kind !== "location") throw new Error("Current location is missing");
    return {
      view,
      language,
      name: location.name,
      description: location.description,
      status: location.status,
      features: [...location.traits],
      conditions: [...location.conditions],
      facts: playerVisibleFacts(location),
    };
  }

  return {
    view,
    language,
    threads: threads.map(({ title, summary, status }) => ({ title, summary, status })),
  };
}

export function projectCampaignStateSnapshot(
  manifest: GameState,
  entities: Map<string, Entity>,
  threads: Thread[],
): CampaignStateSnapshot {
  return {
    revision: campaignStateRevision(manifest),
    character: projectPlayerInspection("character", manifest.language, manifest, entities, threads),
    location: projectPlayerInspection("location", manifest.language, manifest, entities, threads),
    threads: projectPlayerInspection("threads", manifest.language, manifest, entities, threads),
  };
}
