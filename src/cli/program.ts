import * as p from "@clack/prompts";
import { Command } from "commander";
import { APPLICATION_VERSION } from "../version.js";
import { LANGUAGES, LanguageCodeSchema } from "../language.js";
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
    .command("play")
    .description("Create or resume the current campaign")
    .helpGroup("Game")
    .action(() => game.play());

  program
    .command("new")
    .description("Archive the current campaign and create another")
    .helpGroup("Game")
    .action(() => game.newGame());

  program
    .command("configure")
    .description("Configure the LLM provider and model")
    .helpGroup("Configuration")
    .action(async () => { await project.configureProvider(); });

  program
    .command("language [language]")
    .description(`Show or set the game language (${Object.keys(LANGUAGES).join(", ")})`)
    .helpGroup("Configuration")
    .action(async (value?: string) => {
      if (!value) {
        console.log(await project.language());
        return;
      }
      const language = LanguageCodeSchema.parse(value.toLowerCase());
      await project.setLanguage(language);
      p.log.success(`Language set to ${language}. New narration will use it from the next turn.`);
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
      console.log(terminalStyle.dim("Keys entered in the browser remain in this process only. Press Ctrl+C to stop."));
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
