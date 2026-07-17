import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  CAMPAIGNS_DIRECTORY,
  CAMPAIGN_CREATION_INTENT_FILE,
  CAMPAIGN_METADATA_FILE,
  CAMPAIGN_MIGRATION_INTENT_FILE,
  CampaignCreationIntentSchema,
  CatalogNewGameInputSchema,
  CampaignMetadataSchema,
  CampaignMigrationIntentSchema,
  campaignDirectoryName,
  campaignMetadataPath,
  campaignScopePath,
  readCampaignMetadata,
  recoverCampaignCatalogMigration,
  writeCampaignMetadata,
  type CampaignCreationIntent,
  type CampaignMetadata,
  type CampaignMigrationIntent,
  type LegacyCampaignSource,
} from "./persistence/campaign-catalog.js";
import { atomicWriteJson, pathExists, unlinkIfExists } from "./persistence/files.js";
import { acquireFileLock } from "./persistence/lock.js";
import { validatePreparedTurnLog } from "./persistence/markdown.js";
import { campaignIdAt } from "./persistence/replacement.js";
import { ProviderConfigSchema, SafeIdSchema, type GameState, type ProviderConfig } from "./schemas.js";
import {
  StateStore,
  loadCampaignDirectory,
  validateInitialSetup,
} from "./store.js";
import type { NewGameInput } from "./types.js";

export interface CampaignCatalogOptions {
  /** Applied to newly created campaigns and legacy saves migrated on first use. */
  defaultProviderConfig?: ProviderConfig;
}

export interface CampaignCreationOptions {
  providerConfig?: ProviderConfig;
  /** Stable caller token that makes an accepted setup safe to retry. */
  requestId?: string;
}

export interface CampaignCatalogSummary {
  campaignId: string;
  title: string;
  turn: number;
  status: GameState["status"];
  timeLabel: string;
  language: GameState["language"];
  createdAt: string;
  updatedAt: string;
  archived: boolean;
  archivedAt?: string;
  providerConfig?: ProviderConfig;
}

export interface CreatedCampaign {
  campaignId: string;
  state: GameState;
  store: StateStore;
}

interface CatalogEntry {
  scopeRoot: string;
  metadata: CampaignMetadata;
  manifest: GameState;
}

const catalogProcessQueues = new Map<string, Promise<void>>();
const CATALOG_LOCK_WAIT_MS = 2_000;
const CATALOG_LOCK_RETRY_MS = 20;

async function queueCatalogOperation<T>(lockPath: string, operation: () => Promise<T>): Promise<T> {
  const previous = catalogProcessQueues.get(lockPath) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  const tail = previous.then(() => current, () => current);
  catalogProcessQueues.set(lockPath, tail);
  await previous.catch(() => undefined);
  try {
    return await operation();
  } finally {
    release();
    if (catalogProcessQueues.get(lockPath) === tail) catalogProcessQueues.delete(lockPath);
  }
}

async function acquireCatalogLock(lockPath: string): Promise<() => Promise<void>> {
  const deadline = Date.now() + CATALOG_LOCK_WAIT_MS;
  for (;;) {
    try {
      return await acquireFileLock(lockPath, "Campaign catalog");
    } catch (error) {
      if (!/locked by another running process/i.test(String((error as Error).message)) || Date.now() >= deadline) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, CATALOG_LOCK_RETRY_MS));
    }
  }
}

function optionalProviderConfig(config: ProviderConfig | undefined): { providerConfig?: ProviderConfig } {
  return config === undefined ? {} : { providerConfig: ProviderConfigSchema.parse(config) };
}

function summaryOf(entry: CatalogEntry): CampaignCatalogSummary {
  const common = {
    campaignId: entry.manifest.campaignId,
    title: entry.manifest.title,
    turn: entry.manifest.turn,
    status: entry.manifest.status,
    timeLabel: entry.manifest.timeLabel,
    language: entry.manifest.language,
    createdAt: entry.manifest.createdAt,
    updatedAt: entry.manifest.updatedAt,
    archived: entry.metadata.archived,
    ...optionalProviderConfig(entry.metadata.providerConfig),
  };
  return entry.metadata.archived
    ? { ...common, archived: true, archivedAt: entry.metadata.archivedAt }
    : { ...common, archived: false };
}

function validatedNewGameInput(input: unknown): NewGameInput {
  const parsed = CatalogNewGameInputSchema.parse(input);
  const openingGeneration = parsed.openingGeneration === undefined
    ? undefined
    : {
      provider: parsed.openingGeneration.provider,
      model: parsed.openingGeneration.model,
      ...(parsed.openingGeneration.usage === undefined
        ? {}
        : { usage: parsed.openingGeneration.usage }),
    };
  return {
    setup: validateInitialSetup(parsed.setup),
    worldRules: parsed.worldRules,
    ...(parsed.language === undefined ? {} : { language: parsed.language }),
    ...(parsed.setupInput === undefined ? {} : { setupInput: parsed.setupInput }),
    ...(openingGeneration === undefined ? {} : { openingGeneration }),
  };
}

function sameMetadata(left: CampaignMetadata, right: CampaignMetadata): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function creationFingerprint(input: NewGameInput, providerConfig: ProviderConfig | undefined): string {
  return createHash("sha256")
    .update(JSON.stringify({ input, providerConfig: providerConfig ?? null }))
    .digest("hex");
}

/**
 * Scan-based registry for independent, forward-only campaign stores. The
 * manifests remain the source of display state; the tiny metadata file owns
 * only catalog lifecycle and the secret-free provider configuration.
 */
export class CampaignCatalog {
  readonly campaignsRoot: string;
  readonly lockPath: string;
  readonly migrationIntentPath: string;
  readonly creationIntentPath: string;
  private readonly defaultProviderConfig: ProviderConfig | undefined;
  private readonly lockContext = new AsyncLocalStorage<boolean>();

  constructor(readonly dataRoot: string, options: CampaignCatalogOptions = {}) {
    this.campaignsRoot = path.join(dataRoot, CAMPAIGNS_DIRECTORY);
    this.lockPath = path.join(dataRoot, ".campaign-catalog.lock");
    this.migrationIntentPath = path.join(dataRoot, CAMPAIGN_MIGRATION_INTENT_FILE);
    this.creationIntentPath = path.join(dataRoot, CAMPAIGN_CREATION_INTENT_FILE);
    this.defaultProviderConfig = options.defaultProviderConfig === undefined
      ? undefined
      : ProviderConfigSchema.parse(options.defaultProviderConfig);
  }

  private async withCatalogLock<T>(operation: () => Promise<T>): Promise<T> {
    if (this.lockContext.getStore()) return operation();
    return queueCatalogOperation(path.resolve(this.lockPath), async () => {
      const release = await acquireCatalogLock(this.lockPath);
      try {
        return await this.lockContext.run(true, operation);
      } finally {
        await release();
      }
    });
  }

  async ensureReady(): Promise<void> {
    await this.withCatalogLock(() => this.ensureReadyUnlocked());
  }

  private async ensureReadyUnlocked(): Promise<void> {
    await mkdir(this.dataRoot, { recursive: true });
    const legacyStore = new StateStore(this.dataRoot);
    await legacyStore.withCampaignLock(async () => {
      // A pre-catalog replacement must settle before its source directories are
      // described by the migration intent.
      await legacyStore.hasCurrentGame();
      await recoverCampaignCatalogMigration(this.dataRoot, this.migrationIntentPath);
      const intent = await this.legacyMigrationIntentUnlocked();
      if (intent !== undefined) {
        await atomicWriteJson(
          this.migrationIntentPath,
          CampaignMigrationIntentSchema.parse(intent),
        );
        await recoverCampaignCatalogMigration(this.dataRoot, this.migrationIntentPath);
      }
    });
    await mkdir(this.campaignsRoot, { recursive: true });
    await this.recoverCreationUnlocked();
    await this.recoverLegacyCreationOrphansUnlocked();
  }

  private async removeCreationStagingUnlocked(scopeRoot: string, campaignId: string): Promise<void> {
    const entries = await readdir(scopeRoot, { withFileTypes: true });
    for (const entry of entries.filter((candidate) => candidate.name.startsWith(".new-"))) {
      if (!entry.isDirectory()) {
        throw new Error(`Campaign ${campaignId} has an unsafe creation staging entry ${entry.name}`);
      }
      const stagingPath = path.join(scopeRoot, entry.name);
      const stagedId = await campaignIdAt(stagingPath);
      if (stagedId !== undefined && stagedId !== campaignId) {
        throw new Error(`Campaign ${campaignId} staging belongs to another campaign: ${stagedId}`);
      }
      await rm(stagingPath, { recursive: true, force: true });
    }
  }

  private async recoverCreationUnlocked(): Promise<CreatedCampaign | undefined> {
    if (!(await pathExists(this.creationIntentPath))) return undefined;
    const intent = CampaignCreationIntentSchema.parse(JSON.parse(
      await readFile(this.creationIntentPath, "utf8"),
    ));
    const scopeRoot = campaignScopePath(this.dataRoot, intent.metadata.campaignId);
    await mkdir(scopeRoot, { recursive: true });
    if (await pathExists(campaignMetadataPath(scopeRoot))) {
      const existing = await readCampaignMetadata(scopeRoot);
      if (!sameMetadata(existing, intent.metadata)) {
        throw new Error(`Campaign ${intent.metadata.campaignId} creation metadata conflicts with its durable intent`);
      }
    } else {
      await writeCampaignMetadata(scopeRoot, intent.metadata);
    }

    const store = this.storeFor(scopeRoot, intent.metadata, false);
    let state: GameState | undefined;
    await store.withCampaignLock(async () => {
      const manifestPath = path.join(store.currentDir, "manifest.json");
      if (await pathExists(manifestPath)) {
        state = (await store.load()).manifest;
        return;
      }
      if (await pathExists(store.currentDir)) {
        throw new Error(`Campaign ${intent.metadata.campaignId} has an incomplete current directory`);
      }
      await this.removeCreationStagingUnlocked(scopeRoot, intent.metadata.campaignId);
      state = await store.createGame(validatedNewGameInput(intent.input));
    });
    if (state === undefined) throw new Error("Campaign creation recovery produced no state");
    await unlinkIfExists(this.creationIntentPath);
    return { campaignId: intent.metadata.campaignId, state, store };
  }

  private async validLegacyInitialStage(stagePath: string, campaignId: string): Promise<boolean> {
    try {
      const loaded = await loadCampaignDirectory(stagePath, campaignId);
      if (loaded.manifest.turn !== 0 || loaded.manifest.status !== "active") return false;
      if (await pathExists(path.join(stagePath, "pending-turn.json"))) return false;
      const turnFiles = (await readdir(path.join(stagePath, "turns")))
        .filter((name) => name.endsWith(".md"))
        .sort();
      if (turnFiles.length !== 1 || turnFiles[0] !== "000000.md") return false;
      const opening = validatePreparedTurnLog(
        await readFile(path.join(stagePath, "turns", "000000.md"), "utf8"),
      );
      return opening.turn === 0 && opening.kind === "opening" && opening.operations.length === 0;
    } catch {
      return false;
    }
  }

  /** Promote complete pre-intent staging while preserving every ambiguous partial save. */
  private async recoverLegacyCreationOrphansUnlocked(): Promise<void> {
    const directories = (await readdir(this.campaignsRoot, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const directory of directories) {
      const scopeRoot = path.join(this.campaignsRoot, directory.name);
      if (!(await pathExists(campaignMetadataPath(scopeRoot)))) continue;
      if (await pathExists(path.join(scopeRoot, "current", "manifest.json"))) continue;
      const metadata = await readCampaignMetadata(scopeRoot);
      if (directory.name !== campaignDirectoryName(metadata.campaignId)) {
        throw new Error(`Catalog campaign ${metadata.campaignId} is stored in the wrong directory`);
      }
      const store = this.storeFor(scopeRoot, metadata, metadata.archived);
      await store.withCampaignLock(async () => {
        if (await pathExists(path.join(scopeRoot, "current", "manifest.json"))) return;
        if (await pathExists(path.join(scopeRoot, "current"))) return;
        const entries = await readdir(scopeRoot, { withFileTypes: true });
        const staged = entries.filter((entry) => entry.name.startsWith(".new-"));
        if (staged.some((entry) => !entry.isDirectory())) return;

        const valid: string[] = [];
        for (const entry of staged) {
          const stagePath = path.join(scopeRoot, entry.name);
          const stagedId = await campaignIdAt(stagePath);
          if (stagedId !== undefined && stagedId !== metadata.campaignId) {
            throw new Error(`Campaign ${metadata.campaignId} staging belongs to another campaign: ${stagedId}`);
          }
          if (await this.validLegacyInitialStage(stagePath, metadata.campaignId)) valid.push(stagePath);
        }
        if (valid.length > 1) {
          throw new Error(`Campaign ${metadata.campaignId} has multiple complete creation staging directories`);
        }
        if (valid.length === 1) {
          await rename(valid[0]!, store.currentDir);
          await loadCampaignDirectory(store.currentDir, metadata.campaignId);
          return;
        }
        // Without a durable creation intent there is no complete source from
        // which to rebuild a partial stage. Leave it untouched and invisible
        // rather than deleting the only surviving copy of accepted setup data.
      });
    }
  }

  private async legacyMigrationIntentUnlocked(): Promise<CampaignMigrationIntent | undefined> {
    const createdAt = new Date().toISOString();
    const entries: CampaignMigrationIntent["entries"] = [];
    const seen = new Set<string>();

    const add = async (source: LegacyCampaignSource, archived: boolean): Promise<void> => {
      const sourcePath = source.kind === "current"
        ? path.join(this.dataRoot, "current")
        : path.join(this.dataRoot, "archive", source.directory);
      const campaignId = await campaignIdAt(sourcePath);
      if (campaignId === undefined) return;
      if (seen.has(campaignId)) {
        throw new Error(`Legacy storage contains duplicate campaign ${campaignId}`);
      }
      seen.add(campaignId);
      if (await campaignIdAt(path.join(campaignScopePath(this.dataRoot, campaignId), "current"))) {
        throw new Error(`Campaign ${campaignId} exists in both legacy and catalog storage`);
      }
      const fields = {
        schemaVersion: 1 as const,
        campaignId,
        registeredAt: createdAt,
        ...optionalProviderConfig(this.defaultProviderConfig),
      };
      const metadata = archived
        ? CampaignMetadataSchema.parse({ ...fields, archived: true, archivedAt: createdAt })
        : CampaignMetadataSchema.parse({ ...fields, archived: false });
      entries.push({ source, metadata });
    };

    await add({ kind: "current" }, false);
    let archivedDirectories: string[] = [];
    try {
      archivedDirectories = (await readdir(path.join(this.dataRoot, "archive"), { withFileTypes: true }))
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    for (const directory of archivedDirectories) {
      await add({ kind: "archive", directory }, true);
    }

    return entries.length === 0
      ? undefined
      : { schemaVersion: 1, createdAt, entries };
  }

  private storeFor(scopeRoot: string, metadata: CampaignMetadata, readOnly: boolean): StateStore {
    return new StateStore(scopeRoot, {
      campaignId: metadata.campaignId,
      readOnly,
      catalogMetadataPath: path.join(scopeRoot, CAMPAIGN_METADATA_FILE),
    });
  }

  private async entryUnlocked(campaignId: string): Promise<CatalogEntry> {
    const validatedId = SafeIdSchema.parse(campaignId);
    const scopeRoot = campaignScopePath(this.dataRoot, validatedId);
    if (!(await pathExists(campaignMetadataPath(scopeRoot)))) {
      throw new Error(`Campaign ${validatedId} was not found`);
    }
    const metadata = await readCampaignMetadata(scopeRoot);
    if (metadata.campaignId !== validatedId) {
      throw new Error(`Campaign catalog directory belongs to ${metadata.campaignId}, not ${validatedId}`);
    }
    const manifest = await this.storeFor(scopeRoot, metadata, metadata.archived).readManifest();
    return { scopeRoot, metadata, manifest };
  }

  private async entriesUnlocked(): Promise<CatalogEntry[]> {
    const directories = (await readdir(this.campaignsRoot, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .sort((left, right) => left.name.localeCompare(right.name));
    const entries: CatalogEntry[] = [];
    const seen = new Set<string>();
    for (const directory of directories) {
      const scopeRoot = path.join(this.campaignsRoot, directory.name);
      const metadataExists = await pathExists(campaignMetadataPath(scopeRoot));
      const manifestExists = await pathExists(path.join(scopeRoot, "current", "manifest.json"));
      if (!metadataExists && !manifestExists) continue;
      if (!metadataExists) throw new Error(`Catalog campaign ${directory.name} is missing metadata`);
      if (!manifestExists) continue; // Conservatively preserved unrecognized legacy orphan.
      const metadata = await readCampaignMetadata(scopeRoot);
      if (directory.name !== campaignDirectoryName(metadata.campaignId)) {
        throw new Error(`Catalog campaign ${metadata.campaignId} is stored in the wrong directory`);
      }
      if (seen.has(metadata.campaignId)) throw new Error(`Duplicate catalog campaign ${metadata.campaignId}`);
      seen.add(metadata.campaignId);
      const manifest = await this.storeFor(scopeRoot, metadata, metadata.archived).readManifest();
      entries.push({ scopeRoot, metadata, manifest });
    }
    return entries;
  }

  private async entryForCreationRequestUnlocked(requestId: string): Promise<CatalogEntry | undefined> {
    const matches: Array<{ scopeRoot: string; metadata: CampaignMetadata }> = [];
    const directories = (await readdir(this.campaignsRoot, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const directory of directories) {
      const scopeRoot = path.join(this.campaignsRoot, directory.name);
      if (!(await pathExists(campaignMetadataPath(scopeRoot)))) continue;
      const metadata = await readCampaignMetadata(scopeRoot);
      if (metadata.creationRequestId === requestId) matches.push({ scopeRoot, metadata });
    }
    if (matches.length > 1) {
      throw new Error(`Multiple campaigns claim creation request ${requestId}`);
    }
    const match = matches[0];
    if (match === undefined) return undefined;
    if (path.basename(match.scopeRoot) !== campaignDirectoryName(match.metadata.campaignId)) {
      throw new Error(`Catalog campaign ${match.metadata.campaignId} is stored in the wrong directory`);
    }
    if (!(await pathExists(path.join(match.scopeRoot, "current", "manifest.json")))) {
      throw new Error(`Campaign creation request ${requestId} belongs to an incomplete preserved campaign`);
    }
    const manifest = await this.storeFor(match.scopeRoot, match.metadata, match.metadata.archived).readManifest();
    return { ...match, manifest };
  }

  private createdCampaign(entry: CatalogEntry): CreatedCampaign {
    return {
      campaignId: entry.manifest.campaignId,
      state: entry.manifest,
      store: this.storeFor(entry.scopeRoot, entry.metadata, entry.metadata.archived),
    };
  }

  async listCampaigns(): Promise<CampaignCatalogSummary[]> {
    return this.withCatalogLock(async () => {
      await this.ensureReadyUnlocked();
      const summaries = (await this.entriesUnlocked()).map(summaryOf);
      return summaries.sort((left, right) => {
        if (left.archived !== right.archived) return left.archived ? 1 : -1;
        return right.updatedAt.localeCompare(left.updatedAt)
          || left.title.localeCompare(right.title)
          || left.campaignId.localeCompare(right.campaignId);
      });
    });
  }

  async createCampaign(
    input: NewGameInput,
    options: CampaignCreationOptions = {},
  ): Promise<CreatedCampaign> {
    return this.withCatalogLock(async () => {
      await this.ensureReadyUnlocked();
      const requestId = options.requestId === undefined
        ? undefined
        : z.string().uuid().parse(options.requestId);
      const providerConfig = options.providerConfig ?? this.defaultProviderConfig;
      const normalizedProviderConfig = providerConfig === undefined
        ? undefined
        : ProviderConfigSchema.parse(providerConfig);
      const validatedInput = validatedNewGameInput(input);
      const fingerprint = creationFingerprint(validatedInput, normalizedProviderConfig);
      if (requestId !== undefined) {
        const existing = await this.entryForCreationRequestUnlocked(requestId);
        if (existing !== undefined) {
          if (existing.metadata.creationFingerprint !== undefined
            && existing.metadata.creationFingerprint !== fingerprint) {
            throw new Error(`Campaign creation request ${requestId} was reused with different setup data`);
          }
          return this.createdCampaign(existing);
        }
      }
      const campaignId = SafeIdSchema.parse(`campaign:${randomUUID()}`);
      const scopeRoot = campaignScopePath(this.dataRoot, campaignId);
      if (await pathExists(scopeRoot)) throw new Error(`Campaign ${campaignId} already exists`);
      const metadata = CampaignMetadataSchema.parse({
        schemaVersion: 1,
        campaignId,
        registeredAt: new Date().toISOString(),
        archived: false,
        ...(requestId === undefined ? {} : {
          creationRequestId: requestId,
          creationFingerprint: fingerprint,
        }),
        ...optionalProviderConfig(normalizedProviderConfig),
      });
      const intent: CampaignCreationIntent = CampaignCreationIntentSchema.parse({
        schemaVersion: 1,
        metadata,
        input: validatedInput,
      });
      await atomicWriteJson(this.creationIntentPath, intent);
      const created = await this.recoverCreationUnlocked();
      if (created === undefined) throw new Error("Campaign creation intent disappeared before completion");
      return created;
    });
  }

  async findCampaignByCreationRequest(requestId: string): Promise<CreatedCampaign | undefined> {
    return this.withCatalogLock(async () => {
      await this.ensureReadyUnlocked();
      const validatedRequestId = z.string().uuid().parse(requestId);
      const entry = await this.entryForCreationRequestUnlocked(validatedRequestId);
      return entry === undefined ? undefined : this.createdCampaign(entry);
    });
  }

  /** Open only a resumable campaign. Archived campaigns fail closed. */
  async openCampaign(campaignId: string): Promise<StateStore> {
    return this.withCatalogLock(async () => {
      await this.ensureReadyUnlocked();
      const entry = await this.entryUnlocked(campaignId);
      if (entry.metadata.archived) throw new Error(`Campaign ${campaignId} is archived and cannot be resumed`);
      return this.storeFor(entry.scopeRoot, entry.metadata, false);
    });
  }

  /** Open any campaign through a store whose mutation methods fail closed. */
  async readCampaign(campaignId: string): Promise<StateStore> {
    return this.withCatalogLock(async () => {
      await this.ensureReadyUnlocked();
      const entry = await this.entryUnlocked(campaignId);
      return this.storeFor(entry.scopeRoot, entry.metadata, true);
    });
  }

  async archiveCampaign(campaignId: string): Promise<CampaignCatalogSummary> {
    return this.withCatalogLock(async () => {
      await this.ensureReadyUnlocked();
      const entry = await this.entryUnlocked(campaignId);
      if (entry.metadata.archived) return summaryOf(entry);
      const store = this.storeFor(entry.scopeRoot, entry.metadata, false);
      return store.withCampaignLock(async () => {
        await store.recoverCommit();
        if (await store.getPending()) {
          throw new Error("Campaign has an unfinished request; recover or discard it before archiving");
        }
        const metadata = CampaignMetadataSchema.parse({
          ...entry.metadata,
          archived: true,
          archivedAt: new Date().toISOString(),
        });
        await writeCampaignMetadata(entry.scopeRoot, metadata);
        return summaryOf({
          ...entry,
          metadata,
          manifest: await store.readManifest(),
        });
      });
    });
  }

  async deleteArchivedCampaign(campaignId: string): Promise<void> {
    await this.withCatalogLock(async () => {
      await this.ensureReadyUnlocked();
      const entry = await this.entryUnlocked(campaignId);
      if (!entry.metadata.archived) {
        throw new Error(`Campaign ${campaignId} must be archived before it can be permanently deleted`);
      }
      const store = this.storeFor(entry.scopeRoot, entry.metadata, true);
      await store.withCampaignLock(async () => {
        const metadata = await readCampaignMetadata(entry.scopeRoot);
        if (!metadata.archived || metadata.campaignId !== campaignId) {
          throw new Error(`Campaign ${campaignId} is not a matching archived campaign`);
        }
        const manifest = await store.readManifest();
        if (manifest.campaignId !== campaignId) {
          throw new Error(`Campaign ${campaignId} manifest identity does not match its catalog entry`);
        }
        await rm(entry.scopeRoot, { recursive: true });
      });
    });
  }

  async providerConfig(campaignId: string): Promise<ProviderConfig | undefined> {
    return this.withCatalogLock(async () => {
      await this.ensureReadyUnlocked();
      return (await this.entryUnlocked(campaignId)).metadata.providerConfig;
    });
  }

  async updateProviderConfig(campaignId: string, config: ProviderConfig): Promise<ProviderConfig> {
    return this.withCatalogLock(async () => {
      await this.ensureReadyUnlocked();
      const entry = await this.entryUnlocked(campaignId);
      if (entry.metadata.archived) throw new Error("Archived campaign provider configuration cannot be changed");
      const providerConfig = ProviderConfigSchema.parse(config);
      const store = this.storeFor(entry.scopeRoot, entry.metadata, false);
      await store.withCampaignLock(async () => {
        const metadata = await readCampaignMetadata(entry.scopeRoot);
        if (metadata.archived) throw new Error("Archived campaign provider configuration cannot be changed");
        if (metadata.providerConfig !== undefined && await store.getPending()) {
          throw new Error("Campaign has an unfinished request; recover or discard it before changing model");
        }
        await writeCampaignMetadata(entry.scopeRoot, CampaignMetadataSchema.parse({
          ...metadata,
          providerConfig,
        }));
      });
      return providerConfig;
    });
  }
}
