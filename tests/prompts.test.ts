import { describe, expect, it } from "vitest";
import { inspectPrompt, PROMPT_PHASES } from "../src/prompt-inspection.js";
import { judgeSystemPrompt } from "../src/evaluation/judge.js";
import { resolveCheck } from "../src/mechanics.js";
import {
  adjudicationPromptDocument,
  APPEAL_SYSTEM_PROMPT,
  APPEAL_SYSTEM_SECTIONS,
  appealPromptDocument,
  CHECK_DIFFICULTY_POLICY,
  CURRENT_STATE_RECONCILIATION,
  DM_SYSTEM_PROMPT,
  DM_SYSTEM_SECTIONS,
  GAMEPLAY_CONTRACT,
  PROMPT_SUITE_VERSION,
  RESOLVED_TURN_AUDIT,
  resolutionPromptDocument,
  setupPromptDocument,
  structuredRepairPrompt,
  turnDomainCorrectionPrompt,
} from "../src/prompts.js";

const context = "AUTHORITATIVE CONTEXT";
const action = "I attempt an uncertain action.";
const check = resolveCheck({
  name: "Test action",
  difficulty: 50,
  modifiers: [{ label: "Prepared", value: 10 }],
  successStakes: "Succeed.",
  failureStakes: "Fail proportionately.",
}, 60);

describe("prompt suite V1", () => {
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
    expect(adjudication.text).toContain(CURRENT_STATE_RECONCILIATION.content);
    expect(resolution.text).toContain(CURRENT_STATE_RECONCILIATION.content);
    expect(resolution.text).toContain("Application-calculated outcome: success");
    expect(resolution.text).toContain("MUST return decision=resolved");
    expect(resolution.text).toContain("returning check_required or proposing another check is invalid");
    expect(resolution.text).toContain("Preserve the attempted action's scope and quantity");
    expect(CHECK_DIFFICULTY_POLICY.content).toContain("directly relevant and actually brought to bear");
    expect(CHECK_DIFFICULTY_POLICY.content).toContain("cannot supply expertise, knowledge, access, or authority");
    expect(CHECK_DIFFICULTY_POLICY.content).toContain("natural-100 override");
    expect(CHECK_DIFFICULTY_POLICY.content).toContain("only the natural-1 override can fail");
    expect(CHECK_DIFFICULTY_POLICY.content).toContain("performative check");
    expect(CHECK_DIFFICULTY_POLICY.content).toContain("newer status, condition, or fact");
  });

  it("reconciles only explicitly changed current state and preserves the policy through recovery", () => {
    const requiredOperations = [
      "set_entity_state", "add_condition", "remove_condition", "supersede_fact",
      "set_relationship", "update_thread", "resolve_thread", "move_entity", "transfer_item", "add_fact",
    ];
    for (const operation of requiredOperations) {
      expect(CURRENT_STATE_RECONCILIATION.content).toContain(operation);
    }
    expect(CURRENT_STATE_RECONCILIATION.content).toContain("Do not infer expiration");
    expect(CURRENT_STATE_RECONCILIATION.content).toContain("causally established");
    expect(CURRENT_STATE_RECONCILIATION.content).toContain("Information recorded into a durable item");
    expect(CURRENT_STATE_RECONCILIATION.content).toContain("material progress, setbacks, commitments, or conclusions");
    expect(CURRENT_STATE_RECONCILIATION.content).toContain("causes, limits, warnings, and commitments");
    expect(CURRENT_STATE_RECONCILIATION.content).toContain("persist what was learned as player knowledge");
    expect(CURRENT_STATE_RECONCILIATION.content).toContain("fields must agree with one another");
    expect(CURRENT_STATE_RECONCILIATION.content).toContain("Resolve or fail a thread only when its stated problem is conclusively finished");
    expect(CURRENT_STATE_RECONCILIATION.content).toContain("Persist each change on its authoritative owner");
    expect(RESOLVED_TURN_AUDIT.content).toContain("one-sided change_inventory is not a conserved");
    expect(RESOLVED_TURN_AUDIT.content).toContain("authoritative inventory cannot supply");
    expect(RESOLVED_TURN_AUDIT.content).toContain("end-of-turn disposition");
    expect(RESOLVED_TURN_AUDIT.content).toContain("After every transfer_item");
    expect(RESOLVED_TURN_AUDIT.content).toContain("puts down, throws, or leaves an item");
    expect(RESOLVED_TURN_AUDIT.content).toContain("stale interaction or activity label");
    expect(RESOLVED_TURN_AUDIT.content).toContain("otherwise unmentioned delay");
    expect(RESOLVED_TURN_AUDIT.content).toContain("nearby settlement");
    expect(RESOLVED_TURN_AUDIT.content).toContain("still-relevant objective, participants, prior discoveries");
    expect(RESOLVED_TURN_AUDIT.content).toContain("marked unused, full, sealed, intact");
    expect(RESOLVED_TURN_AUDIT.content).toContain("nonempty end-of-turn time label");
    expect(RESOLVED_TURN_AUDIT.content).toContain("create that location and move the entity there");
    expect(RESOLVED_TURN_AUDIT.content).toContain("applies equally to the player and NPCs");
    expect(RESOLVED_TURN_AUDIT.content).toContain("add that content to the item itself");
    expect(RESOLVED_TURN_AUDIT.content).toContain("Do not persist an intended or in-progress change as completed");
    expect(RESOLVED_TURN_AUDIT.content).toContain("ongoing danger, custody, accusation, obligation, pursuit, or actionable lead");
    expect(RESOLVED_TURN_AUDIT.content).toContain("Do not leave elapsed time frozen");
    expect(DM_SYSTEM_PROMPT).toContain("an observation, report, suspicion, or correlation is not proof");
    expect(DM_SYSTEM_PROMPT).toContain("currently resist the specific immediate outcome");
    expect(DM_SYSTEM_PROMPT).toContain("Do not silently omit requested speech, commitments, transfers, destinations");
    expect(DM_SYSTEM_PROMPT).toContain("does not authorize performing that later action");
    expect(GAMEPLAY_CONTRACT.content).toContain('Default to ["$unchanged"]');
    expect(GAMEPLAY_CONTRACT.content).toContain('for items, relatedId="" and a separate change_inventory');
    expect(GAMEPLAY_CONTRACT.content).toContain("durable retrieval links");
    expect(GAMEPLAY_CONTRACT.content).toContain("summary body without repeating the thread title");
    expect(CURRENT_STATE_RECONCILIATION.content).toContain("cannot remain DM-only");
    expect(CURRENT_STATE_RECONCILIATION.content).toContain("pending audit");
    expect(CURRENT_STATE_RECONCILIATION.content).toContain("Reconcile scene-wide state");
    expect(CURRENT_STATE_RECONCILIATION.content).toContain("contradictory secret or intention");
    expect(CURRENT_STATE_RECONCILIATION.content).toContain("must not become direct observation or proven causation");
    expect(CURRENT_STATE_RECONCILIATION.content).toContain("resolve_thread changes lifecycle and outcome, not retrieval links");
    expect(RESOLVED_TURN_AUDIT.content).toContain("kind, severity, subject, and body location");
    expect(RESOLVED_TURN_AUDIT.content).toContain("not each routine exchange, attack, conversation beat");
    expect(RESOLVED_TURN_AUDIT.content).toContain("that person is the new owner");
    expect(RESOLVED_TURN_AUDIT.content).toContain("former owner carries, holds, guards, or controls");
    expect(RESOLVED_TURN_AUDIT.content).toContain("opened, closed, unsealed, written in");
    expect(RESOLVED_TURN_AUDIT.content).toContain("first introduces a new central participant");
    expect(CURRENT_STATE_RECONCILIATION.content).toContain("Audit active threads independently");
    expect(RESOLVED_TURN_AUDIT.content).toContain("Build the end-state ledger");
    expect(RESOLVED_TURN_AUDIT.content).toContain("never narrate departure while retaining the old location");

    const original = resolutionPromptDocument(context, action, check).text;
    expect(structuredRepairPrompt(original, "<BAD RESPONSE>", new Error("invalid")))
      .toContain(CURRENT_STATE_RECONCILIATION.content);
    expect(turnDomainCorrectionPrompt(original, "<REJECTED RESPONSE>", new Error("invalid")))
      .toContain(CURRENT_STATE_RECONCILIATION.content);
    expect(judgeSystemPrompt("en")).toContain(CURRENT_STATE_RECONCILIATION.content);
    expect(judgeSystemPrompt("en")).toContain("narration-to-state pass");
    expect(judgeSystemPrompt("en")).toContain("one-sided change_inventory debit is not a persisted transfer");
    expect(judgeSystemPrompt("en")).toContain("A player-knowledge fact does not persist objective world damage");
    expect(judgeSystemPrompt("en")).toContain("Treat descriptions as stable identity text");
    expect(judgeSystemPrompt("en")).toContain("caps persistenceScore and overallScore at 8");
    expect(judgeSystemPrompt("en")).toContain("Audit scene-wide state");
    expect(judgeSystemPrompt("en")).toContain("routine tactical exchanges");
    expect(judgeSystemPrompt("en")).toContain("durableConsequences must be an empty array");
    expect(judgeSystemPrompt("en")).toContain("Audit every starting active thread independently");
  });

  it("defines administrative appeals without creating another gameplay contract", () => {
    const appeal = appealPromptDocument("AUTHORITATIVE APPEAL CONTEXT", "I should own the key.", 7);
    const ids = appeal.sections.map((section) => section.id);

    expect(ids).toEqual([
      "appeal-context", "appeal-target", "appeal-claim", "appeal-review", "gameplay-contract-v1",
    ]);
    expect(appeal.text).toContain("Committed turn under review: 7");
    expect(appeal.text).toContain("not evidence");
    expect(appeal.text).toContain("Current durable state and consequences committed after the target turn outrank older prose");
    expect(appeal.text).toContain("If the appeal is denied, return effects=[]");
    expect(appeal.text).toContain("only the minimal effects");
    expect(appeal.text).toContain("Never roll or request a check");
    expect(appeal.text).toContain("Never retcon, rewind, advance time, record a major event, end the campaign, or resurrect");
    expect(appeal.text).toContain(GAMEPLAY_CONTRACT.content);
    expect(appealPromptDocument(context, "Review this.").text).toContain("No specific committed turn was identified");
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
      const requirements = setup.sections.find((candidate) => candidate.id === "setup-requirements")?.content;

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
      "create_entity", "add_fact", "supersede_fact", "set_entity_state", "move_entity",
      "change_inventory", "transfer_item", "add_condition", "remove_condition", "add_trait",
      "set_relationship", "create_thread", "update_thread", "resolve_thread",
      "record_major_event", "advance_time", "end_campaign",
    ];
    for (const kind of kinds) expect(GAMEPLAY_CONTRACT.content).toContain(`- ${kind}`);
  });

  it("calibrates anchor probabilities to the application d100 mechanic", () => {
    const expected = new Map([[5, 96], [20, 81], [35, 66], [50, 51], [65, 36], [80, 21], [95, 6]]);
    for (const [difficulty, successes] of expected) {
      let actual = 0;
      for (let roll = 1; roll <= 100; roll += 1) {
        const result = resolveCheck({ name: "Anchor", difficulty, modifiers: [], successStakes: "Yes.", failureStakes: "No." }, roll);
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
      if (phase === "adjudication" || phase === "resolution" || phase === "appeal") {
        expect(preview.prompt).toContain("AUTHORITATIVE CAMPAIGN CONTEXT — supplied at runtime");
        expect(preview.prompt).not.toContain("Creative profile marker");
      }
    }
    const dmSystem = inspectPrompt("dm-system", "en");
    expect(dmSystem.sections).toEqual(DM_SYSTEM_SECTIONS.map((section) => section.id));
    const appeal = inspectPrompt("appeal", "en");
    expect(appeal.sections).toEqual(expect.arrayContaining([
      ...APPEAL_SYSTEM_SECTIONS.map((section) => section.id),
      "appeal-review",
    ]));
    expect(appeal.sections).toContain("gameplay-contract-v1");
    expect(appeal.system).toBe(APPEAL_SYSTEM_PROMPT);
    expect(appeal.prompt).toContain("<PLAYER APPEAL CLAIM>");
    const judge = inspectPrompt("judge", "en");
    expect(judge.sections).toEqual(expect.arrayContaining(["current-state-reconciliation", "check-difficulty"]));
    expect(judge.system).toContain(CURRENT_STATE_RECONCILIATION.content);
    const setup = inspectPrompt("setup", "ru");
    expect(setup.prompt).toContain("WORLD AND DM-STYLE PROFILE — selected language profile supplied at runtime");
    expect(setup.prompt).not.toContain("# Классическое фэнтези");
    const probe = inspectPrompt("connection-probe", "en");
    expect(probe.sections).toContain("campaign-setup-schema-probe");
    expect(probe.sections).toContain("gameplay-schema-probe");
    expect(probe.prompt).toContain('"campaignTitle":"Schema Probe"');
    expect(probe.prompt).toContain("decision=resolved");
  });
});
