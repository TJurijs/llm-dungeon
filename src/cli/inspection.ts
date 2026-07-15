import { languageDefinition } from "../language.js";
import type { PlayerStateInspection } from "../types.js";

function section(title: string, lines: string[], empty: string): string {
  return `${title}\n${lines.length ? lines.map((line) => `  • ${line}`).join("\n") : `  ${empty}`}`;
}

export function inspectionTitle(inspection: PlayerStateInspection): string {
  const copy = languageDefinition(inspection.language).inspection;
  if (inspection.view === "character") return copy.character;
  if (inspection.view === "location") return copy.location;
  return copy.storyThreads;
}

export function renderInspection(inspection: PlayerStateInspection): string {
  const copy = languageDefinition(inspection.language).inspection;
  if (inspection.view === "character") {
    const inventory = inspection.inventory.map((item) =>
      `${item.quantity} × ${item.name} (${item.status})${item.description ? ` — ${item.description}` : ""}`);
    const relationships = inspection.relationships.map((relationship) =>
      `${relationship.name} — ${relationship.summary}`);
    return [
      inspection.name,
      inspection.description,
      `${copy.status}: ${inspection.status}`,
      section(copy.traits, inspection.traits, copy.none),
      section(copy.conditions, inspection.conditions, copy.none),
      section(copy.inventory, inventory, copy.emptyInventory),
      section(copy.establishedFacts, inspection.facts.established, copy.none),
      section(copy.knowledge, inspection.facts.knowledge, copy.none),
      section(copy.history, inspection.facts.history, copy.none),
      section(copy.relationships, relationships, copy.none),
    ].filter(Boolean).join("\n\n");
  }

  if (inspection.view === "location") {
    return [
      inspection.name,
      inspection.description,
      `${copy.status}: ${inspection.status}`,
      section(copy.features, inspection.features, copy.none),
      section(copy.conditions, inspection.conditions, copy.none),
      section(copy.establishedFacts, inspection.facts.established, copy.none),
      section(copy.knowledge, inspection.facts.knowledge, copy.none),
      section(copy.history, inspection.facts.history, copy.none),
    ].filter(Boolean).join("\n\n");
  }

  if (!inspection.threads.length) return copy.noThreads;
  return (["active", "resolved", "failed"] as const).map((status) => {
    const title = status === "active" ? copy.active : status === "resolved" ? copy.resolved : copy.failed;
    return section(
      title,
      inspection.threads
        .filter((thread) => thread.status === status)
        .map((thread) => `${thread.title} — ${thread.summary}`),
      copy.none,
    );
  }).join("\n\n");
}
