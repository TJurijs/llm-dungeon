import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { DEFAULT_LANGUAGE } from "./language.js";

/**
 * A shipped, read-only campaign seed. Each seed is a folder with one subfolder
 * per language, mirroring the worlds/<lang>.md convention:
 *   defaults/scenario-seeds/<id>/<lang>/{world,premise,character}.md
 */
export interface ScenarioSeedSummary {
  readonly id: string;
  readonly title: string;
}

export interface ScenarioSeed extends ScenarioSeedSummary {
  readonly worldRules: string;
  readonly premise: string;
  readonly character: string;
  /** The language folder actually used, after fallback. */
  readonly language: string;
}

const SEED_ID_PATTERN = /^[a-z][a-z0-9-]*$/;
const SEED_LANG_PATTERN = /^[a-z]{2}$/;

function titleFromId(id: string): string {
  return id.split("-").map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(" ");
}

function scenarioSeedsRoot(root: string): string {
  return path.join(root, "defaults", "scenario-seeds");
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/** Language folders that carry at least a world.md, sorted for deterministic fallback. */
async function seedLanguageDirs(idDir: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(idDir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const languages: string[] = [];
  for (const entry of entries) {
    if (entry.isDirectory() && SEED_LANG_PATTERN.test(entry.name)
      && await pathExists(path.join(idDir, entry.name, "world.md"))) {
      languages.push(entry.name);
    }
  }
  return languages.sort();
}

/** Lists shipped scenario seeds (any seed with at least one language). Returns [] if none exist. */
export async function listScenarioSeeds(root: string): Promise<ScenarioSeedSummary[]> {
  const rootDir = scenarioSeedsRoot(root);
  let entries;
  try {
    entries = await readdir(rootDir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const summaries: ScenarioSeedSummary[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !SEED_ID_PATTERN.test(entry.name)) continue;
    if ((await seedLanguageDirs(path.join(rootDir, entry.name))).length > 0) {
      summaries.push({ id: entry.name, title: titleFromId(entry.name) });
    }
  }
  return summaries.sort((left, right) => left.id.localeCompare(right.id));
}

/**
 * Loads one seed in the requested language, falling back to the default language
 * and then to any available language. Throws a "was not found" error for an unknown id.
 */
export async function loadScenarioSeed(root: string, id: string, language: string): Promise<ScenarioSeed> {
  if (!SEED_ID_PATTERN.test(id)) throw new Error(`Invalid scenario seed id: ${id}`);
  const idDir = path.join(scenarioSeedsRoot(root), id);
  const available = await seedLanguageDirs(idDir);
  const resolved = [language, DEFAULT_LANGUAGE].find((candidate) => available.includes(candidate)) ?? available[0];
  if (resolved === undefined) throw new Error(`Scenario seed was not found: ${id}`);
  const dir = path.join(idDir, resolved);
  try {
    const [worldRules, premise, character] = await Promise.all([
      readFile(path.join(dir, "world.md"), "utf8"),
      readFile(path.join(dir, "premise.md"), "utf8"),
      readFile(path.join(dir, "character.md"), "utf8"),
    ]);
    return {
      id,
      title: titleFromId(id),
      worldRules: worldRules.trim(),
      premise: premise.trim(),
      character: character.trim(),
      language: resolved,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error(`Scenario seed was not found: ${id}`);
    throw error;
  }
}
