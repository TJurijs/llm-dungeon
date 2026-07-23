import { Command } from "commander";
import { LANGUAGES, LanguageCodeSchema } from "../../../src/language.js";
import { inspectPrompt, PROMPT_PHASES, type PromptPhase } from "../prompt-inspection.js";
import { terminalBanner, terminalHeading } from "../../../src/terminal-style.js";
import {
  EvaluationCli,
  positiveInteger,
  positiveNumber,
  profilePool,
  type EvaluateOptions,
} from "./evaluation.js";
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
import type { PlaytestProjectContext } from "./playtest-project-context.js";

function latencyMode(value: string): "canonical" | "loaded" {
  if (value !== "canonical" && value !== "loaded") throw new Error("Latency mode must be canonical or loaded");
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
    .option("--provider-concurrency <provider=limit>", "provider-specific call limit; repeat by provider", providerConcurrency, {})
    .option("--model-price <target=input,output>", "custom USD per million input/output tokens", modelPrice, {})
    .requiredOption("--max-cost <usd>", "hard aggregate cost ceiling", positiveNumber)
    .option("--max-duration-minutes <minutes>", "active execution time ceiling", positiveNumber)
    .option("--seed <seed>", "deterministic roll seed for seeded packages")
    .option("--scenario-seed <id>", "shipped scenario-seed id to start a generated package from (defaults/scenario-seeds/<id>)")
    .option("--player <target>", "fixed player-driver provider:model[@route]")
    .option("--player-profile <profile>", "fixed simulated-player profile")
    .option("--judge <target>", "separate judge provider:model[@route]; defaults to Gemini 3.5 Flash")
    .option("--checkpoint-every <turns>", "judge each interval plus the final campaign", positiveInteger)
    .option("--tuning-variable <kind:description>", "one controlled model:, adapter:, or prompt: variable for tuning-v1");
}

export function createPlaytestCliProgram(project: PlaytestProjectContext): Command {
  const playtest = new PlaytestCli(project);
  const evaluation = new EvaluationCli(project);
  const program = new Command()
    .name("llm-dungeon-playtest")
    .description("Developer-only model calibration, certification, and playtesting");
  const prompts = program.command("prompts").description("Inspect static prompt-suite previews");
  prompts.command("list").action(() => console.log(PROMPT_PHASES.join("\n")));
  prompts
    .command("show <phase>")
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
  const playtests = program.command("playtest").description("Run the unified playtest engine");

  playtests.command("packages").description("List versioned built-in playtest packages").action(() => playtest.packages());
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
    .command("promote <target>")
    .description("Sync a calibrated/certified model's local evidence into defaults/ for git (does not add it as a public candidate)")
    .option("--note <text>", "human provenance stored with the shipped compatibility test")
    .action((target: string, options: { note?: string }) => playtest.promote(target, options));
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

  addPlaytestRunOptions(playtests.command("run <package>").description("Run one playtest package for a candidate"))
    .action((packageId: string, options: PlaytestRunOptions) => playtest.run(packageId, options));
  addPlaytestRunOptions(playtests.command("certify").description("Run authoritative bilingual certification-v1"))
    .action((options: PlaytestRunOptions) => playtest.certify(options));
  addPlaytestRunOptions(playtests.command("matrix <package>").description("Run a package across frozen candidates"), true)
    .action((packageId: string, options: PlaytestRunOptions) => playtest.matrix(packageId, options));
  playtests.command("resume <runId>").action((runId: string) => playtest.resume(runId));
  playtests.command("judge <runId>").action((runId: string) => playtest.judge(runId));
  playtests.command("report <runId>").action((runId: string) => playtest.report(runId));
  playtests.command("compare <leftRunId> <rightRunId>")
    .action((leftRunId: string, rightRunId: string) => playtest.compare(leftRunId, rightRunId));

  program
    .command("evaluate")
    .description("Deprecated alias for playtest run campaign-autoplay-v1")
    .option("--sessions <number>", "session count", positiveInteger, 1)
    .option("--turns <number>", "turns per session", positiveInteger, 25)
    .option("--concurrency <number>", "maximum parallel evaluation sessions", positiveInteger, 3)
    .requiredOption("--max-cost <usd>", "hard estimated cost ceiling", positiveNumber)
    .option("--player-profiles <profiles>", "one fixed player profile", profilePool)
    .option("--judge <target>", "separate judge provider:model[@route]")
    .option("--player-provider <provider>", "override simulated-player provider")
    .option("--player-model <model>", "override simulated-player model")
    .action((options: EvaluateOptions) => evaluation.run(options));
  program.command("evaluate:resume <runId>").action((runId: string) => evaluation.resume(runId));
  program.command("evaluate:report <runId>").action((runId: string) => evaluation.regenerateReport(runId));
  return program;
}
