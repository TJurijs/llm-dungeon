import { readFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import * as p from "@clack/prompts";
import type { DungeonEngine } from "../engine.js";
import type { LanguageCode } from "../language.js";
import { formatCheck } from "../mechanics.js";
import { DEFAULT_CAMPAIGN_PREMISE, DEFAULT_CHARACTER_CONCEPT } from "../prompts.js";
import type { SetupResult } from "../schemas.js";
import { terminalBanner, terminalHeading, terminalPrompt, terminalRule, terminalStyle } from "../terminal-style.js";
import type { StateView, TurnResult } from "../types.js";
import type { CliProjectContext } from "./project-context.js";
import { takePrompt } from "./prompt.js";

interface SetupSeeds {
  premise: string;
  character: string;
}

interface AcceptedSetupDraft {
  setup: SetupResult;
  worldRules: string;
  language: LanguageCode;
}

const INSPECTION_COMMANDS = new Map<string, StateView>([
  [":character", "character"],
  [":inventory", "inventory"],
  [":location", "location"],
  [":threads", "threads"],
  [":journal", "journal"],
]);

const HELP = `Commands:

Inspect
  :character  Show player-visible character state
  :inventory  Show carried items
  :location   Show the current location and notable occupants
  :threads    Show active and completed story threads
  :journal    Show the eight most recent turns

Recovery
  :retry      Retry an uncommitted action (reusing a locked roll)
  :discard    Discard an uncommitted action without changing the world

Campaign
  :new        Archive this campaign and create a new one
  :help       Show this help
  :quit       Leave the game`;

export class HumanGameCli {
  constructor(private readonly project: CliProjectContext) {}

  async play(): Promise<void> {
    await this.playLoop(await this.project.createEngine());
  }

  async newGame(): Promise<void> {
    const engine = await this.project.createEngine();
    const replaceCurrent = await engine.hasCurrentGame();
    if (replaceCurrent) {
      const confirmed = takePrompt(
        await p.confirm({
          message: "Archive the current campaign and start a new one?",
          initialValue: false,
        }),
      );
      if (!confirmed) return;
    }
    await this.setupNewGame(engine, replaceCurrent);
    await this.playLoop(engine);
  }

  private async readMaybeFile(value: string | undefined): Promise<string> {
    const trimmed = (value ?? "").trim();
    if (!trimmed.startsWith("@")) return trimmed;
    return readFile(path.resolve(this.project.paths.root, trimmed.slice(1)), "utf8");
  }

  private async gatherSetupSeeds(): Promise<SetupSeeds> {
    const premiseRaw = takePrompt(
      await p.text({
        message: "Premise / scenario (optional; text or @Markdown path)",
        placeholder: `Default: ${DEFAULT_CAMPAIGN_PREMISE}`,
      }),
    );
    const characterRaw = takePrompt(
      await p.text({
        message: "Character concept (optional; text or @Markdown path)",
        placeholder: `Default: ${DEFAULT_CHARACTER_CONCEPT}`,
      }),
    );
    return {
      premise: await this.readMaybeFile(premiseRaw),
      character: await this.readMaybeFile(characterRaw),
    };
  }

  private previewSetup(setup: SetupResult): void {
    console.log(`\n${terminalHeading(setup.campaignTitle, "campaign preview")}\n`);
    console.log(setup.scenarioMarkdown.trim());
    console.log(`\n${terminalRule()}\n${terminalHeading(setup.player.name, "your character")}\n`);
    console.log(setup.player.description.trim());
    if (setup.player.traits.length) {
      console.log(`\n${terminalStyle.bold("Traits:")} ${setup.player.traits.join(", ")}`);
    }
    console.log(`\n${terminalRule()}\n${terminalHeading("Opening scene")}\n\n${setup.openingNarration.trim()}\n`);
  }

  private async acceptedSetupDraft(engine: DungeonEngine): Promise<AcceptedSetupDraft> {
    const worldRules = await readFile(this.project.paths.worldConfig, "utf8");
    const language = await this.project.language();
    let seeds = await this.gatherSetupSeeds();
    for (;;) {
      const spin = p.spinner();
      spin.start("Creating the campaign...");
      let setup: SetupResult;
      try {
        setup = await engine.generateSetup({ worldRules, language, ...seeds });
        spin.stop("Campaign draft ready.");
      } catch (error) {
        spin.stop("Campaign generation failed.");
        throw error;
      }
      this.previewSetup(setup);
      const choice = takePrompt(
        await p.select({
          message: "Use this campaign?",
          options: [
            { value: "accept", label: "Accept and begin" },
            { value: "regenerate", label: "Regenerate" },
            { value: "edit", label: "Edit the seeds" },
          ],
        }),
      );
      if (choice === "accept") return { setup, worldRules, language };
      if (choice === "edit") seeds = await this.gatherSetupSeeds();
    }
  }

  private async setupNewGame(engine: DungeonEngine, replaceCurrent: boolean): Promise<void> {
    const draft = await this.acceptedSetupDraft(engine);
    // The active campaign remains authoritative throughout generation and
    // preview. Archival starts only after the player accepts a valid draft.
    if (replaceCurrent && await engine.hasCurrentGame()) await engine.replaceGame(draft);
    else await engine.createGame(draft);
    console.log(`\n${draft.setup.openingNarration.trim()}\n`);
  }

  private printTurn(result: TurnResult): void {
    console.log();
    if (result.check) {
      console.log(`${terminalHeading("D100 check", result.check.spec.name)}\n${terminalStyle.blue(formatCheck(result.check, result.state.language))}\n`);
    }
    console.log(terminalHeading(`Turn ${result.turn}`, "Dungeon Master"));
    console.log();
    console.log(result.narration.trim());
    if (result.state.status !== "active") {
      console.log(`\n${terminalStyle.red(`Campaign ${result.state.status}.`)} ${terminalStyle.dim("You may inspect the save or start :new.")}`);
    }
    console.log(`\n${terminalRule()}\n`);
  }

  private async handleRecovery(engine: DungeonEngine): Promise<boolean> {
    const pending = await engine.getPendingTurn();
    if (!pending) return true;
    if (pending.kind === "commit") {
      await engine.recoverPendingCommit();
      p.log.success("Recovered an interrupted committed turn.");
      return true;
    }
    const choice = takePrompt(
      await p.select({
        message: `An uncommitted action was found: “${pending.action}”`,
        options: [
          { value: "retry", label: "Retry it", ...(pending.phase === "rolled" ? { hint: "reuses the locked roll" } : {}) },
          { value: "discard", label: "Discard it", hint: "no committed state will be changed" },
          { value: "quit", label: "Quit" },
        ],
      }),
    );
    if (choice === "quit") return false;
    if (choice === "discard") {
      await engine.discardPendingTurn();
      return true;
    }
    const spin = p.spinner();
    spin.start("Retrying the pending turn...");
    try {
      const result = await engine.resumePendingTurn();
      spin.stop("Turn committed.");
      this.printTurn(result);
      return true;
    } catch (error) {
      spin.stop("Turn is still pending.");
      throw error;
    }
  }

  private async playLoop(engine: DungeonEngine): Promise<void> {
    console.log(terminalBanner());
    if (!(await this.handleRecovery(engine))) return;
    if (!(await engine.hasCurrentGame())) await this.setupNewGame(engine, false);
    const readline = createInterface({ input, output });
    console.log(`${terminalStyle.dim("Type :help for commands. Ctrl+C or :quit leaves the game.")}\n`);
    try {
      for (;;) {
        const action = (await readline.question(terminalPrompt())).trim();
        if (!action) continue;
        if (action === ":quit") break;
        if (action === ":help") {
          console.log(`\n${HELP}\n`);
          continue;
        }
        const inspection = INSPECTION_COMMANDS.get(action);
        if (inspection) {
          const heading = inspection[0]!.toUpperCase() + inspection.slice(1);
          console.log(`\n${terminalHeading(heading)}\n\n${await engine.inspect(inspection)}\n`);
          continue;
        }
        if (action === ":retry") {
          const spin = p.spinner();
          spin.start("Retrying...");
          try {
            const result = await engine.resumePendingTurn();
            spin.stop("Turn committed.");
            this.printTurn(result);
          } catch (error) {
            spin.stop("Retry failed; the turn remains pending.");
            p.log.error(error instanceof Error ? error.message : String(error));
          }
          continue;
        }
        if (action === ":discard") {
          const pending = await engine.getPendingTurn();
          if (pending?.kind !== "action") {
            p.log.info("There is no uncommitted action to discard.");
          } else {
            await engine.discardPendingTurn();
            p.log.success("Pending action discarded; world state was not changed.");
          }
          continue;
        }
        if (action === ":new") {
          const confirmed = takePrompt(
            await p.confirm({
              message: "Archive this campaign and start a new one?",
              initialValue: false,
            }),
          );
          if (confirmed) await this.setupNewGame(engine, true);
          continue;
        }
        if (action.startsWith(":")) {
          console.log("Unknown command. Type :help.\n");
          continue;
        }
        const spin = p.spinner();
        spin.start("The dungeon master considers the world...");
        try {
          const result = await engine.play(action);
          spin.stop("Turn committed.");
          this.printTurn(result);
        } catch (error) {
          spin.stop("The turn was not committed.");
          p.log.error(error instanceof Error ? error.message : String(error));
          if ((await engine.getPendingTurn())?.kind === "action") {
            console.log("Use :retry to retry the pending action.\n");
          }
        }
      }
    } finally {
      readline.close();
    }
  }
}
