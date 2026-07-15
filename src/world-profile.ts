import { createHash } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { languageDefinition, type LanguageCode } from "./language.js";
import { atomicWriteText } from "./persistence/files.js";

export type WorldProfileSource = "localized_override" | "legacy_override" | "default";

export interface ResolvedWorldProfile {
  readonly markdown: string;
  readonly path: string;
  readonly source: WorldProfileSource;
}

// Exact hash of the V1 English stock config/world.md. A modified legacy file
// is user-authored configuration and must continue to outrank shipped defaults.
const STOCK_LEGACY_WORLD_HASH = "09992f9cbdec82757694f10147c51447935a927591bf68e8de7c4d1d5c6b2f2d";

function contentHash(content: string): string {
  // Git may materialize the retired stock file with CRLF on Windows. Treat
  // line-ending conversion as the same file so it cannot shadow a native
  // language profile as a false "custom" override.
  const normalized = content.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
  return createHash("sha256").update(normalized).digest("hex");
}

async function readOptional(target: string): Promise<string | undefined> {
  try {
    return await readFile(target, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

/** Language-specific user override written by the CLI or Web settings. */
export function localizedWorldProfilePath(root: string, language: LanguageCode): string {
  return path.join(root, "config", "worlds", languageDefinition(language).worldProfileFile);
}

/** Read-only native profile shipped with the application. */
export function defaultWorldProfilePath(root: string, language: LanguageCode): string {
  return path.join(root, "defaults", "worlds", languageDefinition(language).worldProfileFile);
}

/** Compatibility path used by installations created before localized profiles. */
export function legacyWorldProfilePath(root: string): string {
  return path.join(root, "config", "world.md");
}

/**
 * Deterministic precedence:
 * 1. language-specific user override;
 * 2. a user-modified legacy config/world.md;
 * 3. the native shipped profile;
 * 4. an untouched legacy stock profile only if no native asset exists.
 */
export async function resolveWorldProfile(root: string, language: LanguageCode): Promise<ResolvedWorldProfile> {
  const localizedPath = localizedWorldProfilePath(root, language);
  const localized = await readOptional(localizedPath);
  if (localized !== undefined) return { markdown: localized, path: localizedPath, source: "localized_override" };

  const legacyPath = legacyWorldProfilePath(root);
  const legacy = await readOptional(legacyPath);
  const legacyIsCustom = legacy !== undefined && contentHash(legacy) !== STOCK_LEGACY_WORLD_HASH;
  if (legacyIsCustom) return { markdown: legacy, path: legacyPath, source: "legacy_override" };

  const defaultPath = defaultWorldProfilePath(root, language);
  const nativeDefault = await readOptional(defaultPath);
  if (nativeDefault !== undefined) return { markdown: nativeDefault, path: defaultPath, source: "default" };

  if (legacy !== undefined) return { markdown: legacy, path: legacyPath, source: "default" };
  throw new Error(`No world profile is available for language ${language}`);
}

/** Save creative guidance without mutating shipped defaults or legacy files. */
export async function saveWorldProfile(root: string, language: LanguageCode, markdown: string): Promise<string> {
  const target = localizedWorldProfilePath(root, language);
  await mkdir(path.dirname(target), { recursive: true });
  await atomicWriteText(target, markdown);
  return target;
}
