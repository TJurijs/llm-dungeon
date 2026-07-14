import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import type { Dirent } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { DungeonEngine } from "./engine.js";
import { loadProjectEnv } from "./env.js";
import {
  defaultPlayerConfig,
  EvaluationConfigSchema,
  generateEvaluationReport,
  inferModelCost,
  PlayerProfileIdSchema,
  readEvaluationManifest,
  SelfPlayEvaluator,
  type EvaluationConfig,
  type EvaluationManifest,
  type EvaluationProgressEvent,
} from "./evaluation.js";
import { CheckResultSchema, formatCheck } from "./mechanics.js";
import { LANGUAGES, LanguageCodeSchema, loadAppConfig, saveAppConfig, type LanguageCode } from "./language.js";
import { createProvider, loadProviderConfig } from "./providers.js";
import { ProviderConfigSchema, SetupResultSchema, TurnDecisionSchema, type ProviderConfig, type SetupResult } from "./schemas.js";
import {
  GAMEPLAY_PROTOCOL_VERSION,
  GAMEPLAY_SCHEMA_NAMES,
  decodeTurnDecision,
  gameplayRequest,
} from "./llm/gameplay-protocol.js";
import { StateStore } from "./store.js";
import { atomicWriteJson, atomicWriteText } from "./persistence/files.js";
import { combineUsage } from "./llm/structured-generation.js";
import type { PendingTurn } from "./persistence/pending.js";
import type { LlmProvider, StateView, TurnResult } from "./types.js";

type ProviderFactory = (config: ProviderConfig, environment: NodeJS.ProcessEnv) => LlmProvider;

export interface WebServerOptions {
  root: string;
  environment?: NodeJS.ProcessEnv;
  providerFactory?: ProviderFactory;
}

interface BackgroundTask {
  id: string;
  kind: "evaluation" | "resume";
  runId: string;
  status: "running" | "completed" | "completed_with_failures" | "cost_limit" | "failed";
  startedAt: string;
  completedAt?: string;
  logs: string[];
  sessionProgress: Record<string, EvaluationProgressEvent>;
  error?: string;
  reportPath?: string;
}

interface EvaluationRunInspectionFailure {
  runId: string;
  status: "inspection_failed";
  totalEstimatedCostUsd: 0;
  sessions: [];
  inspectionError: string;
}

const SetupDraftRequestSchema = z.object({
  premise: z.string().max(100_000).default(""),
  character: z.string().max(100_000).default(""),
}).strict();

const EvaluationRequestSchema = z.object({
  sessions: z.number().int().min(1).max(100).optional(),
  turns: z.number().int().min(1).max(200).optional(),
  concurrency: z.number().int().min(1).max(10).default(3),
  maxCostUsd: z.number().positive().max(10_000).default(5),
  playerProfiles: z.array(PlayerProfileIdSchema)
    .min(1)
    .max(PlayerProfileIdSchema.options.length)
    .refine((profiles) => new Set(profiles).size === profiles.length, "Player profile pool cannot contain duplicates")
    .default(["curious-explorer"]),
  playerModel: z.string().trim().min(1).optional(),
});

const EvaluationTranscriptTurnSchema = z.object({
  turn: z.number().int().positive(),
  action: z.string(),
  approach: z.string(),
  narration: z.string().optional(),
  check: CheckResultSchema.optional(),
  status: z.enum(["completed", "failed"]),
  error: z.string().optional(),
});

const SAFE_ARTIFACT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const STATE_VIEWS: StateView[] = ["character", "inventory", "location", "threads", "journal"];

function asError(error: unknown): string {
  if (error instanceof z.ZodError) return error.issues.map((issue) => `${issue.path.join(".") || "request"}: ${issue.message}`).join("; ");
  return error instanceof Error ? error.message : String(error);
}

function assertSafeId(value: string, label: string): string {
  if (!SAFE_ARTIFACT_ID.test(value)) throw new Error(`Invalid ${label}`);
  return value;
}

function transcriptOpening(markdown: string): string {
  const heading = "## Opening";
  const start = markdown.indexOf(heading);
  if (start < 0) return "";
  const contentStart = start + heading.length;
  const nextTurn = markdown.indexOf("\n## Turn ", contentStart);
  return markdown.slice(contentStart, nextTurn < 0 ? undefined : nextTurn).trim();
}

function parseEvaluationTurns(jsonLines: string): Array<z.infer<typeof EvaluationTranscriptTurnSchema>> {
  return jsonLines
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line, index) => {
      try {
        return EvaluationTranscriptTurnSchema.parse(JSON.parse(line));
      } catch (error) {
        throw new Error(`Invalid evaluation turn record ${index + 1}: ${asError(error)}`);
      }
    });
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 1_000_000) throw new Error("Request body exceeds 1 MB");
    chunks.push(buffer);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Error("Request body must be valid JSON");
  }
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(JSON.stringify(value));
}

function rejectUnsafeMutation(request: IncomingMessage, response: ServerResponse): boolean {
  const method = request.method ?? "GET";
  if (method !== "POST" && method !== "PUT") return false;
  const contentType = request.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") {
    sendJson(response, 415, { error: "Mutating requests require Content-Type: application/json" });
    return true;
  }
  const fetchSite = request.headers["sec-fetch-site"];
  if (fetchSite === "cross-site") {
    sendJson(response, 403, { error: "Cross-site requests are not allowed" });
    return true;
  }
  const origin = request.headers.origin;
  const host = request.headers.host;
  if (origin && (!host || origin !== `http://${host}`)) {
    sendJson(response, 403, { error: "Foreign request origins are not allowed" });
    return true;
  }
  return false;
}

function pendingStatus(pending: PendingTurn | undefined): unknown {
  if (!pending) return null;
  if (pending.kind === "commit") return { kind: "commit" };
  return {
    kind: "action",
    phase: pending.phase,
    lockedRoll: pending.phase === "rolled",
  };
}

function setupPreview(setup: SetupResult): unknown {
  return {
    campaignTitle: setup.campaignTitle,
    scenarioMarkdown: setup.scenarioMarkdown,
    openingNarration: setup.openingNarration,
    player: {
      name: setup.player.name,
      description: setup.player.description,
      traits: setup.player.traits,
    },
  };
}

function playerTurnResponse(result: TurnResult): unknown {
  return {
    turn: result.turn,
    narration: result.narration,
    summary: result.summary,
    state: result.state,
    checkText: result.check ? formatCheck(result.check, result.state.language) : null,
  };
}

function configuredCost(
  config: ProviderConfig,
  label: string,
): { inputPerMillion: number; outputPerMillion: number } {
  const inferred = inferModelCost(config);
  if (!inferred) throw new Error(`No built-in pricing for ${label} model ${config.model}; select a supported model for auto-runs`);
  return inferred;
}

export class DungeonWebController {
  readonly providerConfigPath: string;
  readonly worldConfigPath: string;
  readonly dataRoot: string;
  readonly evaluationsRoot: string;
  readonly webRoot: string;
  private readonly environment: NodeJS.ProcessEnv;
  private readonly runtimeKeys: NodeJS.ProcessEnv = {};
  private readonly providerFactory: ProviderFactory;
  private readonly drafts = new Map<string, {
    setup: SetupResult;
    language: LanguageCode;
    worldRules: string;
  }>();
  private task: BackgroundTask | undefined;
  private gameBusy = false;

  constructor(readonly root: string, options: Omit<WebServerOptions, "root"> = {}) {
    this.providerConfigPath = path.join(root, "config", "provider.json");
    this.worldConfigPath = path.join(root, "config", "world.md");
    this.dataRoot = path.join(root, "data");
    this.evaluationsRoot = path.join(root, "evaluations");
    this.webRoot = path.join(root, "web");
    if (!options.environment) loadProjectEnv(root);
    this.environment = options.environment ?? process.env;
    this.providerFactory = options.providerFactory ?? ((config, environment) => createProvider(config, environment));
  }

  private effectiveEnvironment(): NodeJS.ProcessEnv {
    return { ...this.environment, ...this.runtimeKeys };
  }

  private async config(): Promise<ProviderConfig> {
    return loadProviderConfig(this.providerConfigPath);
  }

  private provider(config: ProviderConfig): LlmProvider {
    return this.providerFactory(config, this.effectiveEnvironment());
  }

  private async engine(): Promise<DungeonEngine> {
    const config = await this.config();
    return new DungeonEngine(new StateStore(this.dataRoot), this.provider(config));
  }

  private async currentStore(): Promise<StateStore> {
    const store = new StateStore(this.dataRoot);
    if (!(await store.hasCurrentGame())) {
      throw new Error("No current campaign. Create one in the New campaign panel first.");
    }
    return store;
  }

  private async withGameLock<T>(operation: () => Promise<T>): Promise<T> {
    if (this.gameBusy) throw new Error("Another campaign operation is still running");
    this.gameBusy = true;
    try {
      return await operation();
    } finally {
      this.gameBusy = false;
    }
  }

  private keyStatus(): Record<string, boolean> {
    const environment = this.effectiveEnvironment();
    return {
      openrouter: Boolean(environment.OPENROUTER_API_KEY),
      gemini: Boolean(environment.GEMINI_API_KEY),
    };
  }

  private async buildEvaluationConfig(raw: unknown): Promise<EvaluationConfig> {
    const request = EvaluationRequestSchema.parse(raw);
    const dmConfig = await this.config();
    const basePlayer = defaultPlayerConfig(dmConfig);
    const playerConfig = ProviderConfigSchema.parse({
      ...basePlayer,
      ...(request.playerModel ? { model: request.playerModel } : {}),
    });
    return EvaluationConfigSchema.parse({
      language: (await loadAppConfig(this.root)).language,
      sessions: request.sessions ?? 1,
      turns: request.turns ?? 20,
      concurrency: request.concurrency,
      maxCostUsd: request.maxCostUsd,
      playerProfiles: request.playerProfiles,
      dm: { config: dmConfig, cost: configuredCost(dmConfig, "DM") },
      player: {
        config: playerConfig,
        cost: configuredCost(playerConfig, "player"),
      },
    });
  }

  private launchTask(task: BackgroundTask, work: (progress: (event: EvaluationProgressEvent) => void) => Promise<string>): void {
    if (this.task?.status === "running") throw new Error("An evaluation task is already running");
    this.task = task;
    const appendLog = (message: string): void => {
      task.logs.push(`[${new Date().toLocaleTimeString()}] ${message}`);
      if (task.logs.length > 500) task.logs.shift();
    };
    const progress = (event: EvaluationProgressEvent): void => {
      const previous = task.sessionProgress[event.sessionId];
      task.sessionProgress[event.sessionId] = event;
      if (!previous || previous.phase !== event.phase || event.retries !== previous.retries) {
        appendLog(`${event.sessionId}: ${event.message}`);
      }
    };
    void work(progress).then((reportPath) => {
      task.reportPath = reportPath;
      task.completedAt = new Date().toISOString();
      return readEvaluationManifest(path.join(this.evaluationsRoot, "runs", task.runId, "manifest.json"));
    }).then((manifest) => {
      const outcome = manifest.status;
      task.status = outcome === "running" ? "completed" : outcome;
      appendLog(`Evaluation finished: ${task.status}. Report: ${path.relative(this.root, task.reportPath!)}`);
    }).catch((error: unknown) => {
      task.status = "failed";
      task.error = asError(error);
      task.completedAt = new Date().toISOString();
      appendLog(`Failed: ${task.error}`);
    });
  }

  private async listEvaluationRuns(): Promise<Array<EvaluationManifest | EvaluationRunInspectionFailure>> {
    const runsRoot = path.join(this.evaluationsRoot, "runs");
    let names: Dirent[];
    try {
      names = await readdir(runsRoot, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const manifests = await Promise.all(names.filter((entry) => entry.isDirectory()).map(async (entry) => {
      try {
        return await readEvaluationManifest(path.join(runsRoot, entry.name, "manifest.json"));
      } catch (error) {
        return {
          runId: entry.name,
          status: "inspection_failed" as const,
          totalEstimatedCostUsd: 0 as const,
          sessions: [] as [],
          inspectionError: asError(error),
        };
      }
    }));
    return manifests.sort((a, b) => {
      const left = "startedAt" in a ? a.startedAt : a.runId;
      const right = "startedAt" in b ? b.startedAt : b.runId;
      return right.localeCompare(left);
    });
  }

  private artifactPath(runId: string, kind: string, sessionId?: string): string {
    const safeRun = assertSafeId(runId, "run ID");
    const runDir = path.join(this.evaluationsRoot, "runs", safeRun);
    if (kind === "report") return path.join(runDir, "report.md");
    if (kind === "manifest") return path.join(runDir, "manifest.json");
    if (kind !== "transcript" && kind !== "evaluation") throw new Error("Invalid artifact kind");
    if (!sessionId) throw new Error("A session ID is required");
    return path.join(runDir, "sessions", assertSafeId(sessionId, "session ID"), `${kind}.md`);
  }

  private async evaluationTranscriptPresentation(runId: string, sessionId: string, markdown: string): Promise<unknown> {
    const runDir = path.join(this.evaluationsRoot, "runs", runId);
    const manifest = await readEvaluationManifest(path.join(runDir, "manifest.json"));
    const session = manifest.sessions.find((candidate) => candidate.id === sessionId);
    if (!session) throw new Error(`Evaluation session ${sessionId} is not present in run ${runId}`);
    let jsonLines = "";
    try {
      jsonLines = await readFile(path.join(runDir, "sessions", sessionId, "turns.jsonl"), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const turns = parseEvaluationTurns(jsonLines).map((turn) => ({
      turn: turn.turn,
      action: turn.action,
      approach: turn.approach,
      status: turn.status,
      ...(turn.narration ? { narration: turn.narration } : {}),
      ...(turn.check ? { checkText: formatCheck(turn.check, manifest.config.language) } : {}),
      ...(turn.error ? { error: turn.error } : {}),
    }));
    return {
      profile: session.profile,
      opening: transcriptOpening(markdown),
      turns,
    };
  }

  async api(request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> {
    const method = request.method ?? "GET";

    if (method === "GET" && url.pathname === "/api/status") {
      let config: ProviderConfig | undefined;
      try { config = await this.config(); } catch { /* First-run state. */ }
      const store = new StateStore(this.dataRoot);
      const hasGame = await store.hasCurrentGame();
      let campaign: unknown;
      let pending: unknown;
      if (hasGame) {
        campaign = this.gameBusy
          ? await store.readManifest()
          : (await this.withGameLock(() => store.load())).manifest;
        pending = pendingStatus(await store.getPending());
      }
      sendJson(response, 200, {
        language: (await loadAppConfig(this.root)).language,
        languages: Object.entries(LANGUAGES).map(([code, value]) => ({ code, name: value.nativeName })),
        config: config ?? null,
        keyStatus: this.keyStatus(),
        game: { exists: hasGame, busy: this.gameBusy, campaign: campaign ?? null, pending: pending ?? null },
        evaluationTask: this.task ?? null,
      });
      return;
    }

    if (url.pathname === "/api/config/language" && method === "PUT") {
      const body = z.object({
        language: LanguageCodeSchema,
        applyToCurrent: z.boolean().default(true),
      }).parse(await readJsonBody(request));
      const update = async (): Promise<unknown> => {
        await saveAppConfig(this.root, { language: body.language });
        const store = new StateStore(this.dataRoot);
        return body.applyToCurrent && await store.hasCurrentGame()
          ? store.setLanguage(body.language)
          : null;
      };
      const campaign = body.applyToCurrent ? await this.withGameLock(update) : await update();
      sendJson(response, 200, { language: body.language, campaign });
      return;
    }

    if (url.pathname === "/api/config/provider" && method === "GET") {
      const config = await this.config().catch(() => null);
      sendJson(response, 200, { config, keyStatus: this.keyStatus() });
      return;
    }

    if (url.pathname === "/api/config/provider" && method === "PUT") {
      const body = z.object({
        provider: z.enum(["openrouter", "gemini"]),
        model: z.string().trim().min(1),
        temperature: z.number().min(0).max(2).default(0.8),
        maxOutputTokens: z.number().int().min(256).max(32_000).default(4000),
        endpoint: z.string().url().or(z.literal("")).optional(),
        apiKey: z.string().trim().optional(),
      }).parse(await readJsonBody(request));
      const config = ProviderConfigSchema.parse({
        provider: body.provider,
        model: body.model,
        temperature: body.temperature,
        maxOutputTokens: body.maxOutputTokens,
        ...(body.endpoint ? { endpoint: body.endpoint } : {}),
      });
      if (body.apiKey) {
        const name = body.provider === "openrouter" ? "OPENROUTER_API_KEY" : "GEMINI_API_KEY";
        this.runtimeKeys[name] = body.apiKey;
      }
      await atomicWriteJson(this.providerConfigPath, config);
      sendJson(response, 200, { config, keyStatus: this.keyStatus(), keyStorage: "memory_only" });
      return;
    }

    if (url.pathname === "/api/config/provider/test" && method === "POST") {
      const saved = await this.config().catch(() => undefined);
      const body = z.object({
        provider: z.enum(["openrouter", "gemini"]).optional(),
        model: z.string().trim().min(1).optional(),
        temperature: z.number().min(0).max(2).optional(),
        maxOutputTokens: z.number().int().min(256).max(32_000).optional(),
        endpoint: z.string().url().or(z.literal("")).optional(),
        apiKey: z.string().trim().optional(),
      }).parse(await readJsonBody(request));
      const candidate: Record<string, unknown> = {
        ...(saved ?? {}),
        ...(body.provider === undefined ? {} : { provider: body.provider }),
        ...(body.model === undefined ? {} : { model: body.model }),
        ...(body.temperature === undefined ? {} : { temperature: body.temperature }),
        ...(body.maxOutputTokens === undefined ? {} : { maxOutputTokens: body.maxOutputTokens }),
      };
      if (body.endpoint === "") delete candidate.endpoint;
      else if (body.endpoint !== undefined) candidate.endpoint = body.endpoint;
      const config = ProviderConfigSchema.parse(candidate);
      const environment = this.effectiveEnvironment();
      if (body.apiKey) {
        const keyName = config.provider === "openrouter" ? "OPENROUTER_API_KEY" : "GEMINI_API_KEY";
        environment[keyName] = body.apiKey;
      }
      const provider = this.providerFactory(config, environment);
      const setupProbe: SetupResult = {
        campaignTitle: "Schema Probe",
        scenarioMarkdown: "Schema enforcement verified.",
        openingNarration: "You stand in a quiet room, ready to act.",
        timeLabel: "Noon",
        player: {
          id: "player:hero",
          kind: "person",
          name: "Probe Hero",
          status: "active",
          location: "location:probe-room",
          tags: [],
          description: "A test adventurer.",
          establishedFacts: [],
          secrets: [],
          playerKnowledge: [],
          traits: [],
          conditions: [],
          inventory: [],
        },
        entities: [{
          id: "location:probe-room",
          kind: "location",
          name: "Probe Room",
          status: "active",
          tags: [],
          description: "A test location.",
          establishedFacts: [],
          secrets: [],
          playerKnowledge: [],
          traits: [],
          conditions: [],
          inventory: [],
        }],
        threads: [],
      };
      const setupResult = await provider.generateStructured({
        schemaName: "connection_campaign_setup",
        schema: SetupResultSchema,
        system: "Return the requested structured response exactly. This is a provider compatibility test; do not add commentary.",
        prompt: `Return exactly this campaign setup object: ${JSON.stringify(setupProbe)}`,
        temperature: 0,
        maxOutputTokens: 2000,
      });
      const result = await provider.generateStructured(gameplayRequest({
        schemaName: GAMEPLAY_SCHEMA_NAMES.connectionProbe,
        schema: TurnDecisionSchema,
        decodeResponse: decodeTurnDecision,
        system: "Return the requested structured response exactly. This is a provider compatibility test; do not add commentary.",
        prompt: `Return decision=resolved, narration and summary set to "Schema enforcement verified.", effects=[], modifiers=[], every other string empty, difficulty=0, and failureCampaignStatus=none. Include every schema field exactly once and never use null.`,
        temperature: 0,
        maxOutputTokens: 2000,
      }));
      sendJson(response, 200, {
        // Parsing any branch proves that the representative union schema was
        // enforced and accepted; the fictional branch chosen is irrelevant.
        ok: true,
        provider: result.provider,
        model: result.model,
        usage: combineUsage(setupResult.usage, result.usage) ?? null,
        structuredOutput: {
          required: true,
          compatibility: "compatible",
          mode: result.structuredMode ?? "exact_schema",
          protocolVersion: GAMEPLAY_PROTOCOL_VERSION,
          testedSchemas: ["campaign_setup", "gameplay_contract_v1"],
          providerRequirement: config.provider === "openrouter"
            ? "The selected model route must support strict response_format=json_schema for campaign setup and gameplay."
            : "The selected Gemini model must accept both provider-enforced campaign setup and Gameplay Contract V1 schemas.",
        },
      });
      return;
    }

    if (url.pathname === "/api/config/world" && method === "GET") {
      sendJson(response, 200, { markdown: await readFile(this.worldConfigPath, "utf8") });
      return;
    }

    if (url.pathname === "/api/config/world" && method === "PUT") {
      const body = z.object({ markdown: z.string().min(1).max(500_000) }).parse(await readJsonBody(request));
      await atomicWriteText(this.worldConfigPath, body.markdown);
      sendJson(response, 200, { saved: true });
      return;
    }

    if (url.pathname === "/api/campaign/draft" && method === "POST") {
      const body = SetupDraftRequestSchema.parse(await readJsonBody(request));
      const language = (await loadAppConfig(this.root)).language;
      const draft = await this.withGameLock(async () => {
        const worldRules = await readFile(this.worldConfigPath, "utf8");
        const engine = await this.engine();
        const setup = await engine.generateSetup({ ...body, language, worldRules });
        return { setup, language, worldRules };
      });
      const draftId = randomUUID();
      this.drafts.clear();
      this.drafts.set(draftId, draft);
      sendJson(response, 200, { draftId, setup: setupPreview(draft.setup) });
      return;
    }

    if (url.pathname === "/api/campaign/confirm" && method === "POST") {
      const body = z.object({ draftId: z.string().uuid(), archiveCurrent: z.boolean().default(false) }).parse(await readJsonBody(request));
      const draft = this.drafts.get(body.draftId);
      if (!draft) throw new Error("Campaign draft was not found; generate it again");
      const { setup, language, worldRules } = draft;
      const state = await this.withGameLock(async () => {
        const engine = await this.engine();
        if (await engine.hasCurrentGame()) {
          if (!body.archiveCurrent) throw new Error("A campaign already exists; confirm archival before starting another");
          return engine.replaceGame({ setup, language, worldRules });
        }
        return engine.createGame({ setup, language, worldRules });
      });
      this.drafts.delete(body.draftId);
      sendJson(response, 200, { state, openingNarration: setup.openingNarration });
      return;
    }

    if (url.pathname === "/api/game/play" && method === "POST") {
      const body = z.object({ action: z.string().trim().min(1).max(10_000) }).parse(await readJsonBody(request));
      const result = await this.withGameLock(async () => {
        await this.currentStore();
        return (await this.engine()).play(body.action);
      });
      sendJson(response, 200, playerTurnResponse(result));
      return;
    }

    if (url.pathname === "/api/game/retry" && method === "POST") {
      const result = await this.withGameLock(async () => {
        await this.currentStore();
        return (await this.engine()).resumePendingTurn();
      });
      sendJson(response, 200, playerTurnResponse(result));
      return;
    }

    if (url.pathname === "/api/game/discard" && method === "POST") {
      await this.withGameLock(async () => {
        await this.currentStore();
        await (await this.engine()).discardPendingTurn();
      });
      sendJson(response, 200, { discarded: true });
      return;
    }

    if (url.pathname === "/api/game/archive" && method === "POST") {
      await this.withGameLock(async () => {
        await this.currentStore();
        await (await this.engine()).archiveAndReset();
      });
      sendJson(response, 200, { archived: true });
      return;
    }

    if (url.pathname === "/api/game/inspect" && method === "GET") {
      const view = url.searchParams.get("view") as StateView | null;
      if (!view || !STATE_VIEWS.includes(view)) throw new Error("Invalid inspection view");
      const text = await this.withGameLock(async () => {
        await this.currentStore();
        return (await this.engine()).inspect(view);
      });
      sendJson(response, 200, { view, text });
      return;
    }

    if (url.pathname === "/api/game/transcript" && method === "GET") {
      const turns = await this.withGameLock(async () => {
        await this.currentStore();
        return (await this.engine()).recentTranscript();
      });
      sendJson(response, 200, { turns });
      return;
    }

    if (url.pathname === "/api/evaluations/runs" && method === "GET") {
      sendJson(response, 200, { runs: await this.listEvaluationRuns(), task: this.task ?? null });
      return;
    }

    if (url.pathname === "/api/evaluations/start" && method === "POST") {
      if (this.task?.status === "running") throw new Error("An evaluation task is already running");
      const config = await this.buildEvaluationConfig(await readJsonBody(request));
      const environment = this.effectiveEnvironment();
      const dm = this.providerFactory(config.dm.config, environment);
      const player = this.providerFactory(config.player.config, environment);
      const worldRules = await readFile(this.worldConfigPath, "utf8");
      const runId = `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID()}`;
      const task: BackgroundTask = { id: randomUUID(), kind: "evaluation", runId, status: "running", startedAt: new Date().toISOString(), logs: [], sessionProgress: {} };
      this.launchTask(task, async (progress) => {
        const result = await new SelfPlayEvaluator(this.root, this.evaluationsRoot, config, worldRules, dm, player, 0, progress).run(runId);
        return result.reportPath;
      });
      sendJson(response, 202, { task, config });
      return;
    }

    if (url.pathname === "/api/evaluations/resume" && method === "POST") {
      if (this.task?.status === "running") throw new Error("An evaluation task is already running");
      const body = z.object({ runId: z.string() }).parse(await readJsonBody(request));
      const runId = assertSafeId(body.runId, "run ID");
      const runDir = path.join(this.evaluationsRoot, "runs", runId);
      const manifest = await readEvaluationManifest(path.join(runDir, "manifest.json"));
      const config = EvaluationConfigSchema.parse(manifest.config);
      const environment = this.effectiveEnvironment();
      const task: BackgroundTask = { id: randomUUID(), kind: "resume", runId, status: "running", startedAt: new Date().toISOString(), logs: [], sessionProgress: {} };
      this.launchTask(task, async (progress) => {
        const resumed = new SelfPlayEvaluator(
          this.root,
          this.evaluationsRoot,
          config,
          await readFile(path.join(runDir, "world.md"), "utf8"),
          this.providerFactory(config.dm.config, environment),
          this.providerFactory(config.player.config, environment),
          manifest.totalEstimatedCostUsd,
          progress,
        );
        return (await resumed.run(runId)).reportPath;
      });
      sendJson(response, 202, { task });
      return;
    }

    if (url.pathname === "/api/evaluations/report" && method === "POST") {
      const body = z.object({ runId: z.string() }).parse(await readJsonBody(request));
      const runId = assertSafeId(body.runId, "run ID");
      const reportPath = await generateEvaluationReport(path.join(this.evaluationsRoot, "runs", runId));
      sendJson(response, 200, { report: await readFile(reportPath, "utf8") });
      return;
    }

    if (url.pathname === "/api/evaluations/artifact" && method === "GET") {
      const runId = url.searchParams.get("runId") ?? "";
      const kind = url.searchParams.get("kind") ?? "";
      const sessionId = url.searchParams.get("sessionId") ?? undefined;
      const target = this.artifactPath(runId, kind, sessionId);
      const text = await readFile(target, "utf8");
      if (kind === "transcript" && sessionId) {
        const safeRunId = assertSafeId(runId, "run ID");
        const safeSessionId = assertSafeId(sessionId, "session ID");
        const presentation = await this.evaluationTranscriptPresentation(safeRunId, safeSessionId, text);
        sendJson(response, 200, { text, presentation });
      } else {
        sendJson(response, 200, { text });
      }
      return;
    }

    sendJson(response, 404, { error: "Not found" });
  }

  async static(response: ServerResponse, pathname: string): Promise<void> {
    const files: Record<string, { name: string; type: string }> = {
      "/": { name: "index.html", type: "text/html; charset=utf-8" },
      "/index.html": { name: "index.html", type: "text/html; charset=utf-8" },
      "/app.js": { name: "app.js", type: "text/javascript; charset=utf-8" },
      "/styles.css": { name: "styles.css", type: "text/css; charset=utf-8" },
    };
    const asset = files[pathname];
    if (!asset) { sendJson(response, 404, { error: "Not found" }); return; }
    const content = await readFile(path.join(this.webRoot, asset.name));
    response.writeHead(200, {
      "Content-Type": asset.type,
      "Cache-Control": "no-cache",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'",
    });
    response.end(content);
  }
}

export function createDungeonWebServer(options: WebServerOptions): Server {
  const controller = new DungeonWebController(options.root, options);
  return createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://localhost");
      if (url.pathname.startsWith("/api/")) {
        if (rejectUnsafeMutation(request, response)) return;
        await controller.api(request, response, url);
      }
      else await controller.static(response, url.pathname);
    } catch (error) {
      sendJson(response, 400, { error: asError(error) });
    }
  });
}

export async function startDungeonWebServer(options: WebServerOptions & { host?: string; port?: number }): Promise<Server> {
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 4317;
  const server = createDungeonWebServer(options);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve());
  });
  return server;
}
