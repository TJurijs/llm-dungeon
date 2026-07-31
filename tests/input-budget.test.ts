import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DungeonEngine } from "../src/engine.js";
import { attachStructuredFailure } from "../src/llm/structured-error.js";
import {
  APPLICATION_CONTEXT_TOKEN_BUDGET,
  APPLICATION_INPUT_TOKEN_LIMIT,
  APPLICATION_SCHEMA_FRAMING_TOKEN_RESERVE,
  conservativeInputTokenEstimate,
  inputTokenLimitForOutputBudget,
  inspectStructuredInputBudget,
} from "../src/input-budget.js";
import { GAMEPLAY_CONTEXT_TOKEN_TARGET, StateStore } from "../src/store.js";
import { adjudicationPromptDocument, DM_SYSTEM_PROMPT } from "../src/prompts.js";
import {
  entityFilename,
  renderChronicle,
  renderEntity,
  renderThreads,
  renderTurnLog,
} from "../src/persistence/markdown.js";
import type { LlmProvider, StructuredRequest, StructuredResult } from "../src/types.js";
import { createTestStore, setupFixture } from "./helpers.js";

class CountingProvider implements LlmProvider {
  readonly id = "counting";
  readonly model = "counting-model";
  calls = 0;
  requests: StructuredRequest<unknown>[] = [];

  effectiveOutputTokenBudget(): number {
    return 8_000;
  }

  async generateStructured<T>(request: StructuredRequest<T>): Promise<StructuredResult<T>> {
    this.calls += 1;
    this.requests.push(request as StructuredRequest<unknown>);
    const data = request.schemaName.endsWith("campaign_setup")
      ? setupFixture
      : {
          kind: "resolved",
          narration: "The oversized legacy rules remain available through a bounded view.",
          turnSummary: "The legacy campaign continued safely.",
          operations: [],
        };
    return {
      data: request.schema.parse(data),
      provider: this.id,
      model: this.model,
    };
  }
}

class RecoveryProvider implements LlmProvider {
  readonly id = "recovery";
  readonly model = "recovery-model";
  readonly requests: StructuredRequest<unknown>[] = [];

  constructor(private readonly mode: "schema" | "domain" | "domain_then_schema") {}

  effectiveOutputTokenBudget(): number {
    return 8_000;
  }

  async generateStructured<T>(request: StructuredRequest<T>): Promise<StructuredResult<T>> {
    this.requests.push(request as StructuredRequest<unknown>);
    if (this.requests.length === 1 && this.mode === "schema") {
      const failure = request.schema.safeParse({
        invalid: "X".repeat(24_000),
      });
      if (failure.success) throw new Error("Expected invalid schema fixture");
      attachStructuredFailure(failure.error, {
        parsedResponse: { invalid: "X".repeat(24_000) },
      });
      throw failure.error;
    }
    if (this.requests.length === 2 && this.mode === "domain_then_schema") {
      const failure = request.schema.safeParse({
        invalidCorrection: "Y".repeat(24_000),
      });
      if (failure.success) throw new Error("Expected invalid correction schema fixture");
      attachStructuredFailure(failure.error, {
        parsedResponse: { invalidCorrection: "Y".repeat(24_000) },
      });
      throw failure.error;
    }
    const data =
      this.requests.length === 1
        ? {
            kind: "resolved",
            narration: `The attempted record is rejected locally. ${"N".repeat(20_000)}`,
            turnSummary: "The attempted record could not be applied.",
            operations: [
              {
                type: "add_fact",
                targetId: "npc:nonexistent-repair-target",
                section: "knowledge",
                text: "A deliberately invalid test fact.",
              },
            ],
          }
        : {
            kind: "resolved",
            narration: "The investigation continues without inventing an unsupported record.",
            turnSummary: "The investigation continued safely.",
            operations: [],
          };
    return {
      data: request.schema.parse(data),
      provider: this.id,
      model: this.model,
    };
  }
}

/** Large enough that the maximal projection cannot fit its input allowance. */
const SATURATION_OUTPUT_RESERVE = 30_000;

async function saturateLegacyGameplayProjection(store: StateStore): Promise<void> {
  const loaded = await store.load();
  for (const entityId of [
    loaded.manifest.playerId,
    loaded.manifest.currentLocationId,
    "npc:mara-venn",
  ]) {
    const entity = loaded.entities.get(entityId)!;
    entity.facts.push(
      ...Array.from({ length: 300 }, (_, index) => ({
        id: `fact:${entityId.replace(":", "-")}-legacy-${String(index).padStart(3, "0")}`,
        section: "knowledge" as const,
        text: `Legacy durable detail ${index}: ${"x".repeat(500)}`,
        active: true,
        createdTurn: 0,
      })),
    );
    await writeFile(
      path.join(store.currentDir, "entities", entityFilename(entity.id)),
      renderEntity(entity),
      "utf8",
    );
  }
  const player = loaded.entities.get(loaded.manifest.playerId)!;
  const itemTemplate = loaded.entities.get("item:travel-sword")!;
  const locationTemplate = loaded.entities.get(loaded.manifest.currentLocationId)!;
  for (let index = 0; index < 24; index += 1) {
    const item = {
      ...structuredClone(itemTemplate),
      id: `item:legacy-tool-${String(index).padStart(2, "0")}`,
      name: `Legacy Expedition Tool ${index} ${"I".repeat(120)}`,
      inventory: [],
      facts: [],
    };
    player.inventory.push({ entityId: item.id, quantity: 1 });
    await writeFile(
      path.join(store.currentDir, "entities", entityFilename(item.id)),
      renderEntity(item),
      "utf8",
    );
    const location = {
      ...structuredClone(locationTemplate),
      id: `location:legacy-site-${String(index).padStart(2, "0")}`,
      name: `Legacy Expedition Site ${index} ${"L".repeat(140)}`,
      inventory: [],
      facts: [],
    };
    await writeFile(
      path.join(store.currentDir, "entities", entityFilename(location.id)),
      renderEntity(location),
      "utf8",
    );
  }
  await writeFile(
    path.join(store.currentDir, "entities", entityFilename(player.id)),
    renderEntity(player),
    "utf8",
  );
  await writeFile(
    path.join(store.currentDir, "scenario.md"),
    `# Campaign Rules Snapshot\n\n${"R".repeat(80_000)}\n\n# Scenario\n\n${"S".repeat(40_000)}\n`,
    "utf8",
  );
  await mkdir(path.join(store.currentDir, "setup"), { recursive: true });
  await writeFile(
    path.join(store.currentDir, "setup", "premise.md"),
    `${"P".repeat(30_000)}\n`,
    "utf8",
  );
  await writeFile(
    path.join(store.currentDir, "setup", "character-concept.md"),
    `${"C".repeat(50_000)}\n`,
    "utf8",
  );
  const threads = Array.from({ length: 20 }, (_, index) => ({
    id: `thread:legacy-investigation-${String(index).padStart(2, "0")}`,
    title: `Legacy Investigation ${index} ${"T".repeat(180)}`,
    objective: `Preserve objective ${index} ${"O".repeat(700)}`,
    summary: `Current progress ${index} ${"U".repeat(1_000)}`,
    status: "active" as const,
    relatedEntityIds: [loaded.manifest.playerId],
    createdTurn: 0,
    updatedTurn: 0,
  }));
  await writeFile(path.join(store.currentDir, "threads.md"), renderThreads(threads), "utf8");
  await writeFile(
    path.join(store.currentDir, "chronicle.md"),
    renderChronicle(
      Array.from({ length: 20 }, (_, index) => ({
        id: `event:legacy-event-${String(index).padStart(2, "0")}`,
        turn: Math.min(index + 1, 8),
        text: `Campaign-shaping event ${index} ${"E".repeat(900)}`,
      })),
    ),
    "utf8",
  );
  for (let turn = 1; turn <= 8; turn += 1) {
    await writeFile(
      path.join(store.currentDir, "turns", `${String(turn).padStart(6, "0")}.md`),
      renderTurnLog(turn, {
        action: `Legacy action ${turn} ${"A".repeat(780)}`,
        resolved: {
          narration: `Legacy narration ${turn} ${"N".repeat(5_000)}`,
          turnSummary: `Legacy summary ${turn} ${"M".repeat(1_200)}`,
          operations:
            turn === 8
              ? Array.from({ length: 12 }, (_, index) => ({
                  type: "add_fact" as const,
                  targetId: loaded.manifest.playerId,
                  section: "knowledge" as const,
                  factId: `fact:ledger-detail-${String(index).padStart(2, "0")}`,
                  text: `Already-applied ledger detail ${index} ${"D".repeat(500)}`,
                }))
              : [],
        },
        provider: "legacy",
        model: "legacy-model",
      }),
      "utf8",
    );
  }
  const manifestPath = path.join(store.currentDir, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
  manifest.turn = 8;
  manifest.updatedAt = new Date().toISOString();
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

async function addColdReferencedCompanions(store: StateStore): Promise<void> {
  const loaded = await store.load();
  const personTemplate = loaded.entities.get("npc:mara-venn")!;
  const itemTemplate = loaded.entities.get("item:travel-sword")!;
  const companions = [
    {
      id: "npc:tala-venn",
      name: "Tala Venn",
      trait:
        "Master Pilot and Engineer — Scope: expert piloting, ship diagnostics, mechanical repair, and drone operation; destroyed hardware still requires parts.",
      itemId: "item:talas-multi-tool",
      itemName: "Tala's Mechanical Multi-Tool",
      itemTrait:
        "Engineering Multi-Tool — Scope: cutting, welding, electronic hotwiring, and mechanical diagnostic readings.",
    },
    {
      id: "npc:eli-mercer",
      name: "Doctor Eli Mercer",
      trait:
        "Xenobiologist and Medical Officer — Scope: traumatic care, contaminant analysis, bio-hazard containment, and artifact observation; complex surgery requires standard medical equipment.",
      itemId: "item:elis-medical-kit",
      itemName: "Eli's Field Diagnostic Kit",
      itemTrait:
        "Field Medical Scanner — Scope: vital signs, toxic compounds, tissue trauma, and synthetic biological traces.",
    },
  ] as const;
  for (const companion of companions) {
    const item = {
      ...structuredClone(itemTemplate),
      id: companion.itemId,
      name: companion.itemName,
      traits: [companion.itemTrait],
      inventory: [],
      facts: [],
    };
    const person = {
      ...structuredClone(personTemplate),
      id: companion.id,
      name: companion.name,
      location: "location:legacy-site-00",
      traits: [companion.trait],
      inventory: [{ entityId: item.id, quantity: 1 }],
      facts: Array.from({ length: 8 }, (_, index) => ({
        id: `fact:${companion.id.replace(":", "-")}-${index}`,
        section: "knowledge" as const,
        text: `Dense companion history ${index} ${"H".repeat(180)}`,
        active: true,
        createdTurn: 0,
      })),
    };
    await writeFile(
      path.join(store.currentDir, "entities", entityFilename(item.id)),
      renderEntity(item),
      "utf8",
    );
    await writeFile(
      path.join(store.currentDir, "entities", entityFilename(person.id)),
      renderEntity(person),
      "utf8",
    );
  }
}

describe("application input budgets", () => {
  it("permits the 100k input ceiling for normal phase budgets and shrinks it when required", () => {
    expect(inputTokenLimitForOutputBudget(4_000)).toBe(100_000);
    expect(inputTokenLimitForOutputBudget(8_000)).toBe(100_000);
    expect(inputTokenLimitForOutputBudget(20_000)).toBe(100_000);
    expect(inputTokenLimitForOutputBudget(32_000)).toBe(88_000);
    expect(
      inputTokenLimitForOutputBudget(8_000) + 8_000 + APPLICATION_SCHEMA_FRAMING_TOKEN_RESERVE,
    ).toBeLessThanOrEqual(APPLICATION_CONTEXT_TOKEN_BUDGET);

    const gameplay = inspectStructuredInputBudget({
      phase: "decision",
      system: "system",
      prompt: "prompt",
      outputTokenReserve: 4_000,
    });
    const repair = inspectStructuredInputBudget({
      phase: "repair",
      system: "system",
      prompt: "prompt",
      outputTokenReserve: 8_000,
    });
    expect(gameplay).toMatchObject({
      inputTokenLimit: APPLICATION_INPUT_TOKEN_LIMIT,
      outputTokenReserve: 4_000,
    });
    expect(repair).toMatchObject({
      inputTokenLimit: APPLICATION_INPUT_TOKEN_LIMIT,
      outputTokenReserve: 8_000,
    });
  });

  it("estimates multilingual input deterministically and sorts named diagnostics by size", () => {
    expect(conservativeInputTokenEstimate("abcd")).toBe(4);
    expect(conservativeInputTokenEstimate("Привет")).toBe(6);
    expect(conservativeInputTokenEstimate("🙂")).toBe(2);

    const report = inspectStructuredInputBudget({
      phase: "decision",
      system: "system",
      prompt: "prompt",
      sections: [
        { id: "small", text: "a" },
        { id: "large", text: "abcdefgh" },
      ],
    });
    expect(report.sections.map((section) => section.id)).toEqual(["large", "small"]);
  });

  it("rejects immutable setup material that cannot fit its durable slot before calling the provider", async () => {
    const store = await createTestStore();
    const provider = new CountingProvider();
    const engine = new DungeonEngine(store, provider);

    const result = engine.generateSetup({
      worldRules: "w".repeat(APPLICATION_INPUT_TOKEN_LIMIT),
      premise: "A short premise.",
      character: "A short character.",
    });

    await expect(result).rejects.toThrow(/World and DM style requires .*5,000/);
    expect(provider.calls).toBe(0);
  });

  it("bounds oversized legacy durable context while keeping canonical Markdown lossless", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "llm-dungeon-input-budget-"));
    const store = new StateStore(path.join(root, "data"));
    const worldRules = "r".repeat(APPLICATION_INPUT_TOKEN_LIMIT);
    await store.createGame({ setup: structuredClone(setupFixture), worldRules: "Short rules." });
    await writeFile(
      path.join(store.currentDir, "scenario.md"),
      `# Campaign Rules Snapshot\n\n${worldRules}\n\n# Scenario\n\n${setupFixture.scenarioMarkdown}\n`,
      "utf8",
    );
    const provider = new CountingProvider();
    const engine = new DungeonEngine(store, provider);

    const context = await store.buildContext();
    expect(conservativeInputTokenEstimate(context)).toBeLessThanOrEqual(
      GAMEPLAY_CONTEXT_TOKEN_TARGET,
    );
    expect(context).toContain("campaign rules and scenario abbreviated");
    await expect(engine.play("I wait and listen.")).resolves.toMatchObject({ turn: 1 });
    expect(provider.calls).toBe(1);
    expect(await store.getPending()).toBeUndefined();
    expect(await readFile(path.join(store.currentDir, "scenario.md"), "utf8")).toContain(
      worldRules,
    );
  });

  it.each(["fresh play", "pending retry"])(
    "shrinks a maximal gameplay projection against the exact %s decision request",
    async (mode) => {
      const store = await createTestStore();
      await saturateLegacyGameplayProjection(store);
      const action = `I ${"carefully continue the established investigation. ".repeat(30)}`.slice(
        0,
        800,
      );
      const fullContext = await store.buildContextDocument(action);
      const unbounded = inspectStructuredInputBudget({
        phase: "decision",
        system: DM_SYSTEM_PROMPT,
        prompt: adjudicationPromptDocument(fullContext.text, action).text,
        outputTokenReserve: 8_000,
      });
      // The full projection plus the fixed instruction no longer overruns the
      // application cap at the default reserve, so the preflight is exercised
      // at a reserve large enough to force the reduced projection.
      expect(unbounded.estimatedInputTokens).toBeGreaterThan(
        inputTokenLimitForOutputBudget(SATURATION_OUTPUT_RESERVE),
      );

      if (mode === "pending retry") {
        await store.setPendingRequest({
          kind: "action",
          action,
          operationId: "00000000-0000-4000-8000-000000000021",
          phase: "requested",
        });
      }
      const provider = new CountingProvider();
      const engine = new DungeonEngine(store, provider);
      const result = mode === "pending retry" ? engine.resumePendingTurn() : engine.play(action);

      await expect(result).resolves.toMatchObject({ turn: 9 });
      expect(provider.calls).toBe(1);
      const sent = provider.requests[0]!;
      const bounded = inspectStructuredInputBudget({
        phase: "decision",
        system: sent.system,
        prompt: sent.prompt,
        outputTokenReserve: 8_000,
      });
      expect(bounded.estimatedInputTokens).toBeLessThanOrEqual(
        APPLICATION_INPUT_TOKEN_LIMIT - 1_000,
      );
      expect(sent.prompt).toContain("canonical Markdown remains complete");
      expect(await store.getPending()).toBeUndefined();
    },
  );

  it("keeps two exact cold companions, owned gear, and capability clauses in the sent request", async () => {
    const store = await createTestStore();
    await saturateLegacyGameplayProjection(store);
    await addColdReferencedCompanions(store);
    const provider = new CountingProvider();
    const action = "I ask Tala Venn and Doctor Eli Mercer to accompany me.";

    await expect(new DungeonEngine(store, provider).play(action)).resolves.toMatchObject({
      turn: 9,
    });

    expect(provider.calls).toBe(1);
    const prompt = provider.requests[0]!.prompt;
    expect(prompt).toContain("ENTITY [npc:tala-venn]");
    expect(prompt).toContain("Master Pilot and Engineer");
    expect(prompt).toContain("ENTITY [item:talas-multi-tool]");
    expect(prompt).toContain("Engineering Multi-Tool");
    expect(prompt).toContain("ENTITY [npc:eli-mercer]");
    expect(prompt).toContain("Xenobiologist and Medical Officer");
    expect(prompt).toContain("ENTITY [item:elis-medical-kit]");
    expect(prompt).toContain("Field Medical Scanner");
    expect(
      inspectStructuredInputBudget({
        phase: "decision",
        system: provider.requests[0]!.system,
        prompt,
        outputTokenReserve: 8_000,
      }).estimatedInputTokens,
    ).toBeLessThanOrEqual(APPLICATION_INPUT_TOKEN_LIMIT - 8_000);
  });

  it.each(["schema", "domain"] as const)(
    "keeps a saturated decision plus one bounded %s recovery inside the input envelope",
    async (mode) => {
      const store = await createTestStore();
      await saturateLegacyGameplayProjection(store);
      const provider = new RecoveryProvider(mode);
      const action = `I ${"carefully continue the established investigation. ".repeat(30)}`.slice(
        0,
        800,
      );

      await expect(new DungeonEngine(store, provider).play(action)).resolves.toMatchObject({
        turn: 9,
      });

      expect(provider.requests).toHaveLength(2);
      expect(provider.requests[1]).toMatchObject({
        generationPhase: "repair",
        repairOfPhase: "decision",
        attemptKind: mode === "schema" ? "schema_repair" : "domain_repair",
      });
      expect(provider.requests[1]!.prompt).toContain(
        mode === "schema"
          ? "structured-repair evidence abbreviated"
          : "domain-correction evidence abbreviated",
      );
      for (const request of provider.requests) {
        expect(
          inspectStructuredInputBudget({
            phase: request.generationPhase,
            system: request.system,
            prompt: request.prompt,
            outputTokenReserve: 8_000,
          }).estimatedInputTokens,
        ).toBeLessThanOrEqual(APPLICATION_INPUT_TOKEN_LIMIT);
      }
      expect(await store.getPending()).toBeUndefined();
    },
  );

  it("replaces a domain appendix with one combined bounded appendix when its correction needs schema repair", async () => {
    const store = await createTestStore();
    await saturateLegacyGameplayProjection(store);
    const provider = new RecoveryProvider("domain_then_schema");
    const action = `I ${"carefully continue the established investigation. ".repeat(30)}`.slice(
      0,
      800,
    );

    await expect(new DungeonEngine(store, provider).play(action)).resolves.toMatchObject({
      turn: 9,
    });

    expect(provider.requests).toHaveLength(3);
    expect(provider.requests[1]).toMatchObject({ attemptKind: "domain_repair" });
    expect(provider.requests[2]).toMatchObject({
      generationPhase: "repair",
      repairOfPhase: "decision",
      attemptKind: "schema_repair",
    });
    expect(provider.requests[2]!.prompt).toContain(
      "PRIOR BOUNDED RECOVERY REQUIREMENT — STILL APPLIES",
    );
    expect(provider.requests[2]!.prompt.match(/TURN DOMAIN CORRECTION/gu)).toHaveLength(1);
    expect(provider.requests[2]!.prompt.match(/STRUCTURED RESPONSE REPAIR/gu)).toHaveLength(1);
    for (const request of provider.requests) {
      expect(
        inspectStructuredInputBudget({
          phase: request.generationPhase,
          system: request.system,
          prompt: request.prompt,
          outputTokenReserve: 8_000,
        }).estimatedInputTokens,
      ).toBeLessThanOrEqual(APPLICATION_INPUT_TOKEN_LIMIT);
    }
  });

  it("applies the shared action character limit before persistence or generation", async () => {
    const store = await createTestStore();
    const provider = new CountingProvider();
    const engine = new DungeonEngine(store, provider);

    await expect(engine.play("a".repeat(10_001))).rejects.toThrow(
      "Action exceeds 10,000 characters",
    );
    expect(provider.calls).toBe(0);
    expect(await store.getPending()).toBeUndefined();
  });
});
