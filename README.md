# llm-dungeon

`llm-dungeon` is a local, persistent LLM dungeon master for free-form fantasy
play. It supports Google Gemini, OpenRouter, OpenAI, Anthropic, and DeepSeek,
runs in a browser or terminal, and keeps every campaign in readable
Markdown-first files.

Each campaign has one forward-only save. You can keep several campaigns and
switch between them, but there is no rewind or undo.

## Requirements

- Node.js 22 or newer
- npm
- A key for at least one supported provider

Gemini `gemini-3.5-flash` is the recommended, playtested DM model. Other models
must support the application's required structured schemas.

## Install

```bash
npm install
cp .env.example .env
```

Put your provider key in `.env`:

```dotenv
GEMINI_API_KEY=your_key_here
OPENROUTER_API_KEY=
OPENAI_API_KEY=
ANTHROPIC_API_KEY=
DEEPSEEK_API_KEY=
```

Keys are read from `.env` when the application starts and are never saved with
campaigns. Restart the application after changing them. You can also enter a
temporary key under **Settings → LLM providers**; it stays only in server memory
until restart and overrides the matching `.env` key for that session.

## Browser

```bash
npm run web-cli
```

Open [http://127.0.0.1:4317](http://127.0.0.1:4317).

- Use **New campaign** to choose a premise, character, and language. It uses
  the configured default model. World and DM style is prefilled from global
  defaults and can be customized for that campaign.
- Select campaigns in the left sidebar. Different campaigns can generate at
  the same time.
- Change the current campaign's model from the selector beside the chat input.
- Use **Settings → Global defaults** for language and world style, and
  **Settings → LLM providers** for models. Provider settings show which `.env`
  keys are present, accept temporary session keys, show quality ratings and
  rounded 50-turn estimates from OpenRouter rates, and let you test, enable,
  and choose a default model. A model is selectable only after its compatibility
  test passes.
  The five provider cards are built in; use **Model ID → Test & add** at the
  bottom of a card for a model that is not in its suggested list.
- **Ask** answers a question without advancing or saving a turn. **Appeal** adds
  an administrative review turn without rewriting earlier turns.
- Campaign state docks on the right with Character, Location, and Story views.
  Drag either divider to resize the campaign list or state dock.
- Archived campaigns are readable and exportable, but cannot be resumed. Use
  the trash icon beside an archived campaign to delete it permanently.

Stop the server with `Ctrl+C`. To use another address or port:

```bash
npm run dev -- web-cli --host 127.0.0.1 --port 4317
```

## Terminal

```bash
npm run dev                         # Choose, resume, or create a campaign
npm run dev -- play [campaign-id]  # Open a campaign
npm run dev -- campaigns           # List campaigns
npm run dev -- new                 # Create an additional campaign
npm run dev -- configure           # Set provider/model defaults
npm run dev -- language ru         # Set the default for new campaigns
npm run dev -- world show          # Show world and DM-style defaults
npm run dev -- world set rules.md  # Replace defaults from Markdown
npm run dev -- prompts list        # List prompt previews
npm run dev -- prompts show setup  # Render a safe static preview
```

During play:

```text
:character                       Show character and inventory
:location                        Show the current location
:threads                         Show story threads
:ask <question>                  Ask without advancing the campaign
:appeal <explanation>            Review a possible mistake
:appeal --turn N <explanation>   Review a committed turn
:retry                           Retry an uncommitted request
:discard                         Discard an uncommitted request
:switch                          Switch to another resumable campaign
:new                             Create and switch to another campaign
:help                            Show help
:quit                            Exit
```

Prompt inspection and self-play evaluation are developer tools available only
through the terminal.

DeepSeek uses its documented JSON Object mode, receives the complete gameplay
schema and a matching example in its system instruction, and is then validated
against the same strict local wire and domain schemas as every other provider.
Its models become available only after passing the full multilingual setup and
gameplay compatibility probe.

## Saves and recovery

Campaigns are stored under `data/campaigns/`. On first use, older
`data/current/` and `data/archive/` layouts are migrated automatically; old
archives remain read-only. Do not edit these folders while the application is
running.

After an interrupted provider call or commit, restart the application. It will
recover completed writes when possible and otherwise offer retry or discard. A
recorded d100 roll is reused after restart.

## Self-play evaluation

Evaluations use isolated saves under `evaluations/runs/` and never change a
campaign. Always set a cost ceiling.

```bash
npm run dev -- evaluate \
  --sessions 1 \
  --turns 5 \
  --concurrency 1 \
  --max-cost 1 \
  --player-profiles curious-explorer
```

Resume or rebuild a report with:

```bash
npm run dev -- evaluate:resume <run-id>
npm run dev -- evaluate:report <run-id>
```

## Build and development

```bash
npm run build
npm start
npm run start:web-cli
```

Before committing:

```bash
npm test -- --run
npm run typecheck
npm run build
```

Engineering constraints are documented in `AGENTS.md`.
