import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile, truncate } from "node:fs/promises";
import path from "node:path";

export async function appendPlaytestJsonLine(target: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(target), { recursive: true });
  let separator = "";
  try {
    const existing = await readFile(target);
    if (existing.length > 0 && existing.at(-1) !== 0x0a) {
      const lastNewline = existing.lastIndexOf(0x0a);
      const tail = existing.subarray(lastNewline + 1).toString("utf8");
      try {
        JSON.parse(tail);
        separator = "\n";
      } catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
        await truncate(target, lastNewline + 1);
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await appendFile(target, `${separator}${JSON.stringify(value)}\n`, "utf8");
}

/** Reads complete records and conservatively ignores only an incomplete final write. */
export async function readPlaytestJsonLines<T>(target: string): Promise<T[]> {
  let text: string;
  try {
    text = await readFile(target, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const lines = text.split("\n");
  const lastNonempty = lines.findLastIndex((line) => line.trim().length > 0);
  const result: T[] = [];
  for (const [index, line] of lines.entries()) {
    if (!line.trim()) continue;
    try {
      result.push(JSON.parse(line) as T);
    } catch (error) {
      if (error instanceof SyntaxError && index === lastNonempty && !text.endsWith("\n")) break;
      throw error;
    }
  }
  return result;
}

export function hashPlaytestValue(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
