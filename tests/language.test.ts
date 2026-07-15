import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  LANGUAGES,
  LanguageCodeSchema,
  campaignSetupDefaults,
  languageDefinition,
  languageInstruction,
  loadAppConfig,
  saveAppConfig,
} from "../src/language.js";
import { localizedWorldProfilePath, resolveWorldProfile } from "../src/world-profile.js";
import { StateStore } from "../src/store.js";
import { setupFixture } from "./helpers.js";

async function temporaryProject(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "llm-dungeon-language-"));
}

describe("language registry", () => {
  it("derives accepted language codes and behavior from one registry", () => {
    expect(LanguageCodeSchema.options).toEqual(Object.keys(LANGUAGES));
    expect(LanguageCodeSchema.parse("en")).toBe("en");
    expect(LanguageCodeSchema.parse("ru")).toBe("ru");
    expect(() => LanguageCodeSchema.parse("unknown")).toThrow();

    expect(languageInstruction("en")).toContain("in English");
    expect(languageInstruction("ru")).toContain("natural Russian");
  });

  it("provides native setup defaults for every registered language", () => {
    const english = campaignSetupDefaults("en");
    const russian = campaignSetupDefaults("ru");

    expect(english.premise).toBe("A classical opening in a tavern, with immediate but optional possibilities.");
    expect(english.characterConcept).toBe("Create a grounded adventurer with two useful traits and one complicating trait.");
    expect(russian.premise).toMatch(/[А-Яа-яЁё]/);
    expect(russian.characterConcept).toMatch(/[А-Яа-яЁё]/);
    expect(russian).not.toEqual(english);
  });

  it("provides structured inspection copy for every registered language", () => {
    expect(languageDefinition("en").inspection).toMatchObject({
      character: "Character",
      inventory: "Inventory",
      features: "Features",
    });
    expect(languageDefinition("ru").inspection).toMatchObject({
      character: "Персонаж",
      inventory: "Инвентарь",
      features: "Особенности",
    });
  });

  it("continues to read and write the existing app.json shape", async () => {
    const root = await temporaryProject();
    try {
      expect(await loadAppConfig(root)).toEqual({ language: "en" });
      await mkdir(path.join(root, "config"), { recursive: true });
      await writeFile(path.join(root, "config", "app.json"), '{"language":"ru"}\n', "utf8");
      expect(await loadAppConfig(root)).toEqual({ language: "ru" });

      await saveAppConfig(root, { language: "en" });
      expect(JSON.parse(await readFile(path.join(root, "config", "app.json"), "utf8"))).toEqual({ language: "en" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("localized world profiles", () => {
  it("prefers the native profile selected by the language registry", async () => {
    const root = await temporaryProject();
    try {
      await mkdir(path.join(root, "config", "worlds"), { recursive: true });
      await writeFile(path.join(root, "config", "worlds", "ru.md"), "# Русский мир\n", "utf8");
      await writeFile(path.join(root, "config", "world.md"), "# Legacy English world\n", "utf8");

      const profile = await resolveWorldProfile(root, "ru");
      expect(profile).toEqual({
        markdown: "# Русский мир\n",
        path: localizedWorldProfilePath(root, "ru"),
        source: "localized_override",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("falls back to legacy config/world.md when a localized profile is absent", async () => {
    const root = await temporaryProject();
    try {
      await mkdir(path.join(root, "config"), { recursive: true });
      await writeFile(path.join(root, "config", "world.md"), "# Existing custom world\n", "utf8");

      const profile = await resolveWorldProfile(root, "ru");
      expect(profile.markdown).toBe("# Existing custom world\n");
      expect(profile.path).toBe(path.join(root, "config", "world.md"));
      expect(profile.source).toBe("legacy_override");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("ships equivalent native English and Russian profiles", async () => {
    const root = process.cwd();
    const english = await resolveWorldProfile(root, "en");
    const russian = await resolveWorldProfile(root, "ru");

    expect(english.source).toBe("default");
    expect(english.markdown).toContain("# Classic Fantasy Sandbox");
    expect(russian.source).toBe("default");
    expect(russian.markdown).toContain("# Классическое фэнтези");
    expect(russian.markdown).not.toContain("## Setting");
  });
});

describe("localized deterministic campaign text", () => {
  it("stores the synthetic opening action and summary in the campaign language", async () => {
    const root = await temporaryProject();
    try {
      const store = new StateStore(path.join(root, "data"));
      await store.createGame({ setup: setupFixture, worldRules: "# Мир\n", language: "ru" });
      const [opening] = await store.recentTranscript(1);
      expect(opening?.action).toBe("Кампания начинается.");
      expect(opening?.summary).toBe("Кампания началась.");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
