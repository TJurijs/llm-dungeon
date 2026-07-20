import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { PlaytestManifestSchema, type PlaytestManifest } from "./contracts.js";

export async function readPlaytestManifest(target: string): Promise<PlaytestManifest> {
  return PlaytestManifestSchema.parse(JSON.parse(await readFile(target, "utf8")));
}

export async function readOptionalPlaytestManifest(target: string): Promise<PlaytestManifest | undefined> {
  try {
    return await readPlaytestManifest(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export function playtestCodeVersion(projectRoot: string): PlaytestManifest["codeVersion"] {
  const hasher = createHash("sha256");
  const collect = (directory: string): string[] => {
    try {
      return readdirSync(directory)
        .flatMap((name) => {
          const target = path.join(directory, name);
          return statSync(target).isDirectory() ? collect(target) : [target];
        })
        .sort();
    } catch {
      return [];
    }
  };
  for (const target of [path.join(projectRoot, "package.json"), ...collect(path.join(projectRoot, "src"))]) {
    try {
      hasher.update(path.relative(projectRoot, target));
      hasher.update(readFileSync(target));
    } catch {
      // Missing optional source files do not contribute to the version hash.
    }
  }
  const sourceHash = hasher.digest("hex");
  try {
    const options = {
      cwd: projectRoot,
      encoding: "utf8" as const,
      stdio: ["ignore", "pipe", "ignore"] as ["ignore", "pipe", "ignore"],
    };
    const commit = execFileSync("git", ["rev-parse", "HEAD"], options).trim();
    const dirty = Boolean(execFileSync("git", ["status", "--porcelain"], options).trim());
    return { commit, dirty, sourceHash };
  } catch {
    return { commit: null, dirty: null, sourceHash };
  }
}
