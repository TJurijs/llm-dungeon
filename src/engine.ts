import {
  ResolvedTurnSchema,
  SetupResultSchema,
  TurnDecisionSchema,
  type ResolvedTurn,
  type SetupResult,
  type StateOperation,
} from "./schemas.js";
import {
  GAMEPLAY_PROTOCOL_VERSION,
  GAMEPLAY_SCHEMA_NAMES,
  decodeResolvedTurn,
  decodeTurnDecision,
  gameplayRequest,
} from "./llm/gameplay-protocol.js";
import { resolveCheck, secureRollD100, type RollD100 } from "./mechanics.js";
import {
  adjudicationPrompt,
  correctionPrompt,
  DM_SYSTEM_PROMPT,
  resolutionPrompt,
  setupCorrectionPrompt,
  setupPrompt,
} from "./prompts.js";
import { StateStore, validateInitialSetup } from "./store.js";
import { TransactionValidationError } from "./domain/transaction.js";
import { StructuredClient, combineUsage } from "./llm/structured-generation.js";
import type {
  CheckResult,
  CommittedTurn,
  GameEngine,
  LlmProvider,
  NewGameInput,
  SetupGenerationInput,
  StateView,
  StructuredResult,
  TurnResult,
} from "./types.js";
import type { PendingAction } from "./persistence/pending.js";

function lockedOutcomeStake(check: CheckResult): string {
  switch (check.outcome) {
    case "exceptional_success": return check.spec.exceptionalSuccessStakes;
    case "success": return check.spec.successStakes;
    case "failure": return check.spec.failureStakes;
    case "severe_failure": return check.spec.severeFailureStakes;
  }
}

class LockedOutcomeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LockedOutcomeError";
  }
}

/** Campaign status is part of the locked check and is applied by code, never inferred from narration. */
function enforceLockedCampaignOutcome(resolved: ResolvedTurn, check: CheckResult | undefined): ResolvedTurn {
  if (!check) return resolved;
  const endings = resolved.operations.filter((operation) => operation.type === "end_campaign");
  const failed = check.outcome === "failure" || check.outcome === "severe_failure";
  const desired = failed ? check.spec.failureCampaignStatus : "none";
  if (desired === "none") {
    if (endings.length) throw new LockedOutcomeError("The resolution cannot end the campaign because the locked check outcome is nonlethal");
    return resolved;
  }
  if (endings.some((operation) => operation.status !== desired)) {
    throw new LockedOutcomeError(`The resolution conflicts with the locked campaign status ${desired}`);
  }
  const operations: StateOperation[] = [
    ...resolved.operations.filter((operation) => operation.type !== "end_campaign"),
    { type: "end_campaign", status: desired, reason: lockedOutcomeStake(check) },
  ];
  return ResolvedTurnSchema.parse({ ...resolved, operations });
}

export class DungeonEngine implements GameEngine {
  private readonly structured: StructuredClient;

  constructor(
    private readonly store: StateStore,
    readonly provider: LlmProvider,
    private readonly rollD100: RollD100 = secureRollD100,
  ) {
    this.structured = new StructuredClient(provider);
  }

  async generateSetup(input: SetupGenerationInput): Promise<SetupResult> {
    const prompt = setupPrompt(input);
    const generated = await this.structured.generate({
      schemaName: "campaign_setup",
      schema: SetupResultSchema,
      system: DM_SYSTEM_PROMPT,
      prompt,
      temperature: 0.8,
      maxOutputTokens: 6000,
    });
    try {
      return validateInitialSetup(generated.data);
    } catch (error) {
      const corrected = await this.structured.generate({
        schemaName: "domain_repair_campaign_setup",
        schema: SetupResultSchema,
        system: DM_SYSTEM_PROMPT,
        prompt: setupCorrectionPrompt(prompt, generated.data, error),
        temperature: 0.4,
        maxOutputTokens: 6000,
      });
      return validateInitialSetup(corrected.data);
    }
  }

  hasCurrentGame() { return this.store.hasCurrentGame(); }
  createGame(input: NewGameInput) { return this.store.createGame(input); }
  replaceGame(input: NewGameInput) { return this.store.replaceGame(input); }
  async archiveAndReset(): Promise<void> { await this.store.archiveAndReset(); }
  inspect(view: StateView) { return this.store.withCampaignLock(() => this.store.inspect(view)); }
  recentTranscript(limit = 8) { return this.store.withCampaignLock(() => this.store.recentTranscript(limit)); }
  getPendingTurn() { return this.store.getPending(); }
  discardPendingTurn() { return this.store.discardPendingAction(); }

  async recoverPendingCommit(): Promise<boolean> {
    if ((await this.store.getPending())?.kind !== "commit") return false;
    await this.store.recoverCommit();
    return true;
  }

  async play(action: string): Promise<TurnResult> {
    return this.store.withCampaignLock(() => this.playLocked(action));
  }

  private async playLocked(action: string): Promise<TurnResult> {
    const cleanAction = action.trim();
    if (!cleanAction) throw new Error("Action cannot be empty");
    const campaign = await this.store.load();
    if (campaign.manifest.status !== "active") throw new Error("The campaign has ended");
    const pending = await this.store.getPending();
    if (pending) throw new Error("An uncommitted turn already exists; use :retry or discard it");
    await this.store.setPendingAction({
      kind: "action", action: cleanAction, phase: "requested",
    });
    return this.resumePendingTurn();
  }

  async resumePendingTurn(): Promise<TurnResult> {
    return this.store.withCampaignLock(() => this.resumePendingTurnLocked());
  }

  private async resumePendingTurnLocked(): Promise<TurnResult> {
    let pending = await this.store.getPending();
    if (!pending) throw new Error("There is no pending turn to retry");
    if (pending.kind === "commit") {
      await this.store.recoverCommit();
      throw new Error("The interrupted commit was recovered; the turn is already complete");
    }
    const context = await this.store.buildContext();

    if (pending.phase === "requested") {
      const prompt = adjudicationPrompt(context, pending.action);
      const decision = await this.structured.generate(gameplayRequest({
        schemaName: GAMEPLAY_SCHEMA_NAMES.decision,
        schema: TurnDecisionSchema,
        decodeResponse: decodeTurnDecision,
        system: DM_SYSTEM_PROMPT,
        prompt,
      }));
      if (decision.data.kind === "resolved") {
        return this.commitWithDomainRepair(pending, decision.data, undefined, decision, prompt);
      }

      const checkResult = resolveCheck(decision.data.check, this.rollD100());
      pending = {
        kind: "action",
        action: pending.action,
        phase: "rolled",
        checkResult,
        ...(decision.usage ? { priorUsage: decision.usage } : {}),
      };
      await this.store.setPendingAction(pending);
      return this.resolveAndCommit(context, pending, checkResult);
    }

    if (!pending.checkResult) throw new Error("Pending checked turn is missing its locked result");
    return this.resolveAndCommit(context, pending, pending.checkResult);
  }

  private async resolveAndCommit(
    context: string,
    pending: Extract<PendingAction, { phase: "rolled" }>,
    check: CheckResult,
  ): Promise<TurnResult> {
    const prompt = resolutionPrompt(context, pending.action, check);
    const resolution = await this.structured.generate(gameplayRequest({
      schemaName: GAMEPLAY_SCHEMA_NAMES.resolution,
      schema: ResolvedTurnSchema,
      decodeResponse: decodeResolvedTurn,
      system: DM_SYSTEM_PROMPT,
      prompt,
    }));
    const usage = combineUsage(pending.priorUsage, resolution.usage);
    const combined: StructuredResult<ResolvedTurn> = { ...resolution, ...(usage ? { usage } : {}) };
    return this.commitWithDomainRepair(pending, resolution.data, check, combined, prompt);
  }

  private async commitWithDomainRepair(
    pending: Pick<PendingAction, "action">,
    resolved: ResolvedTurn,
    check: CheckResult | undefined,
    result: StructuredResult<unknown>,
    originalPrompt: string,
  ): Promise<TurnResult> {
    try {
      return await this.commit(pending.action, enforceLockedCampaignOutcome(resolved, check), check, result);
    } catch (error) {
      if (!(error instanceof TransactionValidationError) && !(error instanceof LockedOutcomeError)) throw error;
      const currentPending = await this.store.getPending();
      if (currentPending?.kind === "commit") throw error;
      const corrected = await this.structured.generate(gameplayRequest({
        schemaName: GAMEPLAY_SCHEMA_NAMES.domainCorrection,
        schema: ResolvedTurnSchema,
        decodeResponse: decodeResolvedTurn,
        system: DM_SYSTEM_PROMPT,
        prompt: correctionPrompt(originalPrompt, resolved, error),
        temperature: 0.4,
      }));
      const usage = combineUsage(result.usage, corrected.usage);
      return this.commit(
        pending.action,
        enforceLockedCampaignOutcome(corrected.data, check),
        check,
        { ...corrected, ...(usage ? { usage } : {}) },
      );
    }
  }

  private async commit(
    action: string,
    resolved: ResolvedTurn,
    check: CheckResult | undefined,
    result: StructuredResult<unknown>,
  ): Promise<TurnResult> {
    const committed: CommittedTurn = {
      action,
      resolved,
      provider: result.provider,
      model: result.model,
      protocolVersion: GAMEPLAY_PROTOCOL_VERSION,
      ...(check ? { check } : {}),
      ...(result.usage ? { usage: result.usage } : {}),
    };
    const committedResult = await this.store.commitTurnWithResult(committed);
    const { state } = committedResult;
    return {
      turn: state.turn,
      narration: resolved.narration,
      summary: resolved.turnSummary,
      operations: committedResult.operations,
      ...(check ? { check } : {}),
      state,
    };
  }
}
