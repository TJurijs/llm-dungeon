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
  GAMEPLAY_CONTRACT,
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
    expect(CHECK_DIFFICULTY_POLICY.content).toContain(
      "make an action possible without automatically making it easier",
    );
    expect(CHECK_DIFFICULTY_POLICY.content).toContain(
      "use recent equivalent check calibration",
    );
    expect(CHECK_DIFFICULTY_POLICY.content).toContain(
      "Hard capability limits are never difficulty",
    );
    expect(GAMEPLAY_CONTRACT.content).toContain(
      "complete self-contained capability contract",
    );
    expect(GAMEPLAY_CONTRACT.content).toContain(
      "separate same-turn add_trait effect referencing this hint",
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
    expect(adjudication.text).toContain(CHECK_DIFFICULTY_POLICY.content);
    expect(adjudication.text).toContain("account for every material clause");
    expect(adjudication.text).toContain(
      "Do not substitute another helpful action, escape, travel, self-preservation maneuver, or state change",
    );
    expect(adjudication.text).toContain("audit all four outcome stakes independently");
    expect(adjudication.text).toContain("Discovering information does not authorize reporting it");
    expect(adjudication.text).toContain(CURRENT_STATE_RECONCILIATION.content);
    expect(resolution.text).toContain(CURRENT_STATE_RECONCILIATION.content);
    expect(resolution.text).toContain("Application-calculated outcome: success");
    expect(resolution.text).toContain("MUST return decision=resolved");
    expect(resolution.text).toContain(
      "returning check_required or proposing another check is invalid",
    );
    expect(resolution.text).toContain("Preserve the attempted action's scope and quantity");
    expect(resolution.text).toContain("CHECKED-NARRATION COMPLETENESS");
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
      "update_thread",
      "resolve_thread",
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
    expect(RESOLVED_TURN_AUDIT.content).toContain("one-sided change_inventory is not a conserved");
    expect(RESOLVED_TURN_AUDIT.content).toContain("authoritative inventory cannot supply");
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
    expect(GAMEPLAY_CONTRACT.content).toContain('Default to ["$unchanged"]');
    expect(GAMEPLAY_CONTRACT.content).toContain(
      'for items, relatedId="" and a separate change_inventory',
    );
    expect(GAMEPLAY_CONTRACT.content).toContain("durable retrieval links");
    expect(GAMEPLAY_CONTRACT.content).toContain("summary body without repeating the thread title");
    expect(GAMEPLAY_CONTRACT.content).toContain(
      'verify narration === "", summary === "", and effects is exactly []',
    );
    expect(adjudicationPromptDocument(context, action).text).toContain("CHECK-REQUIRED WIRE AUDIT");
    expect(CURRENT_STATE_RECONCILIATION.content).toContain("cannot remain DM-only");
    expect(CURRENT_STATE_RECONCILIATION.content).toContain("pending audit");
    expect(CURRENT_STATE_RECONCILIATION.content).toContain("Reconcile scene-wide state");
    expect(CURRENT_STATE_RECONCILIATION.content).toContain("contradictory secret or intention");
    expect(CURRENT_STATE_RECONCILIATION.content).toContain(
      "must not become direct observation or proven causation",
    );
    expect(CURRENT_STATE_RECONCILIATION.content).toContain(
      "resolve_thread changes lifecycle and outcome, not retrieval links",
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
    expect(RESOLVED_TURN_AUDIT.content).toContain("first introduces a new central participant");
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
    expect(
      turnDomainCorrectionPrompt(original, "<REJECTED RESPONSE>", new Error("invalid")),
    ).toContain(CURRENT_STATE_RECONCILIATION.content);
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
    ]);
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

      expect(requirements).toContain("physical containment by a different included location");
      expect(requirements).toContain("entity's own ID");
      expect(requirements).toContain("omit it for a top-level location");
      expect(requirements).toContain("location-parent chains must be acyclic");
      expect(requirements).toContain("Inventory is the ownership authority");
      expect(requirements).toContain("Secrecy changes who knows about an object");
      expect(requirements).toContain("audit every possession claim");
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
      "update_thread",
      "resolve_thread",
      "record_major_event",
      "advance_time",
      "end_campaign",
    ];
    for (const kind of kinds) expect(GAMEPLAY_CONTRACT.content).toContain(`- ${kind}`);
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
