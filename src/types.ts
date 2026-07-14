import type { z } from "zod";
import type {
  GameState,
  ResolvedTurn,
  SetupResult,
  StateOperation,
} from "./schemas.js";
import type { LanguageCode } from "./language.js";
import type { CheckResult } from "./mechanics.js";
import type { PendingTurn } from "./persistence/pending.js";

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
  temperature?: number;
  maxOutputTokens?: number;
}

export interface StructuredResult<T> {
  data: T;
  provider: string;
  model: string;
  rawText?: string;
  structuredMode?: "exact_schema";
  protocolVersion?: number;
  usage?: {
    inputTokens?: number | undefined;
    outputTokens?: number | undefined;
    totalTokens?: number | undefined;
  };
}

export interface LlmProvider {
  readonly id: string;
  readonly model: string;
  generateStructured<T>(request: StructuredRequest<T>): Promise<StructuredResult<T>>;
}

export interface NewGameInput {
  setup: SetupResult;
  worldRules: string;
  language?: LanguageCode;
}

export interface SetupGenerationInput {
  worldRules: string;
  premise: string;
  character: string;
  language?: LanguageCode;
}

export type StateView = "character" | "inventory" | "location" | "threads" | "journal";

export interface TurnResult {
  turn: number;
  narration: string;
  summary: string;
  operations: StateOperation[];
  check?: CheckResult;
  state: GameState;
}

export interface PlayerVisibleTurn {
  turn: number;
  action: string;
  narration: string;
  summary: string;
  checkText?: string;
}

export interface GameEngine {
  generateSetup(input: SetupGenerationInput): Promise<SetupResult>;
  hasCurrentGame(): Promise<boolean>;
  createGame(input: NewGameInput): Promise<GameState>;
  replaceGame(input: NewGameInput): Promise<GameState>;
  play(action: string): Promise<TurnResult>;
  inspect(view: StateView): Promise<string>;
  recentTranscript(limit?: number): Promise<PlayerVisibleTurn[]>;
  getPendingTurn(): Promise<PendingTurn | undefined>;
  resumePendingTurn(): Promise<TurnResult>;
  recoverPendingCommit(): Promise<boolean>;
  discardPendingTurn(): Promise<void>;
  archiveAndReset(): Promise<void>;
}

export interface CommittedTurn {
  action: string;
  resolved: ResolvedTurn;
  check?: CheckResult;
  provider: string;
  model: string;
  usage?: StructuredResult<unknown>["usage"];
  protocolVersion?: number;
}
