import * as p from "@clack/prompts";
import { Command } from "commander";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { APPLICATION_VERSION } from "../version.js";
import { LANGUAGES, LanguageCodeSchema } from "../language.js";
import { terminalBanner, terminalHeading, terminalStyle } from "../terminal-style.js";
import { HumanGameCli } from "./game.js";
import type { CliProjectContext } from "./project-context.js";

function positiveInteger(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error("Expected a positive integer");
  return parsed;
}

export function createCliProgram(project: CliProjectContext): Command {
  const game = new HumanGameCli(project);
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
