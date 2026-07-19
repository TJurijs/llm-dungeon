import { randomUUID } from "node:crypto";
import { mkdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

const ATOMIC_RENAME_RETRY_DELAYS_MS = [25, 50, 100, 200, 400] as const;

function isTransientRenameError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "EPERM" || code === "EBUSY" || code === "EACCES";
}

async function renameWithTransientRetry(source: string, target: string): Promise<void> {
  for (const delayMs of [0, ...ATOMIC_RENAME_RETRY_DELAYS_MS]) {
    if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
    try {
      await rename(source, target);
      return;
    } catch (error) {
      if (!isTransientRenameError(error) || delayMs === ATOMIC_RENAME_RETRY_DELAYS_MS.at(-1)) throw error;
    }
  }
}

export async function pathExists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export async function unlinkIfExists(target: string): Promise<void> {
  try {
    await unlink(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

/** Write a complete file beside its destination, then atomically replace it. */
export async function atomicWriteText(target: string, content: string): Promise<void> {
  await mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.tmp-${process.pid}-${randomUUID()}`;
  try {
    await writeFile(temporary, content, "utf8");
    await renameWithTransientRetry(temporary, target);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

export function atomicWriteJson(target: string, value: unknown): Promise<void> {
  return atomicWriteText(target, `${JSON.stringify(value, null, 2)}\n`);
}
