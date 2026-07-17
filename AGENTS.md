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
- Google Gemini, OpenRouter, OpenAI, Anthropic, and DeepSeek are the supported
  providers. A provider/model may be selected only after its strict multilingual
  compatibility probe passes. The API command is a placeholder, not an
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
- `src/llm-model-catalog.ts` owns the five public provider definitions, curated
  and custom model IDs, compatibility lifecycle, and the browser default model.
  It persists no credentials; `config/provider.json` remains the terminal
  configuration rather than a second authority for the browser model catalog.
- `src/providers.ts` translates the shared request into Google Gemini,
  OpenRouter, OpenAI, Anthropic, and DeepSeek calls.
- `src/connection-probe.ts` exercises the real setup and gameplay schemas for
  provider compatibility checks.
- `src/prompts.ts` is the internal Prompt Suite V1 facade. `src/prompts/`
  separates shared blocks, setup, gameplay, adjudication-only difficulty,
  administrative appeal, recovery, evaluation, and connection-probe
  instructions. Avoid provider-specific story logic here.
- `src/prompt-inspection.ts` renders static, read-only prompt previews with safe
  placeholders; it must never compose live campaign context for presentation.
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
  store validates its campaign identity and read-only status.
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
- `src/evaluation.ts` is the self-play facade. `src/evaluation/` separates run
  orchestration, contracts, configuration, shared cost accounting, telemetry,
  manifests, metrics, and reports.
- `src/evaluation/judge.ts` owns structured post-run judgment and turn-by-turn
  persistence audits.
- `src/cli.ts` is a thin entry point. `src/cli/` separates command routing, human
  gameplay, evaluation commands, prompting, and project configuration.
- `src/web-server.ts`, `src/web/`, and `web/` are the browser presentation
  surface over the same engine. There is no separate Web CLI engine or source
  entry point.
- `tests/` uses deterministic fake providers and temporary stores. Prefer adding
  regression coverage here before changing a hard-won invariant.
- `dist/` is generated. Never edit it directly.
- `data/` and `evaluations/runs/` are local runtime artifacts. Do not delete or
  rewrite the user's campaign catalog or evaluation history during refactoring.

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
- Keep provider model restrictions visible in connection testing and the Web CLI.
  The connection probe must use both the actual campaign-setup schema and the
  actual gameplay schema.
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
  headers or secrets.
- Simulated-player actions are locally capped at 800 characters, while the
  provider output budget is 1,500 tokens to leave room for hidden reasoning.

Changing the wire format is not a casual refactor. If a change is unavoidable:

1. deliberately increment `GAMEPLAY_PROTOCOL_VERSION` and its schema names;
2. update every provider and the connection probe;
3. update prompts, wire/domain codecs, telemetry, and tests together;
4. retain readable failure diagnostics;
5. run the live all-profile acceptance evaluation.

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

Adjudication, locked resolution, and evaluation judging share the current-state
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

## Evaluation invariants

- Evaluation sessions use isolated stores under `evaluations/runs`; they never
  mutate the player campaign catalog under `data/campaigns`.
- Parallelism is bounded and all workers share one reservation-based cost
  manager.
- Run IDs are collision-resistant and one filesystem lock protects each run
  from concurrent cross-process execution or resume.
- Profile selection rotates in the exact user-selected order. With one selected
  profile, every session uses it.
- Technical failures may stop a session. Fictional setbacks do not; natural
  campaign death is a valid terminal result.
- Every technically completed session receives a structured same-DM-model judge
  evaluation with one audit entry per completed turn.
- A clean quality gate means: completed session, zero failed structured calls,
  zero domain repairs, completed judge, and zero high-severity judge issues.
- Keep failure fingerprints, failed-call cost, repair counts, check rate, and
  per-session artifacts visible. Do not replace model judging with regex/string
  sentiment checks.
- Check-rate warnings above 50% are review signals, not automatic gameplay
  failures. Judge whether established danger or opposition justified them.

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
8. Run live evaluation only when explicitly authorized, a key/model is present,
   and its cost ceiling is understood.

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
- Settings separates global language/world defaults from `.env` key presence,
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
- Prompt inspection and self-play evaluation remain terminal/developer tools;
  do not expose them through browser routes or controls. Static prompt previews
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

For a provider/protocol/prompt/state/evaluation change, also run a focused live
test first, then—when authorized—the acceptance matrix:

```bash
npm run dev -- evaluate \
  --sessions 9 \
  --turns 5 \
  --concurrency 3 \
  --max-cost 5 \
  --player-profiles curious-explorer,social-manipulator,cautious-investigator,reckless-adventurer,combat-focused,creative-problem-solver,rule-challenger,long-term-planner,chaotic
```

The verified handover baseline is run `2026-07-14T18-27-34-181Z`:

- 9/9 sessions completed and 45/45 turns committed;
- 9/9 clean quality gates;
- all nine judge scores 10/10;
- zero structured failures, transient retries, schema repairs, or domain repairs;
- 42.2% aggregate check rate;
- $2.1268 estimated cost with Gemini 3.5 Flash as DM and Gemini 3.1 Flash-Lite
  as simulated player.

Live results are stochastic. A refactor is not proven safe merely because one
new run is good; local deterministic tests remain mandatory.

## Handover definition of done

A refactor is complete when:

- ownership boundaries are clearer and obsolete code is removed;
- terminal and Web CLI still operate over the same engine;
- campaign compatibility and pending-turn recovery are preserved or migrated
  explicitly;
- keys and user runtime data remain untouched;
- all local verification commands pass;
- affected live behavior has proportionate evaluation evidence;
- README and this file remain accurate.
