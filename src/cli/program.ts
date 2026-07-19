import * as p from "@clack/prompts";
import { Command } from "commander";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { APPLICATION_VERSION } from "../version.js";
import { LANGUAGES, LanguageCodeSchema } from "../language.js";
import { inspectPrompt, PROMPT_PHASES, type PromptPhase } from "../prompt-inspection.js";
import { terminalBanner, terminalHeading, terminalStyle } from "../terminal-style.js";
import {
  EvaluationCli,
  positiveInteger,
  positiveNumber,
  profilePool,
  type EvaluateOptions,
} from "./evaluation.js";
import { HumanGameCli } from "./game.js";
import {
  PlaytestCli,
  collectValue,
  languageList,
  modelPrice,
  providerConcurrency,
  type CalibrationOptions,
  type CompatibilityProbeOptions,
  type PlaytestRunOptions,
  type ReplayOptions,
} from "./playtest.js";
import type { CliProjectContext } from "./project-context.js";

function latencyMode(value: string): "canonical" | "loaded" {
  if (value !== "canonical" && value !== "loaded") {
    throw new Error("Latency mode must be canonical or loaded");
  }
  return value;
}

function addPlaytestRunOptions(command: Command, matrix = false): Command {
  if (matrix) {
    command.option(
      "--candidate <target>",
      "candidate provider:model[@route]; repeat for each matrix entry",
      collectValue,
      [],
    );
  } else {
    command.option("--candidate <target>", "candidate provider:model[@route]; defaults to configured model");
  }
  return command
    .option("--languages <codes>", "comma-separated gameplay languages", languageList)
    .option("--turns <number>", "turns per campaign", positiveInteger)
    .option("--repetitions <number>", "repetitions per candidate and language", positiveInteger, 1)
    .option("--concurrency <number>", "global worker limit", positiveInteger, 1)
    .option("--latency-mode <mode>", "canonical (one worker) or loaded", latencyMode)
    .option(
      "--provider-concurrency <provider=limit>",
      "provider-specific call limit; repeat by provider",
      providerConcurrency,
      {},
    )
    .option(
      "--model-price <target=input,output>",
      "custom USD per million input/output tokens; repeat by provider:model[@route]",
      modelPrice,
      {},
    )
    .requiredOption("--max-cost <usd>", "hard aggregate cost ceiling", positiveNumber)
    .option("--max-duration-minutes <minutes>", "active execution time ceiling", positiveNumber)
    .option("--seed <seed>", "deterministic roll seed for seeded packages")
    .option("--player <target>", "fixed player-driver provider:model[@route]")
    .option("--player-profile <profile>", "fixed simulated-player profile")
    .option("--judge <target>", "separate judge provider:model[@route]; defaults to Gemini 3.5 Flash")
    .option("--checkpoint-every <turns>", "judge each interval plus the final campaign", positiveInteger)
    .option("--tuning-variable <kind:description>", "one controlled model:, adapter:, or prompt: variable for tuning-v1");
}

export function createCliProgram(project: CliProjectContext): Command {
  const game = new HumanGameCli(project);
  const evaluation = new EvaluationCli(project);
  const playtest = new PlaytestCli(project);
  const program = new Command()
    .name("llm-dungeon")
    .description("A persistent, non-agentic LLM dungeon master")
    .version(APPLICATION_VERSION);

  program
    .command("play [campaign]")
    .description("Create, choose, or open an unarchived campaign")
    .helpGroup("Game")
    .action((campaign?: string) => game.play(campaign));

  program
    .command("new")
    .description("Create and play an additional campaign")
    .helpGroup("Game")
    .action(() => game.newGame());

  program
    .command("campaigns")
    .description("List campaigns and their resumable or archived state")
    .helpGroup("Game")
    .action(async () => {
      const campaigns = await project.campaigns();
      if (campaigns.length === 0) {
        console.log("No campaigns yet.");
        return;
      }
      console.log(campaigns.map((campaign) => [
        campaign.campaignId,
        campaign.archived ? "archived" : campaign.status,
        `turn ${campaign.turn}`,
        campaign.title,
      ].join("\t")).join("\n"));
    });

  program
    .command("configure")
    .description("Configure the default provider and model for new campaigns")
    .helpGroup("Configuration")
    .action(async () => { await project.configureProvider(); });

  program
    .command("language [language]")
    .description(`Show or set the default language for new campaigns (${Object.keys(LANGUAGES).join(", ")})`)
    .helpGroup("Configuration")
    .action(async (value?: string) => {
      if (!value) {
        console.log(await project.language());
        return;
      }
      const language = LanguageCodeSchema.parse(value.toLowerCase());
      await project.setLanguage(language);
      p.log.success(`Default language set to ${language}. New campaigns will use it.`);
    });

  const world = program
    .command("world")
    .description("Inspect or edit future-campaign world and DM-style guidance")
    .helpGroup("Configuration");

  world
    .command("show")
    .description("Print the selected language's world and style profile")
    .action(async () => {
      const profile = await project.worldProfile();
      console.log(`${terminalHeading("World and DM style", profile.source)}\n\n${profile.markdown}`);
    });

  world
    .command("set <file>")
    .description("Replace the selected language's world and style profile from a Markdown file")
    .action(async (file: string) => {
      const source = path.resolve(project.paths.root, file);
      const markdown = await readFile(source, "utf8");
      if (!markdown.trim()) throw new Error("World and style guidance cannot be empty");
      const target = await project.saveWorldProfile(markdown);
      p.log.success(`Saved ${path.relative(project.paths.root, target)}. It will apply to future campaigns.`);
    });

  const prompts = program
    .command("prompts")
    .description("Inspect the current prompt suite without exposing live campaign secrets")
    .helpGroup("Configuration");

  prompts
    .command("list")
    .description("List inspectable prompt phases")
    .action(() => console.log(PROMPT_PHASES.join("\n")));

  prompts
    .command("show <phase>")
    .description("Render a static prompt preview with safe placeholders")
    .option("--language <code>", `preview language (${Object.keys(LANGUAGES).join(", ")})`)
    .action(async (phaseValue: string, options: { language?: string }) => {
      if (!PROMPT_PHASES.includes(phaseValue as PromptPhase)) {
        throw new Error(`Unknown prompt phase. Use one of: ${PROMPT_PHASES.join(", ")}`);
      }
      const language = options.language
        ? LanguageCodeSchema.parse(options.language.toLowerCase())
        : await project.language();
      const preview = inspectPrompt(phaseValue as PromptPhase, language);
      console.log(terminalBanner(`Prompt suite V${preview.version}`));
      console.log(`${terminalHeading("Phase", preview.phase)}\nSections: ${preview.sections.join(", ") || "none"}`);
      if (preview.system) console.log(`\n${terminalHeading("System prompt")}\n\n${preview.system}`);
      if (preview.prompt) console.log(`\n${terminalHeading("Task prompt")}\n\n${preview.prompt}`);
    });

  const playtests = program
    .command("playtest")
    .description("Calibrate adapters and run resumable certification, autoplay, stress, or tuning packages")
    .helpGroup("Playtest");

  playtests
    .command("packages")
    .description("List versioned built-in playtest packages")
    .action(() => playtest.packages());

  playtests
    .command("calibrate")
    .description("Probe one provider route and freeze a compatible execution profile")
    .option("--target <target>", "provider:model[@route]; defaults to configured model")
    .option("--variant <file>", "JSON profile draft or array; repeat in one-variable order", collectValue, [])
    .option("--evidence-id <id>", "stable safe ID for retained calibration evidence")
    .option("--input-cost <usd>", "custom input USD per million tokens", positiveNumber)
    .option("--output-cost <usd>", "custom output USD per million tokens", positiveNumber)
    .requiredOption("--max-cost <usd>", "hard calibration cost ceiling", positiveNumber)
    .action((options: CalibrationOptions & { variant?: string[] }) => playtest.calibrate({
      target: options.target,
      variants: options.variant,
      evidenceId: options.evidenceId,
      maxCost: options.maxCost,
      inputCost: options.inputCost,
      outputCost: options.outputCost,
    }));

  playtests
    .command("probe")
    .description("Refresh strict setup/gameplay compatibility for a calibrated model")
    .option("--target <target>", "provider:model[@route]; defaults to configured model")
    .option("--languages <codes>", "comma-separated gameplay languages", languageList)
    .requiredOption("--max-cost <usd>", "hard compatibility-probe cost ceiling", positiveNumber)
    .action((options: CompatibilityProbeOptions) => playtest.probe(options));

  playtests
    .command("replay <bundle>")
    .description("Run bounded non-committing adapter variants against one diagnostic bundle")
    .option("--variant <file>", "JSON profile draft or array; repeat", collectValue, [])
    .option("--replay-id <id>", "safe stable ID used to resume replay evidence")
    .option("--input-cost <usd>", "custom input USD per million tokens", positiveNumber)
    .option("--output-cost <usd>", "custom output USD per million tokens", positiveNumber)
    .requiredOption("--max-cost <usd>", "hard focused-replay cost ceiling", positiveNumber)
    .action((bundle: string, options: ReplayOptions & { variant?: string[] }) => playtest.replay(bundle, {
      variants: options.variant,
      replayId: options.replayId,
      maxCost: options.maxCost,
      inputCost: options.inputCost,
      outputCost: options.outputCost,
    }));

  addPlaytestRunOptions(
    playtests
      .command("run <package>")
      .description("Run one versioned playtest package for a candidate"),
  ).action((packageId: string, options: PlaytestRunOptions) => playtest.run(packageId, options));

  addPlaytestRunOptions(
    playtests
      .command("certify")
      .description("Run authoritative certification-v1 (English and Russian by default)"),
  ).action((options: PlaytestRunOptions) => playtest.certify(options));

  addPlaytestRunOptions(
    playtests
      .command("matrix <package>")
      .description("Run the same package across two or more frozen candidate profiles"),
    true,
  ).action((packageId: string, options: PlaytestRunOptions) => playtest.matrix(packageId, options));

  playtests
    .command("resume <runId>")
    .description("Resume incomplete jobs from persisted playtest artifacts")
    .action((runId: string) => playtest.resume(runId));

  playtests
    .command("judge <runId>")
    .description("Rerun separate judging from persisted evidence without replaying gameplay")
    .action((runId: string) => playtest.judge(runId));

  playtests
    .command("report <runId>")
    .description("Regenerate a playtest report from separate telemetry lanes")
    .action((runId: string) => playtest.report(runId));

  playtests
    .command("compare <leftRunId> <rightRunId>")
    .description("Compare runs of the same package and version")
    .action((leftRunId: string, rightRunId: string) => playtest.compare(leftRunId, rightRunId));

  program
    .command("evaluate")
    .description("Deprecated alias for playtest run campaign-autoplay-v1")
    .helpGroup("Evaluation")
    .option("--sessions <number>", "session count", positiveInteger, 1)
    .option("--turns <number>", "turns per session", positiveInteger, 25)
    .option("--concurrency <number>", "maximum parallel evaluation sessions", positiveInteger, 3)
    .requiredOption("--max-cost <usd>", "hard estimated cost ceiling", positiveNumber)
    .option("--player-profiles <profiles>", "one fixed player profile (deprecated spelling)", profilePool)
    .option("--judge <target>", "separate judge provider:model[@route]; defaults to Gemini 3.5 Flash")
    .option("--player-provider <provider>", "override the simulated-player provider")
    .option("--player-model <model>", "override the inexpensive simulated-player model")
    .action((options: EvaluateOptions) => evaluation.run(options));

  program
    .command("evaluate:resume <runId>")
    .description("Deprecated alias for playtest resume")
    .helpGroup("Evaluation")
    .action((runId: string) => evaluation.resume(runId));

  program
    .command("evaluate:report <runId>")
    .description("Deprecated alias for playtest report")
    .helpGroup("Evaluation")
    .action((runId: string) => evaluation.regenerateReport(runId));

  program
    .command("web")
    .description("Start the local browser application")
    .helpGroup("Interfaces")
    .option("--host <host>", "host interface", "127.0.0.1")
    .option("--port <port>", "HTTP port", positiveInteger, 4317)
    .action(async (options: { host: string; port: number }) => {
      const { startDungeonWebServer } = await import("../web-server.js");
      await startDungeonWebServer({
        root: project.paths.root,
        host: options.host,
        port: options.port,
      });
      console.log(terminalBanner("llm-dungeon Web"));
      console.log(`${terminalHeading("Web app ready")} http://${options.host}:${options.port}`);
      console.log(terminalStyle.dim("Provider keys are read from .env at startup. Press Ctrl+C to stop."));
    });

  program
    .command("api")
    .description("Reserved for a future machine-facing API")
    .helpGroup("Future")
    .action(() => {
      console.log(terminalBanner("Machine-facing integration"));
      console.log(terminalHeading("API mode is reserved for future development"));
      console.log(`\n${terminalStyle.dim("No API contract is exposed yet. Use llm-dungeon web for the browser app or llm-dungeon play for terminal play.")}\n`);
    });

  program.action(() => game.play());
  return program;
}
