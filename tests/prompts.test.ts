import { describe, expect, it } from "vitest";
import { inspectPrompt, PROMPT_PHASES } from "../tools/playtest/prompt-inspection.js";
import { playtestJudgeSystemPrompt } from "../tools/playtest/harness/judge.js";
import { resolveCheck } from "../src/mechanics.js";
import {
  adjudicationPromptDocument,
  ACTION_ECONOMY_POLICY,
  APPEAL_SYSTEM_PROMPT,
  APPEAL_SYSTEM_SECTIONS,
  appealPromptDocument,
  CAPABILITY_POLICY,
  CHECK_DIFFICULTY_POLICY,
  CURRENT_STATE_RECONCILIATION,
  DM_SYSTEM_PROMPT,
  DM_SYSTEM_SECTIONS,
  FINAL_RESOLVED_COMMIT_GATE,
  GAMEPLAY_CONTRACT,
  PERSISTENCE_POLICY,
  PROMPT_SUITE_VERSION,
  QUESTION_SYSTEM_PROMPT,
  QUESTION_SYSTEM_SECTIONS,
  questionPromptDocument,
  RESOLVED_TURN_AUDIT,
  resolutionPromptDocument,
  setupPromptDocument,
  structuredRepairPrompt,
  turnDomainCorrectionPrompt,
} from "../src/prompts.js";

const context = "AUTHORITATIVE CONTEXT";
const action = "I attempt an uncertain action.";
const check = resolveCheck(
  {
    name: "Test action",
    difficulty: 50,
    modifiers: [{ label: "Prepared", value: 10 }],
    successStakes: "Succeed.",
    failureStakes: "Fail proportionately.",
  },
  60,
);

describe("prompt suite V1", () => {
  it("treats setting-defined abilities as complete generic capability contracts", () => {
    expect(DM_SYSTEM_SECTIONS).toContain(CAPABILITY_POLICY);
    expect(CAPABILITY_POLICY.content).toContain(
      "mundane training, powers, magic, psionics, mutations, senses, forms, techniques",
    );
    expect(CAPABILITY_POLICY.content).toContain("Apply the entire contract together");
    expect(CAPABILITY_POLICY.content).toContain("no roll can expand a hard limit");
    expect(CAPABILITY_POLICY.content).toContain("Distinguish access from advantage");
    expect(CAPABILITY_POLICY.content).toContain(
      "Never invent generic mana, exhaustion, exposure, or backlash",
    );
    expect(CAPABILITY_POLICY.content).toContain("newly acquired or permanently transformed");
    expect(CAPABILITY_POLICY.content).toContain("reveals only manifestations");
    expect(CAPABILITY_POLICY.content).toContain(
      "name or genre convention grants no implicit function",
    );
    expect(CAPABILITY_POLICY.content).toContain(
      "A tool cannot observe, diagnose, reconstruct, access, communicate, or manipulate",
    );
    expect(CAPABILITY_POLICY.content).toContain(
      "A generic or unspecified kit supplies only its explicitly named components and functions",
    );
    expect(CAPABILITY_POLICY.content).toContain(
      "An established named NPC may carry, wear, draw, activate, use, or supply only",
    );
    expect(CAPABILITY_POLICY.content).toContain(
      "Profession, genre convention, description, and narrative convenience do not create retroactive NPC gear",
    );
    expect(CAPABILITY_POLICY.content).toContain("Observation cannot transmit");
    expect(CAPABILITY_POLICY.content).toContain(
      "does not reveal unobserved facts or prove their absence",
    );
    expect(CAPABILITY_POLICY.content).toContain(
      "Better success improves clarity within the same epistemic kind",
    );
    expect(CHECK_DIFFICULTY_POLICY.content).toContain(
      "make an action possible without automatically making it easier",
    );
    expect(CHECK_DIFFICULTY_POLICY.content).toContain("use recent equivalent check calibration");
    expect(CHECK_DIFFICULTY_POLICY.content).toContain(
      "Hard capability limits are never difficulty",
    );
    expect(GAMEPLAY_CONTRACT.content).toContain("complete self-contained capability contract");
    expect(GAMEPLAY_CONTRACT.content).toContain(
      "add any enduring capability with same-turn add_trait",
    );
    expect(DM_SYSTEM_PROMPT).toContain(
      "genuinely uncertain tracking, concealed evidence, protected access",
    );

    const setup = setupPromptDocument({
      worldRules: "Psychic gifts and ritual magic exist.",
      premise: "A sealed observatory is failing.",
      character:
        "A psychometrist who reads only strongly felt recent past events through bare-skin contact, unreliably and at risk of harmful echoes.",
      language: "en",
    });
    const requirements = setup.sections.find(
      (candidate) => candidate.id === "setup-requirements",
    )?.content;
    expect(requirements).toContain("traits as the durable home");
    expect(requirements).toContain("one self-contained capability trait");
    expect(requirements).toContain("activation or method");
    expect(requirements).toContain("hard limits");
    expect(requirements).toContain("reliability or control");
    expect(requirements).toContain("Keep setting-wide capability rules in scenarioMarkdown");
    expect(requirements).toContain("Do not invent a capability");
  });

  it("requires spatially and temporally coherent setup events", () => {
    const setup = setupPromptDocument({
      worldRules: "Consequences follow physical causes.",
      premise: "A warning arrives after an unexplained loss.",
      character: "A cautious investigator.",
      language: "en",
    });
    const requirements = setup.sections.find(
      (candidate) => candidate.id === "setup-requirements",
    )?.content;

    expect(requirements).toContain("CAUSAL OPENING CHRONOLOGY");
    expect(requirements).toContain("TRANSFER GEOMETRY AUDIT");
    expect(requirements).toContain("must be co-located or physically connected at the event time");
    expect(requirements).toContain("never borrow geometry from the final opening state");
    expect(requirements).toContain("EVIDENCE-TIME AUDIT");
    expect(requirements).toContain(
      "distinguish a detection, observation, or record time from the underlying event time",
    );
    expect(requirements).toContain("ACTIONABLE WARNING AUDIT");
    expect(requirements).toContain("repeating, extending, reversing containment");
    expect(requirements).toContain("CAUSAL SURVIVAL AUDIT");
    expect(requirements).toContain("physically plausible bridge");
  });

  it("keeps setup premise, central entities, and hidden current state durable", () => {
    const setup = setupPromptDocument({
      worldRules: "Journeys and unusual abilities have concrete limits.",
      premise: "A named refuge is empty and an important object is missing.",
      character: "Its caretaker investigates.",
      language: "en",
    });
    const requirements = setup.sections.find(
      (candidate) => candidate.id === "setup-requirements",
    )?.content;

    expect(requirements).toContain("For every supplied named entity central");
    expect(requirements).toContain(
      "movement, access, functions, defenses, practical limits, and established weaknesses",
    );
    expect(requirements).toContain(
      "Do not reduce it to a generic record whose only durable property is its opening position",
    );
    expect(requirements).toContain(
      "Initial status is the DM-authoritative current synopsis, not merely a player belief or a past transition",
    );
    expect(requirements).toContain(
      "Put only the player-known absence in playerKnowledge and the player-safe thread summary",
    );
    expect(requirements).toContain(
      "Put the actual pre-opening transfer chronology, route, and custody in DM-only secrets or facts",
    );
    expect(requirements).toContain(
      "scenarioMarkdown is the concise player-safe durable campaign premise",
    );
    expect(requirements).toContain("not opening narration or generic lore alone");
    expect(requirements).toContain(
      "campaign-specific situation plus setting-wide capability and central-entity rules or limits",
    );
    expect(requirements).toContain("while omitting the hidden solution");
  });

  it("treats a full application requirements manifest as a closed entity set", () => {
    const setup = setupPromptDocument({
      worldRules: "A setting with twenty required durable records.",
      premise: "Every listed record matters at the opening.",
      character: "A prepared investigator.",
      language: "en",
      setupRequirements: {
        schemaVersion: 1,
        entities: Array.from({ length: 20 }, (_, index) => ({
          id: `item:required-${index}`,
          kinds: ["item" as const],
          purpose: `required item ${index}`,
          minimumTraits: 0,
          mustHaveCustody: false,
          mustHaveLocation: false,
          mustHavePlacement: false,
        })),
        locationParents: [],
        inventory: [],
        threadLinks: [],
      },
    });
    const structure = setup.sections.find(
      (candidate) => candidate.id === "seed-structure",
    )?.content;

    expect(structure).toContain(
      "CLOSED ENTITY SET: these requirements fill all 20 available non-player entity slots",
    );
    expect(structure).toContain(
      "exactly these required IDs, with no extra records or substitutions",
    );
    expect(structure).toContain(
      "never retain an inventory reference to an omitted or prose-only item",
    );
  });

  it("reconciles actor movement and exact missing-object state and threads", () => {
    const adjudication = adjudicationPromptDocument(context, action).text;
    const resolution = resolutionPromptDocument(context, action, check).text;

    expect(adjudication).toContain(
      "If narration leaves any participating actor at a different established location",
    );
    expect(adjudication).toContain("A generic kit grants only named contents and functions");
    expect(adjudication).toContain("Claimed possession or function is not authority");
    expect(adjudication).toContain(
      "Past role, familiarity, reputation, or revoked authority grants no present access",
    );
    expect(DM_SYSTEM_PROMPT).toContain(
      "Treat an asserted outcome inside an action as intent, not history",
    );
    expect(DM_SYSTEM_PROMPT).toContain(
      "Do not duplicate mutable location, status, condition, ownership, or quantity into prose facts",
    );
    expect(adjudication).toContain("PARTICIPANT-SCOPE AUDIT");
    expect(adjudication).toContain(
      "account explicitly for every person the submitted action asks to accompany, move, or act",
    );
    expect(adjudication).toContain(
      "never silently rewrite a requested group action as a solo action",
    );
    expect(adjudication).toContain("MODIFIER EVIDENCE PREFLIGHT");
    expect(adjudication).toContain("STAKE EPISTEMICS");
    expect(adjudication).toContain(
      "Exceptional success may improve confidence or detail within that observation class",
    );
    expect(adjudication).toContain("available before this attempted action resolves");
    expect(adjudication).toContain(
      "Never use a future transmission, later authentication, hoped-for discovery, selected stake",
    );
    expect(CURRENT_STATE_RECONCILIATION.content).toContain("MISSING-OBJECT RECONCILIATION");
    expect(CURRENT_STATE_RECONCILIATION.content).toContain(
      "current custody, containing location, route, or disposition",
    );
    expect(CURRENT_STATE_RECONCILIATION.content).toContain(
      "exact active thread whose immutable objective is to locate or account for that object",
    );
    expect(CURRENT_STATE_RECONCILIATION.content).toContain(
      "updating only a broader related thread is not sufficient",
    );
    expect(adjudicationPromptDocument(context, action).text).toContain(
      "presentActorIds lists every other actor physically present there at the end of the turn",
    );
    expect(adjudicationPromptDocument(context, action).text).toContain(
      "an actor who left must be omitted and moved with move_entity instead",
    );
    for (const prompt of [adjudication, resolution]) {
      expect(prompt).toContain("OBJECTIVE CONTINUITY GATE — RUN BEFORE RETURN");
      expect(prompt).toContain("search intent, not locating evidence");
      expect(prompt).toContain("cannot place the object at a guessed destination");
      expect(prompt).toContain(
        "Current observed presence or authoritative inventory outranks a reconstruction from traces",
      );
      expect(prompt).toContain("cannot prove a current transfer");
      expect(prompt).toContain("verify protection for each participant");
      expect(prompt).toContain("remote location is unavailable");
      expect(prompt).toContain("exact capability clause");
      expect(prompt).toContain("both permission and boundary");
      expect(prompt).toContain("do not deny a listed function or infer an unlisted one");
      expect(prompt).toContain(
        "Observation, interpretation, communication, access, and control are separate functions",
      );
      expect(prompt).toContain(
        "role or adjacent capability supplies no missing equipment or function",
      );
      expect(prompt).toContain("current status or fact that still names the former place");
      expect(prompt).toContain("every active thread's immutable objective");
      expect(prompt).toContain("answered, accomplished, or still unresolved");
      expect(prompt).toContain("Resolve every conclusively answered or accomplished objective");
      expect(prompt).toContain("distinct successor thread");
      expect(prompt).toContain("emit the exact supersede_fact or state effect now");
      expect(prompt).toContain("never leave their wording falsely current");
      expect(prompt).toContain(
        "ends outside a sealed, locked, guarded, or hazardous boundary remains in the established exterior containing location",
      );
      expect(prompt).toContain(
        "create a threshold only when it becomes an important reusable scene anchor",
      );
      expect(prompt).toContain(
        "Move the person across only when narration explicitly establishes entry",
      );
      expect(prompt).toContain(
        "Calibrate materially equivalent opposition and hazards consistently with recent turns",
      );
      expect(prompt).toContain(
        "calculate it from the authoritative campaign clock and the established event time",
      );
      expect(prompt).toContain("irreversible campaign-shaping discovery");
      expect(prompt).toContain("threat, transformation, rescue, loss, or central objective");
      expect(prompt).toContain("emit record_major_event");
      expect(prompt).toContain("Ordinary clues and incremental progress are not major events");
    }
  });

  it("limits action bundles under combat or immediate pressure", () => {
    expect(DM_SYSTEM_SECTIONS).toContain(ACTION_ECONOMY_POLICY);
    expect(ACTION_ECONOMY_POLICY.content).toContain("at most one primary consequential action");
    expect(ACTION_ECONOMY_POLICY.content).toContain("Repeated attacks or spells");
    expect(ACTION_ECONOMY_POLICY.content).toContain(
      "attack plus a separate defensive or protective maneuver",
    );
    expect(ACTION_ECONOMY_POLICY.content).toContain(
      "Never compress extra independent actions into one aggregate check",
    );
    expect(ACTION_ECONOMY_POLICY.content).toContain("single-use area or multi-target ability");
    expect(adjudicationPromptDocument(context, action).text).toContain(
      "apply the action-economy policy",
    );
  });

  it("makes physical identity and false-premise continuity explicit at the final task boundary", () => {
    expect(GAMEPLAY_CONTRACT.content).toContain(
      "Create every newly encountered named or important physical actor",
    );
    expect(GAMEPLAY_CONTRACT.content).toContain("One entity ID is one physical body");
    expect(GAMEPLAY_CONTRACT.content).toContain("a copy or identity claimant is a distinct entity");
    expect(GAMEPLAY_CONTRACT.content).toContain(
      "Judge each thread against its own immutable objective, never the latest scene",
    );
    expect(RESOLVED_TURN_AUDIT.content).toContain(
      "Installing a reusable item transfers it from its former owner",
    );
    expect(GAMEPLAY_CONTRACT.content).toContain(
      "An established missing object keeps its identity and ID",
    );
    expect(GAMEPLAY_CONTRACT.content).toContain(
      "Create an important item at its first confirmed appearance",
    );
    expect(adjudicationPromptDocument(context, action).text).toContain(
      "exactly one entry per active thread listed in context",
    );
    expect(adjudicationPromptDocument(context, action).text).toContain(
      "Closing the last active thread requires a successor",
    );
    expect(RESOLVED_TURN_AUDIT.content).toContain("NARRATION SUPPORT AUDIT");
    expect(RESOLVED_TURN_AUDIT.content).toContain("FIRST-APPEARANCE AND CUSTODY AUDIT");
    expect(RESOLVED_TURN_AUDIT.content).toContain("IMPORTANT OBJECT AUDIT");
    expect(RESOLVED_TURN_AUDIT.content).toContain("NPC MOVEMENT AUDIT");
    expect(adjudicationPromptDocument(context, action).text).toContain(
      "sceneState: locationId is the exact location containing the player character",
    );
    expect(adjudicationPromptDocument(context, action).text).toContain(
      "Use the smallest important containing place the narration actually reaches",
    );
    expect(RESOLVED_TURN_AUDIT.content).toContain("EVIDENCE STRENGTH AUDIT");
    expect(RESOLVED_TURN_AUDIT.content).toContain("ACTOR LOADOUT AND HANDLING AUDIT");
    expect(RESOLVED_TURN_AUDIT.content).toContain(
      "no actor can use more hands than narration leaves free",
    );
    expect(adjudicationPromptDocument(context, action).text).toContain(
      "an actor stopped outside a locked, guarded, or hazardous boundary is not inside the place beyond it",
    );
    expect(adjudicationPromptDocument(context, action).text).toContain(
      "stopped outside a locked, guarded, or hazardous boundary",
    );
    expect(RESOLVED_TURN_AUDIT.content).toContain(
      "Enumerate every actor narration says accompanies, follows, arrives",
    );
    expect(RESOLVED_TURN_AUDIT.content).toContain("RELATED-CHARACTER EVIDENCE AUDIT");
    expect(RESOLVED_TURN_AUDIT.content).toContain(
      "related-character target is an indexing choice, not an evidentiary upgrade",
    );
    expect(CURRENT_STATE_RECONCILIATION.content).toContain("STALE SOURCE STATE AUDIT");
    expect(DM_SYSTEM_PROMPT).toContain(
      "DM-only secrets are authoritative causal and historical constraints",
    );
    expect(DM_SYSTEM_PROMPT).toContain("A completed secret past event remains true history");
    expect(DM_SYSTEM_PROMPT).toContain(
      "A secret about current state may change through a later causally narrated event",
    );
    expect(RESOLVED_TURN_AUDIT.content).toContain("PRIVATE HIDDEN-CONTINUITY AUDIT");
    expect(RESOLVED_TURN_AUDIT.content).toContain("time and order, prior and current locations");
    expect(RESOLVED_TURN_AUDIT.content).toContain(
      "All propositions must be able to be true together",
    );
    expect(RESOLVED_TURN_AUDIT.content).toContain(
      "A record establishes what it says, not that the attributed actor acted",
    );
    expect(RESOLVED_TURN_AUDIT.content).toContain("current absence does not prove prior absence");
    expect(GAMEPLAY_CONTRACT.content).toContain(
      "An inspected record or trace is knowledge on its source",
    );
    expect(GAMEPLAY_CONTRACT.content).toContain("name its observed source and retain uncertainty");
    expect(GAMEPLAY_CONTRACT.content).toContain("Thread references are private retrieval metadata");
    expect(RESOLVED_TURN_AUDIT.content).toContain("OBSERVATION CAPABILITY AUDIT");
    expect(RESOLVED_TURN_AUDIT.content).toContain(
      "A method never grants narrator-wide diagnosis or adjacent functions",
    );
    expect(RESOLVED_TURN_AUDIT.content).toContain("UNRESOLVED DISCOVERY COVERAGE");
    expect(RESOLVED_TURN_AUDIT.content).toContain(
      "solving one objective must not erase a distinct remaining question",
    );
    expect(RESOLVED_TURN_AUDIT.content).toContain("CHRONICLE CHECKPOINT");
    expect(RESOLVED_TURN_AUDIT.content).toContain("irreversible campaign-shaping discovery");
    expect(RESOLVED_TURN_AUDIT.content).toContain("defining milestone");
    expect(RESOLVED_TURN_AUDIT.content).toContain("CAUSAL COMPLETION AUDIT");
    expect(RESOLVED_TURN_AUDIT.content).toContain(
      "arrived, accompanied, summoned, confined, guarded, handed off, delivered, installed, retrieved, boarded, evacuated, or departed",
    );
    expect(RESOLVED_TURN_AUDIT.content).toContain("GROUP AND VEHICLE MOVEMENT AUDIT");
    expect(RESOLVED_TURN_AUDIT.content).toContain("A travel status is not a containing location");
    expect(RESOLVED_TURN_AUDIT.content).toContain("AGGREGATE ITEM AUDIT");
    expect(RESOLVED_TURN_AUDIT.content).toContain("shares one owner, destination, and lifecycle");
    expect(RESOLVED_TURN_AUDIT.content).toContain("UNFAMILIAR-ACTION AUDIT");
    expect(RESOLVED_TURN_AUDIT.content).toContain("use a genuine check");

    const prompt = adjudicationPromptDocument(context, "The jump failed, so I repair it.").text;
    expect(prompt).toContain("CONTINUITY PREMISE AUDIT");
    expect(prompt).toContain("ACTOR AND OBJECT PREFLIGHT");
    expect(prompt).toContain("SCENE CONTINUITY PREFLIGHT");
    expect(prompt).toContain("UNFAMILIAR-ACTION PREFLIGHT");
    expect(prompt).toContain("PLAYER RESOURCE PREFLIGHT");
    expect(prompt).toContain("Claimed possession or function is not authority");
    expect(prompt).toContain("RESOLVED PRECOMMIT");
    expect(prompt).toContain("STAKE REPRESENTABILITY AUDIT");
    expect(prompt).toContain("HIDDEN-TRUTH CAUSAL AUDIT");
    expect(prompt).toContain("New physical traces, logs, timestamps, locations, object paths");
    expect(prompt).toContain(
      "dates, elapsed intervals, distances, depths, counts, routes, speakers, and quoted warnings",
    );
    expect(prompt).toContain("durable subjects and consequences in all four branches");
    expect(prompt).toContain("anonymous generic tools, gear, supplies, or possessions");
    expect(prompt).toContain("A fact on a surrounding actor or location does not represent damage");
    expect(prompt).toContain(
      "If the action assumes an unestablished offer, possession, arrival, departure, success, failure, identity, or physical presence",
    );
  });

  it("compresses only player-authorized consequence-free traversal and search", () => {
    expect(ACTION_ECONOMY_POLICY.id).toBe("action-economy");
    expect(ACTION_ECONOMY_POLICY.title).toBe("ACTION ECONOMY AND ROUTINE PACING");
    expect(ACTION_ECONOMY_POLICY.content).toContain(
      "compress consequence-free continuation of the player's submitted travel, traversal, or search intent",
    );
    expect(ACTION_ECONOMY_POLICY.content).toContain(
      "until the next meaningful decision, obstacle, material discovery, or situation change",
    );
    expect(ACTION_ECONOMY_POLICY.content).toContain(
      "Do not stop at every corridor, doorway, or empty search beat",
    );
    expect(ACTION_ECONOMY_POLICY.content).toContain(
      "repeated inspection of the same unchanged object",
    );
    expect(ACTION_ECONOMY_POLICY.content).toContain(
      "routine readiness and preflight checks, stable monitoring, and uneventful transit",
    );
    expect(ACTION_ECONOMY_POLICY.content).toContain(
      "only routine continuation already entailed by the submitted intent",
    );
    expect(ACTION_ECONOMY_POLICY.content).toContain(
      "Never choose a branch, destination, interaction, disclosure, item use, risk",
    );
    expect(ACTION_ECONOMY_POLICY.content).toContain("Stop before a new meaningful choice");
    expect(ACTION_ECONOMY_POLICY.content).toContain(
      "never relaxes the one-primary-action boundary",
    );
    expect(DM_SYSTEM_PROMPT).toContain(
      "consequence-free continuation of submitted traversal or search",
    );
    expect(
      adjudicationPromptDocument(context, "I keep searching the empty passage.").text,
    ).toContain("apply the action-economy policy");
  });

  it("keeps routine noise ephemeral while persisting actionable negative evidence", () => {
    expect(DM_SYSTEM_SECTIONS).toContain(PERSISTENCE_POLICY);
    expect(PERSISTENCE_POLICY.content).toContain(
      "Durable state is selective restart memory, not a transcript index",
    );
    expect(PERSISTENCE_POLICY.content).toContain(
      "Use add_fact only for a durable discovery or consequence",
    );
    expect(PERSISTENCE_POLICY.content).toContain(
      "incremental movement, another routine search step",
    );
    expect(PERSISTENCE_POLICY.content).toContain(
      "no-result observation already represented by recent memory, current location, or current status",
    );
    expect(adjudicationPromptDocument(context, action).text).toContain(
      "conclusive negative evidence that rules out an option or materially narrows the lead is progress",
    );
    expect(PERSISTENCE_POLICY.content).toContain(
      "Negative evidence is still a durable discovery when it conclusively rules out a location, suspect, hypothesis, resource, or approach",
    );
    expect(PERSISTENCE_POLICY.content).toContain("Negative evidence is still a durable discovery");
    expect(GAMEPLAY_CONTRACT.content).toContain("after recent narration is compacted");
    expect(adjudicationPromptDocument(context, action).text).toContain(
      "repeated search procedure, and redundant consequence-free no-result observations are not progress",
    );
    expect(GAMEPLAY_CONTRACT.content).toContain(
      "A conclusive exclusion that narrows an active lead is durable",
    );
    expect(resolutionPromptDocument(context, action, check).text).toContain(
      "repeated search procedure, and redundant consequence-free no-result observations are not progress",
    );
    expect(CURRENT_STATE_RECONCILIATION.content).toContain(
      "leave incremental travel/search procedure and redundant no-result observations to recent narration, location, or status",
    );
    expect(CURRENT_STATE_RECONCILIATION.content).toContain(
      "A conclusively empty place, ruled-out suspect or hypothesis, or other actionable negative finding must remain durable",
    );
    expect(RESOLVED_TURN_AUDIT.content).toContain(
      "Routine movement, repeated search procedure, and redundant consequence-free no-result observations are not progress",
    );
    expect(RESOLVED_TURN_AUDIT.content).toContain(
      "conclusive negative evidence that rules out an option or materially narrows the lead is progress",
    );
  });

  it("persists important discovered places without indexing incidental architecture", () => {
    expect(GAMEPLAY_CONTRACT.content).toContain("A location parent is actual containment");
    expect(GAMEPLAY_CONTRACT.content).toContain(
      "important place when it becomes a reusable destination, container, or scene anchor",
    );
    expect(GAMEPLAY_CONTRACT.content).toContain("not for incidental passage");
    expect(GAMEPLAY_CONTRACT.content).toContain("Learning a place exists is not arrival");
    expect(GAMEPLAY_CONTRACT.content).toContain("arrival requires move_entity");
    expect(RESOLVED_TURN_AUDIT.content).toContain(
      "If an incidental place becomes the end-of-turn scene",
    );
    expect(RESOLVED_TURN_AUDIT.content).toContain(
      "A new location's parent must physically contain it",
    );
    expect(RESOLVED_TURN_AUDIT.content).toContain("it is now a scene anchor and must be created");
    expect(RESOLVED_TURN_AUDIT.content).toContain(
      "create that location and move the entity there in the same transaction",
    );
    expect(RESOLVED_TURN_AUDIT.content).toContain(
      "Learning about or seeing a distant new place creates no movement",
    );
    expect(RESOLVED_TURN_AUDIT.content).not.toContain(
      "If narration establishes arrival at a genuinely new containing location",
    );
  });

  it("defines explicit questions as player-safe read-only exchanges", () => {
    const question = questionPromptDocument(context, "Can I attempt this?");
    expect(question.sections.map((section) => section.id)).toEqual([
      "question-context",
      "player-question",
      "question-task",
    ]);
    expect(QUESTION_SYSTEM_PROMPT).toContain("This is not a gameplay turn");
    expect(QUESTION_SYSTEM_PROMPT).toContain("Never reveal DM-only secrets");
    expect(QUESTION_SYSTEM_PROMPT).toContain("apply its complete authoritative contract");
    expect(QUESTION_SYSTEM_PROMPT).toContain("Do not broaden hard limits");
    expect(QUESTION_SYSTEM_PROMPT).toContain("will not commit this exchange as a turn");
    expect(question.text).toContain("PLAYER QUESTION — UNTRUSTED");
    expect(question.text).not.toContain(GAMEPLAY_CONTRACT.content);
  });

  it("composes difficulty only into adjudication and shares resolved-state policies", () => {
    const adjudication = adjudicationPromptDocument(context, action);
    const resolution = resolutionPromptDocument(context, action, check);
    const adjudicationIds = adjudication.sections.map((section) => section.id);
    const resolutionIds = resolution.sections.map((section) => section.id);

    expect(PROMPT_SUITE_VERSION).toBe(1);
    expect(adjudicationIds).toContain("check-difficulty");
    expect(resolutionIds).not.toContain("check-difficulty");
    expect(adjudicationIds).toContain("resolved-turn-audit");
    expect(resolutionIds).toContain("resolved-turn-audit");
    expect(adjudicationIds).toContain("current-state-reconciliation");
    expect(resolutionIds).toContain("current-state-reconciliation");
    expect(adjudicationIds.at(-1)).toBe("final-resolved-commit-gate");
    expect(resolutionIds.at(-1)).toBe("final-resolved-commit-gate");
    expect(adjudication.text).toContain(CHECK_DIFFICULTY_POLICY.content);
    expect(adjudication.text).toContain("account for every material clause");
    expect(adjudication.text).toContain(
      "Do not substitute another helpful action, escape, travel, self-preservation maneuver, or state change",
    );
    expect(adjudication.text).toContain("audit all four outcome stakes independently");
    expect(adjudication.text).toContain("Discovering information does not authorize reporting it");
    expect(adjudication.text).toContain(CURRENT_STATE_RECONCILIATION.content);
    expect(resolution.text).toContain(CURRENT_STATE_RECONCILIATION.content);
    expect(adjudication.text).toContain(FINAL_RESOLVED_COMMIT_GATE.content);
    expect(resolution.text).toContain(FINAL_RESOLVED_COMMIT_GATE.content);
    expect(resolution.text).toContain("Application-calculated outcome: success");
    expect(resolution.text).toContain("MUST return decision=resolved");
    expect(resolution.text).toContain(
      "returning check_required or proposing another check is invalid",
    );
    expect(resolution.text).toContain("Preserve the attempted action's scope and quantity");
    expect(resolution.text).toContain("CHECKED-NARRATION COMPLETENESS");
    expect(resolution.text).toContain("HIDDEN-TRUTH CAUSAL AUDIT");
    expect(resolution.text).toContain("LOCKED-STAKE CLAUSE AUDIT");
    expect(resolution.text).toContain(
      "Give each clause an explicit sentence or spoken line in narration",
    );
    expect(resolution.text).toContain("LOCKED-CONSEQUENCE ENTITY AUDIT");
    expect(resolution.text).toContain(
      "A fact on the actor or location is not a substitute for the affected item's own entity",
    );
    expect(resolution.text).toContain(
      "The summary must be a shorter compression of events already present in narration",
    );
    expect(resolution.text).toContain(
      "a locked stake does not authorize an unsubmitted player action",
    );
    expect(resolution.text).toContain(
      "newly learned information remains private unless the submitted action explicitly communicated it",
    );
    expect(resolution.text).toContain("SELECTED LOCKED OUTCOME: success");
    expect(resolution.text).toContain(
      "SELECTED LOCKED STAKE — NARRATE AND APPLY THIS BRANCH, NOT ANOTHER BRANCH: Succeed.",
    );
    expect(resolution.text).toContain(
      "narration, effects, and summary all contain its required success, setback, injury, loss, or other consequence",
    );
    expect(CHECK_DIFFICULTY_POLICY.content).toContain(
      "directly relevant and actually brought to bear",
    );
    expect(CHECK_DIFFICULTY_POLICY.content).toContain(
      "cannot supply expertise, knowledge, access, or authority",
    );
    expect(CHECK_DIFFICULTY_POLICY.content).toContain("natural-100 override");
    expect(CHECK_DIFFICULTY_POLICY.content).toContain("only the natural-1 override can fail");
    expect(CHECK_DIFFICULTY_POLICY.content).toContain("performative check");
    expect(CHECK_DIFFICULTY_POLICY.content).toContain("newer status, condition, or fact");
  });

  it("ends both resolved prompt paths with a setting-agnostic five-part commit gate", () => {
    const adjudication = adjudicationPromptDocument(context, action);
    const resolution = resolutionPromptDocument(context, action, check);

    expect(FINAL_RESOLVED_COMMIT_GATE.content.match(/^\d\./gm)).toHaveLength(5);
    expect(FINAL_RESOLVED_COMMIT_GATE.content).toContain(
      "every material summary/effect claim is explicitly narrated",
    );
    expect(FINAL_RESOLVED_COMMIT_GATE.content).toContain(
      "clarity proves neither an unobserved fact nor its absence",
    );
    expect(FINAL_RESOLVED_COMMIT_GATE.content).toContain("exact item custody or quantity");
    expect(FINAL_RESOLVED_COMMIT_GATE.content).toContain(
      "threadAudit covers every active thread exactly once",
    );
    expect(FINAL_RESOLVED_COMMIT_GATE.content).toContain(
      "a capsule freshness count above zero requires explicit review",
    );
    expect(FINAL_RESOLVED_COMMIT_GATE.content).toContain(
      "state, evidence, and threads describe one end state",
    );
    expect(adjudication.sections.at(-1)).toBe(FINAL_RESOLVED_COMMIT_GATE);
    expect(resolution.sections.at(-1)).toBe(FINAL_RESOLVED_COMMIT_GATE);
  });

  it("keeps discoveries private until the player chooses to disclose them", () => {
    expect(DM_SYSTEM_PROMPT).toContain(
      "Learning, noticing, or deducing information never authorizes revealing it",
    );
    expect(DM_SYSTEM_PROMPT).toContain(
      "An explicitly submitted line of speech authorizes only that communication",
    );
    expect(DM_SYSTEM_PROMPT).toContain(
      "Never persist invented player dialogue, disclosure, commitments, or follow-up actions",
    );

    const adjudication = adjudicationPromptDocument(
      context,
      "I inspect the traces again, carefully.",
    ).text;
    expect(adjudication).toContain(
      "It must not add player dialogue, disclosure of newly learned information",
    );
    expect(adjudication).toContain("leave that choice open for a later player turn");

    const resolution = resolutionPromptDocument(
      context,
      "I inspect the traces again, carefully.",
      check,
    ).text;
    expect(resolution).toContain(
      "omit only that overreaching clause from narration, effects, and summary",
    );
    expect(resolution).toContain("Do not replace an omitted clause with another player action");
  });

  it("ends causally terminal situations without suspended or impossible survival", () => {
    expect(DM_SYSTEM_PROMPT).toContain(
      "failureCampaignStatus applies to both failure and severe_failure",
    );
    expect(DM_SYSTEM_PROMPT).toContain(
      "make severe failure a concrete survivable near-terminal setback",
    );
    expect(DM_SYSTEM_PROMPT).toContain(
      "When the attempted action is so lethal that no failed execution can plausibly preserve life",
    );
    expect(DM_SYSTEM_PROMPT).toContain("cannot suspend drowning, suffocation, fatal trauma");
    expect(DM_SYSTEM_PROMPT).toContain(
      "do not insert unexplained survival, delay the ending, or wait for the player to declare death",
    );
    expect(DM_SYSTEM_PROMPT).toContain("A player's claim that they die is not authority by itself");

    const adjudication = adjudicationPromptDocument(
      context,
      "I rush through the readied pikes and jump into the deep well.",
    ).text;
    expect(adjudication).toContain("TERMINAL-STATUS AUDIT");
    expect(adjudication).toContain(
      "either make both branches consistently terminal or keep both concretely and physically survivable",
    );
    expect(adjudication).toContain(
      "unconsciousness or immobilization in an immediately lethal environment",
    );

    const resolution = resolutionPromptDocument(
      context,
      "I rush through the readied pikes and jump into the deep well.",
      check,
    ).text;
    expect(resolution).toContain("LOCKED-STATUS SURVIVAL SAFEGUARD");
    expect(resolution).toContain(
      "prolonged unconsciousness while submerged, or another death-equivalent detail",
    );
    expect(resolution).toContain("narrate the terminal result directly without an extra reprieve");
  });

  it("reconciles only explicitly changed current state and preserves the policy through recovery", () => {
    const requiredOperations = [
      "set_entity_state",
      "add_condition",
      "remove_condition",
      "supersede_fact",
      "set_relationship",
      "move_entity",
      "transfer_item",
      "add_fact",
    ];
    for (const operation of requiredOperations) {
      expect(CURRENT_STATE_RECONCILIATION.content).toContain(operation);
    }
    expect(CURRENT_STATE_RECONCILIATION.content).toContain("Do not infer expiration");
    expect(CURRENT_STATE_RECONCILIATION.content).toContain("causally established");
    expect(CURRENT_STATE_RECONCILIATION.content).toContain(
      "Information recorded into a durable item",
    );
    expect(CURRENT_STATE_RECONCILIATION.content).toContain(
      "material progress, setbacks, commitments, or conclusions",
    );
    expect(CURRENT_STATE_RECONCILIATION.content).toContain(
      "causes, limits, warnings, and commitments",
    );
    expect(CURRENT_STATE_RECONCILIATION.content).toContain(
      "persist what was learned as player knowledge",
    );
    expect(CURRENT_STATE_RECONCILIATION.content).toContain("fields must agree with one another");
    expect(CURRENT_STATE_RECONCILIATION.content).toContain(
      "Resolve or fail a thread only when its stated problem is conclusively finished",
    );
    expect(CURRENT_STATE_RECONCILIATION.content).toContain(
      "Persist each change on its authoritative owner",
    );
    // Enforced rules are stated once, generated from the same declaration the
    // admission stage evaluates, so assert them on the delivered prompt.
    expect(adjudicationPromptDocument(context, action).text).toContain(
      "one-sided change_inventory is not a conserved",
    );
    expect(resolutionPromptDocument(context, action, check).text).toContain(
      "one-sided change_inventory is not a conserved",
    );
    expect(adjudicationPromptDocument(context, action).text).toContain(
      "authoritative inventory cannot supply",
    );
    expect(RESOLVED_TURN_AUDIT.content).toContain("end-of-turn disposition");
    expect(RESOLVED_TURN_AUDIT.content).toContain("After every transfer_item");
    expect(RESOLVED_TURN_AUDIT.content).toContain("puts down, throws, or leaves an item");
    expect(RESOLVED_TURN_AUDIT.content).toContain("stale interaction or activity label");
    expect(RESOLVED_TURN_AUDIT.content).toContain("otherwise unmentioned delay");
    expect(RESOLVED_TURN_AUDIT.content).toContain("nearby settlement");
    expect(RESOLVED_TURN_AUDIT.content).toContain(
      "still-relevant objective, participants, prior discoveries",
    );
    expect(RESOLVED_TURN_AUDIT.content).toContain("marked unused, full, sealed, intact");
    expect(RESOLVED_TURN_AUDIT.content).toContain("nonempty end-of-turn time label");
    expect(RESOLVED_TURN_AUDIT.content).toContain("create that location and move the entity there");
    expect(RESOLVED_TURN_AUDIT.content).toContain("applies equally to the player and NPCs");
    expect(RESOLVED_TURN_AUDIT.content).toContain("add that content to the item itself");
    expect(RESOLVED_TURN_AUDIT.content).toContain(
      "Do not persist an intended or in-progress change as completed",
    );
    expect(RESOLVED_TURN_AUDIT.content).toContain(
      "ongoing danger, custody, accusation, obligation, pursuit, or actionable lead",
    );
    expect(RESOLVED_TURN_AUDIT.content).toContain("Do not leave elapsed time frozen");
    expect(DM_SYSTEM_PROMPT).toContain(
      "an observation, report, suspicion, or correlation is not proof",
    );
    expect(DM_SYSTEM_PROMPT).toContain("currently resist the specific immediate outcome");
    expect(DM_SYSTEM_PROMPT).toContain("honoring an existing promise remains unopposed");
    expect(DM_SYSTEM_PROMPT).toContain("does not itself consume campaign time");
    expect(DM_SYSTEM_PROMPT).toContain(
      "Do not silently omit requested speech, commitments, transfers, destinations",
    );
    expect(DM_SYSTEM_PROMPT).toContain("does not authorize performing that later action");
    expect(GAMEPLAY_CONTRACT.content).toContain(
      'the single value "$unchanged" to keep the current links',
    );
    expect(GAMEPLAY_CONTRACT.content).toContain(
      'for items, relatedId="" and a separate change_inventory',
    );
    expect(GAMEPLAY_CONTRACT.content).toContain("private retrieval metadata");
    expect(GAMEPLAY_CONTRACT.content).toContain(
      "no longer than 1600 characters and without repeating the title",
    );
    expect(GAMEPLAY_CONTRACT.content).toContain(
      'verify narration === "", summary === "", and effects is exactly []',
    );
    expect(adjudicationPromptDocument(context, action).text).toContain("CHECK-REQUIRED WIRE AUDIT");
    expect(CURRENT_STATE_RECONCILIATION.content).toContain("cannot remain DM-only");
    expect(CURRENT_STATE_RECONCILIATION.content).toContain("pending audit");
    expect(CURRENT_STATE_RECONCILIATION.content).toContain("Reconcile scene-wide state");
    expect(CURRENT_STATE_RECONCILIATION.content).toContain("CURRENT-MARKER SWEEP");
    expect(CURRENT_STATE_RECONCILIATION.content).toContain(
      "alarm, idle engine, custody, missing state, containment, contamination",
    );
    expect(CURRENT_STATE_RECONCILIATION.content).toContain(
      "Treat tags as enduring classification only",
    );
    expect(CURRENT_STATE_RECONCILIATION.content).toContain("contradictory secret or intention");
    expect(CURRENT_STATE_RECONCILIATION.content).toContain(
      "must not become direct observation or proven causation",
    );
    // Retrieval links now travel on the audit entry rather than a separate
    // lifecycle effect, so the contract states it once.
    expect(adjudicationPromptDocument(context, action).text).toContain(
      'references is the complete related entity ID list, or the single value "$unchanged"',
    );
    expect(RESOLVED_TURN_AUDIT.content).toContain("kind, severity, subject, and body location");
    expect(RESOLVED_TURN_AUDIT.content).toContain(
      "not each routine exchange, attack, conversation beat",
    );
    expect(RESOLVED_TURN_AUDIT.content).toContain("that person is the new owner");
    expect(RESOLVED_TURN_AUDIT.content).toContain(
      "former owner carries, holds, guards, or controls",
    );
    expect(RESOLVED_TURN_AUDIT.content).toContain("opened, closed, unsealed, written in");
    expect(adjudicationPromptDocument(context, action).text).toContain(
      "retain a central DM-known hidden actor or location needed to resolve the objective",
    );
    expect(CURRENT_STATE_RECONCILIATION.content).toContain("Audit active threads independently");
    expect(RESOLVED_TURN_AUDIT.content).toContain("Build the end-state ledger");
    expect(RESOLVED_TURN_AUDIT.content).toContain(
      "never narrate departure while retaining the old location",
    );

    const original = resolutionPromptDocument(context, action, check).text;
    expect(structuredRepairPrompt(original, "<BAD RESPONSE>", new Error("invalid"))).toContain(
      CURRENT_STATE_RECONCILIATION.content,
    );
    const checkRepair = structuredRepairPrompt(
      original,
      {
        decision: "check_required",
        narration: "",
        summary: "Premature summary.",
        effects: [],
      },
      new Error("summary must be empty"),
    );
    expect(checkRepair).toContain("CHECK-REQUIRED REPAIR CHECKLIST");
    expect(checkRepair).toContain(
      'set narration exactly to "", summary exactly to "", and effects exactly to []',
    );
    const domainCorrection = turnDomainCorrectionPrompt(
      original,
      "<REJECTED RESPONSE>",
      new Error("Unknown location reference location:shortened"),
    );
    expect(domainCorrection).toContain(CURRENT_STATE_RECONCILIATION.content);
    expect(domainCorrection).toContain("EXACT-ID CORRECTION PROCEDURE");
    expect(domainCorrection).toContain(
      "copy only the exact characters inside one bracketed authoritative ID",
    );
    expect(domainCorrection).not.toContain("thread:the-empty-colony-turn-0");
    expect(domainCorrection).toContain("An almost-matching ID is still unknown");
    expect(playtestJudgeSystemPrompt("en")).toContain(CURRENT_STATE_RECONCILIATION.content);
    expect(playtestJudgeSystemPrompt("en")).toContain(CHECK_DIFFICULTY_POLICY.content);
    expect(playtestJudgeSystemPrompt("en")).toContain(
      "Candidate technical status was frozen before judging",
    );
    expect(playtestJudgeSystemPrompt("en")).toContain(
      "Judge failures, latency, cost, retries, and repairs are judge telemetry only",
    );
    expect(playtestJudgeSystemPrompt("en")).toContain(
      "Audit every completed turn and every committed operation index",
    );
  });

  it("defines administrative appeals without creating another gameplay contract", () => {
    const appeal = appealPromptDocument("AUTHORITATIVE APPEAL CONTEXT", "I should own the key.", 7);
    const ids = appeal.sections.map((section) => section.id);

    expect(ids).toEqual([
      "appeal-context",
      "appeal-target",
      "appeal-claim",
      "appeal-review",
      "gameplay-contract-v1",
      "domain-rules",
    ]);
    // Rules are phase-scoped: the appeal-only rule reaches appeals and never
    // reaches a gameplay turn.
    expect(appeal.text).toContain("An appeal cannot roll, advance time");
    expect(adjudicationPromptDocument(context, action).text).not.toContain(
      "An appeal cannot roll, advance time",
    );
    expect(appeal.text).toContain("Committed turn under review: 7");
    expect(appeal.text).toContain("not evidence");
    expect(appeal.text).toContain(
      "Current durable state and consequences committed after the target turn outrank older prose",
    );
    expect(appeal.text).toContain("If the appeal is denied, return effects=[]");
    expect(appeal.text).toContain("only the minimal effects");
    expect(appeal.text).toContain("Never roll or request a check");
    expect(appeal.text).toContain(
      "Never retcon, rewind, advance time, record a major event, end the campaign, or resurrect",
    );
    expect(appeal.text).toContain(GAMEPLAY_CONTRACT.content);
    expect(appealPromptDocument(context, "Review this.").text).toContain(
      "No specific committed turn was identified",
    );
    expect(APPEAL_SYSTEM_PROMPT).toContain("administrative consistency reviewer");
    expect(APPEAL_SYSTEM_PROMPT).toContain("do not act as the narrator of a new gameplay turn");
    expect(APPEAL_SYSTEM_PROMPT).not.toContain("vivid second-person");
    expect(APPEAL_SYSTEM_PROMPT).not.toContain("End with a concrete situation");
  });

  it("defines acyclic physical containment for setup in every supported language", () => {
    for (const language of ["en", "ru"] as const) {
      const setup = setupPromptDocument({
        worldRules: "Classic fantasy.",
        premise: "A tavern opening.",
        character: "A scout.",
        language,
      });
      const requirements = setup.sections.find(
        (candidate) => candidate.id === "setup-requirements",
      )?.content;

      expect(requirements).toContain("CAUSAL OPENING CHRONOLOGY");
      expect(requirements).toContain("actual actor or source, prior state, place or owner");
      expect(requirements).toContain(
        "Nothing can act, transfer, or arrive somewhere without a plausible connection and enough time",
      );
      expect(requirements).toContain("TRANSFER GEOMETRY AUDIT");
      expect(requirements).toContain("co-located or physically connected at the event time");
      expect(requirements).toContain("never borrow geometry from the final opening state");
      expect(requirements).toContain("EVIDENCE-TIME AUDIT");
      expect(requirements).toContain("ACTIONABLE WARNING AUDIT");
      expect(requirements).toContain("CAUSAL SURVIVAL AUDIT");
      expect(requirements).toContain("quantitative details as continuity anchors");

      expect(requirements).toContain("physical containment by a different included location");
      expect(requirements).toContain("location-parent chains must be acyclic");
      expect(requirements).toContain("CONTAINMENT HIERARCHY AUDIT");
      expect(requirements).toContain("a parent location must physically contain its child");
      expect(requirements).toContain("exterior threshold and the distinct place beyond it");
      expect(requirements).toContain("OPTIONAL REFERENCE FORM");
      expect(requirements).toContain("INVENTORY-LOCATION EXCLUSIVITY AUDIT");
      expect(requirements).toContain("Inventory is the ownership authority");

      expect(requirements).toContain("its own exact item with a neutral enduring identity");
      expect(requirements).toContain("smallest known containing place");
      expect(requirements).toContain(
        "Every physical item entity must appear in exactly one person or location inventory",
      );
      expect(requirements).toContain("HIDDEN-CUSTODY AUDIT");
      expect(requirements).toContain("Earlier custodians remain history");
      expect(requirements).toContain("Initial thread relatedEntityIds are private retrieval links");
      expect(requirements).toContain("Aggregate only homogeneous items");
      expect(requirements).toContain("share custody, destination, and lifecycle");

      expect(requirements).toContain("Treat each named actor's opening inventory as exhaustive");
      expect(requirements).toContain(
        "role, genre, description, traits, facts, secrets, or narration never create implicit equipment",
      );
      expect(requirements).toContain("SEED COMPLETENESS GATE");
      expect(requirements).toContain("Prose mention is not a substitute");
      expect(requirements).toContain("STRICT SETUP SIZE AUDIT");
      expect(requirements).toContain("hard maximum of 20 records, excluding player");
      expect(requirements).toContain("return exactly that closed set");
      expect(requirements).toContain("Never rely on truncation or repair");
      expect(requirements).toContain("Keep entity descriptions stable");
    }
  });

  it("documents every Gameplay Contract V1 effect kind", () => {
    const kinds = [
      "create_entity",
      "add_fact",
      "supersede_fact",
      "set_entity_state",
      "move_entity",
      "change_inventory",
      "transfer_item",
      "add_condition",
      "remove_condition",
      "add_trait",
      "set_relationship",
      "create_thread",
      "record_major_event",
      "advance_time",
      "end_campaign",
    ];
    for (const kind of kinds) expect(GAMEPLAY_CONTRACT.content).toContain(`- ${kind}`);

    // The tag taxonomy is an enforced rule, so the wire contract no longer
    // restates it: one generated statement now serves every gameplay phase.
    const delivered = adjudicationPromptDocument(context, action).text;
    expect(delivered).toContain("never mutable or epistemic state");
    expect(delivered).toContain(
      "discovered, guarding, hidden, holding, idle, in-transit, known, missing, undiscovered, unknown",
    );
    expect(delivered).toContain(
      "what has or has not been learned with player knowledge, facts, and threads",
    );
    expect(
      (delivered.match(/discovered, guarding, hidden, holding, idle, in-transit/gu) ?? []).length,
    ).toBe(1);
  });

  it("calibrates anchor probabilities to the application d100 mechanic", () => {
    const expected = new Map([
      [5, 96],
      [20, 81],
      [35, 66],
      [50, 51],
      [65, 36],
      [80, 21],
      [95, 6],
    ]);
    for (const [difficulty, successes] of expected) {
      let actual = 0;
      for (let roll = 1; roll <= 100; roll += 1) {
        const result = resolveCheck(
          {
            name: "Anchor",
            difficulty,
            modifiers: [],
            successStakes: "Yes.",
            failureStakes: "No.",
          },
          roll,
        );
        if (result.outcome === "success" || result.outcome === "exceptional_success") actual += 1;
      }
      expect(actual).toBe(successes);
    }
  });

  it("inspects only static templates and safe placeholders", () => {
    for (const phase of PROMPT_PHASES) {
      const preview = inspectPrompt(phase, "ru");
      expect(preview.containsLiveCampaignData).toBe(false);
      expect(preview.version).toBe(1);
      expect(`${preview.system}\n${preview.prompt}`).not.toContain("watch captain takes bribes");
      if (
        phase === "adjudication" ||
        phase === "resolution" ||
        phase === "question" ||
        phase === "appeal"
      ) {
        expect(preview.prompt).toContain("AUTHORITATIVE CAMPAIGN CONTEXT — supplied at runtime");
        expect(preview.prompt).not.toContain("Creative profile marker");
      }
    }
    const dmSystem = inspectPrompt("dm-system", "en");
    expect(dmSystem.sections).toEqual(DM_SYSTEM_SECTIONS.map((section) => section.id));
    expect(dmSystem.sourceFiles).toEqual(["src/prompts/blocks.ts"]);
    const adjudication = inspectPrompt("adjudication", "en");
    expect(adjudication.sharedSystemSource).toBe("src/prompts/blocks.ts");
    expect(adjudication.sourceFiles).toContain("src/prompts/gameplay.ts");
    const appeal = inspectPrompt("appeal", "en");
    expect(appeal.sections).toEqual(
      expect.arrayContaining([
        ...APPEAL_SYSTEM_SECTIONS.map((section) => section.id),
        "appeal-review",
      ]),
    );
    expect(appeal.sections).toContain("gameplay-contract-v1");
    expect(appeal.system).toBe(APPEAL_SYSTEM_PROMPT);
    expect(appeal.prompt).toContain("<PLAYER APPEAL CLAIM>");
    const question = inspectPrompt("question", "en");
    expect(question.sections).toEqual(
      expect.arrayContaining([
        ...QUESTION_SYSTEM_SECTIONS.map((section) => section.id),
        "question-task",
      ]),
    );
    expect(question.system).toBe(QUESTION_SYSTEM_PROMPT);
    expect(question.prompt).toContain("<PLAYER QUESTION>");
    const judge = inspectPrompt("judge", "en");
    expect(judge.sections).toEqual(
      expect.arrayContaining(["current-state-reconciliation", "check-difficulty"]),
    );
    expect(judge.system).toContain(CURRENT_STATE_RECONCILIATION.content);
    const setup = inspectPrompt("setup", "ru");
    expect(setup.prompt).toContain(
      "WORLD AND DM-STYLE PROFILE — selected language profile supplied at runtime",
    );
    expect(setup.prompt).not.toContain("# Классическое фэнтези");
    const probe = inspectPrompt("connection-probe", "en");
    expect(probe.sections).toContain("campaign-setup-schema-probe");
    expect(probe.sections).toContain("gameplay-schema-probe");
    expect(probe.prompt).toContain('"campaignTitle":"Schema Probe"');
    expect(probe.prompt).toContain("decision=resolved");
  });
});
