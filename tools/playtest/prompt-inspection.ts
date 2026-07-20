import { type LanguageCode } from "../../src/language.js";
import { resolveCheck } from "../../src/mechanics.js";
import {
  adjudicationPromptDocument,
  APPEAL_SYSTEM_PROMPT,
  APPEAL_SYSTEM_SECTIONS,
  appealPromptDocument,
  CHECK_DIFFICULTY_POLICY,
  DM_SYSTEM_PROMPT,
  DM_SYSTEM_SECTIONS,
  PROMPT_SUITE_VERSION,
  QUESTION_SYSTEM_PROMPT,
  QUESTION_SYSTEM_SECTIONS,
  questionPromptDocument,
  resolutionPromptDocument,
  setupPromptDocument,
  structuredRepairPrompt,
  turnDomainCorrectionPrompt,
} from "../../src/prompts.js";
import {
  CONNECTION_GAMEPLAY_PROMPT,
  CONNECTION_SETUP_PROBE,
  CONNECTION_SYSTEM_PROMPT,
  connectionSetupPrompt,
} from "../../src/prompts/connection.js";
import { playtestPlayerPrompt, playtestPlayerSystemPrompt } from "./prompts/playtest-player.js";
import { assessCoverage, buildMechanicalAudit } from "./harness/audit.js";
import { playtestJudgePrompt, playtestJudgeSystemPrompt } from "./harness/judge.js";
import { CERTIFICATION_PACKAGE } from "./harness/packages.js";

export const PROMPT_PHASES = [
  "dm-system",
  "setup",
  "adjudication",
  "difficulty",
  "resolution",
  "question",
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
  readonly sourceFiles: readonly string[];
  readonly sharedSystemSource?: string;
  readonly containsLiveCampaignData: false;
}

const PROMPT_SOURCE_FILES: Record<PromptPhase, readonly string[]> = {
  "dm-system": ["src/prompts/blocks.ts"],
  setup: ["src/prompts/setup.ts", "src/prompts/blocks.ts"],
  adjudication: ["src/prompts/gameplay.ts", "src/prompts/difficulty.ts", "src/prompts/blocks.ts"],
  difficulty: ["src/prompts/difficulty.ts"],
  resolution: ["src/prompts/gameplay.ts", "src/prompts/blocks.ts"],
  question: ["src/prompts/question.ts"],
  appeal: ["src/prompts/appeal.ts"],
  "schema-repair": ["src/prompts/recovery.ts"],
  "domain-correction": ["src/prompts/recovery.ts"],
  "simulated-player": ["src/prompts/playtest-player.ts"],
  judge: ["src/playtest/judge.ts"],
  "connection-probe": ["src/prompts/connection.ts"],
};

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
    case "question": {
      const document = questionPromptDocument(CONTEXT_PLACEHOLDER, "<PLAYER QUESTION>");
      system = QUESTION_SYSTEM_PROMPT;
      prompt = document.text;
      sections = [
        ...QUESTION_SYSTEM_SECTIONS.map((item) => item.id),
        ...document.sections.map((item) => item.id),
      ];
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
      system = playtestPlayerSystemPrompt({ id: "curious-explorer", instruction: "Explore unfamiliar places and follow discoveries." }, language);
      prompt = playtestPlayerPrompt("<PLAYER-VISIBLE CONTEXT — no secrets>");
      sections = ["player-profile", "output-language", "player-visible-context", "next-action"];
      break;
    case "judge":
      system = playtestJudgeSystemPrompt(language);
      prompt = playtestJudgePrompt({
        playtestPackage: CERTIFICATION_PACKAGE,
        language,
        transcript: "<PLAYER-FACING TRANSCRIPT>",
        turns: [],
        startingState: "<STARTING DM STATE>",
        finalState: "<FINAL DM STATE>",
        mechanicalAudit: buildMechanicalAudit([]),
        coverage: assessCoverage(CERTIFICATION_PACKAGE, []),
      });
      sections = ["judge-policy", "quality-rubric", "current-state-reconciliation", "check-difficulty", "deterministic-coverage", "transcript", "mechanical-audit", "starting-state", "final-state"];
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
    sourceFiles: PROMPT_SOURCE_FILES[phase],
    ...(["setup", "adjudication", "resolution"].includes(phase)
      ? { sharedSystemSource: "src/prompts/blocks.ts" }
      : {}),
    containsLiveCampaignData: false,
  };
}
