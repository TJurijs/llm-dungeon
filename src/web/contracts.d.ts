/**
 * Private, unversioned HTTP contract shared by the local server and browser.
 * These declarations stay dependency-free so the browser checkJs build does
 * not pull Node application modules into its compilation.
 */

export type BrowserLanguageCode = "en" | "ru";
export type BrowserProviderId =
  "gemini" | "openrouter" | "xai" | "openai" | "anthropic" | "deepseek";

export interface BrowserModelSelection {
  provider: BrowserProviderId;
  model: string;
}

export interface BrowserUsage {
  inputTokens?: number | undefined;
  outputTokens?: number | undefined;
  totalTokens?: number | undefined;
  billedCostUsd?: number | undefined;
}

export interface BrowserGameState {
  schemaVersion: 1;
  campaignId: string;
  title: string;
  turn: number;
  status: "active" | "dead" | "ended";
  playerId: string;
  currentLocationId: string;
  elapsedMinutes: number;
  timeLabel: string;
  language: BrowserLanguageCode;
  createdAt: string;
  updatedAt: string;
}

export interface BrowserReplyGeneration {
  provider: string;
  model: string;
  costUsd?: number;
  costBasis?: "exact" | "estimated";
}

export type BrowserPendingStatus =
  | null
  | { kind: "commit" }
  | { kind: "appeal"; phase: "requested"; targetTurn?: number }
  | { kind: "action"; phase: "requested" | "rolled"; lockedRoll: boolean };

export interface BrowserSetupPreview {
  campaignTitle: string;
  scenarioMarkdown: string;
  openingNarration: string;
  player: {
    name: string;
    description: string;
    traits: string[];
  };
}

export interface BrowserCampaignStartSettings {
  premise: string;
  character: string;
  language: BrowserLanguageCode;
  worldRules: string;
}

export interface BrowserCampaignCostSummary {
  totalUsd: number;
  basis: "exact" | "estimated" | "mixed";
  pricedTurns: number;
  unpricedTurns: number;
}

/** Application-owned campaign spending limits and physical-attempt accounting. */
export interface BrowserCampaignBudgetSnapshot {
  limits: {
    campaignUsd: number | null;
    logicalTurnUsd: number | null;
  };
  spentUsd: number;
  reservedUsd: number;
  remainingUsd: number | null;
  basis: "exact" | "estimated" | "reserved" | "mixed" | "unpriced";
  projectedNextTurnUsd: number | null;
  projected100TurnsUsd: number | null;
  warningThreshold: 0.5 | 0.75 | 0.9 | 1 | null;
  paused: boolean;
  pauseReason: "campaign_limit" | "logical_turn_limit" | "pricing_unavailable" | null;
  settledAttempts: number;
  unsettledAttempts: number;
}

export interface BrowserCampaignPresentation {
  campaignId: string;
  title: string;
  turn: number;
  status: "active" | "dead" | "ended";
  timeLabel: string;
  language: BrowserLanguageCode;
  createdAt: string;
  updatedAt: string;
  archived: boolean;
  archivedAt?: string;
  tags: string[];
  deleteRequiresTitleConfirmation: boolean;
  stateRevision: string;
  busy: boolean;
  pending: BrowserPendingStatus;
  campaignCost: BrowserCampaignCostSummary | null;
  budget: BrowserCampaignBudgetSnapshot;
  config: BrowserModelSelection | null;
}

export interface BrowserLanguagePresentation {
  code: BrowserLanguageCode;
  name: string;
  setupDefaults: { premise: string; characterConcept: string };
}

export type BrowserModelCompatibilityStatus = "untested" | "compatible" | "failed" | "stale";
export type BrowserModelAdapterStatus =
  "uncalibrated" | "calibrated" | "calibration_inconclusive" | "no_compatible_profile";
export type BrowserModelSpeedRating = "fast" | "average" | "slow" | "very-slow";
export type BrowserModelCostRating = "cheap" | "moderate" | "expensive" | "very-expensive";

export interface BrowserModelEvidenceReference {
  source: "calibration" | "legacy_evaluation";
  reference: string;
  packageId?: string | undefined;
  packageVersion?: string | undefined;
  executionProfileFingerprint?: string | undefined;
  recordedAt?: string | undefined;
}

export interface BrowserModelRecommendationEligibility {
  eligible: boolean;
  reasons: string[];
  evidence?: BrowserModelEvidenceReference | undefined;
}

export interface BrowserModelPriceEstimate {
  inputPerMillion: number;
  outputPerMillion: number;
  sourceModel: string;
  estimated50TurnsUsd: number;
}

/** Published by OpenRouter for its own routed endpoint; not measured here. */
export interface BrowserModelSpeedEstimate {
  source: "openrouter_published";
  sourceUrl: string;
  checkedAt: string;
  outputTokensPerSecond: number;
  routeMismatch: boolean;
}

export interface BrowserLlmModelPresentation {
  id: string;
  label: string;
  compatibilityStatus: BrowserModelCompatibilityStatus;
  status: BrowserModelCompatibilityStatus;
  adapterStatus: BrowserModelAdapterStatus;
  enabled: boolean;
  available: boolean;
  known: boolean;
  testedLanguages: BrowserLanguageCode[];
  failedLanguages: BrowserLanguageCode[];
  pricing?: BrowserModelPriceEstimate;
  speed?: BrowserModelSpeedRating;
  speedEstimate?: BrowserModelSpeedEstimate;
  cost?: BrowserModelCostRating;
  recommended: boolean;
  recommendationEligibility: BrowserModelRecommendationEligibility;
  reasoningDescription?: string;
  evidence: {
    compatibility: {
      testedAt: string;
      protocolVersion: number;
      fingerprint: string;
    } | null;
    assessment: BrowserModelEvidenceReference[];
    profileFingerprint?: string;
  };
  hidden: boolean;
  keyAccess?: "allowed" | "not_allowed";
  error?: string;
}

export interface BrowserLlmProviderPresentation {
  id: BrowserProviderId;
  label: string;
  envKey: string;
  recommended: boolean;
  keyPresent: boolean;
  keySource: "session" | "environment" | "missing";
  keyConnectionStatus: "unknown" | "connected" | "failed";
  models: BrowserLlmModelPresentation[];
}

export interface BrowserLlmPresentation {
  defaultModel: BrowserModelSelection | null;
  pricingBasis: {
    turns: number;
    inputTokens: number;
    outputTokens: number;
    source: string;
    sourceUrl: string;
    checkedAt: string;
  };
  providers: BrowserLlmProviderPresentation[];
}

/** Flattened UI-only projection of one model and its provider metadata. */
export interface BrowserLlmModelEntry extends Omit<BrowserLlmModelPresentation, "id"> {
  provider: BrowserProviderId;
  providerLabel: string;
  envKey: string;
  keyPresent: boolean;
  keySource: "session" | "environment" | "missing";
  model: string;
}

export interface BrowserStatusResponse {
  language: BrowserLanguageCode;
  languages: BrowserLanguagePresentation[];
  config: BrowserModelSelection | null;
  defaults: { language: BrowserLanguageCode; config: BrowserModelSelection | null };
  keyStatus: Record<string, boolean>;
  llm: BrowserLlmPresentation;
  campaigns: BrowserCampaignPresentation[];
}

export interface BrowserCampaignStatusResponse {
  campaign: BrowserCampaignPresentation;
}

export interface BrowserSetupDraftResponse {
  draftId: string;
  setup: BrowserSetupPreview;
  config: BrowserModelSelection;
  language: BrowserLanguageCode;
}

export interface BrowserCampaignCreatedResponse {
  state: BrowserGameState;
  playerName: string;
  openingNarration: string;
  config: BrowserModelSelection | null;
}

export type BrowserPlayerTurnResponse =
  | { kind: "question"; answer: string; generation?: BrowserReplyGeneration }
  | {
      turn: number;
      kind: "gameplay" | "appeal";
      appealTargetTurn?: number;
      narration: string;
      summary: string;
      state: BrowserGameState;
      checkText: string | null;
    };

export type BrowserCommittedTurnResponse = Exclude<BrowserPlayerTurnResponse, { kind: "question" }>;

export interface BrowserPlayerVisibleTurn {
  turn: number;
  kind: "opening" | "gameplay" | "appeal";
  appealTargetTurn?: number;
  action: string;
  narration: string;
  summary: string;
  checkText?: string;
  generation?: BrowserReplyGeneration;
}

export interface BrowserInspectionFacts {
  established: string[];
  knowledge: string[];
  history: string[];
}

export interface BrowserCharacterInspection {
  view: "character";
  language: BrowserLanguageCode;
  name: string;
  description: string;
  status: string;
  traits: string[];
  conditions: string[];
  inventory: Array<{ name: string; quantity: number; status: string; description: string }>;
  facts: BrowserInspectionFacts;
  relationships: Array<{ name: string; summary: string }>;
}

export interface BrowserLocationInspection {
  view: "location";
  language: BrowserLanguageCode;
  name: string;
  description: string;
  status: string;
  features: string[];
  conditions: string[];
  facts: BrowserInspectionFacts;
}

export interface BrowserThreadsInspection {
  view: "threads";
  language: BrowserLanguageCode;
  threads: Array<{
    title: string;
    summary: string;
    status: "active" | "resolved" | "failed";
  }>;
}

export type BrowserPlayerStateInspection =
  BrowserCharacterInspection | BrowserLocationInspection | BrowserThreadsInspection;

export interface BrowserCampaignStateSnapshot {
  revision: string;
  character: BrowserCharacterInspection;
  location: BrowserLocationInspection;
  threads: BrowserThreadsInspection;
}

export interface BrowserCampaignTranscriptResponse {
  playerName: string;
  turns: BrowserPlayerVisibleTurn[];
}

export interface BrowserCampaignInspectionResponse {
  state: BrowserCampaignStateSnapshot;
}

export interface BrowserCampaignSetupResponse {
  setup: BrowserCampaignStartSettings | null;
}

/** Player-safe projection of the optional finished-campaign story artifact. */
export type BrowserCompletedStoryResponse =
  | { status: "missing" }
  | {
      status: "ready";
      story: string;
      generatedAt: string;
      sourceTurn: number;
    };

export interface BrowserWorldProfileResponse {
  language: BrowserLanguageCode;
  markdown: string;
  source: "localized_override" | "legacy_override" | "default";
}

export interface BrowserScenarioSeedSummary {
  id: string;
  title: string;
}

export interface BrowserScenarioSeed extends BrowserScenarioSeedSummary {
  worldRules: string;
  premise: string;
  character: string;
  language: string;
}

export interface BrowserModelTestResponse {
  ok: boolean;
  provider: string;
  model: string;
  language?: BrowserLanguageCode;
  usage: BrowserUsage | null;
  testedLanguages: BrowserLanguageCode[];
  failedLanguages: BrowserLanguageCode[];
  failures: Array<{ language: BrowserLanguageCode; error: string }>;
  protocolVersion: number | null;
  error?: string;
}

export interface BrowserModelMutationResponse {
  saved: true;
  defaultModel: BrowserModelSelection | null;
}

export interface BrowserProviderConnectionResponse {
  results: Array<{
    provider: BrowserProviderId;
    status: "connected" | "unauthorized" | "unavailable";
  }>;
  llm: BrowserLlmPresentation;
}

export interface BrowserErrorResponse {
  error: string;
  code?: "campaign_budget_exhausted" | undefined;
  scope?: "campaign" | "logical_turn" | undefined;
}

export interface BrowserCampaignParams {
  campaignId: string;
}

/** Named operations keep this local surface private rather than implying a public API. */
export interface BrowserApiContract {
  bootstrap: { method: "GET"; response: BrowserStatusResponse };
  readWorldProfile: {
    method: "GET";
    query: { language: BrowserLanguageCode };
    response: BrowserWorldProfileResponse;
  };
  saveWorldProfile: {
    method: "PUT";
    request: { language: BrowserLanguageCode; markdown: string };
    response: { saved: true; language: BrowserLanguageCode; source: "localized_override" };
  };
  saveLanguage: {
    method: "PUT";
    request: { language: BrowserLanguageCode };
    response: { language: BrowserLanguageCode };
  };
  listScenarioSeeds: {
    method: "GET";
    response: { seeds: BrowserScenarioSeedSummary[] };
  };
  readScenarioSeed: {
    method: "GET";
    params: { seedId: string };
    query: { language: BrowserLanguageCode };
    response: { seed: BrowserScenarioSeed };
  };
  createDraft: {
    method: "POST";
    request: {
      premise: string;
      character: string;
      language: BrowserLanguageCode;
      worldRules?: string;
      config: BrowserModelSelection;
      requestId: string;
    };
    response: BrowserSetupDraftResponse;
  };
  detachDraft: {
    method: "POST";
    request: { requestId: string };
    response: { detached: true };
  };
  confirmDraft: {
    method: "POST";
    request: { draftId: string };
    response: BrowserCampaignCreatedResponse;
  };
  testModel: {
    method: "POST";
    request: BrowserModelSelection & { language?: BrowserLanguageCode };
    response: BrowserModelTestResponse;
  };
  addModel: {
    method: "POST";
    request: BrowserModelSelection;
    response: BrowserModelMutationResponse;
  };
  setModelEnabled: {
    method: "PUT";
    request: BrowserModelSelection & { enabled: boolean };
    response: BrowserModelMutationResponse;
  };
  removeModel: {
    method: "DELETE";
    request: BrowserModelSelection;
    response: BrowserModelMutationResponse;
  };
  setDefaultModel: {
    method: "PUT";
    request: BrowserModelSelection;
    response: BrowserModelMutationResponse;
  };
  setSessionKey: {
    method: "PUT";
    request: { provider: BrowserProviderId; key: string };
    response: { llm: BrowserLlmPresentation };
  };
  testProviderConnection: {
    method: "POST";
    request: { provider: BrowserProviderId };
    response: BrowserProviderConnectionResponse;
  };
  reloadEnvironment: {
    method: "POST";
    response: { reloaded: true; llm: BrowserLlmPresentation };
  };
  campaignStatus: {
    method: "GET";
    params: BrowserCampaignParams;
    response: BrowserCampaignStatusResponse;
  };
  campaignBudget: {
    method: "GET";
    params: BrowserCampaignParams;
    response: { budget: BrowserCampaignBudgetSnapshot };
  };
  updateCampaignBudget: {
    method: "PUT";
    params: BrowserCampaignParams;
    request: { campaignUsd?: number | null; logicalTurnUsd?: number | null };
    response: { budget: BrowserCampaignBudgetSnapshot };
  };
  renameCampaign: {
    method: "PUT";
    params: BrowserCampaignParams;
    request: { title: string };
    response: BrowserCampaignStatusResponse;
  };
  campaignTranscript: {
    method: "GET";
    params: BrowserCampaignParams;
    response: BrowserCampaignTranscriptResponse;
  };
  play: {
    method: "POST";
    params: BrowserCampaignParams;
    request: { action: string };
    response: BrowserPlayerTurnResponse;
  };
  retry: {
    method: "POST";
    params: BrowserCampaignParams;
    response: BrowserPlayerTurnResponse;
  };
  discard: {
    method: "POST";
    params: BrowserCampaignParams;
    response: { discarded: true };
  };
  setCampaignModel: {
    method: "PUT";
    params: BrowserCampaignParams;
    request: BrowserModelSelection;
    response: { config: BrowserModelSelection };
  };
  campaignInspection: {
    method: "GET";
    params: BrowserCampaignParams;
    response: BrowserCampaignInspectionResponse;
  };
  archiveCampaign: {
    method: "POST";
    params: BrowserCampaignParams;
    response: { archived: true };
  };
  campaignSetup: {
    method: "GET";
    params: BrowserCampaignParams;
    response: BrowserCampaignSetupResponse;
  };
  campaignStory: {
    method: "GET";
    params: BrowserCampaignParams;
    response: BrowserCompletedStoryResponse;
  };
  generateCampaignStory: {
    method: "POST";
    params: BrowserCampaignParams;
    response: BrowserCompletedStoryResponse;
  };
  deleteCampaign: {
    method: "DELETE";
    params: BrowserCampaignParams;
    request: { title?: string };
    response: { deleted: true };
  };
}

export type BrowserApiOperation = keyof BrowserApiContract;
export type BrowserApiResponse<K extends BrowserApiOperation> = BrowserApiContract[K]["response"];
export type BrowserApiRequest<K extends BrowserApiOperation> = BrowserApiContract[K] extends {
  request: infer Request;
}
  ? Request
  : never;
export type BrowserApiCall<K extends BrowserApiOperation> = (BrowserApiContract[K] extends {
  params: infer Params;
}
  ? { params: Params }
  : { params?: never }) &
  (BrowserApiContract[K] extends { query: infer Query } ? { query: Query } : { query?: never }) &
  (BrowserApiContract[K] extends { request: infer Request }
    ? { body: Request }
    : { body?: never }) & { signal?: AbortSignal };

export interface BrowserApiClient {
  <K extends BrowserApiOperation>(
    operation: K,
    call: BrowserApiCall<K>,
  ): Promise<BrowserApiResponse<K>>;
}
