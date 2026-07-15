import { section, type PromptSection } from "./render.js";

/**
 * Shared calibration for the model-selected check specification. This is a
 * prompt block, not a separate generation: code remains the sole dice and
 * outcome authority.
 */
export const CHECK_DIFFICULTY_POLICY: PromptSection = section(
  "check-difficulty",
  "CHECK DIFFICULTY POLICY",
  `First decide whether a check is warranted. Resolve an action directly when its outcome is already certain, unopposed, or impossible under authoritative state.

The application rolls d100 and adds all modifiers. A total at least equal to difficulty succeeds. A margin of at least +30 is exceptional success; a margin of -30 or lower is severe failure. Natural 1 is always severe failure and natural 100 is always exceptional success. You select the specification and locked stakes; the application alone rolls and resolves it.

When a check is warranted, choose the base difficulty for the established opposition or hazard before considering character-specific circumstances:
- 5 nearly certain despite genuine pressure (about 96% successful without modifiers)
- 20 favorable but meaningfully uncertain (about 81% success without modifiers)
- 35 advantageous challenge (about 66%)
- 50 evenly matched challenge (about 51%)
- 65 difficult challenge (about 36%)
- 80 formidable challenge (about 21%)
- 95 extraordinary, barely achievable challenge (about 6%)

Prefer these anchors. Use an intermediate integer only when the established fiction clearly lies between two anchors. Routine or fictionally certain actions still resolve without a check rather than using difficulty 5.

Modifiers represent circumstances specific to this actor and attempt, not the base opposition:
- ±5 minor influence
- ±10 meaningful influence
- ±15 major influence
- ±20 decisive influence
- ±30 extraordinary influence

Use zero to five concrete modifiers. Positive values help the player character; negative values hinder them. Apply a modifier only when that circumstance is directly relevant and actually brought to bear in this attempt; mere possession or unrelated background is not enough. Never count the same circumstance in both base difficulty and a modifier. Combined modifiers must remain between -50 and +50. Equivalent established circumstances should receive equivalent calibration.

Use only circumstances supported by current authoritative state. A newer status, condition, or fact that ends or contradicts an older reputation, advantage, or capability makes the older circumstance unavailable. After modifiers, if success depends only on the natural-100 override because no ordinary roll can reach the difficulty, treat the attempted outcome as impossible and resolve it without a check. Conversely, if every ordinary roll succeeds and only the natural-1 override can fail, resolve directly unless an established danger makes that exceptional mishap a meaningful stake; do not use a performative check for an already-certain agreement.

Scope every success and failure stake to what the established capability, evidence, and attempted method can actually achieve. A successful check cannot supply expertise, knowledge, access, or authority that the character and situation do not support.`,
);
