import { readFileSync } from "node:fs";
import path from "node:path";
import { parseEnv } from "node:util";

/**
 * Loads a project-local .env without replacing variables already supplied by
 * the shell or process manager. Values are never logged or persisted elsewhere.
 */
export function loadProjectEnv(
  root: string,
  environment: NodeJS.ProcessEnv = process.env,
): string[] {
  let parsed: NodeJS.Dict<string>;
  try {
    parsed = parseEnv(readFileSync(path.join(root, ".env"), "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }

  const loaded: string[] = [];
  for (const [name, value] of Object.entries(parsed)) {
    if (value === undefined) continue;
    if (environment[name] !== undefined) continue;
    environment[name] = value;
    loaded.push(name);
  }
  return loaded;
}

/**
 * Re-sources the project `.env` on explicit user request. Unlike the boot-time
 * {@link loadProjectEnv} — which defers to variables already supplied by the
 * shell or process manager — a manual reload treats `.env` as authoritative:
 * every value it defines is applied over the current environment, and keys the
 * process previously sourced from `.env` that are now absent are cleared. This
 * lets a key added or changed on disk take effect without a restart even when a
 * launcher exported that variable (often empty) into the process at startup.
 * Values are never logged or persisted elsewhere.
 */
export function reloadProjectEnv(
  root: string,
  environment: NodeJS.ProcessEnv,
  previouslyLoaded: Iterable<string>,
): string[] {
  for (const name of previouslyLoaded) delete environment[name];

  let parsed: NodeJS.Dict<string>;
  try {
    parsed = parseEnv(readFileSync(path.join(root, ".env"), "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }

  const loaded: string[] = [];
  for (const [name, value] of Object.entries(parsed)) {
    if (value === undefined) continue;
    environment[name] = value;
    loaded.push(name);
  }
  return loaded;
}
