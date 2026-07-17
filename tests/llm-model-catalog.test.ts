import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  LLM_MODEL_CATALOG_VERSION,
  LLM_PROVIDER_DEFINITIONS,
  RECOMMENDED_MODEL_SELECTION,
  LlmModelCatalog,
  ModelUnavailableError,
  type LlmModelCatalogSnapshot,
  type ModelSelection,
} from "../src/llm-model-catalog.js";

const roots: string[] = [];
const now = new Date("2026-07-17T12:34:56.000Z");

async function temporaryProject(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "llm-dungeon-model-catalog-"));
  roots.push(root);
  return root;
}

function catalog(root: string, options: {
  fingerprint?: string;
  protocolVersion?: number;
  legacySelection?: ModelSelection;
} = {}): LlmModelCatalog {
  return new LlmModelCatalog(root, {
    testFingerprint: options.fingerprint ?? "connection-probe-v1:languages=en,ru",
    ...(options.protocolVersion === undefined ? {} : { protocolVersion: options.protocolVersion }),
    ...(options.legacySelection === undefined ? {} : { legacySelection: options.legacySelection }),
    now: () => now,
  });
}

function model(
  snapshot: LlmModelCatalogSnapshot,
  selection: ModelSelection,
) {
  return snapshot.providers
    .find((provider) => provider.id === selection.provider)
    ?.models.find((candidate) => candidate.model === selection.model);
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("LLM provider definitions", () => {
  it("owns public metadata and curated candidates for every supported provider", () => {
    expect(LLM_PROVIDER_DEFINITIONS.map((provider) => provider.id)).toEqual([
      "gemini",
      "openrouter",
      "openai",
      "anthropic",
      "deepseek",
    ]);
    expect(LLM_PROVIDER_DEFINITIONS.map((provider) => provider.envKey)).toEqual([
      "GEMINI_API_KEY",
      "OPENROUTER_API_KEY",
      "OPENAI_API_KEY",
      "ANTHROPIC_API_KEY",
      "DEEPSEEK_API_KEY",
    ]);
    for (const provider of LLM_PROVIDER_DEFINITIONS) {
      expect(provider.label).not.toBe("");
      expect(provider.candidateModels.length).toBeGreaterThan(0);
      expect(new Set(provider.candidateModels).size).toBe(provider.candidateModels.length);
    }
    expect(LLM_PROVIDER_DEFINITIONS.find((provider) => provider.id === "openrouter")?.candidateModels).toEqual([
      "moonshotai/kimi-k2.6",
      "qwen/qwen3.7-plus",
      "x-ai/grok-4.5",
    ]);
    expect(LLM_PROVIDER_DEFINITIONS.find((provider) => provider.id === "openai")?.candidateModels)
      .toContain("gpt-5.6-sol");
    expect(LLM_PROVIDER_DEFINITIONS.find((provider) => provider.id === "anthropic")?.candidateModels).toEqual([
      "claude-sonnet-4-6",
      "claude-haiku-4-5",
    ]);
    expect(LLM_PROVIDER_DEFINITIONS.find((provider) => provider.id === "deepseek")?.candidateModels).toEqual([
      "deepseek-v4-flash",
    ]);
    expect(RECOMMENDED_MODEL_SELECTION).toEqual({ provider: "gemini", model: "gemini-3.5-flash" });
  });
});

describe("LLM model catalog persistence", () => {
  it("bootstraps the fixed versioned file and merges a legacy selection as untested", async () => {
    const root = await temporaryProject();
    const legacySelection = { provider: "openrouter", model: "vendor/legacy-model" } as const;
    const registry = catalog(root, { legacySelection });

    const snapshot = await registry.snapshot();
    expect(snapshot.version).toBe(LLM_MODEL_CATALOG_VERSION);
    expect(snapshot.defaultModel).toBeNull();
    expect(snapshot.providers).toHaveLength(5);
    expect(model(snapshot, legacySelection)).toMatchObject({
      ...legacySelection,
      candidate: false,
      state: "untested",
      enabled: false,
    });
    expect(model(snapshot, { provider: "gemini", model: "gemini-3.5-flash" })).toMatchObject({
      candidate: true,
      state: "untested",
      enabled: false,
    });

    const persistedPath = path.join(root, "config", "llm-models.json");
    const firstWrite = await readFile(persistedPath, "utf8");
    expect(JSON.parse(firstWrite)).toMatchObject({
      version: 1,
      defaultModel: null,
    });
    expect(firstWrite.endsWith("\n")).toBe(true);

    expect(await registry.snapshot()).toEqual(snapshot);
    expect(await readFile(persistedPath, "utf8")).toBe(firstWrite);
    expect((await readdir(path.join(root, "config"))).filter((name) => name.includes(".tmp-"))).toEqual([]);
  });

  it("adds arbitrary provider model IDs without duplicating them", async () => {
    const root = await temporaryProject();
    const registry = catalog(root);
    const custom = { provider: "anthropic", model: "claude-private-preview" } as const;

    await registry.addModel(custom);
    const snapshot = await registry.addModel(custom);

    expect(snapshot.providers.find((provider) => provider.id === "anthropic")?.models
      .filter((candidate) => candidate.model === custom.model)).toHaveLength(1);
    expect(model(snapshot, custom)).toMatchObject({ candidate: false, state: "untested", enabled: false });
  });

  it("preserves removed curated models only as non-candidate legacy selections", async () => {
    const root = await temporaryProject();
    const removed = { provider: "deepseek", model: "deepseek-v4-pro" } as const;

    const snapshot = await catalog(root, { legacySelection: removed }).snapshot();

    expect(model(snapshot, removed)).toMatchObject({
      ...removed,
      candidate: false,
      state: "untested",
      enabled: false,
    });
  });

  it("merges newly shipped candidates into an existing catalog idempotently", async () => {
    const root = await temporaryProject();
    const target = path.join(root, "config", "llm-models.json");
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, `${JSON.stringify({
      version: 1,
      defaultModel: null,
      models: [{ provider: "openai", model: "private-model", state: "untested", enabled: false }],
    }, null, 2)}\n`, "utf8");

    const registry = catalog(root);
    const first = await registry.snapshot();
    expect(model(first, { provider: "openai", model: "private-model" })).toBeDefined();
    for (const definition of LLM_PROVIDER_DEFINITIONS) {
      for (const candidate of definition.candidateModels) {
        expect(model(first, { provider: definition.id, model: candidate })).toBeDefined();
      }
    }
    const afterMigration = await readFile(target, "utf8");
    await registry.snapshot();
    expect(await readFile(target, "utf8")).toBe(afterMigration);
  });

  it("serializes concurrent mutations across catalog instances as complete atomic documents", async () => {
    const root = await temporaryProject();
    const registries = [catalog(root), catalog(root), catalog(root)];
    const selections = [
      { provider: "openai", model: "custom-a" },
      { provider: "anthropic", model: "custom-b" },
      { provider: "deepseek", model: "custom-c" },
    ] as const;

    await Promise.all(selections.map((selection, index) => registries[index].addModel(selection)));

    const raw = await readFile(path.join(root, "config", "llm-models.json"), "utf8");
    const persisted = JSON.parse(raw) as { models: ModelSelection[] };
    for (const selection of selections) {
      expect(persisted.models).toContainEqual(expect.objectContaining(selection));
    }
    expect((await readdir(path.join(root, "config"))).filter((name) => name.includes(".tmp-"))).toEqual([]);
  });

  it("fails closed without replacing malformed or unsupported persisted data", async () => {
    const root = await temporaryProject();
    const target = path.join(root, "config", "llm-models.json");
    await mkdir(path.dirname(target), { recursive: true });
    const unsupported = '{"version":99,"defaultModel":null,"models":[]}\n';
    await writeFile(target, unsupported, "utf8");

    await expect(catalog(root).snapshot()).rejects.toThrow();
    expect(await readFile(target, "utf8")).toBe(unsupported);

    const malformed = "{definitely-not-json\n";
    await writeFile(target, malformed, "utf8");
    await expect(catalog(root).snapshot()).rejects.toThrow();
    expect(await readFile(target, "utf8")).toBe(malformed);
  });
});

describe("LLM model compatibility lifecycle", () => {
  const first = { provider: "openai", model: "gpt-5" } as const;
  const second = { provider: "anthropic", model: "claude-sonnet-4-5" } as const;

  it("records success, auto-enables, and chooses a default only when one is absent", async () => {
    const root = await temporaryProject();
    const registry = catalog(root, { protocolVersion: 7 });

    let snapshot = await registry.recordTestSuccess(first, { testedLanguages: ["ru", "en", "ru"] });
    expect(snapshot.defaultModel).toEqual(first);
    expect(model(snapshot, first)).toEqual(expect.objectContaining({
      ...first,
      state: "compatible",
      enabled: true,
      test: {
        testedAt: now.toISOString(),
        protocolVersion: 7,
        testFingerprint: "connection-probe-v1:languages=en,ru",
        testedLanguages: ["en", "ru"],
      },
    }));

    snapshot = await registry.recordTestSuccess(second, { testedLanguages: ["en"] });
    expect(snapshot.defaultModel).toEqual(first);
    snapshot = await registry.setDefault(second);
    expect(snapshot.defaultModel).toEqual(second);
  });

  it("records only a bounded safe failure summary, disables, and clears the default", async () => {
    const root = await temporaryProject();
    const registry = catalog(root);
    await registry.recordTestSuccess(first, { testedLanguages: ["en", "ru"] });
    const unsafeShape = {
      testedLanguages: ["en"] as const,
      failureSummary: `  schema rejected\n${"x".repeat(600)}  `,
      apiKey: "must-not-be-persisted",
      rawOutput: "must-not-be-persisted",
    };

    const snapshot = await registry.recordTestFailure(first, unsafeShape);
    const failed = model(snapshot, first);
    expect(snapshot.defaultModel).toBeNull();
    expect(failed).toMatchObject({ state: "failed", enabled: false });
    expect(failed?.test?.failureSummary).not.toContain("\n");
    expect(failed?.test?.failureSummary).toHaveLength(500);

    const persisted = await readFile(path.join(root, "config", "llm-models.json"), "utf8");
    expect(persisted).not.toContain("must-not-be-persisted");
    await expect(registry.setEnabled(first, true)).rejects.toBeInstanceOf(ModelUnavailableError);
  });

  it("enforces enabled state and language-specific availability", async () => {
    const root = await temporaryProject();
    const registry = catalog(root);
    await registry.recordTestSuccess(first, { testedLanguages: ["en"] });

    await expect(registry.assertAvailable(first, "en")).resolves.toMatchObject(first);
    await expect(registry.assertAvailable(first, "ru")).rejects.toMatchObject({ reason: "language" });

    let snapshot = await registry.setEnabled(first, false);
    expect(snapshot.defaultModel).toBeNull();
    await expect(registry.assertAvailable(first, "en")).rejects.toMatchObject({ reason: "disabled" });

    snapshot = await registry.setEnabled(first, true);
    expect(model(snapshot, first)?.enabled).toBe(true);
    expect(snapshot.defaultModel).toBeNull();
    await registry.setDefault(first);
    await expect(registry.assertAvailable({ provider: "openai", model: "not-added" }, "en"))
      .rejects.toMatchObject({ reason: "unregistered" });
  });

  it("marks tested models stale on probe fingerprint changes and requires a retest", async () => {
    const root = await temporaryProject();
    const original = catalog(root, { fingerprint: "probe-a", protocolVersion: 1 });
    await original.recordTestSuccess(first, { testedLanguages: ["en", "ru"] });

    const changedProbe = catalog(root, { fingerprint: "probe-b", protocolVersion: 1 });
    let snapshot = await changedProbe.snapshot();
    expect(model(snapshot, first)).toMatchObject({ state: "stale", enabled: false });
    expect(snapshot.defaultModel).toBeNull();
    await expect(changedProbe.assertAvailable(first, "en")).rejects.toMatchObject({ reason: "stale" });
    await expect(changedProbe.setEnabled(first, true)).rejects.toMatchObject({ reason: "stale" });

    snapshot = await changedProbe.recordTestSuccess(first, { testedLanguages: ["ru"] });
    expect(model(snapshot, first)).toMatchObject({ state: "compatible", enabled: true });
    expect(snapshot.defaultModel).toEqual(first);
    await expect(changedProbe.assertAvailable(first, "ru")).resolves.toBeDefined();

    const changedProtocol = catalog(root, { fingerprint: "probe-b", protocolVersion: 2 });
    snapshot = await changedProtocol.snapshot();
    expect(model(snapshot, first)).toMatchObject({ state: "stale", enabled: false });
  });
});
