import { performance } from "node:perf_hooks";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import {
  GAMEPLAY_SCHEMA_NAMES,
  decodeResolvedTurn,
  decodeTurnDecision,
  gameplayRequest,
  resolvedGameplayRequest,
} from "../llm/gameplay-protocol.js";
import { GenerationFailure } from "../llm/failures.js";
import { generateStructured } from "../llm/structured-generation.js";
import { attemptMetadataFor, structuredFailureDetails } from "../llm/structured-error.js";
import {
  ModelExecutionProfileDraftSchema,
  assertSingleCalibrationVariableChange,
  escalateOutputBudgetAfterTruncation,
  type ModelExecutionProfileDraft,
  type ModelGenerationPhase,
} from "../model-execution-profile.js";
import type { ModelAdapterStatus } from "../model-status.js";
import { atomicWriteJson } from "../persistence/files.js";
import {
  ResolvedTurnSchema,
  SetupResultSchema,
  TurnDecisionSchema,
  type SetupResult,
} from "../schemas.js";
import { validateInitialSetup } from "../store.js";
import type {
  LlmProvider,
  ProviderAttemptMetadata,
  StructuredRequest,
  StructuredResult,
} from "../types.js";
import { attributePlaytestFailure, type FailureAttribution } from "./failure-attribution.js";

export const CALIBRATION_SUITE_VERSION = 2 as const;
export const MAX_CALIBRATION_VARIANTS = 8 as const;

export type CalibrationProbeCaseId =
  | "representative_setup"
  | "resolved_real_effects"
  | "check_required"
  | "locked_resolution"
  | "schema_repair_effect_completeness"
  | "inventory_transfer_and_references"
  | "production_sized_context"
  | "near_normal_output";

export interface CalibrationCaseResult {
  caseId: CalibrationProbeCaseId;
  phase: ModelGenerationPhase;
  success: boolean;
  durationMs: number;
  usage?: StructuredResult<unknown>["usage"];
  attemptMetadata?: ProviderAttemptMetadata;
  attribution?: FailureAttribution;
  error?: string;
}

export interface CalibrationProbeResult {
  suiteVersion: typeof CALIBRATION_SUITE_VERSION;
  provider: string;
  model: string;
  passed: boolean;
  cases: CalibrationCaseResult[];
}

const REPRESENTATIVE_SETUP: SetupResult = SetupResultSchema.parse({
  campaignTitle: "The Brass Lantern Calibration",
  scenarioMarkdown: "A compact city mystery with trade, relationships, hidden evidence, and an approaching threat.",
  openingNarration: "Rain ticks against the Brass Lantern while the last market bell fades.",
  timeLabel: "Evening",
  player: {
    id: "player:hero",
    kind: "person",
    name: "Ilya Venn",
    status: "active",
    location: "location:brass-lantern",
    tags: ["traveler"],
    description: "A careful courier.",
    establishedFacts: ["Carries ten silver marks."],
    secrets: [],
    playerKnowledge: ["Mara promised information before midnight."],
    traits: ["observant"],
    conditions: [],
    inventory: [{ entityId: "item:silver-mark", quantity: 10 }],
  },
  entities: [
    {
      id: "location:brass-lantern",
      kind: "location",
      name: "The Brass Lantern",
      status: "open",
      tags: ["tavern"],
      description: "A warm tavern beside the market.",
      establishedFacts: [], secrets: [], playerKnowledge: [], traits: [], conditions: [], inventory: [],
    },
    {
      id: "location:old-market",
      kind: "location",
      name: "Old Market",
      status: "closing",
      tags: ["market"],
      description: "Rain-dark stalls surround a stone well.",
      establishedFacts: [], secrets: ["A coded ledger is hidden beneath the well rim."], playerKnowledge: [], traits: [], conditions: [],
      inventory: [{ entityId: "item:sealed-vial", quantity: 1 }],
    },
    {
      id: "npc:mara",
      kind: "person",
      name: "Mara",
      status: "cooperative",
      location: "location:brass-lantern",
      tags: ["merchant"],
      description: "A spice merchant with an exact memory.",
      establishedFacts: ["Promised Ilya information before midnight."], secrets: [], playerKnowledge: [], traits: [], conditions: [],
      inventory: [{ entityId: "item:healing-draught", quantity: 1 }],
    },
    {
      id: "item:silver-mark", kind: "item", name: "Silver Mark", status: "currency", tags: ["currency"],
      description: "A stamped silver coin.", establishedFacts: [], secrets: [], playerKnowledge: [], traits: [], conditions: [], inventory: [],
    },
    {
      id: "item:healing-draught", kind: "item", name: "Healing Draught", status: "sealed", tags: ["consumable"],
      description: "A single-use restorative.", establishedFacts: [], secrets: [], playerKnowledge: [], traits: [], conditions: [], inventory: [],
    },
    {
      id: "item:sealed-vial", kind: "item", name: "Sealed Vial", status: "loose", tags: [],
      description: "A thumb-sized blue vial.", establishedFacts: [], secrets: [], playerKnowledge: [], traits: [], conditions: [], inventory: [],
    },
  ],
  threads: [{
    id: "thread:missing-ledger",
    title: "The Missing Ledger",
    summary: "Find the ledger before the watch closes the market.",
    status: "active",
    relatedEntityIds: ["npc:mara", "location:old-market"],
  }],
});

const EFFECT = {
  kind: "transfer_item",
  targetId: "npc:mara",
  relatedId: "player:hero",
  itemId: "item:healing-draught",
  entityKindCode: 0,
  factSectionCode: 0,
  lifecycleCode: 0,
  name: "",
  status: "",
  text: "",
  quantity: 1,
  tags: [],
  references: [],
} as const;

const REAL_EFFECTS = [
  {
    kind: "add_fact",
    targetId: "player:hero",
    relatedId: "",
    itemId: "",
    entityKindCode: 0,
    factSectionCode: 3,
    lifecycleCode: 0,
    name: "",
    status: "",
    text: "Mara confirmed that the watch changes at midnight.",
    quantity: 0,
    tags: [],
    references: [],
  },
  {
    kind: "advance_time",
    targetId: "",
    relatedId: "",
    itemId: "",
    entityKindCode: 0,
    factSectionCode: 0,
    lifecycleCode: 0,
    name: "",
    status: "",
    text: "Late Evening",
    quantity: 10,
    tags: [],
    references: [],
  },
] as const;

function resolvedWire(narration: string, effects: unknown[] = []) {
  return {
    decision: "resolved",
    narration,
    effects,
    summary: narration,
    checkName: "",
    difficulty: 0,
    modifiers: [],
    exceptionalSuccessStakes: "",
    successStakes: "",
    failureStakes: "",
    severeFailureStakes: "",
    failureCampaignStatus: "none",
  };
}

const CHECK_WIRE = {
  decision: "check_required",
  narration: "",
  effects: [],
  summary: "",
  checkName: "Convince the hostile watch captain",
  difficulty: 65,
  modifiers: [{ label: "Mara's corroboration", value: 10 }],
  exceptionalSuccessStakes: "The captain openly assists.",
  successStakes: "The captain grants passage.",
  failureStakes: "The captain refuses passage.",
  severeFailureStakes: "The captain orders an immediate search.",
  failureCampaignStatus: "none",
} as const;

const PRODUCTION_CONTEXT = Array.from({ length: 96 }, (_, index) =>
  `Context record ${index + 1}: authoritative places, inventories, promises, facts, and recent summaries remain unchanged.`).join("\n");

interface ProbeCase<T> {
  id: CalibrationProbeCaseId;
  phase: ModelGenerationPhase;
  request: StructuredRequest<T>;
  validate: (result: T) => void;
}

function probeCases(): Array<ProbeCase<unknown>> {
  const resolvedEffects = resolvedWire(
    "Mara confirms the watch schedule while ten minutes pass.",
    [...REAL_EFFECTS],
  );
  const inventoryTransfer = resolvedWire(
    "Mara hands Ilya the promised draught and records the transfer.",
    [EFFECT],
  );
  const locked = resolvedWire("The locked roll succeeds; the captain grants passage.");
  const normalNarration = "The crowded room settles into a tense silence. ".repeat(32).trim();
  return [
    {
      id: "representative_setup",
      phase: "setup",
      request: {
        schemaName: "calibration_campaign_setup_v1",
        schema: SetupResultSchema,
        system: "Return the requested structured object exactly. This is a non-scored adapter calibration probe.",
        prompt: `Return exactly this representative campaign setup: ${JSON.stringify(REPRESENTATIVE_SETUP)}`,
        temperature: 0,
        maxOutputTokens: 8_000,
        generationPhase: "setup",
        attemptKind: "initial",
      },
      validate: (value) => { validateInitialSetup(value); },
    },
    {
      id: "resolved_real_effects",
      phase: "decision",
      request: gameplayRequest({
        schemaName: `${GAMEPLAY_SCHEMA_NAMES.connectionProbe}_resolved_effects`,
        schema: TurnDecisionSchema,
        decodeResponse: decodeTurnDecision,
        system: "Return the requested structured object exactly. This is a non-scored adapter calibration probe.",
        prompt: `Return exactly this resolved gameplay wire object: ${JSON.stringify(resolvedEffects)}`,
        temperature: 0,
        maxOutputTokens: 4_000,
        generationPhase: "decision",
        attemptKind: "initial",
      }),
      validate: (value) => {
        const parsed = TurnDecisionSchema.parse(value);
        const addedFact = parsed.kind === "resolved"
          ? parsed.operations.find((operation) => operation.type === "add_fact")
          : undefined;
        const advancedTime = parsed.kind === "resolved"
          ? parsed.operations.find((operation) => operation.type === "advance_time")
          : undefined;
        if (parsed.kind !== "resolved"
          || addedFact?.text !== "Mara confirmed that the watch changes at midnight."
          || advancedTime?.minutes !== 10
          || advancedTime.timeLabel !== "Late Evening") {
          throw new GenerationFailure("domain_decode_violation", "Calibration response omitted or corrupted required effect fields", true);
        }
      },
    },
    {
      id: "check_required",
      phase: "decision",
      request: gameplayRequest({
        schemaName: `${GAMEPLAY_SCHEMA_NAMES.connectionProbe}_check`,
        schema: TurnDecisionSchema,
        decodeResponse: decodeTurnDecision,
        system: "Return the requested structured object exactly. This is a non-scored adapter calibration probe.",
        prompt: `Return exactly this check-required gameplay wire object: ${JSON.stringify(CHECK_WIRE)}`,
        temperature: 0,
        maxOutputTokens: 4_000,
        generationPhase: "decision",
        attemptKind: "initial",
      }),
      validate: (value) => {
        if (TurnDecisionSchema.parse(value).kind !== "check_required") {
          throw new GenerationFailure("domain_decode_violation", "Calibration response did not request the required check", true);
        }
      },
    },
    {
      id: "locked_resolution",
      phase: "locked_resolution",
      request: resolvedGameplayRequest({
        schemaName: `${GAMEPLAY_SCHEMA_NAMES.connectionProbe}_locked_resolution`,
        schema: ResolvedTurnSchema,
        decodeResponse: decodeResolvedTurn,
        system: "Return the requested structured object exactly. This is a non-scored adapter calibration probe.",
        prompt: `The application has locked a successful roll. Return exactly this resolved gameplay wire object: ${JSON.stringify(locked)}`,
        temperature: 0,
        maxOutputTokens: 4_000,
        generationPhase: "locked_resolution",
        attemptKind: "initial",
      }),
      validate: (value) => { ResolvedTurnSchema.parse(value); },
    },
    {
      id: "schema_repair_effect_completeness",
      phase: "repair",
      request: resolvedGameplayRequest({
        schemaName: `${GAMEPLAY_SCHEMA_NAMES.connectionProbe}_repair_effects`,
        schema: ResolvedTurnSchema,
        decodeResponse: decodeResolvedTurn,
        system: "Repair the supplied JSON into one complete protocol object. This is a non-scored adapter calibration probe.",
        prompt: `A previous response omitted required fields from effect objects. Return exactly this complete corrected resolved gameplay wire object: ${JSON.stringify(resolvedEffects)}`,
        temperature: 0,
        maxOutputTokens: 8_000,
        generationPhase: "repair",
        repairOfPhase: "locked_resolution",
        attemptKind: "schema_repair",
      }),
      validate: (value) => {
        const parsed = ResolvedTurnSchema.parse(value);
        const addedFact = parsed.operations.find((operation) => operation.type === "add_fact");
        const advancedTime = parsed.operations.find((operation) => operation.type === "advance_time");
        if (addedFact?.text !== "Mara confirmed that the watch changes at midnight."
          || advancedTime?.minutes !== 10
          || advancedTime.timeLabel !== "Late Evening") {
          throw new GenerationFailure("domain_decode_violation", "Calibration repair corrupted required effect fields", true);
        }
      },
    },
    {
      id: "inventory_transfer_and_references",
      phase: "decision",
      request: gameplayRequest({
        schemaName: `${GAMEPLAY_SCHEMA_NAMES.connectionProbe}_inventory_transfer`,
        schema: TurnDecisionSchema,
        decodeResponse: decodeTurnDecision,
        system: "Return the requested structured object exactly. This is a non-scored adapter calibration probe.",
        prompt: `The authoritative owners are npc:mara and player:hero, and item:healing-draught exists. Return exactly this wire object: ${JSON.stringify(inventoryTransfer)}`,
        temperature: 0,
        maxOutputTokens: 4_000,
        generationPhase: "decision",
        attemptKind: "initial",
      }),
      validate: (value) => {
        const parsed = TurnDecisionSchema.parse(value);
        const transfer = parsed.kind === "resolved"
          ? parsed.operations.find((operation) => operation.type === "transfer_item")
          : undefined;
        if (transfer?.fromId !== "npc:mara"
          || transfer.toId !== "player:hero"
          || transfer.itemId !== "item:healing-draught"
          || transfer.quantity !== 1) {
          throw new GenerationFailure("domain_decode_violation", "Calibration response did not preserve authoritative transfer fields", true);
        }
      },
    },
    {
      id: "production_sized_context",
      phase: "decision",
      request: gameplayRequest({
        schemaName: `${GAMEPLAY_SCHEMA_NAMES.connectionProbe}_production_context`,
        schema: TurnDecisionSchema,
        decodeResponse: decodeTurnDecision,
        system: "Return the requested structured object exactly. This is a non-scored adapter calibration probe.",
        prompt: `${PRODUCTION_CONTEXT}\n\nReturn exactly this resolved gameplay wire object: ${JSON.stringify(resolvedWire("The authoritative context remains internally consistent."))}`,
        temperature: 0,
        maxOutputTokens: 4_000,
        generationPhase: "decision",
        attemptKind: "initial",
      }),
      validate: (value) => { TurnDecisionSchema.parse(value); },
    },
    {
      id: "near_normal_output",
      phase: "decision",
      request: gameplayRequest({
        schemaName: `${GAMEPLAY_SCHEMA_NAMES.connectionProbe}_near_normal_output`,
        schema: TurnDecisionSchema,
        decodeResponse: decodeTurnDecision,
        system: "Return the requested structured object exactly. This is a non-scored adapter calibration probe.",
        prompt: `Return exactly this near-normal-sized resolved gameplay wire object: ${JSON.stringify(resolvedWire(normalNarration))}`,
        temperature: 0,
        maxOutputTokens: 4_000,
        generationPhase: "decision",
        attemptKind: "initial",
      }),
      validate: (value) => {
        const parsed = TurnDecisionSchema.parse(value);
        if (parsed.kind !== "resolved" || parsed.narration.length < 1_000) {
          throw new GenerationFailure("domain_decode_violation", "Calibration response was shorter than the near-normal output fixture", true);
        }
      },
    },
  ];
}

async function runCase(provider: LlmProvider, probe: ProbeCase<unknown>): Promise<CalibrationCaseResult> {
  const started = performance.now();
  try {
    const result = await generateStructured(provider, probe.request);
    probe.validate(result.data);
    return {
      caseId: probe.id,
      phase: probe.phase,
      success: true,
      durationMs: Math.round((performance.now() - started) * 10) / 10,
      ...(result.usage ? { usage: result.usage } : {}),
      ...(result.attemptMetadata ? { attemptMetadata: result.attemptMetadata } : {}),
    };
  } catch (error) {
    const metadata = attemptMetadataFor(error);
    const usage = structuredFailureDetails(error)?.usage;
    return {
      caseId: probe.id,
      phase: probe.phase,
      success: false,
      durationMs: Math.round((performance.now() - started) * 10) / 10,
      ...(metadata ? { attemptMetadata: metadata } : {}),
      ...(usage ? { usage } : {}),
      attribution: attributePlaytestFailure(error, {
        lane: "calibration",
        stage: "provider_call",
        ...(metadata ? { attemptMetadata: metadata } : {}),
      }),
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/** Runs the complete non-scored protocol suite sequentially for one route/profile. */
export async function runModelCalibrationProbe(provider: LlmProvider): Promise<CalibrationProbeResult> {
  const cases: CalibrationCaseResult[] = [];
  for (const probe of probeCases()) cases.push(await runCase(provider, probe));
  return {
    suiteVersion: CALIBRATION_SUITE_VERSION,
    provider: provider.id,
    model: provider.model,
    passed: cases.every((probe) => probe.success && probe.attemptMetadata?.truncated !== true),
    cases,
  };
}

export interface CalibrationVariantResult {
  profile: ModelExecutionProfileDraft;
  changedVariable?: string;
  probe: CalibrationProbeResult;
}

export interface CalibrationAttemptArtifact {
  recordedAt: string;
  evidenceId: string;
  variantIndex: number;
  profile: ModelExecutionProfileDraft;
  changedVariable?: string;
  probe: CalibrationProbeResult;
}

export function calibrationEvidenceId(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) {
    throw new Error("Calibration evidence ID must be a safe filename component");
  }
  return value;
}

/** Append-only, secret-free evidence storage for every attempted calibration variant. */
export class CalibrationEvidenceStore {
  constructor(private readonly root: string) {}

  private evidenceDir(evidenceId: string): string {
    return path.join(this.root, calibrationEvidenceId(evidenceId));
  }

  async appendAttempt(artifact: CalibrationAttemptArtifact): Promise<void> {
    const directory = this.evidenceDir(artifact.evidenceId);
    await mkdir(directory, { recursive: true });
    await appendFile(path.join(directory, "attempts.jsonl"), `${JSON.stringify(artifact)}\n`, "utf8");
  }

  async readAttempts(evidenceId: string): Promise<CalibrationAttemptArtifact[]> {
    let text: string;
    try {
      text = await readFile(path.join(this.evidenceDir(evidenceId), "attempts.jsonl"), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    return text.split("\n").filter(Boolean).map((line) => JSON.parse(line) as CalibrationAttemptArtifact);
  }

  async writeSelection(evidenceId: string, selected: CalibrationVariantResult): Promise<void> {
    const directory = this.evidenceDir(evidenceId);
    await mkdir(directory, { recursive: true });
    await atomicWriteJson(path.join(directory, "selection.json"), selected);
  }
}

export interface CalibrationVariantRunOptions {
  evidenceId?: string;
  evidenceStore?: CalibrationEvidenceStore;
  now?: () => Date;
  /** Append bounded one-variable budget steps only when the last probe proves truncation. */
  autoEscalateTruncation?: boolean;
}

function firstTruncationEscalation(
  profile: ModelExecutionProfileDraft,
  probe: CalibrationProbeResult,
): ModelExecutionProfileDraft | undefined {
  for (const phase of ["setup", "decision", "locked_resolution"] as const) {
    if (!probe.cases.some((item) =>
      item.phase === phase && item.attemptMetadata?.truncated === true)) continue;
    const escalated = escalateOutputBudgetAfterTruncation(profile, phase, true);
    if (escalated) return escalated;
  }
  return undefined;
}

function budgetPhaseForChange(changedVariable: string): ModelGenerationPhase | undefined {
  if (changedVariable === "outputBudgets.setup") return "setup";
  if (changedVariable === "outputBudgets.decision") return "decision";
  if (changedVariable === "outputBudgets.lockedResolution") return "locked_resolution";
  if (changedVariable === "outputBudgets.repair") return "repair";
  return undefined;
}

function phaseTruncated(probe: CalibrationProbeResult, phase: ModelGenerationPhase): boolean {
  if (phase === "repair") {
    return probe.cases.some((item) => item.attemptMetadata?.generationPhase === "repair"
      && item.attemptMetadata.truncated);
  }
  return probe.cases.some((item) => item.phase === phase && item.attemptMetadata?.truncated === true);
}

/** Enforces one-variable-at-a-time comparison and sequential execution. */
export async function runCalibrationVariants(
  variants: readonly ModelExecutionProfileDraft[],
  providerFor: (profile: ModelExecutionProfileDraft) => LlmProvider,
  options: CalibrationVariantRunOptions = {},
): Promise<CalibrationVariantResult[]> {
  if (variants.length === 0 || variants.length > MAX_CALIBRATION_VARIANTS) {
    throw new Error(`Calibration requires between one and ${MAX_CALIBRATION_VARIANTS} bounded variants`);
  }
  const parsed = variants.map((variant) => ModelExecutionProfileDraftSchema.parse(variant));
  for (let index = 1; index < parsed.length; index += 1) {
    const prior = parsed[index - 1]!;
    const profile = parsed[index]!;
    const changedVariable = assertSingleCalibrationVariableChange(prior, profile);
    const budgetPhase = budgetPhaseForChange(changedVariable);
    if (budgetPhase) {
      const expected = escalateOutputBudgetAfterTruncation(prior, budgetPhase, true);
      if (!expected || JSON.stringify(expected) !== JSON.stringify(profile)) {
        throw new Error(
          `${changedVariable} must use exactly the next bounded truncation-escalation step`,
        );
      }
    }
  }
  const results: CalibrationVariantResult[] = [];
  for (let index = 0; index < parsed.length; index += 1) {
    const profile = parsed[index]!;
    const prior = parsed[index - 1];
    const changedVariable = prior === undefined ? undefined : assertSingleCalibrationVariableChange(prior, profile);
    const budgetPhase = changedVariable ? budgetPhaseForChange(changedVariable) : undefined;
    if (budgetPhase && !phaseTruncated(results[index - 1]!.probe, budgetPhase)) {
      throw new Error(`${changedVariable} requires confirmed truncation in the immediately preceding probe`);
    }
    const probe = await runModelCalibrationProbe(providerFor(profile));
    const result = { profile, ...(changedVariable ? { changedVariable } : {}), probe };
    results.push(result);
    if (options.evidenceStore && options.evidenceId) {
      await options.evidenceStore.appendAttempt({
        recordedAt: (options.now?.() ?? new Date()).toISOString(),
        evidenceId: options.evidenceId,
        variantIndex: index,
        profile,
        ...(changedVariable ? { changedVariable } : {}),
        probe,
      });
    }
    if ((options.autoEscalateTruncation ?? true) && index === parsed.length - 1) {
      const escalated = firstTruncationEscalation(profile, probe);
      if (escalated && parsed.length < MAX_CALIBRATION_VARIANTS) parsed.push(escalated);
    }
  }
  const selected = selectCalibrationProfile(results);
  if (selected && options.evidenceStore && options.evidenceId) {
    await options.evidenceStore.writeSelection(options.evidenceId, selected);
  }
  return results;
}

/** External or ambiguous blockers make calibration inconclusive, not unsupported. */
export function calibrationFailureStatus(
  results: readonly CalibrationVariantResult[],
): Extract<ModelAdapterStatus, "calibration_inconclusive" | "no_compatible_profile"> {
  const inconclusiveOwners = new Set([
    "provider_route",
    "account_access",
    "application",
    "inconclusive",
  ]);
  return results.some((result) => result.probe.cases.some((item) =>
    item.attribution !== undefined && inconclusiveOwners.has(item.attribution.owner)))
    ? "calibration_inconclusive"
    : "no_compatible_profile";
}

function billedCost(result: CalibrationVariantResult): number {
  return result.probe.cases.reduce((sum, item) => sum + (item.usage?.billedCostUsd ?? 0), 0);
}

function repairedAttempts(result: CalibrationVariantResult): number {
  return result.probe.cases.filter((item) =>
    item.attemptMetadata?.attemptKind === "schema_repair"
    || item.attemptMetadata?.attemptKind === "transient_retry"
    || item.attemptMetadata?.attemptKind === "domain_repair").length;
}

/** Selects without narrative scoring: correctness, first pass, truncation, repair, latency, then cost. */
export function selectCalibrationProfile(
  results: readonly CalibrationVariantResult[],
): CalibrationVariantResult | undefined {
  return [...results].sort((left, right) => {
    const leftSuccesses = left.probe.cases.filter((item) => item.success).length;
    const rightSuccesses = right.probe.cases.filter((item) => item.success).length;
    if (leftSuccesses !== rightSuccesses) return rightSuccesses - leftSuccesses;
    const leftFirstPass = left.probe.cases.filter((item) => item.success
      && (item.attemptMetadata === undefined || item.attemptMetadata.attemptKind === "initial")).length;
    const rightFirstPass = right.probe.cases.filter((item) => item.success
      && (item.attemptMetadata === undefined || item.attemptMetadata.attemptKind === "initial")).length;
    if (leftFirstPass !== rightFirstPass) return rightFirstPass - leftFirstPass;
    const leftTruncated = left.probe.cases.filter((item) => item.attemptMetadata?.truncated).length;
    const rightTruncated = right.probe.cases.filter((item) => item.attemptMetadata?.truncated).length;
    if (leftTruncated !== rightTruncated) return leftTruncated - rightTruncated;
    const repairDifference = repairedAttempts(left) - repairedAttempts(right);
    if (repairDifference !== 0) return repairDifference;
    const leftLatency = left.probe.cases.reduce((sum, item) => sum + item.durationMs, 0);
    const rightLatency = right.probe.cases.reduce((sum, item) => sum + item.durationMs, 0);
    if (leftLatency !== rightLatency) return leftLatency - rightLatency;
    return billedCost(left) - billedCost(right);
  })[0];
}
