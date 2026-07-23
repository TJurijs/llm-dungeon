import { campaignSetupDefaults, DEFAULT_LANGUAGE, languageInstruction, type LanguageCode } from "../language.js";
import { renderPrompt, section, type PromptDocument } from "./render.js";

export interface SetupPromptInput {
  worldRules: string;
  premise: string;
  character: string;
  language?: LanguageCode;
}

export function setupPromptDocument(input: SetupPromptInput): PromptDocument {
  const language = input.language ?? DEFAULT_LANGUAGE;
  const defaults = campaignSetupDefaults(language);
  return renderPrompt([
    section("setup-task", undefined, "Create the initial persistent state for a single-player, text-based roleplaying sandbox campaign. Its genre and setting are defined entirely by the world configuration and seeds below."),
    section(
      "world-configuration",
      "WORLD AND STYLE CONFIGURATION — CREATIVE GUIDANCE",
      `${input.worldRules}\n\nTreat this configuration together with the campaign seeds as the authoritative creative brief. They define the campaign's genre, era, technology level, setting, tone, pacing, content boundaries, and fiction, and may set any of these freely — there is no default or assumed medieval-fantasy setting, and you must not import genre conventions the brief does not call for. Honor the brief over any generic convention. This authority governs fiction only: it never alters the enforced output schema, durable-state authority, dice, outcome calculation, or other application-owned mechanics.`,
    ),
    section("setup-seeds", "CAMPAIGN SEEDS", `PREMISE: ${input.premise.trim() || defaults.premise}\nCHARACTER: ${input.character.trim() || defaults.characterConcept}`),
    section("output-language", "OUTPUT LANGUAGE", languageInstruction(language)),
    section(
      "setup-requirements",
      "SETUP REQUIREMENTS",
      `- Preserve supplied concepts faithfully; organize them rather than replacing them.
- Use player:hero for the player ID.
- Include the starting location and make player.location reference that location entity.
- Every entity location and inventory reference must resolve to a type-compatible included entity.
- An entity's location means physical containment by a different included location. Never set it to the entity's own ID; omit it for a top-level location; location-parent chains must be acyclic.
- Omit unknown optional references rather than using empty or placeholder IDs.
- Carried items belong in inventory and do not use an owner as their world location.
- Inventory is the ownership authority. Do not state in descriptions, facts, secrets, or opening narration that an entity carries or owns an item unless that item and quantity appear in its inventory.
- Secrecy changes who knows about an object, not whether the object mechanically exists. A hidden carried object still requires an item entity and inventory entry; store the hidden meaning or purpose as a secret instead of encoding possession only in prose.
- Before returning, audit every possession claim across the character, entities, facts, secrets, and opening narration against the inventory lists. Add each actually carried unique object as an item with quantity, or remove the unsupported claim.
- Keep entity descriptions stable: describe enduring appearance or nature, never current placement, ownership, activity, mood, or temporary condition. Put mutable state in location, inventory, status, conditions, or facts.
- Unless the configuration or seeds replace currency, require destitution, or imply a setting without money, include a small spendable currency inventory item.
- Unless the configuration or seeds clearly call for a different opening cast, include roughly two to four immediately relevant NPCs and no more than two active threads; when they do, follow the brief within the schema limits.
- Give supplied entities unique safe namespaced IDs. Omit initial thread IDs so the application can assign them.
- Keep hidden motives in secrets rather than player knowledge.
- scenarioMarkdown is the durable campaign premise, not opening narration.
- End the opening with an actionable situation, without deciding the player's response or presenting an action menu.`,
    ),
  ]);
}

export function setupPrompt(input: SetupPromptInput): string {
  return setupPromptDocument(input).text;
}
