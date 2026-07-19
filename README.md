# llm-dungeon

**A local web app for persistent, narrative-first RPG campaigns with an LLM
as your dungeon master.**

Describe what your character does in plain language. The DM narrates the
consequences, calls visible d100 checks when an outcome is uncertain, and keeps
track of durable characters, locations, inventory, facts, and story threads
between sessions.

![An llm-dungeon campaign showing an exceptional d100 success](docs/images/llm-dungeon-gameplay.jpg)

The app supports multiple independent campaigns, English and Russian gameplay,
and a curated choice of models from Google Gemini, OpenRouter, xAI, OpenAI, and
DeepSeek. 

## Start playing

You need [Node.js 22 or newer](https://nodejs.org/), npm, and an API key from at
least one supported LLM provider.

### 1. Download and install

```bash
git clone https://github.com/TJurijs/llm-dungeon.git
cd llm-dungeon
npm ci
```

### 2. Start the web app

```bash
npm run web
```

Open [http://127.0.0.1:4317](http://127.0.0.1:4317) in your browser. Keep the
command running while you play. Press `Ctrl+C` when you want to stop the app.

### 3. Connect an LLM provider

On a clean installation, the welcome screen explains that a provider is needed
and offers a button that opens **Settings → LLM providers**.

For the easiest start:

1. Open **Google Gemini**.
2. Open its **•••** menu and enter a Gemini API key.
3. Return to the welcome screen.

The key entered in Settings is temporary: it stays only in server memory and is
cleared when the app stops. For persistent configuration, see
[Keep your API key between restarts](#keep-your-api-key-between-restarts).

`gemini-3.5-flash` is enabled and selected as the default model from the first
launch. It remains the recommended starting choice.

### 4. Create your first campaign

1. Select **New campaign**.
2. Enter a premise, a character concept, and your gameplay language.
3. Optionally expand **Model** or **World and DM style** to customize them.
4. Select **Generate preview**.
5. Accept, edit, or regenerate the preview.
6. Type what your character does and select **Send**. You can also use
   `Ctrl+Enter` or `Cmd+Enter`.

That is all you need to begin playing. The campaign appears in the left sidebar
and resumes from the same state the next time you start the app.

## Keep your API key between restarts

Copy the included environment template to `.env` in the project folder:

```bash
cp .env.example .env
```

On PowerShell:

```powershell
Copy-Item .env.example .env
```

Add only the key or keys you use:

```dotenv
GEMINI_API_KEY=
OPENROUTER_API_KEY=
XAI_API_KEY=
OPENAI_API_KEY=
ANTHROPIC_API_KEY=
DEEPSEEK_API_KEY=
```

The supported providers are:

| Provider | Environment variable |
| --- | --- |
| Google Gemini | `GEMINI_API_KEY` |
| OpenRouter | `OPENROUTER_API_KEY` |
| xAI | `XAI_API_KEY` |
| OpenAI | `OPENAI_API_KEY` |
| Anthropic | `ANTHROPIC_API_KEY` |
| DeepSeek | `DEEPSEEK_API_KEY` |

Restart the web app after changing `.env`. A temporary session key overrides
the matching environment key until the app stops. Never commit, publish, or
share your `.env` file.

Provider requests may incur charges. Gameplay, campaign previews and
regeneration, Ask, Appeal, and custom-model tests can all make provider
requests. Prices shown by the app are estimates; confirm current pricing and
limits with the provider.

## How campaigns work

Each campaign has its own premise, character, language, world style, model, and
forward-only roguelike style save. Select campaigns in the sidebar to switch between them.
Several campaigns can coexist without sharing story state.

The LLM improvises the fiction, while the application owns dice, validation,
state changes, persistence, and crash recovery. Every uncertain action uses the
same visible d100 mechanic, including combat; there are no separate hit points
or initiative rules.

The state panel provides three player-safe views:

- **Character**, including inventory
- **Location**
- **Story threads**

The campaign header also lets you inspect the starting setup and export a
readable Markdown transcript.

### Ask without taking a turn

Select **Ask** to prefill an out-of-character question:

```text
:ask What does my character know about this symbol?
```

Ask does not roll dice, advance time, change state, consume a turn, or persist
an answer into the campaign history. The button only prefills the composer; it
does not send anything until you select **Send**.

### Appeal a result

Select **Appeal** to request an administrative review:

```text
:appeal The inventory appears to be missing the torch I picked up.
:appeal Turn 4 The result seems inconsistent with the recorded roll.
```

An appeal may correct current state when the durable evidence supports it. It
never rewrites a committed turn, rerolls, rewinds the story, advances fictional
time, or resurrects a finished character. Like Ask, the button only prefills
the composer.

### Change a campaign's model

Use the model selector beside the composer. It lists only models that have a
configured key, are enabled, and are compatible with the campaign's language.
Changing the global default in Settings affects new campaigns only.

A model cannot change while a campaign is archived, finished, generating, or
has an unfinished request. Retry or discard the pending request first.

### Archive or delete a campaign

Use **Campaign actions → Archive campaign** and confirm the in-app dialog. An
archived campaign is permanently read-only, but its transcript, state, setup,
and export remain available.

Permanent deletion is available only for archived campaigns:

1. Expand **Archived** in the sidebar.
2. Select the trash icon beside the campaign.
3. Type the exact campaign title.
4. Select **Delete forever**.

Deletion cannot be undone. Export or back up the campaign first if you may want
it later.

## Models, calibration, and certification

The public curated lineup is intentionally small:

| Provider | Curated models |
| --- | --- |
| Google Gemini (recommended) | `gemini-3.5-flash` (recommended/default), `gemini-3.1-flash-lite` |
| OpenRouter | `qwen/qwen3.7-plus` |
| xAI | `grok-4.5` |
| OpenAI | `gpt-5.6-terra` |
| DeepSeek | `deepseek-v4-flash`, `deepseek-v4-pro` |

In **Settings → LLM providers**, you can enable or disable available models and
choose the default used by new campaigns. The model cards show only current
certification quality; superseded quality labels are not displayed.

To try another model ID, expand a public provider and select **Add**. Adding a
custom model does not contact the provider. Its row includes a **Test** button
that checks the real setup and gameplay schemas independently in English and
Russian. Passing one language is enough to use the custom model for that
language. Custom models can be removed unless they are referenced by a default,
campaign, or campaign draft.

A compatibility test answers only whether a route can follow the strict setup
and Gameplay Contract schemas for a language. It does not calibrate provider
parameters, certify gameplay, establish narrative quality, or make a model
recommendable.

The model assessment system keeps these results separate:

- **Adapter status:** `uncalibrated`, `calibrated`,
  `calibration_inconclusive`, or `no_compatible_profile`.
- **Technical gameplay status:** `clean`, `playable_with_recovery`, `unstable`,
  `unsupported`, or `inconclusive`.
- **Language-specific quality:** `high`, `medium`, `low`, `unrated`, or
  `awaiting_judgment`.
- **Recommendation eligibility:** derived independently from current evidence;
  it is never equivalent to passing a schema test.

Calibration is a non-scored adapter exercise. It finds a strict,
provider-supported `ModelExecutionProfile` for one provider, model, and route,
including schema mode/projection, temperature, reasoning, token field,
phase-specific budgets, and timeouts. Direct and OpenRouter routes are distinct.
Variants run sequentially and change one variable at a time; budget escalation
requires confirmed truncation. Every attempt is retained, and the chosen
profile is frozen by fingerprint before certification. Changing that profile
invalidates its certification.

## Developer playtests

Calibration, certification, autoplay, stress testing, tuning, judging, and
prompt inspection are terminal/developer tools; they are not browser gameplay
features. One versioned playtest engine owns all six initial packages:

| Package | Purpose |
| --- | --- |
| `certification-v1` | One passable canonical ten-turn gauge of core gameplay behavior with deterministic rolls and no AI player; valid terminal outcomes remain complete fixtures, while later coverage may continue in a fresh isolated fixture. This is the only package allowed to update authoritative certification metadata. |
| `campaign-autoplay-v1` | Resumable 25–200 turn generated campaigns with a fixed player model/profile, seeded rolls, checkpoints, and final judgment. |
| `persistence-soak-v1` | Long-horizon revisitation of early facts, items, promises, NPCs, and places after context compaction. |
| `adversarial-boundaries-v1` | Unsupported possessions and abilities, contradictory or incoherent claims, secret-extraction attempts, and bundled actions. |
| `mechanics-v1` | Combat, social opposition, investigation, check calibration, action economy, and proportional consequences. |
| `tuning-v1` | Controlled comparison of one declared variable with the same state, actions, rolls, package, and judge. |

Invoke the command family through `npm run dev --`, for example
`npm run dev -- playtest packages`:

```text
playtest packages
playtest calibrate [--target <provider:model@route>] [--input-cost <usd-per-million> --output-cost <usd-per-million>] --max-cost <usd>
playtest probe [--target <provider:model@route>] [--languages <codes>] --max-cost <usd>
playtest replay <diagnostic-bundle> [--variant <profile.json>] --max-cost <usd>
playtest run <package> [--candidate <provider:model@route>] [--judge <provider:model@route>] --max-cost <usd>
playtest certify [--candidate <provider:model@route>] [--judge <provider:model@route>] --max-cost <usd>
playtest matrix <package> --candidate <provider:model@route> --candidate <provider:model@route> [--judge <provider:model@route>] --max-cost <usd>
playtest resume <run-id>
playtest judge <run-id>
playtest report <run-id>
playtest compare <run-id> <run-id>
```

Candidate, player-driver, and judge targets must each have a current frozen
execution profile. Judged packages use a separate Gemini 3.5 Flash call by
default; `--judge` overrides that fixed target for a run. The judge may be the
same underlying model as the candidate because it receives a new blinded,
non-mutating request after gameplay completes. Generated and hybrid packages additionally require
`--player <provider:model@route>` and may select one of the nine behavior inputs
with `--player-profile <profile>`. The `<usd>` values above are mandatory hard
ceilings, not suggested budgets; choose them only after reviewing the intended
package and provider pricing. These commands can make paid calls and should not
be run merely as part of local verification.

Use repeatable `--model-price <provider:model@route=input-usd-per-million,output-usd-per-million>` overrides
for unpriced custom candidate, player, or judge models. Tuning runs declare
exactly one `model:`, `adapter:`, or `prompt:` variable with
`--tuning-variable <kind:description>`; comparison rejects mismatched package,
seed, language, player, judge, limits, concurrency, or unrelated target/source
controls. A current calibrated execution profile is also reused for ordinary
terminal and browser gameplay with that model and route.

The former `evaluate`, `evaluate:resume`, and `evaluate:report` spellings are
deprecated aliases into this playtest engine; they do not run a second legacy
evaluation framework.

Autoplay remains an external harness that submits one ordinary player action at
a time. It does not give the dungeon master tools or autonomous background
actions. Optional concurrency applies only across independent jobs and
campaigns: a global worker limit, provider-specific pools, a shared reserved
cost budget, and per-campaign serialization prevent turns in one campaign from
overlapping. Runs support cancellation and artifact-driven resume.

Failures are attributed separately to `candidate_model`,
`adapter_configuration`, `provider_route`, `account_access`, `judge`,
`player_driver`, `application`, or `inconclusive`, with separate telemetry
lanes. Candidate technical metrics are frozen before the separate judge call
runs. Judge configuration stays fixed across a comparison
batch and should be blind to candidate identity where possible. Non-candidate
failures, latency, repairs, and cost cannot lower the candidate's technical
status, though infrastructure failures may make a run inconclusive. Judging is
rerunnable without replaying gameplay; failed judging leaves quality at
`awaiting_judgment`.

Reports distinguish scheduler queue time, provider-call duration, retry/backoff
time, and player-visible turn duration. Canonical speed uses concurrency 1;
parallel runs are marked as loaded latency. A failed call may create a
secret-safe diagnostic bundle for bounded, non-committing focused replay.
`playtest replay` keeps its own locked manifest, hard cost ceiling, scheduler,
and resumable evidence without opening a campaign store. A
successful replay variant still requires a fresh frozen profile and a complete
`certification-v1` run.

Existing campaigns and historical evaluation artifacts are preserved but are
not presented as current technical or quality certification. Do not run paid live calibration, certification,
autoplay, stress, replay, or judging without explicit authorization and an
agreed cost ceiling.

## Saves and backups

Campaign data is stored under `data/campaigns/`. To make a restorable backup:

1. Stop the web app.
2. Copy the entire `data/` directory to a secure location.
3. Keep the directory together; do not merge or edit individual save files.

Restore a backup only while the app is stopped. Archived campaigns are included
in `data/`. A Markdown export is readable, but it is not a restorable save.

Back up `config/` separately if you also want global language, world-style,
model compatibility, and default-model settings. Treat `.env` as a secret and
do not place it in a shared backup.

## Build and update

To run a compiled production build locally:

```bash
npm run build
npm run start:web
```

To update an existing checkout:

```bash
git pull
npm ci
npm run web
```

Back up `data/` before updating if the campaigns are important to you.

## Privacy and limitations

- The app and campaign files run locally, but prompts are sent to the LLM
  provider you configure.
- The local server has no authentication or TLS and binds to `127.0.0.1` by
  default. Do not expose it to the internet or an untrusted network.
- Saves move forward only. Dead, ended, and archived campaigns cannot resume.
- Model quality, pricing, limits, and uptime depend on third-party providers.
- English and Russian are the currently supported interface and gameplay
  languages.
- There is no supported public or multi-user API.

## Development verification

Before releasing a code change, run:

```bash
npm test -- --run
npm run typecheck
npm run build
```

## License

Licensed under the [Apache License 2.0](LICENSE).
