# Work order: restore long-run playability, then make improvement measurable

You are picking up `llm-dungeon` mid-recovery. This document is self-contained.
Read `AGENTS.md` before touching code — its constraints override anything here.

---

## The goal, in one sentence

Get back to a system that **completes long runs with acceptable drawbacks**, then
make it possible to **improve it by analyzing long runs without regressing**.

Not: a system that never needs a repair. Repairs are the designed recovery path.

The task list below is the smallest path there, not a fence. You may rewrite core
logic — including reverting the V2 protocol — where the evidence supports it. See
**Latitude** before assuming any of this is fixed in place.

---

## What happened (context you need)

A persistent, non-agentic LLM dungeon master. The model narrates and proposes a
structured state transaction; deterministic code validates it and either commits
it or returns it for **one** bounded LLM correction. If the corrected turn also
fails, the autoplay run **aborts**.

The system demonstrably worked. From `playtests/runs/*/report.md`:

| Date | Turns | Technical | Domain repairs |
| --- | --- | --- | --- |
| 2026-07-28 | **100/25** | clean | 0 |
| 2026-07-29 | **100/25** | clean | 0 |
| 2026-07-30 | 50/50 | playable_with_recovery | 1 |

Then a **mandatory per-turn thread audit** was added. Run `2026-07-30T20-28` is
the first one after it:

```
thread_audit_incomplete      15 repairs / 15 turns
thread_audit_unknown_thread   4
unknown_thread_reference      2
```

Zero to one repair per turn, in one change. Recovery work since has moved the
failure later but not fixed it:

| Run | Turns | Died on |
| --- | --- | --- |
| 2026-07-31T08-28 | 6/40 | `unknown_location_reference`, twice on turn 7 |
| 2026-07-31T09-02 | 13/40 | `thread_audit_unjustified_unchanged`, twice on turn 14 |

**Why it went unnoticed for days:** `HEAD` is `2026-07-26`. The clean 100-turn
runs are from 07-28 and 07-29. There are **110 uncommitted files, +13,579 /
−1,540, plus 30 untracked**. The known-good state was never committed, so there
is no checkpoint, no bisect, and no run-to-run comparison. Every run was judged
in isolation.

### Already landed (do not redo)

- Entity IDs no longer carry an unpredictable `-turn-N` suffix (`src/domain/ids.ts`).
  Facts, threads and chronicle events still do, deliberately — a superseded fact
  can free its slug, and nothing transcribes those from memory.
- A reference that misses by exactly that application-added suffix now resolves
  when exactly one candidate matches (`src/domain/transaction-normalization.ts`).
- The **disposition ladder is live**. `DomainViolationCollector.add` now reads
  `DOMAIN_RULES[code].disposition`. Before today all 97 rules said `"reject"` and
  *nothing read the field*. Exactly one rule is currently `"signal"`.
- Review-only signals flow `applyTransaction` → `CommitTurnResult` → `TurnResult`
  → harness turn record → a "Domain judgment signals" line in the report.

State: **635 tests, lint, and build all pass.**

---

## Acceptance criteria — what "good enough" means

A repaired turn is **fine**. Judge rules, not incidents.

| Criterion | Bar | Hard? |
| --- | --- | --- |
| Run completion | 40/40 turns, zero fatal aborts | **yes** |
| Any single rule's share of turns | < 20% | **yes** |
| Invariant failures | 0 | **yes** |
| Aggregate domain repairs | ≤ 0.3/turn (cost signal, not a gate) | no |
| Check rate | **not a criterion** | — |
| Thread closure rate | measure and report only | — |

Two notes that matter:

- **Check rate is not a defect signal.** One clean 100-turn run scored 17.0%,
  another scored 0.0%. Do not tune against it.
- **The ranked "Domain-repair causes" table in each report is your instrument.**
  Its own header says it: a rule near the top is a candidate for normalization, a
  clearer contract, or removal as a false invariant. A rule firing once in 25
  calls is noise. A rule firing every turn is the defect.

---

## Tasks, in order

### 1. Commit a checkpoint — do this first

Ask the user for approval, then commit the current working tree on a branch. It
is green, so it is a legitimate baseline even mid-recovery. Nothing below is safe
without it: there is currently no way back from a bad change.

**Done when:** a commit exists that `npm test`, `npx tsc --noEmit`, `npx eslint .`
and `npm run build` all pass against.

### 2. Build run-to-run regression comparison

A `playtest compare` command already exists — check what it does before writing
anything new. Extend or replace it so it scores a run against the table above and
diffs it against a named previous run.

It must surface, per rule: **share of turns the rule fired**, and whether that
share moved since the baseline run. That single number is what would have caught
the 07-30 spiral on the first run instead of the fifth day.

**Done when:** comparing `2026-07-30T13-28` (clean) against `2026-07-30T20-28`
(the spiral) reports `thread_audit_incomplete` going 0% → 100% of turns. Use the
47 runs already on disk; this needs no API spend.

### 3. Reclassify the 97-rule table

`src/domain/rules/registry.ts`. One pass, one criterion:

> **Does committing this transaction leave state that a later turn cannot
> correctly read?**
>
> - **Yes** → `reject`. Real integrity faults: unresolvable references, ID
>   collisions, containment cycles, inventory arithmetic, temporal ordering.
> - **No, and deterministic code can produce the intended state** → `normalize`.
>   Candidates: `set_entity_state_empty`, `transfer_same_owner`,
>   `relationship_duplicate`, `durable_text_limit`,
>   `locked_resolution_summary_length`, `reserved_mutable_state_tag`,
>   `non_machine_tag`, `repeated_abstract_inventory_credit`.
> - **No, and it is a judgment about DM quality** → `signal`. Candidates:
>   `thread_successor_required`, `fact_source_required`,
>   `location_name_duplicate`, and the already-converted
>   `thread_audit_unjustified_unchanged`.

Rough expected split: ~60 reject, ~18 normalize, ~9 signal. Do not treat those
numbers as targets — apply the criterion and report what it gives.

`normalize` has **no plumbing yet** — only `reject` and `signal` are implemented.
Either implement it or leave those rules as `reject` and say so plainly. Do not
mark a rule `normalize` that nothing normalizes.

**Done when:** every rule's disposition follows from the criterion, tests pass,
and `tests/domain-rules.test.ts` still proves the declared disposition decides
blocking.

### 4. Make an uncommittable turn non-fatal for exploratory runs

For an unjudged autoplay run whose product is a transcript, a turn that fails its
bounded correction should be **recorded and skipped**, not fatal. Certification
and stress packages must keep aborting — do not weaken those.

**Done when:** a 40-turn autoplay with a deliberately failing turn still produces
a 39-turn transcript and reports the skipped turn.

### 5. Investigate, then decide, on these open items

Cheap, offline, and each may be instrument error rather than model behaviour.

- **`hidden-actor-evidence-sourced` fires on 13/13 turns.** Confirmed cause:
  `fact:npc-mara-venn-turn-0-3` is written by the scenario seed at turn 0 and has
  no `basis`, so the contract flags seed data forever. Every other fact on that
  NPC has one. Fix the predicate or the seed.
- **`closed=0`.** Across 26 thread-audit entries in 13 turns the DM never closed
  a thread. Determine whether closure is structurally blocked, prompt-discouraged,
  or correct for that fiction. Measure before changing anything.
- **Lost telemetry detail.** A violation reached telemetry with its rule code but
  without its `detail` token, and a setup-phase rejection fell through to the
  generic `"Local domain validation rejected the structured result"` fallback,
  losing its violations entirely. Reproduce it; the mechanism was never found.
- **`thread_audit_unjustified_unchanged` predicate is over-broad.** In
  `src/domain/transaction-admission.ts`, `changedSubjects` collects *every*
  reference in *every* operation, so a thread linked to the player trips on
  almost any turn. Narrow it to records an operation actually mutates.
- **Phantom `stale` marking.** Something marks models `stale` in
  `config/llm-models.json` mid-run. Never root-caused, only mitigated by letting
  a current record self-heal.

### 6. One paid 40-turn run

Only after 1–4. Get an explicit cost ceiling from the user first.

```
npx tsx tools/playtest/playtest-cli.ts playtest run campaign-autoplay-v1 \
  --candidate gemini:gemini-3.6-flash@direct \
  --languages en --turns 40 \
  --scenario-seed far-meridian-dead-signal \
  --max-cost <approved> --max-duration-minutes 75
```

Score it against the acceptance table and against the previous run using task 2.
Observed cost is roughly $0.09–0.11/turn and rises with context, so 40 turns is
about $4–5.

---

## Latitude: you may rewrite core logic

The task list above describes the smallest path back to a working system. It is
**not** a fence. If the evidence says a subsystem is wrong rather than buggy,
rewrite it. Incremental patching is what produced the current state.

### Explicitly open

- **The V2 wire protocol.** Reverting to V1, or keeping a subset, is a live
  option and arguably the leading one — V1 ran 100 turns clean and V2 has not
  passed 13. `src/llm/gameplay-protocol.ts`, `src/schemas.ts`.
- **The mandatory per-turn thread audit.** This is the change that started the
  spiral. Making it optional, sampled, derived from operations instead of
  declared, or removing it outright are all on the table.
- **The rule registry and the disposition ladder.** 97 rules is a lot of surface.
  If the right answer is 30 rules, or a different taxonomy entirely, do that.
- **The transaction pipeline.** `normalize → admit → apply → verify` is one
  design, not a requirement.
- **The playtest harness.** Scoring, packages, technical-status labels, the
  one-bounded-correction budget — all changeable.
- **The bounded-correction model itself.** One retry per turn is a guess. Two
  cheap retries, or a deterministic fallback that commits a reduced transaction,
  may both beat it.

### Requires the user's explicit sign-off first

- **Markdown-first state.** Human-readable campaign state that survives without
  the model is the project's central bet, not an implementation detail. You may
  argue against it; do not change it unilaterally.
- **Deleting the 47 runs in `playtests/runs/`.** They are the only regression
  baseline that exists.

### The discipline that makes a rewrite safe

A rewrite is not riskier than a patch — an *unmeasured* change is. Before any
structural change:

1. **Checkpoint first.** Task 1 is not optional before a rewrite.
2. **State the hypothesis in one sentence**, and which acceptance criterion it
   moves. "V2's mandatory audit causes most repairs; removing it should drop the
   top rule's share of turns below 20%" is a hypothesis. "V2 is messy" is not.
3. **Say how you will know it worked** *before* you start — ideally as a
   comparison against a named existing run using task 2.
4. **One structural change at a time.** Two at once and neither is attributable.

### The rule of three

If you find yourself making a third fix in the same area, stop patching and
redesign that area. The last session made three separate fixes to thread-audit
handling and the run still died on thread-audit handling.

---

## Hard constraints

From `AGENTS.md`. Non-negotiable, and not covered by the latitude above.

- API keys come only from process memory, env vars, or `.env`. Never print,
  persist, snapshot, or include them in exceptions. Do not read `.env` contents.
- **Never fabricate compatibility or certification evidence.** If a model is
  untested, the correct state is "untested".
- Paid operations require **explicit authorization and a stated cost ceiling**.
- No fuzzy matching across the established world. Exact resolution only. The
  suffix-variant resolution in task "already landed" is the inverse of a
  transformation the application itself performed, uniqueness-guarded — not a
  similarity match. Do not generalize it into one.
- Diagnostic bundles stay secret-safe: hashes and closed-vocabulary tokens, never
  raw model responses. This means you **cannot** recover what a model actually
  emitted on a failed turn. Design diagnostics accordingly.

---

## What not to do

The last session lost a day to this: fix one rule, run, hit the next rule, fix
it, run. Each fix moved the death from turn 7 to turn 14 and cost real money.

Do not fix a rule because a run died on it. Fix a rule because the ranked-cause
table shows it firing on a large share of turns. **One-off repairs are the system
working, not failing.**

Before adding any new blocking rule, state which acceptance criterion it protects.
If it protects none, it is a `signal`.
