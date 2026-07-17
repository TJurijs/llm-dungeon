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
import type { CliProjectContext } from "./project-context.js";

export function createCliProgram(project: CliProjectContext): Command {
  const game = new HumanGameCli(project);
  const evaluation = new EvaluationCli(project);
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

  program
    .command("evaluate")
    .description("Run bounded AI self-play sessions in isolated saves")
    .helpGroup("Evaluation")
    .option("--sessions <number>", "session count", positiveInteger, 1)
    .option("--turns <number>", "turns per session", positiveInteger, 20)
    .option("--concurrency <number>", "maximum parallel evaluation sessions", positiveInteger, 3)
    .option("--max-cost <usd>", "hard estimated cost ceiling", positiveNumber, 5)
    .option("--player-profiles <profiles>", "comma-separated profile pool, rotated in this order", profilePool)
    .option("--player-model <model>", "override the inexpensive simulated-player model")
    .action((options: EvaluateOptions) => evaluation.run(options));

  program
    .command("evaluate:resume <runId>")
    .description("Resume an interrupted evaluation run")
    .helpGroup("Evaluation")
    .action((runId: string) => evaluation.resume(runId));

  program
    .command("evaluate:report <runId>")
    .description("Regenerate an evaluation report")
    .helpGroup("Evaluation")
    .action((runId: string) => evaluation.regenerateReport(runId));

  program
    .command("web-cli")
    .description("Start the browser-based terminal companion")
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
      console.log(terminalBanner("Browser terminal companion"));
      console.log(`${terminalHeading("Web CLI ready")} http://${options.host}:${options.port}`);
      console.log(terminalStyle.dim("Provider keys are read from .env at startup. Press Ctrl+C to stop."));
    });

  program
    .command("api")
    .description("Reserved for a future machine-facing API")
    .helpGroup("Future")
    .action(() => {
      console.log(terminalBanner("Machine-facing integration"));
      console.log(terminalHeading("API mode is reserved for future development"));
      console.log(`\n${terminalStyle.dim("No API contract is exposed yet. Use llm-dungeon for terminal play or llm-dungeon web-cli for the browser companion.")}\n`);
    });

  program.action(() => game.play());
  return program;
}
