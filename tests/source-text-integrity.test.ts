import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const REPOSITORY_ROOT = path.resolve(import.meta.dirname, "..");

/** Generated output and local runtime artifacts are not hand-maintained source. */
const SKIPPED_DIRECTORIES = new Set([
  ".git",
  "node_modules",
  "dist",
  "coverage",
  "data",
  "work",
  "playtests",
  "evaluations",
]);

const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".mjs", ".cjs", ".json", ".md"]);

async function* sourceFiles(directory: string): AsyncGenerator<string> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (SKIPPED_DIRECTORIES.has(entry.name)) continue;
      yield* sourceFiles(target);
      continue;
    }
    if (entry.isFile() && SOURCE_EXTENSIONS.has(path.extname(entry.name))) yield target;
  }
}

describe("source text integrity", () => {
  /**
   * A single NUL byte makes a file binary to `grep`, `rg`, and every text-based
   * scan, which silently skip it rather than reporting anything. The rule
   * registry's own collector spent time in that state: a search for the code
   * that reads a rule's disposition returned nothing while the code was there.
   *
   * Spelling that separator as a unicode escape sequence instead of embedding
   * the byte is identical at runtime and keeps the file searchable, so this
   * rules out only the invisible spelling.
   */
  it("keeps every source file searchable by text tools", async () => {
    const offenders: string[] = [];
    for await (const file of sourceFiles(REPOSITORY_ROOT)) {
      const contents = await readFile(file);
      if (contents.includes(0)) offenders.push(path.relative(REPOSITORY_ROOT, file));
    }

    expect(offenders).toEqual([]);
  });
});
