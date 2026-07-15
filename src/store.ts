import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { contextSection, renderContextDocument } from "./context-document.js";
import { DEFAULT_LANGUAGE, languageDefinition, languageInstruction, type LanguageCode } from "./language.js";
import { projectPlayerInspection } from "./inspection.js";
import { allocateGeneratedId, canonicalEntityName } from "./domain/ids.js";
import { AppealPolicyError, assertAppealOperations } from "./domain/appeal.js";
import { applyTransaction } from "./domain/transaction.js";
import { assertCampaignStateConsistency } from "./domain/state-consistency.js";
import { atomicWriteJson, atomicWriteText, pathExists, unlinkIfExists } from "./persistence/files.js";
import { acquireFileLock } from "./persistence/lock.js";
import { contentHash, executePendingCommit } from "./persistence/commit.js";
import {
  campaignIdAt,
  recoverCampaignReplacement,
  ReplacementIntentSchema,
  type ReplacementIntent,
} from "./persistence/replacement.js";
import {
  PendingRequestSchema,
  PendingTurnSchema,
  type PendingCommit,
  type PendingRequest,
  type PendingTurn,
} from "./persistence/pending.js";
import {
  compactTurnHistory,
  entityFilename,
  parseChronicle,
  parseEntity,
  parsePlayerVisibleTurn,
  parseThreads,
  parseTurnOperationLedger,
  renderChronicle,
  renderChronicleForContext,
  renderContextEntities,
  renderEntity,
  parseTurnOperations,
  renderThreads,
  renderThreadsForContext,
  renderTurnLog,
  type TurnOperationLedger,
} from "./persistence/markdown.js";
import {
  ChronicleEventSchema,
  EntitySchema,
  ManifestSchema,
  SetupResultSchema,
  ThreadSchema,
  type ChronicleEvent,
  type Entity,
  type Fact,
  type GameState,
  type SetupResult,
  type StateOperation,
  type Thread,
} from "./schemas.js";
import type {
  CommittedTurn,
  NewGameInput,
  PlayerVisibleTurn,
  PlayerStateInspection,
  StateView,
} from "./types.js";

function operationEntityReferences(operation: StateOperation): string[] {
  switch (operation.type) {
    case "create_entity": return [operation.entity.id, ...(operation.entity.location ? [operation.entity.location] : [])];
    case "add_fact":
    case "supersede_fact":
    case "set_entity_state":
    case "add_condition":
    case "remove_condition":
    case "add_trait": return [operation.targetId];
    case "move_entity": return [operation.targetId, operation.locationId];
    case "change_inventory": return [operation.ownerId, operation.itemId];
    case "transfer_item": return [operation.fromId, operation.toId, operation.itemId];
    case "set_relationship": return [operation.sourceId, operation.targetId];
    case "create_thread": return operation.relatedEntityIds;
    case "update_thread": return operation.relatedEntityIds ?? [];
    default: return [];
  }
}

export interface LoadedCampaign {
  manifest: GameState;
  entities: Map<string, Entity>;
  /** Existing source filename by entity ID, retained for pre-V1 save compatibility. */
  entityFiles: Map<string, string>;
  scenario: string;
  threads: Thread[];
  chronicle: ChronicleEvent[];
}

export interface CommitTurnResult {
  state: GameState;
  operations: import("./schemas.js").StateOperation[];
}

export function validateInitialSetup(input: unknown): SetupResult {
  const setup = SetupResultSchema.parse(input);
  const errors: string[] = [];
  const reject = (message: string) => { errors.push(message); };
  if (setup.player.id !== "player:hero") reject("The initial player ID must be player:hero");
  const initial = [setup.player, ...setup.entities];
  if (new Set(initial.map((entity) => entity.id)).size !== initial.length) {
    reject("Initial entity IDs must be unique");
  }
  const byId = new Map(initial.map((entity) => [entity.id, entity]));
  const locationEntities = initial.filter((entity) => entity.kind === "location");
  const locations = new Set(locationEntities.map((entity) => entity.id));
  const locationNames = new Map<string, string>();
  for (const location of locationEntities) {
    const canonical = canonicalEntityName(location.name);
    const duplicate = locationNames.get(canonical);
    if (duplicate) reject(`Initial location ${location.id} duplicates ${duplicate} by name`);
    locationNames.set(canonical, location.id);
  }
  if (!setup.player.location || !locations.has(setup.player.location)) {
    reject("Player must begin at an included location entity");
  }
  const inventoriedItems = new Set<string>();
  for (const entity of initial) {
    if (entity.location && !locations.has(entity.location)) {
      reject(`Initial entity ${entity.id} references an unknown location`);
    }
    if (entity.location === entity.id) reject(`Initial entity ${entity.id} cannot be located inside itself`);
    const inventoryIds = new Set<string>();
    for (const entry of entity.inventory) {
      if (inventoryIds.has(entry.entityId)) {
        reject(`Initial entity ${entity.id} has duplicate inventory entries for ${entry.entityId}`);
      }
      inventoryIds.add(entry.entityId);
      const item = byId.get(entry.entityId);
      if (!item) {
        reject(`Initial inventory item ${entry.entityId} does not exist`);
      } else if (item.kind !== "item") {
        reject(`Initial inventory entry ${entry.entityId} is not an item`);
      } else {
        inventoriedItems.add(item.id);
      }
    }
  }
  for (const itemId of inventoriedItems) {
    if (byId.get(itemId)?.location) {
      reject(`Initial inventoried item ${itemId} must not also have a world location`);
    }
  }
  for (const location of locationEntities) {
    const visited = new Set<string>([location.id]);
    let parentId = location.location;
    while (parentId) {
      if (visited.has(parentId)) {
        reject(`Initial location hierarchy contains a cycle at ${parentId}`);
        break;
      }
      visited.add(parentId);
      parentId = byId.get(parentId)?.location;
    }
  }
  for (const thread of setup.threads) {
    for (const relatedId of thread.relatedEntityIds) {
      if (!byId.has(relatedId)) reject(`Initial thread ${thread.title} references unknown entity ${relatedId}`);
    }
  }
  if (errors.length > 0) {
    throw new Error(`Initial setup validation failed:\n- ${[...new Set(errors)].join("\n- ")}`);
  }
  const usedThreadIds = new Set<string>();
  const threads = setup.threads.map((thread) => ({
    ...thread,
    id: allocateGeneratedId("thread", thread.title, 0, usedThreadIds),
  }));
  return { ...setup, threads };
}

export class StateStore {
  readonly currentDir: string;
  readonly archiveDir: string;
  readonly pendingPath: string;
  readonly lockPath: string;
  readonly replacementIntentPath: string;
  private readonly lockContext = new AsyncLocalStorage<boolean>();

  constructor(readonly dataRoot: string) {
    this.currentDir = path.join(dataRoot, "current");
    this.archiveDir = path.join(dataRoot, "archive");
    this.pendingPath = path.join(this.currentDir, "pending-turn.json");
    this.lockPath = path.join(dataRoot, ".campaign.lock");
    this.replacementIntentPath = path.join(dataRoot, ".replacement-intent.json");
  }

  async withCampaignLock<T>(operation: () => Promise<T>): Promise<T> {
    if (this.lockContext.getStore()) return operation();
    const release = await acquireFileLock(this.lockPath, "Campaign state");
    try {
      return await this.lockContext.run(true, operation);
    } finally {
      await release();
    }
  }

  async hasCurrentGame(): Promise<boolean> {
    if (await pathExists(this.replacementIntentPath)) {
      await this.withCampaignLock(() => this.recoverReplacementUnlocked());
    }
    return pathExists(path.join(this.currentDir, "manifest.json"));
  }

  async createGame(input: NewGameInput): Promise<GameState> {
    return this.withCampaignLock(() => this.createGameUnlocked(input));
  }

  private async createGameUnlocked(input: NewGameInput): Promise<GameState> {
    await this.recoverReplacementUnlocked();
    if (await pathExists(this.currentDir)) throw new Error("A current campaign already exists");
    const staged = await this.stageGame(input);
    try {
      if (await pathExists(this.currentDir)) throw new Error("A current campaign already exists");
      await rename(staged.path, this.currentDir);
      return staged.manifest;
    } catch (error) {
      await rm(staged.path, { recursive: true, force: true });
      throw error;
    }
  }

  /** Stage a complete replacement before archiving the authoritative campaign. */
  async replaceGame(input: NewGameInput): Promise<GameState> {
    return this.withCampaignLock(() => this.replaceGameUnlocked(input));
  }

  private async replaceGameUnlocked(input: NewGameInput): Promise<GameState> {
    await this.recoverReplacementUnlocked();
    const staged = await this.stageGame(input);
    const previousCampaignId = await campaignIdAt(this.currentDir);
    const archivedDirectory = previousCampaignId
      ? `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`
      : undefined;
    const intent: ReplacementIntent = {
      schemaVersion: 1,
      stagedDirectory: path.basename(staged.path),
      stagedCampaignId: staged.manifest.campaignId,
      ...(archivedDirectory ? { archivedDirectory, previousCampaignId } : {}),
    };
    try {
      if (previousCampaignId) await this.recoverCommitUnlocked();
      await atomicWriteJson(this.replacementIntentPath, ReplacementIntentSchema.parse(intent));
      if (archivedDirectory) {
        await mkdir(this.archiveDir, { recursive: true });
        await rename(this.currentDir, path.join(this.archiveDir, archivedDirectory));
      }
      await rename(staged.path, this.currentDir);
      await unlinkIfExists(this.replacementIntentPath);
      return staged.manifest;
    } catch (error) {
      try {
        await this.recoverReplacementUnlocked();
        if (await campaignIdAt(this.currentDir) === staged.manifest.campaignId) return staged.manifest;
      } catch (recoveryError) {
        throw new AggregateError([error, recoveryError], "Campaign replacement failed and its durable recovery intent could not be completed");
      }
      throw error;
    } finally {
      if (!(await pathExists(this.replacementIntentPath))) {
        await rm(staged.path, { recursive: true, force: true });
      }
    }
  }

  private async recoverReplacementUnlocked(): Promise<void> {
    await recoverCampaignReplacement({
      dataRoot: this.dataRoot,
      currentDir: this.currentDir,
      archiveDir: this.archiveDir,
      intentPath: this.replacementIntentPath,
    });
  }

  private async stageGame(input: NewGameInput): Promise<{ path: string; manifest: GameState }> {
    const setup = validateInitialSetup(input.setup);
    const initial = [setup.player, ...setup.entities];

    const now = new Date().toISOString();
    const manifest = ManifestSchema.parse({
      schemaVersion: 1,
      campaignId: `campaign:${randomUUID()}`,
      title: setup.campaignTitle,
      turn: 0,
      status: "active",
      playerId: setup.player.id,
      currentLocationId: setup.player.location,
      elapsedMinutes: 0,
      timeLabel: setup.timeLabel,
      language: input.language ?? DEFAULT_LANGUAGE,
      createdAt: now,
      updatedAt: now,
    });
    const usedFactIds = new Set<string>();
    const entities = initial.map((source) => {
      const facts: Fact[] = [];
      for (const [section, values] of [
        ["established", source.establishedFacts],
        ["secrets", source.secrets],
        ["knowledge", source.playerKnowledge],
      ] as const) {
        for (const text of values) {
          facts.push({
            id: allocateGeneratedId("fact", source.id, 0, usedFactIds),
            section,
            text,
            active: true,
          });
        }
      }
      return EntitySchema.parse({
        id: source.id,
        kind: source.kind,
        name: source.name,
        status: source.status,
        ...(source.location ? { location: source.location } : {}),
        tags: source.tags,
        updatedTurn: 0,
        description: source.description,
        traits: source.traits,
        conditions: source.conditions,
        inventory: source.inventory,
        facts,
        relationships: [],
      });
    });

    assertCampaignStateConsistency(
      manifest,
      new Map(entities.map((entity) => [entity.id, entity])),
      setup.threads,
      [],
    );

    await mkdir(this.dataRoot, { recursive: true });
    const staging = path.join(this.dataRoot, `.new-${randomUUID()}`);
    try {
      await mkdir(path.join(staging, "entities"), { recursive: true });
      await mkdir(path.join(staging, "turns"), { recursive: true });
      await writeFile(path.join(staging, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
      await writeFile(
        path.join(staging, "scenario.md"),
        `# Campaign Rules Snapshot\n\n${input.worldRules.trim()}\n\n# Scenario\n\n${setup.scenarioMarkdown.trim()}\n`,
        "utf8",
      );
      await writeFile(path.join(staging, "threads.md"), renderThreads(setup.threads), "utf8");
      await writeFile(path.join(staging, "chronicle.md"), renderChronicle([]), "utf8");
      for (const entity of entities) {
        await writeFile(path.join(staging, "entities", entityFilename(entity.id)), renderEntity(entity), "utf8");
      }
      const lifecycleCopy = languageDefinition(manifest.language).campaignLifecycle;
      const opening: CommittedTurn = {
        action: lifecycleCopy.openingAction,
        resolved: { narration: setup.openingNarration, turnSummary: lifecycleCopy.openingSummary, operations: [] },
        provider: "setup",
        model: "setup",
      };
      await writeFile(path.join(staging, "turns", "000000.md"), renderTurnLog(0, opening), "utf8");
      return { path: staging, manifest };
    } catch (error) {
      await rm(staging, { recursive: true, force: true });
      throw error;
    }
  }

  async archiveAndReset(): Promise<string | undefined> {
    return this.withCampaignLock(() => this.archiveAndResetUnlocked());
  }

  private async archiveAndResetUnlocked(): Promise<string | undefined> {
    await this.recoverReplacementUnlocked();
    if (!(await pathExists(this.currentDir))) return;
    await this.recoverCommitUnlocked();
    await mkdir(this.archiveDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const archivedPath = path.join(this.archiveDir, `${stamp}-${randomUUID().slice(0, 8)}`);
    await rename(this.currentDir, archivedPath);
    return archivedPath;
  }

  async setLanguage(language: LanguageCode): Promise<GameState> {
    return this.withCampaignLock(() => this.setLanguageUnlocked(language));
  }

  private async setLanguageUnlocked(language: LanguageCode): Promise<GameState> {
    const loaded = await this.loadUnlocked();
    const manifest = ManifestSchema.parse({
      ...loaded.manifest,
      language,
      updatedAt: new Date().toISOString(),
    });
    await atomicWriteText(path.join(this.currentDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    return manifest;
  }

  async readManifest(): Promise<GameState> {
    return this.readManifestUnlocked();
  }

  // This atomic single-file diagnostic read intentionally remains available
  // while another store instance owns the campaign lock. Multi-file snapshots
  // use load(), which holds the lock through recovery and every related read.
  private async readManifestUnlocked(): Promise<GameState> {
    return ManifestSchema.parse(JSON.parse(
      await readFile(path.join(this.currentDir, "manifest.json"), "utf8"),
    ));
  }

  async load(): Promise<LoadedCampaign> {
    return this.withCampaignLock(() => this.loadUnlocked());
  }

  private async loadUnlocked(): Promise<LoadedCampaign> {
    await this.recoverReplacementUnlocked();
    await this.recoverCommitUnlocked();
    const manifest = await this.readManifestUnlocked();
    const entityDir = path.join(this.currentDir, "entities");
    const names = (await readdir(entityDir)).filter((name) => name.endsWith(".md")).sort();
    const entities = new Map<string, Entity>();
    const entityFiles = new Map<string, string>();
    for (const name of names) {
      const entity = parseEntity(await readFile(path.join(entityDir, name), "utf8"));
      if (entities.has(entity.id)) throw new Error(`Duplicate entity ID ${entity.id}`);
      entities.set(entity.id, entity);
      entityFiles.set(entity.id, name);
    }
    const scenario = await readFile(path.join(this.currentDir, "scenario.md"), "utf8");
    const threads = parseThreads(await readFile(path.join(this.currentDir, "threads.md"), "utf8"));
    const chronicle = parseChronicle(await readFile(path.join(this.currentDir, "chronicle.md"), "utf8"));
    assertCampaignStateConsistency(manifest, entities, threads, chronicle);
    return { manifest, entities, entityFiles, scenario, threads, chronicle };
  }

  async getPending(): Promise<PendingTurn | undefined> {
    return this.getPendingUnlocked();
  }

  // Like readManifest(), this is a single-file diagnostic read; callers needing
  // a coherent campaign snapshot use load().
  private async getPendingUnlocked(): Promise<PendingTurn | undefined> {
    if (!(await pathExists(this.pendingPath))) return undefined;
    return PendingTurnSchema.parse(JSON.parse(await readFile(this.pendingPath, "utf8")));
  }

  async setPendingRequest(pending: PendingRequest): Promise<void> {
    return this.withCampaignLock(() => this.setPendingRequestUnlocked(pending));
  }

  private async setPendingRequestUnlocked(pending: PendingRequest): Promise<void> {
    const validated = PendingRequestSchema.parse(pending);
    await atomicWriteText(this.pendingPath, `${JSON.stringify(validated, null, 2)}\n`);
  }

  async discardPendingRequest(): Promise<void> {
    return this.withCampaignLock(() => this.discardPendingRequestUnlocked());
  }

  private async discardPendingRequestUnlocked(): Promise<void> {
    const pending = await this.getPendingUnlocked();
    if (pending?.kind === "commit") throw new Error("Cannot discard a prepared commit");
    await rm(this.pendingPath, { force: true });
  }

  async recoverCommit(): Promise<void> {
    return this.withCampaignLock(() => this.recoverCommitUnlocked());
  }

  private async recoverCommitUnlocked(): Promise<void> {
    const pending = await this.getPendingUnlocked();
    if (!pending || pending.kind !== "commit") return;
    await executePendingCommit(this.currentDir, this.pendingPath, pending);
  }

  async commitTurn(committed: CommittedTurn): Promise<GameState> {
    return (await this.commitTurnWithResult(committed)).state;
  }

  async commitTurnWithResult(committed: CommittedTurn): Promise<CommitTurnResult> {
    return this.withCampaignLock(() => this.commitTurnWithResultUnlocked(committed));
  }

  private async commitTurnWithResultUnlocked(committed: CommittedTurn): Promise<CommitTurnResult> {
    const loaded = await this.loadUnlocked();
    if (loaded.manifest.status !== "active") throw new Error("The campaign has ended");
    const nextTurn = loaded.manifest.turn + 1;
    const turnKind = committed.kind ?? "gameplay";
    if (turnKind === "appeal") {
      if (committed.check) throw new AppealPolicyError("Appeals cannot contain a check");
      if (committed.appealTargetTurn !== undefined
        && (committed.appealTargetTurn < 1 || committed.appealTargetTurn > loaded.manifest.turn)) {
        throw new AppealPolicyError(`Appeal target turn must be between 1 and ${loaded.manifest.turn}`);
      }
    } else if (committed.appealTargetTurn !== undefined) {
      throw new Error("Only an appeal may reference an appeal target turn");
    }
    const manifestPath = path.join(this.currentDir, "manifest.json");
    const preManifestText = await readFile(manifestPath, "utf8");
    const previousOperations = (await this.currentOperationLedgerWindowUnlocked(loaded.manifest.turn))
      .flatMap((ledger) => ledger.operations);
    const transaction = applyTransaction(
      committed.resolved.operations,
      nextTurn,
      loaded.manifest,
      loaded.entities,
      loaded.threads,
      loaded.chronicle,
      previousOperations,
    );
    if (turnKind === "appeal") assertAppealOperations(transaction.operations, loaded.entities);
    const { manifest, entities, threads, chronicle } = transaction;
    manifest.updatedAt = new Date().toISOString();
    const normalizedCommitted: CommittedTurn = {
      ...committed,
      resolved: { ...committed.resolved, operations: transaction.operations },
    };

    const writes: Record<string, string> = {
      [`turns/${String(nextTurn).padStart(6, "0")}.md`]: renderTurnLog(nextTurn, normalizedCommitted),
    };
    for (const entity of [...entities.values()].filter((candidate) => candidate.updatedTurn === nextTurn)) {
      writes[`entities/${loaded.entityFiles.get(entity.id) ?? entityFilename(entity.id)}`] = renderEntity(EntitySchema.parse(entity));
    }
    if (transaction.operations.some((operation) =>
      operation.type === "create_thread" || operation.type === "update_thread" || operation.type === "resolve_thread")) {
      writes["threads.md"] = renderThreads(ThreadSchema.array().parse(threads));
    }
    if (transaction.operations.some((operation) =>
      operation.type === "record_major_event" || operation.type === "end_campaign")) {
      writes["chronicle.md"] = renderChronicle(ChronicleEventSchema.array().parse(chronicle));
    }
    writes["manifest.json"] = `${JSON.stringify(ManifestSchema.parse(manifest), null, 2)}\n`;
    const pending: PendingCommit = {
      kind: "commit",
      writes,
      campaignId: loaded.manifest.campaignId,
      expectedPreviousTurn: loaded.manifest.turn,
      targetTurn: nextTurn,
      preManifestHash: contentHash(preManifestText),
    };
    await atomicWriteText(this.pendingPath, `${JSON.stringify(pending, null, 2)}\n`);
    await executePendingCommit(this.currentDir, this.pendingPath, pending);
    return {
      state: ManifestSchema.parse(manifest),
      operations: transaction.operations,
    };
  }

  async recentTurnLogs(limit = 8): Promise<string[]> {
    return this.withCampaignLock(async () => {
      await this.recoverReplacementUnlocked();
      await this.recoverCommitUnlocked();
      return this.recentTurnLogsUnlocked(limit);
    });
  }

  private async recentTurnLogsUnlocked(limit = 8): Promise<string[]> {
    const turnDir = path.join(this.currentDir, "turns");
    const files = (await readdir(turnDir)).filter((name) => name.endsWith(".md")).sort().slice(-limit);
    return Promise.all(files.map((name) => readFile(path.join(turnDir, name), "utf8")));
  }

  /**
   * Select the latest gameplay/opening operation ledger and every appeal ledger
   * committed after it. Administrative turns therefore cannot hide gameplay
   * effects, while state-changing appeals remain part of duplicate protection
   * and model context.
   */
  private async currentOperationLedgerWindowUnlocked(latestTurn: number): Promise<TurnOperationLedger[]> {
    const reverse: TurnOperationLedger[] = [];
    for (let turn = latestTurn; turn >= 0; turn -= 1) {
      const log = await readFile(
        path.join(this.currentDir, "turns", `${String(turn).padStart(6, "0")}.md`),
        "utf8",
      );
      const ledger = parseTurnOperationLedger(log);
      if (ledger.turn !== turn) throw new Error(`Turn log ${turn} contains ledger metadata for turn ${ledger.turn}`);
      reverse.push(ledger);
      if (ledger.kind !== "appeal") break;
    }
    return reverse.reverse();
  }

  async recentTranscript(limit = 8): Promise<PlayerVisibleTurn[]> {
    return this.withCampaignLock(() => this.recentTranscriptUnlocked(limit));
  }

  private async recentTranscriptUnlocked(limit: number): Promise<PlayerVisibleTurn[]> {
    const loaded = await this.loadUnlocked();
    return (await this.recentTurnLogsUnlocked(limit))
      .map((log) => parsePlayerVisibleTurn(log, loaded.manifest.language));
  }

  async inspect(view: StateView): Promise<PlayerStateInspection> {
    return this.withCampaignLock(() => this.inspectUnlocked(view));
  }

  private async inspectUnlocked(view: StateView): Promise<PlayerStateInspection> {
    const loaded = await this.loadUnlocked();
    return projectPlayerInspection(
      view,
      loaded.manifest.language,
      loaded.manifest,
      loaded.entities,
      loaded.threads,
    );
  }

  async buildContext(): Promise<string> {
    return this.withCampaignLock(() => this.buildContextUnlocked());
  }

  private async buildContextUnlocked(): Promise<string> {
    const loaded = await this.loadUnlocked();
    const player = loaded.entities.get(loaded.manifest.playerId);
    const location = loaded.entities.get(loaded.manifest.currentLocationId);
    if (!player || !location) throw new Error("Campaign is missing the player or current location");
    const selected = new Map<string, Entity>([[player.id, player], [location.id, location]]);
    for (const entity of loaded.entities.values()) {
      if (entity.location === location.id) selected.set(entity.id, entity);
    }
    let parentId = location.location;
    const visitedParents = new Set<string>();
    while (parentId && !visitedParents.has(parentId)) {
      visitedParents.add(parentId);
      const parent = loaded.entities.get(parentId);
      if (!parent || parent.kind !== "location") break;
      selected.set(parent.id, parent);
      parentId = parent.location;
    }
    const directlyRelevant = [...selected.values()];
    for (const owner of directlyRelevant) {
      for (const item of owner.inventory) {
        const entity = loaded.entities.get(item.entityId);
        if (entity) selected.set(entity.id, entity);
      }
    }
    for (const entity of directlyRelevant) {
      for (const relationship of entity.relationships) {
        const related = loaded.entities.get(relationship.targetId);
        if (related) selected.set(related.id, related);
      }
    }
    for (const thread of loaded.threads.filter((candidate) => candidate.status === "active")) {
      for (const relatedId of thread.relatedEntityIds) {
        const related = loaded.entities.get(relatedId);
        if (related) selected.set(related.id, related);
      }
    }
    const recent = await this.recentTurnLogsUnlocked(8);
    const operationLedgerWindow = await this.currentOperationLedgerWindowUnlocked(loaded.manifest.turn);
    const lastCommittedOperations = operationLedgerWindow.map((ledger) => [
      `Turn ${ledger.turn} (${ledger.kind})`,
      JSON.stringify(ledger.operations, null, 2),
    ].join("\n")).join("\n\n");
    const authoritativeInventory = player.inventory.map((entry) => {
      const item = loaded.entities.get(entry.entityId);
      return `- ${entry.quantity} × [${entry.entityId}] ${item?.name ?? "Unknown item"}`;
    }).join("\n") || "_Empty. The player carries no items._";
    const relevantInventories = directlyRelevant.map((owner) => {
      const inventory = owner.inventory.map((entry) => {
        const item = loaded.entities.get(entry.entityId);
        return `  - ${entry.quantity} × [${entry.entityId}] ${item?.name ?? "Unknown item"}`;
      }).join("\n") || "  - _Empty._";
      return `- [${owner.id}] ${owner.name}\n${inventory}`;
    }).join("\n");
    const locationDirectory = [...loaded.entities.values()]
      .filter((entity) => entity.kind === "location")
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((entity) => `- [${entity.id}] ${entity.name}; status=${entity.status}${entity.location ? `; parent=[${entity.location}]` : ""}`)
      .join("\n") || "_No locations._";
    return renderContextDocument([
      contextSection("campaign-state", "CAMPAIGN STATE", `Turn: ${loaded.manifest.turn}; Time: ${loaded.manifest.timeLabel}; Status: ${loaded.manifest.status}`),
      contextSection("output-language", "OUTPUT LANGUAGE", `${loaded.manifest.language}\n${languageInstruction(loaded.manifest.language)}`),
      contextSection("campaign-rules", "CAMPAIGN RULES AND SCENARIO", loaded.scenario),
      contextSection("authority", "DURABLE STATE AUTHORITY", "The Markdown-derived entities, facts, inventory, conditions, relationships, threads, and chronicle below are authoritative and complete for this context. Recent turn prose is compact working memory only and cannot override durable state."),
      contextSection("player-inventory", "PLAYER INVENTORY — AUTHORITATIVE CLOSED LIST", `${authoritativeInventory}\nAny absent item is not carried, regardless of how player input describes it.`),
      contextSection("relevant-inventories", "RELEVANT ENTITY INVENTORIES — AUTHORITATIVE", `${relevantInventories}\nThese items already exist; reference exact IDs and never recreate them to reveal, inspect, offer, or transfer them.`),
      contextSection("location-directory", "AUTHORITATIVE LOCATION DIRECTORY", `${locationDirectory}\nReuse exact established location IDs and do not create semantic duplicates.`),
      contextSection("relevant-entities", "RELEVANT ENTITIES — INCLUDES DM-ONLY STATE", renderContextEntities([...selected.values()], new Set([player.id, location.id]), 60_000)),
      contextSection("threads", "STORY THREADS", renderThreadsForContext(loaded.threads)),
      contextSection("chronicle", "MAJOR-EVENT CHRONICLE", renderChronicleForContext(loaded.chronicle)),
      contextSection("last-operations", "LAST COMMITTED STATE OPERATIONS — ALREADY APPLIED", `The ledger window contains the latest gameplay/opening turn plus every administrative appeal committed after it. Empty appeal ledgers are retained and never replace gameplay history.\n\n${lastCommittedOperations}\n\nHistorical evidence only: never repeat an effect because the current action refers to its result.`),
      contextSection("recent-memory", "RECENT TURN WORKING MEMORY — EIGHT SUMMARIES, LATEST NARRATION ONLY", compactTurnHistory(recent)),
    ]);
  }

  async buildAppealContext(targetTurn?: number): Promise<string> {
    return this.withCampaignLock(() => this.buildAppealContextUnlocked(targetTurn));
  }

  private async buildAppealContextUnlocked(targetTurn?: number): Promise<string> {
    const loaded = await this.loadUnlocked();
    if (targetTurn !== undefined
      && (!Number.isSafeInteger(targetTurn) || targetTurn < 1 || targetTurn > loaded.manifest.turn)) {
      throw new Error(`Appeal target turn must be between 1 and ${loaded.manifest.turn}`);
    }

    const evidenceLogs = targetTurn === undefined
      ? await this.recentTurnLogsUnlocked(8)
      : [await readFile(
          path.join(this.currentDir, "turns", `${String(targetTurn).padStart(6, "0")}.md`),
          "utf8",
        )];
    const evidence = evidenceLogs.map((log) => ({
      visible: parsePlayerVisibleTurn(log, loaded.manifest.language),
      operations: parseTurnOperations(log),
    }));
    const mandatoryIds = new Set<string>([
      loaded.manifest.playerId,
      loaded.manifest.currentLocationId,
      ...evidence.flatMap(({ operations }) => operations.flatMap(operationEntityReferences)),
    ]);
    for (const id of [...mandatoryIds]) {
      const entity = loaded.entities.get(id);
      for (const item of entity?.inventory ?? []) mandatoryIds.add(item.entityId);
    }
    const player = loaded.entities.get(loaded.manifest.playerId);
    if (!player) throw new Error("Campaign is missing the player");
    const authoritativeInventory = player.inventory.map((entry) => {
      const item = loaded.entities.get(entry.entityId);
      if (!item) throw new Error("Player inventory contains an invalid item reference");
      return `- ${entry.quantity} × [${item.id}] ${item.name}`;
    }).join("\n") || "_Empty. The player carries no items._";
    const entityDirectory = [...loaded.entities.values()].map((entity) => {
      const inventory = entity.inventory.map((entry) => {
        const item = loaded.entities.get(entry.entityId);
        return `${entry.quantity}×[${entry.entityId}] ${item?.name ?? "missing item"}`;
      }).join(", ") || "empty";
      const relationships = entity.relationships
        .map((relationship) => `[${relationship.targetId}] ${relationship.summary}`)
        .join("; ") || "none";
      return `- [${entity.id}] ${entity.kind} ${entity.name}; status=${entity.status}; location=${entity.location ? `[${entity.location}]` : "none"}; conditions=${JSON.stringify(entity.conditions)}; inventory=${inventory}; relationships=${relationships}`;
    }).join("\n");
    const evidenceText = targetTurn === undefined
      ? [
          compactTurnHistory(evidenceLogs),
          "COMMITTED OPERATION LEDGER FOR THE SAME RECENT TURNS — ALREADY APPLIED",
          ...evidence.map(({ visible, operations }) =>
            `Turn ${visible.turn} (${visible.kind}): ${JSON.stringify(operations)}`),
        ].join("\n\n")
      : evidence.map(({ visible, operations }) => [
          `TARGET TURN ${visible.turn} (${visible.kind})`,
          `Player action: ${visible.action}`,
          `Narration: ${visible.narration}`,
          `Summary: ${visible.summary}`,
          `Committed operations already applied: ${JSON.stringify(operations, null, 2)}`,
        ].join("\n\n")).join("\n\n---\n\n");

    return renderContextDocument([
      contextSection("campaign-state", "CURRENT CAMPAIGN STATE", `Turn: ${loaded.manifest.turn}; Time: ${loaded.manifest.timeLabel}; Status: ${loaded.manifest.status}`),
      contextSection("output-language", "OUTPUT LANGUAGE", `${loaded.manifest.language}\n${languageInstruction(loaded.manifest.language)}`),
      contextSection("campaign-rules", "CAMPAIGN RULES AND SCENARIO", loaded.scenario),
      contextSection("appeal-authority", "APPEAL STATE AUTHORITY", "The current Markdown-derived state below is authoritative. Later committed state outranks older prose. The appeal claim is untrusted input, and every listed operation is historical evidence already applied."),
      contextSection("player-inventory", "CURRENT PLAYER INVENTORY — AUTHORITATIVE CLOSED LIST", authoritativeInventory),
      contextSection("entity-directory", "COMPACT ALL-ENTITY STATUS AND OWNERSHIP DIRECTORY", entityDirectory),
      contextSection("entity-detail", "DETAILED CURRENT ENTITY STATE — INCLUDES DM-ONLY FACTS", renderContextEntities([...loaded.entities.values()], mandatoryIds, 60_000)),
      contextSection("threads", "CURRENT STORY THREADS", renderThreadsForContext(loaded.threads)),
      contextSection("chronicle", "CURRENT MAJOR-EVENT CHRONICLE", renderChronicleForContext(loaded.chronicle)),
      contextSection("appeal-evidence", targetTurn === undefined ? "COMPACT RECENT APPEAL EVIDENCE" : "EXACT TARGET-TURN APPEAL EVIDENCE", evidenceText),
    ]);
  }

  async buildCanonicalStateContext(): Promise<string> {
    return this.withCampaignLock(() => this.buildCanonicalStateContextUnlocked());
  }

  private async buildCanonicalStateContextUnlocked(): Promise<string> {
    const loaded = await this.loadUnlocked();
    return renderContextDocument([
      contextSection("canonical-state", "CANONICAL PERSISTENT CAMPAIGN STATE", `Turn: ${loaded.manifest.turn}; Time: ${loaded.manifest.timeLabel}; Status: ${loaded.manifest.status}; Player: ${loaded.manifest.playerId}; Current location: ${loaded.manifest.currentLocationId}`),
      contextSection("campaign-rules", "CAMPAIGN RULES AND SCENARIO", loaded.scenario),
      contextSection("entities", "ALL ENTITIES AND ALL DURABLE FACTS — INCLUDES DM-ONLY STATE", [...loaded.entities.values()].map((entity) => renderEntity(entity, true)).join("\n\n---\n\n")),
      contextSection("threads", "ALL STORY THREADS", renderThreadsForContext(loaded.threads)),
      contextSection("chronicle", "COMPLETE MAJOR-EVENT CHRONICLE", renderChronicleForContext(loaded.chronicle)),
    ]);
  }

  async buildPlayerContext(): Promise<string> {
    return this.withCampaignLock(() => this.buildPlayerContextUnlocked());
  }

  private async buildPlayerContextUnlocked(): Promise<string> {
    const loaded = await this.loadUnlocked();
    const player = loaded.entities.get(loaded.manifest.playerId);
    const location = loaded.entities.get(loaded.manifest.currentLocationId);
    if (!player || !location) throw new Error("Campaign is missing the player or current location");
    const present = [...loaded.entities.values()]
      .filter((entity) => entity.location === location.id && entity.id !== player.id)
      .map((entity) => `- ${entity.name} (${entity.status})`)
      .join("\n");
    const inventory = player.inventory
      .map((entry) => `${entry.quantity} × ${loaded.entities.get(entry.entityId)?.name ?? entry.entityId}`)
      .join("\n");
    const recentLogs = await this.recentTurnLogsUnlocked(6);
    return renderContextDocument([
      contextSection("player-context", "PLAYER-VISIBLE CAMPAIGN CONTEXT", `Turn: ${loaded.manifest.turn}; Time: ${loaded.manifest.timeLabel}; Campaign status: ${loaded.manifest.status}`),
      contextSection("output-language", "OUTPUT LANGUAGE", `${loaded.manifest.language}\n${languageInstruction(loaded.manifest.language)}`),
      contextSection("character", "YOUR CHARACTER", renderEntity(player, false)),
      contextSection("inventory", "YOUR INVENTORY", inventory || "Empty."),
      contextSection("location", "CURRENT LOCATION", renderEntity(location, false)),
      contextSection("present", "NOTABLE PEOPLE OR CREATURES PRESENT", present || "Nobody else of note."),
      contextSection("threads", "KNOWN STORY THREADS", renderThreads(loaded.threads)),
      contextSection("recent-memory", "RECENT PLAY — SIX SUMMARIES, LATEST NARRATION ONLY", compactTurnHistory(recentLogs)),
    ]);
  }
}
