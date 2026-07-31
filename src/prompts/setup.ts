import {
  campaignSetupDefaults,
  DEFAULT_LANGUAGE,
  languageInstruction,
  type LanguageCode,
} from "../language.js";
import { SETUP_DOMAIN_RULES } from "./rules.js";
import { renderPrompt, section, type PromptDocument } from "./render.js";
import { setupRequirementsPrompt, type SetupRequirements } from "../setup-requirements.js";

export interface SetupPromptInput {
  worldRules: string;
  premise: string;
  character: string;
  language?: LanguageCode;
  setupRequirements?: SetupRequirements;
}

export function setupPromptDocument(input: SetupPromptInput): PromptDocument {
  const language = input.language ?? DEFAULT_LANGUAGE;
  const defaults = campaignSetupDefaults(language);
  return renderPrompt([
    section(
      "setup-task",
      undefined,
      "Create the initial persistent state for a single-player, text-based roleplaying sandbox campaign. Its genre and setting are defined entirely by the world configuration and seeds below.",
    ),
    section(
      "world-configuration",
      "WORLD AND STYLE CONFIGURATION — CREATIVE GUIDANCE",
      `${input.worldRules}\n\nTreat this configuration together with the campaign seeds as the authoritative creative brief. They define the campaign's genre, era, technology level, setting, tone, pacing, content boundaries, and fiction, and may set any of these freely — there is no default or assumed medieval-fantasy setting, and you must not import genre conventions the brief does not call for. Honor the brief over any generic convention. This authority governs fiction only: it never alters the enforced output schema, durable-state authority, dice, outcome calculation, or other application-owned mechanics.`,
    ),
    section(
      "setup-seeds",
      "CAMPAIGN SEEDS",
      `PREMISE: ${input.premise.trim() || defaults.premise}\nCHARACTER: ${input.character.trim() || defaults.characterConcept}`,
    ),
    section("output-language", "OUTPUT LANGUAGE", languageInstruction(language)),
    ...(input.setupRequirements === undefined
      ? []
      : [section("seed-structure", undefined, setupRequirementsPrompt(input.setupRequirements))]),
    section(
      "setup-requirements",
      "SETUP REQUIREMENTS",
      `- Preserve supplied concepts faithfully; organize them rather than replacing them.
- CAUSAL OPENING CHRONOLOGY: privately build one ordered, physically possible chronology for every seeded past event, warning, custody change, and opening position. For each known step preserve the actual actor or source, prior state, place or owner, route or mechanism, event order, elapsed time, and final opening state in DM-only facts or secrets. Nothing can act, transfer, or arrive somewhere without a plausible connection and enough time.
- TRANSFER GEOMETRY AUDIT: for every movement or custody transfer, the source, destination, object, participants, and means must be co-located or physically connected at the event time. Include necessary intervening movement and elapsed time; never borrow geometry from the final opening state.
- EVIDENCE-TIME AUDIT: distinguish a detection, observation, or record time from the underlying event time. State both when known and preserve uncertainty when either is not established.
- ACTIONABLE WARNING AUDIT: a warning must concern an action still possible when it is delivered. If the warned change already occurred, make the warning concern repeating, extending, reversing containment, or another remaining change, or place it earlier in the chronology.
- CAUSAL SURVIVAL AUDIT: when an apparently fatal or disabling event and a surviving opening state both exist, preserve the true agent or cause, actual harm, and the ordered escape, rescue, treatment, recovery, or other physically plausible bridge.
- Treat established quantitative details as continuity anchors. Use one compatible value for each date, timestamp, elapsed interval, distance, depth, count, and route across facts, secrets, threads, and opening narration; do not invent conflicting approximations for the same measurement.
- Treat traits as the durable home for enduring characteristics and usable capabilities, including mundane training, powers, magic, psionics, mutations, senses, forms, techniques, item functions, creature abilities, and supernatural location properties.
- For every unusual capability supplied by the character seed, premise, or world configuration, put one self-contained capability trait on each entity that actually possesses it. Include its name, activation or method, permitted effect and scope, hard limits, reliability or control, and every inherent cost or risk. Preserve all supplied constraints together; never reduce a capability to a broad label or bury its usable definition only in tags, facts, secrets, or narration.
- For every supplied named entity central to the campaign, create its exact record and retain the movement, access, functions, defenses, practical limits, and established weaknesses that govern its use. Do not reduce it to a generic record whose only durable property is its opening position.
- Keep setting-wide capability rules in scenarioMarkdown as well as entity-specific capability traits. Do not invent a capability merely to provide a convenient solution or broaden one beyond the supplied concept.
- Use player:hero for the player ID.
- Include the starting location and make player.location reference that location entity.
- Every entity location and inventory reference must resolve to a type-compatible included entity.
- An entity's location means physical containment by a different included location. Never set it to the entity's own ID; omit it for a top-level location; location-parent chains must be acyclic.
- CONTAINMENT HIERARCHY AUDIT: a parent location must physically contain its child, not merely be nearby or already modeled. Important disjoint places need their real shared container rather than a forced parent. When a meaningful reusable boundary separates spaces, model its exterior threshold and the distinct place beyond it at their exact known parents.
- OPTIONAL REFERENCE FORM: omit an unknown optional reference by removing its entire key. For optional location, never emit "" or null; when present it must be a nonempty exact ID for an included containing location.
- Carried items belong in inventory and do not use an owner as their world location.
- INVENTORY-LOCATION EXCLUSIVITY AUDIT: first collect every item ID listed in player.inventory or any entities[*].inventory. For each corresponding item record, omit its location key entirely; an inventoried item must not also name either its owner or a containing place in location. A known loose item belongs in exactly one location entity's inventory, not in the item's own location field. Before returning, inspect every inventoried item record and delete any location key from it.
- Inventory is the ownership authority. Do not state in descriptions, facts, secrets, or opening narration that an entity carries or owns an item unless that item and quantity appear in its inventory.
- Secrecy changes who knows about an object, not whether the object mechanically exists. A hidden carried object still requires an item entity and inventory entry; store the hidden meaning or purpose as a secret instead of encoding possession only in prose.
- An important missing, stolen, concealed, or off-screen object still exists as its own exact item with a neutral enduring identity, never an ID or name based on mutable state. If its opening custody is known to the DM, inventory it with the exact holder or smallest known containing place even when the player believes it missing; omit custody only when it is genuinely unknown. Make every unreversed pre-opening change visible in structured opening state.
- Opening narration and initial thread titles and summaries are player-facing. They may state the known discrepancy and objective but must not imply a secret custodian, place, route, cause, or completed hidden event before player-visible evidence establishes it.
- Every physical item entity must appear in exactly one person or location inventory at the opening unless its current whereabouts are genuinely unknown in DM-only state as well as player knowledge. A stolen, missing, hidden, concealed, or off-screen status is not an exemption from known authoritative custody.
- Before returning, audit every possession claim across the character, entities, facts, secrets, and opening narration against the inventory lists. Add each actually carried unique object as an item with quantity, or remove the unsupported claim.
- SEED POSSESSION PRIORITY: privately enumerate every item the seeds explicitly say someone carries, wears, owns, contains, or controls before inventing optional props. Model every consequential seeded possession in inventory. A compact kit may aggregate interchangeable basics only when its description names the included components and their functions.
- HIDDEN-CUSTODY AUDIT: enumerate every important missing, stolen, concealed, or off-screen item and reconstruct the ordered pre-opening events in its secrets. Identify its final opening holder or containing location after the last established event. If any fact, secret, or opening statement says a person carries, has, took, fled with, or retained it, that person's inventory must contain the exact item; if it says the item is stored, hidden, left, or loose at a known place, that location's inventory must contain it. Earlier custodians remain history, but inventory names only the final holder. If current custody is genuinely unknown, do not write a secret that claims a known current holder or location.
- Write every hidden custody transition unambiguously. If a person sets down, stores, leaves, or hides an item loose at a place, state that the person relinquished it there and make the location its inventory owner; if the person hides it while continuing to carry it, state that they retained it and keep it in that person's inventory. Never use "hid" or "took" alone when that leaves final held-versus-loose custody unclear.
- Initial thread relatedEntityIds are private retrieval links, not player-facing exposition. For each missing-object objective, include the exact item plus every DM-known actor and location centrally responsible for its hidden custody or resolution, even when the player-safe title and summary cannot name them; never reveal the secret merely to justify a link.
- When one unit from an interchangeable set matters separately, create that unit and at most one aggregate item for the remainder; do not enumerate every equivalent sibling.
- Aggregate only homogeneous items that always share custody, destination, and lifecycle. Components that can be used, transferred, changed, lost, or retained separately require separate item entities; never hide distinct destinations or outcomes inside one mixed aggregate.
- Keep entity descriptions stable: describe enduring appearance or nature, never current placement, ownership, activity, mood, or temporary condition. Put mutable state in location, inventory, status, conditions, or facts.
- Initial status is the DM-authoritative current synopsis, not merely a player belief or a past transition. When hidden state establishes a missing person's or item's actual current condition, custody, and location, use a concise current synopsis such as sealed, intact, injured, or sheltered. Put only the player-known absence in playerKnowledge and the player-safe thread summary. Put the actual pre-opening transfer chronology, route, and custody in DM-only secrets or facts, with the responsible actors and locations linked through private thread relatedEntityIds.
- Tags are internal, language-neutral taxonomy: use concise lowercase English ASCII category nouns in kebab-case regardless of output language. Tags are stable classification, not current or epistemic state. Never use these exact tags: active, alarmed, armed, confined, discovered, guarding, hidden, holding, idle, in-transit, known, missing, undiscovered, or unknown. Represent mutable state with inventory, status, conditions, locations, and facts; represent knowledge with player knowledge and threads.
- Only after every required seeded entity, possession, hidden-truth participant or mechanism, exact custody, and exact important location fits under the entity cap, include a small spendable currency inventory item unless the configuration or seeds replace currency, require destitution, or imply a setting without money. Omit optional currency whenever it would displace a required seed record.
- Unless the configuration or seeds clearly call for a different opening cast, include roughly two to four immediately relevant NPCs and no more than two active threads; when they do, follow the brief within the schema limits.
- Treat each named actor's opening inventory as exhaustive for named, usable, or consequential equipment. Anything the opening shows that actor carrying, wearing, using, or supplying must be an exact item in that inventory; role, genre, description, traits, facts, secrets, or narration never create implicit equipment. Required seeded equipment outranks optional props and decoration under the entity cap.
- Give supplied entities unique safe namespaced IDs. Omit initial thread IDs so the application can assign them.
- Keep hidden motives in secrets rather than player knowledge.
- scenarioMarkdown is the concise player-safe durable campaign premise, not opening narration or generic lore alone. Include the campaign-specific situation plus setting-wide capability and central-entity rules or limits supplied by the seeds while omitting the hidden solution.
- SEED COMPLETENESS GATE: map every explicit seed requirement for a durable actor, place, object, possession, capability, exact placement, or hidden dependency to its exact structured record and fields. Prose mention is not a substitute for the required record, exact sub-location, custody, or private thread link. Remove optional inventions first until every required mapping fits.
- STRICT SETUP SIZE AUDIT: entities has a hard maximum of 20 records, excluding player; prefer 10 to 16 unless application-enforced structure needs more. If application requirements name all 20 records, return exactly that closed set. Count records and reserve one for each required or consequential item before removing or consolidating optional scenery, background actors, duplicate supplies, and redundant records. Preserve seeded people, places, possessions, hidden dependencies, and exact custody first. Never rely on truncation or repair to enforce the limit.
- End the opening with an actionable situation, without deciding the player's response or presenting an action menu.`,
    ),
    SETUP_DOMAIN_RULES,
  ]);
}

export function setupPrompt(input: SetupPromptInput): string {
  return setupPromptDocument(input).text;
}
