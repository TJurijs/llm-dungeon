import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadProjectEnv, reloadProjectEnv } from "../src/env.js";

describe("project .env loading", () => {
  it("loads fallback values without replacing shell variables", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "llm-dungeon-env-"));
    await writeFile(
      path.join(root, ".env"),
      [
        "GEMINI_API_KEY=from-file",
        "OPENROUTER_API_KEY='openrouter-file-key'",
        "OPENAI_API_KEY=openai-file-key",
        "ANTHROPIC_API_KEY=anthropic-file-key",
        "DEEPSEEK_API_KEY=deepseek-file-key",
        "",
      ].join("\n"),
      "utf8",
    );
    const environment: NodeJS.ProcessEnv = { GEMINI_API_KEY: "from-shell" };

    expect(loadProjectEnv(root, environment).sort()).toEqual([
      "ANTHROPIC_API_KEY",
      "DEEPSEEK_API_KEY",
      "OPENAI_API_KEY",
      "OPENROUTER_API_KEY",
    ]);
    expect(environment.GEMINI_API_KEY).toBe("from-shell");
    expect(environment.OPENROUTER_API_KEY).toBe("openrouter-file-key");
    expect(environment.OPENAI_API_KEY).toBe("openai-file-key");
    expect(environment.ANTHROPIC_API_KEY).toBe("anthropic-file-key");
    expect(environment.DEEPSEEK_API_KEY).toBe("deepseek-file-key");
  });

  it("allows projects without a .env file", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "llm-dungeon-no-env-"));
    expect(loadProjectEnv(root, {})).toEqual([]);
  });

  it("replaces only values previously loaded from .env", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "llm-dungeon-env-reload-"));
    const environment: NodeJS.ProcessEnv = { GEMINI_API_KEY: "from-shell" };
    await writeFile(path.join(root, ".env"), "OPENAI_API_KEY=old-value\nDEEPSEEK_API_KEY=remove-me\n", "utf8");
    const previous = loadProjectEnv(root, environment);

    await writeFile(path.join(root, ".env"), "OPENAI_API_KEY=new-value\nOPENROUTER_API_KEY=added\n", "utf8");
    expect(reloadProjectEnv(root, environment, previous).sort()).toEqual(["OPENAI_API_KEY", "OPENROUTER_API_KEY"]);
    expect(environment).toMatchObject({
      GEMINI_API_KEY: "from-shell",
      OPENAI_API_KEY: "new-value",
      OPENROUTER_API_KEY: "added",
    });
    expect(environment.DEEPSEEK_API_KEY).toBeUndefined();
  });
});
