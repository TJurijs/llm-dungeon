# llm-dungeon

`llm-dungeon` is a local, persistent LLM dungeon master for free-form fantasy
play. It runs in a terminal or browser, supports Gemini and OpenRouter, and
keeps the campaign in human-readable files.

The current release includes:

- persistent campaigns with crash recovery;
- one shared d100 mechanic for uncertain actions;
- character, location, inventory, and story-thread inspection;
- append-only appeals for reviewing possible DM or state mistakes;
- English and Russian gameplay;
- isolated, cost-limited AI self-play evaluation;
- terminal and browser interfaces over the same campaign.

## Requirements

- Node.js 22 or newer
- npm
- A Gemini or OpenRouter API key

Gemini `gemini-3.5-flash` is the recommended, playtested DM model. OpenRouter
support is available, but results depend on the selected model.

## Install and configure

```bash
npm install
cp .env.example .env
npm run dev -- configure
```

Add the key for the provider you use to `.env`:

```dotenv
GEMINI_API_KEY=your_key_here
OPENROUTER_API_KEY=
```

Keep `.env` local. API keys are not stored in campaign or evaluation files.

## Play in the terminal

Start or resume the active campaign:

```bash
npm run dev
```

Useful commands:

```bash
npm run dev -- play                 # Start or resume
npm run dev -- new                  # Archive the current campaign and start another
npm run dev -- configure            # Change provider or model
npm run dev -- language             # Show the current language
npm run dev -- language ru          # Switch narration to Russian
npm run dev -- world show           # Show the current world and DM style
npm run dev -- world set rules.md   # Use a Markdown profile for future campaigns
npm run dev -- prompts list         # List inspectable prompt phases
npm run dev -- prompts show setup   # Show a safe static prompt preview
```

During play, enter actions as ordinary text. In-game commands are:

```text
:character                       Show character state and inventory
:location                        Show the current location
:threads                         Show story threads
:ask <question>                  Ask the DM without advancing the campaign
:appeal <explanation>            Review a possible mistake
:appeal --turn N <explanation>   Review a specific committed turn
:retry                           Retry an uncommitted action or appeal
:discard                         Discard an uncommitted action or appeal
:new                             Archive this campaign and begin another
:help                            Show help
:quit                            Exit without deleting the campaign
```

There is no undo or rewind. Appeals add a review turn and never rewrite an
already committed turn.

## Use the browser interface

Start the local Web CLI:

```bash
npm run web-cli
```

Open [http://127.0.0.1:4317](http://127.0.0.1:4317).

The browser interface can:

- create, resume, and play campaigns;
- configure and test providers and models;
- select language and edit world/DM style for future campaigns;
- inspect character, location, and story state;
- recover pending actions with `:retry` or `:discard`;
- ask out-of-character questions without advancing a turn;
- submit appeals;
- export the complete player-safe campaign log as a shareable Markdown file;
- show cumulative campaign generation cost beside campaign status;
- run and inspect self-play evaluations.

Campaign cost uses exact billed cost returned by OpenRouter when available.
Gemini and older saved turns are estimated from provider token usage and the
built-in standard-tier price table, so the browser marks those totals with
`≈`. Prompt-inspector previews also list their editable source files relative
to the project root. Campaign exports include the opening, player actions,
checks, narration, summaries, and appeals, but omit secrets, state operations,
provider metadata, and token/cost details.

Leave the browser session-key field blank to use the matching key from `.env`.
Keys entered in the browser stay only in the running server process. Stop the
server with `Ctrl+C`.

To use a different address or port:

```bash
npm run dev -- web-cli --host 127.0.0.1 --port 4317
```

## Build and run production output

```bash
npm run build
npm start
```

For the compiled browser interface:

```bash
npm run start:web-cli
```

## Saves and recovery

The active campaign is stored under `data/current/`. Replaced campaigns are
archived under `data/archive/`. Do not edit or delete these folders while the
game is running.

If a provider call or commit is interrupted, restart the application. It will
recover completed writes when possible and otherwise offer `:retry` or
`:discard`. A rolled check keeps the same recorded roll after restart.

## Self-play evaluation

Evaluations use isolated saves under `evaluations/runs/` and never change the
active campaign. Always set a cost ceiling.

Run a small evaluation:

```bash
npm run dev -- evaluate \
  --sessions 1 \
  --turns 5 \
  --concurrency 1 \
  --max-cost 1 \
  --player-profiles curious-explorer
```

Available player profiles:

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

Resume an interrupted run or rebuild its report:

```bash
npm run dev -- evaluate:resume <run-id>
npm run dev -- evaluate:report <run-id>
```

## Development

Run the complete local check before committing:

```bash
npm test -- --run
npm run typecheck
npm run build
```

Repository invariants and engineering guidance are documented in `AGENTS.md`.
