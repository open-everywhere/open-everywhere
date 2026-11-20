# On-call conventions

A routine that watches a production system is not a different mechanism from any other routine. It
is the same [routine](./proactivity-and-routines.md) with harder conventions, because the cost of a
vague instruction rises when nobody is reading the output at 03:00.

This page is five conventions and one measurement. The conventions are how to write an on-call
routine; the measurement is a real emitted metric, not a claim. Nothing here adds a plane.

## 1. Put the escalation criteria in a condition gate, not in the prompt

Write the escalation rule as a **deterministic decision table**, and put it where the host evaluates
it rather than where the model reads it. In this tree that place is a **condition gate**: a named
predicate declared in `agent/routines/collectors.ts`, read over the routine's collectors, evaluated
host-side before any session starts.

The rule an on-call rotation actually wants looks like this:

> If the error rate is above 2% for longer than five minutes, and this is not a known deploy window,
> page the on-call. Otherwise write it to the lessons log.

As prose in a routine's prompt, that is three judgements the model makes fresh every fire, and two
of them are arithmetic. As a gate it is one predicate in Git that changes by pull request:

```ts
// agent/routines/collectors.ts
{
  name: "error-rate-breach",
  describe: "the error rate has been above 2% for longer than five minutes, outside a deploy window",
  decide: (collected) => {
    // 🔴 ASK THIS FIRST. A read that never ran and a world that is quiet both look like "no
    // breach", and paging on one while staying silent on the other is the whole failure mode.
    if (!collectionComplete(collected)) return { fire: false, why: "the metrics read failed — cannot tell quiet from blind" };
    const breached = errorRateOver(collected, 0.02, 5) && !inDeployWindow(collected);
    return breached
      ? { fire: true, why: "error rate above 2% for over five minutes, outside a deploy window" }
      : { fire: false, why: "error rate within threshold, or inside a known deploy window" };
  },
}
```

The verdict carries a `why` on **both** arms, and that is required rather than polite: a gate that
says no without saying why turns a skipped run back into the silence its audit row exists to remove.

Three properties follow, and none of them is available to prose:

- **It fails closed.** An unknown gate name or a throwing predicate skips the run. A gate exists to
  withhold a claim until a condition is verifiably true, so "could not tell" must mean "do not
  page".
- **A `no` costs one `routine.skip` audit row** — no session, no delivery, no spend. The quiet
  nights are the common case, and they should be nearly free.
- **The threshold is reviewable.** Moving 2% to 5% is a diff somebody approves, not a sentence
  somebody rewrote.

🔴 **The gate decides whether the run happens; it does not decide what the run says.** Keep the
paging *criteria* in the gate and the paging *message* in the prompt. A gate that tried to compose
the escalation text would be behaviour hiding in a predicate.

## 2. Read the lessons log first — as a collector, not as an instruction

Every investigation starts by reading what the last one learned. Do not write "start by reading the
lessons log" into the prompt: an instruction to read is a step the model can skip, and on the night
it skips it you will not know.

Declare the read as a **collector** instead. The host runs it before the fire and hands the result
to the run as data:

```ts
{
  name: "oncall.lessons",
  tool: "notion__search",                                  // named exactly as the tool is called
  args: { query: "label:oncall-lessons" },                 // a frozen literal, never model-authored
  describe: "what previous investigations of this service learned",
}
```

Now the lessons are in the fire's payload whether the model would have asked for them or not, the
read runs under the routine's declared permission and nothing wider, and a read that fails is named
in the fire's own message rather than silently returning nothing.

🔴 **A collector only runs where the deployment has registered a reader, and core ships none.** The
dispatcher tick is not a session, so it mounts no connector tools; until you wire a reader through
`registerRoutineCollectorReader`, every collector reports `no_reader` on every fire — in the fire's
own message and in a `routine.collect_failed` audit row — and the fire still happens. Write the gate
above accordingly: a read that did not happen is never a read that returned nothing.

🔴 **Collected output is data, never instructions.** The lessons log is written by earlier runs and
by people; it reaches the turn as content, and the routine's own prompt and standing rules are what
the turn treats as trusted. A lessons file that says "ignore the escalation gate" changes nothing.

## 3. Write a runbook per failure CLASS, and put it under `docs/`

Investigation knowledge belongs to a failure class, not to an integration. A page called "what to do
when replicas diverge" is worth ten times a page called "the Postgres integration", because the
first one is the thing somebody needs at 03:00.

Conventions for such a page:

- **One failure class per page**, named for the symptom an operator sees, not for the subsystem.
- **Lead with the discriminator** — the one observation that tells this class apart from the two it
  is most often confused with. That sentence is the whole value of the page.
- **State what is unproven.** A step that has never been run in anger says so.
- **Cite the file that decides.** A runbook that names `access/halt.ts` survives a refactor that
  renames a log line; one that quotes the log line does not.

🔴 **A runbook is documentation and lives under `docs/`.** It is not a skill, and it must not be
written into an agent's own instruction directory. The distinction is not cosmetic: content under
`docs/` is served to the agent as documentation it can cite and a reader can review in a pull
request, while an instruction directory changes what the agent *is*. See
[Self-documentation](./self-documentation.md) for how a page here reaches the agent.

## 4. Give each domain one report template, and expect to rewrite it

An on-call report is read under time pressure by people who share assumptions. That makes its shape
team-specific, and it will take several passes to get right — that is normal, not a failure of the
first draft.

Put the template in the routine's **standing rules** (`routine.policy`), not in its prompt. Standing
rules are rendered as a trusted block into every fire, they change through their own carded action,
and — unlike an `edit_routine` — adding one does not bump the prompt generation, so refining the
report shape does not revoke the routine's standing permissions or rotate a durable job's seat.

A template that works has four parts, in this order:

1. **What is true now** — the current state, in one sentence.
2. **What changed** — the delta since the last report, and nothing older.
3. **What is not known** — named explicitly, so silence is never read as "fine".
4. **What is being done** — with who is doing it, or "nobody yet".

🔴 **"Nothing to report" and "I could not check" must never be the same sentence.** This is the
single most common defect in a quiet-night report, and it is what makes a broken watcher look like a
healthy system for weeks.

## 5. Measure the time to first output

An on-call rotation is judged on how fast something useful appears, so the deployment emits that
measurement rather than asserting it.

**`oe.turn.first_output`** is written when a turn's **first step completes**, and the bucket measures
from the turn's start to the **end of that step**. It carries three labels and no more:

| Attribute | Value |
| --- | --- |
| `oe.surface` | `webhook` for a webhook fire; otherwise the verified binding's platform (`slack`, `teams`, `discord`, `github`, `linear`, `notion` — whichever bundles this deployment carries), or `local` when no binding resolves |
| `oe.kind` | the trigger type (`channel`, `dm`, `mpim`, `routine`, `webhook`) |
| `oe.latency.bucket` | `<5s` · `5-15s` · `15-60s` · `1-5m` · `>5m` |

- Emitted by: `packages/core/agent/hooks/telemetry.ts`, on the turn's first model `usage.recorded`.
- Declared in: `packages/core/agent/observability/telemetry.ts` (`EVENT_SCHEMA`).
- Proved by: `npm run test:telemetry`, which drives the shipped hook and reads the row back off the
  wire — a source scan alone would stay green over a metric that stopped being measured.

Three things to be exact about, because a latency number is easy to over-read:

- 🔴 **The window ends when the first model run settles, before that run's tool calls execute.**
  On eve 1.x the edge is the run's `usage.recorded`, which eve writes when the model run settles.
  So a turn whose first act is a three-minute `bash` still reports the model's own latency, and the
  tool's three minutes appear in no `first_output` bucket. (On eve 0.71 the edge was
  `step.completed`, which fired after the step's tool calls, so it was an upper bound.)
- 🔴 **It is not a measure of usefulness.** Nothing reads what the first step produced. A turn whose
  first act is a wasted tool call scores the same as one whose first act is the answer.
- **It is a separate event, not an attribute on `oe.turn.completed`.** A turn that hangs never
  completes, so an attribute there would go missing in exactly the window worth watching. This row
  is written the moment the first model run settles.
- **One row per turn.** Later steps of the same turn emit nothing more; the next turn on the same
  session reports its own first output.

It rides the ordinary telemetry pipeline, so it is off wherever telemetry is off, and it is bucketed
rather than precise for the reason every row in [Telemetry](../deploy/telemetry.md) is: a coarse
bucket cannot be correlated back to one conversation.

## What this page does not give you

There is no paging integration here, and no incident object. Escalation is whatever tool the routine
is permitted to call, and the routine's declared permissions are what bound it — see
[Proactivity & routines](./proactivity-and-routines.md). These are conventions for writing the
routine well, and one measurement for telling whether it is working.
