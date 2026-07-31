# Design: game schema, deterministic state, and the LLM interface

Answer to `DESIGN-BRIEF-STATE-AND-LLM.md`. This is a design document with a
migration assessment. No engine code was changed. Every number below is derived
from artifacts already on disk; the scripts are inlined so each claim can be
re-derived.

Read order: §1 corrects three "Measured" claims. §2 attacks the interpretation.
§3–§5 answer Q1–Q3. §6 is the migration assessment. §7 is what I would not
change. §8 is how you would know any of it worked.

---

## 0. Hypotheses, and how each was to be falsified

Stated before the corresponding analysis, with the offline verdict. H1, H2 and H6
were predictions; H3–H5 were formed while reading the corpus and are marked
exploratory, because presenting an exploratory finding as a pre-registered one is
the exact failure this brief exists to prevent.

| # | Hypothesis | Falsification test | Verdict |
| --- | --- | --- | --- |
| H1 | The 47-run corpus is not one population, so aggregate rule counts have no valid denominator. | Group runs by `codeVersion.sourceHash`. If most turns share a code version, H1 fails. | **Confirmed.** 36 source hashes, 47 of 49 runs on dirty trees, largest reproducible sample 55 turns. |
| H2 | "90 of 97 rules never fired" is unfalsifiable at this sample size, not evidence the rules are useless. | Compute the smallest per-turn hazard detectable at 95% confidence for the real exposure. If it is under ~1%, H2 fails. | **Confirmed.** On the only reproducible corpus (55 turns) an unfired rule could still fire on 5.3% of turns. |
| H3 | *(exploratory)* The threadAudit channel has produced no thread closures at all. | Count `closed` verdicts and `resolve_thread` operations in the V2 era. Any closures falsify it. | **Confirmed.** 0 closures in 120 V2 turns; `threadTransitions: []` in the 39-turn run. |
| H4 | *(exploratory)* The "20× repair reduction" measures recovery from a self-inflicted regression, not progress past the prior baseline. | Find the per-run repair rate before the declaration contract on the same seed. If it is worse than 0.026/turn, H4 fails. | **Confirmed.** Same seed, pre-declaration: 0.020/turn over 50 turns, and 0.000/turn over 100 turns. |
| H5 | *(exploratory)* Claim 2.3's ordinal win is measured against a baseline the audit created. | Split `unknown_thread_reference` firings by whether the audit existed. If it was already frequent pre-audit, H5 fails. | **Confirmed.** 0.62% of turns pre-audit → 5.93% with the ID-addressed audit → 0% with ordinals. |
| H6 | Rules police fields the model cannot supply, so a `reject` sends the model a fault it cannot fix. | Check whether thread lifecycle turns are reachable from the wire. If the wire can supply them, H6 fails. | **Confirmed.** The wire has no thread-turn field; `transaction-application.ts` stamps all of them; 7 rules police them as `reject`. |

---

## 1. Measured — reproduced, with three corrections

I ran every command in §2 of the brief. **2.1 (rule counts), 2.3 (the grep), 2.4
(15 of 97 with a prompt), 2.5 (12 candidate deaths, all `far-meridian`) and 2.6
(39/40 committed, 1 skipped, $2.48) all reproduce exactly.** The dispositions
reproduce at 5 `normalize` / 87 `reject` / 5 `signal`.

Three claims need correcting. None of the corrections is cosmetic; each changes
what you would do next.

### 1.1 Eleven rules have fired, not eight — and the corpus loses a third of its repair causes

The brief's repro command extracts rule codes with `\[([a-z_]{2,64})\]`. That
only works on the *multi*-violation format. `formatDomainViolations`
([violations.ts:40](src/domain/violations.ts:40)) deliberately keeps a single
fault's exact rule text with no bracketed code, and `validateInitialSetup`
([store.ts:703](src/store.ts:703)) has its own envelope that never emits codes.
So single-fault repairs are invisible to the command.

```bash
python3 - <<'PY'
import json,glob,re,collections
w=n=f=nc=t=0
for cp in sorted(glob.glob('playtests/runs/*/jobs/*/calls/candidate.jsonl')):
    for line in open(cp):
        o=json.loads(line)
        if o.get('repairKind')!='domain': continue
        t+=1; c=o.get('domainRepairCause')
        if not c: nc+=1; continue
        if [x for x in re.findall(r'\[([a-z_]{2,64})\]',c['errorMessage']) if x!='redacted']: w+=1
        else:
            n+=1
            if 'Local domain validation rejected' in c['errorMessage']: f+=1
print(f'domain repairs {t}; rule recoverable {w}; cause but no code {n} (generic fallback {f}); no cause {nc}')
PY
```

→ `domain repairs 53; rule recoverable 35; cause but no code 12 (generic fallback 3); no cause 6`

**The rule that caused a repair is knowable for 35 of 53 repairs (66%).** Six
predate repair-cause instrumentation entirely (it appears in run artifacts from
2026-07-30T09-43 onward). Three degraded to the generic `domain_rule` fallback,
so their identity is permanently gone. The rest render the rule as prose.

Recovering the prose forms adds three rules to the fired set:
`unknown_entity_reference` (×1), `setup_unknown_inventory_item` (×2),
`setup_item_dual_placement` (×1). So **11 named rules have fired, not 8.** Two of
the 11 have since been deleted, so **88 of the current 97 have never fired, not
90.** And because `unknown_entity_reference` is one of the 15 rules carrying a
prompt sentence, **2.4's ratio is four of 15, not three of 15.**

```bash
python3 -c "
import re
n=set(re.findall(r'^  ([a-z][a-z0-9_]*): rule\(\{',open('src/domain/rules/registry.ts').read(),re.M))
fired='thread_audit_incomplete unknown_thread_reference thread_audit_unknown_thread unknown_location_reference thread_audit_unjustified_unchanged scene_movement_conflict thread_audit_index_out_of_range unknown_entity_reference setup_unknown_inventory_item setup_item_dual_placement setup_inventory_non_item'.split()
print('fired',len(fired),' deleted since',sum(f not in n for f in fired),' never fired',len(n)-sum(f in n for f in fired),'of',len(n))"
```

→ `fired 11  deleted since 2  never fired 88 of 97`

`unknown_entity_reference` matters out of proportion to its single firing: it is
the first rule in the registry and the one the brief's numbers imply is inert.

### 1.2 Ranked by share of turns, as AGENTS.md requires

The brief ranks by repair count. AGENTS.md is explicit that this is the wrong
statistic. Counting distinct `logicalOperationId` values instead, and folding in
the prose-rendered repairs, over all 947 turn records:

| rule | turns | share |
| --- | --- | --- |
| `thread_audit_incomplete` *(deleted since)* | 15 | 1.58% |
| `unknown_thread_reference` | 13 | 1.37% |
| `thread_audit_unknown_thread` *(deleted since)* | 12 | 1.27% |
| `unknown_location_reference` | 4 | 0.42% |
| `thread_audit_unjustified_unchanged` | 4 | 0.42% |
| `scene_movement_conflict` | 2 | 0.21% |
| `thread_audit_index_out_of_range` | 2 | 0.21% |
| `unknown_entity_reference` | 1 | 0.11% |

`unknown_thread_reference` is still declared. What V2 removed is the wire's
`update_thread`/`resolve_thread` effects, not the rule — which is the right call,
because appeal and derived-operation paths can still carry a thread reference.

Corpus-wide shares are misleading in the other direction, though — they dilute a
catastrophe across 947 turns. Per run, which is what AGENTS.md actually
specifies:

```bash
python3 - <<'PY'
import json,os,glob,re,collections
for d in sorted(os.listdir('playtests/runs')):
    for j in sorted(glob.glob(os.path.join('playtests/runs',d,'jobs','*'))):
        tj,cp=os.path.join(j,'turns.jsonl'),os.path.join(j,'calls','candidate.jsonl')
        if not(os.path.exists(tj) and os.path.exists(cp)): continue
        n=sum(1 for _ in open(tj))
        if not n: continue
        r=collections.defaultdict(set); reps=0
        for line in open(cp):
            o=json.loads(line)
            if o.get('repairKind')!='domain': continue
            c=o.get('domainRepairCause') or {}
            if c.get('sourcePhase')=='setup': continue
            reps+=1
            for cd in {x for x in re.findall(r'\[([a-z_]{2,64})\]',c.get('errorMessage','')) if x!='redacted'}:
                r[cd].add(c.get('logicalOperationId') or o['id'])
        if reps:
            top=max(r,key=lambda k:len(r[k])) if r else '(unattributed)'
            print(f"{d[:16]} turns={n:3d} rep/turn={reps/n:.3f} top={top} {100*len(r.get(top,()))/n:.0f}%")
PY
```

The output is the whole story of the last two days:

```
...
2026-07-30T13-14 turns= 15 rep/turn=0.067 top=unknown_thread_reference 7%
2026-07-30T20-28 turns= 15 rep/turn=1.000 top=thread_audit_incomplete 100%   <- declarations land
2026-07-30T21-10 turns= 15 rep/turn=0.333 top=thread_audit_unknown_thread 27%
2026-07-30T21-55 turns= 15 rep/turn=0.200 top=thread_audit_unknown_thread 20%
2026-07-31T09-02 turns= 14 rep/turn=0.429 top=thread_audit_unjustified_unchanged 29%
2026-07-31T13-52 turns= 15 rep/turn=0.067 top=thread_audit_index_out_of_range 7%
2026-07-31T14-04 turns= 40 rep/turn=0.025 top=scene_movement_conflict 3%
```

### 1.3 The corpus is 36 codebases, and 47 of 49 runs are unreproducible

```bash
python3 -c "
import json,glob,collections
g=collections.Counter()
for p in glob.glob('playtests/runs/*/manifest.json'):
    cv=json.load(open(p)).get('codeVersion') or {}
    g[(cv.get('commit','?')[:7],bool(cv.get('dirty')),cv.get('sourceHash','?')[:8])]+=1
print('run dirs:',sum(g.values()),' distinct code versions:',len(g))
print('dirty:',sum(v for k,v in g.items() if k[1]),' clean:',sum(v for k,v in g.items() if not k[1]))
"
```

→ `run dirs: 49  distinct code versions: 36` / `dirty: 47  clean: 2`

Forty runs claim commit `105e94c` (2026-07-26) across **30 different source
hashes**, all dirty. The code that produced them is not in git and cannot be
recovered. Only the last two runs (55 turns, `ad5e46e`) are reproducible.

Total turn records on disk are **947**, not ~1,200.

This matters most for the brief's own §5: "Deleting anything under
`playtests/runs/` — those 47 runs are the only regression baseline that exists."
They are a valuable *corpus*, and I did not touch them. They are not a
*baseline*: a baseline you cannot re-run is a set of observations, and 36 of the
37 codebases that produced them no longer exist.

---

## 2. Interpretation — where §3 is wrong

### 2.1 Claim 2.3 is the brief's strongest result and it points the other way

§2.3 says thread ordinals took `unknown_thread_reference` "from 8 repairs to
structurally unreachable," and calls this "the strongest single result in the
corpus and the main reason to take 'make it unrepresentable' seriously over 'add
a check'."

The mechanism is real. The *credit* is not. Split the firings by whether the
`threadAudit` channel existed yet:

```bash
python3 - <<'PY'
import json,os,glob,re
pre,post,pt,st=set(),set(),0,0
for d in sorted(os.listdir('playtests/runs')):
    e = 'post' if d[:16]>='2026-07-30T20-28' else 'pre'
    for j in sorted(glob.glob(os.path.join('playtests/runs',d,'jobs','*'))):
        tj=os.path.join(j,'turns.jsonl')
        n=sum(1 for _ in open(tj)) if os.path.exists(tj) else 0
        if e=='pre': pt+=n
        else: st+=n
        cp=os.path.join(j,'calls','candidate.jsonl')
        if not os.path.exists(cp): continue
        for line in open(cp):
            o=json.loads(line)
            if o.get('repairKind')!='domain': continue
            m=(o.get('domainRepairCause') or {}).get('errorMessage','')
            if 'unknown_thread_reference' in m or 'Unknown thread reference' in m:
                (pre if e=='pre' else post).add((d,(o.get('domainRepairCause') or {}).get('logicalOperationId') or o['id']))
print(f'pre-audit  {len(pre)} turns / {pt} = {100*len(pre)/pt:.2f}%')
print(f'ID-addressed audit {len(post)} turns / {st} = {100*len(post)/st:.2f}%')
PY
```

```
pre-audit  5 turns / 812 = 0.62%
ID-addressed audit 8 turns / 135 = 5.93%
ordinal-addressed audit (runs 13-52, 14-04): 0 turns / 55 = 0.00%
```

Sequence: `unknown_thread_reference` was a **0.62%-of-turns** nuisance for 812
turns. The `threadAudit` channel landed on 2026-07-30T20-28 addressing threads by
transcribed ID and drove it to **5.93%**. Ordinals then removed it. Every one of
the 8 post-audit firings is co-reported with `thread_audit_unknown_thread` in the
same repair — the audit is the thing that was failing, not an `update_thread`
operation.

**Ordinals cured a wound the audit inflicted.** Against the pre-audit baseline
the whole episode bought 0.62 percentage points, and it cost two deleted rules, a
new rule, prompt tokens, and a dozen paid runs. The corpus does not evidence
"make it unrepresentable" — it evidences "do not add a second channel."

I still think "make it unrepresentable" is right (§3 argues it structurally, from
the schema, where the reasoning does not depend on this corpus). But it must not
be argued from 2.3.

### 2.2 The "20× reduction" is recovery, not progress

§2.6 presents 39/40 committed at 0.026 repairs/turn against a prior attempt that
aborted at turn 13 with 0.538. Interpretation #6 credits deleting two rules and
demoting four.

Both endpoints are inside the declaration era. The comparison you want is against
the last runs before it, on the same seed:

```bash
python3 -c "
import json,os,glob
for d in sorted(os.listdir('playtests/runs')):
    m=json.load(open(f'playtests/runs/{d}/manifest.json'))
    if (m.get('config') or {}).get('scenarioSeed')!='far-meridian-dead-signal': continue
    for j in sorted(glob.glob(f'playtests/runs/{d}/jobs/*')):
        ts=[json.loads(l) for l in open(f'{j}/turns.jsonl')] if os.path.exists(f'{j}/turns.jsonl') else []
        if len(ts)<40: continue
        dom=sum(1 for l in open(f'{j}/calls/candidate.jsonl') if json.loads(l).get('repairKind')=='domain')
        era='V2' if any('threadAudit' in t for t in ts) else 'pre-V2'
        print(f'{d[:16]} {len(ts):3d} turns  {dom} domain repairs  {dom/len(ts):.3f}/turn  {era}')
"
```

```
2026-07-29T18-46 100 turns  0 domain repairs  0.000/turn  pre-V2
2026-07-30T07-31  50 turns  1 domain repairs  0.020/turn  pre-V2
2026-07-30T09-43  50 turns  1 domain repairs  0.020/turn  pre-V2
2026-07-31T14-04  39 turns  1 domain repairs  0.025/turn  V2
```

Of the five runs in the corpus that reached 40+ turns, **the celebrated one is
the shortest and has the highest repair rate.** A 100-turn run on the same seed
went clean.

The honest caveat, which cuts against me as much as against the brief: the
pre-V2 code had fewer declared rules, so fewer things *could* fire. Lower repair
rates partly measure looser checking. That is precisely why the number is
useless as a comparison — and it is why the current acceptance criteria are the
wrong instrument (§4.4).

What *is* comparable is outcome quality, and it is flat:

```bash
python3 -c "
import json,glob
for p in sorted(glob.glob('playtests/runs/*/jobs/*/mechanical-audit.json')):
    a=json.load(open(p))
    if a.get('committedTurns',0)<39: continue
    print(f\"{p.split('/')[2][:16]} committed={a['committedTurns']:3d} invariantFailures={len(a['invariantFailures'])} threadTransitions={len(a['threadTransitions'])} set_entity_state={a['operationCounts'].get('set_entity_state',0)}\")
"
```

```
2026-07-28T21-33 committed=100 invariantFailures=0 threadTransitions=1 set_entity_state=78
2026-07-29T18-46 committed=100 invariantFailures=0 threadTransitions=0 set_entity_state=194
2026-07-30T07-31 committed= 50 invariantFailures=0 threadTransitions=2 set_entity_state=34
2026-07-30T09-43 committed= 50 invariantFailures=0 threadTransitions=0 set_entity_state=33
2026-07-31T14-04 committed= 39 invariantFailures=0 threadTransitions=0 set_entity_state=2
```

Zero invariant failures in every era. The added strictness bought no measurable
state-quality improvement in the only metric the harness records for it.

### 2.3 Interpretation #4 ("blocking should expire") is unsupportable at this sample size

"A rule that has not fired in N runs should be demoted automatically."

A rule with per-turn hazard `p` is seen at least once in `N` turns with
probability `1-(1-p)^N`. Inverting, the smallest `p` detectable at 95%
confidence is `1-0.05^(1/N)`:

| exposure | what it is | smallest detectable `p` |
| --- | --- | --- |
| 15 turns | the median run | 18.1% |
| 55 turns | all reproducible code | 5.3% |
| 120 turns | the whole declaration era | 2.5% |
| 947 turns | every turn record on disk | 0.3% |

Auto-demotion on the reproducible corpus would demote rules that fire on up to
**5.3% of turns** — twice the share of the worst rule in the current run.
Worse, the hazard is not stationary: `inventory_negative` cannot fire until the
fiction involves quantities, and `campaign_already_ended` cannot fire twice in a
campaign. Silence is mostly *coverage*, not *futility*.

Reject #4 as stated. §4.2 keeps the part that survives.

### 2.4 Interpretation #1 is right, and it under-reaches

"The root cause is duplicate representation." Correct, and the strongest evidence
is not in the wire at all — it is in the durable schema, where nobody looked.

`ManifestSchema` ([schemas.ts:191](src/schemas.ts:191)) stores
`currentLocationId`, and `EntitySchema` ([schemas.ts:148](src/schemas.ts:148))
stores `location` on the player. The same fact, twice. All four "campaign
coherence" rules exist only to police the copies:
`current_location_not_location`, `player_location_mismatch`,
`player_status_mismatch`, `player_status_terminal_mismatch`. Same pattern as
`threadAudit` vs `move_entity`, one layer down, and permanent rather than
per-turn.

### 2.5 Interpretation #3 (operation-level failure) should be rejected — see §4.3

### 2.6 Interpretation #5 is right and cheap

"Prompt sentences should be earned by observed failure." Agreed, and the
corrected numbers make it slightly worse than the brief's:

```bash
python3 -c "
import re
b=dict(re.findall(r'^  ([a-z][a-z0-9_]*): rule\(\{(.*?)^  \}\),',open('src/domain/rules/registry.ts').read(),re.M|re.S))
fired='unknown_thread_reference unknown_location_reference thread_audit_unjustified_unchanged scene_movement_conflict thread_audit_index_out_of_range unknown_entity_reference setup_unknown_inventory_item setup_item_dual_placement setup_inventory_non_item'.split()
print('with prompt:',sum('prompt:' in v for v in b.values()),'of',len(b))
print('fired AND prompted:',sum('prompt:' in b[f] for f in fired),'/ fired and silent:',sum('prompt:' not in b[f] for f in fired))"
```

→ `with prompt: 15 of 97` / `fired AND prompted: 4 / fired and silent: 5`

Four of 15 prompted rules have fired; five of the nine fired rules that still
exist say nothing to the model. Alongside them sit **42 hand-written audit
blocks** (§4.4), so the generated-from-evidence channel is 15 sentences and the
authored-from-intuition channel is 42 blocks. There is no cost to inverting that
ratio.

### 2.7 What §2.5's seed confound actually shows

The caution is right; the mechanism is mis-stated. Death rate by seed across
autoplay jobs: `far-meridian` 12/32 (37.5%), `dark-sun` 0/5, default 0/4.
Fisher exact one-sided **p = 0.029**, so the association is real — I expected it
to be under-powered and it is not.

But three source hashes ran all three seeds at 15 turns each — the only
same-code seed comparisons in existence:

| sourceHash | far-meridian | dark-sun | default |
| --- | --- | --- | --- |
| `dc1bd66a` | 15 turns, 0 repairs | 15 turns, 1 repair | 15 turns, 0 repairs |
| `0442ecd7` | **died at setup, 0 turns** | 15 turns, 0 repairs | 15 turns, 1 repair |
| `2c3b2ce4` | 15 turns, 2 repairs | 15 turns, 0 repairs | 15 turns, 0 repairs |

Controlled, `far-meridian` is not uniformly worse — and its one death is a
**setup** failure with zero turns committed. Four of its twelve deaths committed
zero turns. The seed's difficulty is concentrated where its `requirements.json`
lives: 20 required entities, 6 containment edges (a 7-node location tree), 4
custody requirements and 2 threads pre-linked to 11 entities, all of which the
model must satisfy in one structured setup response. (The brief's "19 mandatory
entities … 8 custody requirements" is close but does not match the file; the
counts above are `len()` over each key.) That is a *setup-generation* problem, not
a per-turn gameplay problem, and it changes what you would fix — which is M8.

---

## 3. Q1 — Game schema

**Decision: keep the four durable record types and Markdown-first storage. Change
four shapes. That removes or reclassifies roughly 30 of the 97 rules without a
new record model.**

Today: `Manifest` (campaign header), `Entity` (with nested `Fact`,
`InventoryEntry`, `Relationship`, traits, conditions), `Thread`,
`ChronicleEvent`. Plus three non-gameplay records: the setup snapshot, the
completed-story artifact, the pending turn. The record *set* is good — small,
readable, and it is why a campaign survives without the model. The problem is
that each record's *type* permits states the domain forbids, so 97 rules do work
the type could do.

> **Correction (after M6 shipped).** §3.1 below was written from the rule list.
> Measured against the committed snapshots it is substantially wrong, and §6's
> M7 and M9 were withdrawn because of it. See §3.6 for what the data says and
> what replaces them. The original text is kept so the error is inspectable.

### 3.1 Entity is one type with kind-dependent legal fields

`EntitySchema` carries `kind: person|location|item|faction|creature|event|other`
and then `location?`, `inventory[]`, `conditions[]`, `traits[]` for all of them.
So the type permits an item that is both carried and in the world, a movement
destination that is not a location, a non-item inside an inventory, and an entity
contained by a person.

A discriminated union on `kind` makes six of those unrepresentable rather than
detected:

```ts
type LocationEntity = Base & { kind: "location"; parentId?: LocationId; contents: ItemId[] };
type ItemEntity     = Base & { kind: "item"; placement: Placement };
type ActorEntity    = Base & { kind: "person"|"creature"; location: LocationId;
                               inventory: InventoryEntry[]; conditions: string[] };
type AbstractEntity = Base & { kind: "faction"|"event"|"other" };

type Placement =
  | { held: { ownerId: ActorId | LocationId; quantity: number } }   // exactly one owner
  | { loose: { locationId: LocationId } };                          // physically there
```

Dies at the type level: `not_a_location`, `not_an_item`, `non_location_parent`,
`inventory_non_item`, `item_dual_placement`, and — because `Placement` is a sum,
not two independent fields — `conflicting_item_destination`,
`multiple_inventory_owners`, `inventory_duplicate_ownership`.

**`Placement` is the single highest-value schema change.** "Carried" is currently
a two-place invariant: an entry in the owner's `inventory` *and* the absence of
`location` on the item. Two places means a rule per disagreement. One place means
none.

Honest limits: `self_containment`, `inventory_self_containment`,
`inventory_cycle`, `location_hierarchy_cycle` are graph properties. No type
expresses them; they stay as checks, and they should. `inventory_negative` needs
`quantity: PositiveInt` plus an arithmetic check, because the *delta* is what
goes negative.

### 3.2 Thread's application-owned fields are unconstrained, while Fact's identical fields are constrained

`ThreadSchema` comments `createdTurn`/`updatedTurn`/`closedTurn` as
"Application-owned lifecycle turns." They are: `transaction-application.ts`
stamps every one from its `turn` parameter, and the wire has no field for them:

```bash
grep -n "createdTurn\|closedTurn\|updatedTurn" src/llm/gameplay-protocol.ts   # no output
grep -n "superRefine" src/schemas.ts                                          # 25, 120, 390
```

`FactSchema` puts exactly these constraints in the type, at
[schemas.ts:120](src/schemas.ts:120) — an active fact cannot have
`supersededTurn`, and `supersededTurn` cannot precede `createdTurn`. There are no
`fact_future_*` rules, because the type already refuses.

`ThreadSchema` has no `superRefine`, and gets six rules instead:
`thread_future_created`, `thread_future_updated`, `thread_future_closed`,
`thread_updated_before_created`, `thread_closed_before_update`,
`thread_active_with_closure`. Plus `chronicle_future_turn`. **Seven rules exist
because one record got a schema refinement and its sibling did not.**

This is the cleanest available demonstration that the schema, not the rule count,
is the lever — and it is a five-line change.

### 3.3 The manifest stores two facts that already live on the player

Per §2.4. `currentLocationId` is derivable as `entities[playerId].location`;
`Manifest.status` overlaps the player's free-form `status`.

Make `currentLocationId` a derived projection with one accessor. If the manifest
must keep a copy so a status read does not load every entity — and it probably
must — name it a cache, write it from exactly one function, and demote
`player_location_mismatch` to an application invariant (§4.2) rather than a
model-correctable reject. The model cannot fix our cache.

Campaign lifecycle is genuinely campaign-level: keep `Manifest.status` as the
sole authority for `active|dead|ended` and stop letting the player entity's
free-form `status` carry terminal meaning. `player_status_mismatch` and
`player_status_terminal_mismatch` then have nothing to compare.

### 3.4 Setup is a second, hand-written copy of the domain

Fourteen of the fifteen `setup_*` rules restate a gameplay rule:

```bash
python3 - <<'PY'
import re
n=set(re.findall(r'^  ([a-z][a-z0-9_]*): rule\(\{',open('src/domain/rules/registry.ts').read(),re.M))
alias={'setup_unknown_location':'unknown_location_reference','setup_unknown_inventory_item':'unknown_item_reference',
 'setup_duplicate_entity_ids':'entity_already_exists','setup_player_start_location':'not_a_location',
 'setup_thread_unknown_entity':'unknown_entity_reference','setup_inventory_multiple_owners':'multiple_inventory_owners'}
s=[x for x in n if x.startswith('setup_')]
p=[x for x in s if (x[6:] in n) or (alias.get(x) in n)]
print(f'{len(p)} of {len(s)} setup rules restate a gameplay rule')
print('the exception:', [x for x in s if x not in p])
PY
```

→ `14 of 15 setup rules restate a gameplay rule` / `the exception: ['setup_player_id']`

`validateInitialSetup` is ~200 lines inside `store.ts` with its own violation
list, its own dedup, and its own error envelope that emits no rule codes — which
is why six of seven setup repairs in the corpus have no recoverable cause.

Setup is not a different domain. It is the same domain applied to an empty
campaign. Express it as `applyTransaction` over empty state with the setup's
entities as `create_entity` operations, and 14 rules plus 200 lines of parallel
implementation disappear, and setup repairs start reporting rule codes for free.

`setup_player_id` (the initial player must be `player:hero`) is the one genuine
setup-only rule, and it should be a type: `playerId` is a constant, not an input.

### 3.6 What the snapshots actually contain — and why M7 and M9 were withdrawn

Before starting M7 I measured the assumptions in §3.1 against the final state
snapshot of all 53 jobs. Two of them are false.

```bash
python3 - <<'PY'
import os,glob,re,collections
kinds=collections.Counter(); inv=collections.Counter(); loc=collections.Counter()
cond=collections.Counter(); trait=collections.Counter(); multi=[]; nonitem=collections.Counter()
for j in sorted(glob.glob('playtests/runs/*/jobs/*')):
    st=sorted(glob.glob(os.path.join(j,'states','turn-*.txt')))
    if not st: continue
    txt=open(st[-1]).read(); ek={}; bl=[]
    for b in txt.split('\n---\n'):
        i=re.search(r"^id: '?([^'\n]+?)'?$",b,re.M); k=re.search(r"^kind: (\S+)$",b,re.M)
        if i and k: ek[i.group(1)]=k.group(1); bl.append((i.group(1),k.group(1),b))
    own=collections.defaultdict(set)
    for eid,k,b in bl:
        kinds[k]+=1
        if re.search(r"^location: ",b,re.M): loc[k]+=1
        m=re.search(r"^inventory:\n((?:  - entityId:[\s\S]*?)(?=^\w|\Z))",b,re.M)
        if m:
            inv[k]+=1
            for e in re.finditer(r"entityId: '?([^'\n]+?)'?\n",m.group(1)):
                own[e.group(1)].add(eid)
                if ek.get(e.group(1))!='item': nonitem[ek.get(e.group(1),'?')]+=1
        if re.search(r"^conditions:\n  - ",b,re.M): cond[k]+=1
        if re.search(r"^traits:\n  - ",b,re.M): trait[k]+=1
    multi += [(i,sorted(o)) for i,o in own.items() if len(o)>1]
print('kinds        ',dict(kinds)); print('holds inventory',dict(inv)); print('has location ',dict(loc))
print('conditions   ',dict(cond)); print('traits       ',dict(trait))
print('non-item in an inventory:',dict(nonitem) or 'NONE')
print('items held by >1 owner at once:',len(multi), multi[:3])
PY
```

```
kinds         {'item': 398, 'location': 318, 'person': 229, 'other': 5, 'faction': 14}
holds inventory {'location': 78, 'person': 132, 'other': 2}
has location  {'person': 217, 'location': 206, 'other': 5, 'faction': 12}
conditions    {'person': 83, 'location': 37, 'item': 49, 'faction': 2, 'other': 1}
traits        {'person': 144, 'item': 111, 'location': 42, 'faction': 2, 'other': 2}
non-item in an inventory: NONE
items held by >1 owner at once: 27 [('item:silver-marks', ['npc:mara-venn', 'player:hero']), ...]
```

**M7 is withdrawn: an item entity is a fungible type, not a physical object.**
`item:silver-marks` is held by the player *and* by Mara Venn in the same
snapshot — 27 such cases, plus 61 inventory entries with quantity above 1. A
`placement` sum type with one owner cannot express that, so it would break
currency and consumables. The rules I claimed it would kill —
`multiple_inventory_owners`, `inventory_duplicate_ownership` — exist precisely
*because* multi-owner is legitimate for fungibles and must happen only through a
conserved transfer. Meanwhile the sum type's other arm is dead: no item carries
a world `location` in any snapshot, because a loose object is modelled as an
entry in a *location's* inventory (78 locations hold one). `item_dual_placement`
guards a state that is expressible and has never occurred.

The real missing distinction is fungibility, and nothing in the schema carries
it: `owned_item_credit_requires_transfer`, `repeated_abstract_inventory_credit`,
`inventory_duplicate_ownership`, and `non_atomic_item_transfer` are all trying
to infer uniqueness from behaviour. The honest fix is a `stacking:
"unique" | "fungible"` discriminator the model sets at creation — which makes
uniqueness checkable instead of inferred, but needs a new wire field and
therefore another protocol change.

**M9 is withdrawn: the kinds are not separable, and branding would not have
worked anyway.** Conditions appear on locations (37) and items (49), not just
actors; traits appear on items (111) and locations (42); inventories are held by
locations (78) and by `other` (2). The union arms would be near-identical, so
splitting `Entity` touches everything that reads an entity and buys almost
nothing.

The deeper error is in §3.1's claim that these rules "die at the type level."
They cannot. `not_a_location`, `non_location_parent`, `inventory_non_item` and
`not_an_item` are runtime facts about a model-supplied string: whether the ID
resolves to an entity of the right kind. A TypeScript brand is erased before any
model output exists. **What the data does support is that the containment
relation is totally uniform** — person→location 217, location→location 206,
faction→location 12, other→location 5, and *zero* non-location containers, and
zero non-item records in 423 inventory entries. That uniformity is what makes
those four rules eliminable, but only by changing how the reference is
*expressed*: an ordinal into a kind-scoped context list, the way M6 did for
threads. That is a protocol change, not a schema change.

Both mistakes have one cause: I read the rule registry and inferred the shape of
the data from it, instead of reading the data. The registry describes what
someone once feared, and the corpus describes what happens.

### 3.5 What Q1 comes to

Nothing above changes what a durable record *is*, so nothing above touches
Markdown-first state or needs your sign-off. It changes how the types are
declared. The 97 rules are not evidence of a wrong record model; they are the
accumulated cost of four shapes that let the wrong states be written down.

---

## 4. Q2 — Deterministic state

### 4.1 What must block

The existing test in AGENTS.md is right and I would not weaken it: **block if
committing leaves state a later turn cannot correctly read.** Unresolvable
references, ID collisions, containment cycles, inventory arithmetic, temporal
ordering.

### 4.2 The ladder needs a fourth value, on a second axis: who can fix it

`DomainViolationCollector.add` reduces three dispositions to two behaviours
([violations.ts:82](src/domain/violations.ts:82)):

```ts
const blocking = DOMAIN_RULES[code].disposition !== "signal";
```

`reject` and `normalize` both block; blocking means `assertNone()` throws, which
means the engine spends its one bounded domain correction on a **model call**.
There is no way to say "no model can fix this."

That gap is not hypothetical. `assertCampaignStateConsistency` is called two
different ways:

```bash
grep -rn "assertCampaignStateConsistency" src | grep -v state-consistency.ts
```

- with a collector, from `transaction-application.ts:444` — the verify stage of a
  live turn, so a fault becomes a model correction request;
- without a collector, from `store.ts:676` (loading a campaign) and
  `persistence/commit.ts:233,313` (commit preflight) — where it throws.

Same rule codes, two meanings. A `player_location_mismatch` from a hand-edited
save and one from an apply-stage bug are indistinguishable in the repair
ranking, and in the live path the model is asked to repair both.

Add a fourth disposition — **`invariant`** — meaning: violated only by an
application defect or an externally modified save. Never sent to the model. Fails
the turn, writes a secret-safe diagnostic, leaves the save untouched, and is
ranked in its own lane so it never pollutes the model's repair worklist.

Roughly 15–20 rules belong there: the seven application-stamped temporal rules
(§3.2), `state_unknown_entity`, `fact_id_duplicate`, `thread_id_duplicate`,
`chronicle_id_duplicate`, and the four campaign-coherence rules.

This is *not* the same as demoting them. Markdown-first state is
human-editable-by-design, so these checks are load-bearing — they are the only
thing standing between an edited save and a corrupted campaign. They are
correctly `reject`-strength and incorrectly addressed to the model.

Second-order benefit: ~20 rules leave the model-facing rule set, so the
"90 never fired" denominator stops mixing two populations.

### 4.3 The unit of failure stays the turn

Interpretation #3 proposes committing narration and valid operations and
surfacing the dropped one to the next turn. **Reject it**, and the brief is right
that it is the most questionable item in §3.

The stated benefit is measured and small. Domain repairs are 53 across 947 turns;
in the stable eras the rate is 0.020–0.067/turn. Partial commit would save
roughly one $0.06 regeneration every 20–50 turns.

The cost is silent and unbounded. Operations within a turn are causally coupled —
`advance_time` on 94% of turns, `add_fact` on 77%, `update_thread` on 68% — and
they are coupled *to the narration*, which is unbounded working memory that
later turns read. Commit "you hand Tala the crate" with the `transfer_item`
dropped and the campaign now holds prose contradicting state. That is exactly
"a later turn cannot correctly read this state," except undetectably, and it is
strictly worse than losing the turn.

The cheap escape hatch already exists and is already correct: an unjudged
autoplay run records an uncommittable turn as `skipped` and continues. It fired
once in 947 turns. One lost turn, no corruption.

**But take the narrow version of #3 that costs nothing.** Today a dropped turn
tells the *next* turn nothing, so the model is free to make the same reference
mistake again. Feed a closed-vocabulary summary of the failure (rule codes, not
prose, per the secret-safe constraint) into the next turn's context. That is the
useful 80% of #3 without partial application, and it does not touch the
"never partially apply" invariant.

### 4.4 The acceptance criteria measure cost and not yield

This is the finding I did not expect and think matters most for Q2.

Run reports score themselves on run completion, largest single rule's share of
turns, invariant failures, and repairs/turn as advisory. **Every one of those
improves when the model emits fewer operations.** Nothing watches whether the
turn recorded anything.

Seed-controlled on `far-meridian`, pre-declaration vs declaration era:

| | turns | ops/turn | `set_entity_state`/turn | narration (median chars) |
| --- | --- | --- | --- | --- |
| pre-V2 | 454 | 4.64 | 0.87 | 1241 |
| V2 | 120 | 3.64 | **0.13** | 1202 |

An 85% drop in recorded status changes with narration length unchanged: the model
writes the same fiction and records far less of it. Per-run: 194
`set_entity_state` in the 100-turn run, **2** in the 39-turn run.

I cannot attribute this to the schema, and I will not pretend otherwise.
Commit `58e9cb0` shipped at least five changes at once — V2's wire, the rule
registry, entity ID format, scenario contracts, and a prompt rewrite that took
the named hand-written audit blocks from **6 to 42**:

```bash
for c in 105e94c 58e9cb0 HEAD; do
  printf "%s: " $c
  git grep -ohE '[A-Z][A-Z -]{6,40}(AUDIT|SWEEP|RECONCILIATION|PREFLIGHT|PRECOMMIT)' $c -- src/prompts/ | sort -u | wc -l
done
```

→ `105e94c: 6` / `58e9cb0: 42` / `HEAD: 42`

Among the 36 added is an explicit instruction to stop "manufacturing another
identical status beat," plus "Durable state is selective restart memory, not a
transcript index." **Either could produce the entire `set_entity_state` effect on
its own, and it would be a deliberate improvement, not a regression.**

For calibration, the token cost of those 36 blocks is small — measured, not
assumed:

```bash
python3 -c "
import json,os,glob,statistics,collections
g=collections.defaultdict(list)
for d in sorted(os.listdir('playtests/runs')):
    m=json.load(open(f'playtests/runs/{d}/manifest.json'))
    if (m.get('config') or {}).get('scenarioSeed')!='far-meridian-dead-signal': continue
    for j in sorted(glob.glob(f'playtests/runs/{d}/jobs/*')):
        if not os.path.exists(f'{j}/turns.jsonl'): continue
        ts=[json.loads(l) for l in open(f'{j}/turns.jsonl')]
        e='V2' if any('threadAudit' in t for t in ts) else 'pre-V2'
        for l in open(f'{j}/calls/candidate.jsonl'):
            o=json.loads(l)
            if o.get('phase')=='decision' and o.get('inputTokens'): g[e].append(o['inputTokens'])
for e in ('pre-V2','V2'): print(e, len(g[e]), 'median', statistics.median(g[e]))"
```

→ `pre-V2 451 median 17137` / `V2 121 median 17692` — **+555 tokens (+3%)**.
Confounded by campaign length (V2 runs are 15–40 turns, pre-V2 up to 100, so
pre-V2 carries more accumulated context), so treat it as an upper bound on the
prompt's contribution. The argument against 42 hand-written blocks is not their
token cost; it is AGENTS.md's own warning about restatement, which is how the
suite reached "thirteen separate phrasings of the thread obligation without ever
detecting a violation."

The point is that **it is unfalsifiable from disk, and no metric would have
caught it in either direction.** Add two yield metrics, both computable
retroactively for all 49 runs from artifacts already present:

- durable operations per turn, by kind;
- thread closures per 100 turns.

They cost nothing and they are the only defence against optimising repairs to
zero by recording nothing.

### 4.5 Atomicity and crash recovery: what is load-bearing

**Load-bearing, keep exactly as is:**

- *Manifest-last commit with idempotent replay.* A campaign is Markdown across
  many files; a torn write is the one failure that silently loses a campaign.
- *Per-campaign filesystem lock.* CLI, browser and playtest harness can all reach
  one campaign concurrently. This is a real, present race.
- *Pre-roll persistence of the natural roll.* The only recovery guarantee with
  player-visible meaning: a crash must not reroll a check. It is a fairness
  property, not a durability one, which is why it must not be traded away for
  simplicity.
- *Validate the complete plan before mutating.* Same argument as §4.3, at the
  filesystem layer.

**Present, correct, and never exercised in anger:**

```bash
find playtests/runs -name prepared-turn.json | wc -l    # 53
python3 -c "
import json,glob
print(sum(1 for p in glob.glob('playtests/runs/*/manifest.json')
          if (lambda m: m.get('resumedAt') or m.get('status')=='resumed')(json.load(open(p)))))"   # 0
```

**Zero resumes in 49 runs.** Pending-turn recovery, `persistence/replacement.ts`
(pre-catalog compatibility only), and catalog-migration intents are covered by
deterministic tests and by nothing else.

I would not delete any of it — untested-in-production is not the same as wrong,
and `replacement.ts` guards a real persisted format. But I would stop letting it
constrain schema design. "Setup must be recoverable" is currently an argument for
the separate setup path in §3.4; it is not a good one, because a setup expressed
as a transaction over an empty campaign inherits the *same* commit machinery
instead of needing its own.

---

## 5. Q3 — LLM interface

**Decision: one channel, and it is operations. Delete `threadAudit` and
`sceneState` from the wire. Keep ordinal addressing and extend it. Restore
`update_thread`/`resolve_thread` as ordinal-addressed operations.**

### 5.1 The declaration channel has zero measured yield

```bash
python3 - <<'PY'
import json,os,glob,collections
a=collections.Counter(); n=0
for d in sorted(os.listdir('playtests/runs')):
    for j in sorted(glob.glob(os.path.join('playtests/runs',d,'jobs','*'))):
        tj=os.path.join(j,'turns.jsonl')
        if not os.path.exists(tj): continue
        ts=[json.loads(l) for l in open(tj)]
        if not any('threadAudit' in t for t in ts): continue
        for t in ts:
            n+=1
            for k,v in (t.get('threadAudit') or {}).items(): a[k]+=v
print(f'{n} V2 turns; audit verdicts {dict(a)}')
PY
```

→ `120 V2 turns; audit verdicts {'unchanged': 85, 'progressed': 97, 'closed': 0, 'omitted': 52, 'invented': 0}`

- **`closed: 0`.** In 120 turns under a contract whose entire purpose is thread
  lifecycle, the audit has never once closed a thread. `resolve_thread`
  operations in the V2 era: 0. `threadTransitions` in the 39-turn run: `[]` —
  identical to the 100-turn run that had no audit at all.
- **50 of 120 turns are all-`unchanged`** — a mandatory declaration that
  changed nothing, on 42% of turns.
- **`omitted: 52`** — the audit is incomplete more often than it is complete,
  and those turns now commit anyway because the blocking rule was deleted. The
  obligation is unenforced.

`sceneState` fares better but is still mostly restatement:

```
player move_entity present on 41/120 turns; of those the location actually changed on 40
```

Informative on 34% of turns and essentially always correct when it is. On the
other 66% it restates the current location, where it cannot add information and
can only introduce error — which is exactly how the one uncommittable turn in
the last run happened. `scene_movement_conflict`, verbatim:

```
player:hero is moved to generated:wire-create-1 but the declared
end-of-turn scene places them at location-habitat-main-corridors
```

The model created a location, moved the player by its temp hint, and named the
same place by display name in the declaration. Neither statement was wrong.
There was nothing for a check to be smarter about; there were two channels.

### 5.2 The choice is not symmetric

The brief frames Q3 as picking one of two channels, and notes the tradeoff:
end-state description silently drops unmentioned records; operations require the
model to track identity.

The corpus makes it asymmetric. `update_thread` appears on **68.5% of turns as a
domain operation in both eras** — in the declaration era it is *derived from the
audit*. So the audit is a re-encoding of an operation the model could already
emit directly, and the re-encoding is the part that fails. Meanwhile the
declaration's own failure mode is live and measured: `omitted: 52` is precisely
"end-state description silently drops unmentioned records," and the rule that
caught it has been deleted.

Operations are load-bearing. Declarations are a lossy re-encoding of them.

### 5.3 Keep ordinals; they are separable from declarations

Ordinal addressing is genuinely good — not because of §2.3's arithmetic, but
because a 1-based index into a list the application just printed cannot be
misremembered, and the application supplies the authoritative ID. That property
has nothing to do with declarations:

```ts
{ kind: "update_thread",  threadOrdinal: 3, summary: "...", references: [...] }
{ kind: "resolve_thread", threadOrdinal: 3, outcome: "...", status: "resolved" }
```

Transcription-proof reference *and* a single channel. This is what V2 should have
been.

Extend ordinals to the other reference classes the same way — entities, items and
locations already appear in the context projection as ordered lists.
`unknown_entity_reference`, `unknown_location_reference`, `unknown_item_reference`
and the five `ambiguous_*` rules then become range checks
(`thread_audit_index_out_of_range` is the shape they collapse to), which is
interpretation #2 done narrowly and with a known cost.

The cost is real and should be stated: an ordinal is only meaningful against the
exact list the model was shown, so the context projection becomes part of the
contract. A projection change silently reindexes everything. Mitigation: hash the
ordered reference list into the request and record that hash with the turn, so a
reindex is detectable rather than silent. That is one field and it is the price
of the whole references section becoming unrepresentable.

Same-turn creations keep hints — an ordinal cannot address a record that did not
exist when the list was printed. `duplicate_create_hint` therefore stays, and it
should.

### 5.4 The wire is a flattened union, and 80% of it is padding

`WireEffectSchema` requires all 14 fields on every effect regardless of kind, so
a `move_entity` must still send `factSectionCode: 0`, `quantity: 0`, `tags: []`.

```bash
python3 -c "
import json,os,glob
ops=used=0
for p in glob.glob('playtests/runs/*/jobs/*/turns.jsonl'):
    for l in open(p):
        for o in json.loads(l).get('operations') or []:
            ops+=1; used+=len([k for k in o if k!='type'])
print(f'{ops} ops x 14 required wire fields = {ops*14} slots; {used} carry a value ({100*used/(ops*14):.1f}%)')"
```

→ `3911 ops x 14 required wire fields = 54754 slots; 10504 carry a value (19.2%)`

This is a deliberate provider-compatibility tradeoff and I am **not**
recommending a change. Flat schemas are what all six adapters support uniformly,
`GAMEPLAY_WIRE_JSON_SCHEMA` is shallow on purpose, and changing it retires every
compatibility record and certification. The cost is worth naming, though,
because it is the reason "invalid states are expressible" is the default at the
wire layer, and it is why the domain layer must keep policing field discipline
even after §3's changes. Fix the *domain* schema (free) and leave the wire flat
(expensive).

### 5.5 Rule-derived prompt sentences should be earned

Per §2.6: four of the 15 prompted rules have ever fired, and five of the nine
fired rules that still exist are silent. `src/prompts/rules.ts` already generates
this section from the registry, so the whole fix is registry edits — drop the
sentence from rules with no observed failure, add one to the five that failed
silently. No new mechanism, and the regression test that forbids a prose copy
reappearing already guards it.

The 42 hand-written audit blocks are the harder half and I would not touch them
in the same change. Measured prompt growth was only +3% (§4.4), so the case for
pruning them is maintainability and the AGENTS.md restatement warning, not tokens
— which makes it a lower priority than anything in §6.

---

## 6. Migration assessment

Ordered by (evidence strength × cheapness). Each is one structural change, so
each is separately attributable — which is the discipline that was missing.

### Cheap and portable to the current code

| # | Change | Rules affected | Cost | Attributable by |
| --- | --- | --- | --- | --- |
| M1 | Add `superRefine` to `ThreadSchema` mirroring `FactSchema`'s; reclassify the 7 temporal rules to `invariant`. | 7 | ~20 lines + tests | Unit tests only. No live run needed. |
| M2 | Add the `invariant` disposition; route it away from the model correction; rank it in its own lane. | ~15–20 reclassified | ~60 lines in `violations.ts` + registry + report | Unit tests; then any run shows a clean model-facing worklist. |
| M3 | Prune and add prompt sentences per §5.5. | 15 → ~8 | registry edits | Token count per call; repair rate must not regress. |
| M4 | Add the two yield metrics (§4.4) to the run report. | 0 | ~40 lines in `report.ts` | Recompute over all 49 runs retroactively; no new run. |
| M5 | Feed the closed-vocabulary failure summary of a skipped turn into the next turn's context (§4.3). | 0 | small, engine + prompt | `turnsSkipped` and repeat-cause rate. |

M1–M4 are all offline-verifiable. M4 should be done **first**, because without it
none of the others can be shown not to have made the model record less.

### Moderate, worth doing, needs one authorized run each

| # | Change | Rules affected | Cost |
| --- | --- | --- | --- |
| M6 | **DONE.** Deleted `threadAudit` and `sceneState`; restored `update_thread`/`resolve_thread` as ordinal-addressed operations. | 97 → 94 | Shipped as protocol V3. Gate green; the three new guards were mutation-checked. Awaiting the paid comparison run in §8. |
| ~~M7~~ | ~~`Placement` as a sum type on `ItemEntity`.~~ | — | **Withdrawn — premise refuted by the data. See §3.6.** Items are fungible types held by several owners at once (27 cases, 61 stacked entries); a single-owner sum type cannot express currency. |
| M8 | Setup as `applyTransaction` over an empty campaign. | 14 removed | Deletes ~200 lines from `store.ts`; setup repairs gain rule codes. **Now the highest-value remaining schema change.** |
| ~~M9~~ | ~~`Entity` as a discriminated union on `kind`.~~ | — | **Withdrawn — premise refuted by the data. See §3.6.** Conditions, traits and inventories span nearly every kind, so the arms are near-identical; and the four reference rules are runtime facts a type brand cannot touch. |
| M10 | Kind-scoped ordinals for entity, location and item references, extending the M6 pattern. | up to 15 reference rules | Protocol change. The containment relation is totally uniform in the corpus (zero non-location containers, zero non-item inventory entries), which is what makes it safe. Replaces what M7/M9 were trying to do. |

M6 is the highest-value single change and also the only one that is a protocol
change. Per AGENTS.md that means a deliberate `GAMEPLAY_PROTOCOL_VERSION`
increment to 3, every adapter and the probe updated together, and fresh
calibration plus `certification-v1` — **which needs your authorization and a
cost ceiling.** It should not be bundled with anything else.

M7 and M9 touch the Markdown codec. They do not change the *bet* — state stays
human-readable Markdown — but they change the durable shape, so **M7 and M9 need
your sign-off before I would start them.**

### Not worth doing

- **Operation-level partial commit** (interpretation #3). §4.3. The measured
  saving is ~$0.06 per 20–50 turns against a silent corruption mode.
- **Automatic demotion of unfired rules** (interpretation #4). §2.3. Would
  demote rules firing on up to 5.3% of turns.
- **Flattening or unflattening the wire union** (§5.4). Correct as a compatibility
  tradeoff; fixing it retires all certification evidence to save tokens.
- **Any rewrite.** §7.
- **Deleting the unexercised recovery paths** (§4.5). Zero resumes is not
  evidence they are unnecessary.
- **Replacing `store.ts`'s locked/unlocked method pairs.** AGENTS.md records that
  the split was evaluated and rejected; nothing I measured contradicts it. §3.4's
  ~200-line deletion is the one part of that file I would touch.

---

## 7. What I would not change, explicitly

- **Markdown-first state.** The corpus is the argument *for* it: 947 turns
  across 36 codebases are readable and analysable today precisely because they
  were never opaque. Every measurement in this document was possible only
  because of it.
- **The four durable record types.** Q1 asks whether a different record model is
  the answer. It is not; the shapes are wrong, not the set.
- **"Never partially apply a model response."** §4.3.
- **Collecting the complete violation set before rejecting.** Load-bearing given
  a single bounded correction, and the reason adding checks is not
  counterproductive.
- **The three-stage discipline** (normalize never rejects / admit collects /
  verify checks the whole snapshot). It is right; only the *addressing* of verify
  failures is wrong (§4.2).
- **One bounded correction, one schema repair, one transient retry.** Nothing in
  the corpus suggests more retries would help; the 07-30T20-28 run shows what
  happens when a contract needs a repair every turn — you fix the contract.
- **Non-agentic gameplay, the shared d100, one generation per ordinary turn.**
  Out of scope and not implicated in anything measured.
- **Interpretation #6, which I am agreeing with against my own instincts.** The
  architecture was not the problem. The problem was that a five-change commit
  shipped as one checkpoint, with no metric that would notice a regression and no
  reproducible baseline to compare against. My §6 is ordered to fix that first
  (M4) and to keep every later change separately attributable.

---

## 8. How you would know it worked

Named comparisons, all against runs that exist.

**M1–M4 (no paid run).** Recompute the report over all 49 runs. Success:
`unknown_entity_reference`, `setup_unknown_inventory_item` and
`setup_item_dual_placement` appear in the ranking; the ~20 `invariant` rules
leave the model-facing worklist; the two yield metrics populate for every
historical run. All checkable with `npm test -- --run`.

**M5 and M6 — the one comparison worth paying for.** Target
`2026-07-31T14-04-08-572Z-e04ae699-b5da-4b4a-81ae-39edc7699dd7`: 40 turns,
`far-meridian-dead-signal`, `gemini-3.6-flash@direct`, `curious-explorer`,
$2.48. Re-run that exact package/candidate/language/seed after M6 alone.

- **Primary:** `turnsSkipped` = 0 and `scene_movement_conflict` structurally
  unreachable — no `sceneState` exists to conflict with. This is the one
  uncommittable turn in the run, and it is the whole point of M6.
- **Secondary:** `thread_audit_unjustified_unchanged` gone from the signal lane,
  where it currently occupies 11 of 40 turns (28%) carrying no decision.
- **Yield, and the reason M4 comes first:** `threadTransitions` > 0. The audit
  scored 0 in 39 turns; so did the 100-turn run without it. Any closures at all
  would be the first positive thread-lifecycle evidence in the corpus. And
  `set_entity_state`/turn must not fall below 0.13 — if repairs improve while
  yield drops, M6 failed.
- **Guard:** largest single rule's share of turns ≤ 2.5% (the current run's
  `scene_movement_conflict`), and invariant failures 0.
- **Falsified if:** repairs/turn exceeds 0.025, or any new rule exceeds 5% of
  turns. That is the 07-30T20-28 signature — a contract that needs constant
  repair — and it means restoring operations reintroduced the transcription
  problem ordinals solved.

One run, one variable. **This requires your authorization and a cost ceiling; the
comparison run cost $2.48, so ~$3.50 with the existing `maxCostUsd` headroom
would cover a like-for-like repeat.** I have not run anything paid.

**M7–M9 (schema shape).** Verified offline: replay all 3,911 committed
operations from `playtests/runs/*/jobs/*/turns.jsonl` through the new types and
confirm every historically-committed operation still type-checks and applies.
That is a free regression test against the entire corpus, and it is the strongest
evidence available without spending anything.

---

## Appendix — analysis scripts

Throwaway, in the session scratchpad, not added to the repo:

| script | what it produces |
| --- | --- |
| `census.py` | per-job corpus table: code version, seed, turns, repairs, per-rule turn sets |
| `ranking.py` | corrected per-turn rule ranking including prose-rendered repairs |
| `v2era.py` | declaration yield per turn: audit verdicts, real vs restated movement |
| `ops.py` | corpus-wide operation census and wire-slot utilisation |

Every figure in this document is reproducible from the inlined commands above.
Nothing under `playtests/runs/` was modified, and no paid call was made.
