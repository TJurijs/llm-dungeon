import path from "node:path";
import { z } from "zod";
import type { PlaytestCallRecord } from "./contracts.js";
import { appendPlaytestJsonLine, readPlaytestJsonLines } from "./files.js";

const ReservedCostSchema = z.object({
  schemaVersion: z.literal(1),
  event: z.literal("reserved"),
  reservationId: z.string().uuid(),
  callId: z.string().min(1),
  timestamp: z.string().datetime(),
  estimatedCostUsd: z.number().nonnegative(),
}).strict();

const SettledCostSchema = z.object({
  schemaVersion: z.literal(1),
  event: z.literal("settled"),
  reservationId: z.string().uuid(),
  timestamp: z.string().datetime(),
}).strict();

export const PlaytestCostLedgerEventSchema = z.discriminatedUnion("event", [
  ReservedCostSchema,
  SettledCostSchema,
]);
export type PlaytestCostLedgerEvent = z.infer<typeof PlaytestCostLedgerEventSchema>;

export function reservationLedgerPathForCalls(callsPath: string): string {
  const extension = path.extname(callsPath);
  return extension
    ? `${callsPath.slice(0, -extension.length)}.reservations${extension}`
    : `${callsPath}.reservations.jsonl`;
}

export async function reservePlaytestCallCost(
  ledgerPath: string,
  input: { reservationId: string; callId: string; estimatedCostUsd: number },
): Promise<void> {
  await appendPlaytestJsonLine(ledgerPath, PlaytestCostLedgerEventSchema.parse({
    schemaVersion: 1,
    event: "reserved",
    reservationId: input.reservationId,
    callId: input.callId,
    timestamp: new Date().toISOString(),
    estimatedCostUsd: input.estimatedCostUsd,
  }));
}

export async function settlePlaytestCallCost(
  ledgerPath: string,
  reservationId: string,
): Promise<void> {
  await appendPlaytestJsonLine(ledgerPath, PlaytestCostLedgerEventSchema.parse({
    schemaVersion: 1,
    event: "settled",
    reservationId,
    timestamp: new Date().toISOString(),
  }));
}

/**
 * A reservation without a recorded call or settlement represents a provider
 * call whose billed outcome became unknowable during a crash. Charge its full
 * conservative estimate on resume so the hard ceiling remains fail-closed.
 */
export async function unsettledPlaytestCallCost(
  ledgerPath: string,
  calls: readonly PlaytestCallRecord[],
): Promise<number> {
  const events = PlaytestCostLedgerEventSchema.array().parse(
    await readPlaytestJsonLines(ledgerPath),
  );
  const reservations = new Map<string, z.infer<typeof ReservedCostSchema>>();
  const settled = new Set<string>();
  for (const event of events) {
    if (event.event === "reserved") reservations.set(event.reservationId, event);
    else settled.add(event.reservationId);
  }
  const recorded = new Set(calls.flatMap((call) => (
    call.costReservationId ? [call.costReservationId] : []
  )));
  return [...reservations.values()].reduce((sum, reservation) => (
    settled.has(reservation.reservationId) || recorded.has(reservation.reservationId)
      ? sum
      : sum + reservation.estimatedCostUsd
  ), 0);
}
