import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadProjectEnv } from "../src/env.js";

describe("project .env loading", () => {
  it("loads fallback values without replacing shell variables", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "llm-dungeon-env-"));
    await writeFile(
      path.join(root, ".env"),
      "GEMINI_API_KEY=from-file\nOPENROUTER_API_KEY='openrouter-file-key'\n",
      "utf8",
    );
    const environment: NodeJS.ProcessEnv = { GEMINI_API_KEY: "from-shell" };

    expect(loadProjectEnv(root, environment)).toEqual(["OPENROUTER_API_KEY"]);
    expect(environment.GEMINI_API_KEY).toBe("from-shell");
    expect(environment.OPENROUTER_API_KEY).toBe("openrouter-file-key");
  });

  it("allows projects without a .env file", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "llm-dungeon-no-env-"));
    expect(loadProjectEnv(root, {})).toEqual([]);
  });
});
