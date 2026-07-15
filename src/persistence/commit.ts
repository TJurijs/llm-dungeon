import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { assertCampaignStateConsistency } from "../domain/state-consistency.js";
import {
  ManifestSchema,
  type Entity,
  type GameState,
} from "../schemas.js";
import {
  parseChronicle,
  parseEntity,
  parseThreads,
  entityFilename,
  validatePreparedTurnLog,
} from "./markdown.js";
import type { PendingCommit } from "./pending.js";
import { atomicWriteText, pathExists, unlinkIfExists } from "./files.js";

export function contentHash(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function commitTarget(currentDir: string, relative: string): string {
  const supported = relative === "manifest.json"
    || relative === "threads.md"
    || relative === "chronicle.md"
    || /^entities\/[^/\\]+\.md$/.test(relative)
    || /^turns\/\d{6}\.md$/.test(relative);
  if (
    !supported
    || relative.includes("\0")
    || path.posix.normalize(relative) !== relative
    || path.isAbsolute(relative)
    || path.win32.isAbsolute(relative)
  ) {
    throw new Error(`Unsafe or unsupported path in pending commit: ${relative}`);
  }
  const root = path.resolve(currentDir);
  const target = path.resolve(root, relative);
  if (!target.startsWith(`${root}${path.sep}`)) {
    throw new Error(`Unsafe or unsupported path in pending commit: ${relative}`);
  }
  return target;
}

async function validateProjectedSnapshot(
  currentDir: string,
  writes: Record<string, string>,
  targetManifest: GameState,
): Promise<void> {
  const entityDir = path.join(currentDir, "entities");
  const existingEntityDocuments = new Map<string, string>();
  const entityDocuments = new Map<string, string>();
  const plannedEntityFiles = new Set<string>();
  const existingEntityFiles = (await readdir(entityDir))
    .filter((name) => name.endsWith(".md"))
    .sort();
  for (const name of existingEntityFiles) {
    const content = await readFile(path.join(entityDir, name), "utf8");
    existingEntityDocuments.set(name, content);
    entityDocuments.set(name, content);
  }
  for (const [relative, content] of Object.entries(writes)) {
    if (relative.startsWith("entities/")) {
      const name = relative.slice("entities/".length);
      entityDocuments.set(name, content);
      plannedEntityFiles.add(name);
    }
  }

  const entities = new Map<string, Entity>();
  for (const [name, content] of [...entityDocuments.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    const entity = parseEntity(content, plannedEntityFiles.has(name));
    if (plannedEntityFiles.has(name)) {
      const existingContent = existingEntityDocuments.get(name);
      if (!existingContent) {
        if (name !== entityFilename(entity.id)) {
          throw new Error(`New entity ${entity.id} must use generated filename ${entityFilename(entity.id)}`);
        }
      } else {
        const existing = parseEntity(existingContent);
        if (entity.id !== existing.id) {
          throw new Error(`Planned entity write ${name} cannot change durable ID ${existing.id} to ${entity.id}`);
        }
        if (entity.kind !== existing.kind) {
          throw new Error(`Planned entity write ${name} cannot change immutable kind for ${existing.id}`);
        }
        if (entity.description !== existing.description) {
          throw new Error(`Planned entity write ${name} cannot rewrite immutable description for ${existing.id}`);
        }
        for (const trait of existing.traits) {
          if (!entity.traits.includes(trait)) {
            throw new Error(`Planned entity write ${name} drops established trait ${trait}`);
          }
        }
        const relationshipTargets = new Set(entity.relationships.map((relationship) => relationship.targetId));
        for (const relationship of existing.relationships) {
          if (!relationshipTargets.has(relationship.targetId)) {
            throw new Error(`Planned entity write ${name} drops relationship to ${relationship.targetId}`);
          }
        }
        const facts = new Map(entity.facts.map((fact) => [fact.id, fact]));
        for (const fact of existing.facts) {
          const retained = facts.get(fact.id);
          if (!retained) {
            throw new Error(`Planned entity write ${name} drops durable fact ${fact.id}`);
          }
          if (retained.section !== fact.section || retained.text !== fact.text) {
            throw new Error(`Planned entity write ${name} rewrites durable fact history ${fact.id}`);
          }
          if (!fact.active && retained.active) {
            throw new Error(`Planned entity write ${name} reactivates superseded fact ${fact.id}`);
          }
        }
      }
    }
    if (entities.has(entity.id)) {
      throw new Error(`Projected campaign contains duplicate entity ID ${entity.id} in ${name}`);
    }
    entities.set(entity.id, entity);
  }

  const currentThreads = parseThreads(await readFile(path.join(currentDir, "threads.md"), "utf8"));
  const threads = Object.prototype.hasOwnProperty.call(writes, "threads.md")
    ? parseThreads(writes["threads.md"]!, true)
    : currentThreads;
  if (Object.prototype.hasOwnProperty.call(writes, "threads.md")) {
    const plannedById = new Map(threads.map((thread) => [thread.id, thread]));
    for (const existing of currentThreads) {
      const planned = plannedById.get(existing.id);
      if (!planned) throw new Error(`Planned threads document drops existing thread ${existing.id}`);
      if (planned.title !== existing.title) {
        throw new Error(`Planned threads document changes immutable title for ${existing.id}`);
      }
      if (existing.status !== "active" && JSON.stringify(planned) !== JSON.stringify(existing)) {
        throw new Error(`Planned threads document rewrites terminal thread ${existing.id}`);
      }
    }
  }

  const currentChronicle = parseChronicle(await readFile(path.join(currentDir, "chronicle.md"), "utf8"));
  const chronicle = Object.prototype.hasOwnProperty.call(writes, "chronicle.md")
    ? parseChronicle(writes["chronicle.md"]!, true)
    : currentChronicle;
  if (Object.prototype.hasOwnProperty.call(writes, "chronicle.md")) {
    for (const [index, existing] of currentChronicle.entries()) {
      const planned = chronicle[index];
      if (!planned
        || planned.id !== existing.id
        || planned.text !== existing.text
        || planned.turn !== existing.turn) {
        throw new Error(`Planned chronicle document does not preserve event ${existing.id}`);
      }
    }
  }

  assertCampaignStateConsistency(targetManifest, entities, threads, chronicle);
}

interface ValidatedCommitPlan {
  targets: Map<string, string>;
  currentManifest: GameState;
  currentManifestText: string;
  targetManifestText: string;
}

async function validateCommitPlan(currentDir: string, commit: PendingCommit): Promise<ValidatedCommitPlan> {
  const targets = new Map(
    Object.keys(commit.writes).map((relative) => [relative, commitTarget(currentDir, relative)]),
  );
  const targetTurnPath = `turns/${String(commit.targetTurn).padStart(6, "0")}.md`;
  const turnPaths = Object.keys(commit.writes).filter((relative) => relative.startsWith("turns/"));
  if (!Object.prototype.hasOwnProperty.call(commit.writes, targetTurnPath)) {
    throw new Error(`Pending commit must write its target turn log ${targetTurnPath}`);
  }
  if (turnPaths.some((relative) => relative !== targetTurnPath)) {
    throw new Error("Pending commit may write only its target turn log");
  }

  const targetManifestText = commit.writes["manifest.json"]!;
  const targetManifestInput: unknown = JSON.parse(targetManifestText);
  if (!targetManifestInput || typeof targetManifestInput !== "object" || Array.isArray(targetManifestInput)) {
    throw new Error("Pending commit target manifest must be an object");
  }
  for (const key of [
    "schemaVersion",
    "campaignId",
    "title",
    "turn",
    "status",
    "playerId",
    "currentLocationId",
    "elapsedMinutes",
    "timeLabel",
    "language",
    "createdAt",
    "updatedAt",
  ]) {
    if (!Object.prototype.hasOwnProperty.call(targetManifestInput, key)) {
      throw new Error(`Pending commit target manifest is missing ${key}`);
    }
  }
  const targetManifest = ManifestSchema.parse(targetManifestInput);
  if (targetManifest.campaignId !== commit.campaignId || targetManifest.turn !== commit.targetTurn) {
    throw new Error("Pending commit target manifest does not match its recovery metadata");
  }

  const targetTurnText = commit.writes[targetTurnPath]!;
  const targetTurnLedger = validatePreparedTurnLog(targetTurnText);
  if (targetTurnLedger.turn !== commit.targetTurn) {
    throw new Error("Pending commit turn log metadata does not match its target turn");
  }
  const existingTurnPath = targets.get(targetTurnPath)!;
  if (await pathExists(existingTurnPath)) {
    const existingTurn = await readFile(existingTurnPath, "utf8");
    if (existingTurn !== targetTurnText) {
      throw new Error(`Pending commit cannot alter existing turn log ${targetTurnPath}`);
    }
  }

  const currentManifestText = await readFile(path.join(currentDir, "manifest.json"), "utf8");
  const currentManifest = ManifestSchema.parse(JSON.parse(currentManifestText));
  if (currentManifest.campaignId !== commit.campaignId) {
    throw new Error("Pending commit belongs to another campaign");
  }
  if (targetManifest.schemaVersion !== currentManifest.schemaVersion
    || targetManifest.campaignId !== currentManifest.campaignId
    || targetManifest.title !== currentManifest.title
    || targetManifest.playerId !== currentManifest.playerId
    || targetManifest.language !== currentManifest.language
    || targetManifest.createdAt !== currentManifest.createdAt) {
    throw new Error("Pending commit changes immutable campaign manifest fields");
  }
  if (currentManifest.turn !== commit.expectedPreviousTurn && currentManifest.turn !== commit.targetTurn) {
    throw new Error(`Pending commit expected turn ${commit.expectedPreviousTurn} or ${commit.targetTurn}, found ${currentManifest.turn}`);
  }
  if (currentManifest.turn === commit.expectedPreviousTurn) {
    if (currentManifest.status !== "active") {
      throw new Error("A terminal campaign cannot prepare another turn commit");
    }
    if (targetManifest.elapsedMinutes < currentManifest.elapsedMinutes) {
      throw new Error("Pending commit cannot rewind elapsed campaign time");
    }
  }
  if (currentManifest.turn === commit.expectedPreviousTurn
    && contentHash(currentManifestText) !== commit.preManifestHash) {
    throw new Error("Pending commit pre-state manifest hash does not match");
  }

  // Overlay every planned payload in memory and validate the resulting complete
  // campaign before the first authoritative write. This catches individually
  // malformed documents as well as valid documents whose references conflict.
  await validateProjectedSnapshot(currentDir, commit.writes, targetManifest);

  return { targets, currentManifest, currentManifestText, targetManifestText };
}

async function assertCommittedWritesMatch(
  commit: PendingCommit,
  targets: Map<string, string>,
): Promise<void> {
  for (const [relative, expected] of Object.entries(commit.writes)) {
    const target = targets.get(relative)!;
    if (!(await pathExists(target))) {
      throw new Error(`Committed campaign is missing planned write ${relative}`);
    }
    if (await readFile(target, "utf8") !== expected) {
      throw new Error(`Committed campaign differs from planned write ${relative}`);
    }
  }
}

/** Execute a fully preflighted pending commit, with the manifest written last. */
export async function executePendingCommit(
  currentDir: string,
  pendingPath: string,
  commit: PendingCommit,
): Promise<void> {
  const plan = await validateCommitPlan(currentDir, commit);
  if (plan.currentManifest.turn === commit.targetTurn) {
    if (plan.currentManifestText !== plan.targetManifestText) {
      throw new Error("Committed target manifest differs from the pending recovery record");
    }
    await assertCommittedWritesMatch(commit, plan.targets);
    await unlinkIfExists(pendingPath);
    return;
  }

  const orderedWrites = Object.entries(commit.writes).sort(([left], [right]) => {
    if (left === "manifest.json") return 1;
    if (right === "manifest.json") return -1;
    return left.localeCompare(right);
  });
  for (const [relative, content] of orderedWrites) {
    await atomicWriteText(plan.targets.get(relative)!, content);
  }
  await unlinkIfExists(pendingPath);
}
