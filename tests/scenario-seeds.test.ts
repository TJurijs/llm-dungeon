import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  listScenarioSeeds,
  loadScenarioSeed,
  loadScenarioSeedSetupRequirements,
} from "../src/scenario-seeds.js";
import { assertNewCampaignOriginInputFits } from "../src/store.js";

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
    const [seed, ru, requirements] = await Promise.all([
      loadScenarioSeed(process.cwd(), "far-meridian-dead-signal", "en"),
      loadScenarioSeed(process.cwd(), "far-meridian-dead-signal", "ru"),
      loadScenarioSeedSetupRequirements(process.cwd(), "far-meridian-dead-signal"),
    ]);

    expect(seed.title).toBe("Far Meridian Dead Signal");
    expect(requirements?.entities.map((requirement) => requirement.id)).toEqual(
      expect.arrayContaining([
        "location:mercy-end",
        "location:shelter",
        "faction:mercy-end-colonists",
        "item:sealed-object",
        "item:containment-key",
        "item:transfer-device",
      ]),
    );
    expect(requirements?.threadLinks).toHaveLength(2);
    expect(seed.premise).toContain("Mercy's End");
    expect(seed.premise).toContain("don't let them open the mine");
    expect(seed.premise).toContain("after landing and before the audit");
    expect(seed.premise).toContain("The alarm marks detection, not transfer");
    expect(seed.premise).toContain(
      "Ground equipment cannot remove cargo in flight, during descent, or in orbit",
    );
    expect(seed.premise).toContain("a pre-landing transfer contradicts the scan");
    expect(seed.premise).toContain("was aboard at touchdown");
    expect(seed.premise).toContain("one definite hidden chronology");
    expect(seed.premise).toContain("reveal it only through evidence");
    expect(seed.premise).toContain("recording's physical performer or source");
    expect(seed.premise).toContain("why Jace's likeness and date appear");
    expect(seed.premise).toContain(
      "the warning concerns reopening it, a deeper sealed boundary, or removing containment",
    );
    expect(seed.premise).toContain(
      "Model every central hidden actor, machine, and object as an exact entity",
    );
    expect(seed.premise).toContain(
      "filmed sealed object keeps one identity, bounded capability, and final custody",
    );
    expect(seed.premise).toContain(
      "never turn it into a different cipher plate, key, or substitute",
    );
    expect(seed.premise).toContain("The DM knows Alpha's true custody");
    expect(seed.premise).toContain("exact holder or smallest known containing location");
    expect(seed.premise).toContain("never only the broad landing pad, colony, or mine");
    expect(seed.premise).toContain(
      "Put only its player-known absence in playerKnowledge and the safe cargo-thread summary",
    );
    expect(seed.premise).toContain(
      "complete transfer chronology, route, mechanism, and custody in DM-only state",
    );
    expect(seed.premise).toContain(
      "Privately link that thread to Alpha, the actor or source, mechanism, route anchors",
    );
    expect(seed.premise).toContain("utility drone and environmental suits as ship-owned items");
    expect(seed.premise).toContain("records and seeded gear outrank optional currency");
    expect(seed.premise).toContain("Mara's fate is unknown to the player");
    expect(seed.premise).toContain("first response left to the player");
    expect(seed.premise).not.toMatch(/Mara (?:is|was) (?:alive|dead|killed|hidden|held)/i);
    expect(seed.premise).not.toMatch(/Alpha (?:is|was) (?:held|hidden|stored) (?:by|in|at)/i);
    expect(seed.premise).not.toMatch(/the recording (?:was|is) (?:made|performed|spoken) by/i);
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
    expect(ru.premise).toContain("перемещение происходит после посадки и до проверки");
    expect(ru.premise).toContain("Сигнализация отмечает обнаружение, а не само перемещение");
    expect(ru.premise).toContain(
      "Наземная техника не может вынести груз в полёте, при снижении или на орбите",
    );
    expect(ru.premise).toContain("более раннее перемещение противоречит сканированию");
    expect(ru.premise).toContain("присутствие при касании");
    expect(ru.premise).toContain("одну скрытую хронологию");
    expect(ru.premise).toContain("раскрывай её только через улики");
    expect(ru.premise).toContain("исполнителя или источник записи");
    expect(ru.premise).toContain("причину сходства и даты Джейса");
    expect(ru.premise).toContain(
      "предупреждение касается повторного открытия, более глубокой границы либо снятия изоляции",
    );
    expect(ru.premise).toContain(
      "точные сущности для главных тайных участников, механизмов и предметов",
    );
    expect(ru.premise).toContain(
      "Предмет на записи сохраняет одну личность, ограниченную функцию и конечного владельца",
    );
    expect(ru.premise).toContain("не превращай его в другую шифропластину, ключ или замену");
    expect(ru.premise).toContain("Местонахождение «Альфы» известно ведущему");
    expect(ru.premise).toContain("точному владельцу или в самое узкое известное хранилище");
    expect(ru.premise).toContain("Только известное игроку отсутствие помести в playerKnowledge");
    expect(ru.premise).toContain(
      "полную хронологию, маршрут, механизм и владельца храни в тайном состоянии",
    );
    expect(ru.premise).toContain(
      "Тайно свяжи ветку с «Альфой», участником или источником, механизмом, точками маршрута",
    );
    expect(ru.premise).toContain("грузовой дрон и скафандры как корабельные предметы");
    expect(ru.premise).toContain("важнее необязательной валюты");
    expect(ru.premise).toContain("Судьба Мары неизвестна игроку");
    expect(ru.premise).toContain("оставив первый ответ игроку");
    expect(ru.premise).not.toMatch(/Мара (?:жива|мертва|убита|спрятана|удерживается)/i);
    expect(ru.premise).not.toMatch(/«Альфа» (?:находится|спрятана|хранится) (?:у|в|на)/i);
    expect(ru.premise).not.toMatch(/запись (?:создал|сделал|исполнил|озвучил) /i);
    expect(ru.character).toContain("Тала Венн — пилот и механик");
    expect(ru.character).toContain("Доктор Илай Мерсер — медик и полевой учёный");
    expect(ru.character).toContain("Это не боевой корабль");
    expect(ru.character).toContain("Чувство сигнала не извлекает полные воспоминания");
    expect(ru.worldRules).toContain("приземлённый космический вестерн");
    expect(ru.worldRules).toContain("Никогда не выдумывай за персонажа игрока");
    expect(ru.worldRules).not.toContain("Джейс");
    expect(ru.worldRules).not.toContain("Чувство сигнала");
    expect(() =>
      assertNewCampaignOriginInputFits({
        worldRules: seed.worldRules,
        premise: seed.premise,
        character: seed.character,
      }),
    ).not.toThrow();
    expect(() =>
      assertNewCampaignOriginInputFits({
        worldRules: ru.worldRules,
        premise: ru.premise,
        character: ru.character,
      }),
    ).not.toThrow();
  });

  it("throws a not-found error for an unknown id", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "llm-dungeon-seeds-missing-"));
    await seedFiles(root, "twin-suns", "en", "EN");
    await expect(loadScenarioSeed(root, "no-such-seed", "en")).rejects.toThrow(/was not found/);
  });
});
