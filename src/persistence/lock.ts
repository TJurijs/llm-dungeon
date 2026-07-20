import { createHash, randomUUID } from "node:crypto";
import type { Stats } from "node:fs";
import { mkdir, open, readFile, stat, unlink } from "node:fs/promises";
import path from "node:path";

interface LockOwner {
  pid: number;
  token: string;
  createdAt: string;
}

interface LockSnapshot {
  fingerprint: string;
  modifiedAt: number;
  owner: LockOwner | undefined;
}

type LockSnapshotResult =
  | { kind: "missing" }
  | { kind: "unstable" }
  | { kind: "present"; snapshot: LockSnapshot };

function isTransientWindowsLockError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return process.platform === "win32" && (code === "EPERM" || code === "EBUSY");
}

const INCOMPLETE_LOCK_GRACE_MS = 30_000;
const MAX_RECLAIM_CLAIM_GENERATIONS = 1_000;

function processIsRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function parseLockOwner(contents: Buffer): LockOwner | undefined {
  try {
    const value = JSON.parse(contents.toString("utf8")) as Partial<LockOwner>;
    if (!Number.isSafeInteger(value.pid) || value.pid! <= 0) return undefined;
    if (typeof value.token !== "string" || !value.token) return undefined;
    if (typeof value.createdAt !== "string" || !value.createdAt) return undefined;
    return value as LockOwner;
  } catch {
    return undefined;
  }
}

function sameFileVersion(left: Stats, right: Stats): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs;
}

async function readLockSnapshot(target: string): Promise<LockSnapshotResult> {
  let before: Stats;
  let contents: Buffer;
  let after: Stats;
  try {
    before = await stat(target);
    contents = await readFile(target);
    after = await stat(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "missing" };
    if (isTransientWindowsLockError(error)) return { kind: "unstable" };
    throw error;
  }
  if (!sameFileVersion(before, after)) return { kind: "unstable" };
  const fileIdentity = JSON.stringify({
    dev: after.dev,
    ino: after.ino,
    size: after.size,
    mtimeMs: after.mtimeMs,
    ctimeMs: after.ctimeMs,
  });
  return {
    kind: "present",
    snapshot: {
      fingerprint: createHash("sha256").update(fileIdentity).update("\0").update(contents).digest("hex"),
      modifiedAt: after.mtimeMs,
      owner: parseLockOwner(contents),
    },
  };
}

function snapshotIsStale(snapshot: LockSnapshot): boolean {
  if (snapshot.owner) return !processIsRunning(snapshot.owner.pid);
  return Date.now() - snapshot.modifiedAt >= INCOMPLETE_LOCK_GRACE_MS;
}

async function claimStaleSnapshot(target: string, fingerprint: string): Promise<boolean> {
  // Generations are intentionally append-only. Reusing or deleting one while
  // its target snapshot can still exist would reintroduce an ABA cleanup race.
  for (let generation = 0; generation < MAX_RECLAIM_CLAIM_GENERATIONS; generation += 1) {
    const claimPath = `${target}.reclaim-${fingerprint}.${generation}`;
    try {
      const handle = await open(claimPath, "wx", 0o600);
      try {
        await handle.writeFile(`${JSON.stringify({
          pid: process.pid,
          token: randomUUID(),
          createdAt: new Date().toISOString(),
        })}\n`, "utf8");
      } finally {
        await handle.close();
      }
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const existing = await readLockSnapshot(claimPath);
      if (existing.kind === "unstable") return false;
      if (existing.kind === "missing") return false;
      if (!snapshotIsStale(existing.snapshot)) return false;
    }
  }
  throw new Error("Lock reclamation has too many abandoned claims");
}

async function removeStaleLock(target: string): Promise<boolean> {
  const observed = await readLockSnapshot(target);
  if (observed.kind === "missing") return true;
  if (observed.kind === "unstable" || !snapshotIsStale(observed.snapshot)) return false;
  if (!await claimStaleSnapshot(target, observed.snapshot.fingerprint)) return false;

  const current = await readLockSnapshot(target);
  if (current.kind === "missing") return true;
  if (current.kind === "unstable" || current.snapshot.fingerprint !== observed.snapshot.fingerprint) return false;
  try {
    await unlink(target);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw error;
  }
}

const serializedProcessQueues = new Map<string, Promise<void>>();

export interface SerializedFileLockOptions {
  /** How long to keep retrying a lock held by another process. */
  waitMs?: number;
  /** Delay between lock acquisition retries. */
  retryMs?: number;
}

async function acquireFileLockWithRetry(
  target: string,
  label: string,
  waitMs: number,
  retryMs: number,
): Promise<() => Promise<void>> {
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      return await acquireFileLock(target, label);
    } catch (error) {
      if (!/locked by another running process/i.test(String((error as Error).message)) || Date.now() >= deadline) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, retryMs));
    }
  }
}

/**
 * Serialize same-process callers per lock path, then run the operation while
 * holding the cross-process lock file, retrying a busy lock within a bounded
 * wait. This is the shared exclusive-mutation pattern for every JSON store
 * that a second app or harness process may touch concurrently.
 */
export async function withSerializedFileLock<T>(
  target: string,
  label: string,
  operation: () => Promise<T>,
  options: SerializedFileLockOptions = {},
): Promise<T> {
  const queueKey = path.resolve(target);
  const previous = serializedProcessQueues.get(queueKey) ?? Promise.resolve();
  let releaseQueue!: () => void;
  const current = new Promise<void>((resolve) => { releaseQueue = resolve; });
  const tail = previous.then(() => current, () => current);
  serializedProcessQueues.set(queueKey, tail);
  await previous.catch(() => undefined);
  try {
    const release = await acquireFileLockWithRetry(target, label, options.waitMs ?? 5_000, options.retryMs ?? 25);
    try {
      return await operation();
    } finally {
      await release();
    }
  } finally {
    releaseQueue();
    if (serializedProcessQueues.get(queueKey) === tail) serializedProcessQueues.delete(queueKey);
  }
}

/** Acquire a crash-recoverable, cross-process exclusive lock file. */
export async function acquireFileLock(target: string, label: string): Promise<() => Promise<void>> {
  await mkdir(path.dirname(target), { recursive: true });
  const token = randomUUID();
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(target, "wx", 0o600);
      try {
        await handle.writeFile(`${JSON.stringify({ pid: process.pid, token, createdAt: new Date().toISOString() })}\n`, "utf8");
      } finally {
        await handle.close();
      }
      return async () => {
        let current: LockOwner | undefined;
        try {
          current = JSON.parse(await readFile(target, "utf8")) as LockOwner;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
          throw error;
        }
        if (current.token !== token) throw new Error(`${label} lock ownership changed unexpectedly`);
        await unlink(target);
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (attempt === 0 && await removeStaleLock(target)) continue;
      throw new Error(`${label} is locked by another running process`);
    }
  }
  throw new Error(`${label} lock could not be acquired`);
}
