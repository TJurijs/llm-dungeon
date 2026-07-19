import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { PlaytestCallRecordSchema } from "../src/playtest/contracts.js";
import {
  reservePlaytestCallCost,
  settlePlaytestCallCost,
  unsettledPlaytestCallCost,
} from "../src/playtest/cost-ledger.js";

function recordedCall(costReservationId: string) {
  return PlaytestCallRecordSchema.parse({
    id: "job-001-candidate-00001",
    timestamp: "2026-07-19T12:00:00.000Z",
    jobId: "job-001",
    actor: "candidate",
    phase: "decision",
    sequence: 1,
    schemaName: "fixture",
    provider: "openai",
    model: "gpt-5.6-terra",
    route: "direct",
    executionProfileFingerprint: "profile",
    costReservationId,
    costWaitMs: 0,
    queueWaitMs: 0,
    providerDurationMs: 1,
    retryBackoffMs: 0,
    promptHash: "prompt",
    systemHash: "system",
    schemaHash: "schema",
    success: true,
    estimatedCostUsd: 0.01,
    costBasis: "reported_usage",
  });
}

describe("durable playtest cost reservations", () => {
  it("charges an interrupted unknown call conservatively on resume", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "llm-dungeon-cost-ledger-"));
    const ledger = path.join(root, "candidate.reservations.jsonl");
    const reservationId = randomUUID();
    await reservePlaytestCallCost(ledger, {
      reservationId,
      callId: "job-001-candidate-00001",
      estimatedCostUsd: 0.25,
    });

    expect(await unsettledPlaytestCallCost(ledger, [])).toBe(0.25);
  });

  it("does not double count a reservation once its call or settlement is durable", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "llm-dungeon-cost-ledger-"));
    const ledger = path.join(root, "candidate.reservations.jsonl");
    const recordedId = randomUUID();
    const settledId = randomUUID();
    await reservePlaytestCallCost(ledger, {
      reservationId: recordedId,
      callId: "job-001-candidate-00001",
      estimatedCostUsd: 0.25,
    });
    await reservePlaytestCallCost(ledger, {
      reservationId: settledId,
      callId: "job-001-candidate-00002",
      estimatedCostUsd: 0.5,
    });
    await settlePlaytestCallCost(ledger, settledId);

    expect(await unsettledPlaytestCallCost(ledger, [recordedCall(recordedId)])).toBe(0);
  });
});
