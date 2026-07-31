import { z } from "zod";
import { SafeIdSchema, type ChronicleEvent, type Entity, type Thread } from "./schemas.js";

/**
 * Continuity a seed asserts about its own campaign, evaluated every turn.
 *
 * Setup requirements constrain only the opening state, so everything a
 * scenario cares about afterwards previously lived in prose and was measured,
 * if at all, by a judge. These declarations are generic kinds parameterized by
 * IDs, which lets a new seed ship as JSON with no new code: the runtime
 * evaluates them as review signals and the playtest harness grades them as
 * coverage.
 *
 * They are deliberately signals rather than rejections. A seed author is
 * describing intent about fiction that has not happened yet, and a wrong
 * assertion must not be able to block a legitimate turn.
 */

const CustodyChainSchema = z
  .object({
    kind: z.literal("custody_chain"),
    code: z.string().trim().min(1).max(80),
    itemId: SafeIdSchema,
    /** Owners this item may legitimately reach; empty allows any owner. */
    permittedOwnerIds: z.array(SafeIdSchema).max(24).default([]),
  })
  .strict();

const ThreadOpenUntilSchema = z
  .object({
    kind: z.literal("thread_open_until"),
    code: z.string().trim().min(1).max(80),
    /** Matched against the thread's immutable objective and title. */
    threadLabel: z.string().trim().min(1).max(120),
    /** The thread may close only once this entity is player-known. */
    untilKnown: SafeIdSchema,
  })
  .strict();

const NeverCoalesceSchema = z
  .object({
    kind: z.literal("never_coalesce"),
    code: z.string().trim().min(1).max(80),
    locationIds: z.array(SafeIdSchema).min(2).max(8),
  })
  .strict();

const FactProvenanceRequiredSchema = z
  .object({
    kind: z.literal("fact_provenance_required"),
    code: z.string().trim().min(1).max(80),
    /** Facts recorded on these subjects must declare how they are known. */
    subjectIds: z.array(SafeIdSchema).min(1).max(24),
  })
  .strict();

const ClockMonotonicSchema = z
  .object({
    kind: z.literal("clock_monotonic"),
    code: z.string().trim().min(1).max(80),
  })
  .strict();

export const ScenarioContractSchema = z.discriminatedUnion("kind", [
  CustodyChainSchema,
  ThreadOpenUntilSchema,
  NeverCoalesceSchema,
  FactProvenanceRequiredSchema,
  ClockMonotonicSchema,
]);

export type ScenarioContract = z.infer<typeof ScenarioContractSchema>;

export interface ScenarioContractSignal {
  readonly code: string;
  readonly kind: ScenarioContract["kind"];
  readonly message: string;
}

export interface ScenarioContractState {
  readonly entities: ReadonlyMap<string, Entity>;
  readonly threads: readonly Thread[];
  readonly chronicle: readonly ChronicleEvent[];
  readonly elapsedMinutes: number;
  readonly previousElapsedMinutes?: number;
}

function ownersOf(state: ScenarioContractState, itemId: string): string[] {
  const owners: string[] = [];
  for (const entity of state.entities.values()) {
    if (entity.inventory.some((entry) => entry.entityId === itemId)) owners.push(entity.id);
  }
  return owners.sort();
}

function matchesLabel(thread: Thread, label: string): boolean {
  const needle = label.trim().toLowerCase();
  return (
    thread.title.toLowerCase().includes(needle) ||
    (thread.objective ?? thread.summary).toLowerCase().includes(needle)
  );
}

function playerKnows(state: ScenarioContractState, subjectId: string): boolean {
  const subject = state.entities.get(subjectId);
  if (!subject) return false;
  return subject.facts.some((fact) => fact.active && fact.section === "knowledge");
}

/** Evaluate one campaign snapshot against a seed's ongoing continuity claims. */
export function evaluateScenarioContracts(
  contracts: readonly ScenarioContract[],
  state: ScenarioContractState,
): ScenarioContractSignal[] {
  const signals: ScenarioContractSignal[] = [];
  const signal = (contract: ScenarioContract, message: string): void => {
    signals.push({ code: contract.code, kind: contract.kind, message });
  };

  for (const contract of contracts) {
    switch (contract.kind) {
      case "custody_chain": {
        const owners = ownersOf(state, contract.itemId);
        if (owners.length > 1) {
          signal(contract, `${contract.itemId} is held by several owners: ${owners.join(", ")}`);
        }
        if (contract.permittedOwnerIds.length > 0) {
          const unexpected = owners.filter((id) => !contract.permittedOwnerIds.includes(id));
          if (unexpected.length > 0) {
            signal(
              contract,
              `${contract.itemId} reached an owner the seed did not anticipate: ${unexpected.join(", ")}`,
            );
          }
        }
        break;
      }
      case "thread_open_until": {
        const closed = state.threads.filter(
          (thread) => thread.status !== "active" && matchesLabel(thread, contract.threadLabel),
        );
        if (closed.length > 0 && !playerKnows(state, contract.untilKnown)) {
          signal(
            contract,
            `${closed.map((thread) => thread.id).join(", ")} closed before the player learned anything about ${contract.untilKnown}`,
          );
        }
        break;
      }
      case "never_coalesce": {
        const present = contract.locationIds.filter((id) => state.entities.has(id));
        if (present.length < contract.locationIds.length) {
          signal(
            contract,
            `these places must stay distinct but only ${present.join(", ") || "none"} remain`,
          );
        }
        break;
      }
      case "fact_provenance_required": {
        for (const subjectId of contract.subjectIds) {
          const subject = state.entities.get(subjectId);
          if (!subject) continue;
          const unsourced = subject.facts.filter(
            (fact) => fact.active && fact.section === "knowledge" && fact.basis === undefined,
          );
          if (unsourced.length > 0) {
            signal(
              contract,
              `${subjectId} carries ${unsourced.length} player-known fact(s) with no declared basis`,
            );
          }
        }
        break;
      }
      case "clock_monotonic": {
        if (
          state.previousElapsedMinutes !== undefined &&
          state.elapsedMinutes < state.previousElapsedMinutes
        ) {
          signal(
            contract,
            `the campaign clock moved backward from ${state.previousElapsedMinutes} to ${state.elapsedMinutes} minutes`,
          );
        }
        const futureEvents = state.chronicle.filter((event) => event.turn < 0);
        if (futureEvents.length > 0) {
          signal(contract, `${futureEvents.length} chronicle event(s) carry an invalid turn`);
        }
        break;
      }
    }
  }
  return signals;
}
