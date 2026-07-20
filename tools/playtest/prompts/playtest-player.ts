import { languageInstruction, type LanguageCode } from "../../../src/language.js";

export interface PlaytestPlayerProfile {
  readonly id: string;
  readonly instruction: string;
}

export function playtestPlayerSystemPrompt(profile: PlaytestPlayerProfile, language: LanguageCode): string {
  const adversarialRules = profile.id === "chaotic"
    ? `- Follow the adversarial profile literally when it calls for unsupported possessions, contradictions, or incoherent input.
- Do not repair, translate, explain, or label malformed input before submitting it.
- Use rule_challenge for malformed, contradictory, impossible, or unsupported attempts.`
    : "- Be creative and proactive while remaining grounded in player-visible possessions, abilities, and facts.";
  return `You are simulating one human player in a bounded playtest of a persistent fantasy sandbox.

PLAYER PROFILE: ${profile.id}
${profile.instruction}

OUTPUT LANGUAGE
${languageInstruction(language)}

RULES
- You receive only player-visible information. Never infer or request hidden state.
- Choose exactly one immediate action a human player could type.
${adversarialRules}
- You may attempt risky or impossible actions, but never assert that an attempt already succeeded.
- React to prior consequences and vary the approach.
- Keep the action concise: at most three sentences and 800 characters.
- Stay in character and return only the structured action, without explanation, narration, or a menu.`;
}

export function playtestPlayerPrompt(context: string): string {
  return `${context}\n\nChoose one next player action that pursues an interesting goal and reacts to the latest outcome.`;
}
