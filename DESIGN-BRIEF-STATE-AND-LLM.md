# Design brief: game schema, deterministic state, and how we use the LLM

You are designing this part of `llm-dungeon` from first principles. This document
is self-contained. It gives you measured evidence, clearly separated from one
prior assistant's interpretation of it, and the commands to re-derive both.

**Read `AGENTS.md` before anything else. Its constraints override this document.**

## Why the separation matters

The previous handover in this repo (`AGENT-TASK.md`) presented a causal story as
established fact. The story was confounded, and following it cost several days
and two failed paid runs. The confound was visible in data already on disk and
nobody had looked.

So: everything under **Measured** below is reproducible and you should spot-check
it. Everything under **Interpretation** is argument, and you are expected to
attack it. If your conclusion is "the prior analysis is wrong", say so and show
the evidence — that is a success, not a problem.

---

## 1. What the system is

A persistent, non-agentic LLM dungeon master. TypeScript, Zod, Markdown-first
state, no database. A player submits an action; the model narrates it and
proposes durable state changes as a structured transaction; deterministic code
validates that transaction and either commits it or returns it for **one**
bounded correction. Two languages (`en`, `ru`). CLI plus a local web UI.

The central bet: **the model writes fiction, the code owns truth.**

Your scope is three things and nothing else:

| Area | Where it lives now |
| --- | --- |
| The game schema — what a durable record is | `src/schemas.ts`, `src/domain/ids.ts` |
| Deterministic state — validation, commit, recovery | `src/domain/`, `src/store.ts`, `src/persistence/` |
| How we ask the model for truth | `src/llm/gameplay-protocol.ts`, `src/prompts/` |

Everything else — UI, provider adapters, catalogs, calibration, the playtest
harness — is outside the engine and outside your scope. `AGENTS.md` has a section
called "The engine boundary" that defines this precisely, and
`tests/engine-boundary.test.ts` enforces it.

---

## 2. Measured

Each item below has a command. Run them.

### 2.1 Ninety of ninety-seven rules have never fired

`src/domain/rules/registry.ts` declares 97 deterministic rules that can reject a
turn. Across 47 historical runs (~1,200 committed turns) on disk, **9 have ever
forced a repair.** Two of those 9 have since been deleted.

```bash
python3 - <<'PY'
import json,os,glob,re,collections
rules=collections.Counter()
for d in sorted(os.listdir('playtests/runs')):
    for cp in glob.glob(os.path.join('playtests/runs',d,'jobs','*','calls','candidate.jsonl')):
        for line in open(cp):
            c=json.loads(line).get('domainRepairCause')
            if c:
                for m in set(re.findall(r'\[([a-z_]{2,64})\]', c['errorMessage'])): rules[m]+=1
for k,v in rules.most_common(): print(f'{k:45s} {v}')
PY
```

Two entries in that output are not rules: `redacted` is a redaction placeholder
token, and the generic `domain_rule` fallback carries no bracketed code so it does
not appear at all. Read the list as eight named rules plus one fallback.

Current dispositions: `grep -o 'disposition: "[a-z]*"' src/domain/rules/registry.ts | sort | uniq -c`
→ 5 `normalize`, 87 `reject`, 5 `signal`.

### 2.2 The failures cluster in one place

Of the 9 rules that ever fired:

- **5 were declaration failures** — `thread_audit_incomplete`,
  `thread_audit_unknown_thread`, `thread_audit_index_out_of_range`,
  `thread_audit_unjustified_unchanged`, `scene_movement_conflict`
- **2 were ID transcription failures** — `unknown_location_reference`,
  `unknown_thread_reference`
- 2 were a setup type error and a generic fallback

The wire contract (V2) asks the model, on every resolved turn, for two
**declarations** in addition to its operations: `threadAudit` (a verdict per
active thread) and `sceneState` (end-of-turn location and present actors). Code
derives operations from those declarations *and* accepts operations directly,
then checks whether the two agree.

The most recent skipped turn, verbatim from `turns.jsonl`:

```
player:hero is moved to generated:wire-create-1 but the declared
end-of-turn scene places them at location-habitat-main-corridors
```

The model created a location, moved the player there by its temporary same-turn
hint, and named the same place by display name in the declaration. Neither
statement was wrong on its own.

### 2.3 Removing the possibility of error worked; detecting it did not

Thread references were changed from IDs the model transcribes to **1-based
ordinals into the context list**. `unknown_thread_reference` went from 8 repairs
to structurally unreachable: the V2 wire schema has no `update_thread` or
`resolve_thread`, so every thread reference is now derived by the application and
carries an authoritative ID.

```bash
grep -n "update_thread\|resolve_thread" src/llm/gameplay-protocol.ts
```

This is the strongest single result in the corpus and the main reason to take
"make it unrepresentable" seriously over "add a check".

### 2.4 The prompt is close to anti-correlated with real failure

15 of 97 rules carry a prompt sentence (~700 tokens per call). **Of those 15,
three have ever fired.** Of the 7 rules that fired, **4 say nothing to the model.**

One of those three was added today because of this finding: guidance for
`unknown_location_reference`, the top live failure, which had been silent. Before
that the ratio was 2 of 14, with 5 of 7 silent. Recompute it rather than trusting
either figure — it moves whenever a rule is touched.

```bash
python3 - <<'PY'
import re
src=open('src/domain/rules/registry.ts').read()
b=dict(re.findall(r'^  ([a-z][a-z0-9_]*): rule\(\{(.*?)^  \}\),', src, re.M|re.S))
print('rules:', len(b), 'with prompt:', sum('prompt:' in v for v in b.values()))
PY
```

### 2.5 The scenario seed is a dominant uncontrolled variable

Three scenario seeds exist. Every autoplay run that died with
`failureOwner=candidate_model` — 12 of them — used `far-meridian-dead-signal`.
`dark-sun-sealed-oasis` (4 runs) and the default seed (3 runs) never died that
way. On 07-30, three runs sharing one source hash split by seed alone.

`far-meridian` is the only seed with a `requirements.json`: 19 mandatory
entities, a 7-node location tree, 8 custody requirements, and two threads
pre-linked to 11 entities including the rooms the player occupies. Its premise is
462 words, roughly 20 of which are imperative directives at the data model rather
than fiction.

**Any comparison across seeds is not a comparison of code.**
`playtest compare` now labels this; it did not before.

### 2.6 Current state of play

Most recent run: 40 turns requested, **39 committed, 1 skipped, no fatal abort**;
largest single rule 2.6% of turns; 1 domain repair total (0.026/turn); 0 invariant
failures; $2.48. The previous 40-turn attempt aborted at turn 13 with 0.538
repairs/turn. Reports now score themselves against written acceptance criteria.

One live signal worth your attention: `thread_audit_unjustified_unchanged` fired
as review-only on **13 of 39 turns (33%)**. It blocks nothing, so it costs
nothing — but at a third of turns it carries no information either.

---

## 3. Interpretation — argue with this

These are the prior assistant's conclusions. They are reasoning, not data.

1. **The root cause is duplicate representation.** Asking the model for the same
   fact twice, in two forms, then checking agreement, creates a failure class
   that cannot exist with one representation. 5 of 9 firing rules are this.

2. **Any identifier the model must transcribe is a defect surface.** Ordinals
   proved the alternative works. Extending handles to entities, items, locations
   and facts would make the entire 15-rule references section unrepresentable
   rather than detected.

3. **The unit of failure should be the operation, not the turn.** One bad
   reference currently discards a whole turn (~20 s, ~$0.06) including good
   narration. Committing the narration and the valid operations, and surfacing
   the dropped one to the next turn, would be cheaper.
   *This conflicts with a hard-won invariant — "never partially apply a model
   response". Treat it as the most questionable item here.*

4. **Blocking must be earned and should expire.** A check should have to state
   what breaks if it commits; only "a later turn cannot read this state" earns a
   block. A rule that has not fired in N runs should be demoted automatically.

5. **Prompt sentences should be earned by observed failure**, not author
   intuition.

6. **The architecture was not the problem.** The 20× repair reduction came from
   deleting two rules and demoting four — not from redesign. The absence of a
   checkpoint and a comparable metric was the actual failure. A rewrite is
   probably worth less than measurement discipline. **Weigh this against your own
   conclusions before recommending a rewrite.**

---

## 4. The three questions to answer

**Q1 — Game schema.** What are the durable record types, and is the schema shaped
so invalid states are hard to express rather than merely detected? Today 97 rules
police it. If the right answer is a different record model, say so.

**Q2 — Deterministic state.** What must block a commit, what should be rewritten
deterministically, and what should only be observed? What is the right unit of
failure? What are the atomicity and crash-recovery guarantees, and which of
today's are load-bearing versus incidental?

**Q3 — LLM interface.** What exactly do we ask the model for, in what form, and
how is a reference expressed? Settle the declaration-versus-operations question:
one channel, and which one. Note the tradeoff — end-state description risks
silently dropping unmentioned records; operations require the model to track
identity.

---

## 5. Constraints

Non-negotiable, from `AGENTS.md`:

- API keys come only from process memory, env vars, or `.env`. Never print,
  persist, or snapshot them. Do not read `.env` contents; presence is enough.
- Never fabricate compatibility or certification evidence. Untested means
  untested.
- No fuzzy matching across established world state. Exact resolution only.
- Diagnostic bundles stay secret-safe: hashes and closed-vocabulary tokens, never
  raw model responses. **You therefore cannot recover what a model actually
  emitted on a failed turn.** Design diagnostics accordingly.
- Gameplay stays non-agentic: no tools, no autonomous loops, no multi-agent play.

Requires the user's explicit sign-off — do not do these unilaterally:

- **Changing Markdown-first state.** Human-readable campaign state that survives
  without the model is the project's central bet. One campaign's save format is
  not separable from the engine; multi-campaign management already is.
- **Deleting anything under `playtests/runs/`.** Those 47 runs are the only
  regression baseline that exists.
- **Any paid run.** Requires explicit authorization and a stated cost ceiling.
  Offline analysis against the existing runs is free and is where you should
  spend your effort.

---

## 6. What done looks like

A design document, not a rewrite. Specifically:

1. Answers to Q1–Q3 with a concrete decision on each, and the evidence for it.
2. For each decision, which failure class it eliminates and how you would know
   it worked — ideally as a comparison against a named existing run.
3. A migration assessment: what is portable to the current code cheaply, what
   needs a rewrite, and what is not worth doing. Be explicit about what you would
   **not** change.
4. Anything you can verify offline against the 47 runs, verified rather than
   asserted.

If you write code, prefer a throwaway prototype that tests one hypothesis
against existing run data over edits to the live engine.

## 7. How not to repeat the last failure

- **Commit a checkpoint before any structural change.** The last session had 110
  uncommitted files and no way back. That, more than any bug, is what cost days.
- **State the hypothesis in one sentence, and how you will know it worked, before
  you start.** "V2's mandatory audit causes most repairs; removing it should drop
  the top rule's share of turns below 20%" is a hypothesis. "V2 is messy" is not.
- **One structural change at a time.** Two at once and neither is attributable.
- **Rank rules by share of turns, not repair count.** A rule firing once in 25
  turns is the recovery path working. A rule firing every turn is the defect.
- **Do not fix a rule because a run died on it.** The prior session moved a death
  from turn 7 to turn 14 that way, one paid run at a time.
- Verify a new test fails before your fix and passes after. Several tests written
  during the last session were vacuous until checked this way.
- The full gate is `npm test -- --run`, `npm run typecheck`, `npm run lint`,
  `npm run build`.
