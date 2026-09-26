# Evals mined from transcripts

A defect ticket closes and the trajectory that proved it goes with the run. The next ship re-drives
the LEG, never the TURN. So a fixed defect keeps no bench of its own, and the same failure shape can
come back without anything noticing.

This page is the recipe that turns a failed turn into a bench case. It has three parts: the miner,
the bench, and the rule that keeps an invented case out.

The lane is `packages/core/scripts/eval/`. The bench is
[`family-bench.ts`](../../packages/core/scripts/eval/family-bench.ts) and the miner is
[`mine-family-case.ts`](../../packages/core/scripts/eval/mine-family-case.ts).

## What a case is

One case is one failed turn. It holds:

| Field | What it carries |
|---|---|
| `family` | The failure family, from [failure families](./failure-families.md). |
| `provenance` | The run, the leg, the ticket and a tracked path that record the transcript. |
| `context` | What the turn saw. |
| `expected` | What a turn that does the job produces. One sentence. |
| `observed` | The failed turn, verbatim where the transcript records words. |
| `corrected` | A turn that does the job. |
| `signal` | The predicate that fires on `observed` and stays quiet on `corrected`. |

A `signal` has two halves, and both must be satisfied for it to fire. `text` is a list of regular
expressions over the turn's words. `facts` is a map of structural values — an audit row count, a
`no_reply` reason, a tool ref — compared with `===` against the candidate's own facts.

Both halves exist because the families need different evidence. A `grounding` failure is words. A
`delivery` failure has no words at all: the member got nothing, and the count of reply rows is the
whole case.

## The bench's own green

`npm run test:family-bench` runs the bench and the miner. The bench's green is a PAIR CHECK: every
case's signal must fire on its own recorded failure and stay quiet on its corrected turn.

That check has teeth both ways. A signal loose enough to match everything fires on the corrected turn
and reds. A signal tight enough to miss its own recorded failure reds too. An empty signal is refused
rather than scored, because it would report every turn as broken.

🔴 **Every declared half must discriminate ON ITS OWN.** A case may declare `text`, or `facts`, or
both. Whichever it declares is run alone against the pair, and must still separate them. The rule
exists because the first version did not have it: the grounding case's `facts` half already separated
its pair, so its `text` patterns could be loosened to `/./` and the bench stayed green. A pattern no
assertion can fail is decoration. Delete a half that decides nothing; do not keep it for readability.

Three more fields are refused when empty — `context`, `expected`, and the provenance. A case pasted
straight out of the miner and forgotten therefore cannot reach the bench.

🔴 **The bench is never a gate on the product.** It measures the model and the turn, the way the rest
of the eval lane does. No ship blocks on it. It reports a pass rate per family; it does not decide a
deploy.

## The recipe

### 1. Triage the red to a family

Read the trajectory and name the family. The decision order is in
[failure families](./failure-families.md) — first match wins. The family goes in the ticket body and
in the TRIAGE stamp.

A SOAK red arrives already triaged: the cold reviewer sets `family` on every red row and the run's
`review-report.json` carries `familyCounts`, so read it rather than re-deriving it (OPE-1787). An
e2e red still needs the read above.

### 2. Check the family leaves a transcript

Two families leave none, so neither can be mined:

- `lifecycle` — the lost decision is outside the turn;
- `harness` — the defect is in the instrument, not the product.

`wake` and `containment` are mineable only for the half a turn saw. The miner refuses `lifecycle`
and `harness` by name (`MINEABLE_FAMILIES` in `family-bench.ts` lists the other five), refuses a
string that is not a family at all, and says which rule refused it.

### 3. Mine the turn

The miner reads the two shapes the lanes already write:

- **soak** — `verdicts.jsonl` from `soak-run.ts`. One verdict line per step. A failed turn is a line
  whose `conduct` is `hard-fail` or `soft-fail`, or whose `memberOutcome` is `broken`. (`none` is
  the OPERATOR-only outcome — the phase-8 rotation — and is not a failure.)
- **e2e** — the `runner.ts` console log. A failed leg is its `✗ <id> <title> (<s>s): <message>` line,
  with the `↳ reply:` tail the runner appends to a gate failure.

```
cd packages/core
npx tsx scripts/eval/mine-family-case.ts --evidence <run>/verdicts.jsonl --family grounding --step 17
npx tsx scripts/eval/mine-family-case.ts --evidence <run>/e2e.log --family delivery --leg J-GH
```

The pack prints its `✗` lines on STDERR, so capture it with `npm run e2e 2>&1 | tee e2e.log`. A log
captured from stdout alone holds no failure line, and the miner then answers "no e2e failure line".

It prints a case literal. It refuses a step that passed, a leg that is not in the log, and a leg that
the pack skipped — each with its own reason, because "absent" and "did not fail" send the reader to
different places. `--step` and `--leg` also select the evidence shape, so naming both is refused
rather than resolved.

### 4. Write the judgement yourself

🔴 **The miner never writes `expected`, `corrected` or `signal`.** It leaves them empty. A signal is
the claim "this text, joined to these rows, IS the defect", and no script can read a trajectory and
make that claim. The bench refuses an empty signal, so an unfinished case cannot reach the bench by
being pasted and forgotten.

Write the corrected turn from the transcript where the evidence holds one — a worker's own correct
prose, an earlier reply of the seat's in the same session. Where it does not, author the control and
set `correctedIsAuthored: true`, so a reader can tell the two apart.

### 5. Paste it into the bench and run the test

Add the case to `FAMILY_BENCH` and run `npm run test:family-bench`. A red says the signal does not
discriminate. Fix the signal, never the check.

🔴 **Read what you paste.** A transcript holds member content. The case becomes a tracked file, and
this repository is source-open. Cut anything that names a real person, a room, or a credential. The
bench's existing cases quote product prose and audit rows only.

## Scoring a later transcript

```
cd packages/core
npx tsx scripts/eval/mine-family-case.ts --evidence <run>/e2e.log --family delivery --leg J-GH --json > turn.json
npx tsx scripts/eval/family-bench.ts --score turn.json
```

`--score` prints `defect` or `clean` for every case in that family and a count. It exits 0 either
way: the exit code says the file was readable, never that the turn was good.

🔴 **`--score` reaches fewer cases than the bench holds.** The miner derives `conduct` and
`member_outcome` from a soak line, and `member_outcome`, `reply_rows` and `within_budget` from an
e2e log. A case whose signal reads any other fact — `reply_verb`, `engagement_state`, `tool_ok`,
`names_boundary` — can never fire on miner output, because the scorer ANDs the facts and the key is
simply absent. Today only the `delivery` case scores automatically; the other three are scored by
hand against a transcript. Each new derived fact is a change to the miner.

## What the bench holds today

Four cases, one per family that had a mineable transcript in this tree on 2026-09-11.

| Case | Family | Mined from |
|---|---|---|
| `wake-engaged-thread-declined` | `wake` | OPE-1673, F-EDIT |
| `tool-use-attachment-ref-is-a-filename` | `tool-use` | OPE-1686, F-ART |
| `grounding-refusal-cites-the-harness-not-the-boundary` | `grounding` | OPE-1688, S-PR-BOUNDARY |
| `delivery-reply-timeout-member-got-nothing` | `delivery` | OPE-1704, cadence pack 2026-09-10, J-GH |

`containment` is the fifth mineable family and has no case. Its recorded example (OPE-1680, a Slack
click branch that read no tenant) is host-side, and no turn saw the wrong decision. It gets a case
the day a containment red leaves a transcript.

## What this does not do yet

- **Nothing archives a case.** OPE-1703 asked for a case to retire after N straight passes. That
  half did not ship and the ticket is closed: the bench has no run history to count, so the rule is
  not implemented and no field pretends it is.
- **The transcripts are ours, not a user's.** Soak and e2e drive this deployment. The value of a
  mined bench arrives with real-user transcripts, which this deployment does not have. The shape
  takes them without a change: a real transcript reaches `--score` the same way an e2e log does.
- **The e2e red report still reports a red as free text.** For a SOAK red, step 1 of the recipe is
  now a lookup: `oe-soak-reviewer.agent.md` requires a `family` on every red row and the run's
  report carries `familyCounts` (OPE-1787). An e2e red has no such field, so a red from the live
  pack is still triaged by a human read.
- **One case's pack number is unsettled.** The tracked records of the `tool-use` red disagree:
  `docs/dev/failure-families.md` names one live run, and an older record names a different one. The audit row
  is identical in both, so the case stands and its `run` field names the disagreement rather than
  picking a side.
