import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { GAMEPLAY_PROTOCOL_VERSION } from "./llm/gameplay-protocol.js";
import { LanguageCodeSchema, type LanguageCode } from "./language.js";
import { atomicWriteJson } from "./persistence/files.js";
import { acquireFileLock } from "./persistence/lock.js";

export const LLM_MODEL_CATALOG_VERSION = 1 as const;

const MODEL_CATALOG_LOCK_WAIT_MS = 5_000;
const MODEL_CATALOG_LOCK_RETRY_MS = 25;
const modelCatalogProcessQueues = new Map<string, Promise<void>>();

async function queueModelCatalogOperation<T>(lockPath: string, operation: () => Promise<T>): Promise<T> {
  const previous = modelCatalogProcessQueues.get(lockPath) ?? Promise.resolve();
  let releaseQueue!: () => void;
  const current = new Promise<void>((resolve) => { releaseQueue = resolve; });
  const tail = previous.then(() => current, () => current);
  modelCatalogProcessQueues.set(lockPath, tail);
  await previous.catch(() => undefined);
  try {
    return await operation();
  } finally {
    releaseQueue();
    if (modelCatalogProcessQueues.get(lockPath) === tail) modelCatalogProcessQueues.delete(lockPath);
  }
}

async function acquireModelCatalogLock(lockPath: string): Promise<() => Promise<void>> {
  const deadline = Date.now() + MODEL_CATALOG_LOCK_WAIT_MS;
  for (;;) {
    try {
      return await acquireFileLock(lockPath, "LLM model catalog");
    } catch (error) {
      if (!/locked by another running process/i.test(String((error as Error).message)) || Date.now() >= deadline) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, MODEL_CATALOG_LOCK_RETRY_MS));
    }
  }
}

export const LlmProviderIdSchema = z.enum([
  "gemini",
  "openrouter",
  "xai",
  "openai",
  "anthropic",
  "deepseek",
]);
export type LlmProviderId = z.infer<typeof LlmProviderIdSchema>;

export interface SupportedLlmProviderDefinition {
  id: LlmProviderId;
  label: string;
  envKey: string;
}

export interface LlmProviderDefinition extends SupportedLlmProviderDefinition {
  recommended: boolean;
  candidateModels: readonly string[];
}

/**
 * Adapter/key metadata for every provider whose persisted configurations remain
 * supported. This is deliberately broader than the public browser lineup.
 */
export const SUPPORTED_LLM_PROVIDER_DEFINITIONS = [
  { id: "gemini", label: "Google Gemini", envKey: "GEMINI_API_KEY" },
  { id: "openrouter", label: "OpenRouter", envKey: "OPENROUTER_API_KEY" },
  { id: "xai", label: "xAI", envKey: "XAI_API_KEY" },
  { id: "openai", label: "OpenAI", envKey: "OPENAI_API_KEY" },
  { id: "anthropic", label: "Anthropic", envKey: "ANTHROPIC_API_KEY" },
  { id: "deepseek", label: "DeepSeek", envKey: "DEEPSEEK_API_KEY" },
] as const satisfies readonly SupportedLlmProviderDefinition[];

const ModelIdSchema = z.string().trim().min(1).max(300);
export const ModelSelectionSchema = z.object({
  provider: LlmProviderIdSchema,
  model: ModelIdSchema,
}).strict();
export type ModelSelection = z.infer<typeof ModelSelectionSchema>;

export const ModelCompatibilityStateSchema = z.enum([
  "untested",
  "compatible",
  "failed",
  "stale",
]);
export type ModelCompatibilityState = z.infer<typeof ModelCompatibilityStateSchema>;

const ModelTestMetadataSchema = z.object({
  testedAt: z.string().datetime({ offset: true }),
  protocolVersion: z.number().int().nonnegative(),
  testFingerprint: z.string().trim().min(1).max(500),
  testedLanguages: z.array(LanguageCodeSchema),
  failedLanguages: z.array(LanguageCodeSchema).optional(),
  failureSummary: z.string().trim().min(1).max(500).optional(),
}).strict();
export type ModelTestMetadata = z.infer<typeof ModelTestMetadataSchema>;

const PersistedModelSchema = ModelSelectionSchema.extend({
  state: ModelCompatibilityStateSchema,
  enabled: z.boolean(),
  test: ModelTestMetadataSchema.optional(),
}).strict().superRefine((entry, context) => {
  const preEnabledRecommendation = entry.state === "untested"
    && entry.provider === RECOMMENDED_MODEL_SELECTION.provider
    && entry.model === RECOMMENDED_MODEL_SELECTION.model;
  if (entry.enabled && entry.state !== "compatible" && !preEnabledRecommendation) {
    context.addIssue({
      code: "custom",
      path: ["enabled"],
      message: "only compatible models or the untested recommended model may be enabled",
    });
  }
  if (entry.state !== "untested" && entry.test === undefined) {
    context.addIssue({
      code: "custom",
      path: ["test"],
      message: "tested and stale models require test metadata",
    });
  }
  if (entry.state === "untested" && entry.test !== undefined) {
    context.addIssue({
      code: "custom",
      path: ["test"],
      message: "untested models cannot have test metadata",
    });
  }
  if (entry.state === "failed" && entry.test?.failureSummary === undefined) {
    context.addIssue({
      code: "custom",
      path: ["test", "failureSummary"],
      message: "failed models require a safe failure summary",
    });
  }
  if (entry.state === "compatible" && entry.test?.testedLanguages.length === 0) {
    context.addIssue({
      code: "custom",
      path: ["test", "testedLanguages"],
      message: "compatible models require at least one tested language",
    });
  }
  const passed = new Set(entry.test?.testedLanguages ?? []);
  if (entry.test?.failedLanguages?.some((language) => passed.has(language))) {
    context.addIssue({
      code: "custom",
      path: ["test", "failedLanguages"],
      message: "a language cannot be both passed and failed",
    });
  }
});
type PersistedModel = z.infer<typeof PersistedModelSchema>;

const PersistedCatalogSchema = z.object({
  version: z.literal(LLM_MODEL_CATALOG_VERSION),
  defaultModel: ModelSelectionSchema.nullable(),
  models: z.array(PersistedModelSchema),
}).strict().superRefine((catalog, context) => {
  const seen = new Set<string>();
  for (const [index, model] of catalog.models.entries()) {
    const key = selectionKey(model);
    if (seen.has(key)) {
      context.addIssue({
        code: "custom",
        path: ["models", index],
        message: `duplicate model selection ${key}`,
      });
    }
    seen.add(key);
  }
});
type PersistedCatalog = z.infer<typeof PersistedCatalogSchema>;

/**
 * The curated public lineup, recommended default, retired curated models, and
 * shipped compatibility-probe results are data, not logic: they change when
 * providers rename models or new probe runs land, and they ship in
 * defaults/llm-models.json. Adapter coupling (labels, env keys, provider ids)
 * stays in code above; the data joins it by provider id.
 */
const CURATED_MODEL_DATA_URL = new URL("../defaults/llm-models.json", import.meta.url);

const ShippedModelTestDataSchema = ModelSelectionSchema.extend({
  testedAt: z.string().datetime({ offset: true }),
  protocolVersion: z.number().int().nonnegative(),
  testFingerprint: z.string().trim().min(1).max(500),
  testedLanguages: z.array(LanguageCodeSchema),
  /** Human provenance for the probe result; never surfaced to the app. */
  note: z.string().optional(),
}).strict();

const CuratedModelDataSchema = z.object({
  version: z.literal(LLM_MODEL_CATALOG_VERSION),
  recommended: ModelSelectionSchema,
  providers: z.array(z.object({
    id: LlmProviderIdSchema,
    recommended: z.boolean(),
    candidateModels: z.array(ModelIdSchema).min(1),
  }).strict()).min(1),
  retiredModels: z.array(ModelSelectionSchema),
  shippedTests: z.array(ShippedModelTestDataSchema),
}).strict();

const CURATED_MODEL_DATA = CuratedModelDataSchema.parse(
  JSON.parse(readFileSync(CURATED_MODEL_DATA_URL, "utf8")),
);

export const RECOMMENDED_MODEL_SELECTION: ModelSelection = CURATED_MODEL_DATA.recommended;

/** Public browser provider metadata only. Credentials never enter the catalog. */
export const PUBLIC_LLM_PROVIDER_DEFINITIONS: readonly LlmProviderDefinition[] =
  CURATED_MODEL_DATA.providers.map((provider) => {
    const supported = SUPPORTED_LLM_PROVIDER_DEFINITIONS.find((entry) => entry.id === provider.id);
    if (!supported) {
      throw new Error(`Curated provider ${provider.id} has no supported adapter definition`);
    }
    return {
      ...supported,
      recommended: provider.recommended,
      candidateModels: provider.candidateModels,
    };
  });

if (!PUBLIC_LLM_PROVIDER_DEFINITIONS.some((provider) =>
  provider.id === RECOMMENDED_MODEL_SELECTION.provider
  && provider.candidateModels.includes(RECOMMENDED_MODEL_SELECTION.model))) {
  throw new Error("The recommended model must be a curated candidate of a public provider");
}

/** Backward-compatible name for callers interested in the curated public lineup. */
export const LLM_PROVIDER_DEFINITIONS = PUBLIC_LLM_PROVIDER_DEFINITIONS;

export interface CatalogModel extends ModelSelection {
  candidate: boolean;
  state: ModelCompatibilityState;
  enabled: boolean;
  test?: ModelTestMetadata;
}

export interface CatalogProvider {
  id: LlmProviderId;
  label: string;
  envKey: string;
  public: boolean;
  recommended: boolean;
  models: CatalogModel[];
}

export interface LlmModelCatalogSnapshot {
  version: typeof LLM_MODEL_CATALOG_VERSION;
  defaultModel: ModelSelection | null;
  providers: CatalogProvider[];
}

export interface LlmModelCatalogOptions {
  /** Changes whenever the real compatibility probe or language registry changes. */
  testFingerprint: string;
  protocolVersion?: number;
  legacySelection?: ModelSelection;
  now?: () => Date;
}

export interface TestSuccessInput {
  testedLanguages: readonly LanguageCode[];
}

export interface TestFailureInput {
  /** Omit for a model-wide failure; provide languages for independent probe failures. */
  failedLanguages?: readonly LanguageCode[];
  /** A caller-produced, redacted diagnostic summary; raw provider output is not accepted. */
  failureSummary: string;
}

export class ModelUnavailableError extends Error {
  constructor(
    readonly selection: ModelSelection,
    readonly reason: "unregistered" | "untested" | "failed" | "stale" | "disabled" | "language",
    message: string,
  ) {
    super(message);
    this.name = "ModelUnavailableError";
  }
}

function selectionKey(selection: ModelSelection): string {
  return `${selection.provider}\u0000${selection.model}`;
}

/**
 * Models that were previously curated remain valid persisted references, but
 * must not be mistaken for user-added custom models or public choices.
 */
const RETIRED_CURATED_MODEL_KEYS = new Set(
  CURATED_MODEL_DATA.retiredModels.map((selection) => selectionKey(selection)),
);

export function isRetiredCuratedModel(selection: ModelSelection): boolean {
  return RETIRED_CURATED_MODEL_KEYS.has(selectionKey(selection));
}

const SHIPPED_MODEL_TESTS: Readonly<Record<string, ModelTestMetadata>> = Object.fromEntries(
  CURATED_MODEL_DATA.shippedTests.map(({ provider, model, note: _note, ...test }) => [
    selectionKey({ provider, model }),
    ModelTestMetadataSchema.parse(test),
  ]),
);

function shippedModel(
  selection: ModelSelection,
  protocolVersion: number,
  testFingerprint: string,
): PersistedModel | undefined {
  const test = SHIPPED_MODEL_TESTS[selectionKey(selection)];
  if (test === undefined
    || test.protocolVersion !== protocolVersion
    || test.testFingerprint !== testFingerprint) return undefined;
  return {
    ...selection,
    state: "compatible",
    enabled: true,
    test: structuredClone(test),
  };
}

function sameSelection(left: ModelSelection | null, right: ModelSelection): boolean {
  return left?.provider === right.provider && left.model === right.model;
}

function normalizeLanguages(languages: readonly LanguageCode[]): LanguageCode[] {
  return [...new Set(languages.map((language) => LanguageCodeSchema.parse(language)))].sort();
}

function safeFailureSummary(value: string): string {
  const summary = value.replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 500).trim();
  if (!summary) throw new Error("A safe failure summary is required");
  return summary;
}

function isRecommended(selection: ModelSelection): boolean {
  return selection.provider === RECOMMENDED_MODEL_SELECTION.provider
    && selection.model === RECOMMENDED_MODEL_SELECTION.model;
}

function untestedModel(selection: ModelSelection): PersistedModel {
  return { ...selection, state: "untested", enabled: isRecommended(selection) };
}

function isCurrentTest(
  model: PersistedModel,
  protocolVersion: number,
  testFingerprint: string,
): boolean {
  return model.test?.protocolVersion === protocolVersion
    && model.test.testFingerprint === testFingerprint;
}

function isValidDefault(catalog: PersistedCatalog, selection: ModelSelection | null): boolean {
  if (selection === null) return false;
  const model = catalog.models.find((candidate) => sameSelection(candidate, selection));
  return model?.enabled === true && (
    model.state === "compatible"
    || (model.state === "untested" && isRecommended(model))
  );
}

function canonicalize(
  input: PersistedCatalog,
  additions: readonly ModelSelection[],
  protocolVersion: number,
  testFingerprint: string,
): PersistedCatalog {
  const models = new Map<string, PersistedModel>();
  for (const model of input.models) {
    const stale = model.state !== "untested"
      && model.state !== "stale"
      && !isCurrentTest(model, protocolVersion, testFingerprint);
    const normalized = stale ? { ...model, state: "stale" as const, enabled: false } : model;
    models.set(selectionKey(normalized), normalized);
  }
  for (const selection of additions) {
    const key = selectionKey(selection);
    const existing = models.get(key);
    const shipped = shippedModel(selection, protocolVersion, testFingerprint);
    if (existing === undefined) models.set(key, shipped ?? untestedModel(selection));
    else if (existing.state === "untested" && shipped !== undefined) models.set(key, shipped);
  }

  const ordered: PersistedModel[] = [];
  for (const definition of SUPPORTED_LLM_PROVIDER_DEFINITIONS) {
    const providerModels = [...models.values()].filter((model) => model.provider === definition.id);
    const publicDefinition = PUBLIC_LLM_PROVIDER_DEFINITIONS.find((candidate) => candidate.id === definition.id);
    const candidateOrder = new Map<string, number>(
      (publicDefinition?.candidateModels ?? []).map((model, index): [string, number] => [model, index]),
    );
    providerModels.sort((left, right) => {
      const leftOrder = candidateOrder.get(left.model) ?? Number.MAX_SAFE_INTEGER;
      const rightOrder = candidateOrder.get(right.model) ?? Number.MAX_SAFE_INTEGER;
      return leftOrder - rightOrder || left.model.localeCompare(right.model);
    });
    ordered.push(...providerModels);
  }

  const candidate: PersistedCatalog = {
    version: LLM_MODEL_CATALOG_VERSION,
    defaultModel: input.defaultModel,
    models: ordered,
  };
  if (!isValidDefault(candidate, candidate.defaultModel)) candidate.defaultModel = null;
  return PersistedCatalogSchema.parse(candidate);
}

function codeOwnedCandidates(): ModelSelection[] {
  return PUBLIC_LLM_PROVIDER_DEFINITIONS.flatMap((provider) => provider.candidateModels.map((model) => ({
    provider: provider.id,
    model,
  })));
}

function snapshotsEqual(left: PersistedCatalog, right: PersistedCatalog): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export class LlmModelCatalog {
  readonly filePath: string;
  readonly lockPath: string;
  private readonly testFingerprint: string;
  private readonly protocolVersion: number;
  private readonly legacySelection: ModelSelection | undefined;
  private readonly now: () => Date;

  constructor(readonly root: string, options: LlmModelCatalogOptions) {
    this.filePath = path.join(root, "config", "llm-models.json");
    this.lockPath = path.join(root, "config", ".llm-models.lock");
    this.testFingerprint = z.string().trim().min(1).max(500).parse(options.testFingerprint);
    this.protocolVersion = z.number().int().nonnegative().parse(
      options.protocolVersion ?? GAMEPLAY_PROTOCOL_VERSION,
    );
    this.legacySelection = options.legacySelection === undefined
      ? undefined
      : ModelSelectionSchema.parse(options.legacySelection);
    this.now = options.now ?? (() => new Date());
  }

  async snapshot(legacySelection?: ModelSelection): Promise<LlmModelCatalogSnapshot> {
    return this.exclusive(async () => {
      const { catalog, changed } = await this.load(legacySelection);
      if (changed) await this.write(catalog);
      return this.toSnapshot(catalog);
    });
  }

  async addModel(selection: ModelSelection): Promise<LlmModelCatalogSnapshot> {
    const parsed = ModelSelectionSchema.parse(selection);
    return this.mutate((catalog) => {
      if (!catalog.models.some((model) => sameSelection(model, parsed))) {
        catalog.models.push(untestedModel(parsed));
      }
    });
  }

  async recordTestSuccess(
    selection: ModelSelection,
    input: TestSuccessInput,
  ): Promise<LlmModelCatalogSnapshot> {
    const parsed = ModelSelectionSchema.parse(selection);
    const testedLanguages = normalizeLanguages(input.testedLanguages);
    if (testedLanguages.length === 0) throw new Error("At least one tested language is required");
    return this.mutate((catalog) => {
      const model = this.ensureModel(catalog, parsed);
      const current = isCurrentTest(model, this.protocolVersion, this.testFingerprint)
        ? model.test
        : undefined;
      const passedLanguages = normalizeLanguages([
        ...(current?.testedLanguages ?? []),
        ...testedLanguages,
      ]);
      const failedLanguages = normalizeLanguages(
        (current?.failedLanguages ?? []).filter((language) => !testedLanguages.includes(language)),
      );
      model.state = "compatible";
      model.enabled = true;
      model.test = {
        testedAt: this.timestamp(),
        protocolVersion: this.protocolVersion,
        testFingerprint: this.testFingerprint,
        testedLanguages: passedLanguages,
        ...(failedLanguages.length === 0 ? {} : { failedLanguages }),
        ...(failedLanguages.length === 0 || current?.failureSummary === undefined
          ? {}
          : { failureSummary: current.failureSummary }),
      };
      if (!isValidDefault(catalog, catalog.defaultModel)) catalog.defaultModel = parsed;
    });
  }

  async recordTestFailure(
    selection: ModelSelection,
    input: TestFailureInput,
  ): Promise<LlmModelCatalogSnapshot> {
    const parsed = ModelSelectionSchema.parse(selection);
    const failedLanguages = normalizeLanguages(input.failedLanguages ?? []);
    const failureSummary = safeFailureSummary(input.failureSummary);
    return this.mutate((catalog) => {
      const model = this.ensureModel(catalog, parsed);
      const current = isCurrentTest(model, this.protocolVersion, this.testFingerprint)
        ? model.test
        : undefined;
      const testedLanguages = failedLanguages.length === 0
        ? []
        : normalizeLanguages(
          (current?.testedLanguages ?? []).filter((language) => !failedLanguages.includes(language)),
        );
      const allFailedLanguages = failedLanguages.length === 0
        ? []
        : normalizeLanguages([...(current?.failedLanguages ?? []), ...failedLanguages]);
      model.state = testedLanguages.length === 0 ? "failed" : "compatible";
      if (model.state === "failed") model.enabled = false;
      model.test = {
        testedAt: this.timestamp(),
        protocolVersion: this.protocolVersion,
        testFingerprint: this.testFingerprint,
        testedLanguages,
        ...(allFailedLanguages.length === 0 ? {} : { failedLanguages: allFailedLanguages }),
        failureSummary,
      };
      if (model.state === "failed" && sameSelection(catalog.defaultModel, parsed)) catalog.defaultModel = null;
    });
  }

  async removeModel(selection: ModelSelection): Promise<LlmModelCatalogSnapshot> {
    const parsed = ModelSelectionSchema.parse(selection);
    return this.mutate((catalog) => {
      if (codeOwnedCandidates().some((candidate) => sameSelection(candidate, parsed))) {
        throw new Error(`Known model ${parsed.provider}/${parsed.model} cannot be removed`);
      }
      if (sameSelection(catalog.defaultModel, parsed)) {
        throw new Error(`Default model ${parsed.provider}/${parsed.model} cannot be removed`);
      }
      const index = catalog.models.findIndex((model) => sameSelection(model, parsed));
      if (index < 0) throw new Error(`Model ${parsed.provider}/${parsed.model} was not found`);
      catalog.models.splice(index, 1);
    });
  }

  async setEnabled(selection: ModelSelection, enabled: boolean): Promise<LlmModelCatalogSnapshot> {
    const parsed = ModelSelectionSchema.parse(selection);
    return this.mutate((catalog) => {
      const model = this.ensureModel(catalog, parsed);
      if (enabled && model.state !== "compatible") {
        throw new ModelUnavailableError(parsed, model.state, `Model ${parsed.model} is ${model.state}, not compatible`);
      }
      model.enabled = enabled;
      if (!enabled && sameSelection(catalog.defaultModel, parsed)) catalog.defaultModel = null;
    });
  }

  async setDefault(selection: ModelSelection): Promise<LlmModelCatalogSnapshot> {
    const parsed = ModelSelectionSchema.parse(selection);
    return this.mutate((catalog) => {
      const model = this.ensureModel(catalog, parsed);
      if (model.state !== "compatible") {
        throw new ModelUnavailableError(parsed, model.state, `Model ${parsed.model} is ${model.state}, not compatible`);
      }
      if (!model.enabled) {
        throw new ModelUnavailableError(parsed, "disabled", `Model ${parsed.model} is disabled`);
      }
      catalog.defaultModel = parsed;
    });
  }

  async assertAvailable(selection: ModelSelection, language: LanguageCode): Promise<CatalogModel> {
    const parsed = ModelSelectionSchema.parse(selection);
    const parsedLanguage = LanguageCodeSchema.parse(language);
    const snapshot = await this.snapshot();
    const model = snapshot.providers
      .find((provider) => provider.id === parsed.provider)
      ?.models.find((candidate) => sameSelection(candidate, parsed));
    if (model === undefined) {
      throw new ModelUnavailableError(parsed, "unregistered", `Model ${parsed.provider}/${parsed.model} is not registered`);
    }
    if (model.state !== "compatible") {
      throw new ModelUnavailableError(parsed, model.state, `Model ${parsed.model} is ${model.state}, not compatible`);
    }
    if (!model.enabled) {
      throw new ModelUnavailableError(parsed, "disabled", `Model ${parsed.model} is disabled`);
    }
    if (!model.test?.testedLanguages.includes(parsedLanguage)) {
      throw new ModelUnavailableError(
        parsed,
        "language",
        `Model ${parsed.model} has not passed compatibility testing for ${parsedLanguage}`,
      );
    }
    return model;
  }

  private async mutate(change: (catalog: PersistedCatalog) => void): Promise<LlmModelCatalogSnapshot> {
    return this.exclusive(async () => {
      const { catalog } = await this.load();
      change(catalog);
      const canonical = canonicalize(
        PersistedCatalogSchema.parse(catalog),
        this.additions(),
        this.protocolVersion,
        this.testFingerprint,
      );
      await this.write(canonical);
      return this.toSnapshot(canonical);
    });
  }

  private async load(additionalLegacySelection?: ModelSelection): Promise<{
    catalog: PersistedCatalog;
    changed: boolean;
  }> {
    let persisted: PersistedCatalog;
    let missing = false;
    try {
      persisted = PersistedCatalogSchema.parse(JSON.parse(await readFile(this.filePath, "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      missing = true;
      persisted = {
        version: LLM_MODEL_CATALOG_VERSION,
        defaultModel: RECOMMENDED_MODEL_SELECTION,
        models: [],
      };
    }
    const additions = this.additions(additionalLegacySelection);
    const catalog = canonicalize(persisted, additions, this.protocolVersion, this.testFingerprint);
    return { catalog, changed: missing || !snapshotsEqual(persisted, catalog) };
  }

  private additions(additionalLegacySelection?: ModelSelection): ModelSelection[] {
    return [
      ...codeOwnedCandidates(),
      ...(this.legacySelection === undefined ? [] : [this.legacySelection]),
      ...(additionalLegacySelection === undefined ? [] : [ModelSelectionSchema.parse(additionalLegacySelection)]),
    ];
  }

  private ensureModel(catalog: PersistedCatalog, selection: ModelSelection): PersistedModel {
    let model = catalog.models.find((candidate) => sameSelection(candidate, selection));
    if (model === undefined) {
      model = untestedModel(selection);
      catalog.models.push(model);
    }
    return model;
  }

  private timestamp(): string {
    const date = this.now();
    if (Number.isNaN(date.getTime())) throw new Error("Catalog clock returned an invalid date");
    return date.toISOString();
  }

  private async write(catalog: PersistedCatalog): Promise<void> {
    await atomicWriteJson(this.filePath, PersistedCatalogSchema.parse(catalog));
  }

  private toSnapshot(catalog: PersistedCatalog): LlmModelCatalogSnapshot {
    return {
      version: LLM_MODEL_CATALOG_VERSION,
      defaultModel: catalog.defaultModel,
      providers: SUPPORTED_LLM_PROVIDER_DEFINITIONS.map((definition) => {
        const publicDefinition = PUBLIC_LLM_PROVIDER_DEFINITIONS.find(
          (candidate) => candidate.id === definition.id,
        );
        return {
          id: definition.id,
          label: definition.label,
          envKey: definition.envKey,
          public: publicDefinition !== undefined,
          recommended: publicDefinition?.recommended ?? false,
          models: catalog.models
            .filter((model) => model.provider === definition.id)
            .map((model) => ({
              provider: model.provider,
              model: model.model,
              candidate: (publicDefinition?.candidateModels as readonly string[] | undefined)
                ?.includes(model.model) ?? false,
              state: model.state,
              enabled: model.enabled,
              ...(model.test === undefined ? {} : { test: model.test }),
            })),
        };
      }),
    };
  }

  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    return queueModelCatalogOperation(path.resolve(this.lockPath), async () => {
      const release = await acquireModelCatalogLock(this.lockPath);
      try {
        return await operation();
      } finally {
        await release();
      }
    });
  }
}
