import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { listScenarioSeeds, loadScenarioSeed } from "../src/scenario-seeds.js";

async function seedFiles(
  root: string,
  id: string,
  language: string,
  prefix: string,
): Promise<void> {
  const dir = path.join(root, "defaults", "scenario-seeds", id, language);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "world.md"), `${prefix} world\n`, "utf8");
  await writeFile(path.join(dir, "premise.md"), `${prefix} premise\n`, "utf8");
  await writeFile(path.join(dir, "character.md"), `${prefix} character\n`, "utf8");
}

describe("scenario seeds", () => {
  it("returns an empty list when no seeds directory exists", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "llm-dungeon-seeds-empty-"));
    expect(await listScenarioSeeds(root)).toEqual([]);
  });

  it("lists seeds with titles derived from the folder id", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "llm-dungeon-seeds-list-"));
    await seedFiles(root, "dark-sun-sealed-oasis", "en", "EN");
    await seedFiles(root, "ashen-road", "en", "EN");
    expect(await listScenarioSeeds(root)).toEqual([
      { id: "ashen-road", title: "Ashen Road" },
      { id: "dark-sun-sealed-oasis", title: "Dark Sun Sealed Oasis" },
    ]);
  });

  it("loads the requested language and trims content", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "llm-dungeon-seeds-load-"));
    await seedFiles(root, "twin-suns", "en", "EN");
    await seedFiles(root, "twin-suns", "ru", "RU");
    const ru = await loadScenarioSeed(root, "twin-suns", "ru");
    expect(ru).toEqual({
      id: "twin-suns",
      title: "Twin Suns",
      worldRules: "RU world",
      premise: "RU premise",
      character: "RU character",
      language: "ru",
    });
  });

  it("falls back to the default language when the requested one is missing", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "llm-dungeon-seeds-fallback-"));
    await seedFiles(root, "twin-suns", "en", "EN");
    const seed = await loadScenarioSeed(root, "twin-suns", "ru");
    expect(seed.language).toBe("en");
    expect(seed.worldRules).toBe("EN world");
  });

  it("ships Kroll with bounded surface telepathy in both native languages", async () => {
    const [en, ru] = await Promise.all([
      loadScenarioSeed(process.cwd(), "dark-sun-sealed-oasis", "en"),
      loadScenarioSeed(process.cwd(), "dark-sun-sealed-oasis", "ru"),
    ]);

    expect(en.premise).toContain("Motherwell");
    expect(en.character).toContain("surface drift");
    expect(en.character).toContain("rather than a word-for-word inner voice");
    expect(en.character).toContain("whisper a brief new thought");
    expect(en.character).toContain("it cannot issue commands");
    expect(en.character).not.toContain("bare skin rests against an object");

    expect(ru.premise).toContain("Материнского Колодца");
    expect(ru.character).toContain("поверхностное течение");
    expect(ru.character).toContain("а не дословный внутренний голос");
    expect(ru.character).toContain("шепнуть в один близкий разум короткую новую мысль");
    expect(ru.character).toContain("не может отдавать приказы");
    expect(ru.character).not.toContain("голая кожа прижимается к предмету");
  });

  it("ships Dead Signal with a reusable world, bounded captain, crew, and courier ship", async () => {
    const [seed, ru] = await Promise.all([
      loadScenarioSeed(process.cwd(), "far-meridian-dead-signal", "en"),
      loadScenarioSeed(process.cwd(), "far-meridian-dead-signal", "ru"),
    ]);

    expect(seed.title).toBe("Far Meridian Dead Signal");
    expect(seed.premise).toContain("Mercy's End");
    expect(seed.premise).toContain("don't let them open the mine");
    expect(seed.premise).toContain("definite hidden explanation");
    expect(seed.premise).toContain("Do not decide the player's first action");
    expect(seed.character).toContain("Tala Venn — pilot and mechanic");
    expect(seed.character).toContain("Doctor Eli Mercer — medic and field scientist");
    expect(seed.character).toContain("It is not a warship");
    expect(seed.character).toContain("ancient gates at fixed points");
    expect(seed.character).toContain("Signal Sense cannot extract complete memories");
    expect(seed.worldRules).toContain("grounded space-western tone");
    expect(seed.worldRules).toContain("Never invent decisions, dialogue, beliefs");
    expect(seed.worldRules).not.toContain("Jace");
    expect(seed.worldRules).not.toContain("Signal Sense");
    expect(ru.language).toBe("ru");
    expect(ru.premise).toContain("Последнему Приюту");
    expect(ru.premise).toContain("не дай им открыть шахту");
    expect(ru.premise).toContain("Не решай за игрока");
    expect(ru.character).toContain("Тала Венн — пилот и механик");
    expect(ru.character).toContain("Доктор Илай Мерсер — медик и полевой учёный");
    expect(ru.character).toContain("Это не боевой корабль");
    expect(ru.character).toContain("Чувство сигнала не извлекает полные воспоминания");
    expect(ru.worldRules).toContain("приземлённый космический вестерн");
    expect(ru.worldRules).toContain("Никогда не выдумывай за персонажа игрока");
    expect(ru.worldRules).not.toContain("Джейс");
    expect(ru.worldRules).not.toContain("Чувство сигнала");
  });

  it("throws a not-found error for an unknown id", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "llm-dungeon-seeds-missing-"));
    await seedFiles(root, "twin-suns", "en", "EN");
    await expect(loadScenarioSeed(root, "no-such-seed", "en")).rejects.toThrow(/was not found/);
  });
});
