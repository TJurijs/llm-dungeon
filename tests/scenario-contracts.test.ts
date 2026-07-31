import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  evaluateScenarioContracts,
  type ScenarioContract,
  type ScenarioContractState,
} from "../src/scenario-contracts.js";
import { SetupRequirementsSchema } from "../src/setup-requirements.js";
import type { Entity } from "../src/schemas.js";
import { PlaytestTurnRecordSchema } from "../tools/playtest/harness/contracts.js";
import { summarizeScenarioSignals } from "../tools/playtest/harness/report.js";
import { createTestStore } from "./helpers.js";

const SEEDS = fileURLToPath(new URL("../defaults/scenario-seeds", import.meta.url));

async function campaignState(): Promise<ScenarioContractState> {
  const loaded = await (await createTestStore()).load();
  return {
    entities: loaded.entities,
    threads: loaded.threads,
    chronicle: loaded.chronicle,
    elapsedMinutes: loaded.manifest.elapsedMinutes,
  };
}

function withEntities(
  state: ScenarioContractState,
  mutate: (entities: Map<string, Entity>) => void,
): ScenarioContractState {
  const entities = new Map(
    [...state.entities.entries()].map(([id, entity]) => [id, structuredClone(entity)]),
  );
  mutate(entities);
  return { ...state, entities };
}

describe("ongoing scenario contracts", () => {
  it("stays quiet on a coherent campaign", async () => {
    const state = await campaignState();
    const contracts: ScenarioContract[] = [
      { kind: "custody_chain", code: "sword", itemId: "item:travel-sword", permittedOwnerIds: [] },
      { kind: "clock_monotonic", code: "clock" },
    ];

    expect(evaluateScenarioContracts(contracts, state)).toEqual([]);
  });

  it("signals split custody and an owner the seed never anticipated", async () => {
    const base = await campaignState();
    const split = withEntities(base, (entities) => {
      entities.get("npc:mara-venn")!.inventory.push({ entityId: "item:travel-sword", quantity: 1 });
    });

    const signals = evaluateScenarioContracts(
      [
        {
          kind: "custody_chain",
          code: "sword",
          itemId: "item:travel-sword",
          permittedOwnerIds: ["player:hero"],
        },
      ],
      split,
    );

    expect(signals.map((entry) => entry.code)).toEqual(["sword", "sword"]);
    expect(signals[0]!.message).toContain("held by several owners");
    expect(signals[1]!.message).toContain("owner the seed did not anticipate");
  });

  it("signals a thread closed before its subject was ever learned", async () => {
    const base = await campaignState();
    const state: ScenarioContractState = {
      ...base,
      threads: base.threads.map((thread) => ({ ...thread, status: "resolved" as const })),
    };

    const signals = evaluateScenarioContracts(
      [
        {
          kind: "thread_open_until",
          code: "road",
          threadLabel: "northern road",
          untilKnown: "npc:mara-venn",
        },
      ],
      state,
    );

    expect(signals).toHaveLength(1);
    expect(signals[0]!.message).toContain("closed before the player learned anything");
  });

  it("signals a lost distinct place and a backward clock", async () => {
    const base = await campaignState();
    const state = { ...base, previousElapsedMinutes: base.elapsedMinutes + 30 };

    const signals = evaluateScenarioContracts(
      [
        {
          kind: "never_coalesce",
          code: "places",
          locationIds: ["location:crooked-crown", "location:vanished-annex"],
        },
        { kind: "clock_monotonic", code: "clock" },
      ],
      state,
    );

    expect(signals.map((entry) => entry.code)).toEqual(["places", "clock"]);
    expect(signals[1]!.message).toContain("moved backward");
  });

  it("signals player knowledge recorded without a declared basis", async () => {
    const base = await campaignState();
    const state = withEntities(base, (entities) => {
      entities.get("npc:mara-venn")!.facts.push({
        id: "fact:unsourced-claim",
        section: "knowledge",
        text: "The bridge is out.",
        active: true,
        createdTurn: 1,
      });
    });

    const signals = evaluateScenarioContracts(
      [{ kind: "fact_provenance_required", code: "sourced", subjectIds: ["npc:mara-venn"] }],
      state,
    );

    expect(signals).toHaveLength(1);
    expect(signals[0]!.message).toContain("no declared basis");
  });

  it("carries signals on a turn record and groups them in the report", () => {
    const turn = PlaytestTurnRecordSchema.parse({
      turn: 1,
      action: "I search the shelter.",
      driver: "scripted",
      expectedCheckPolicy: "context_dependent",
      assignedNaturalRoll: 50,
      status: "completed",
      invariantStatus: "passed",
      scenarioSignals: [
        { code: "crate-alpha-single-custody", kind: "custody_chain", message: "split custody" },
      ],
    });

    // Signals are review evidence, so they never change technical status.
    expect(turn.invariantStatus).toBe("passed");
    expect(turn.scenarioSignals).toHaveLength(1);

    expect(summarizeScenarioSignals([turn, turn])).toEqual([
      {
        code: "crate-alpha-single-custody",
        count: 2,
        example: "split custody",
      },
    ]);
  });

  it("defaults to no signals for a record written before contracts existed", () => {
    expect(
      PlaytestTurnRecordSchema.parse({
        turn: 1,
        action: "A legacy record.",
        driver: "scripted",
        expectedCheckPolicy: "context_dependent",
        assignedNaturalRoll: 50,
        status: "completed",
        invariantStatus: "passed",
      }).scenarioSignals,
    ).toEqual([]);
  });

  it("accepts the shipped seed's ongoing contracts as valid declarations", async () => {
    const requirements = SetupRequirementsSchema.parse(
      JSON.parse(
        await readFile(path.join(SEEDS, "far-meridian-dead-signal", "requirements.json"), "utf8"),
      ),
    );

    // A new scenario ships as JSON: the kinds are generic, so no new code runs.
    expect(requirements.ongoing.length).toBeGreaterThan(0);
    expect(new Set(requirements.ongoing.map((entry) => entry.code)).size).toBe(
      requirements.ongoing.length,
    );
    expect(() =>
      evaluateScenarioContracts(requirements.ongoing, {
        entities: new Map(),
        threads: [],
        chronicle: [],
        elapsedMinutes: 0,
      }),
    ).not.toThrow();
  });
});
