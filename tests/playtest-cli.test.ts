import { describe, expect, it, vi } from "vitest";
import { createPlaytestCliProgram } from "../tools/playtest/cli/playtest-program.js";
import { EvaluationCli } from "../tools/playtest/cli/evaluation.js";
import {
  DEFAULT_PLAYTEST_PLAYER_SPEC,
  PlaytestCli,
  languageList,
  modelSpec,
  providerConcurrency,
  withProcessCancellation,
  type PlaytestRunOptions,
} from "../tools/playtest/cli/playtest.js";
import type { PlaytestProjectContext } from "../tools/playtest/cli/playtest-project-context.js";
import type { PlaytestModelTarget, PlaytestRunConfig } from "../tools/playtest/playtest.js";
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
      target(config, route ?? "direct"),
    ),
  } as unknown as PlaytestProjectContext;
}

describe("playtest terminal commands", () => {
  it("coalesces duplicate process cancellation signals and removes its listeners", async () => {
    const beforeInterrupts = process.listenerCount("SIGINT");
    const beforeTerminations = process.listenerCount("SIGTERM");
    const cancel = vi.fn();

    const result = await withProcessCancellation({ cancel }, async () => {
      process.emit("SIGINT", "SIGINT");
      process.emit("SIGINT", "SIGINT");
      process.emit("SIGTERM", "SIGTERM");
      return "cancelled-cleanly";
    });

    expect(result).toBe("cancelled-cleanly");
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(process.listenerCount("SIGINT")).toBe(beforeInterrupts);
    expect(process.listenerCount("SIGTERM")).toBe(beforeTerminations);
  });

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
    const build = (
      cli as unknown as {
        buildRunConfig(
          id: string,
          options: PlaytestRunOptions,
          matrix: boolean,
        ): Promise<PlaytestRunConfig>;
      }
    ).buildRunConfig.bind(cli);

    const config = await build(
      "certification-v1",
      {
        candidate: "openai:gpt-5.6-terra@direct",
        judge: "gemini:gemini-3.5-flash@direct",
        languages: ["en", "ru"],
        repetitions: 2,
        concurrency: 1,
        maxCost: 4,
      },
      false,
    );

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
    const build = (
      cli as unknown as {
        buildRunConfig(
          id: string,
          options: PlaytestRunOptions,
          matrix: boolean,
        ): Promise<PlaytestRunConfig>;
      }
    ).buildRunConfig.bind(cli);

    const config = await build(
      "certification-v1",
      {
        candidate: "gemini:gemini-3.5-flash@direct",
        languages: ["en"],
        maxCost: 2,
      },
      false,
    );

    expect(config.judge).toMatchObject({
      policy: "final",
      target: { config: { provider: "gemini", model: "gemini-3.5-flash" }, route: "direct" },
    });
    expect(project.resolvePlaytestTarget).toHaveBeenCalledTimes(2);
  });

  it("uses Gemini 3.6 Flash direct as the default model-driven player", async () => {
    const project = fakeProject();
    const cli = new PlaytestCli(project);
    const build = (
      cli as unknown as {
        buildRunConfig(
          id: string,
          options: PlaytestRunOptions,
          matrix: boolean,
        ): Promise<PlaytestRunConfig>;
      }
    ).buildRunConfig.bind(cli);

    const config = await build(
      "campaign-autoplay-v1",
      {
        candidate: "openai:gpt-5.6-terra@direct",
        languages: ["en"],
        maxCost: 2,
      },
      false,
    );

    expect(DEFAULT_PLAYTEST_PLAYER_SPEC).toBe("gemini:gemini-3.6-flash@direct");
    expect(config.player).toMatchObject({
      profile: "curious-explorer",
      target: {
        config: { provider: "gemini", model: "gemini-3.6-flash" },
        route: "direct",
        executionProfileFingerprint: fingerprint,
      },
    });
    expect(project.resolvePlaytestTarget).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "gemini", model: "gemini-3.6-flash" }),
      "direct",
      undefined,
    );
    expect(config.judge).toEqual({ policy: "none", rubricVersion: 1 });
  });

  it("builds autoplay with a fixed player and rejects judge options", async () => {
    const cli = new PlaytestCli(fakeProject());
    const build = (
      cli as unknown as {
        buildRunConfig(
          id: string,
          options: PlaytestRunOptions,
          matrix: boolean,
        ): Promise<PlaytestRunConfig>;
      }
    ).buildRunConfig.bind(cli);
    const config = await build(
      "campaign-autoplay-v1",
      {
        player: "gemini:gemini-3.1-flash-lite@direct",
        playerProfile: "long-term-planner",
        turns: 50,
        concurrency: 3,
        providerConcurrency: { gemini: 2, openai: 1 },
      },
      false,
    );

    expect(config.player).toMatchObject({
      profile: "long-term-planner",
      target: { config: { provider: "gemini", model: "gemini-3.1-flash-lite" } },
    });
    expect(config.judge).toEqual({ policy: "none", rubricVersion: 1 });
    expect(config.latencyMode).toBe("loaded");
    expect(config.providerConcurrency).toEqual({ gemini: 2, openai: 1 });
    await expect(
      build("campaign-autoplay-v1", { judge: "openai:gpt-5.6-terra@direct", maxCost: 2 }, false),
    ).rejects.toThrow(/does not define a judge rubric/i);
  });

  it("routes the deprecated autoplay alias through the canonical player default", async () => {
    const cli = new PlaytestCli(fakeProject());
    const run = vi.spyOn(cli, "run").mockResolvedValue();

    await cli.legacyEvaluate({ concurrency: 1, maxCost: 2 });

    expect(run).toHaveBeenCalledWith(
      "campaign-autoplay-v1",
      expect.objectContaining({
        player: DEFAULT_PLAYTEST_PLAYER_SPEC,
        playerProfile: "curious-explorer",
      }),
    );
  });

  it("registers the unified command tree and routes deprecated evaluate through its wrapper", async () => {
    const project = fakeProject();
    const packages = vi
      .spyOn(PlaytestCli.prototype, "packages")
      .mockImplementation(() => undefined);
    const probe = vi.spyOn(PlaytestCli.prototype, "probe").mockResolvedValue();
    const calibrate = vi.spyOn(PlaytestCli.prototype, "calibrate").mockResolvedValue();
    const legacy = vi.spyOn(EvaluationCli.prototype, "run").mockResolvedValue();
    try {
      const program = createPlaytestCliProgram(project);
      const group = program.commands.find((command) => command.name() === "playtest");
      expect(group?.commands.map((command) => command.name())).toEqual([
        "packages",
        "calibrate",
        "probe",
        "promote",
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
        "calibrate",
        "--target",
        "openrouter:moonshotai/kimi-k3@openrouter",
        "--scenario-seed",
        "far-meridian-dead-signal",
        "--language",
        "ru",
        "--truncation-evidence",
        "playtests/runs/run-a/diagnostics/setup.json",
        "--truncation-evidence",
        "playtests/runs/run-b/diagnostics/decision.json",
        "--max-cost",
        "2",
      ]);
      expect(calibrate).toHaveBeenCalledWith(
        expect.objectContaining({
          scenarioSeed: "far-meridian-dead-signal",
          language: "ru",
          truncationEvidence: [
            "playtests/runs/run-a/diagnostics/setup.json",
            "playtests/runs/run-b/diagnostics/decision.json",
          ],
          maxCost: 2,
        }),
      );

      await program.parseAsync([
        "node",
        "llm-dungeon-playtest",
        "playtest",
        "probe",
        "--target",
        "gemini:gemini-3.5-flash",
        "--languages",
        "en,ru",
        "--input-cost",
        "3",
        "--output-cost",
        "15",
        "--max-cost",
        "0.25",
      ]);
      expect(probe).toHaveBeenCalledWith(
        expect.objectContaining({
          target: "gemini:gemini-3.5-flash",
          languages: ["en", "ru"],
          inputCost: 3,
          outputCost: 15,
          maxCost: 0.25,
        }),
      );

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
      expect(legacy).toHaveBeenCalledWith(
        expect.objectContaining({
          sessions: 2,
          turns: 25,
          playerProfiles: ["curious-explorer"],
        }),
      );
    } finally {
      packages.mockRestore();
      calibrate.mockRestore();
      probe.mockRestore();
      legacy.mockRestore();
    }
  });

  it("documents the default player model in model-driven command help", () => {
    const program = createPlaytestCliProgram(fakeProject());
    const group = program.commands.find((command) => command.name() === "playtest");
    const run = group?.commands.find((command) => command.name() === "run");
    const calibrate = group?.commands.find((command) => command.name() === "calibrate");

    expect(run?.helpInformation()).toContain("defaults to Gemini 3.6 Flash direct");
    expect(calibrate?.helpInformation()).toContain("--truncation-evidence <diagnostic-bundle>");
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
