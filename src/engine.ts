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
  resolvedGameplayRequest,
} from "./llm/gameplay-protocol.js";
import { resolveCheck, secureRollD100, type RollD100 } from "./mechanics.js";
import {
  adjudicationPrompt,
  APPEAL_SYSTEM_PROMPT,
  appealPrompt,
  DM_SYSTEM_PROMPT,
  resolutionPrompt,
  setupDomainCorrectionPrompt,
  setupPrompt,
  turnDomainCorrectionPrompt,
} from "./prompts.js";
import { StateStore, validateInitialSetup } from "./store.js";
import { TransactionValidationError } from "./domain/transaction.js";
import { AppealPolicyError } from "./domain/appeal.js";
import { formatAppealCommand } from "./appeal.js";
import { StructuredClient, combineUsage } from "./llm/structured-generation.js";
import type {
  AppealInput,
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
import type { PendingRequest } from "./persistence/pending.js";

type CommitRequest =
  | { kind: "gameplay"; action: string }
  | { kind: "appeal"; action: string; targetTurn?: number };

const SETUP_MAX_OUTPUT_TOKENS = 8_000;

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
      maxOutputTokens: SETUP_MAX_OUTPUT_TOKENS,
    });
    try {
      return validateInitialSetup(generated.data);
    } catch (error) {
      const corrected = await this.structured.generate({
        schemaName: "domain_repair_campaign_setup",
        schema: SetupResultSchema,
        system: DM_SYSTEM_PROMPT,
        prompt: setupDomainCorrectionPrompt(prompt, generated.data, error),
        temperature: 0.4,
        maxOutputTokens: SETUP_MAX_OUTPUT_TOKENS,
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
  discardPendingTurn() { return this.store.discardPendingRequest(); }

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
    await this.store.setPendingRequest({
      kind: "action", action: cleanAction, phase: "requested",
    });
    return this.resumePendingTurnLocked();
  }

  async appeal(input: AppealInput): Promise<TurnResult> {
    return this.store.withCampaignLock(() => this.appealLocked(input));
  }

  private async appealLocked(input: AppealInput): Promise<TurnResult> {
    formatAppealCommand(input);
    const campaign = await this.store.load();
    if (campaign.manifest.status !== "active") throw new Error("The campaign has ended");
    if (input.targetTurn !== undefined && input.targetTurn > campaign.manifest.turn) {
      throw new Error(`Appeal target turn must be between 1 and ${campaign.manifest.turn}`);
    }
    if (await this.store.getPending()) {
      throw new Error("An uncommitted turn already exists; use :retry or discard it");
    }
    await this.store.setPendingRequest({
      kind: "appeal",
      claim: input.claim.trim(),
      ...(input.targetTurn === undefined ? {} : { targetTurn: input.targetTurn }),
      phase: "requested",
    });
    return this.resumePendingTurnLocked();
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
    if (pending.kind === "appeal") return this.resolveAppeal(pending);
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
        return this.commitWithDomainRepair(
          { kind: "gameplay", action: pending.action },
          decision.data,
          undefined,
          decision,
          prompt,
        );
      }

      const checkResult = resolveCheck(decision.data.check, this.rollD100());
      pending = {
        kind: "action",
        action: pending.action,
        phase: "rolled",
        checkResult,
        ...(decision.usage ? { priorUsage: decision.usage } : {}),
      };
      await this.store.setPendingRequest(pending);
      return this.resolveAndCommit(context, pending, checkResult);
    }

    if (!pending.checkResult) throw new Error("Pending checked turn is missing its locked result");
    return this.resolveAndCommit(context, pending, pending.checkResult);
  }

  private async resolveAndCommit(
    context: string,
    pending: Extract<PendingRequest, { kind: "action"; phase: "rolled" }>,
    check: CheckResult,
  ): Promise<TurnResult> {
    const prompt = resolutionPrompt(context, pending.action, check);
    const resolution = await this.structured.generate(resolvedGameplayRequest({
      schemaName: GAMEPLAY_SCHEMA_NAMES.resolution,
      schema: ResolvedTurnSchema,
      decodeResponse: decodeResolvedTurn,
      system: DM_SYSTEM_PROMPT,
      prompt,
    }));
    const usage = combineUsage(pending.priorUsage, resolution.usage);
    const combined: StructuredResult<ResolvedTurn> = { ...resolution, ...(usage ? { usage } : {}) };
    return this.commitWithDomainRepair(
      { kind: "gameplay", action: pending.action },
      resolution.data,
      check,
      combined,
      prompt,
    );
  }

  private async resolveAppeal(
    pending: Extract<PendingRequest, { kind: "appeal" }>,
  ): Promise<TurnResult> {
    const context = await this.store.buildAppealContext(pending.targetTurn);
    const prompt = appealPrompt(context, pending.claim, pending.targetTurn);
    const resolution = await this.structured.generate(resolvedGameplayRequest({
      schemaName: GAMEPLAY_SCHEMA_NAMES.appealResolution,
      schema: ResolvedTurnSchema,
      decodeResponse: decodeResolvedTurn,
      system: APPEAL_SYSTEM_PROMPT,
      prompt,
      temperature: 0.2,
    }));
    return this.commitWithDomainRepair(
      {
        kind: "appeal",
        action: formatAppealCommand(pending.targetTurn === undefined
          ? { claim: pending.claim }
          : { claim: pending.claim, targetTurn: pending.targetTurn }),
        ...(pending.targetTurn === undefined ? {} : { targetTurn: pending.targetTurn }),
      },
      resolution.data,
      undefined,
      resolution,
      prompt,
    );
  }

  private async commitWithDomainRepair(
    request: CommitRequest,
    resolved: ResolvedTurn,
    check: CheckResult | undefined,
    result: StructuredResult<unknown>,
    originalPrompt: string,
  ): Promise<TurnResult> {
    try {
      const enforced = request.kind === "gameplay"
        ? enforceLockedCampaignOutcome(resolved, check)
        : resolved;
      return await this.commit(request, enforced, check, result);
    } catch (error) {
      if (!(error instanceof TransactionValidationError)
        && !(error instanceof LockedOutcomeError)
        && !(error instanceof AppealPolicyError)) throw error;
      const currentPending = await this.store.getPending();
      if (currentPending?.kind === "commit") throw error;
      const corrected = await this.structured.generate(resolvedGameplayRequest({
        schemaName: request.kind === "appeal"
          ? GAMEPLAY_SCHEMA_NAMES.appealDomainCorrection
          : GAMEPLAY_SCHEMA_NAMES.domainCorrection,
        schema: ResolvedTurnSchema,
        decodeResponse: decodeResolvedTurn,
        system: request.kind === "appeal" ? APPEAL_SYSTEM_PROMPT : DM_SYSTEM_PROMPT,
        prompt: turnDomainCorrectionPrompt(originalPrompt, resolved, error),
        temperature: 0.4,
      }));
      const usage = combineUsage(result.usage, corrected.usage);
      const enforced = request.kind === "gameplay"
        ? enforceLockedCampaignOutcome(corrected.data, check)
        : corrected.data;
      return this.commit(
        request,
        enforced,
        check,
        { ...corrected, ...(usage ? { usage } : {}) },
      );
    }
  }

  private async commit(
    request: CommitRequest,
    resolved: ResolvedTurn,
    check: CheckResult | undefined,
    result: StructuredResult<unknown>,
  ): Promise<TurnResult> {
    const committed: CommittedTurn = {
      kind: request.kind,
      action: request.action,
      ...(request.kind === "appeal" && request.targetTurn !== undefined
        ? { appealTargetTurn: request.targetTurn }
        : {}),
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
      kind: request.kind,
      ...(request.kind === "appeal" && request.targetTurn !== undefined
        ? { appealTargetTurn: request.targetTurn }
        : {}),
      narration: resolved.narration,
      summary: resolved.turnSummary,
      operations: committedResult.operations,
      ...(check ? { check } : {}),
      state,
    };
  }
}
