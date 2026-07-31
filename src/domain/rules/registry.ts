/**
 * The deterministic domain rules, declared once.
 *
 * Every rule previously existed in up to four hand-maintained copies: the
 * check itself, the prose that asked the model to respect it, the redacted
 * string used for repair telemetry, and the playtest vocabulary that measured
 * it. Those copies drifted silently — a new check whose redaction branch was
 * forgotten degraded to an unclassified cause and disappeared from the repair
 * ranking. One declaration now produces all of them.
 *
 * `DomainViolationCode` is derived from this table, so the compiler rejects any
 * check that reports a code with no declaration.
 */

/** Where a rule is evaluated. Prompt fragments render into the same phases. */
export type RulePhase = "setup" | "adjudication" | "resolution" | "appeal";

/**
 * What happens when a rule matches.
 *
 * - `normalize`: the intended end state already holds or is unambiguous, so
 *   deterministic code rewrites the transaction and the turn proceeds.
 * - `reject`: the transaction contradicts authoritative state. Admission
 *   collects it for one bounded correction.
 * - `signal`: recorded for telemetry and review; never blocks a turn.
 */
export type RuleDisposition = "normalize" | "reject" | "signal";

export interface DomainRule {
  readonly disposition: RuleDisposition;
  readonly phases: readonly RulePhase[];
  /**
   * Telemetry form of the rule. It states the violated rule and nothing about
   * the campaign: no IDs, names, quantities, or generated prose.
   */
  readonly redacted: string;
  /** Optional generated prompt sentence; omit when prose adds nothing. */
  readonly prompt?: string;
}

const ALL_GAMEPLAY_PHASES = ["adjudication", "resolution", "appeal"] as const;

function rule<const T extends DomainRule>(value: T): T {
  return value;
}

export const DOMAIN_RULES = {
  // ---------------------------------------------------------------- references
  // Reference faults are the most common correction cause, so each kind keeps
  // its own code: "unknown location" and "unknown thread" call for different
  // structural fixes and must rank separately.
  unknown_entity_reference: rule({
    disposition: "reject",
    phases: ALL_GAMEPLAY_PHASES,
    redacted: "An effect referenced an entity that does not exist",
    prompt:
      "Square brackets mark ID boundaries in context and are not part of the ID. For every existing-state reference, copy only the characters inside one bracketed authoritative ID, emit them without brackets, and never shorten, reconstruct, or guess one from a display name.",
  }),
  // The one reference failure still reaching real runs, and the only rule with
  // measured repairs that said nothing to the model. It arises from the declared
  // end-of-turn scene: narration arrives somewhere new, the scene names that
  // place, and no such location exists for the derived movement to resolve.
  unknown_location_reference: rule({
    disposition: "reject",
    phases: ALL_GAMEPLAY_PHASES,
    redacted: "An effect referenced a location that does not exist",
    prompt:
      "A scene or movement may name only a location that already exists under its authoritative ID, or one this same turn creates with create_entity of kind location. When narration arrives somewhere not yet established, create that place in this effect list first; otherwise the destination cannot be resolved and the turn is returned.",
  }),
  unknown_item_reference: rule({
    disposition: "reject",
    phases: ALL_GAMEPLAY_PHASES,
    redacted: "An effect referenced an item that does not exist",
  }),
  unknown_thread_reference: rule({
    disposition: "reject",
    phases: ALL_GAMEPLAY_PHASES,
    redacted: "An effect referenced a thread that does not exist",
  }),
  unknown_fact_reference: rule({
    disposition: "reject",
    phases: ALL_GAMEPLAY_PHASES,
    redacted: "An effect referenced a fact that is not active on that entity",
  }),
  ambiguous_entity_reference: rule({
    disposition: "reject",
    phases: ALL_GAMEPLAY_PHASES,
    redacted: "An entity reference matched more than one authoritative record",
  }),
  ambiguous_location_reference: rule({
    disposition: "reject",
    phases: ALL_GAMEPLAY_PHASES,
    redacted: "A location reference matched more than one authoritative record",
  }),
  ambiguous_item_reference: rule({
    disposition: "reject",
    phases: ALL_GAMEPLAY_PHASES,
    redacted: "An item reference matched more than one authoritative record",
  }),
  ambiguous_thread_reference: rule({
    disposition: "reject",
    phases: ALL_GAMEPLAY_PHASES,
    redacted: "A thread reference matched more than one authoritative record",
  }),
  ambiguous_fact_reference: rule({
    disposition: "reject",
    phases: ALL_GAMEPLAY_PHASES,
    redacted: "A fact reference matched more than one active fact",
  }),
  unknown_entity: rule({
    disposition: "reject",
    phases: ALL_GAMEPLAY_PHASES,
    redacted: "An effect targeted an entity that does not exist",
  }),
  unknown_thread: rule({
    disposition: "reject",
    phases: ALL_GAMEPLAY_PHASES,
    redacted: "An effect targeted a thread that does not exist",
  }),
  unknown_active_fact: rule({
    disposition: "reject",
    phases: ALL_GAMEPLAY_PHASES,
    redacted: "A supersession targeted a fact that is not active on that entity",
  }),
  state_unknown_entity: rule({
    disposition: "reject",
    phases: ALL_GAMEPLAY_PHASES,
    redacted: "Committed state referenced an entity that does not exist",
  }),
  duplicate_create_hint: rule({
    disposition: "reject",
    phases: ALL_GAMEPLAY_PHASES,
    redacted: "Two created entities shared one same-turn reference hint",
  }),

  // ------------------------------------------------------------------- entities
  entity_already_exists: rule({
    disposition: "reject",
    phases: ALL_GAMEPLAY_PHASES,
    redacted: "A created entity reused an established durable ID",
  }),
  // Normalized: an effect naming no field asks for nothing, so it is dropped
  // from the ledger. Nothing about authoritative state is contradicted.
  set_entity_state_empty: rule({
    disposition: "normalize",
    phases: ALL_GAMEPLAY_PHASES,
    redacted: "An entity-state effect changed no field",
  }),
  not_a_location: rule({
    disposition: "reject",
    phases: ALL_GAMEPLAY_PHASES,
    redacted: "A movement destination was not a location entity",
  }),
  not_an_item: rule({
    disposition: "reject",
    phases: ALL_GAMEPLAY_PHASES,
    redacted: "An inventory effect targeted a record that is not an item",
  }),
  self_containment: rule({
    disposition: "reject",
    phases: ALL_GAMEPLAY_PHASES,
    redacted: "An entity was placed inside itself",
  }),
  non_location_parent: rule({
    disposition: "reject",
    phases: ALL_GAMEPLAY_PHASES,
    redacted: "An entity was contained by a record that is not a location",
  }),
  // Exact canonical duplicates are already coalesced deterministically. What
  // reaches here is an inexact near-duplicate, and resolving that would be the
  // fuzzy matching across established state the project forbids, so it is
  // observed instead of blocking.
  location_name_duplicate: rule({
    disposition: "signal",
    phases: ALL_GAMEPLAY_PHASES,
    redacted: "A created location duplicated an established location by canonical name",
    prompt:
      "Reuse the exact established location ID instead of recreating a known place under an alias.",
  }),
  location_hierarchy_cycle: rule({
    disposition: "reject",
    phases: ALL_GAMEPLAY_PHASES,
    redacted: "Location containment formed a cycle",
  }),
  // Normalized: the forbidden tag is pruned before admission. A tag is optional
  // machine taxonomy, so removing one yields exactly the intended record, and
  // pruning never clears an established tag list it did not ask to change.
  reserved_mutable_state_tag: rule({
    disposition: "normalize",
    phases: ["setup", ...ALL_GAMEPLAY_PHASES],
    redacted: "A new tag encoded mutable or epistemic state",
    prompt:
      "Tags are enduring language-neutral machine taxonomy in lowercase ASCII kebab-case, never translated and never mutable or epistemic state. Never introduce any of these exact tags: active, alarmed, armed, confined, discovered, guarding, hidden, holding, idle, in-transit, known, missing, undiscovered, unknown. Represent current situations with status, conditions, location, inventory, and facts, and what has or has not been learned with player knowledge, facts, and threads. An unchanged legacy tag may be retained or removed.",
  }),
  // Normalized: pruned with the reserved tags above rather than rewritten. A
  // canonicalized token would invent taxonomy the model never chose.
  non_machine_tag: rule({
    disposition: "normalize",
    phases: ["setup", ...ALL_GAMEPLAY_PHASES],
    redacted: "A new tag was not a lowercase ASCII kebab-case token",
  }),

  // -------------------------------------------------------------------- facts
  fact_id_conflict: rule({
    disposition: "reject",
    phases: ALL_GAMEPLAY_PHASES,
    redacted: "A generated fact ID collided with an existing fact",
  }),
  fact_id_duplicate: rule({
    disposition: "reject",
    phases: ALL_GAMEPLAY_PHASES,
    redacted: "Committed state contained duplicate fact IDs",
  }),
  fact_duplicate_replacement: rule({
    disposition: "reject",
    phases: ALL_GAMEPLAY_PHASES,
    redacted: "A replacement fact duplicated another active fact on the same entity",
  }),
  durable_text_limit: rule({
    disposition: "reject",
    phases: ["setup", ...ALL_GAMEPLAY_PHASES],
    redacted: "A generated durable record exceeded its new-write character limit",
  }),

  // ---------------------------------------------------------------- inventory
  inventory_negative: rule({
    disposition: "reject",
    phases: ALL_GAMEPLAY_PHASES,
    redacted: "An inventory quantity would become negative",
  }),
  inventory_duplicate_entry: rule({
    disposition: "reject",
    phases: ALL_GAMEPLAY_PHASES,
    redacted: "One owner held duplicate inventory entries for the same item",
  }),
  inventory_non_item: rule({
    disposition: "reject",
    phases: ALL_GAMEPLAY_PHASES,
    redacted: "A non-item record was placed in an inventory",
  }),
  inventory_self_containment: rule({
    disposition: "reject",
    phases: ALL_GAMEPLAY_PHASES,
    redacted: "An entity contained itself in inventory",
  }),
  inventory_cycle: rule({
    disposition: "reject",
    phases: ALL_GAMEPLAY_PHASES,
    redacted: "Inventory ownership formed a cycle",
  }),
  inventory_duplicate_ownership: rule({
    disposition: "reject",
    phases: ALL_GAMEPLAY_PHASES,
    redacted: "One item became owned by several owners without a conserved transfer",
  }),
  item_dual_placement: rule({
    disposition: "reject",
    phases: ALL_GAMEPLAY_PHASES,
    redacted: "A carried item also retained a world location",
    prompt:
      "A carried item has no world location, and a location inventory represents loose objects physically at that exact location.",
  }),
  item_move_requires_inventory_transfer: rule({
    disposition: "reject",
    phases: ALL_GAMEPLAY_PHASES,
    redacted: "An item was moved as an entity instead of transferred between owners",
    prompt:
      "Items never use move_entity. They move only through inventory ownership, using transfer_item between known owners, including an item becoming loose at a known location.",
  }),
  // Normalized: handing an item from an owner to itself leaves ownership where
  // it already is, so the operation is dropped.
  transfer_same_owner: rule({
    disposition: "normalize",
    phases: ALL_GAMEPLAY_PHASES,
    redacted: "A transfer named the same prior and new owner",
  }),
  transfer_insufficient_quantity: rule({
    disposition: "reject",
    phases: ALL_GAMEPLAY_PHASES,
    redacted: "A transfer exceeded the prior owner's authoritative quantity",
    prompt:
      "Never narrate an established owner supplying an item their authoritative inventory cannot supply.",
  }),
  conflicting_item_destination: rule({
    disposition: "reject",
    phases: ALL_GAMEPLAY_PHASES,
    redacted: "One item was given two physical destinations in one turn",
  }),
  multiple_inventory_owners: rule({
    disposition: "reject",
    phases: ALL_GAMEPLAY_PHASES,
    redacted: "One item was added to several inventories in one turn",
  }),
  non_atomic_item_transfer: rule({
    disposition: "reject",
    phases: ALL_GAMEPLAY_PHASES,
    redacted: "One exchange was modelled as unrelated debit and credit effects",
    prompt:
      "Represent every completed exchange between known owners with one transfer_item effect. A one-sided change_inventory is not a conserved payment, gift, taking, or loss; use change_inventory only for a new or unowned item, destruction, or an explicit abstract source or sink.",
  }),
  owned_item_credit_requires_transfer: rule({
    disposition: "reject",
    phases: ALL_GAMEPLAY_PHASES,
    redacted: "An abstract credit duplicated an item that already has a known owner",
  }),
  repeated_abstract_inventory_credit: rule({
    disposition: "reject",
    phases: ALL_GAMEPLAY_PHASES,
    redacted: "An abstract credit repeated one already applied in the current ledger window",
    prompt:
      "Existing owned items are not new acquisitions. Increase inventory only for a distinct current-turn source and explicit receipt.",
  }),

  // ---------------------------------------------------------------- lifecycle
  thread_not_active: rule({
    disposition: "reject",
    phases: ALL_GAMEPLAY_PHASES,
    redacted: "A thread effect targeted a thread that is already closed",
  }),
  thread_id_conflict: rule({
    disposition: "reject",
    phases: ALL_GAMEPLAY_PHASES,
    redacted: "A generated thread ID collided with an existing thread",
  }),
  thread_id_duplicate: rule({
    disposition: "reject",
    phases: ALL_GAMEPLAY_PHASES,
    redacted: "Committed state contained duplicate thread IDs",
  }),
  thread_future_created: rule({
    disposition: "reject",
    phases: ALL_GAMEPLAY_PHASES,
    redacted: "A thread carried a creation turn in the future",
  }),
  thread_future_updated: rule({
    disposition: "reject",
    phases: ALL_GAMEPLAY_PHASES,
    redacted: "A thread carried an update turn in the future",
  }),
  thread_future_closed: rule({
    disposition: "reject",
    phases: ALL_GAMEPLAY_PHASES,
    redacted: "A thread carried a closure turn in the future",
  }),
  thread_updated_before_created: rule({
    disposition: "reject",
    phases: ALL_GAMEPLAY_PHASES,
    redacted: "A thread was updated before it was created",
  }),
  thread_closed_before_update: rule({
    disposition: "reject",
    phases: ALL_GAMEPLAY_PHASES,
    redacted: "A thread was closed before its latest update",
  }),
  thread_active_with_closure: rule({
    disposition: "reject",
    phases: ALL_GAMEPLAY_PHASES,
    redacted: "An active thread carried a closure turn",
  }),
  chronicle_id_conflict: rule({
    disposition: "reject",
    phases: ALL_GAMEPLAY_PHASES,
    redacted: "A generated chronicle event ID collided with an existing event",
  }),
  chronicle_id_duplicate: rule({
    disposition: "reject",
    phases: ALL_GAMEPLAY_PHASES,
    redacted: "Committed state contained duplicate chronicle event IDs",
  }),
  chronicle_future_turn: rule({
    disposition: "reject",
    phases: ALL_GAMEPLAY_PHASES,
    redacted: "A chronicle event carried a turn in the future",
  }),
  campaign_already_ended: rule({
    disposition: "reject",
    phases: ALL_GAMEPLAY_PHASES,
    redacted: "An effect ended a campaign that has already ended",
  }),
  // Normalized: the second identical relationship already holds after the first,
  // so it is dropped as a satisfied operation.
  relationship_duplicate: rule({
    disposition: "normalize",
    phases: ALL_GAMEPLAY_PHASES,
    redacted: "One entity held duplicate relationships to the same target",
  }),

  // -------------------------------------------------------- campaign coherence
  current_location_not_location: rule({
    disposition: "reject",
    phases: ALL_GAMEPLAY_PHASES,
    redacted: "The current campaign location was not a location entity",
  }),
  player_location_mismatch: rule({
    disposition: "reject",
    phases: ALL_GAMEPLAY_PHASES,
    redacted: "The player's location disagreed with the campaign's current location",
  }),
  player_status_mismatch: rule({
    disposition: "reject",
    phases: ALL_GAMEPLAY_PHASES,
    redacted: "The player's status disagreed with the campaign's ending status",
  }),
  player_status_terminal_mismatch: rule({
    disposition: "reject",
    phases: ALL_GAMEPLAY_PHASES,
    redacted: "A terminal player status was set without a matching campaign ending",
  }),

  // -------------------------------------------------------- generated setup
  setup_player_id: rule({
    disposition: "reject",
    phases: ["setup"],
    redacted: "The initial player used an ID other than the required one",
  }),
  setup_duplicate_entity_ids: rule({
    disposition: "reject",
    phases: ["setup"],
    redacted: "Initial entity IDs were not unique",
  }),
  setup_location_name_duplicate: rule({
    disposition: "reject",
    phases: ["setup"],
    redacted: "Two initial locations shared one canonical name",
  }),
  setup_unknown_location: rule({
    disposition: "reject",
    phases: ["setup"],
    redacted: "An initial entity referenced a location that was not included",
  }),
  setup_self_containment: rule({
    disposition: "reject",
    phases: ["setup"],
    redacted: "An initial entity was placed inside itself",
  }),
  setup_player_start_location: rule({
    disposition: "reject",
    phases: ["setup"],
    redacted: "The initial player did not begin at an included location entity",
  }),
  setup_inventory_duplicate_entry: rule({
    disposition: "reject",
    phases: ["setup"],
    redacted: "An initial owner held duplicate inventory entries for one item",
  }),
  setup_inventory_self_containment: rule({
    disposition: "reject",
    phases: ["setup"],
    redacted: "An initial entity contained itself in inventory",
  }),
  setup_unknown_inventory_item: rule({
    disposition: "reject",
    phases: ["setup"],
    redacted: "An initial inventory referenced an item that was not included",
  }),
  setup_inventory_non_item: rule({
    disposition: "reject",
    phases: ["setup"],
    redacted: "An initial inventory entry was not an item",
  }),
  setup_inventory_multiple_owners: rule({
    disposition: "reject",
    phases: ["setup"],
    redacted: "One initial item was inventoried by several owners",
  }),
  setup_item_dual_placement: rule({
    disposition: "reject",
    phases: ["setup"],
    redacted: "An initial inventoried item also carried a world location",
  }),
  setup_inventory_cycle: rule({
    disposition: "reject",
    phases: ["setup"],
    redacted: "Initial inventory ownership formed a cycle",
  }),
  setup_location_hierarchy_cycle: rule({
    disposition: "reject",
    phases: ["setup"],
    redacted: "Initial location containment formed a cycle",
  }),
  setup_thread_unknown_entity: rule({
    disposition: "reject",
    phases: ["setup"],
    redacted: "An initial thread referenced an entity that was not included",
  }),

  // ------------------------------------------------- declared reconciliation
  thread_audit_index_out_of_range: rule({
    disposition: "reject",
    phases: ["adjudication", "resolution"],
    redacted: "A thread audit entry numbered a thread that context never listed",
    prompt:
      "Audit active threads by their number in the context list, never by ID or title. The application resolves the number, so a thread cannot be misnamed; only a number outside the list is an error.",
  }),
  // The state is identical whether or not the reason is written: the thread
  // stays unchanged either way. Spending the turn's one bounded correction to
  // extract a sentence killed runs without protecting any invariant, so this
  // is observed for review instead.
  thread_audit_unjustified_unchanged: rule({
    disposition: "signal",
    phases: ["adjudication", "resolution"],
    redacted: "A thread was declared unchanged although records linked to it changed on this turn",
    prompt:
      "If you declare a thread unchanged while this turn changed one of its linked records, give the brief reason in that entry's text.",
  }),
  // A campaign with no active thread is perfectly readable by a later turn, so
  // this is a judgment about whether the fiction left something open. It cost a
  // bounded correction while protecting no invariant.
  thread_successor_required: rule({
    disposition: "signal",
    phases: ["adjudication", "resolution"],
    redacted: "An active campaign was left with no active thread after a closure",
    prompt:
      "Closing the last active thread requires a successor: create_thread for the danger, obligation, or question the ending leaves open. Solving one objective never makes the remaining situation disappear.",
  }),
  scene_state_required: rule({
    disposition: "reject",
    phases: ["adjudication", "resolution"],
    redacted: "A resolved turn did not declare its end-of-turn scene",
    prompt:
      "Declare the end-of-turn scene: the exact location containing the player character when the turn ends, and every other actor physically present there. The application derives the movement effects from that declaration, so it must match the narrated end state rather than the starting scene.",
  }),
  scene_movement_conflict: rule({
    disposition: "reject",
    phases: ["adjudication", "resolution"],
    redacted: "A movement effect contradicted the declared end-of-turn scene",
  }),
  // A fact whose basis is reported but names no source is fully readable; the
  // missing provenance is an evidence-discipline judgment. Recorded for review
  // rather than spending the turn's one correction.
  fact_source_required: rule({
    disposition: "signal",
    phases: ALL_GAMEPLAY_PHASES,
    redacted: "A reported or inferred fact did not name an authoritative source record",
    prompt:
      "Give every durable fact its basis: observed, reported, inferred, read from a record, or established world truth. A reported or inferred fact must name the source record it came from, and better success never converts an inference into an observation.",
  }),

  // ------------------------------------------------------------------ appeals
  appeal_operation_limit: rule({
    disposition: "reject",
    phases: ["appeal"],
    redacted: "An appeal correction exceeded the operation safety limit",
  }),
  appeal_forbidden_operation: rule({
    disposition: "reject",
    phases: ["appeal"],
    redacted: "An appeal used an effect appeals may never apply",
    prompt:
      "An appeal cannot roll, advance time, record a major event, end a campaign, or restore terminal state.",
  }),
  appeal_terminal_restore: rule({
    disposition: "reject",
    phases: ["appeal"],
    redacted: "An appeal tried to restore a terminal entity",
  }),
  appeal_non_item_creation: rule({
    disposition: "reject",
    phases: ["appeal"],
    redacted: "An appeal created a record other than a missing supported item",
  }),
  appeal_created_item_placement: rule({
    disposition: "reject",
    phases: ["appeal"],
    redacted: "An item created by an appeal did not enter one authoritative inventory",
  }),
  appeal_created_item_credit: rule({
    disposition: "reject",
    phases: ["appeal"],
    redacted: "An item created by an appeal was not credited to exactly one inventory",
  }),
  appeal_created_item_transfer: rule({
    disposition: "reject",
    phases: ["appeal"],
    redacted: "A newly created appeal item was transferred from a prior owner",
  }),
  appeal_item_name_duplicate: rule({
    disposition: "reject",
    phases: ["appeal"],
    redacted: "An appeal item name duplicated an existing item",
  }),
  appeal_contains_check: rule({
    disposition: "reject",
    phases: ["appeal"],
    redacted: "An appeal turn carried a check or automatic outcome",
  }),
  appeal_target_turn_range: rule({
    disposition: "reject",
    phases: ["appeal"],
    redacted: "An appeal named a target turn outside the committed range",
  }),

  // ------------------------------------------------------------ locked outcome
  // Despite the name this is a prose-quality judgment, not a length limit, and
  // no deterministic rewrite can make narration more detailed. Blocking a turn
  // on it traded a committable outcome for nothing enforceable.
  locked_resolution_summary_length: rule({
    disposition: "signal",
    phases: ["resolution"],
    redacted:
      "Checked resolution narration was not more detailed than its summary and did not narrate the complete locked outcome first",
  }),
  locked_resolution_nonlethal_ending: rule({
    disposition: "reject",
    phases: ["resolution"],
    redacted: "A resolution ended the campaign although the locked outcome was nonlethal",
  }),
  locked_resolution_status_conflict: rule({
    disposition: "reject",
    phases: ["resolution"],
    redacted: "A resolution conflicted with the locked campaign status",
  }),

  // -------------------------------------------------------------------- other
  domain_rule: rule({
    disposition: "reject",
    phases: ALL_GAMEPLAY_PHASES,
    redacted: "Local domain validation rejected the structured result",
  }),
} as const satisfies Record<string, DomainRule>;

export type DomainViolationCode = keyof typeof DOMAIN_RULES;

export function domainRule(code: DomainViolationCode): DomainRule {
  return DOMAIN_RULES[code];
}

/** Deterministic prompt fragments for one phase, ordered by rule code. */
export function domainRulePromptFragments(
  phase: RulePhase,
  disposition?: RuleDisposition,
): string[] {
  const entries = Object.entries(DOMAIN_RULES) as [DomainViolationCode, DomainRule][];
  return entries
    .filter(
      ([, value]) =>
        value.prompt !== undefined &&
        value.phases.includes(phase) &&
        (disposition === undefined || value.disposition === disposition),
    )
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, value]) => `- ${value.prompt!}`);
}

/**
 * Rules whose prompt text is guidance rather than a gate.
 *
 * A `signal` is recorded for review and a `normalize` is rewritten
 * deterministically, so neither returns the turn. Stating them under an
 * "enforced" heading claims a consequence that does not exist, and a model that
 * learns one of those claims is false has no way to tell which others are.
 */
export function advisoryRulePromptFragments(phase: RulePhase): string[] {
  return [
    ...domainRulePromptFragments(phase, "normalize"),
    ...domainRulePromptFragments(phase, "signal"),
  ].sort((left, right) => left.localeCompare(right));
}
