import type { z } from "zod";
import type {
  AutomaticOutcome,
  CompletedStoryArtifact,
  GameState,
  ResolvedTurn,
  SetupResult,
  StateOperation,
} from "./schemas.js";
import type { LanguageCode } from "./language.js";
import type { SetupRequirements } from "./setup-requirements.js";
import type { CheckResult } from "./mechanics.js";
import type { PendingTurn } from "./persistence/pending.js";
import type { Usage } from "./usage.js";
import type {
  ModelGenerationPhase,
  OutputTokenField,
  SchemaProjectionId,
} from "./model-execution-profile.js";
import type { InputBudgetSection } from "./input-budget.js";
import type { DomainRepairCause } from "./llm/domain-repair-cause.js";

export type { CheckResult } from "./mechanics.js";

export interface StructuredRequest<T> {
  schemaName: string;
  schema: z.ZodType<T>;
  /** Exact provider-facing wire validator when the transport differs from T. */
  wireSchema?: z.ZodType<unknown>;
  /** Hand-authored provider JSON Schema; never dynamically weakened. */
  jsonSchema?: Record<string, unknown>;
  /** Deterministic wire-to-domain codec, run before authoritative validation. */
  decodeResponse?: (value: unknown) => T;
  protocolVersion?: number;
  system: string;
  prompt: string;
  /** Optional application-owned cancellation for this physical provider request. */
  signal?: AbortSignal;
  temperature?: number;
  maxOutputTokens?: number;
  /** Optional application-owned ceiling below a calibrated phase budget. */
  outputTokenCeiling?: number;
  /** Semantic phase used by a frozen model execution profile. */
  generationPhase?: ModelGenerationPhase;
  /** The phase whose failed output is being repaired. */
  repairOfPhase?: Exclude<ModelGenerationPhase, "repair">;
  /** Physical attempt kind; retries retain the semantic generation phase. */
  attemptKind?: StructuredAttemptKind;
  /** Secret-safe application explanation for a local domain-correction attempt. */
  domainRepairCause?: DomainRepairCause;
  /** Time spent in bounded retry backoff before this physical attempt. */
  retryBackoffMs?: number;
  /** Optional named diagnostics for application-owned input-budget failures. */
  inputBudgetSections?: readonly InputBudgetSection[];
}

export type StructuredAttemptKind =
  "initial" | "schema_repair" | "content_repair" | "transient_retry" | "domain_repair";

export interface ProviderAttemptMetadata {
  provider: string;
  model: string;
  route: string;
  generationPhase?: ModelGenerationPhase;
  attemptKind: StructuredAttemptKind;
  profileFingerprint?: string;
  structuredMode: NonNullable<StructuredResult<unknown>["structuredMode"]>;
  schemaProjection: SchemaProjectionId;
  outputTokenField: OutputTokenField;
  outputTokenBudget: number;
  timeoutMs?: number;
  retryBackoffMs: number;
  finishReason?: string;
  truncated: boolean;
}

export interface ProviderRequestDiagnostics {
  /** UTC time when the provider request was initiated. */
  timestamp: string;
  provider: string;
  model: string;
  /** Locally generated correlation ID; sent to OpenAI as X-Client-Request-Id. */
  clientRequestId: string;
  /** Provider-generated correlation ID from the allowlisted response header. */
  requestId?: string;
  httpStatus?: number;
  /** Only documented rate-limit headers are retained; all other headers are discarded. */
  rateLimitHeaders?: Record<string, string>;
}

export interface StructuredResult<T> {
  data: T;
  provider: string;
  model: string;
  rawText?: string;
  structuredMode?: "exact_schema" | "json_object_local_schema";
  protocolVersion?: number;
  usage?: Usage;
  requestDiagnostics?: ProviderRequestDiagnostics;
  attemptMetadata?: ProviderAttemptMetadata;
}

export type StructuredOutputBudgetRequest = Pick<
  StructuredRequest<unknown>,
  "maxOutputTokens" | "outputTokenCeiling" | "generationPhase" | "repairOfPhase"
>;

export interface LlmProvider {
  readonly id: string;
  readonly model: string;
  /** Exact provider/profile output allowance used to keep input within the shared context window. */
  effectiveOutputTokenBudget?(request: StructuredOutputBudgetRequest): number;
  generateStructured<T>(request: StructuredRequest<T>): Promise<StructuredResult<T>>;
}

export interface NewGameInput {
  setup: SetupResult;
  worldRules: string;
  language?: LanguageCode;
  openingGeneration?: GenerationMetadata;
  setupInput?: CampaignSetupInput;
}

export interface CampaignSetupInput {
  premise: string;
  character: string;
}

export interface CampaignStartSettings extends CampaignSetupInput {
  language: LanguageCode;
  worldRules: string;
}

export interface GenerationMetadata {
  provider: string;
  model: string;
  usage?: Usage;
}

export interface GeneratedSetup {
  setup: SetupResult;
  generation: GenerationMetadata;
}

export interface SetupGenerationInput {
  worldRules: string;
  premise: string;
  character: string;
  language?: LanguageCode;
  /** Optional application-owned structural admission rules for a shipped seed. */
  setupRequirements?: SetupRequirements;
}

export type StateView = "character" | "location" | "threads";

export type TurnKind = "opening" | "gameplay" | "appeal";

export interface AppealInput {
  claim: string;
  targetTurn?: number;
}

export interface InspectionFacts {
  established: string[];
  knowledge: string[];
  history: string[];
}

export interface InspectionInventoryItem {
  name: string;
  quantity: number;
  status: string;
  description: string;
}

export interface CharacterInspection {
  view: "character";
  language: LanguageCode;
  name: string;
  description: string;
  status: string;
  traits: string[];
  conditions: string[];
  inventory: InspectionInventoryItem[];
  facts: InspectionFacts;
  relationships: Array<{ name: string; summary: string }>;
}

export interface LocationInspection {
  view: "location";
  language: LanguageCode;
  name: string;
  description: string;
  status: string;
  features: string[];
  conditions: string[];
  facts: InspectionFacts;
}

export interface ThreadsInspection {
  view: "threads";
  language: LanguageCode;
  threads: Array<{
    title: string;
    summary: string;
    status: "active" | "resolved" | "failed";
  }>;
}

export type PlayerStateInspection = CharacterInspection | LocationInspection | ThreadsInspection;

export interface CampaignStateSnapshot {
  revision: string;
  character: CharacterInspection;
  location: LocationInspection;
  threads: ThreadsInspection;
}

export interface CampaignStateSnapshotRead {
  revision: string;
  state?: CampaignStateSnapshot;
}

export interface TurnResult {
  turn: number;
  kind: Exclude<TurnKind, "opening">;
  appealTargetTurn?: number;
  narration: string;
  summary: string;
  operations: StateOperation[];
  check?: CheckResult;
  automaticOutcome?: AutomaticOutcome;
  /**
   * Review-only domain rules the committed turn tripped. Kept on the result so
   * a judgment-quality rule can be measured across a run without ever costing
   * a turn its single bounded correction.
   */
  domainSignals?: readonly { readonly code: string; readonly message: string }[];
  state: GameState;
}

export interface QuestionResult {
  kind: "question";
  answer: string;
  generation?: ReplyGeneration;
}

export interface ReplyGeneration {
  provider: string;
  model: string;
  costUsd?: number;
  costBasis?: "exact" | "estimated";
}

export interface PlayerVisibleTurn {
  turn: number;
  kind: TurnKind;
  appealTargetTurn?: number;
  action: string;
  narration: string;
  summary: string;
  checkText?: string;
  generation?: ReplyGeneration;
}

export interface CampaignLogSnapshot {
  state: GameState;
  playerName: string;
  setup?: CampaignStartSettings;
  turns: PlayerVisibleTurn[];
  completedStory?: CompletedStoryArtifact;
}

export interface CompletedStoryGenerationOptions {
  /** Permit a caller-owned finalized snapshot whose gameplay status is still active. */
  settledSnapshot?: boolean;
}

export interface DungeonEngineOptions {
  /** Disable only the best-effort post-terminal call; explicit generation remains available. */
  automaticCompletedStory?: boolean;
}

export interface GameEngine {
  generateSetup(input: SetupGenerationInput): Promise<SetupResult>;
  generateSetupWithMetadata(input: SetupGenerationInput): Promise<GeneratedSetup>;
  hasCurrentGame(): Promise<boolean>;
  createGame(input: NewGameInput): Promise<GameState>;
  replaceGame(input: NewGameInput): Promise<GameState>;
  play(action: string): Promise<TurnResult>;
  ask(question: string): Promise<QuestionResult>;
  appeal(input: AppealInput): Promise<TurnResult>;
  inspect(view: StateView): Promise<PlayerStateInspection>;
  recentTranscript(limit?: number): Promise<PlayerVisibleTurn[]>;
  campaignLogSnapshot(): Promise<CampaignLogSnapshot>;
  completedStory(): Promise<CompletedStoryArtifact | undefined>;
  generateCompletedStory(
    options?: CompletedStoryGenerationOptions,
  ): Promise<CompletedStoryArtifact>;
  getPendingTurn(): Promise<PendingTurn | undefined>;
  resumePendingTurn(): Promise<TurnResult>;
  recoverPendingCommit(): Promise<boolean>;
  discardPendingTurn(): Promise<void>;
  archiveAndReset(): Promise<void>;
}

export interface CommittedTurn {
  kind?: TurnKind;
  appealTargetTurn?: number;
  action: string;
  resolved: ResolvedTurn;
  check?: CheckResult;
  automaticOutcome?: AutomaticOutcome;
  provider: string;
  model: string;
  usage?: StructuredResult<unknown>["usage"];
  protocolVersion?: number;
}
