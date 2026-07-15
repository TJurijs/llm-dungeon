import type { LanguageCode } from "./language.js";
import type { Entity, GameState, Thread } from "./schemas.js";
import type {
  InspectionFacts,
  InspectionInventoryItem,
  PlayerStateInspection,
  StateView,
} from "./types.js";

const PLAYER_VISIBLE_FACT_SECTIONS = new Set(["established", "knowledge", "history"]);

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
  view: StateView,
  language: LanguageCode,
  manifest: GameState,
  entities: Map<string, Entity>,
  threads: Thread[],
): PlayerStateInspection {
  const player = entities.get(manifest.playerId);
  if (!player) throw new Error("Player entity is missing");

  if (view === "character") {
    return {
      view,
      language,
      name: player.name,
      description: player.description,
      status: player.status,
      traits: [...player.traits],
      conditions: [...player.conditions],
      inventory: inventoryItems(player, entities),
      facts: playerVisibleFacts(player),
      relationships: player.relationships.map((relationship) => {
        const target = entities.get(relationship.targetId);
        if (!target) throw new Error(`Inspection relationship on ${player.name} has an invalid target`);
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
