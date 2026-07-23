import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { listScenarioSeeds, loadScenarioSeed } from "../src/scenario-seeds.js";

async function seedFiles(root: string, id: string, language: string, prefix: string): Promise<void> {
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

  it("throws a not-found error for an unknown id", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "llm-dungeon-seeds-missing-"));
    await seedFiles(root, "twin-suns", "en", "EN");
    await expect(loadScenarioSeed(root, "no-such-seed", "en")).rejects.toThrow(/was not found/);
  });
});
