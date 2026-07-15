import { judgePrompt, judgeSystemPrompt, type JudgeProfile, type TechnicalHealthStats } from "./evaluation/judge.js";
import { type LanguageCode } from "./language.js";
import { resolveCheck } from "./mechanics.js";
import {
  adjudicationPromptDocument,
  APPEAL_SYSTEM_PROMPT,
  APPEAL_SYSTEM_SECTIONS,
  appealPromptDocument,
  CHECK_DIFFICULTY_POLICY,
  DM_SYSTEM_PROMPT,
  DM_SYSTEM_SECTIONS,
  PROMPT_SUITE_VERSION,
  resolutionPromptDocument,
  setupPromptDocument,
  structuredRepairPrompt,
  turnDomainCorrectionPrompt,
} from "./prompts.js";
import {
  CONNECTION_GAMEPLAY_PROMPT,
  CONNECTION_SETUP_PROBE,
  CONNECTION_SYSTEM_PROMPT,
  connectionSetupPrompt,
} from "./prompts/connection.js";
import { simulatedPlayerPrompt, simulatedPlayerSystemPrompt } from "./prompts/evaluation.js";

export const PROMPT_PHASES = [
  "dm-system",
  "setup",
  "adjudication",
  "difficulty",
  "resolution",
  "appeal",
  "schema-repair",
  "domain-correction",
  "simulated-player",
  "judge",
  "connection-probe",
] as const;

export type PromptPhase = (typeof PROMPT_PHASES)[number];

export interface PromptInspection {
  readonly phase: PromptPhase;
  readonly version: number;
  readonly sections: readonly string[];
  readonly system: string;
  readonly prompt: string;
  readonly containsLiveCampaignData: false;
}

const CONTEXT_PLACEHOLDER = "<AUTHORITATIVE CAMPAIGN CONTEXT — supplied at runtime; hidden state is never exposed by this inspector>";
const ACTION_PLACEHOLDER = "<PLAYER ACTION>";
const WORLD_PROFILE_PLACEHOLDER = "<WORLD AND DM-STYLE PROFILE — selected language profile supplied at runtime>";

function previewCheck() {
  return resolveCheck({
    name: "Example uncertain action",
    difficulty: 50,
    modifiers: [{ label: "Example meaningful advantage", value: 10 }],
    exceptionalSuccessStakes: "The attempt succeeds with an additional established advantage.",
    successStakes: "The attempt succeeds.",
    failureStakes: "The attempt fails with a proportionate setback.",
    severeFailureStakes: "The attempt fails and materially worsens the situation.",
    failureCampaignStatus: "none",
  }, 55);
}

const JUDGE_PROFILE: JudgeProfile = {
  id: "example-profile",
  instruction: "Pursue an established goal and react to consequences.",
};

const EMPTY_TECHNICAL_HEALTH: TechnicalHealthStats = {
  gameplayDmCalls: 0,
  gameplayPlayerCalls: 0,
  failedDmCalls: 0,
  failedPlayerCalls: 0,
  dmFailureRate: 0,
  schemaRepairCalls: 0,
  transientRetryCalls: 0,
  domainRepairCalls: 0,
  failedCallCostUsd: 0,
};

export function inspectPrompt(
  phase: PromptPhase,
  language: LanguageCode,
): PromptInspection {
  let system = DM_SYSTEM_PROMPT;
  let prompt = "";
  let sections: readonly string[] = [];

  switch (phase) {
    case "dm-system":
      prompt = "<PHASE-SPECIFIC TASK PROMPT>";
      sections = DM_SYSTEM_SECTIONS.map((item) => item.id);
      break;
    case "setup": {
      const document = setupPromptDocument({ worldRules: WORLD_PROFILE_PLACEHOLDER, premise: "", character: "", language });
      prompt = document.text;
      sections = document.sections.map((item) => item.id);
      break;
    }
    case "adjudication": {
      const document = adjudicationPromptDocument(CONTEXT_PLACEHOLDER, ACTION_PLACEHOLDER);
      prompt = document.text;
      sections = document.sections.map((item) => item.id);
      break;
    }
    case "difficulty":
      system = "";
      prompt = `${CHECK_DIFFICULTY_POLICY.title}\n${CHECK_DIFFICULTY_POLICY.content}`;
      sections = [CHECK_DIFFICULTY_POLICY.id];
      break;
    case "resolution": {
      const document = resolutionPromptDocument(CONTEXT_PLACEHOLDER, ACTION_PLACEHOLDER, previewCheck());
      prompt = document.text;
      sections = document.sections.map((item) => item.id);
      break;
    }
    case "appeal": {
      const document = appealPromptDocument(CONTEXT_PLACEHOLDER, "<PLAYER APPEAL CLAIM>", 3);
      system = APPEAL_SYSTEM_PROMPT;
      prompt = document.text;
      sections = [
        ...APPEAL_SYSTEM_SECTIONS.map((item) => item.id),
        ...document.sections.map((item) => item.id),
      ];
      break;
    }
    case "schema-repair":
      prompt = structuredRepairPrompt("<ORIGINAL TASK PROMPT>", "<INVALID MODEL RESPONSE>", new Error("<PROTOCOL VALIDATION ERROR>"));
      sections = ["original-task", "structured-repair"];
      break;
    case "domain-correction":
      prompt = turnDomainCorrectionPrompt(
        "<ORIGINAL TASK PROMPT>",
        "<REJECTED STRUCTURED RESPONSE>",
        new Error("<APPLICATION VALIDATION ERROR>"),
      );
      sections = ["original-task", "domain-correction"];
      break;
    case "simulated-player":
      system = simulatedPlayerSystemPrompt({ id: "curious-explorer", instruction: "Explore unfamiliar places and follow discoveries." }, language);
      prompt = simulatedPlayerPrompt("<PLAYER-VISIBLE CONTEXT — no secrets>");
      sections = ["player-profile", "output-language", "player-visible-context", "next-action"];
      break;
    case "judge":
      system = judgeSystemPrompt(language);
      prompt = judgePrompt(JUDGE_PROFILE, "<PLAYER-FACING TRANSCRIPT>", [], "<STARTING DM STATE>", "<FINAL DM STATE>", EMPTY_TECHNICAL_HEALTH);
      sections = ["judge-policy", "current-state-reconciliation", "check-difficulty", "deterministic-metrics", "transcript", "mechanical-audit", "starting-state", "final-state"];
      break;
    case "connection-probe":
      system = CONNECTION_SYSTEM_PROMPT;
      prompt = `CAMPAIGN SETUP SCHEMA PROBE\n${connectionSetupPrompt(CONNECTION_SETUP_PROBE)}\n\nGAMEPLAY CONTRACT SCHEMA PROBE\n${CONNECTION_GAMEPLAY_PROMPT}`;
      sections = ["connection-system", "campaign-setup-schema-probe", "gameplay-schema-probe"];
      break;
  }

  return {
    phase,
    version: PROMPT_SUITE_VERSION,
    sections,
    system,
    prompt,
    containsLiveCampaignData: false,
  };
}
