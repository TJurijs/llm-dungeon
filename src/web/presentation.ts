import { formatCheck } from "../mechanics.js";
import type { PendingTurn } from "../persistence/pending.js";
import type { SetupResult } from "../schemas.js";
import type { TurnResult } from "../types.js";

/** Deliberately omits prepared writes, action text, stakes, and raw operations. */
export function pendingStatus(pending: PendingTurn | undefined): unknown {
  if (!pending) return null;
  if (pending.kind === "commit") return { kind: "commit" };
  if (pending.kind === "appeal") {
    return {
      kind: "appeal",
      phase: pending.phase,
      ...(pending.targetTurn === undefined ? {} : { targetTurn: pending.targetTurn }),
    };
  }
  return {
    kind: "action",
    phase: pending.phase,
    lockedRoll: pending.phase === "rolled",
  };
}

/** Campaign draft projection safe to return before the user accepts it. */
export function setupPreview(setup: SetupResult): unknown {
  return {
    campaignTitle: setup.campaignTitle,
    scenarioMarkdown: setup.scenarioMarkdown,
    openingNarration: setup.openingNarration,
    player: {
      name: setup.player.name,
      description: setup.player.description,
      traits: setup.player.traits,
    },
  };
}

/** Committed-turn projection; alternate stakes and state operations stay server-side. */
export function playerTurnResponse(result: TurnResult): unknown {
  return {
    turn: result.turn,
    kind: result.kind,
    ...(result.appealTargetTurn === undefined ? {} : { appealTargetTurn: result.appealTargetTurn }),
    narration: result.narration,
    summary: result.summary,
    state: result.state,
    checkText: result.check ? formatCheck(result.check, result.state.language) : null,
  };
}
