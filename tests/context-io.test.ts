import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

const observedIo = vi.hoisted(() => ({
  readPaths: [] as string[],
  directoryPaths: [] as string[],
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    readFile: async (...args: unknown[]) => {
      observedIo.readPaths.push(String(args[0]));
      return Reflect.apply(actual.readFile, actual, args);
    },
    readdir: async (...args: unknown[]) => {
      observedIo.directoryPaths.push(String(args[0]));
      return Reflect.apply(actual.readdir, actual, args);
    },
  };
});

import { renderTurnLog } from "../src/persistence/markdown.js";
import { createTestStore } from "./helpers.js";

function syntheticTurn(turn: number): string {
  return renderTurnLog(turn, {
    action: `Bounded I/O action ${turn}`,
    resolved: {
      narration: `Bounded I/O narration ${turn}`,
      turnSummary: `Bounded I/O summary ${turn}`,
      operations: [],
    },
    provider: "fake",
    model: "fake-model",
  });
}

describe("long-run context I/O", () => {
  it("reads a fixed recent window directly at turn 10,000 without enumerating the turn archive", async () => {
    const store = await createTestStore();
    const latestTurn = 10_000;
    const turnsDirectory = path.join(store.currentDir, "turns");
    for (let turn = latestTurn - 7; turn <= latestTurn; turn += 1) {
      await writeFile(
        path.join(turnsDirectory, `${String(turn).padStart(6, "0")}.md`),
        syntheticTurn(turn),
        "utf8",
      );
    }
    const manifestPath = path.join(store.currentDir, "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
    manifest.turn = latestTurn;
    manifest.updatedAt = new Date().toISOString();
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

    observedIo.readPaths.length = 0;
    observedIo.directoryPaths.length = 0;
    const context = await store.buildContextDocument("I continue the investigation.");

    const turnReads = observedIo.readPaths.filter(
      (target) => target.startsWith(`${turnsDirectory}${path.sep}`) && target.endsWith(".md"),
    );
    expect(context.text).toContain("Bounded I/O summary 10000");
    // Eight recent summaries plus one latest gameplay-ledger read. The count is
    // independent of the manifest turn and never requires listing the archive.
    expect(turnReads).toHaveLength(9);
    expect(observedIo.directoryPaths).not.toContain(turnsDirectory);
  });
});
