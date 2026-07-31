# Independent review brief: llm-dungeon

You are reviewing this project from scratch. Nobody expects you to defend prior
decisions, including the ones described here. Answer three questions:

1. **What are we actually trying to achieve?**
2. **What is good enough?**
3. **How do we get there?**

You are explicitly invited to reject the framing in this document. The section
"Prior interpretations" contains conclusions reached by the previous assistant
that are **not** established — treat them as hypotheses to test, not findings.
If your answer to (1) is "the stated goal is incoherent" or your answer to (3)
is "revert the last refactor", those are acceptable and expected answers.

---

## 1. What the repo is

A persistent, **non-agentic** LLM dungeon master. TypeScript, Zod, Markdown-first
state, no database. A player submits an action; an LLM narrates it and proposes
durable state changes as a structured transaction; deterministic code validates
that transaction and either commits it or returns it for one bounded correction.
Two languages (`en`, `ru`). CLI plus a local web UI.

The central design bet: **the model writes fiction, the code owns truth.** State
lives in Markdown (`entities/`, `threads.md`, `chronicle.md`, `turns/`), so a
campaign is human-readable and survives without the model.

Scale: ~27.8k lines in `src/` (97 files), ~11.6k in the playtest harness
(`tools/playtest/`), ~26.9k in tests (61 files, 635 tests passing).

Key reading, in order:

| Path | Why |
| --- | --- |
| `AGENTS.md` | Architecture and the hard constraints. Read first. |
| `src/domain/rules/registry.ts` | The 97 deterministic rules that can reject a turn. |
| `src/domain/transaction.ts` | The normalize → admit → apply → verify pipeline. |
| `src/llm/gameplay-protocol.ts` | The wire contract (currently V2) and its decoder. |
| `tools/playtest/harness/runner.ts` | How automated campaigns are executed and scored. |
| `playtests/runs/` | 47 historical runs, each with a `report.md`. Primary evidence. |

---

## 2. Verified facts

Everything here is checkable. Paths and numbers are current as of this brief.

### Architecture

- **97 domain rules** in `src/domain/rules/registry.ts`. Until today every one
  of them declared `disposition: "reject"`. The type also declares `normalize`
  and `signal`; **no code read the field at all** — behaviour was hard-coded at
  each call site. It is now read by `DomainViolationCollector.add`, and exactly
  one rule (`thread_audit_unjustified_unchanged`) is currently `signal`.
- A rejected turn gets **one** bounded LLM correction. If the corrected turn
  also fails, the autoplay run **aborts**.
- The wire protocol was changed from V1 to **V2** earlier today: strict flat
  schema, machine-code tables, mandatory per-turn thread audit addressed by
  1-based ordinal, declared end-of-turn scene, fact provenance.
- Six playtest packages exist (`playtest packages`): certification-v1,
  campaign-autoplay-v1, persistence-soak-v1, adversarial-boundaries-v1,
  mechanics-v1, tuning-v1.

### Measured history — the system used to run long

From `playtests/runs/*/report.md`:

| Date | Turns | Technical | Checks | Domain repairs |
| --- | --- | --- | --- | --- |
| 2026-07-29 | **100/25** | clean | 17 (17.0%) | 0 |
| 2026-07-28 | **100/25** | clean | 0 (0.0%) | 0 |
| 2026-07-30 | 50/50 | playable_with_recovery | 2 (4.0%) | 1 |
| 2026-07-30 | 50/50 | completed_with_failures | — | — |

Two separate **100-turn runs completed technically clean with zero domain
repairs.** This is the single most important fact in this document.

### Measured now — after the V2 refactor

| Run | Turns | Cost | Died on |
| --- | --- | --- | --- |
| 1 | **6/40** | $0.57 | `unknown_location_reference`, twice on turn 7 |
| 2 | **13/40** | $1.40 | `thread_audit_unjustified_unchanged`, twice on turn 14 |

Run 2 detail: 7 domain repairs across 25 candidate calls; thread verdicts
`unchanged=14, progressed=12, closed=0`; checks 1 (7.7%); a scenario contract
(`hidden-actor-evidence-sourced`) fired on **13 of 13 turns**.

Between the runs, two fixes landed: entity IDs stopped carrying an
unpredictable `-turn-N` suffix the model had to transcribe (`src/domain/ids.ts`),
and a reference that misses by exactly that suffix now resolves.

### A measurement artifact, confirmed

The `hidden-actor-evidence-sourced` contract fires because
`fact:npc-mara-venn-turn-0-3` — a fact **written by the scenario seed at turn
0** — has no `basis`. It never had one and never can. Every other fact on that
NPC has a basis. The contract flags seed data on every turn forever.

**Implication worth testing:** other "weaknesses" in the list below may also be
instrument error rather than model behaviour. Note that a clean 100-turn run on
2026-07-28 also recorded **checks 0 (0.0%)**, so a zero check rate is not by
itself evidence of a defect.

---

## 3. Prior interpretations — treat as unverified

These are the previous assistant's conclusions. They may be wrong.

- That the V1→V2 refactor is the proximate cause of the regression from 100-turn
  clean runs to 13-turn deaths. Plausible from timing, **not proven**.
- That the root cause of repeated run deaths is 97/97 rules being blocking, so
  the fix is reclassifying the rule table rather than fixing rules one at a time.
- That an exploratory unjudged run should survive an uncommittable turn instead
  of aborting.
- That making the thread audit mandatory multiplied exact-ID transcriptions and
  that ID transcription is the dominant reference-error surface.

### The original weakness list (the user's starting point)

Given as the motivation for the V2 work. **Validate before accepting.**

1. Thread updates and closure unreliable.
2. Spatial authority diverging from narration.
3. Chronology/evidence overreach in mystery-heavy play.
4. Occasional bounded schema/domain recovery.

---

## 4. Open questions nobody has answered

- A domain violation reached telemetry with its rule code but **without** its
  `detail` token, and a setup-phase rejection fell through to the generic
  `"Local domain validation rejected the structured result"` fallback, losing
  its violations entirely. The mechanism was not found.
- Something marks models `stale` in `config/llm-models.json` mid-run. Never
  root-caused; mitigated by letting a current record self-heal.
- `closed=0`: across 26 thread-audit entries in 13 turns the DM never closed a
  thread. Unknown whether this is structural, prompt-induced, or correct.
- The harness records neither automatic outcomes nor the decision kind, so a
  check rate cannot distinguish "never adjudicated" from "adjudicated as
  certain".

---

## 5. Hard constraints

Non-negotiable; from `AGENTS.md`.

- API keys come only from process memory, env vars, or `.env`. Never print,
  persist, snapshot, or include them in exceptions. Do not read `.env` contents;
  checking that a key is present is enough.
- **Never fabricate compatibility or certification evidence.** If a model is
  untested, the correct state is "untested".
- Paid operations (calibration, certification, autoplay, stress, replay,
  judging) require **explicit authorization and a stated cost ceiling**.
- No fuzzy matching across the established world. Exact resolution only.
- Diagnostic bundles stay secret-safe: hashes and closed-vocabulary tokens,
  never raw model responses.

Budget context: ~$2.03 of an authorized $4 remains. Two runs already failed.
Assume you must justify any spend and that offline analysis against the 47
existing runs is free.

---

## 6. What to produce

Answer the three questions, in this order and with this emphasis:

**(1) What are we trying to achieve?** The project currently optimizes hard for
state integrity — 97 blocking rules, a certification harness, execution-profile
freezing. The stated near-term want is different: *a readable 40-turn transcript
a human can judge for quality.* Determine whether these are the same goal, and
if not, which one the architecture should serve. Say plainly if the goal is
underspecified.

**(2) What is good enough?** There are currently **no written acceptance
criteria.** No target repair rate, no required run length, no definition of a
passing transcript. Every run therefore "fails" and every fix is unbounded.
Propose concrete, measurable thresholds — this is likely the highest-value
artifact you can produce.

**(3) How do we get there?** A sequenced plan. Include explicitly whether to
keep V2, revert to V1, or take a subset. Say what to **stop** doing. Prefer
changes verifiable offline against existing run data over changes that need
another paid run.

Cite file paths and run reports for every claim. Where you disagree with this
brief, say so directly and show the evidence.
