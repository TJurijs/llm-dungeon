# AGENTS.md

This file applies to the entire repository. It is the engineering handover for
coding agents working on `llm-dungeon`.

## Mission

Maintain a persistent, narrative-first LLM dungeon master that remains fast,
non-agentic, inspectable, and recoverable. The LLM improvises fiction; application
code owns protocol enforcement, dice, state authority, validation, persistence,
and crash recovery.

Treat current source, automated tests, and persisted schemas as the source of
truth. Do not preserve an abstraction merely because it exists, but do preserve
observable behavior and documented invariants during refactors.

## Non-negotiable product constraints

- Gameplay is non-agentic: no tools, autonomous loops, multi-agent behavior, or
  background fictional actions.
- An ordinary turn uses one DM generation. A checked turn uses one adjudication
  generation and one locked-outcome resolution generation. Bounded recovery
  calls are exceptional failure handling, not normal gameplay.
- Several resumable campaigns may coexist, each with one forward-only save.
  Archived campaigns are read-only, with no rewind or resurrection through
  undo. Death ends a campaign while preserving inspection data.
- All uncertainty uses the shared d100 mechanic. Combat is not a separate rules
  engine and has no hit points or initiative.
- State is Markdown-first with a small structured mechanical layer. Do not
  replace readable campaign storage with an opaque database without explicit
  product authorization.
- Established durable state outranks recent prose, player claims, and model
  improvisation.
- Google Gemini, OpenRouter, xAI, OpenAI, Anthropic, and DeepSeek adapters remain
  supported for persisted/custom configuration. New public selection exposes
  Gemini (`gemini-3.6-flash`, `gemini-3.5-flash-lite`), OpenRouter
  (`qwen/qwen3.7-plus`), xAI (`grok-4.5`), OpenAI (`gpt-5.4`), Anthropic
  (`claude-sonnet-5`), and DeepSeek (`deepseek-v4-flash`, `deepseek-v4-pro`).
  Do not remove an adapter or break a legacy campaign because its
  provider/model is retired from public selection.
- `gemini-3.6-flash` is the recommended and default model. A language-specific
  compatibility probe is necessary for selection but is not calibration,
  certification, narrative quality, or recommendation eligibility. English and
  Russian results remain independent. The API command is a placeholder, not an
  invitation to design a public API during unrelated work.
- The application and gameplay contract are V1. The npm package is private and
  intentionally has no public module exports; do not infer an API surface from
  internal TypeScript modules.
- Administrative appeals append a new non-fiction review turn. They never
  rewrite a committed turn, reroll, rewind, retcon, advance fictional time, end
  a campaign, or resurrect terminal state.
- Explicit `:ask` questions are read-only and not campaign-persisted. They
  never roll, mutate state, advance fictional time, or consume a campaign turn.
- Under combat or immediate pressure, one player turn resolves at most one
  primary consequential action. Incidental speech, movement, item preparation,
  or self-preservation must not become an additional independent outcome.
- English and Russian must remain functional and additional languages should be
  addable through the centralized registries.

## Repository map and boundaries

- `src/engine.ts` orchestrates setup, read-only questions, pending
  gameplay/appeal requests, checks, correction, and commit. Keep it independent
  from terminal and HTTP presentation.
- `src/types.ts` contains reusable interfaces, including `GameEngine` and
  `LlmProvider`.
- `src/llm/gameplay-protocol.ts` is the exact Gameplay Contract V1 wire
  contract. Every provider must use the same schema and deterministic decoder.
- `src/llm/structured-generation.ts` owns bounded transient/schema recovery;
  `src/llm/structured-error.ts` classifies structured failures.
- `src/llm-model-catalog.ts` owns public provider definitions, the exact curated
  and custom model IDs, compatibility lifecycle, and the browser default model.
  It persists no credentials; `config/provider.json` remains the terminal
  configuration rather than a second authority for the browser model catalog.
- `src/model-execution-profile.ts` owns the versioned provider/model/route
  execution contract, calibration variables, phase budgets, fingerprints, and
  freeze rules. `src/model-execution-profile-store.ts` is the durable authority
  for selected calibrated profiles.
- `src/model-status.ts` defines separate adapter, technical gameplay, quality,
  evidence, and recommendation concepts. `src/model-assessment-catalog.ts`
  persists current calibration and certification evidence without rewriting
  legacy evaluation history.
- `src/providers.ts` is the provider facade (adapter construction and
  persisted configuration). `src/providers/` owns the shared chat-completions
  transport, provider-specific schema projections, and the concrete Google
  Gemini, OpenRouter, xAI, OpenAI, Anthropic, and DeepSeek adapters.
- `src/connection-probe.ts` exercises the real setup and gameplay schemas for
  provider compatibility checks.
- `src/prompts.ts` is the internal Prompt Suite V1 facade. `src/prompts/`
  separates shared blocks, setup, gameplay, adjudication-only difficulty,
  administrative appeal, recovery, evaluation, and connection-probe
  instructions. Avoid provider-specific story logic here.
- `tools/playtest/prompt-inspection.ts` renders static, read-only prompt
  previews with safe placeholders; it must never compose live campaign context
  for presentation.
- `src/language.ts` is the sole gameplay-language registry and
  `src/languages/` owns per-language instructions, defaults, and deterministic
  copy.
- `src/world-profile.ts` resolves shipped native creative profiles, localized
  user overrides, and the legacy `config/world.md` compatibility path.
- `src/appeal.ts` parses and formats the human `:appeal` command;
  `src/domain/appeal.ts` enforces the deterministic correction policy, and
  `src/prompts/appeal.ts` owns both the administrative system prompt and the
  untrusted review task prompt.
- `src/question.ts` parses the explicit human `:ask` command, and
  `src/prompts/question.ts` owns its player-safe read-only answer boundary.
- `src/inspection.ts` owns the player-safe Character, Location, and Story
  threads projections. `src/cli/inspection.ts` renders those structured views
  in the terminal; presentation surfaces must not reconstruct state from prose.
- `src/campaign-catalog.ts` owns the scan-based registry of independent
  campaign stores, per-campaign provider configuration, archival, and safe
  migration from the legacy active/archive layout.
- `src/store.ts` owns one campaign's durable state, structured inspection,
  appeal evidence context, and deterministic gameplay context. A catalog-owned
  store validates its campaign identity and read-only status. The file is long
  by design: it is one responsibility expressed as uniform locked/unlocked
  method pairs, and splitting it was evaluated and rejected because every
  candidate seam widened the interface without reducing coupling.
- `src/persistence/markdown.ts` owns serialization and parsing of durable files.
- `src/persistence/files.ts` owns shared atomic writes and filesystem probes;
  `src/persistence/pending.ts` validates recoverable pending requests and commits.
- `src/persistence/lock.ts` owns crash-recoverable cross-process exclusion.
  `src/persistence/commit.ts` preflights and executes manifest-last commits;
  `src/persistence/campaign-catalog.ts` owns catalog metadata plus recoverable
  creation and legacy-layout migration intents. `src/persistence/replacement.ts`
  remains only for compatibility with pre-catalog replacement recovery.
- `src/domain/ids.ts` owns canonical names and durable ID allocation. Entity
  filename encoding lives with the Markdown persistence codec.
- `src/domain/transaction.ts` is the atomic transaction facade;
  `src/domain/transaction-normalization.ts` and
  `src/domain/transaction-application.ts` own deterministic normalization and
  in-memory application, with shared exhaustive reference mapping in
  `src/domain/operation-references.ts`.
- `src/domain/operation-consistency.ts` validates operation-list invariants;
  `src/domain/state-consistency.ts` validates whole-campaign referential and
  physical invariants.
- `src/schemas.ts` is the authoritative runtime domain contract.
- `src/mechanics.ts` is the sole d100 calculation authority.
- `tools/playtest/` is the developer-only playtest harness, physically separate
  from the shipped app. `tools/playtest/harness/` is the single versioned engine
  for calibration, certification, autoplay, stress, tuning, scheduling,
  telemetry, assessment, judging, manifests, reports, resume, and focused
  replay. Packages describe experiments; player profiles describe
  simulated-player behavior. The harness may import app modules from `src/`,
  but app code must never import from `tools/` (lint-enforced).
- `tools/playtest/legacy-evaluation-artifacts.ts` owns the sole versioned
  read-only v1 manifest reader for existing `evaluations/runs/`;
  `tools/playtest/web/evaluation-artifacts.ts` presents those legacy artifacts
  without treating them as live state. Do not restore `src/evaluation.ts`, the
  old `src/evaluation/` runner stack, or any write/resume path for legacy runs.
- `src/cli.ts` is the shipped thin entry point; `src/cli/` separates runtime
  command routing, human gameplay, prompting, and project configuration.
  `tools/playtest/playtest-cli.ts` and `tools/playtest/cli/` are the
  developer-only playtest commands and thin deprecated evaluation aliases,
  outside the app build and `dist`.
- `src/web-server.ts`, `src/web/`, and `web/` are the browser presentation
  surface over the same engine. There is no separate Web engine or source
  entry point.
- `tests/` uses deterministic fake providers and temporary stores. Prefer adding
  regression coverage here before changing a hard-won invariant.
- `dist/` is generated. Never edit it directly.
- `data/`, `evaluations/runs/`, and playtest run directories are local runtime
  artifacts. Do not delete or rewrite the user's campaign catalog, evaluation
  history, calibration evidence, or playtest history during refactoring.

Keep dependency flow pointed inward:

```text
terminal / web
      ↓
 DungeonEngine
   ↙       ↘
StateStore  StructuredClient → LlmProvider
   ↓              ↓
transaction    Gameplay Contract V1
```

Presentation code may depend on the engine; the engine must not depend on CLI or
browser code.

## State and transaction invariants

- The model returns operations; it never writes files or supplies paths.
- Validate the entire operation list before mutating anything. Never partially
  apply a model response.
- Durable IDs and paths are application-generated. Model IDs are temporary
  same-turn hints only.
- Existing references require authoritative IDs or exact type-compatible
  namespace completion. Near-miss repair is limited to an unambiguous entity
  created in the same transaction. Do not introduce fuzzy matching across the
  established world.
- Exact canonical duplicate locations are coalesced; established locations are
  never recreated under aliases.
- Inventory is the ownership authority. A carried item has no world `location`.
  A location inventory represents loose objects physically there.
- Transfers between known owners are conserved with `transfer_item`. Do not
  model one exchange as unrelated debit and credit operations.
- Inventory cannot become negative. Duplicate-credit validation retains the
  latest gameplay/opening ledger plus following appeal ledgers; an empty denied
  appeal must never mask the latest gameplay credit.
- Idempotent movement to the current authoritative location is normalized away.
- Every entity `location` must reference a location entity.
- Fact supersession preserves history; do not destructively erase established
  facts.
- A prepared commit is written to `pending-turn.json`, writes non-manifest files
  first, commits the manifest last, and can be replayed idempotently. Validate
  its complete plan before mutation and require exactly the target turn log.
- Mutations within one campaign are serialized across processes with that
  campaign's filesystem lock. Catalog creation, archival, configuration, and
  migration use the catalog lock; different campaigns may generate in parallel.
- Accepted setup is persisted in a secret-free creation intent before its store
  is published. Recovery must finish or conservatively preserve an interrupted
  creation, and retrying the same browser draft must not create a duplicate.
- Legacy replacement recovery must settle before catalog migration. Catalog
  migration uses a durable intent and remains idempotent after interruption.
- Never alter an already committed turn during recovery.
- Appeals are append-only corrections. A targeted turn supplies evidence but is
  never rewritten; current durable state and later committed consequences
  outrank older prose and the player's untrusted claim.
- Appeal operations are validated atomically. They cannot roll, advance time,
  record a major event, end a campaign, restore terminal state, or create a
  non-item entity. A denied appeal commits no state operations.
- A rolled check is persisted before resolution and must reuse the same natural
  roll after failure/restart.
- Checked death/ending status is locked before the roll and applied by code. The
  resolution model cannot introduce a harsher campaign ending.

Do not use regex, keyword matching, or free-form prose heuristics to silently
invent or mutate gameplay state. Deterministic normalization must operate on the
structured transaction and must be conservative, explainable, and covered by
tests. AI judging may assess prose after a run; it is not part of turn commit.

## Protocol and provider invariants

- Gameplay Contract V1 is strict and flat. Provider output constraints, wire
  Zod schema, decoder, and domain Zod schema form one chain; do not bypass a
  layer. DeepSeek's documented JSON Object mode receives the exact schema and a
  deterministic example in the prompt, then relies on the same strict local
  wire validation; it is not a schema-less or free-form fallback.
- Keep the implementation at the unversioned
  `src/llm/gameplay-protocol.ts` path. Do not restore old contract modules or
  parallel compatibility paths unless a real persisted format requires them.
- Unknown fields, aliases, Markdown fences, array wrappers, and partial JSON fail
  closed. Do not add a schema-less fallback to improve apparent success rates.
- Keep provider model restrictions visible in connection testing and the Web app.
  Each language-specific connection probe must use both the actual campaign-setup
  schema and the actual gameplay schema. A failure in one language must not erase
  a current passing result for another language.
- Curated models may ship real compatibility or legacy speed/cost evidence with
  provenance, but never invented calibration or certification results. The
  browser does not expose retest controls for known curated models. Custom model
  tests probe every registered language independently; partial language
  compatibility is valid and must remain visible.
- Adding a custom browser model only registers its ID; it does not call the
  provider. The custom row owns its Test and remove controls. Known models cannot
  be removed, and custom removal must not orphan a default, campaign, or setup draft.
- A `ModelExecutionProfile` is keyed by provider, model, and route. Direct and
  aggregator routes for the same underlying model are separate. The profile
  fixes structured-output mode, schema projection, temperature, reasoning,
  output-token field, phase budgets, timeouts, adapter revision, and evidence.
- Calibration changes one bounded provider-supported variable at a time and
  retains every attempt. Output budgets escalate only after finish metadata or
  the response proves truncation, using bounded phase-specific steps. Repair
  receives at least the failed phase's budget. Never improve apparent
  calibration by weakening local wire/domain validation.
- Certification may start only with the selected execution profile frozen by
  fingerprint. A profile or adapter-revision change makes prior certification
  stale and requires a fresh `certification-v1` run.
- Gemini intentionally receives a compatible projection of the same schema; its
  adapter omits unsupported/high-complexity annotations while local Zod limits
  remain authoritative.
- Post-roll resolution, appeal, and domain-correction requests use the same V1
  wire object with the provider schema additionally locking `decision` to
  `resolved`; only adjudication and the connection probe expose the full union.
- API keys come only from process memory, environment variables, or `.env`.
  Never print, persist, snapshot, or include them in exceptions. Do not inspect
  or reproduce the contents of the user's `.env`; checking key presence is enough.
- A malformed structured response gets at most one schema repair. A transient
  failure gets at most one retry. A valid but inapplicable transaction gets at
  most one domain correction.
- Preserve usage metadata and failure classification without logging auth
  headers or secrets. Physical attempts also retain route, phase, attempt kind,
  profile fingerprint, schema mode/projection, token field/budget, timeout,
  backoff, finish reason, and truncation evidence where available.
- Simulated-player actions are locally capped at 800 characters, while the
  provider output budget is 1,500 tokens to leave room for hidden reasoning.

Changing the wire format is not a casual refactor. If a change is unavoidable:

1. deliberately increment `GAMEPLAY_PROTOCOL_VERSION` and its schema names;
2. update every provider and the connection probe;
3. update prompts, wire/domain codecs, telemetry, and tests together;
4. retain readable failure diagnostics;
5. invalidate affected profiles and certifications, then run focused live
   calibration and `certification-v1` only when explicitly authorized with a
   known cost ceiling.

## Context and prompting invariants

Context retrieval is deterministic. Do not add embeddings, vector search, an
LLM retrieval loop, or tools without explicit authorization.

Prompt Suite V1 is composed from named reusable sections. The check-difficulty
policy belongs to adjudication only and is not a separate generation;
resolution receives the application-locked roll, outcome, and stakes. Keep
static prompt inspection read-only and free of live campaign state and secrets.

Appeals use their dedicated administrative system prompt, including for schema
and domain repair. Do not route an appeal through gameplay narration, agency,
check, or scene-continuation instructions.

Adjudication, locked resolution, and playtest judging share the current-state
reconciliation policy. When a turn explicitly changes or ends an existing
status, condition, fact, relationship, or thread state, update the corresponding
current record while preserving superseded fact history. Reconcile only changes
causally established by that narration or locked outcome; never infer expiry or
clear state speculatively.

The DM context includes:

- campaign rules and scenario;
- authoritative player and current-location state;
- entities at the location, parent locations, inventory-linked and directly
  related entities;
- active-thread entities;
- compact authoritative location directory;
- active/resolved threads and major events;
- the latest gameplay/opening operation ledger plus every following appeal
  ledger, all marked as already applied;
- eight recent summaries, retaining full narration only for the latest turn.

Key facts in entity Markdown are durable and must not be compacted away. Recent
turn prose is working memory, not state authority. This eight-summary/latest-
narration policy is the established context-compaction design; preserve it
during storage, prompt, and retrieval refactors.

For resolved output, keep causal ordering: narration first, effects derived only
from events explicitly in narration, summary last. The summary cannot introduce
new facts.

## Playtest, calibration, and assessment invariants

- Adapter status (`uncalibrated`, `calibrated`, `calibration_inconclusive`,
  `no_compatible_profile`), technical gameplay status (`clean`,
  `playable_with_recovery`, `unstable`, `unsupported`, `inconclusive`), and
  language-specific quality (`high`, `medium`, `low`, `unrated`,
  `awaiting_judgment`) are independent authorities. Recommendation eligibility
  is derived separately and is never equivalent to a connection-schema pass.
  Gemini 3.5 Flash remains the explicit product-recommended default even when
  no new paid certification has been authorized.
- Calibration is non-scored and exercises representative setup, resolved real
  effects, `check_required`, locked resolution, inventory/reference transfer,
  production-sized context, and near-normal output. Variants for one
  provider/model/route run sequentially by default, change exactly one variable,
  retain every result, and are selected by protocol correctness, first-pass
  success, no truncation, no repairs, latency, then cost. Different model routes
  may calibrate concurrently within scheduler limits.
- Every failure receives one evidence-based owner: `candidate_model`,
  `adapter_configuration`, `provider_route`, `account_access`, `judge`,
  `player_driver`, `application`, or `inconclusive`. Judge, player, provider,
  account, adapter, and application failures do not reduce candidate quality or
  technical status; they are excluded or make the result inconclusive.
- One playtest engine owns `certification-v1`, `campaign-autoplay-v1`,
  `persistence-soak-v1`, `adversarial-boundaries-v1`, `mechanics-v1`, and
  `tuning-v1`. Do not reintroduce separate evaluation and autoplay runners.
- The developer terminal surface (`npm run playtest -- playtest ...`) includes `playtest packages`, `playtest calibrate`,
  `playtest replay <diagnostic-bundle>`, and
  `playtest run <package>`; `playtest certify`, `playtest matrix <package>`, and
  `playtest resume <run-id>`; plus `playtest judge <run-id>`,
  `playtest report <run-id>`, and `playtest compare <run-id> <run-id>`. Matrix
  jobs are independent combinations of package × candidate × language ×
  optional repetition, never interacting models or concurrent turns inside one
  campaign. Deprecated `evaluate` spellings may remain only as thin routes into
  the playtest engine and must never instantiate the retired evaluator.
- `certification-v1` is the only package that may update authoritative model
  technical/quality metadata. It uses one bilingual canonical starting state,
  ten branch-aware scripted actions, deterministic per-turn rolls, no AI
  player, deterministic coverage where possible, and one separate final judge
  call. Its turn-seven fixture explicitly locks the natural-1 consequence as a
  severe but survivable injury; this evaluation constraint does not weaken
  lethal stakes in ordinary gameplay. If a committed valid terminal outcome
  nevertheless ends that fixture, preserve it and use the package's fresh
  isolated continuation fixture for later coverage rather than resurrecting
  the campaign. Other packages are diagnostic only.
- Autoplay is an external harness submitting one ordinary player action at a
  time; it never gives the DM tools or autonomous fictional behavior. Packages
  describe experiments, while the nine player profiles below remain optional
  behavior inputs for autoplay and stress runs. Player-model failures belong to
  `player_driver` and never enter candidate metrics.
- Judged packages default to a fixed Gemini 3.5 Flash target and allow an
  explicit override. The judge call is separate, blinded, non-mutating, and
  fixed across a comparison batch; the same underlying model may judge its own
  gameplay in this separate lane. Freeze candidate
  technical metrics before judging; judge calls, repairs, latency, cost, and
  failures remain in a separate lane and can never alter candidate technical
  status. Judging is rerunnable without rerunning gameplay, and a failed or
  pending judge leaves quality `awaiting_judgment`.
- Checkpoint judges assess only their interval plus relevant boundary state,
  never mutate fiction, can retry independently, and do not occupy candidate
  gameplay worker slots. Candidate, player, judge, and calibration telemetry are
  stored separately.
- Playtest stores are isolated from `data/campaigns`. Runs use collision-resistant
  IDs and filesystem locks; resume is idempotent. Preserve existing
  `evaluations/runs/` as legacy evidence and never reinterpret its old quality
  labels as current certification.
- Parallelism is optional and bounded across independent jobs/campaigns by a
  global worker limit, provider-specific pools, and one reservation-based cost
  manager. Turns within one campaign are always serialized. Support cancellation
  and resume without overlapping a campaign or duplicating committed turns.
- Reports distinguish scheduler queue wait, provider-call duration,
  retry/backoff time, and player-visible turn duration. Canonical speed uses
  concurrency 1; concurrent measurements are explicitly loaded latency.
- Failed calls may produce a secret-safe diagnostic bundle with state snapshot,
  prompt/schema hashes, route/profile, response metadata, parsed failure, and
  expected phase. Focused replay is bounded and non-committing. A replay fix is
  only diagnostic; freeze the changed profile and rerun `certification-v1`.
- Technical failures may stop a job. Fictional setbacks do not; natural campaign
  death is a valid terminal result. Technical health and exercised coverage are
  independent evidence: a valid terminal result completes its fixture, while
  later requirements remain visibly `not_exercised` unless a fresh fixture
  completes them. Keep failure fingerprints, failed-call cost,
  repair counts, check rate, invariant status, and per-job artifacts visible.
  AI judging may assess prose, but deterministic code owns mechanics and state
  auditing. Check-rate warnings are review signals, not automatic failures.
- Never run paid calibration, certification, autoplay, stress, replay, or
  judging without explicit authorization and an understood cost ceiling.

Nine profiles exist and should remain individually selectable:

```text
curious-explorer
social-manipulator
cautious-investigator
reckless-adventurer
combat-focused
creative-problem-solver
rule-challenger
long-term-planner
chaotic
```

## Refactoring workflow

1. Read the touched modules and their tests before editing.
2. Identify the invariant or ownership boundary being improved.
3. Prefer moving existing behavior behind a clearer interface over maintaining
   parallel old/new paths.
4. Delete dead code, obsolete exports, and superseded tests once callers are
   migrated. Do not leave obsolete or temporary compatibility code unless a
   real persisted format still needs it.
5. Keep patches scoped. Preserve unrelated user changes and runtime data.
6. Add regression tests for every bug class or normalization rule.
7. Run the complete local gate.
8. Run live calibration, playtesting, replay, or judging only when explicitly
   authorized, the required keys/models are present, and the cost ceiling is
   understood.

Do not assume Git metadata is available in this directory. Inspect files directly
and do not use destructive Git commands to manufacture a clean tree.

## Presentation invariants

- Commander help groups commands under Game, Configuration, Evaluation,
  Interfaces, and Future. In-game help groups inspection, appeal, recovery, and
  campaign actions. Keep additions in the matching group.
- The browser uses a campaign sidebar and chat-like main pane. New campaign
  setup collects premise, character, and language, then uses the configured
  default provider/model. World and DM style is collapsed, prefilled from the
  selected language's global profile, and may be customized for that campaign.
- Settings uses one saved language for the interface and as the overridable
  default for new campaigns. It separates those global language/world defaults from `.env` key presence,
  available models, default model selection, and compatibility testing.
  Temperature and output limits remain internal. Existing campaigns retain
  their own provider/model, language, and world profile, and the composer model
  selector updates only the selected campaign.
- The player-safe campaign setup view may expose only the effective starting
  premise, character concept, language, and immutable world/DM-style snapshot.
  Older campaigns without a durable setup snapshot report it as unavailable.
- Campaign archival uses an in-app confirmation dialog, never a native browser
  confirmation.
- The World & DM style editor changes only the selected language's creative
  future-campaign profile. It must not expose editing of core prompt, protocol,
  mechanics, or state-authority rules.
- Prompt inspection, calibration, certification, autoplay, stress, tuning, and
  judging remain terminal/developer tools; do not expose them through browser
  routes or controls. Static prompt previews
  must never compose live campaign context or secrets.
- Browser inspection has exactly three player-safe views: Character (including
  inventory), Location, and Story threads. Location exposes only player-safe
  location state; omit co-located entities and loose location inventory until
  the domain has explicit visibility tracking. Keep transcript reconstruction
  separate from state inspection.
- The global Ask and Appeal icons only prefill a command in the action field.
  They must never send, commit, or silently mutate state on click.
- Permanent deletion is available only for archived campaigns, requires the
  exact campaign title in both the UI and server request, and removes the
  matching browser cache.
- Browser draft/status/turn/transcript/inspection responses are player-safe
  projections. Do not expose setup secrets, prepared writes, raw state
  operations, or alternate check stakes through presentation endpoints.
- Browser mutations require JSON and same-origin request metadata; do not weaken
  this local cross-site request protection when adding routes.
- `llm-dungeon api` must remain visibly non-operational until a machine-facing
  contract is explicitly authorized and designed.

## Required verification

For every code refactor:

```bash
npm test -- --run
npm run typecheck
npm run build
```

The local gate is the complete deterministic Vitest suite, strict TypeScript,
and a successful production build. Do not pin the test count in this handover;
regression coverage is expected to grow.

For provider/protocol/prompt/state/playtest changes, add focused deterministic
tests for the affected adapter phase, package, lane, scheduler, or recovery
path. No paid command is part of the default local gate.

Live `playtest calibrate`, `certify`, `run`, `matrix`, `judge`, or focused replay
may run only with explicit authorization, available keys/models, and an agreed
cost ceiling. Calibrate and freeze the exact provider/model/route profile before
certification. Use `certification-v1` for authoritative model qualification;
use autoplay, stress, mechanics, and tuning packages only for diagnostics.
Canonical speed evidence must use concurrency 1, while concurrent results must
be labeled loaded latency.

Historical 9×5 evaluation runs and their same-model judgments are legacy
evidence only. Preserve their artifacts, but do not use the old matrix, “clean
quality gate,” or judge scores as current calibration, certification, or
recommendation authority. Live results are stochastic; one good run never
replaces the deterministic local gate.

## Handover definition of done

A refactor is complete when:

- ownership boundaries are clearer and obsolete code is removed;
- terminal and Web app still operate over the same engine;
- campaign compatibility and pending-turn recovery are preserved or migrated
  explicitly;
- keys and user runtime data remain untouched;
- all local verification commands pass;
- affected live behavior has proportionate playtest evidence when a live run was
  explicitly authorized, with package/profile fingerprints and lane attribution;
- README and this file remain accurate.
