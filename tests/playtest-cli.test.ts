import { describe, expect, it, vi } from "vitest";
import { createPlaytestCliProgram } from "../src/cli/playtest-program.js";
import {
  EvaluationCli,
} from "../src/cli/evaluation.js";
import {
  PlaytestCli,
  languageList,
  modelSpec,
  providerConcurrency,
  type PlaytestRunOptions,
} from "../src/cli/playtest.js";
import type { PlaytestProjectContext } from "../src/cli/playtest-project-context.js";
import type { PlaytestModelTarget, PlaytestRunConfig } from "../src/playtest.js";
import type { ProviderConfig } from "../src/schemas.js";

const fingerprint = "a".repeat(64);

function target(config: ProviderConfig, route: string): PlaytestModelTarget {
  return { config, route, executionProfileFingerprint: fingerprint };
}

function fakeProject(): PlaytestProjectContext {
  const configured: ProviderConfig = {
    provider: "gemini",
    model: "gemini-3.5-flash",
    temperature: 0.8,
    maxOutputTokens: 4_000,
  };
  return {
    paths: {
      root: "C:\\fixture",
      providerConfig: "C:\\fixture\\config\\provider.json",
      dataRoot: "C:\\fixture\\data",
      evaluationsRoot: "C:\\fixture\\evaluations",
      playtestsRoot: "C:\\fixture\\playtests",
    },
    providerConfig: vi.fn(async () => configured),
    language: vi.fn(async () => "en"),
    resolvePlaytestTarget: vi.fn(async (config: ProviderConfig, route?: string) =>
      target(config, route ?? "direct")),
  } as unknown as PlaytestProjectContext;
}

describe("playtest terminal commands", () => {
  it("parses model, language, and provider-limit options deterministically", () => {
    expect(modelSpec("openrouter:qwen/qwen3.7-plus@openrouter")).toEqual({
      config: {
        provider: "openrouter",
        model: "qwen/qwen3.7-plus",
        temperature: 0.8,
        maxOutputTokens: 4_000,
      },
      route: "openrouter",
    });
    expect(modelSpec("openai:gpt-5.6-terra").route).toBe("direct");
    expect(languageList("ru,en,ru")).toEqual(["ru", "en"]);
    expect(providerConcurrency("gemini=2", { openai: 1 })).toEqual({ openai: 1, gemini: 2 });
    expect(() => modelSpec("missing-provider-separator")).toThrow(/provider:model/);
    expect(() => providerConcurrency("gemini=0")).toThrow(/positive-integer/);
  });

  it("constructs certification config from frozen targets without making calls", async () => {
    const project = fakeProject();
    const cli = new PlaytestCli(project);
    const build = (cli as unknown as {
      buildRunConfig(id: string, options: PlaytestRunOptions, matrix: boolean): Promise<PlaytestRunConfig>;
    }).buildRunConfig.bind(cli);

    const config = await build("certification-v1", {
      candidate: "openai:gpt-5.6-terra@direct",
      judge: "gemini:gemini-3.5-flash@direct",
      languages: ["en", "ru"],
      repetitions: 2,
      concurrency: 1,
      maxCost: 4,
    }, false);

    expect(config).toMatchObject({
      package: { id: "certification-v1", version: 3 },
      languages: ["en", "ru"],
      repetitions: 2,
      globalWorkerLimit: 1,
      latencyMode: "canonical",
      maxCostUsd: 4,
      judge: { policy: "final", rubricVersion: 1 },
    });
    expect(config.candidates[0]).toMatchObject({
      config: { provider: "openai", model: "gpt-5.6-terra" },
      route: "direct",
      executionProfileFingerprint: fingerprint,
    });
    expect(config.player).toBeUndefined();
    expect(project.resolvePlaytestTarget).toHaveBeenCalledTimes(2);
  });

  it("uses Gemini 3.5 Flash as the default separate judge, including for itself", async () => {
    const project = fakeProject();
    const cli = new PlaytestCli(project);
    const build = (cli as unknown as {
      buildRunConfig(id: string, options: PlaytestRunOptions, matrix: boolean): Promise<PlaytestRunConfig>;
    }).buildRunConfig.bind(cli);

    const config = await build("certification-v1", {
      candidate: "gemini:gemini-3.5-flash@direct",
      languages: ["en"],
      maxCost: 2,
    }, false);

    expect(config.judge).toMatchObject({
      policy: "final",
      target: { config: { provider: "gemini", model: "gemini-3.5-flash" }, route: "direct" },
    });
    expect(project.resolvePlaytestTarget).toHaveBeenCalledTimes(2);
  });

  it("builds autoplay with fixed player and separate optional judge lanes", async () => {
    const cli = new PlaytestCli(fakeProject());
    const build = (cli as unknown as {
      buildRunConfig(id: string, options: PlaytestRunOptions, matrix: boolean): Promise<PlaytestRunConfig>;
    }).buildRunConfig.bind(cli);
    const config = await build("campaign-autoplay-v1", {
      player: "gemini:gemini-3.1-flash-lite@direct",
      playerProfile: "long-term-planner",
      judge: "openai:gpt-5.6-terra@direct",
      checkpointEvery: 12,
      turns: 50,
      concurrency: 3,
      providerConcurrency: { gemini: 2, openai: 1 },
    }, false);

    expect(config.player).toMatchObject({ profile: "long-term-planner" });
    expect(config.judge).toMatchObject({
      policy: "checkpoints_and_final",
      rubricVersion: 1,
      checkpointEvery: 12,
    });
    expect(config.latencyMode).toBe("loaded");
    expect(config.providerConcurrency).toEqual({ gemini: 2, openai: 1 });
  });

  it("registers the unified command tree and routes deprecated evaluate through its wrapper", async () => {
    const project = fakeProject();
    const packages = vi.spyOn(PlaytestCli.prototype, "packages").mockImplementation(() => undefined);
    const probe = vi.spyOn(PlaytestCli.prototype, "probe").mockResolvedValue();
    const legacy = vi.spyOn(EvaluationCli.prototype, "run").mockResolvedValue();
    try {
      const program = createPlaytestCliProgram(project);
      const group = program.commands.find((command) => command.name() === "playtest");
      expect(group?.commands.map((command) => command.name())).toEqual([
        "packages",
        "calibrate",
        "probe",
        "replay",
        "run",
        "certify",
        "matrix",
        "resume",
        "judge",
        "report",
        "compare",
      ]);
      await program.parseAsync(["node", "llm-dungeon-playtest", "playtest", "packages"]);
      expect(packages).toHaveBeenCalledOnce();

      await program.parseAsync([
        "node",
        "llm-dungeon-playtest",
        "playtest",
        "probe",
        "--target",
        "gemini:gemini-3.5-flash",
        "--languages",
        "en,ru",
        "--max-cost",
        "0.25",
      ]);
      expect(probe).toHaveBeenCalledWith(expect.objectContaining({
        target: "gemini:gemini-3.5-flash",
        languages: ["en", "ru"],
        maxCost: 0.25,
      }));

      await program.parseAsync([
        "node",
        "llm-dungeon-playtest",
        "evaluate",
        "--sessions",
        "2",
        "--turns",
        "25",
        "--max-cost",
        "5",
        "--judge",
        "openai:gpt-5.6-terra",
        "--player-profiles",
        "curious-explorer",
      ]);
      expect(legacy).toHaveBeenCalledWith(expect.objectContaining({
        sessions: 2,
        turns: 25,
        playerProfiles: ["curious-explorer"],
      }));
    } finally {
      packages.mockRestore();
      probe.mockRestore();
      legacy.mockRestore();
    }
  });

  it("passes repeatable singular --candidate flags to matrix execution", async () => {
    const matrix = vi.spyOn(PlaytestCli.prototype, "matrix").mockResolvedValue();
    try {
      const program = createPlaytestCliProgram(fakeProject());
      await program.parseAsync([
        "node",
        "llm-dungeon-playtest",
        "playtest",
        "matrix",
        "certification-v1",
        "--candidate",
        "gemini:gemini-3.5-flash",
        "--candidate",
        "openai:gpt-5.6-terra",
        "--max-cost",
        "5",
        "--judge",
        "openrouter:qwen/qwen3.7-plus",
      ]);
      expect(matrix).toHaveBeenCalledWith(
        "certification-v1",
        expect.objectContaining({
          candidate: ["gemini:gemini-3.5-flash", "openai:gpt-5.6-terra"],
        }),
      );
    } finally {
      matrix.mockRestore();
    }
  });
});
