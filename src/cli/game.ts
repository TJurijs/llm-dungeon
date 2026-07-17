import { readFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import * as p from "@clack/prompts";
import { parseAppealCommand } from "../appeal.js";
import type { CampaignCatalogSummary } from "../campaign-catalog.js";
import { parseQuestionCommand } from "../question.js";
import type { LanguageCode } from "../language.js";
import { formatCheck } from "../mechanics.js";
import { campaignSetupDefaults } from "../language.js";
import type { SetupResult } from "../schemas.js";
import { terminalBanner, terminalHeading, terminalPrompt, terminalRule, terminalStyle } from "../terminal-style.js";
import type { GameEngine, GenerationMetadata, StateView, TurnResult } from "../types.js";
import type { CliCampaignSession, CliProjectContext } from "./project-context.js";
import { takePrompt } from "./prompt.js";
import { inspectionTitle, renderInspection } from "./inspection.js";

interface SetupSeeds {
  premise: string;
  character: string;
}

interface AcceptedSetupDraft {
  setup: SetupResult;
  openingGeneration: GenerationMetadata;
  worldRules: string;
  language: LanguageCode;
}

const INSPECTION_COMMANDS = new Map<string, StateView>([
  [":character", "character"],
  [":location", "location"],
  [":threads", "threads"],
]);

const HELP = `Commands:

Inspect
  :character  Show player-visible character state
  :location   Show player-visible current-location state
  :threads    Show active and completed story threads

Appeal
  :appeal <explanation>             Ask the DM to review a state inconsistency
  :appeal --turn N <explanation>    Review a specific committed turn

Ask
  :ask <question>                   Ask the DM without advancing the campaign

Recovery
  :retry      Retry an uncommitted action (reusing a locked roll)
  :discard    Discard an uncommitted action without changing the world

Campaign
  :switch     Switch to another unarchived campaign
  :new        Create and switch to another campaign
  :help       Show this help
  :quit       Leave the game`;

export class HumanGameCli {
  constructor(
    private readonly project: CliProjectContext,
    private readonly chooseCampaign: (campaigns: CampaignCatalogSummary[]) => Promise<string> = async (campaigns) => takePrompt(
      await p.select({
        message: "Choose a campaign",
        options: campaigns.map((campaign) => ({
          value: campaign.campaignId,
          label: campaign.title,
          hint: `turn ${campaign.turn} · ${campaign.status}`,
        })),
      }),
    ),
  ) {}

  async play(campaignId?: string): Promise<void> {
    const selected = await this.selectCampaign(campaignId);
    await this.playLoop(selected ?? await this.setupNewGame());
  }

  async newGame(): Promise<void> {
    await this.playLoop(await this.setupNewGame());
  }

  private async selectCampaign(
    campaignId?: string,
    excludedCampaignId?: string,
  ): Promise<CliCampaignSession | undefined> {
    const campaigns = (await this.project.campaigns())
      .filter((campaign) => !campaign.archived && campaign.campaignId !== excludedCampaignId);
    if (campaignId) {
      if (!campaigns.some((campaign) => campaign.campaignId === campaignId)) {
        throw new Error(`Unarchived campaign ${campaignId} was not found`);
      }
      return { campaignId, engine: await this.project.createEngine(campaignId) };
    }
    if (campaigns.length === 0) return undefined;
    const selectedId = campaigns.length === 1
      ? campaigns[0]!.campaignId
      : await this.chooseCampaign(campaigns);
    if (!campaigns.some((campaign) => campaign.campaignId === selectedId)) {
      throw new Error(`Campaign choice ${selectedId} is not available`);
    }
    return { campaignId: selectedId, engine: await this.project.createEngine(selectedId) };
  }

  private async readMaybeFile(value: string | undefined): Promise<string> {
    const trimmed = (value ?? "").trim();
    if (!trimmed.startsWith("@")) return trimmed;
    return readFile(path.resolve(this.project.paths.root, trimmed.slice(1)), "utf8");
  }

  private async gatherSetupSeeds(language: LanguageCode): Promise<SetupSeeds> {
    const defaults = campaignSetupDefaults(language);
    const premiseRaw = takePrompt(
      await p.text({
        message: "Premise / scenario (optional; text or @Markdown path)",
        placeholder: `Default: ${defaults.premise}`,
      }),
    );
    const characterRaw = takePrompt(
      await p.text({
        message: "Character concept (optional; text or @Markdown path)",
        placeholder: `Default: ${defaults.characterConcept}`,
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

  private async acceptedSetupDraft(engine: GameEngine): Promise<AcceptedSetupDraft> {
    const language = await this.project.language();
    const worldRules = (await this.project.worldProfile(language)).markdown;
    let seeds = await this.gatherSetupSeeds(language);
    for (;;) {
      const spin = p.spinner();
      spin.start("Creating the campaign...");
      let setup: SetupResult;
      let openingGeneration: GenerationMetadata;
      try {
        const generated = await engine.generateSetupWithMetadata({ worldRules, language, ...seeds });
        setup = generated.setup;
        openingGeneration = generated.generation;
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
      if (choice === "accept") return { setup, openingGeneration, worldRules, language };
      if (choice === "edit") seeds = await this.gatherSetupSeeds(language);
    }
  }

  private async setupNewGame(): Promise<CliCampaignSession> {
    const setupSession = await this.project.createSetupSession();
    const draft = await this.acceptedSetupDraft(setupSession.engine);
    const session = await this.project.createCampaignSession(draft, setupSession.config);
    console.log(`\n${draft.setup.openingNarration.trim()}\n`);
    return session;
  }

  private printTurn(result: TurnResult): void {
    console.log();
    if (result.kind === "appeal") {
      const target = result.appealTargetTurn === undefined ? "general" : `turn ${result.appealTargetTurn}`;
      console.log(terminalHeading(`Appeal ${result.turn}`, target));
      console.log();
      console.log(result.narration.trim());
      console.log(`\n${terminalRule()}\n`);
      return;
    }
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

  private async handleRecovery(engine: GameEngine): Promise<boolean> {
    const pending = await engine.getPendingTurn();
    if (!pending) return true;
    if (pending.kind === "commit") {
      await engine.recoverPendingCommit();
      p.log.success("Recovered an interrupted committed turn.");
      return true;
    }
    const pendingDescription = pending.kind === "appeal"
      ? `appeal${pending.targetTurn === undefined ? "" : ` for turn ${pending.targetTurn}`}`
      : `action: “${pending.action}”`;
    const choice = takePrompt(
      await p.select({
        message: `An uncommitted ${pendingDescription} was found.`,
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

  private async playLoop(initialSession: CliCampaignSession): Promise<void> {
    let session = initialSession;
    let engine = session.engine;
    console.log(terminalBanner());
    if (!(await this.handleRecovery(engine))) return;
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
          const state = await engine.inspect(inspection);
          console.log(`\n${terminalHeading(inspectionTitle(state))}\n\n${renderInspection(state)}\n`);
          continue;
        }
        if (action === ":retry") {
          const spin = p.spinner();
          spin.start("Retrying...");
          try {
            engine = await this.project.createEngine(session.campaignId);
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
          if (!pending || pending.kind === "commit") {
            p.log.info("There is no uncommitted action or appeal to discard.");
          } else {
            await engine.discardPendingTurn();
            p.log.success("Pending action discarded; world state was not changed.");
          }
          continue;
        }
        if (action === ":new") {
          session = await this.setupNewGame();
          engine = session.engine;
          continue;
        }
        if (action === ":switch") {
          const selected = await this.selectCampaign(undefined, session.campaignId);
          if (!selected) {
            p.log.info("No other unarchived campaign is available.");
            continue;
          }
          if (!(await this.handleRecovery(selected.engine))) continue;
          session = selected;
          engine = selected.engine;
          p.log.success(`Switched to ${selected.campaignId}.`);
          continue;
        }
        let question: ReturnType<typeof parseQuestionCommand>;
        try {
          question = parseQuestionCommand(action);
        } catch (error) {
          p.log.error(error instanceof Error ? error.message : String(error));
          continue;
        }
        if (question) {
          const spin = p.spinner();
          spin.start("The dungeon master considers your question...");
          try {
            engine = await this.project.createEngine(session.campaignId);
            const result = await engine.ask(question);
            spin.stop("Question answered; no turn advanced.");
            console.log(`\n${terminalHeading("Dungeon Master", "answer — no turn")}\n\n${result.answer.trim()}\n\n${terminalRule()}\n`);
          } catch (error) {
            spin.stop("The question was not answered.");
            p.log.error(error instanceof Error ? error.message : String(error));
          }
          continue;
        }
        let appeal: ReturnType<typeof parseAppealCommand>;
        try {
          appeal = parseAppealCommand(action);
        } catch (error) {
          p.log.error(error instanceof Error ? error.message : String(error));
          continue;
        }
        if (appeal) {
          const spin = p.spinner();
          spin.start("The dungeon master reviews the committed record...");
          try {
            engine = await this.project.createEngine(session.campaignId);
            const result = await engine.appeal(appeal);
            spin.stop("Appeal committed.");
            this.printTurn(result);
          } catch (error) {
            spin.stop("The appeal was not committed.");
            p.log.error(error instanceof Error ? error.message : String(error));
            if ((await engine.getPendingTurn())?.kind === "appeal") {
              console.log("Use :retry to retry the pending appeal.\n");
            }
          }
          continue;
        }
        if (action.startsWith(":")) {
          console.log("Unknown command. Type :help.\n");
          continue;
        }
        const spin = p.spinner();
        spin.start("The dungeon master considers the world...");
        try {
          engine = await this.project.createEngine(session.campaignId);
          const result = await engine.play(action);
          spin.stop("Turn committed.");
          this.printTurn(result);
        } catch (error) {
          spin.stop("The turn was not committed.");
          p.log.error(error instanceof Error ? error.message : String(error));
          const pending = await engine.getPendingTurn();
          if (pending?.kind === "action" || pending?.kind === "appeal") {
            console.log("Use :retry to retry the pending request.\n");
          }
        }
      }
    } finally {
      readline.close();
    }
  }
}
