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

/** Replaces only values this process previously loaded from the project `.env`. */
export function reloadProjectEnv(
  root: string,
  environment: NodeJS.ProcessEnv,
  previouslyLoaded: Iterable<string>,
): string[] {
  for (const name of previouslyLoaded) delete environment[name];
  return loadProjectEnv(root, environment);
}
