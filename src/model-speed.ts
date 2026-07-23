import { openRouterModelId } from "./pricing.js";
import type { ModelEvidenceReference } from "./model-status.js";

export type ModelSpeedRating = "fast" | "average" | "slow" | "very-slow";

export interface ModelSpeedEstimate {
  ordinaryTurnSeconds: number;
  checkedTurnSeconds: number;
  sampleTurns: number;
  measuredAt: string;
  latencyBasis: "canonical" | "loaded" | "unknown";
  concurrency?: number;
  evidence: ModelEvidenceReference;
}

/** Rough responsiveness tiers measured during focused release evaluation runs. */
const MODEL_SPEED: Readonly<Record<string, ModelSpeedRating>> = {
  "google/gemini-3.6-flash": "fast",
  "google/gemini-3.5-flash": "fast",
  "google/gemini-3.1-flash-lite": "fast",
  "openai/gpt-5.4": "fast",
  "anthropic/claude-sonnet-4.6": "slow",
  "anthropic/claude-sonnet-5": "slow",
  "deepseek/deepseek-v4-flash": "average",
  // Pro's parallel EN/RU certification averaged about 16.5 seconds per
  // player-visible turn. This is a loaded estimate, not canonical latency.
  "deepseek/deepseek-v4-pro": "average",
  "qwen/qwen3.7-plus": "average",
  "x-ai/grok-4.5": "slow",
  "x-ai/grok-4.3": "fast",
};

function legacySpeedEvidence(reference: string, recordedAt: string): ModelEvidenceReference {
  return {
    source: "legacy_evaluation",
    reference,
    packageId: "evaluation-profile-matrix",
    packageVersion: "legacy-9x5",
    recordedAt,
  };
}

/** Player-facing wait estimates from completed acceptance runs. */
const MODEL_SPEED_ESTIMATES: Readonly<Record<string, ModelSpeedEstimate>> = {
  "anthropic/claude-sonnet-4.6": {
    // English 9x5 self-play: 41 committed turns. Ordinary turns use one DM
    // generation; checked turns include the decision and locked resolution.
    ordinaryTurnSeconds: 26.8,
    checkedTurnSeconds: 52.2,
    sampleTurns: 41,
    measuredAt: "2026-07-19",
    latencyBasis: "loaded",
    concurrency: 3,
    evidence: legacySpeedEvidence(
      "2026-07-19T00-01-53-097Z-76de627b-072a-403f-8b5e-0cafe783785b",
      "2026-07-19T00:01:53.097Z",
    ),
  },
  "deepseek/deepseek-v4-flash": {
    ordinaryTurnSeconds: 18.1,
    checkedTurnSeconds: 39.1,
    sampleTurns: 39,
    measuredAt: "2026-07-19",
    latencyBasis: "loaded",
    concurrency: 3,
    evidence: legacySpeedEvidence(
      "2026-07-19T01-05-07-589Z-52f412a6-909f-43a4-a573-435ab72ef187",
      "2026-07-19T01:05:07.589Z",
    ),
  },
  "google/gemini-3.6-flash": {
    ordinaryTurnSeconds: 12,
    checkedTurnSeconds: 18,
    sampleTurns: 20,
    measuredAt: "2026-07-23",
    latencyBasis: "canonical",
    concurrency: 1,
    evidence: {
      source: "certification",
      reference: "playtests/runs/2026-07-23T13-12-20-414Z-c33d3661-e888-4dfd-a79d-4acf588ad3c3",
      packageId: "certification-v1",
      packageVersion: "3",
      recordedAt: "2026-07-23T13:12:20.414Z",
    },
  },
  "google/gemini-3.5-flash": {
    ordinaryTurnSeconds: 12,
    checkedTurnSeconds: 24.6,
    sampleTurns: 45,
    measuredAt: "2026-07-18",
    latencyBasis: "loaded",
    concurrency: 3,
    evidence: legacySpeedEvidence(
      "2026-07-18T10-07-08-899Z-66376c44-3cfa-46c2-a53b-b11745211c35",
      "2026-07-18T10:07:08.899Z",
    ),
  },
  "google/gemini-3.1-flash-lite": {
    ordinaryTurnSeconds: 5.5,
    checkedTurnSeconds: 9.8,
    sampleTurns: 20,
    measuredAt: "2026-07-19",
    latencyBasis: "loaded",
    concurrency: 2,
    evidence: {
      source: "certification",
      reference: "playtests/runs/2026-07-19T20-02-51-903Z-e4def943-0f4d-4fb9-9462-fe9a937b1e15",
      packageId: "certification-v1",
      packageVersion: "3",
      recordedAt: "2026-07-19T20:02:51.903Z",
    },
  },
  "openai/gpt-5.4": {
    ordinaryTurnSeconds: 8.5,
    checkedTurnSeconds: 19.3,
    sampleTurns: 20,
    measuredAt: "2026-07-20",
    latencyBasis: "loaded",
    concurrency: 2,
    evidence: {
      source: "certification",
      reference: "playtests/runs/2026-07-19T21-04-46-945Z-dc6516e5-53e2-476c-bf8c-7cf2daa6e3a2",
      packageId: "certification-v1",
      packageVersion: "3",
      recordedAt: "2026-07-19T21:04:46.949Z",
    },
  },
  "qwen/qwen3.7-plus": {
    ordinaryTurnSeconds: 17.3,
    checkedTurnSeconds: 25.8,
    sampleTurns: 70,
    measuredAt: "2026-07-18",
    latencyBasis: "loaded",
    concurrency: 3,
    evidence: legacySpeedEvidence(
      "2026-07-18T18-12-29-682Z-dab6da4b-fd0b-4be1-a70e-1581ee71af1e",
      "2026-07-18T18:12:29.682Z",
    ),
  },
  "x-ai/grok-4.5": {
    ordinaryTurnSeconds: 26.6,
    checkedTurnSeconds: 42.5,
    sampleTurns: 90,
    measuredAt: "2026-07-18",
    latencyBasis: "loaded",
    concurrency: 3,
    evidence: legacySpeedEvidence(
      "2026-07-18T18-56-40-039Z-b568ad4b-5ce2-4518-a550-c4422948c29a",
      "2026-07-18T18:56:40.039Z",
    ),
  },
  "x-ai/grok-4.3": {
    ordinaryTurnSeconds: 3.9,
    // Neither acceptance run requested a check; project the two-generation
    // checked wait from the observed ordinary-generation mean.
    checkedTurnSeconds: 7.8,
    sampleTurns: 77,
    measuredAt: "2026-07-18",
    latencyBasis: "loaded",
    concurrency: 3,
    evidence: legacySpeedEvidence(
      "2026-07-18T19-30-30-095Z-7d6f7019-91c8-48b3-853f-de97214a2851",
      "2026-07-18T19:30:30.095Z",
    ),
  },
};

export function modelSpeedRating(provider: string, modelId: string): ModelSpeedRating | undefined {
  return MODEL_SPEED[openRouterModelId(provider, modelId)];
}

export function modelSpeedEstimate(provider: string, modelId: string): ModelSpeedEstimate | undefined {
  const estimate = MODEL_SPEED_ESTIMATES[openRouterModelId(provider, modelId)];
  return estimate === undefined ? undefined : { ...estimate };
}
