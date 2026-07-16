import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import type { Dirent } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { DungeonEngine } from "./engine.js";
import { probeProviderConnection } from "./connection-probe.js";
import { loadProjectEnv } from "./env.js";
import {
  buildEvaluationConfig as createEvaluationConfig,
  generateEvaluationReport,
  PlayerProfileIdSchema,
  readEvaluationManifest,
  SelfPlayEvaluator,
  type EvaluationConfig,
  type EvaluationManifest,
  type EvaluationProgressEvent,
} from "./evaluation.js";
import { LANGUAGES, LanguageCodeSchema, loadAppConfig, saveAppConfig, type LanguageCode } from "./language.js";
import { inspectPrompt, PROMPT_PHASES } from "./prompt-inspection.js";
import { createProvider, loadProviderConfig } from "./providers.js";
import { ProviderConfigSchema, type ProviderConfig, type SetupResult } from "./schemas.js";
import { StateStore } from "./store.js";
import { atomicWriteJson } from "./persistence/files.js";
import type { LlmProvider, StateView } from "./types.js";
import { resolveWorldProfile, saveWorldProfile } from "./world-profile.js";
import { parseAppealCommand } from "./appeal.js";
import { parseQuestionCommand } from "./question.js";
import {
  assertSafeId,
  evaluationArtifactPath,
  evaluationTranscriptPresentation,
} from "./web/evaluation-artifacts.js";
import { asError, readJsonBody, rejectUnsafeMutation, sendJson } from "./web/http.js";
import { pendingStatus, playerTurnResponse, setupPreview } from "./web/presentation.js";

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

const STATE_VIEWS: StateView[] = ["character", "location", "threads"];

export class DungeonWebController {
  readonly providerConfigPath: string;
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
    return createEvaluationConfig({
      dmConfig,
      language: (await loadAppConfig(this.root)).language,
      sessions: request.sessions,
      turns: request.turns,
      concurrency: request.concurrency,
      maxCostUsd: request.maxCostUsd,
      playerProfiles: request.playerProfiles,
      playerModel: request.playerModel,
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

  private async handleStatusApi(
    method: string,
    response: ServerResponse,
    url: URL,
  ): Promise<boolean> {
    if (method !== "GET" || url.pathname !== "/api/status") return false;
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
      languages: Object.entries(LANGUAGES).map(([code, value]) => ({
        code,
        name: value.nativeName,
        setupDefaults: value.setupDefaults,
      })),
      config: config ?? null,
      keyStatus: this.keyStatus(),
      game: { exists: hasGame, busy: this.gameBusy, campaign: campaign ?? null, pending: pending ?? null },
      evaluationTask: this.task ?? null,
    });
    return true;
  }

  private async handleConfigurationApi(
    method: string,
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
  ): Promise<boolean> {
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
      return true;
    }

    if (url.pathname === "/api/config/provider" && method === "GET") {
      const config = await this.config().catch(() => null);
      sendJson(response, 200, { config, keyStatus: this.keyStatus() });
      return true;
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
      const keyName = body.provider === "openrouter" ? "OPENROUTER_API_KEY" : "GEMINI_API_KEY";
      if (body.apiKey !== undefined) {
        if (body.apiKey) this.runtimeKeys[keyName] = body.apiKey;
        else delete this.runtimeKeys[keyName];
      }
      await atomicWriteJson(this.providerConfigPath, config);
      sendJson(response, 200, {
        config,
        keyStatus: this.keyStatus(),
        keyStorage: body.apiKey ? "memory_only" : body.apiKey === "" ? "environment" : "unchanged",
      });
      return true;
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
      const keyName = config.provider === "openrouter" ? "OPENROUTER_API_KEY" : "GEMINI_API_KEY";
      if (body.apiKey) {
        environment[keyName] = body.apiKey;
      } else if (body.apiKey === "") {
        const environmentKey = this.environment[keyName];
        if (environmentKey) environment[keyName] = environmentKey;
        else delete environment[keyName];
      }
      const result = await probeProviderConnection(this.providerFactory(config, environment));
      sendJson(response, 200, {
        ok: true,
        provider: result.provider,
        model: result.model,
        usage: result.usage ?? null,
        structuredOutput: {
          required: true,
          compatibility: "compatible",
          mode: result.structuredMode,
          protocolVersion: result.protocolVersion,
          testedSchemas: ["campaign_setup", "gameplay_contract_v1"],
          providerRequirement: config.provider === "openrouter"
            ? "The selected model route must support strict response_format=json_schema for campaign setup and gameplay."
            : "The selected Gemini model must accept both provider-enforced campaign setup and Gameplay Contract V1 schemas.",
        },
      });
      return true;
    }

    if (url.pathname === "/api/config/world" && method === "GET") {
      const configured = (await loadAppConfig(this.root)).language;
      const language = LanguageCodeSchema.parse(url.searchParams.get("language") ?? configured);
      const profile = await resolveWorldProfile(this.root, language);
      sendJson(response, 200, { language, markdown: profile.markdown, source: profile.source });
      return true;
    }

    if (url.pathname === "/api/config/world" && method === "PUT") {
      const body = z.object({
        language: LanguageCodeSchema.optional(),
        markdown: z.string().min(1).max(500_000),
      }).parse(await readJsonBody(request));
      const language = body.language ?? (await loadAppConfig(this.root)).language;
      await saveWorldProfile(this.root, language, body.markdown);
      sendJson(response, 200, { saved: true, language, source: "localized_override" });
      return true;
    }

    if (url.pathname === "/api/config/prompts" && method === "GET") {
      const phase = z.enum(PROMPT_PHASES).parse(url.searchParams.get("phase") ?? "dm-system");
      const configured = (await loadAppConfig(this.root)).language;
      const language = LanguageCodeSchema.parse(url.searchParams.get("language") ?? configured);
      sendJson(response, 200, inspectPrompt(phase, language));
      return true;
    }
    return false;
  }

  private async handleCampaignApi(
    method: string,
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
  ): Promise<boolean> {
    if (url.pathname === "/api/campaign/draft" && method === "POST") {
      const body = SetupDraftRequestSchema.parse(await readJsonBody(request));
      const language = (await loadAppConfig(this.root)).language;
      const draft = await this.withGameLock(async () => {
        const worldRules = (await resolveWorldProfile(this.root, language)).markdown;
        const engine = await this.engine();
        const setup = await engine.generateSetup({ ...body, language, worldRules });
        return { setup, language, worldRules };
      });
      const draftId = randomUUID();
      this.drafts.clear();
      this.drafts.set(draftId, draft);
      sendJson(response, 200, { draftId, setup: setupPreview(draft.setup) });
      return true;
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
      return true;
    }
    return false;
  }

  private async handleGameApi(
    method: string,
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
  ): Promise<boolean> {
    if (url.pathname === "/api/game/play" && method === "POST") {
      const body = z.object({ action: z.string().trim().min(1).max(10_000) }).parse(await readJsonBody(request));
      const result = await this.withGameLock(async () => {
        await this.currentStore();
        const engine = await this.engine();
        const question = parseQuestionCommand(body.action);
        if (question) return engine.ask(question);
        const appeal = parseAppealCommand(body.action);
        return appeal ? engine.appeal(appeal) : engine.play(body.action);
      });
      sendJson(response, 200, playerTurnResponse(result));
      return true;
    }

    if (url.pathname === "/api/game/retry" && method === "POST") {
      const result = await this.withGameLock(async () => {
        await this.currentStore();
        return (await this.engine()).resumePendingTurn();
      });
      sendJson(response, 200, playerTurnResponse(result));
      return true;
    }

    if (url.pathname === "/api/game/discard" && method === "POST") {
      await this.withGameLock(async () => {
        await this.currentStore();
        await (await this.engine()).discardPendingTurn();
      });
      sendJson(response, 200, { discarded: true });
      return true;
    }

    if (url.pathname === "/api/game/archive" && method === "POST") {
      await this.withGameLock(async () => {
        await this.currentStore();
        await (await this.engine()).archiveAndReset();
      });
      sendJson(response, 200, { archived: true });
      return true;
    }

    if (url.pathname === "/api/game/inspect" && method === "GET") {
      const view = url.searchParams.get("view") as StateView | null;
      if (!view || !STATE_VIEWS.includes(view)) throw new Error("Invalid inspection view");
      const inspection = await this.withGameLock(async () => {
        await this.currentStore();
        return (await this.engine()).inspect(view);
      });
      sendJson(response, 200, { inspection });
      return true;
    }

    if (url.pathname === "/api/game/transcript" && method === "GET") {
      const turns = await this.withGameLock(async () => {
        await this.currentStore();
        return (await this.engine()).recentTranscript();
      });
      sendJson(response, 200, { turns });
      return true;
    }
    return false;
  }

  private async handleEvaluationApi(
    method: string,
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
  ): Promise<boolean> {
    if (url.pathname === "/api/evaluations/runs" && method === "GET") {
      sendJson(response, 200, { runs: await this.listEvaluationRuns(), task: this.task ?? null });
      return true;
    }

    if (url.pathname === "/api/evaluations/start" && method === "POST") {
      if (this.task?.status === "running") throw new Error("An evaluation task is already running");
      const config = await this.buildEvaluationConfig(await readJsonBody(request));
      const environment = this.effectiveEnvironment();
      const dm = this.providerFactory(config.dm.config, environment);
      const player = this.providerFactory(config.player.config, environment);
      const worldRules = (await resolveWorldProfile(this.root, config.language)).markdown;
      const runId = `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID()}`;
      const task: BackgroundTask = { id: randomUUID(), kind: "evaluation", runId, status: "running", startedAt: new Date().toISOString(), logs: [], sessionProgress: {} };
      this.launchTask(task, async (progress) => {
        const result = await new SelfPlayEvaluator(this.root, this.evaluationsRoot, config, worldRules, dm, player, 0, progress).run(runId);
        return result.reportPath;
      });
      sendJson(response, 202, { task, config });
      return true;
    }

    if (url.pathname === "/api/evaluations/resume" && method === "POST") {
      if (this.task?.status === "running") throw new Error("An evaluation task is already running");
      const body = z.object({ runId: z.string() }).parse(await readJsonBody(request));
      const runId = assertSafeId(body.runId, "run ID");
      const runDir = path.join(this.evaluationsRoot, "runs", runId);
      const manifest = await readEvaluationManifest(path.join(runDir, "manifest.json"));
      const config = manifest.config;
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
      return true;
    }

    if (url.pathname === "/api/evaluations/report" && method === "POST") {
      const body = z.object({ runId: z.string() }).parse(await readJsonBody(request));
      const runId = assertSafeId(body.runId, "run ID");
      const reportPath = await generateEvaluationReport(path.join(this.evaluationsRoot, "runs", runId));
      sendJson(response, 200, { report: await readFile(reportPath, "utf8") });
      return true;
    }

    if (url.pathname === "/api/evaluations/artifact" && method === "GET") {
      const runId = url.searchParams.get("runId") ?? "";
      const kind = url.searchParams.get("kind") ?? "";
      const sessionId = url.searchParams.get("sessionId") ?? undefined;
      const target = evaluationArtifactPath(this.evaluationsRoot, runId, kind, sessionId);
      const text = await readFile(target, "utf8");
      if (kind === "transcript" && sessionId) {
        const safeRunId = assertSafeId(runId, "run ID");
        const safeSessionId = assertSafeId(sessionId, "session ID");
        const presentation = await evaluationTranscriptPresentation(
          this.evaluationsRoot,
          safeRunId,
          safeSessionId,
          text,
        );
        sendJson(response, 200, { text, presentation });
      } else {
        sendJson(response, 200, { text });
      }
      return true;
    }
    return false;
  }

  async api(request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> {
    const method = request.method ?? "GET";
    if (await this.handleStatusApi(method, response, url)) return;
    if (await this.handleConfigurationApi(method, request, response, url)) return;
    if (await this.handleCampaignApi(method, request, response, url)) return;
    if (await this.handleGameApi(method, request, response, url)) return;
    if (await this.handleEvaluationApi(method, request, response, url)) return;

    sendJson(response, 404, { error: "Not found" });
  }

  async static(response: ServerResponse, pathname: string): Promise<void> {
    const files: Record<string, { name: string; type: string }> = {
      "/": { name: "index.html", type: "text/html; charset=utf-8" },
      "/index.html": { name: "index.html", type: "text/html; charset=utf-8" },
      "/app.js": { name: "app.js", type: "text/javascript; charset=utf-8" },
      "/terminal-history.js": { name: "terminal-history.js", type: "text/javascript; charset=utf-8" },
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
