import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { StateStore, validateInitialSetup } from "../src/store.js";
import {
  PLAYTEST_ENGINE_VERSION,
  PLAYER_PROFILES,
  PlaytestManifestSchema,
  PlaytestPackageSchema,
  PlaytestRunConfigSchema,
  ProfileIdSchema,
} from "../tools/playtest/harness/contracts.js";
import { hashPlaytestValue } from "../tools/playtest/harness/files.js";
import {
  ADVERSARIAL_BOUNDARIES_PACKAGE,
  CAMPAIGN_AUTOPLAY_PACKAGE,
  CERTIFICATION_CANONICAL_SETUPS,
  CERTIFICATION_CANONICAL_WORLD_RULES,
  CERTIFICATION_PACKAGE,
  CERTIFICATION_SCRIPT,
  MECHANICS_PACKAGE,
  PERSISTENCE_SOAK_PACKAGE,
  TUNING_PACKAGE,
  getPlaytestPackage,
  listPlaytestPackages,
} from "../tools/playtest/harness/packages.js";

const candidate = {
  config: {
    provider: "gemini" as const,
    model: "gemini-3.5-flash",
    temperature: 0.8,
    maxOutputTokens: 4_000,
  },
  route: "direct",
  executionProfileFingerprint: "profile-sha256",
};

describe("versioned playtest packages", () => {
  it("registers exactly the six initial packages behind defensive copies", () => {
    const packages = listPlaytestPackages();
    expect(packages.map((playtestPackage) => playtestPackage.id)).toEqual([
      "certification-v1",
      "campaign-autoplay-v1",
      "persistence-soak-v1",
      "adversarial-boundaries-v1",
      "mechanics-v1",
      "tuning-v1",
    ]);
    expect(packages.map((playtestPackage) => playtestPackage.version)).toEqual([3, 1, 1, 1, 1, 1]);
    expect(packages.map((playtestPackage) => playtestPackage.purpose)).toEqual([
      "certification", "autoplay", "stress", "stress", "stress", "tuning",
    ]);
    packages[0]!.description.en = "mutated copy";
    expect(getPlaytestPackage("certification-v1").description.en).not.toBe("mutated copy");
    expect(() => getPlaytestPackage("missing-v1")).toThrow("Unknown playtest package");
  });

  it("preserves all nine behavior profiles for autoplay and stress use", () => {
    expect(ProfileIdSchema.options).toHaveLength(9);
    expect(PLAYER_PROFILES.map((profile) => profile.id)).toEqual([
      "curious-explorer",
      "social-manipulator",
      "cautious-investigator",
      "reckless-adventurer",
      "combat-focused",
      "creative-problem-solver",
      "rule-challenger",
      "long-term-planner",
      "chaotic",
    ]);
    expect(CAMPAIGN_AUTOPLAY_PACKAGE.playerProfiles).toEqual(PLAYER_PROFILES.map((profile) => profile.id));
    expect(PERSISTENCE_SOAK_PACKAGE.playerProfiles).toEqual(["long-term-planner"]);
    expect(ADVERSARIAL_BOUNDARIES_PACKAGE.playerProfiles).toEqual(["rule-challenger", "chaotic"]);
    expect(MECHANICS_PACKAGE.playerProfiles).toContain("combat-focused");
    expect(CERTIFICATION_PACKAGE.playerProfiles).toEqual([]);
  });

  it("ships one bilingual canonical certification state that passes production setup validation", () => {
    for (const language of ["en", "ru"] as const) {
      const setup = validateInitialSetup(CERTIFICATION_CANONICAL_SETUPS[language]);
      expect(setup.player.id).toBe("player:hero");
      expect(setup.entities.filter((entity) => entity.kind === "location")).toHaveLength(2);
      expect(setup.entities.filter((entity) => entity.kind === "person")).toHaveLength(3);
      expect(setup.entities.find((entity) => entity.id === "npc:mara-venn")?.inventory)
        .toContainEqual({ entityId: "item:moonleaf-tonic", quantity: 2 });
      expect(setup.entities.find((entity) => entity.id === "location:old-sluice")?.inventory)
        .toContainEqual({ entityId: "item:brass-gate-key", quantity: 1 });
      expect(setup.entities.find((entity) => entity.id === "location:old-sluice")?.inventory)
        .toContainEqual({ entityId: "item:customs-ledger", quantity: 1 });
      const inventoryItemIds = new Set([
        ...setup.player.inventory,
        ...setup.entities.flatMap((entity) => entity.inventory),
      ].map((entry) => entry.entityId));
      expect(setup.entities.filter((entity) => inventoryItemIds.has(entity.id)).every((entity) => entity.location === undefined))
        .toBe(true);
      expect(setup.entities.find((entity) => entity.id === "npc:serik-vale")?.secrets.length).toBeGreaterThan(0);
      expect(setup.entities.find((entity) => entity.id === "location:old-sluice")?.status).toMatch(/warning|сигнальн/i);
      expect(setup.threads).toMatchObject([{ id: "thread:missing-ledger-turn-0", title: "Missing Ledger", status: "active" }]);

      const continuation = CERTIFICATION_PACKAGE.terminalContinuation;
      expect(continuation?.afterTurn).toBe(7);
      const continuationSetup = validateInitialSetup(continuation!.startingState.setups[language]!);
      expect(continuationSetup.player).toMatchObject({
        location: "location:old-sluice",
        inventory: expect.arrayContaining([
          { entityId: "item:moonleaf-tonic", quantity: 1 },
          { entityId: "item:customs-ledger", quantity: 1 },
        ]),
      });
      expect(continuationSetup.threads).toMatchObject([{ id: "thread:missing-ledger-turn-0", status: "active" }]);
    }
  });

  it("freezes bilingual world and DM style into every canonical package and its hash", () => {
    expect(CERTIFICATION_CANONICAL_WORLD_RULES.en).toContain("Canonical World & DM Style");
    expect(CERTIFICATION_CANONICAL_WORLD_RULES.ru).toContain("Канонический мир и стиль ведущего");

    for (const playtestPackage of [CERTIFICATION_PACKAGE, TUNING_PACKAGE]) {
      expect(playtestPackage.startingState.kind).toBe("canonical");
      if (playtestPackage.startingState.kind !== "canonical") throw new Error("expected canonical package");
      expect(playtestPackage.startingState.worldRules).toEqual(CERTIFICATION_CANONICAL_WORLD_RULES);
      expect(Object.keys(playtestPackage.startingState.worldRules).sort()).toEqual(["en", "ru"]);

      const changed = structuredClone(playtestPackage);
      if (changed.startingState.kind !== "canonical") throw new Error("expected canonical package copy");
      changed.startingState.worldRules.en += "\nChanged mutable profile.";
      expect(hashPlaytestValue(changed)).not.toBe(hashPlaytestValue(playtestPackage));
    }

    const { worldRules: _omitted, ...missingRules } = CERTIFICATION_PACKAGE.startingState.kind === "canonical"
      ? CERTIFICATION_PACKAGE.startingState
      : (() => { throw new Error("expected canonical package"); })();
    expect(() => PlaytestPackageSchema.parse({
      ...CERTIFICATION_PACKAGE,
      startingState: missingRules,
    })).toThrow();
    expect(() => PlaytestPackageSchema.parse({
      ...CERTIFICATION_PACKAGE,
      startingState: {
        ...CERTIFICATION_PACKAGE.startingState,
        worldRules: { en: CERTIFICATION_CANONICAL_WORLD_RULES.en },
      },
    })).toThrow();
  });

  it("uses the application-generated stable thread ID referenced by certification coverage", async () => {
    for (const language of ["en", "ru"] as const) {
      const root = await mkdtemp(path.join(tmpdir(), `llm-dungeon-cert-${language}-`));
      const store = new StateStore(root);
      await store.createGame({
        setup: CERTIFICATION_CANONICAL_SETUPS[language],
        worldRules: "Deterministic certification world rules.",
        language,
      });
      const loaded = await store.load();
      expect(loaded.threads.map((thread) => thread.id)).toEqual(["thread:missing-ledger-turn-0"]);
      const packageReferences = JSON.stringify({
        coverage: CERTIFICATION_PACKAGE.coverageRequirements,
        script: CERTIFICATION_PACKAGE.scriptedTurns,
      });
      expect(packageReferences).toContain("thread:missing-ledger-turn-0");
      expect(packageReferences).not.toContain('"thread:missing-ledger"');
    }
  });

  it("defines ten deterministic branch-aware certification turns and exact check anchors", () => {
    expect(CERTIFICATION_SCRIPT).toHaveLength(10);
    expect(CERTIFICATION_SCRIPT.map((turn) => turn.turn)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(CERTIFICATION_SCRIPT.map((turn) => turn.naturalRoll)).toEqual([42, 55, 100, 64, 71, 82, 1, 36, 49, 93]);
    expect(CERTIFICATION_SCRIPT[2]).toMatchObject({ checkPolicy: "required", naturalRoll: 100 });
    expect(CERTIFICATION_SCRIPT[6]).toMatchObject({
      checkPolicy: "required",
      naturalRoll: 1,
      expectedFailureCampaignStatus: "none",
    });
    expect(CERTIFICATION_SCRIPT[6]?.branches[0]?.action.en).toContain("explicitly not lethal");
    expect(CERTIFICATION_SCRIPT[0]?.checkPolicy).toBe("forbidden");
    expect(CERTIFICATION_SCRIPT[8]?.checkPolicy).toBe("forbidden");
    expect(CERTIFICATION_SCRIPT[3]?.branches).toHaveLength(2);
    expect(CERTIFICATION_SCRIPT[7]?.branches).toHaveLength(2);
    expect(CERTIFICATION_SCRIPT[9]?.branches).toHaveLength(2);
    for (const turn of CERTIFICATION_SCRIPT) {
      expect(turn.branches.at(-1)?.when.kind).toBe("always");
      expect(turn.coverageRequirementIds.length).toBeGreaterThan(0);
    }
    expect(CERTIFICATION_PACKAGE).toMatchObject({
      purpose: "certification",
      turnDriver: { kind: "scripted" },
      turns: { minimum: 10, maximum: 10, default: 10 },
      rollPolicy: { kind: "scripted" },
      judgePolicy: { kind: "final", rubricVersion: 1 },
    });
  });

  it("keeps model autoplay scalable, resumable in intent, and distinct from profiles", () => {
    expect(CAMPAIGN_AUTOPLAY_PACKAGE).toMatchObject({
      purpose: "autoplay",
      turnDriver: { kind: "model" },
      turns: { minimum: 25, maximum: 200, default: 25 },
      rollPolicy: { kind: "seeded_random" },
      judgePolicy: { kind: "checkpoints_and_final" },
    });
    expect(PERSISTENCE_SOAK_PACKAGE.turnDriver.kind).toBe("hybrid");
    expect(ADVERSARIAL_BOUNDARIES_PACKAGE.turnDriver.kind).toBe("hybrid");
    expect(MECHANICS_PACKAGE.turnDriver.kind).toBe("hybrid");
    expect(PERSISTENCE_SOAK_PACKAGE.checkpointInjections?.[0]?.coverageRequirementIds).toEqual(["early-recall"]);
    expect(ADVERSARIAL_BOUNDARIES_PACKAGE.checkpointInjections?.flatMap((item) => item.coverageRequirementIds))
      .toEqual(["sandbox-resistance", "secret-safety", "action-economy"]);
    expect(MECHANICS_PACKAGE.checkpointInjections?.flatMap((item) => item.coverageRequirementIds))
      .toEqual(["check-calibration", "combat-action-economy"]);
    expect(TUNING_PACKAGE).toMatchObject({
      purpose: "tuning",
      tuningVariableLimit: 1,
      turnDriver: { kind: "scripted" },
      rollPolicy: { kind: "scripted" },
    });
  });

  it("validates scale, seed, tuning, latency, job, and package snapshots in the v2 manifest", () => {
    const config = PlaytestRunConfigSchema.parse({
      engineVersion: PLAYTEST_ENGINE_VERSION,
      package: { id: "tuning-v1", version: 1 },
      candidates: [candidate],
      languages: ["en"],
      turns: 10,
      seed: "comparison-seed",
      tuningVariable: "prompt: adjudication-prompt-reconciliation-block",
      repetitions: 2,
      globalWorkerLimit: 1,
      latencyMode: "canonical",
      providerConcurrency: { gemini: 1 },
      maxCostUsd: 3,
      judge: { policy: "final", rubricVersion: 1, target: candidate },
    });
    expect(config.turns).toBe(10);
    expect(config.seed).toBe("comparison-seed");
    const now = new Date().toISOString();
    const manifest = PlaytestManifestSchema.parse({
      schemaVersion: 2,
      kind: "playtest",
      engineVersion: 1,
      runId: "test-run",
      startedAt: now,
      updatedAt: now,
      status: "running",
      codeVersion: { commit: null, dirty: null, sourceHash: "source" },
      config,
      packageSnapshot: TUNING_PACKAGE,
      packageHash: "package-hash",
      totalEstimatedCostUsd: 0,
      jobs: [{
        id: "job-001",
        package: config.package,
        candidate,
        language: "en",
        repetition: 1,
        latencyMode: "canonical",
        status: "pending",
        completedTurns: 0,
        judge: config.judge,
        qualityStatus: "unrated",
      }],
    });
    expect(manifest.packageSnapshot.id).toBe("tuning-v1");
    expect(manifest.config.tuningVariable).toBe("prompt: adjudication-prompt-reconciliation-block");
    expect(() => PlaytestPackageSchema.parse({ ...CERTIFICATION_PACKAGE, scriptedTurns: CERTIFICATION_SCRIPT.slice(1) }))
      .toThrow(/exactly its default number of turns/);
  });
});
