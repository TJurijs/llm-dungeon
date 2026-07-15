import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  EvaluationManifestSchema,
  type EvaluationManifest,
} from "./contracts.js";

export async function readEvaluationManifest(manifestPath: string): Promise<EvaluationManifest> {
  return EvaluationManifestSchema.parse(JSON.parse(await readFile(manifestPath, "utf8")));
}

export async function readOptionalEvaluationManifest(
  manifestPath: string,
): Promise<EvaluationManifest | undefined> {
  try {
    return await readEvaluationManifest(manifestPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export function codeVersion(projectRoot: string): EvaluationManifest["codeVersion"] {
  const sourceHasher = createHash("sha256");
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
      sourceHasher.update(path.relative(projectRoot, target));
      sourceHasher.update(readFileSync(target));
    } catch {
      // Missing optional source files simply do not contribute to the hash.
    }
  }
  const sourceHash = sourceHasher.digest("hex");
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
