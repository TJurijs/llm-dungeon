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
- There is one active campaign, archived replacement runs, no rewind, and no
  resurrection through undo. Death ends play while preserving inspection data.
- All uncertainty uses the shared d100 mechanic. Combat is not a separate rules
  engine and has no hit points or initiative.
- State is Markdown-first with a small structured mechanical layer. Do not
  replace readable campaign storage with an opaque database without explicit
  product authorization.
- Established durable state outranks recent prose, player claims, and model
  improvisation.
- Gemini and OpenRouter are the supported providers. The API command is a
  placeholder, not an invitation to design a public API during unrelated work.
- The application and gameplay contract are V1. The npm package is private and
  intentionally has no public module exports; do not infer an API surface from
  internal TypeScript modules.
- English and Russian must remain functional and additional languages should be
  addable through the centralized registries.

## Repository map and boundaries

- `src/engine.ts` orchestrates setup, pending actions, checks, correction, and
  commit. Keep it independent from terminal and HTTP presentation.
- `src/types.ts` contains reusable interfaces, including `GameEngine` and
  `LlmProvider`.
- `src/llm/gameplay-protocol.ts` is the exact Gameplay Contract V1 wire
  contract. Both providers must use the same schema and deterministic decoder.
- `src/llm/structured-generation.ts` owns bounded transient/schema recovery;
  `src/llm/structured-error.ts` classifies structured failures.
- `src/providers.ts` translates the shared request into Gemini/OpenRouter calls.
- `src/prompts.ts` contains setup, adjudication, resolution, and correction
  instructions. Avoid provider-specific story logic here.
- `src/store.ts` owns the active/archive layout, recovery records, inspection,
  and deterministic context selection.
- `src/persistence/markdown.ts` owns serialization and parsing of durable files.
- `src/persistence/files.ts` owns shared atomic writes and filesystem probes;
  `src/persistence/pending.ts` validates recoverable pending actions and commits.
- `src/persistence/lock.ts` owns crash-recoverable cross-process exclusion;
  `src/persistence/replacement.ts` validates durable campaign replacement intent.
- `src/domain/ids.ts` owns canonical names and durable ID allocation. Entity
  filename encoding lives with the Markdown persistence codec.
- `src/domain/transaction.ts` owns deterministic operation normalization,
  complete validation, and in-memory application.
- `src/domain/operation-consistency.ts` validates operation-list invariants;
  `src/domain/state-consistency.ts` validates whole-campaign referential and
  physical invariants.
- `src/schemas.ts` is the authoritative runtime domain contract.
- `src/mechanics.ts` is the sole d100 calculation authority.
- `src/evaluation.ts` runs isolated self-play, shared cost accounting, progress,
  metrics, and reports.
- `src/evaluation/judge.ts` owns structured post-run judgment and turn-by-turn
  persistence audits.
- `src/cli.ts` is a thin entry point. `src/cli/` separates command routing, human
  gameplay, evaluation commands, prompting, and project configuration.
- `src/web-server.ts` and `web/` are the browser presentation surface over the
  same engine. There is no separate Web CLI engine or source entry point.
- `tests/` uses deterministic fake providers and temporary stores. Prefer adding
  regression coverage here before changing a hard-won invariant.
- `dist/` is generated. Never edit it directly.
- `data/` and `evaluations/runs/` are local runtime artifacts. Do not delete or
  rewrite the user's active campaign or evaluation history during refactoring.

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
- Inventory cannot become negative. A repeated abstract positive credit matching
  the immediately preceding turn is rejected to prevent duplicated rewards.
- Idempotent movement to the current authoritative location is normalized away.
- Every entity `location` must reference a location entity.
- Fact supersession preserves history; do not destructively erase established
  facts.
- A prepared commit is written to `pending-turn.json`, writes non-manifest files
  first, commits the manifest last, and can be replayed idempotently. Validate
  its complete plan before mutation and require exactly the target turn log.
- Campaign mutations are serialized across processes with the filesystem lock.
  Accepted replacement is staged before archival and guarded by durable intent
  that recovery can complete or restore.
- Never alter an already committed turn during recovery.
- A rolled check is persisted before resolution and must reuse the same natural
  roll after failure/restart.
- Checked death/ending status is locked before the roll and applied by code. The
  resolution model cannot introduce a harsher campaign ending.

Do not use regex, keyword matching, or free-form prose heuristics to silently
invent or mutate gameplay state. Deterministic normalization must operate on the
structured transaction and must be conservative, explainable, and covered by
tests. AI judging may assess prose after a run; it is not part of turn commit.

## Protocol and provider invariants

- Gameplay Contract V1 is strict and flat. Provider JSON Schema, wire Zod
  schema, decoder, and domain Zod schema form one chain; do not bypass a layer.
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
2. update both providers and the connection probe;
3. update prompts, wire/domain codecs, telemetry, and tests together;
4. retain readable failure diagnostics;
5. run the live all-profile acceptance evaluation.

## Context and prompting invariants

Context retrieval is deterministic. Do not add embeddings, vector search, an
LLM retrieval loop, or tools without explicit authorization.

The DM context includes:

- campaign rules and scenario;
- authoritative player and current-location state;
- entities at the location, parent locations, inventory-linked and directly
  related entities;
- active-thread entities;
- compact authoritative location directory;
- active/resolved threads and major events;
- exact last committed operations marked as already applied;
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
  mutate `data/current`.
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
  Interfaces, and Future. In-game help groups inspection, recovery, and campaign
  actions. Keep additions in the matching group.
- Browser controls group Play/New campaign under Campaign, provider/world/
  language under Configuration, and self-play under Testing.
- The browser activity log is an inspectable local audit trail, not a public API
  console. Keys remain redacted.
- Browser draft/status/turn/journal responses are player-safe projections. Do
  not expose setup secrets, prepared writes, raw state operations, or alternate
  check stakes through presentation endpoints.
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
- active-save compatibility and pending-turn recovery are preserved or migrated
  explicitly;
- keys and user runtime data remain untouched;
- all local verification commands pass;
- affected live behavior has proportionate evaluation evidence;
- README and this file remain accurate.
