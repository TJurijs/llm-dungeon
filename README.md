# llm-dungeon

**A local, persistent LLM dungeon master for open-ended, narrative-first RPG
campaigns.**

Describe what your character does in plain language. The DM narrates the
consequences, calls visible d100 checks when the outcome is uncertain, and
remembers durable characters, locations, inventory, facts, and story threads
between sessions.

![llm-dungeon campaign showing an exceptional d100 success](docs/images/llm-dungeon-gameplay.jpg)

*The real browser UI with an isolated demo campaign, a checked action, and its
exceptional result.*

Play in a browser or terminal with your own Gemini, OpenRouter, OpenAI,
Anthropic, or DeepSeek API key.

- Keep and switch between multiple independent campaigns.
- Store saves as readable Markdown-first files that are easy to inspect and
  back up.
- Play in English or Russian and choose a model for each campaign.
- Resolve every uncertain action, including combat, with the same transparent
  d100 mechanic.

Each campaign has one forward-only save: there is no undo, rewind, or
resurrection after a terminal ending.

## Requirements

- Node.js 22 or newer
- npm
- A current JavaScript-enabled browser for the browser interface
- Internet access and an API key for at least one supported provider: Google
  Gemini, OpenRouter, OpenAI, Anthropic, or DeepSeek

Provider requests may incur charges. Model tests, campaign previews and
regeneration, gameplay, Ask, and Appeal all make provider requests. Displayed
cost estimates are informational; confirm current pricing and limits with your
provider.

The browser server is for local, single-user use. It has no authentication or
TLS and binds to `127.0.0.1` by default. Do not expose it to the internet or an
untrusted network.

## Install from the repository

The project is distributed primarily as source through its Git repository. It
is not published as an installable npm package.

```bash
git clone https://github.com/TJurijs/llm-dungeon.git
cd llm-dungeon
npm ci
```

Run the commands below from the repository directory.

## Configure provider keys

Create a local environment file:

```bash
cp .env.example .env
```

On PowerShell, use `Copy-Item .env.example .env`.

Add only the keys you use:

```dotenv
GEMINI_API_KEY=
OPENROUTER_API_KEY=
OPENAI_API_KEY=
ANTHROPIC_API_KEY=
DEEPSEEK_API_KEY=
```

For the simplest first run, configure `GEMINI_API_KEY`. Google Gemini is the
recommended provider, and `gemini-3.5-flash` is the recommended, extensively
playtested DM model.

Shell environment variables take precedence over `.env`. The application reads
`.env` at startup, so restart it after changing a key. Never commit, publish, or
share this file.

The browser's **Settings → LLM providers** page also accepts a temporary session
key. It overrides the matching environment key, remains only in server memory,
and is cleared when the server stops.

## Browser interface

Start the browser UI:

```bash
npm run web-cli
```

Open [http://127.0.0.1:4317](http://127.0.0.1:4317). Stop the server with
`Ctrl+C`.

To run the compiled build instead:

```bash
npm run build
npm run start:web-cli
```

### Test and enable a model

Before the browser can use a model:

1. Open **Settings → LLM providers** and expand the provider.
2. Confirm that its key is detected.
3. Select **Test** beside a suggested model. To use another model ID, open the
   provider options and select **Test & add**.
4. Wait for the compatibility test to pass. It makes real provider requests in
   both English and Russian.
5. A passing model is enabled automatically. Use **Enable** or **Disable** to
   change its availability, and **Set default** to use it for new campaigns.

If no valid default exists, the first passing model becomes the default. A model
may require retesting after compatibility requirements change. Passing the test
confirms protocol compatibility, not storytelling quality.

### Create, play, and switch campaigns

1. Select **New campaign**.
2. Enter a premise, character concept, and language.
3. Review the collapsed model and **World and DM style** settings. They are
   prefilled from global defaults but can be changed for this campaign.
4. Select **Generate preview**, then accept, edit, or regenerate it.
5. Enter an action and select **Send**, or press `Ctrl+Enter`/`Cmd+Enter`.

Campaigns appear in the left sidebar. Select another campaign to switch to it;
each keeps its own save, language, world profile, and model. Separate campaigns
may generate concurrently.

The state panel provides player-safe Character, Location, and Story views. The
campaign header can display its starting setup and export a readable Markdown
log.

### Change a campaign's model

For an active campaign, use the model selector beside the composer. Only models
with a configured key that are enabled and passed compatibility testing for the
campaign language are listed.

Changing the global default does not affect existing campaigns. A campaign's
model cannot change while it is archived, finished, busy, or has an unfinished
request; retry or discard the pending request first.

### Archive and delete campaigns

Use **Campaign actions → Archive campaign** and confirm the in-app dialog.
Archiving is irreversible within the application: the campaign becomes
read-only and cannot be resumed, but its transcript, state, setup, and export
remain available.

Permanent deletion is available only for archived campaigns:

1. Expand **Archived** in the sidebar.
2. Select the trash icon beside the campaign.
3. Type the exact campaign title.
4. Select **Delete forever**.

Deletion removes the save and its browser transcript cache and cannot be undone.
Export or back up the campaign first if you may need it later.

### Ask questions and submit appeals

The **Ask** and **Appeal** buttons only prefill the composer. They never send or
change anything until you complete the text and select **Send**.

```text
:ask What does my character know about this symbol?
:appeal The inventory appears to be missing the torch I picked up.
:appeal --turn 4 The result seems inconsistent with the recorded roll.
```

`:ask` returns an out-of-character answer without rolling, advancing a turn,
changing state, or persisting a campaign turn. `:appeal` appends an
administrative review turn. It may correct current state when justified, but
never rewrites a committed turn, rerolls, rewinds, advances fictional time, or
restores a dead or ended campaign.

## Terminal interface

Start the interactive terminal interface with:

```bash
npm run dev
```

Useful commands:

```bash
npm run dev -- play [campaign-id]  # Open or choose a campaign
npm run dev -- new                 # Create another campaign
npm run dev -- campaigns           # List active and archived campaigns
npm run dev -- configure           # Set the terminal provider/model default
npm run dev -- language en         # Default new campaigns to English
npm run dev -- language ru         # Default new campaigns to Russian
```

During play:

```text
:character                       Show character and inventory
:location                        Show the current location
:threads                         Show story threads
:ask <question>                  Ask without advancing a turn
:appeal <explanation>            Submit a general appeal
:appeal --turn N <explanation>   Appeal a specific committed turn
:retry                           Retry an unfinished request
:discard                         Discard an unfinished request
:switch                          Switch to another unarchived campaign
:new                             Create another campaign
:help                            Show command help
:quit                            Exit
```

Terminal configuration accepts a provider/model ID only after that exact model
has passed the current English-and-Russian compatibility test and remains
enabled under browser **Settings → LLM providers**. Test new models in the
browser first. Existing campaigns retain their pinned model. Archival,
permanent deletion, export, and model testing are available through the browser
interface.

After building, start the terminal with `npm start`.

## Campaign data and backups

Campaigns are stored under `data/campaigns/`. To make a restorable backup:

1. Stop the browser server and every terminal game process.
2. Copy the entire `data/` directory to a secure location.
3. Keep it together; do not merge or edit individual save files.

Restore a backup only while the application is stopped. Archived campaigns are
included in `data/`. A Markdown export is readable but is not a restorable save.

Back up `config/` separately if you also want language, world-style, model-test,
and terminal defaults. Treat `.env` as a secret; do not place it in a shared
backup.

## Important limitations

- Saves move forward only; dead, ended, and archived campaigns cannot resume.
- Combat is narrative and uses the same d100 checks as other uncertain actions;
  there are no hit points or initiative system.
- Model availability, output quality, pricing, and uptime depend on third-party
  providers.
- English and Russian are the supported interface and gameplay languages.
- There is no supported public or multi-user API.
- The local browser server is not designed for public hosting.

## Development verification

Run the complete deterministic gate before releasing changes:

```bash
npm test -- --run
npm run typecheck
npm run build
```

## License

Licensed under the [Apache License 2.0](LICENSE).
