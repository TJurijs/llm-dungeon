import { randomUUID } from "node:crypto";
import {
  COMPLETED_STORY_SCHEMA_VERSION,
  CompletedStoryArtifactSchema,
  CompletedStoryOutputSchema,
  QuestionAnswerSchema,
  ResolvedTurnSchema,
  SetupResultSchema,
  TurnDecisionSchema,
  type AutomaticOutcome,
  type CompletedStoryArtifact,
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
  adjudicationPromptDocument,
  APPEAL_SYSTEM_PROMPT,
  appealPromptDocument,
  COMPLETED_STORY_SYSTEM_PROMPT,
  completedStoryPromptDocument,
  DM_SYSTEM_PROMPT,
  QUESTION_SYSTEM_PROMPT,
  questionPromptDocument,
  resolutionPromptDocument,
  setupDomainCorrectionPrompt,
  setupPromptDocument,
  TURN_RECOVERY_APPENDIX_TOKEN_LIMIT,
  turnDomainCorrectionPrompt,
} from "./prompts.js";
import {
  GAMEPLAY_CONTEXT_TOKEN_TARGET,
  StateStore,
  assertNewCampaignImmutableContextFits,
  assertNewCampaignOriginInputFits,
  validateInitialSetup,
} from "./store.js";
import { TransactionValidationError } from "./domain/transaction.js";
import { AppealPolicyError } from "./domain/appeal.js";
import type { DomainViolationCode } from "./domain/violations.js";
import { formatAppealCommand } from "./appeal.js";
import { StructuredClient, combineUsage } from "./llm/structured-generation.js";
import { structuredFailureDetails } from "./llm/structured-error.js";
import { createDomainRepairCause } from "./llm/domain-repair-cause.js";
import type {
  AppealInput,
  CheckResult,
  CommittedTurn,
  CompletedStoryGenerationOptions,
  DungeonEngineOptions,
  GameEngine,
  LlmProvider,
  NewGameInput,
  QuestionResult,
  SetupGenerationInput,
  StateView,
  StructuredOutputBudgetRequest,
  StructuredResult,
  TurnResult,
} from "./types.js";
import type { PendingRequest } from "./persistence/pending.js";
import { replyGeneration } from "./campaign-cost.js";
import {
  assertSetupGenerationInput,
  assertStructuredInputBudget,
  conservativeInputTokenEstimate,
  inputTokenLimitForOutputBudget,
  normalizePlayerAction,
  normalizePlayerQuestion,
  promptDocumentInputSections,
  resolveEffectiveOutputTokenBudget,
  type InputBudgetSection,
} from "./input-budget.js";
import { campaignStateRevision } from "./inspection.js";
import { assertSetupRequirements } from "./setup-requirements.js";
import {
  BudgetedProvider,
  currentSpendingOperation,
  runWithReservedSpendingOperation,
  runWithSpendingOperation,
} from "./spending.js";

type CommitRequest =
  { kind: "gameplay"; action: string } | { kind: "appeal"; action: string; targetTurn?: number };

interface PreparedPrompt {
  readonly prompt: string;
  readonly inputBudgetSections: readonly InputBudgetSection[];
}

interface PreparedAdjudication extends PreparedPrompt {
  readonly action: string;
  readonly context: string;
}

interface PreparedAppeal extends PreparedPrompt {
  readonly claim: string;
  readonly context: string;
  readonly targetTurn?: number;
}

const SETUP_MAX_OUTPUT_TOKENS = 8_000;
/** Bounded next step proven necessary by a Gemini response truncated at 3,982 tokens. */
const COMPLETED_STORY_MAX_OUTPUT_TOKENS = 8_000;
const COMPLETED_STORY_SCHEMA_NAME = "completed_campaign_story_v1";
/** Covers prompt separators plus conservative estimator composition differences. */
const GAMEPLAY_DECISION_INPUT_SAFETY_MARGIN = TURN_RECOVERY_APPENDIX_TOKEN_LIMIT + 2_000;

function gameplayDecisionContextTarget(provider: LlmProvider, action: string): number {
  const outputTokenReserve = resolveEffectiveOutputTokenBudget(provider, {
    generationPhase: "decision",
  });
  const inputLimit = inputTokenLimitForOutputBudget(outputTokenReserve);
  const emptyContextPrompt = adjudicationPromptDocument("", action).text;
  const fixedInputUnits = conservativeInputTokenEstimate(
    `${DM_SYSTEM_PROMPT}\n\n${emptyContextPrompt}`,
  );
  return Math.min(
    GAMEPLAY_CONTEXT_TOKEN_TARGET,
    Math.max(0, inputLimit - fixedInputUnits - GAMEPLAY_DECISION_INPUT_SAFETY_MARGIN),
  );
}

function preparePrompt(
  provider: LlmProvider,
  system: string,
  document: {
    readonly text: string;
    readonly sections: readonly {
      readonly id: string;
      readonly title?: string;
      readonly content: string;
    }[];
  },
  phase: string,
  outputBudgetRequest: StructuredOutputBudgetRequest,
  expandedSections: Parameters<typeof promptDocumentInputSections>[2] = {},
): PreparedPrompt {
  const inputBudgetSections = promptDocumentInputSections(system, document, expandedSections);
  assertStructuredInputBudget({
    phase,
    system,
    prompt: document.text,
    sections: inputBudgetSections,
    outputTokenReserve: resolveEffectiveOutputTokenBudget(provider, outputBudgetRequest),
  });
  return { prompt: document.text, inputBudgetSections };
}

/**
 * Generated setup must fit the immutable context slots before it leaves the
 * structured recovery boundary. Persisted setup parsing intentionally remains
 * lenient so legacy campaigns with larger records stay readable.
 */
function setupGenerationSchema(input: SetupGenerationInput) {
  return SetupResultSchema.superRefine((setup, context) => {
    try {
      assertNewCampaignImmutableContextFits({
        worldRules: input.worldRules,
        scenario: setup.scenarioMarkdown,
        premise: input.premise,
        character: input.character,
      });
    } catch (error) {
      context.addIssue({
        code: "custom",
        path: ["scenarioMarkdown"],
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });
}

function lockedOutcomeStake(check: CheckResult): string {
  switch (check.outcome) {
    case "exceptional_success":
      return check.spec.exceptionalSuccessStakes;
    case "success":
      return check.spec.successStakes;
    case "failure":
      return check.spec.failureStakes;
    case "severe_failure":
      return check.spec.severeFailureStakes;
  }
}

class LockedOutcomeError extends Error {
  /** Declared rules this resolution violated; repair telemetry redacts from them. */
  readonly violations: readonly { readonly code: DomainViolationCode; readonly message: string }[];

  constructor(code: DomainViolationCode, message: string) {
    super(message);
    this.name = "LockedOutcomeError";
    this.violations = [{ code, message }];
  }
}

/** Campaign status is part of the locked check and is applied by code, never inferred from narration. */
function enforceLockedResolution(
  resolved: ResolvedTurn,
  check: CheckResult | undefined,
): ResolvedTurn {
  if (!check) return resolved;
  if (resolved.turnSummary.trim().length >= resolved.narration.trim().length) {
    throw new LockedOutcomeError(
      "locked_resolution_summary_length",
      "Checked resolution narration must be more detailed than its summary and must narrate the complete locked outcome before summarizing it",
    );
  }
  const endings = resolved.operations.filter((operation) => operation.type === "end_campaign");
  const failed = check.outcome === "failure" || check.outcome === "severe_failure";
  const desired = failed ? check.spec.failureCampaignStatus : "none";
  if (desired === "none") {
    if (endings.length)
      throw new LockedOutcomeError(
        "locked_resolution_nonlethal_ending",
        "The resolution cannot end the campaign because the locked check outcome is nonlethal",
      );
    return resolved;
  }
  if (endings.some((operation) => operation.status !== desired)) {
    throw new LockedOutcomeError(
      "locked_resolution_status_conflict",
      `The resolution conflicts with the locked campaign status ${desired}`,
    );
  }
  const operations: StateOperation[] = [
    ...resolved.operations.filter((operation) => operation.type !== "end_campaign"),
    { type: "end_campaign", status: desired, reason: lockedOutcomeStake(check) },
  ];
  return ResolvedTurnSchema.parse({ ...resolved, operations });
}

export class DungeonEngine implements GameEngine {
  private readonly structured: StructuredClient;
  private readonly automaticCompletedStory: boolean;
  readonly provider: LlmProvider;

  constructor(
    private readonly store: StateStore,
    provider: LlmProvider,
    private readonly rollD100: RollD100 = secureRollD100,
    options: DungeonEngineOptions = {},
  ) {
    this.provider =
      provider instanceof BudgetedProvider
        ? provider
        : new BudgetedProvider(provider, store.spendingController());
    this.structured = new StructuredClient(this.provider);
    this.automaticCompletedStory = options.automaticCompletedStory ?? true;
  }

  async generateSetup(input: SetupGenerationInput): Promise<SetupResult> {
    return (await this.generateSetupWithMetadata(input)).setup;
  }

  async generateSetupWithMetadata(
    input: SetupGenerationInput,
  ): Promise<import("./types.js").GeneratedSetup> {
    return runWithSpendingOperation({ lane: "setup" }, async () => {
      assertSetupGenerationInput(input);
      // Reject immutable seed material that can never fit the campaign's bounded
      // durable-context slots before the first paid setup request is attempted.
      assertNewCampaignOriginInputFits(input);
      const generatedSetupSchema = setupGenerationSchema(input);
      const prepared = preparePrompt(
        this.provider,
        DM_SYSTEM_PROMPT,
        setupPromptDocument(input),
        "setup",
        { generationPhase: "setup", maxOutputTokens: SETUP_MAX_OUTPUT_TOKENS },
      );
      const prompt = prepared.prompt;
      const generated = await this.structured.generate({
        schemaName: "campaign_setup",
        schema: generatedSetupSchema,
        system: DM_SYSTEM_PROMPT,
        prompt,
        inputBudgetSections: prepared.inputBudgetSections,
        temperature: 0.8,
        maxOutputTokens: SETUP_MAX_OUTPUT_TOKENS,
        generationPhase: "setup",
      });
      try {
        return {
          setup: (() => {
            const setup = validateInitialSetup(generated.data);
            assertSetupRequirements(setup, input.setupRequirements);
            return setup;
          })(),
          generation: {
            provider: generated.provider,
            model: generated.model,
            ...(generated.usage ? { usage: generated.usage } : {}),
          },
        };
      } catch (error) {
        const corrected = await this.structured.generate({
          schemaName: "domain_repair_campaign_setup",
          schema: generatedSetupSchema,
          system: DM_SYSTEM_PROMPT,
          prompt: setupDomainCorrectionPrompt(prompt, generated.data, error),
          temperature: 0.4,
          maxOutputTokens: SETUP_MAX_OUTPUT_TOKENS,
          generationPhase: "repair",
          repairOfPhase: "setup",
          attemptKind: "domain_repair",
          domainRepairCause: createDomainRepairCause(error, {
            logicalOperationId: currentSpendingOperation()?.operationId ?? "unscoped",
            validationStage: "setup",
          }),
        });
        const usage = combineUsage(generated.usage, corrected.usage);
        return {
          setup: (() => {
            const setup = validateInitialSetup(corrected.data);
            assertSetupRequirements(setup, input.setupRequirements);
            return setup;
          })(),
          generation: {
            provider: corrected.provider,
            model: corrected.model,
            ...(usage ? { usage } : {}),
          },
        };
      }
    });
  }

  hasCurrentGame() {
    return this.store.hasCurrentGame();
  }
  createGame(input: NewGameInput) {
    return this.store.createGame(input);
  }
  replaceGame(input: NewGameInput) {
    return this.store.replaceGame(input);
  }
  async archiveAndReset(): Promise<void> {
    await this.store.archiveAndReset();
  }
  inspect(view: StateView) {
    return this.store.withCampaignLock(() => this.store.inspect(view));
  }
  recentTranscript(limit = 8) {
    return this.store.withCampaignLock(() => this.store.recentTranscript(limit));
  }
  campaignLogSnapshot() {
    return this.store.withCampaignLock(() => this.store.campaignLogSnapshot());
  }
  completedStory() {
    return this.store.completedStory();
  }
  generateCompletedStory(
    options: CompletedStoryGenerationOptions = {},
  ): Promise<CompletedStoryArtifact> {
    return this.store.withCampaignLock(() => this.generateCompletedStoryLocked(options));
  }

  private async generateCompletedStoryLocked(
    options: CompletedStoryGenerationOptions,
  ): Promise<CompletedStoryArtifact> {
    const campaign = await this.store.load();
    const existing = await this.store.completedStory();
    if (existing) return existing;
    if (await this.store.getPending()) {
      throw new Error("A completed story cannot be generated while a campaign request is pending");
    }
    if (campaign.manifest.status === "active" && options.settledSnapshot !== true) {
      throw new Error(
        "The campaign is still active; a finalized caller-owned snapshot requires settledSnapshot",
      );
    }

    const contextDocument = await this.store.buildCompletedStoryContextDocument();
    const prepared = preparePrompt(
      this.provider,
      COMPLETED_STORY_SYSTEM_PROMPT,
      completedStoryPromptDocument(contextDocument.text, campaign.manifest.language),
      "completed_story",
      {
        generationPhase: "decision",
        maxOutputTokens: COMPLETED_STORY_MAX_OUTPUT_TOKENS,
        outputTokenCeiling: COMPLETED_STORY_MAX_OUTPUT_TOKENS,
      },
      { "completed-story-context": contextDocument.sections },
    );
    const storyRequest = {
      schemaName: COMPLETED_STORY_SCHEMA_NAME,
      schema: CompletedStoryOutputSchema,
      system: COMPLETED_STORY_SYSTEM_PROMPT,
      prompt: prepared.prompt,
      inputBudgetSections: prepared.inputBudgetSections,
      temperature: 0.8,
      maxOutputTokens: COMPLETED_STORY_MAX_OUTPUT_TOKENS,
      outputTokenCeiling: COMPLETED_STORY_MAX_OUTPUT_TOKENS,
      generationPhase: "decision" as const,
    };
    const generationOptions = {
      maxRepairs: 0,
      maxContentRepairs: 0,
      maxTransientRetries: 0,
    } as const;
    const generated = await runWithSpendingOperation(
      {
        operationId: `story:${campaign.manifest.campaignId}:${campaignStateRevision(campaign.manifest)}`,
        lane: "story",
      },
      async () => {
        try {
          return await this.structured.generate(storyRequest, generationOptions);
        } catch (error) {
          const failed = structuredFailureDetails(error);
          if (failed?.attemptMetadata?.truncated !== true) throw error;

          // A proven output-limit failure gets one fresh attempt. Reuse the
          // original request rather than exposing or appending partial output.
          const retried = await this.structured.generate(storyRequest, generationOptions);
          const usage = combineUsage(failed.usage, retried.usage);
          return { ...retried, ...(usage ? { usage } : {}) };
        }
      },
    );
    const output = CompletedStoryOutputSchema.parse(generated.data);
    return this.store.saveCompletedStory(
      CompletedStoryArtifactSchema.parse({
        schemaVersion: COMPLETED_STORY_SCHEMA_VERSION,
        campaignId: campaign.manifest.campaignId,
        sourceRevision: campaignStateRevision(campaign.manifest),
        sourceTurn: campaign.manifest.turn,
        campaignStatus: campaign.manifest.status,
        provider: generated.provider,
        model: generated.model,
        generatedAt: new Date().toISOString(),
        ...(generated.usage ? { usage: generated.usage } : {}),
        story: output.story,
      }),
    );
  }

  private async generateTerminalStoryBestEffortLocked(): Promise<void> {
    if (!this.automaticCompletedStory) return;
    try {
      const campaign = await this.store.load();
      if (campaign.manifest.status !== "active") {
        await this.generateCompletedStoryLocked({});
      }
    } catch {
      // Gameplay has already committed. Artifact generation is independently retryable.
    }
  }
  getPendingTurn() {
    return this.store.getPending();
  }
  discardPendingTurn() {
    return this.store.discardPendingRequest();
  }

  async recoverPendingCommit(): Promise<boolean> {
    return this.store.withCampaignLock(async () => {
      if ((await this.store.getPending())?.kind !== "commit") return false;
      await this.store.recoverCommit();
      await this.generateTerminalStoryBestEffortLocked();
      return true;
    });
  }

  async play(action: string): Promise<TurnResult> {
    return this.store.withCampaignLock(() => this.playLocked(action));
  }

  async ask(question: string): Promise<QuestionResult> {
    return this.store.withCampaignLock(() =>
      runWithSpendingOperation({ lane: "question" }, async () => {
        const cleanQuestion = normalizePlayerQuestion(question);
        await this.store.load();
        if (await this.store.getPending()) {
          throw new Error("Resolve or discard the pending turn before asking a question");
        }
        const contextDocument = await this.store.buildContextDocument(cleanQuestion);
        const context = contextDocument.text;
        const prepared = preparePrompt(
          this.provider,
          QUESTION_SYSTEM_PROMPT,
          questionPromptDocument(context, cleanQuestion),
          "question",
          { maxOutputTokens: 2_000 },
          { "question-context": contextDocument.sections },
        );
        const result = await this.structured.generate({
          schemaName: "campaign_question",
          schema: QuestionAnswerSchema,
          system: QUESTION_SYSTEM_PROMPT,
          prompt: prepared.prompt,
          inputBudgetSections: prepared.inputBudgetSections,
          temperature: 0.2,
          maxOutputTokens: 2_000,
        });
        return {
          kind: "question" as const,
          answer: result.data.answer,
          generation: replyGeneration({
            provider: result.provider,
            model: result.model,
            ...(result.usage ? { usage: result.usage } : {}),
          }),
        };
      }),
    );
  }

  private async playLocked(action: string): Promise<TurnResult> {
    const cleanAction = normalizePlayerAction(action);
    const campaign = await this.store.load();
    if (campaign.manifest.status !== "active") throw new Error("The campaign has ended");
    const pending = await this.store.getPending();
    if (pending) throw new Error("An uncommitted turn already exists; use :retry or discard it");
    const contextDocument = await this.store.buildContextDocument(
      cleanAction,
      gameplayDecisionContextTarget(this.provider, cleanAction),
    );
    const context = contextDocument.text;
    const preparedPrompt = preparePrompt(
      this.provider,
      DM_SYSTEM_PROMPT,
      adjudicationPromptDocument(context, cleanAction),
      "decision",
      { generationPhase: "decision" },
      { "campaign-context": contextDocument.sections },
    );
    const prepared: PreparedAdjudication = {
      action: cleanAction,
      context,
      ...preparedPrompt,
    };
    await this.store.setPendingRequest({
      kind: "action",
      action: cleanAction,
      operationId: randomUUID(),
      phase: "requested",
    });
    return this.resumePendingTurnLocked(prepared);
  }

  async appeal(input: AppealInput): Promise<TurnResult> {
    return this.store.withCampaignLock(() => this.appealLocked(input));
  }

  private async appealLocked(input: AppealInput): Promise<TurnResult> {
    formatAppealCommand(input);
    const claim = input.claim.trim();
    const campaign = await this.store.load();
    if (campaign.manifest.status !== "active") throw new Error("The campaign has ended");
    if (input.targetTurn !== undefined && input.targetTurn > campaign.manifest.turn) {
      throw new Error(`Appeal target turn must be between 1 and ${campaign.manifest.turn}`);
    }
    if (await this.store.getPending()) {
      throw new Error("An uncommitted turn already exists; use :retry or discard it");
    }
    const contextDocument = await this.store.buildAppealContextDocument(input.targetTurn, claim);
    const context = contextDocument.text;
    const preparedPrompt = preparePrompt(
      this.provider,
      APPEAL_SYSTEM_PROMPT,
      appealPromptDocument(context, claim, input.targetTurn),
      "locked_resolution",
      { generationPhase: "locked_resolution" },
      { "appeal-context": contextDocument.sections },
    );
    const prepared: PreparedAppeal = {
      claim,
      context,
      ...(input.targetTurn === undefined ? {} : { targetTurn: input.targetTurn }),
      ...preparedPrompt,
    };
    await this.store.setPendingRequest({
      kind: "appeal",
      claim,
      operationId: randomUUID(),
      ...(input.targetTurn === undefined ? {} : { targetTurn: input.targetTurn }),
      phase: "requested",
    });
    return this.resumePendingTurnLocked(undefined, prepared);
  }

  async resumePendingTurn(): Promise<TurnResult> {
    return this.store.withCampaignLock(() => this.resumePendingTurnLocked());
  }

  private async resumePendingTurnLocked(
    preparedAdjudication?: PreparedAdjudication,
    preparedAppeal?: PreparedAppeal,
  ): Promise<TurnResult> {
    let pending = await this.store.getPending();
    if (!pending) throw new Error("There is no pending turn to retry");
    if (pending.kind === "commit") {
      await this.store.recoverCommit();
      await this.generateTerminalStoryBestEffortLocked();
      throw new Error("The interrupted commit was recovered; the turn is already complete");
    }
    const operationId = pending.operationId ?? randomUUID();
    if (pending.operationId === undefined) {
      pending = { ...pending, operationId };
      await this.store.setPendingRequest(pending);
    }
    if (currentSpendingOperation()?.operationId !== operationId) {
      const result = await runWithReservedSpendingOperation(
        this.store.spendingController(),
        { operationId, lane: pending.kind === "appeal" ? "appeal" : "gameplay" },
        () => this.resumePendingTurnLocked(preparedAdjudication, preparedAppeal),
      );
      // The terminal story is a separate, retryable artifact call. Wait until
      // the gameplay envelope has released its unused reservation so a tight
      // campaign cap evaluates the story against actual turn spend.
      if (result.state.status !== "active") await this.generateTerminalStoryBestEffortLocked();
      return result;
    }
    if (pending.kind === "appeal") return this.resolveAppeal(pending, preparedAppeal);
    const preparedMatches =
      preparedAdjudication !== undefined && preparedAdjudication.action === pending.action;
    const contextDocument = preparedMatches
      ? undefined
      : await this.store.buildContextDocument(
          pending.action,
          gameplayDecisionContextTarget(this.provider, pending.action),
        );
    const context = preparedMatches ? preparedAdjudication.context : contextDocument!.text;

    if (pending.phase === "requested") {
      const prepared = preparedMatches
        ? preparedAdjudication!
        : {
            action: pending.action,
            context,
            ...preparePrompt(
              this.provider,
              DM_SYSTEM_PROMPT,
              adjudicationPromptDocument(context, pending.action),
              "decision",
              { generationPhase: "decision" },
              { "campaign-context": contextDocument!.sections },
            ),
          };
      const prompt = prepared.prompt;
      const decision = await this.structured.generate(
        gameplayRequest({
          schemaName: GAMEPLAY_SCHEMA_NAMES.decision,
          schema: TurnDecisionSchema,
          decodeResponse: decodeTurnDecision,
          system: DM_SYSTEM_PROMPT,
          prompt,
          inputBudgetSections: prepared.inputBudgetSections,
          generationPhase: "decision",
        }),
      );
      if (decision.data.kind !== "check_required") {
        const automaticOutcome: AutomaticOutcome | undefined =
          decision.data.kind === "resolved"
            ? undefined
            : {
                outcome: decision.data.kind === "automatic_success" ? "success" : "failure",
                reason: decision.data.reason,
              };
        return this.commitWithDomainRepair(
          { kind: "gameplay", action: pending.action },
          ResolvedTurnSchema.parse(decision.data),
          undefined,
          decision,
          prompt,
          automaticOutcome,
        );
      }

      const checkResult = resolveCheck(decision.data.check, this.rollD100());
      pending = {
        kind: "action",
        action: pending.action,
        operationId,
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
    const prepared = preparePrompt(
      this.provider,
      DM_SYSTEM_PROMPT,
      resolutionPromptDocument(context, pending.action, check),
      "locked_resolution",
      { generationPhase: "locked_resolution" },
    );
    const prompt = prepared.prompt;
    const resolution = await this.structured.generate(
      resolvedGameplayRequest({
        schemaName: GAMEPLAY_SCHEMA_NAMES.resolution,
        schema: ResolvedTurnSchema,
        decodeResponse: decodeResolvedTurn,
        system: DM_SYSTEM_PROMPT,
        prompt,
        inputBudgetSections: prepared.inputBudgetSections,
        generationPhase: "locked_resolution",
      }),
    );
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
    preparedAppeal?: PreparedAppeal,
  ): Promise<TurnResult> {
    const preparedMatches =
      preparedAppeal !== undefined &&
      preparedAppeal.claim === pending.claim &&
      preparedAppeal.targetTurn === pending.targetTurn;
    const contextDocument = preparedMatches
      ? undefined
      : await this.store.buildAppealContextDocument(pending.targetTurn, pending.claim);
    const context = preparedMatches ? preparedAppeal.context : contextDocument!.text;
    const prepared = preparedMatches
      ? preparedAppeal!
      : {
          claim: pending.claim,
          context,
          ...(pending.targetTurn === undefined ? {} : { targetTurn: pending.targetTurn }),
          ...preparePrompt(
            this.provider,
            APPEAL_SYSTEM_PROMPT,
            appealPromptDocument(context, pending.claim, pending.targetTurn),
            "locked_resolution",
            { generationPhase: "locked_resolution" },
            { "appeal-context": contextDocument!.sections },
          ),
        };
    const prompt = prepared.prompt;
    const resolution = await this.structured.generate(
      resolvedGameplayRequest({
        schemaName: GAMEPLAY_SCHEMA_NAMES.appealResolution,
        schema: ResolvedTurnSchema,
        decodeResponse: decodeResolvedTurn,
        system: APPEAL_SYSTEM_PROMPT,
        prompt,
        inputBudgetSections: prepared.inputBudgetSections,
        temperature: 0.2,
        generationPhase: "locked_resolution",
      }),
    );
    return this.commitWithDomainRepair(
      {
        kind: "appeal",
        action: formatAppealCommand(
          pending.targetTurn === undefined
            ? { claim: pending.claim }
            : { claim: pending.claim, targetTurn: pending.targetTurn },
        ),
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
    automaticOutcome?: AutomaticOutcome,
  ): Promise<TurnResult> {
    try {
      const enforced =
        request.kind === "gameplay" ? enforceLockedResolution(resolved, check) : resolved;
      return await this.commit(request, enforced, check, result, automaticOutcome);
    } catch (error) {
      if (
        !(error instanceof TransactionValidationError) &&
        !(error instanceof LockedOutcomeError) &&
        !(error instanceof AppealPolicyError)
      )
        throw error;
      const currentPending = await this.store.getPending();
      if (currentPending?.kind === "commit") throw error;
      const authoritativeThreadIds = (await this.store.load()).threads
        .map((thread) => thread.id)
        .sort();
      const corrected = await this.structured.generate(
        resolvedGameplayRequest({
          schemaName:
            request.kind === "appeal"
              ? GAMEPLAY_SCHEMA_NAMES.appealDomainCorrection
              : GAMEPLAY_SCHEMA_NAMES.domainCorrection,
          schema: ResolvedTurnSchema,
          decodeResponse: decodeResolvedTurn,
          system: request.kind === "appeal" ? APPEAL_SYSTEM_PROMPT : DM_SYSTEM_PROMPT,
          prompt: turnDomainCorrectionPrompt(
            originalPrompt,
            resolved,
            error,
            authoritativeThreadIds,
          ),
          temperature: 0.4,
          generationPhase: "repair",
          repairOfPhase:
            request.kind === "appeal" || check !== undefined ? "locked_resolution" : "decision",
          attemptKind: "domain_repair",
          domainRepairCause: createDomainRepairCause(error, {
            logicalOperationId: currentSpendingOperation()?.operationId ?? "unscoped",
            validationStage: "turn_commit",
          }),
        }),
      );
      const usage = combineUsage(result.usage, corrected.usage);
      const enforced =
        request.kind === "gameplay"
          ? enforceLockedResolution(corrected.data, check)
          : corrected.data;
      return this.commit(
        request,
        enforced,
        check,
        { ...corrected, ...(usage ? { usage } : {}) },
        automaticOutcome,
      );
    }
  }

  private async commit(
    request: CommitRequest,
    resolved: ResolvedTurn,
    check: CheckResult | undefined,
    result: StructuredResult<unknown>,
    automaticOutcome?: AutomaticOutcome,
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
      ...(automaticOutcome ? { automaticOutcome } : {}),
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
      ...(automaticOutcome ? { automaticOutcome } : {}),
      ...(committedResult.domainSignals.length
        ? { domainSignals: committedResult.domainSignals }
        : {}),
      state,
    };
  }
}
