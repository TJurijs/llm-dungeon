import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { atomicWriteJson } from "./persistence/files.js";

export const LanguageCodeSchema = z.enum(["en", "ru"]);
export type LanguageCode = z.infer<typeof LanguageCodeSchema>;

export const LANGUAGES: Record<LanguageCode, { nativeName: string; instruction: string }> = {
  en: {
    nativeName: "English",
    instruction: "Write all narration, dialogue, summaries, names, descriptions, and player-facing text in English.",
  },
  ru: {
    nativeName: "Русский",
    instruction: "Write all narration, dialogue, summaries, names, descriptions, and player-facing text in natural Russian. Keep machine IDs and operation type values unchanged.",
  },
};

export const AppConfigSchema = z.object({ language: LanguageCodeSchema.default("en") });
export type AppConfig = z.infer<typeof AppConfigSchema>;

export function languageInstruction(language: LanguageCode): string {
  return LANGUAGES[language].instruction;
}

export async function loadAppConfig(root: string): Promise<AppConfig> {
  try {
    return AppConfigSchema.parse(JSON.parse(await readFile(path.join(root, "config", "app.json"), "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { language: "en" };
    throw error;
  }
}

export async function saveAppConfig(root: string, config: AppConfig): Promise<void> {
  const target = path.join(root, "config", "app.json");
  await atomicWriteJson(target, AppConfigSchema.parse(config));
}

export function localizeInspection(text: string, language: LanguageCode): string {
  if (language !== "ru") return text;
  const replacements: Array<[RegExp, string]> = [
    [/## Description/g, "## Описание"],
    [/## Established Facts/g, "## Установленные факты"],
    [/## Player Knowledge/g, "## Знания игрока"],
    [/## History/g, "## История"],
    [/## Relationships/g, "## Отношения"],
    [/## Present/g, "## Присутствуют"],
    [/# Story Threads/g, "# Сюжетные линии"],
    [/## Active/g, "## Активные"],
    [/## Resolved/g, "## Завершённые"],
    [/## Failed/g, "## Проваленные"],
    [/## Player Action/g, "## Действие игрока"],
    [/## Narration/g, "## Повествование"],
    [/## Summary/g, "## Краткий итог"],
    [/_Nobody else of note\._/g, "_Больше никого примечательного._"],
    [/_None\._/g, "_Нет._"],
    [/_No description recorded\._/g, "_Описание отсутствует._"],
    [/Inventory is empty\./g, "Инвентарь пуст."],
  ];
  return replacements.reduce((value, [pattern, replacement]) => value.replace(pattern, replacement), text);
}
