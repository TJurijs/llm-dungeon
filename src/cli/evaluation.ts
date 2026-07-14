import { readFile } from "node:fs/promises";
import path from "node:path";
import { clearScreenDown, cursorTo, moveCursor } from "node:readline";
import { stdout as output } from "node:process";
import * as p from "@clack/prompts";
import {
  defaultPlayerConfig,
  EvaluationConfigSchema,
  EvaluationRunIdSchema,
  generateEvaluationReport,
  inferModelCost,
  PlayerProfileIdSchema,
  readEvaluationManifest,
  SelfPlayEvaluator,
  type EvaluationConfig,
  type EvaluationProgressEvent,
} from "../evaluation.js";
import { ProviderConfigSchema, type ProviderConfig } from "../schemas.js";
import type { CliProjectContext } from "./project-context.js";

export interface EvaluateOptions {
  sessions?: number;
  turns?: number;
  concurrency: number;
  maxCost: number;
  playerProfiles?: EvaluationConfig["playerProfiles"];
  playerModel?: string;
}

export function positiveInteger(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${value} must be a positive integer`);
  }
  return parsed;
}

export function positiveNumber(value: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${value} must be a positive number`);
  }
  return parsed;
}

export function profilePool(value: string): EvaluationConfig["playerProfiles"] {
  return PlayerProfileIdSchema.array().min(1).parse(
    value.split(",").map((profile) => profile.trim()).filter(Boolean),
  );
}

function configuredCost(config: ProviderConfig, label: string) {
  const inferred = inferModelCost(config);
  if (!inferred) {
    throw new Error(`No built-in pricing for ${label} model ${config.model}; select a supported model for auto-runs`);
  }
  return inferred;
}

class EvaluationProgressRenderer {
  private readonly sessions = new Map<string, EvaluationProgressEvent>();
  private readonly lastPlainState = new Map<string, string>();
  private renderedLines = 0;

  readonly update = (event: EvaluationProgressEvent): void => {
    this.sessions.set(event.sessionId, event);
    if (!output.isTTY) {
      const state = `${event.phase}:${event.completedTurns}:${event.retries}`;
      if (this.lastPlainState.get(event.sessionId) !== state) {
        this.lastPlainState.set(event.sessionId, state);
        p.log.info(`${event.sessionId}: ${event.message} · ${event.completedTurns}/${event.totalTurns} turns · $${event.estimatedCostUsd.toFixed(4)}`);
      }
      return;
    }
    this.render();
  };

  private render(): void {
    if (this.renderedLines) {
      moveCursor(output, 0, -this.renderedLines);
      cursorTo(output, 0);
      clearScreenDown(output);
    }
    const width = Math.max(50, (output.columns ?? 100) - 1);
    const lines = [...this.sessions.values()].map((event) => {
      const filled = Math.round((event.completedTurns / Math.max(event.totalTurns, 1)) * 10);
      const bar = `${"█".repeat(filled)}${"░".repeat(10 - filled)}`;
      const phase = event.phase.replace("_", " ").padEnd(10);
      const line = `${event.sessionId} [${bar}] ${String(event.completedTurns).padStart(3)}/${event.totalTurns} ${phase} $${event.estimatedCostUsd.toFixed(4)} r:${event.retries}`;
      return line.slice(0, width);
    });
    output.write(`${lines.join("\n")}\n`);
    this.renderedLines = lines.length;
  }
}

export class EvaluationCli {
  constructor(private readonly project: CliProjectContext) {}

  private async config(options: EvaluateOptions): Promise<EvaluationConfig> {
    const dmConfig = await this.project.providerConfig();
    const basePlayerConfig = defaultPlayerConfig(dmConfig);
    const playerConfig = ProviderConfigSchema.parse({
      ...basePlayerConfig,
      ...(options.playerModel ? { model: options.playerModel } : {}),
    });
    return EvaluationConfigSchema.parse({
      language: await this.project.language(),
      sessions: options.sessions ?? 1,
      turns: options.turns ?? 20,
      concurrency: options.concurrency,
      maxCostUsd: options.maxCost,
      ...(options.playerProfiles ? { playerProfiles: options.playerProfiles } : {}),
      dm: {
        config: dmConfig,
        cost: configuredCost(dmConfig, "DM"),
      },
      player: {
        config: playerConfig,
        cost: configuredCost(playerConfig, "player"),
      },
    });
  }

  async run(options: EvaluateOptions): Promise<void> {
    const config = await this.config(options);
    const worldRules = await readFile(this.project.paths.worldConfig, "utf8");
    p.intro("Self-play evaluation");
    p.log.info(`${config.sessions} sessions × up to ${config.turns} turns; ${config.concurrency ?? 3} parallel workers; hard cost ceiling $${config.maxCostUsd.toFixed(2)}`);
    const renderer = new EvaluationProgressRenderer();
    const evaluator = new SelfPlayEvaluator(
      this.project.paths.root,
      this.project.paths.evaluationsRoot,
      config,
      worldRules,
      this.project.createProvider(config.dm.config),
      this.project.createProvider(config.player.config),
      0,
      renderer.update,
    );
    const result = await evaluator.run();
    p.outro(`Evaluation ${result.manifest.status}. Report: ${result.reportPath}`);
  }

  async resume(runId: string): Promise<void> {
    runId = EvaluationRunIdSchema.parse(runId);
    const runDir = path.join(this.project.paths.evaluationsRoot, "runs", runId);
    const manifest = await readEvaluationManifest(path.join(runDir, "manifest.json"));
    const config = EvaluationConfigSchema.parse(manifest.config);
    const worldRules = await readFile(path.join(runDir, "world.md"), "utf8");
    const renderer = new EvaluationProgressRenderer();
    const evaluator = new SelfPlayEvaluator(
      this.project.paths.root,
      this.project.paths.evaluationsRoot,
      config,
      worldRules,
      this.project.createProvider(config.dm.config),
      this.project.createProvider(config.player.config),
      manifest.totalEstimatedCostUsd,
      renderer.update,
    );
    const result = await evaluator.run(runId);
    p.outro(`Evaluation ${result.manifest.status}. Report: ${result.reportPath}`);
  }

  async regenerateReport(runId: string): Promise<void> {
    runId = EvaluationRunIdSchema.parse(runId);
    const report = await generateEvaluationReport(
      path.join(this.project.paths.evaluationsRoot, "runs", runId),
    );
    p.outro(`Report generated: ${report}`);
  }
}
