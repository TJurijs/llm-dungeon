# llm-dungeon

`llm-dungeon` is a persistent, non-agentic fantasy dungeon master for a
human-first terminal, with a lightweight browser terminal companion. Players
begin with a scenario and character, then explore a free-form narrative sandbox.
The LLM improvises fiction while the application owns dice, validation,
persistence, recovery, and transaction safety.

The current application and gameplay contract are V1. The npm package is
version `1.0.0`, is marked private, and exposes no public module API. This is an
experimental local application, not a hosted service; the `api` command is only
a non-operational placeholder for a future machine-facing mode.

## Design principles

- One LLM call for an ordinary turn and two when a d100 check is required.
- No tool use, autonomous loops, multi-agent gameplay, or background actions.
- One active roguelike-style campaign, no rewind, and death is final.
- No separate combat subsystem, hit points, initiative, or tactical rules.
- Human-readable Markdown world state with a small structured mechanical layer.
- Established state always outranks player assertions and model improvisation.
- Complete transactions are validated before any narration is displayed or
  state is committed.
- English and Russian are supported; the language registry is extensible.

## Requirements

- Node.js 22 or newer
- npm
- A Gemini or OpenRouter API key

Ollama is not implemented in the current version. Provider support is isolated
behind `LlmProvider`, so another structured-output-capable provider can be added
later.

Provider/model confidence is intentionally explicit:

- direct Gemini `gemini-3.5-flash` is the fully playtested, recommended DM;
- direct Gemini `gemini-3.1-flash-lite` is the playtested, recommended simulated
  player;
- OpenRouter models are model-dependent and remain experimental until they pass
  the full acceptance matrix. A focused five-turn run of
  `google/gemini-3.5-flash` completed with no DM structured or domain failures
  after applying the Gemini-compatible schema projection, but its simulated
  Flash-Lite player required one successful schema repair.

Every provider/model change must pass the Web CLI connection test. That probe
checks both campaign creation and the exact Gameplay Contract V1 schema.

## Quick start

```bash
npm install
cp .env.example .env
npm run dev -- configure
npm run dev
```

Add only the keys you use to the project-local `.env`:

```dotenv
GEMINI_API_KEY=your_key_here
OPENROUTER_API_KEY=
```

`.env` is ignored and must remain local. Keys are never written to provider
configuration, campaign saves, evaluation artifacts, command history, or API
responses. Key precedence is:

1. key entered for the current browser/server session;
2. shell environment variable;
3. project-local `.env`.

## Terminal

Run the game in development:

```bash
npm run dev
```

Build and run the compiled CLI:

```bash
npm run build
npm start
```

Top-level help groups game actions separately from configuration, evaluation,
interfaces, and reserved future modes:

```text
Game
  llm-dungeon                  Resume the current game or start first-run setup
  llm-dungeon play             Explicit form of the default play command
  llm-dungeon new              Preview, then archive and replace the campaign

Configuration
  llm-dungeon configure        Save provider/model configuration
  llm-dungeon language [code]  Show or set en/ru

Evaluation
  llm-dungeon evaluate         Run bounded isolated self-play
  llm-dungeon evaluate:resume  Resume an interrupted evaluation
  llm-dungeon evaluate:report  Rebuild a saved evaluation report

Interfaces
  llm-dungeon web-cli          Start the browser terminal companion

Future
  llm-dungeon api              Non-operational placeholder; no API contract yet
```

In-game help is grouped by purpose:

```text
Inspect
  :character  Inspect the character
  :inventory  Inspect authoritative inventory
  :location   Inspect the current location
  :threads    Inspect active/resolved situations
  :journal    Show the eight most recent turns

Recovery
  :retry      Retry an uncommitted pending action
  :discard    Discard an uncommitted pending action

Campaign
  :new        Archive the current campaign and begin another
  :help       Show grouped help
  :quit       Leave the terminal without deleting the campaign
```

There is intentionally no undo or rewind command.

## Web CLI

Start the local browser companion:

```bash
npm run web-cli
```

Open [http://127.0.0.1:4317](http://127.0.0.1:4317). The server binds to
`127.0.0.1` by default.

The Web CLI uses the same engine and files as the terminal. Its controls are
grouped into **Campaign** (play and new campaign), **Configuration** (provider,
world rules, and language), and **Testing** (self-play auto-runs). It provides:

- provider/model configuration and connection testing;
- process-local key entry with a redacted activity log;
- optional premise and character guidance with explicit defaults and preview;
- free-text play with visible checks;
- campaign-scoped browser transcript persistence across reloads and browser
  restarts, with player-visible turn-by-turn reconstruction for older sessions;
- tab-scoped terminal channels that keep gameplay, setup, configuration, world,
  and auto-run output separate;
- character, inventory, location, threads, and journal views;
- pending-turn retry/discard controls;
- campaign archival and creation;
- English/Russian selection;
- an editable future-campaign `config/world.md`;
- self-play configuration, live per-session progress, reports, and transcripts;
- a draggable output/control split remembered by the browser.

Mutating browser requests require JSON and same-origin browser metadata. Draft,
status, turn, and journal responses are player-visible projections: DM secrets,
raw state operations, alternate check stakes, and prepared commit contents stay
server-side.

The **activity log** control above the output opens the normally hidden local
audit trail of actions performed through the UI. Keys are always redacted. A
key entered in the UI lives only in the current server process; after restart,
the server falls back to the shell or `.env`.

Production web usage:

```bash
npm run build
npm run start:web-cli
```

## Gameplay and checks

Players may attempt any free-text action, but assertions do not create world
facts. Claiming to use an absent dragon sword does not add one to inventory.
Gibberish and incoherent actions are handled without inventing intent or
punishing the character.

All uncertainty uses one aggregate d100 check:

```text
total = natural roll + sum(circumstantial modifiers)
success = total >= difficulty
natural 1 = automatic severe failure
natural 100 = automatic exceptional success
```

- Difficulty: 5–95
- Individual modifier: −30 to +30
- Combined modifiers: −50 to +50
- Margin 30+: exceptional success
- Margin 0–29: success
- Margin −1 to −29: failure with consequences
- Margin −30 or lower: severe failure

The application rolls with `crypto.randomInt`, locks the outcome and stakes,
then asks the model to narrate that result. Death can only result from an
established lethal situation and must be locked into the failure stakes before
the roll.

## Persistence

The active campaign is stored under `data/current/`; archived campaigns are
stored under timestamped `data/archive/` directories.

```text
data/current/
  manifest.json          Mechanical campaign metadata
  scenario.md            Copied world rules and campaign premise
  threads.md             Active, resolved, and failed situations
  chronicle.md           Compact major-event memory
  entities/*.md          Player, NPCs, locations, items, factions, and others
  turns/*.md             Action, narration, roll, operations, and metadata
  pending-turn.json      Crash-safe uncommitted action or prepared commit
data/.campaign.lock      Transient cross-process campaign mutation lock
data/.replacement-intent.json  Crash-only replacement recovery record
```

Entity files use YAML frontmatter for identifiers and small mechanical fields,
plus stable Markdown sections for facts, secrets, knowledge, beliefs,
intentions, relationships, and history. The application generates filenames
and durable IDs; the model never supplies filesystem paths.

State mutations use a closed `StateOperation` union. The transaction layer:

- validates all references and quantities before writing;
- assigns collision-free IDs to new entities, facts, threads, and events;
- conserves transfers between known owners;
- prevents negative inventory;
- treats carried items as inventory rather than person-valued locations;
- coalesces exact duplicate locations;
- repairs only high-confidence same-transaction reference typos;
- removes idempotent no-op movement;
- rejects an exact repeated abstract inventory credit from the preceding turn;
- writes affected files through a crash-safe, idempotent pending commit;
- serializes campaign mutations across terminal and Web processes;
- stages replacement and records durable recovery intent before archival.

Normalization is deliberately conservative. The engine does not use regex or
free-form prose heuristics to mutate world state.

### Pending turns

An action is saved before the provider request. **Retry pending** resumes that
exact uncommitted action and reuses a previously locked d100 roll. **Discard
pending** removes only the uncommitted action; it never changes an already
committed turn. A prepared filesystem commit cannot be discarded and is
completed idempotently on recovery. Recovery validates the complete write plan
before mutation, requires exactly the target turn log, never rewrites an older
turn, and commits the manifest last.

### Context assembly and compaction

Context retrieval is deterministic and remains deliberately compact. Each DM
request includes authoritative campaign, player, current-location, related
entity, active-thread, directory, chronicle, and last-operation state. It also
includes eight recent turn summaries while retaining full narration only for
the latest turn. Durable facts remain in entity Markdown and are never replaced
by compacted prose; recent narration is working memory, not state authority.

## Structured output and failure handling

Gameplay uses one exact flat **Gameplay Contract V1** schema for Gemini and
OpenRouter. Its unversioned source module is `src/llm/gameplay-protocol.ts`; the
current source does not retain earlier wire-contract implementations.
Provider-side schema enforcement is followed by wire validation, deterministic
decoding into domain operations, complete transaction validation, and atomic
commit.

Gameplay Contract V1 uses bounded integer codes for fictional categories that
could otherwise produce model aliases. Unknown fields, array wrappers, Markdown
fences, partial JSON, invalid codes, and incomplete transactions fail closed.
There is no schema-less fallback. The provider connection test sends both the
real campaign-setup schema and the real gameplay schema, so an incompatible
provider/model is rejected before campaign creation or play.

Failure handling is bounded:

- at most one repair call for malformed or schema-invalid output;
- at most one retry for a transient network/rate-limit failure;
- at most one domain correction for a structurally valid but inapplicable
  transaction;
- no campaign mutation on an exhausted or provider-level failure.

The narration is generated before effects and the summary is generated last.
This causal field order reduces facts appearing in state before they occur in
the player-visible fiction.

## World configuration and language

`config/world.md` defines the default setting, tone, pacing, boundaries, and DM
instructions. It is copied into a campaign when that campaign is created, so
editing it affects future campaigns only.

Show or change language from the terminal:

```bash
npm run dev -- language
npm run dev -- language ru
npm run dev -- language en
```

Language codes and LLM instructions live in `src/language.ts`; browser copy
lives in the `UI_COPY` registry in `web/app.js`. Existing facts and history are
not translated when the active language changes.

## Self-play evaluation

Self-play runs isolated campaigns and never touches `data/current/`:

```bash
npm run dev -- evaluate --sessions 1 --turns 20 --concurrency 3 --max-cost 5
```

Run all nine profiles for five turns:

```bash
npm run dev -- evaluate \
  --sessions 9 \
  --turns 5 \
  --concurrency 3 \
  --max-cost 5 \
  --player-profiles curious-explorer,social-manipulator,cautious-investigator,reckless-adventurer,combat-focused,creative-problem-solver,rule-challenger,long-term-planner,chaotic
```

Defaults are one session, 20 turns, three workers, a $5 ceiling, and
`curious-explorer`. Multiple selected profiles rotate in the given order.
Gemini `gemini-3.1-flash-lite` is the default simulated player unless explicitly
overridden.

Artifacts are written to `evaluations/runs/<run-id>/` and include configuration,
provider-call telemetry, transcripts, normalized operations, state snapshots,
metrics, per-session AI judgments, and a run report. The same provider/model as
the DM judges each technically completed session using turn-by-turn persistence
audits. Run IDs include a UUID and each run holds a filesystem lock, preventing
simultaneous processes from colliding or resuming the same artifacts twice.

A clean quality gate requires:

- a technically completed session;
- no failed structured calls;
- no domain repair calls;
- a completed judge evaluation;
- no high-severity judge issue.

The cost manager reserves estimated cost before parallel calls and reconciles
against returned usage, preventing workers from racing past the run-wide ceiling.

### Verified baseline

The current implementation was last verified with run
`2026-07-14T18-27-34-181Z`:

- 9/9 sessions and 45/45 turns completed;
- all nine clean quality gates passed;
- all nine AI judges scored their sessions 10/10;
- zero structured failures, retries, schema repairs, or domain repairs;
- average check rate 42.2%;
- estimated run cost $2.1268 using Gemini 3.5 Flash as DM and Gemini 3.1
  Flash-Lite as player.

Live model output is stochastic, so this baseline is evidence, not a guarantee.
The local run report is normally ignored by Git.

## Development

```bash
npm test -- --run
npm run typecheck
npm run build
```

Source files are strict TypeScript ESM. Do not edit `dist/` directly; it is
generated by the build after the previous output is cleaned. The commands above
run the complete deterministic Vitest suite, strict type checking, and the
production build; the documentation intentionally does not pin a test count as
regression coverage grows.

Important modules:

```text
src/cli.ts                          Thin terminal entry point
src/cli/                             Command routing, game UI, evaluation UI,
                                     prompts, and project configuration
src/web-server.ts                   Local HTTP controller/server
src/engine.ts                       Presentation-independent game orchestration
src/llm/gameplay-protocol.ts        Gameplay Contract V1 schema and decoder
src/llm/structured-generation.ts   Bounded retry/repair orchestration
src/providers.ts                    Gemini and OpenRouter adapters
src/prompts.ts                      Setup, adjudication, and resolution prompts
src/store.ts                        Campaign persistence and context assembly
src/persistence/files.ts            Atomic file helpers
src/persistence/markdown.ts         Markdown serialization/parsing
src/persistence/pending.ts          Pending action/commit validation
src/persistence/lock.ts             Crash-recoverable cross-process file locks
src/persistence/replacement.ts      Durable campaign replacement intent schema
src/domain/ids.ts                   Canonical-name and durable-ID helpers
src/domain/operation-consistency.ts Operation-list consistency checks
src/domain/state-consistency.ts     Whole-campaign consistency checks
src/domain/transaction.ts           Normalization, validation, and application
src/schemas.ts                      Authoritative Zod domain schemas
src/mechanics.ts                    Sole d100 calculation authority
src/evaluation.ts                   Isolated self-play runner and reporting
src/evaluation/judge.ts             Structured AI judge and persistence audits
web/                                Browser terminal companion assets
tests/                              Deterministic regression tests
```

Engineering and refactoring instructions are in `AGENTS.md`.
