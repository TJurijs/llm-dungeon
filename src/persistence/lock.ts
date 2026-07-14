import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, stat, unlink } from "node:fs/promises";
import path from "node:path";

interface LockOwner {
  pid: number;
  token: string;
  createdAt: string;
}

function processIsRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function removeStaleLock(target: string): Promise<boolean> {
  let owner: LockOwner | undefined;
  try {
    owner = JSON.parse(await readFile(target, "utf8")) as LockOwner;
  } catch {
    // A creator can briefly own an empty lock file before its metadata lands.
  }
  if (owner && Number.isInteger(owner.pid) && processIsRunning(owner.pid)) return false;
  if (!owner) {
    const ageMs = Date.now() - (await stat(target)).mtimeMs;
    if (ageMs < 30_000) return false;
  }
  try {
    await unlink(target);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw error;
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
