import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { readLegacyEvaluationManifest } from "../src/legacy-evaluation-artifacts.js";
import { resolveCheck } from "../src/mechanics.js";
import {
  evaluationArtifactPath,
  evaluationTranscriptPresentation,
} from "../src/web/evaluation-artifacts.js";

async function legacyFixture(): Promise<{
  root: string;
  manifestPath: string;
  markdown: string;
}> {
  const root = await mkdtemp(path.join(tmpdir(), "llm-dungeon-legacy-evaluation-"));
  const runDir = path.join(root, "runs", "legacy-run");
  const sessionDir = path.join(runDir, "sessions", "session-one");
  await mkdir(sessionDir, { recursive: true });
  const manifestPath = path.join(runDir, "manifest.json");
  await writeFile(manifestPath, `${JSON.stringify({
    schemaVersion: 1,
    runId: "legacy-run",
    config: {
      language: "en",
      provider: "historical-provider",
      maxCostUsd: 5,
    },
    sessions: [{
      id: "session-one",
      profile: "cautious-investigator",
      status: "completed",
    }],
    historicalOnly: true,
  })}\n`, "utf8");
  const check = resolveCheck({
    name: "Investigation",
    difficulty: 40,
    modifiers: [{ label: "Careful search", value: 5 }],
    successStakes: "The clue is found.",
    failureStakes: "The clue remains hidden.",
  }, 55);
  await writeFile(path.join(sessionDir, "turns.jsonl"), `${JSON.stringify({
    turn: 1,
    action: "Inspect the sealed desk.",
    approach: "investigation",
    narration: "A maker's mark is visible beneath the drawer.",
    check,
    status: "completed",
    privateLegacyField: "not projected",
  })}\n`, "utf8");
  const markdown = [
    "# Historical evaluation",
    "",
    "## Opening",
    "",
    "The archive door closes behind the investigator.",
    "",
    "## Turn 1",
    "",
    "Historical prose is retained separately.",
  ].join("\n");
  return { root, manifestPath, markdown };
}

describe("legacy evaluation artifacts", () => {
  it("reads a representative v1 manifest without rewriting it", async () => {
    const fixture = await legacyFixture();
    const before = await readFile(fixture.manifestPath, "utf8");
    const manifest = await readLegacyEvaluationManifest(fixture.manifestPath);
    expect(manifest).toMatchObject({
      schemaVersion: 1,
      runId: "legacy-run",
      config: { language: "en", provider: "historical-provider" },
      sessions: [{ id: "session-one", profile: "cautious-investigator" }],
      historicalOnly: true,
    });
    expect(await readFile(fixture.manifestPath, "utf8")).toBe(before);
  });

  it("rejects non-v1 manifests instead of reinterpreting them as current playtests", async () => {
    const fixture = await legacyFixture();
    await writeFile(fixture.manifestPath, `${JSON.stringify({
      schemaVersion: 2,
      runId: "legacy-run",
      config: { language: "en" },
      sessions: [{ id: "session-one", profile: "curious-explorer" }],
    })}\n`, "utf8");
    await expect(readLegacyEvaluationManifest(fixture.manifestPath)).rejects.toThrow();
  });

  it("projects only the opening and validated turn records for browser inspection", async () => {
    const fixture = await legacyFixture();
    const presentation = await evaluationTranscriptPresentation(
      fixture.root,
      "legacy-run",
      "session-one",
      fixture.markdown,
    );
    expect(presentation).toMatchObject({
      profile: "cautious-investigator",
      opening: "The archive door closes behind the investigator.",
      turns: [{
        turn: 1,
        action: "Inspect the sealed desk.",
        approach: "investigation",
        status: "completed",
        narration: "A maker's mark is visible beneath the drawer.",
      }],
    });
    expect(JSON.stringify(presentation)).toContain("Investigation: d100 = 55");
    expect(JSON.stringify(presentation)).not.toContain("privateLegacyField");
    expect(JSON.stringify(presentation)).not.toContain("Historical prose is retained separately");
  });

  it("rejects traversal-like run and session IDs before resolving artifact paths", async () => {
    const fixture = await legacyFixture();
    expect(() => evaluationArtifactPath(fixture.root, "../outside", "manifest")).toThrow("Invalid run ID");
    expect(() => evaluationArtifactPath(fixture.root, "legacy-run", "transcript", "../outside"))
      .toThrow("Invalid session ID");
    await expect(evaluationTranscriptPresentation(
      fixture.root,
      "../outside",
      "session-one",
      fixture.markdown,
    )).rejects.toThrow("Invalid run ID");
    await expect(evaluationTranscriptPresentation(
      fixture.root,
      "legacy-run",
      "../outside",
      fixture.markdown,
    )).rejects.toThrow("Invalid session ID");
  });
});
