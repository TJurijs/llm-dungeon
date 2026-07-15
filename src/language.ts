import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { ENGLISH } from "./languages/en.js";
import { RUSSIAN } from "./languages/ru.js";
import type { CampaignSetupDefaults, LanguageDefinition } from "./languages/definition.js";
import { atomicWriteJson } from "./persistence/files.js";

/** The sole registration point for supported gameplay languages. */
export const LANGUAGES = {
  en: ENGLISH,
  ru: RUSSIAN,
} as const satisfies Record<string, LanguageDefinition>;

export type LanguageCode = keyof typeof LANGUAGES;

const LANGUAGE_CODES = Object.keys(LANGUAGES) as [LanguageCode, ...LanguageCode[]];
export const LanguageCodeSchema = z.enum(LANGUAGE_CODES);
export const DEFAULT_LANGUAGE: LanguageCode = "en";

export const AppConfigSchema = z.object({ language: LanguageCodeSchema.default(DEFAULT_LANGUAGE) });
export type AppConfig = z.infer<typeof AppConfigSchema>;

export function languageDefinition(language: LanguageCode): LanguageDefinition {
  return LANGUAGES[language];
}

export function languageInstruction(language: LanguageCode): string {
  return languageDefinition(language).instruction;
}

export function campaignSetupDefaults(language: LanguageCode): CampaignSetupDefaults {
  return languageDefinition(language).setupDefaults;
}

export async function loadAppConfig(root: string): Promise<AppConfig> {
  try {
    return AppConfigSchema.parse(JSON.parse(await readFile(path.join(root, "config", "app.json"), "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { language: DEFAULT_LANGUAGE };
    throw error;
  }
}

export async function saveAppConfig(root: string, config: AppConfig): Promise<void> {
  const target = path.join(root, "config", "app.json");
  await atomicWriteJson(target, AppConfigSchema.parse(config));
}
