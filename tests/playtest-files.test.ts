import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  appendPlaytestJsonLine,
  readPlaytestJsonLines,
} from "../src/playtest/files.js";

describe("playtest JSONL recovery", () => {
  it("removes an interrupted final fragment before appending a resumed record", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "llm-dungeon-jsonl-"));
    const target = path.join(root, "turns.jsonl");
    await writeFile(target, '{"turn":1}\n{"turn":', "utf8");

    expect(await readPlaytestJsonLines(target)).toEqual([{ turn: 1 }]);
    await appendPlaytestJsonLine(target, { turn: 2 });

    expect(await readPlaytestJsonLines(target)).toEqual([{ turn: 1 }, { turn: 2 }]);
    expect(await readFile(target, "utf8")).toBe('{"turn":1}\n{"turn":2}\n');
  });

  it("separates a complete final record that merely lacks its newline", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "llm-dungeon-jsonl-complete-"));
    const target = path.join(root, "calls.jsonl");
    await writeFile(target, '{"sequence":1}', "utf8");
    await appendPlaytestJsonLine(target, { sequence: 2 });
    expect(await readPlaytestJsonLines(target)).toEqual([{ sequence: 1 }, { sequence: 2 }]);
  });
});
