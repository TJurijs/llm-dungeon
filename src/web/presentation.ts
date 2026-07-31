import { formatAutomaticOutcome, formatCheck } from "../mechanics.js";
import type { PendingTurn } from "../persistence/pending.js";
import type { CompletedStoryArtifact, SetupResult } from "../schemas.js";
import type { QuestionResult, TurnResult } from "../types.js";
import type {
  BrowserPendingStatus,
  BrowserCompletedStoryResponse,
  BrowserPlayerTurnResponse,
  BrowserSetupPreview,
} from "./contracts.js";

/** Omits provider, model, usage, and persistence metadata from browser responses. */
export function completedStoryResponse(
  artifact: CompletedStoryArtifact | undefined,
): BrowserCompletedStoryResponse {
  if (!artifact) return { status: "missing" };
  return {
    status: "ready",
    story: artifact.story,
    generatedAt: artifact.generatedAt,
    sourceTurn: artifact.sourceTurn,
  };
}

/** Deliberately omits prepared writes, action text, stakes, and raw operations. */
export function pendingStatus(pending: PendingTurn | undefined): BrowserPendingStatus {
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
export function setupPreview(setup: SetupResult): BrowserSetupPreview {
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

/** Player-safe game response; alternate stakes and state operations stay server-side. */
export function playerTurnResponse(result: TurnResult | QuestionResult): BrowserPlayerTurnResponse {
  if (result.kind === "question") {
    return {
      kind: result.kind,
      answer: result.answer,
      ...(result.generation ? { generation: result.generation } : {}),
    };
  }
  return {
    turn: result.turn,
    kind: result.kind,
    ...(result.appealTargetTurn === undefined ? {} : { appealTargetTurn: result.appealTargetTurn }),
    narration: result.narration,
    summary: result.summary,
    state: result.state,
    checkText: result.check
      ? formatCheck(result.check, result.state.language)
      : result.automaticOutcome
        ? formatAutomaticOutcome(result.automaticOutcome, result.state.language)
        : null,
  };
}
