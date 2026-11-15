# Drop-in arms

An **arm** is a decision function on a seam. Open Everywhere ships one for every such seam —
the **built-in arm** — and lets the consuming deployment drop in its own **consumer arm**
beside it. The pair is not a switch. There is no ON and no OFF: what exists is the built-in
alone, or the built-in plus what a consumer added to it.

This page defines the pattern once. It is the decision half of the
[adapter model](./adapter-model.md): an adapter swaps a *backing* (which database, which
sandbox), while an arm extends a *judgement* (what counts as a secret, how consequential an
operation is). Both are seams on the same fixed spine.

🔴 **Say "arm", never "classifier".** In this repo a
[classifier](../glossary.md) is a specific, code-only thing, and reusing the word for the
extension point would put "a model decides" back into a term the glossary pins to
deterministic TypeScript. An arm may BE a model consult; a classifier may not.

## The five rules

**1. A seam slot is an optional function on `AppConfig`.**
`packages/core/agent/access/config.ts` is the registry the app fills at startup. An arm is one
more optional member on it, beside `loadModelPolicy`, `loadPrincipals` and the rest. No new
registry, no new arming step, no plugin loader. The consumer writes a function in its own repo
and registers it; core never imports consumer code.

**2. The built-in is the default arm, and its absence is not a state.**
A deployment that registers nothing gets the built-in, byte for byte. There is no "unconfigured"
behaviour distinct from the shipped one, so adding a seam slot can never change what an existing
deployment does. This is what makes a seam safe to introduce: the diff that adds it is provably
a no-op until somebody registers an arm.

**3. An arm may raise freely; a seam that lets it lower states the floor it lowers to.**
The built-in runs first. On the audit scrub the arm sees the built-in's result and the shape is
**add-only** — one degree of freedom, one safe direction. On a seam that answers a *verdict* there
are two, and the seam has to choose. Do not read "answers text" as "add-only": the result-reducing
seam answers text too, and its arm REPLACES the body rather than adding to it. What decides the shape
is the property the seam protects (no credential survives; no result grows), not the return type.

🔴 **The tiering seam lets an arm lower, and floors the lowering at `write`** (ruled). The
reasoning is worth carrying to the next verdict seam. The shipped classifier is itself the thing that
loosens — its read-verb list is what puts `get`/`list`/`search` in the open tier at all, and its own
default is `destructive`. So "raise-only" was a default posture, never a principle. What IS a
principle is that a human sees a card at least once for every op an arm LOWERED. Hence the floor: an arm may
move `destructive` to `write` (a card a routine may lift with a declared permission) but never to
`read` (no card at all). The worst a buggy or hostile arm can do is let a routine declare an op that no
declaration could lift before.

Pick your seam's floor the same way: name the outcome that must survive any arm, and clamp to the
weakest verdict that still delivers it.

🔴 **"Abstains" is a fact about the built-in, and the built-in has to SAY it.** A fail-closed default
is an abstention wearing an answer's clothes: the connector-op classifier returns `destructive` both
for a verb it knows to be irreversible and for a verb it has never seen. Those are different facts.
A seam that cannot tell them apart cannot explain, in its audit row or its docs, which of the two an
arm overruled. So before you compose an arm on a verdict seam, give the built-in a way to report WHY.
The tiering seam's `OpTierBasis` is that report, and it had to be built first
(`packages/core/agent/access/consequence.ts`).

**4. Enforce the floor; do not trust the arm.**
A rule an arm could break by being wrong is not a rule. Build the seam so the unsafe move is
unreachable. There are two shapes and the seam picks one:

- **Re-apply the built-in over the arm's output**, and hand the arm the already-narrowed input, so it
  cannot widen what it never received. The audit scrub does both. This works only where the built-in
  never abstains: on a seam whose built-in abstains, a second pass would restore the very answer the
  arm was asked to replace.
  🔴 **The two halves are separable, and the result-reducing seam takes only the first.** It hands
  the arm the RAW body, because narrowing first would defeat the point — a reducer asked to summarise
  a truncation has already lost the text it was meant to keep. Re-application alone still enforces
  that seam's floor, because the property is LENGTH and `capResult` shrinks whatever it is given. Ask
  what the re-application enforces before you decide whether the arm may see the raw input;
- **CLAMP the arm's answer in the composer.** The tiering seam does this: an arm's lowering is lifted
  to `ARM_TIER_FLOOR` before anything reads it. The clamp is not a re-application of the built-in — it
  is a floor on the arm's own output, so it survives the built-in abstaining.

Either way the enforcement is in the SEAM, never in the arm. A rule an arm applies to itself is not a
rule: write a tiering function that answers what it believes, and `connector-op-arm-test.ts` pins
that the seam floors an arm answering `read` over every base tier.

🔴 **A clamp is not a substitute for flooring the CONSUMERS.** The tiering seam does both, and each
catches something the other does not. The clamp stops an arm reaching the open tier. It does not stop
an arm reaching `write`, which is the tier an unattended fire can LIFT with a standing routine
permission. So the two unattended surfaces read the built-in
too, and the approval fence engages on an arm's lowering rather than only on a raised card. Enumerate
the consumers that treat the seam's answer as permission, and decide for each whether the clamped
answer is safe there.

🔴 **State the floor exactly, and no wider.** A floor covers the specific thing the built-in
recognises. It does not make an arm harmless. The audit scrub guarantees that no credential shape
the built-in knows survives an arm; it does NOT stop an arm from adding, replacing or deleting
other text, because the arm's return value is what the seam returns. A doc that rounds that up to
"an arm can only make things safer" tells a consumer's reviewer not to read the arm. Write down
what is enforced and, next to it, what is merely expected of a well-written arm.

**5. Fail closed to the built-in.**
An arm that throws costs nothing but itself. The seam catches, keeps the built-in's answer, notes
the failure once, and carries on. A consumer's drop-in is never allowed to break the operation it
was extending. An arm is not a place to fail loudly: the built-in is already a correct answer.

## A model arm is just an arm

A **model arm** is a drop-in function that happens to call a model. It is not a separate
mechanism and it gets no extra powers: it composes under rule 3 and fails closed under rule 5,
exactly like a hand-written one. The precedent is the
[approval judge](../glossary.md) — a model that runs only on the residue an operator deferred to
it, and every failure of which resolves to `ask`.

The one thing that decides whether a seam can host a model arm is **when the consult happens**, not
whether the slot is async. There are two shapes. The result-reducing and wake seams consult per call
and ship that way; the definition-time shape is described here because it is what a consumer must
build on a synchronous seam, and this repository ships no instance of it:

- **A per-call consult** needs an async slot and every caller awaiting it. Adding one to a seam that
  is synchronous today is a change to that seam, not a property of this pattern — and the
  result-reducing seam paid exactly that price (`ingestUntrustedModelOutput` became async, and its
  callers await it).
- **A definition-time consult** needs nothing from the seam at all. The model is asked once per
  distinct subject, at the moment the subject is *defined*; the answers fill a cache; the arm on the
  slot is a synchronous cache read. A subject the consult never covered abstains — which is the
  built-in, so the seam's own failure contract already covers it.

**The SUBJECT decides which shape a seam may take, not taste.** A definition-time consult needs
subjects that are enumerable ahead of time and that repeat: the tiering seam has them (a connection
exposes a fixed list of op names, and the same names recur for the life of the process), which is why
its slot can stay synchronous and still host a consumer's model-backed function. The result-reducing
seam has the opposite subject: one arbitrary result body, minted fresh per read and never repeated.
Nothing to enumerate, nothing a cache could key on. So it consults per call, and it pays the
wall-clock — bounded by a timeout — for the privilege. Ask what the subject is before you choose.

## The worked instance: connector-op tiering

The seam this pattern was written for (OPE-1321). It is the one that shows the defer rung doing real
work, because its built-in genuinely abstains on some inputs.

**What it decides.** How consequential one connector op is — `read`, `write` or `destructive`. That
tier decides whether the op takes an approval card, and whether a routine's declared permission may ever lift it
(`packages/core/agent/connections/connector-auth.ts` `connectorOpApproval`).

**The built-in arm.** `classifyConnectorOpTierVerdict`
(`packages/core/agent/access/consequence.ts`) — three reviewed verb lists, scanned over the verb
segment, failing closed to `destructive`. It returns a tier AND an `OpTierBasis`: `destructive-verb`,
`write-verb`, `read-verb`, or `unrecognised`. Since 2026-10-10 it also takes the org-admitted MCP
server's own tool annotations (`readOnlyHint`, `destructiveHint`) as a second source: a hint decides
where the name is `unrecognised`, and where the name named a verb the stricter of the two wins
([Connectors](../capabilities/connectors-and-providers.md#raising-an-operations-tier)). The verdict
then carries `hint` and `hintDecided`, and `connectorOpTierParts` reports both.

**The slot, and it ships FULL.** `AppConfig.connectorOpTier?: ConnectorOpTierArm` — one tiering
function, `(op: { connection, verb, toolName, hints? }) => ConnectorOpTier | undefined`. `hints` is
present when the seam read the server's annotations for that op.

🔴 **The default is a registered value, not a fallback.** `registerConfig`
(`packages/core/agent/access/config.ts`) puts `defaultConnectorOpTierArm`
(`packages/core/agent/access/consequence.ts`) on the slot when a deployment supplies none. That
function IS the verb classifier above, wearing this signature — get/list/search are `read`,
create/update are `write`, an unrecognised verb is `destructive`. So the slot always holds a tiering
function of the type a consumer would write, and "what tiers my connector ops?" has one answer a
consumer can read off the config, call, and wrap.

**Supply your own tiering function to REPLACE it.** A deployment that runs a vendor whose ops our
lists do not know writes a function of the same type and registers it:

```ts
registerConfig({ ...appConfig, connectorOpTier: (op) => myTiers[op.verb] });
```

To extend rather than replace, call the default from your own and answer only for the ops you know:

```ts
registerConfig({
  ...appConfig,
  connectorOpTier: (op) => myTiers[op.verb] ?? defaultConnectorOpTierArm(op),
});
```

**A model-backed tiering function is yours to write.** This repository ships none, and no transport
for one. The slot is synchronous (see the contract below), so a model consult cannot happen inside
it — a consumer that wants one asks the model ahead of the call, caches the answers, and registers a
function that reads the cache. Everything about that design is the consumer's: what to consult, when
to prime it, what a cache miss should answer. The seam gives such a function no extra power and no
extra scrutiny — the `write` floor below is the same clamp for every tiering function.

**🔴 The composition, and the one clamp that carries it.** `connectorOpTierParts`
(`packages/core/agent/access/connector-op-gating.ts`) applies the arm's answer like this:

- **a raise passes through as given.** The arm answered at or above the built-in and nothing is at
  stake;
- **a lowering is floored at `write`** (`ARM_TIER_FLOOR`). `notion__delete_page` can be moved from
  `destructive` to `write` by a reviewed arm — from a card no declaration lifts to a card a routine
  may declare. It cannot be moved to `read`. `acme__frobnicate_widget`, which the built-in never
  recognised, lands at `write` the same way instead of being gated per call forever;
- **an arm answering `read` about an op the built-in already opened moves nothing.** The floor clamps
  lowerings, not agreement — clamping the raise branch too would push every open op to `write` the
  moment any arm was registered.

The clamp is in the SEAM, not in any arm. That is deliberate: an arm is consumer JavaScript, and a
rule an arm applies to itself is not a rule. Write a tiering function that answers what it believes;
`packages/core/scripts/connector-op-arm-test.ts` pins that the seam floors an arm answering `read`
over every base tier.

**The default never exercises any of this.** It answers the built-in verdict, so the composition
joins that verdict with itself and nothing moves. That is why filling the slot changed no tier.

An operator's `Bundle.connectorOps` declaration runs LAST and stays raise-only, so a consumer's arm
can never undercut one.

**The basis is now a report, not a gate.** `OpTierBasis` had to exist before the seam could have a
defer rung at all, and the ruling then made the rung total. What the basis still does is separate the
ruling's two buckets in the audit row: `unrecognised` means the built-in abstained, any other basis
means the arm overruled a verb the built-in knows. A `connector.op` row stamps `opTierArmLowered` and
`opTierBasis` together, so "which ops has this deployment's arm talked down, and were any of them
real deletes?" is one query. A row stamps `opTierArmReplaced` when the deployment replaced the
default tiering function — not that an arm ran, which one always does.

**🔴 The floors, and they are not on this seam.** An approval card is only a control when somebody is
there to see it, and `write` is exactly the tier an unattended fire can LIFT with a standing routine
permission. So nothing unattended reads the arm's answer alone. There are **two** such surfaces, and
both had to be floored — one is not a special case of the other:

- `allowedOnRestrictedJobWake` (`packages/core/agent/access/job-posture.ts`) keeps calling the PURE
  built-in. It decides which tools a restricted **job** wake may hold at all. It runs only for a
  `sessionMode:"job"` routine;
- `withUnattendedConnectorFence` (`packages/core/agent/connections/connector-auth.ts`) takes the
  **join** of the built-in and the seam. It covers **every** unattended fire, an ordinary routine
  included, and it is the only floor those fires get.

Note the asymmetry with the operator's declarations: those could only ever narrow these sets, so
keeping them out was tidiness. An arm can go lower, so keeping the arm out is load-bearing.

**What this seam guarantees, exactly:** `effectiveConnectorOpTier` answers `read` only where
`classifyConnectorOpTier` already did, so no arm can move an op into the open tier; no arm can
undercut an operator's declared raise; and no arm can lift an op on an unattended fire, on either of
the two surfaces above. A human sees a card at least once for every op an arm LOWERED — an arm that
agrees with an op the built-in already opened has moved nothing, and that op stays open.

**What it does not guarantee: that the card is the right card.** An arm that lowers a real delete to
`write` lets a routine declare the delete on its creation card, and that one click then lifts every later delete on the routine's fires. That is the
power the slot grants, deliberately, and it is weaker than the built-in's promise. Review an arm as
you would review the verb lists themselves.

**And it does not re-tier a grant that already exists.** The credential-grant plane writes an op's
tier onto the grant row when the grant is minted and never re-derives it
(`packages/core/agent/operational/credential-grant-rows.ts`). An arm that answers differently
tomorrow does not move a live grant. Re-tiering one means revoking it and minting a new one.

**Failure.** Abstention in three forms, all leaving the built-in verdict standing: a deliberate
`undefined`, a return outside `read | write | destructive`, and a throw. The last two log one note per
call. The runtime vocabulary check is not ceremony — the slot is typed, but an arm is consumer
JavaScript, so a typo'd `"Read"` must resolve to the built-in rather than to a tier nothing can rank.

**The contract on the arm: pure, fast, no I/O.** It runs inside eve's synchronous connection approval
callback, on the hot path of every connector op, and the callback sits inside a `turnStep` body that
re-executes on redelivery — so an arm with a side effect performs it more than once per op. Memoise
per distinct `toolName` per process.

**One tiering function, one deployment.** `AppConfig` is process-global, so there is no per-scope,
per-bundle or per-domain arm. An operator who wants an op tiered differently in one place raises it
with `Bundle.connectorOps`, which composes after every arm.

The proofs are in `packages/core/scripts/connector-op-arm-test.ts`
(`npm run test:connector-op-arm`), including the default-arm case this deployment actually runs and
the identity pin that the default IS the registered slot value.
`npm run test:drop-in-arms-unregistered` is the app-tier half: it asserts this deployment's
registered `AppConfig` supplies no arm of its own — every empty slot still empty, and the tiering
slot holding exactly `defaultConnectorOpTierArm` — so "with no consumer arm" is what actually ships.
It keeps that claim total by reading the `AppConfig` interface source and pinning the whole set of
optional members, so a future seam cannot add a slot without the test reding and forcing somebody to
classify it.

## The smallest instance: the audit scrub

The smallest seam in the tree, and the reference implementation of all five rules.

**What it decides.** `auditErrorDetail`
(`packages/core/agent/audit/tool-action.ts`) reduces a caught error to the one short, scrubbed
line an audit row carries. An upstream error string is provider-echoed and
attacker-influenceable, so it is treated as untrusted text, and a credential shape a provider
echoes back must not land in our own audit store. The writers OPE-2545 swept go through it, so an
arm reaches their rows. `npm run lint:audit-error-detail` refuses a writer that
it can see skipping the reducer (OPE-2545), and `typecheck:all` refuses unscrubbed text under an
error-named key (OPE-2549). The lint is a text scan with named limits
([Audit & provenance](../security/audit-and-provenance.md#inside-the-append-path)), so an arm is
not a promise about every row.

**The built-in arm.** `SECRET_SHAPES` — five prefix-anchored regexes covering the credential
families this deployment holds (`Bearer`, `sk-`, `xox*-`, `gh*_`, `AKIA`). Conservative by
design: a false negative costs a leaked-looking token in our own store, a false positive costs
one struck word of diagnostic text.

**The slot.** `AppConfig.auditScrub?(text: string): string`. A deployment that holds a credential
family the built-in does not know — an internal key prefix, say — registers a function that
strikes it.

**How the floor is enforced.** The seam composes built-in → arm → built-in:

- the arm receives the **already-scrubbed** text, so it cannot restore a span the built-in struck.
  It never receives one. This is rule 4's first half, and it is structural — no check to get
  wrong;
- the built-in runs **again over the arm's output**, so an arm that writes a credential shape into
  its result — restoring one it guessed, or synthesising a new one — gets it struck.

The second pass is safe because the built-in is **monotone**: it can only strike more text, never
restore any. It is *not* idempotent, and the difference matters enough to write down. The
replacement inserts `[` and `]`, which are non-word characters, so it can manufacture a `\b`
position the input did not have: `AKIA123456789012bearer aaaaaaaa` scrubs to
`[redacted]bearer aaaaaaaa`, and a second pass takes that to `[redacted][redacted]` — the `]`
supplies the word boundary the `Bearer` shape needs. Monotone is what the floor rests on. Do not
restate it as idempotence, and do not promise a pass-through arm is byte-identical to no arm.

**What this seam guarantees, exactly:** no span matching the built-in's credential shapes reaches
the audit row, whatever the arm does.

**What it does not guarantee:** anything else about the text. The arm's return value is what the
seam returns, so an arm may add, replace or delete non-secret text, and may return the empty
string. The natural convenience arm — `text => text + " ctx=" + JSON.stringify(diagnostics)` — puts
that bag in the audit store checked against five regexes and nothing else, which is exactly the
family of secret this slot exists because the built-in does not know. Write an arm that only
redacts, and review one as you would review any code that writes to the audit store.

**Where the arm sits in the pipeline.** Before the whitespace collapse and the 300-character
truncation. The arm therefore sees the whole message, and cannot widen an audit row into several
lines or past the cap.

**Failure.** A throwing arm leaves the built-in's result standing and logs an audit-side note per
failed call — a consistently broken arm therefore logs on every audited error, which is the
intent: it is a deployment defect, not a condition to ride out quietly. Auditing is best-effort to
its caller by contract, and an arm must never be the thing that breaks an audit write.

The proofs are in `packages/core/scripts/audit-scrub-arm-test.ts`
(`npm run test:audit-scrub-arm`), including the one that matters most for a deployment that
registers nothing: with no arm, the behaviour is byte-identical to the built-in alone.

## The per-call instance: reducing an oversized result

The seam that proves the pattern is general (OPE-1321). It is the first with an **async** slot, and
the first whose arm may be a live model call on the turn.

**What it decides.** What an OVERSIZED tool result looks like by the time the model reads it. A
connector result or a fetched page that arrives at hundreds of KB cannot enter the context whole —
something has to choose what survives.

🔴 **Read the REACH before you wire a reducer, because several read tools never get here.** The arm
is consulted only where a body exceeds `tools.maxResultChars` (120,000 shipped) AT THE PROJECTION,
and a tool that bounds its own output in `execute` has already fallen under that:

- the chat reads (`read_channel`, `read_thread`, `read_work_channel`, `read_work_thread`) spool at
  `SEAT_READ_INLINE_CAP` = 12,000 (`agent/channels/read-spool.ts`) — the arm is NEVER consulted;
- `read_notion_page` caps at `MAX_CHARS` = 20,000 (`packages/providers/notion/.../read_notion_page.ts`)
  — never consulted;
- `web_fetch` is bounded by EVE, not by us, before its body ever reaches the projection: the fetch
  execution truncates at `MAX_OUTPUT_BYTES` = 50 KiB and `MAX_OUTPUT_LINES` = 2,000
  (`eve/dist/src/execution/web-fetch/execute.js`, via `truncateHead` in
  `execution/sandbox/truncate-output.js`). 50 KiB of bytes is at most 50 K characters, so the
  projection's own check is never true — never consulted. The `(truncated)` in the fence's source
  label is eve's cut, not ours;
`read_file_upload` used to sit in this list and no longer does (OPE-1385). It pre-capped with
`capResult` at the SAME 120,000 and then added a `File: …` header, so it reached the arm only when
its own pre-cap had already truncated — and handed the arm that truncation, marker and all. The
pre-cap is gone. The download's own 5 MB byte cap is what bounds the output object, and the untrusted
funnel is the one place this route meets a context bound.

What DOES reach the arm with a whole body: connector and MCP results
(`access/untrusted-projection.ts`), a BORROWED grant's result (`tools/grant_tools.ts`, a separate
composition entry), the `browser_*` family, `read_routine_transcript`, `read_webhook_history`,
`list_recent_events`, `read_file_upload`, and the two work-surface readers `read_linear_issue` and
`read_notion_comments` — which bound a comment COUNT, not a character budget, so a few long comments
still arrive whole. Those are the routes a reducer actually serves.

**The built-in arm.** `capResult` (`packages/core/agent/access/result-cap.ts`) — a head/tail
truncation, 80% head, with a marker in the middle reporting how many characters were dropped of how
many. The whole deployment lever today is one number, `tools.maxResultChars`. A consumer who would
rather SUMMARISE a huge page than keep its first 80% has no way to say so, and that is the gap.

**The slot.** `AppConfig.reduceResult?(body: string, limit: number, ctx: { source; toolName? }):
string | undefined | Promise<string | undefined>`. `limit` is the ceiling the answer must
respect. `ctx.source`
names the composition site; `ctx.toolName` is the ingestion label the call site declared
(`read_routine_transcript`, `browser_navigate`, a connector tool name) — OE's own string, never
vendor text.

**🔴 The arm is asked ONLY where the built-in would act.** A body at or under `limit` is returned
untouched and the arm is never consulted. This is the tiering seam's abstention rung inverted: there,
the built-in says when it has no real answer and the arm fills the gap; here, the built-in has a
perfect answer for every under-limit body — the body itself, byte for byte — so there is nothing to
defer. It also bounds what a model arm costs to the results that were about to be truncated anyway.

**One composition site, and the other callers keep the built-in.**
`ingestUntrustedModelOutput` (`packages/core/agent/access/untrusted.ts`) is the only place the arm
runs. It is the tool-result projection every read tool, connector result and MCP result rides, and it
is the one `capResult` caller that can await: eve types `toModelOutput` as
`ToolModelOutput | Promise<ToolModelOutput>` and awaits it on every path. The other callers of the
built-in are synchronous and stay on it:

- `agent/tools/read_docs.ts` caps inside `execute`, to bound the output object itself, and ends
  there: its content is this repo's own documentation, it declares no `toModelOutput`, and so it
  never reaches the composition site at all;
- `agent/channels/wake-envelope.ts` caps an unfenced wake body in the INGRESS process, outside any
  turn;
- the string-in, string-out funnel (`wrapUntrusted` / `ingestUntrusted`) keeps its own built-in cap,
  which is what `agent/webhooks/dispatch.ts`, `agent/access/aws-output.ts` and the Slack join-intro
  render use;
- `hostAuthoredModelOutput` keeps the built-in too, and that one is a judgement rather than a
  constraint: its whole contract is that the body holds no bytes from outside the trust boundary, so
  there is no external content for a consumer's reducer to have an opinion about.

So a registered reducer governs TOOL RESULTS, and nothing else. Making the render-time sites async
would mean changing call sites in `packages/providers/**` for a body no model reducer was asked to
shorten. State this to a consumer plainly: the seam is not "every oversized string in the process".

**🔴 The floor, and it is exactly one property.** THE SIZE BOUND. Whatever the arm returns goes back
through `capResult(out, limit)` in the composer, so no arm can produce a result LONGER than the
built-in would have. That is rule 4's first shape, and what makes the second pass safe is the real
bound `capResult` holds: **`capResult(x, limit).length ≤ max(limit, markerLength)`**, so it shrinks
every string longer than that and can never grow one at any usable limit.

🔴 **State it that way and not as "it only ever shrinks", because the short version is false.**
`result-cap.ts` documents the exception itself: a `limit` below the truncation marker's own length
floors the budget at 0 and returns the MARKER ALONE, which is longer than a 10-character input.
`tools.maxResultChars` validates only that it is a positive integer, so an operator can set 10. The
composed output is still bounded, so no arm gains reach — but a seam author who copies "monotone,
therefore safe to re-apply" onto a built-in without this shape gets a floor that does not hold. The
shipped 120,000 is far above the marker, which is what makes the bound uneventful here.

An arm that answers over the limit is re-capped rather than rejected — and noted, because an arm
handed its own limit should respect it.

**What this seam guarantees, exactly:** no arm can make a tool result larger than the built-in cap
allows, and a body under the limit reaches the model untouched.

**🔴 What it does not guarantee: anything about the TEXT.** The arm's return value is what the model
reads. A reducer may summarise, re-order, drop the sentence that mattered, or — being a model —
state something the result never said. The built-in truncation is verbatim bytes plus an honest
count; a summary is neither. (One footnote on that count: when the seam re-caps an OVER-LIMIT arm
answer, the marker reports the size of the ARM's answer, not of the original result — the built-in
is capping the text it was handed, and on that one path it was handed the arm's.) The arm runs
INSIDE the untrusted funnel, before the fence, so its
output is still fenced as data and it cannot smuggle instructions past the envelope. It can change
what the answer says. That is the power the slot grants, deliberately.

**Failure.** Abstention in five forms, all leaving the built-in's truncation of the ORIGINAL body
standing: a deliberate `undefined`, a throw, a timeout, a non-string, and the empty string. The empty
string is on that list because a result body is the tool's whole answer — an arm that blanks it
leaves the model an empty fence with no sign anything was dropped. The last four log one note per
call, the same shape and the same reasoning as the tiering arm's; a deliberate `undefined` notes
nothing.

**The timeout is the price of a per-call consult.** One consult gets `resultArmTimeoutMs()` — 8
seconds, the same budget `agent/identity/account-directory.ts` gives its async arm. The identity
plane's other arm is tighter: `agent/identity/account-display-name.ts` allows 3 seconds. A hung arm
therefore costs that bounded wait plus the built-in truncation. Note one mechanical difference worth
copying: this seam CLEARS its timer rather than `unref`-ing it. An unref'd timer never fires in a
process with nothing else pending, which turns a hung arm into a hang instead of a timeout.

**The model arm.** `reduceResultFromCompletion` (`agent/access/result-reduce-model-arm.ts`) is the
shipped building block: a summariser prompt, a hard character budget, and an abstention whenever the
answer is empty or over the limit. **Nothing registers it.** It refuses an over-limit answer rather
than letting the seam re-cap it, and the reason is worth stating: a truncated summary is worse than a
truncated result, because it lost both the tail AND everything the summariser dropped. The body
reaching the prompt is clipped at this arm's own ceiling, `MAX_PROMPT_BODY_CHARS` (200,000 in
`access/result-reduce-model-arm.ts`) — above the seam's `tools.maxResultChars` (120,000), so a
multi-MB read does not become a multi-MB model call, and the summariser sees the truncation marker
rather than a silent prefix.

**🔴 The body in that prompt is the untrusted content itself.** This seam's whole subject is external
text, so a page can address the summariser directly. The prompt says to treat it as data and that is
not a defence. What bounds the damage is where the arm sits: a fully successful injection chooses the
summary of its own page, and that summary still reaches the model inside the untrusted fence. A
deployment that cannot accept "an attacker writes the summary of their own content" should not
register a model reducer.

The proofs are in `packages/core/scripts/result-reduce-arm-test.ts`
(`npm run test:result-reduce-arm`), including the no-arm case this deployment actually runs — the
funnel's render is byte-identical to the built-in cap plus fence — and the two that pin the rules
above: an arm that is never consulted for an under-limit body, and an over-limit answer that the
built-in re-caps.

## The additive instance: the wake decision

The seam where the arm can only ADD (OPE-1367). It is the first with a **per-surface contract**, and
the first whose built-in decision is spread across the provider packages rather than living in core.

**What it decides.** Whether an ambient channel message wakes the agent at all. Today the answer is
a name-drop and nothing else: `nameDropPattern` (`agent/channels/turn-delivery.ts`) over the unified
wake token set, gated by the `nameDropWake` domain flag. The whole deployment lever is two token
LISTS — `wake.nameDrop.include` and `wake.nameDrop.exclude`. "Wake when the message is a billing
question" has nowhere to go, and that is the gap.

**The built-in arm.** The name-drop policy: `shouldNameDropWake`
(`packages/providers/slack/agent/channels/slack-events.ts`), a chain of disqualifiers over the
matcher's answer.

**The slot.** `AppConfig.decideWake?(input: WakeArmInput): "wake" | "abstain" | undefined |
Promise<…>`. The vocabulary is CLOSED and there is deliberately no value meaning "do not wake" — see
the floor below.

**🔴 The floor, and it is the shape of the answer.** An arm may ADD a wake where the built-in
abstained. It can never suppress one. That is not a check in the composer that could be got wrong:
`wakeAfterArm` (`agent/channels/wake-arm.ts`) returns true and NEVER CALLS THE ARM where the built-in
already wakes, and the answer type has no third value. This is rule 4's structural shape at its
purest — the unsafe move is unreachable rather than refused.

**🔴 "Abstained" is a fact the built-in has to say, and here it took a helper.**
`shouldNameDropWake` answers `deliver: false` for seven reasons and only ONE is an abstention: the
text does not name the agent. The rest are POLICY — a DM (the mention path always-wakes there
already), a bot author, an `app_mention`, a message subtype, a domain that never enabled the
name-drop wake, and a channel the internal-channel probe could not confirm. `nameDropAbstained`
(same file) is the rung the tiering seam needed `OpTierBasis` for, and it derives the fact from the
built-in rather than re-listing it: it re-runs the policy with the name matched and asks whether the
name was the ONE thing missing. A hand-kept copy of the disqualifiers would go stale the first time
somebody added one, and the arm would then reach a message the policy had just started dropping.

One disqualifier is NOT in that policy's inputs: an unresolved live display name. `deps.displayName()`
failing means no candidate at all, and the render needs that name, so the route gates the arm rung on
it separately. A seam author copying this pattern should look for the same class — a precondition the
built-in's own input type does not carry.

**🔴 The per-surface contract.** A chat surface DECLARES whether it offers this seam the message
text, and which fields. `WAKE_ARM_SURFACE_CONTRACT` (`agent/channels/wake-arm.ts`) is that table,
total over the six chat surfaces, and the composer READS it:

- a surface with `offers: false` never reaches an arm, whatever its route passes;
- an offering surface's `fields` list is what the arm actually receives. The composer builds the
  arm's input from the declaration, so a route cannot widen what an arm sees by passing more.

**🔴 Slack offers it FROM ONE ROUTE, and that route is not every Slack message.** Read this before
wiring an arm and expecting it to fire:

- a domain running the **ambient supervisor** never reaches `routeNameDropEvent` at all —
  `slack-front.ts` diverts it to `routeSupervisorEvent` first;
- a domain whose **`nameDropWake` flag is off** — the shipped default — returns at the domain gate,
  before the arm rung;
- so a registered arm is INERT until some domain turns `nameDropWake` on with the ambient supervisor
  off, and nothing logs to say it is inert. `wakeArmOffered` answers about the TABLE plus the
  registration; it cannot see which route a message is on.

This is the same shape as the result-reducing seam's reach note: the slot is real, and the set of
messages that actually reach it is much smaller than the surface's name suggests.

**Every other surface declines, and the reasons differ.** Slack's `routeNameDropEvent` stages its
gates, so it can report a real abstention. Discord's
`nameDropEligible` (`packages/providers/discord/agent/channels/discord-gateway.ts`) folds the name
match into one boolean and reports no basis — offering the seam there means splitting that function
first, which is its own change. Teams' `resolveTeamsNameDrop`
(`packages/providers/teams/agent/channels/teams-name-drop.ts`, OPE-2444) declines for the same
reason. GitHub, Linear and Notion have no ambient name-drop route at all, so there is no abstention
to fill. Read the table's `note` before assuming an arm reaches a
surface.

**What this seam guarantees, exactly:** no arm can suppress a wake the name-drop gave; no arm can
overturn a policy drop; and no arm is offered a message on a surface that declined the seam.

**🔴 And what runs AFTER the consult, which is a disclosure question rather than a wake one.** The
arm is handed the message text before two gates the route runs later: the spend gate, and the
**external-participant policy** (`applySlackExternalPolicy` — OPE-507/OPE-504), which decides an
excluded author is owed nothing. Neither can be overturned by an arm, so no wake gets past them; but
on a deployment that has opted out to the `envelope` grain (or its deprecated alias `taint`), an excluded author's message text does
reach the arm — and, for a model arm, a model vendor — before that policy refuses it. The tenant
fence is the one moved ahead of the consult, because an unadmitted workspace is the posture that
says no turn may run at any price. A deployment arming this seam should decide whether the external
policy's exclusions are also a disclosure boundary for it.

**🔴 What it does not guarantee: that the wake is WARRANTED.** An arm that answers `wake` for every
message turns the deployment's enabled internal channels into a wake-on-everything surface, at one
judged turn per message. The spend gate still runs after this decision (`slackWakeSpendGate`) and the
turn may still judge NO_REPLY, so the floor is "a budgeted turn ran", not "the bot posted". Review a
wake arm as you would review the token lists themselves.

**🔴 And it does not re-label the wake.** An arm-added wake renders through the same envelope as a
name-drop, so the turn is told `addressing="name-drop"` about a message that never said the agent's
name. The envelope's addressing vocabulary has no case for "an arm asked for this turn", and adding
one reaches the normalized-wake renderers, the scoring fixtures and the e2e legs — so it is a change
of its own. Until it lands, a consumer arming this seam should know the model reads an arm-added wake
as an address by name.

**🔴 No per-message cost number is claimed for a model arm here, and that is deliberate.** This is
the busiest subject any seam in this tree has — one consult per non-name-drop message in an enabled
internal channel. What the seam bounds is the INPUT LENGTH: `WAKE_ARM_MAX_TEXT_CHARS` (4,000
characters) clips the text before the arm sees it, so one consult's input is bounded whatever a
person pastes into a channel. The other bound is the timeout. Everything past that is a deployment's
own traffic against its own model price, and a figure measured on one workspace's channels would not
transfer to another's — **a deployment measures its own cost before arming a model here.**

**Failure.** Abstention in six forms, all leaving the built-in's answer (no wake) standing: a
deliberate `"abstain"`, a deliberate `undefined`, a throw, a timeout (`wakeArmTimeoutMs()`, the same
8 seconds the result-reducing seam gives), a non-string, and any other string. The last four log one
note per call; the two deliberate abstentions note nothing. The runtime vocabulary check is not
ceremony — the slot is typed, but an arm is consumer JavaScript, so a typo'd `"Wake"` must resolve to
the built-in.

The proofs are in `packages/core/scripts/wake-arm-test.ts` (`npm run test:wake-arm`) for the
composer, and in `packages/providers/slack/scripts/slack-engagement-test.ts` for the real route —
including an arm that adds a wake and runs the turn, an always-abstaining arm that cannot suppress a
name-drop, six policy drops an arm never sees, and the no-arm control that still drops a non-name-drop
message before any API call.

## Adding a seam

1. Find the built-in decision and give it a name of its own — a function, not an inlined loop.
   The built-in arm has to be callable before it can be composed. On a verdict seam, check whether it
   can report that it ABSTAINED, separately from its fail-closed answer. If it cannot, add that first
   (the tiering seam needed `OpTierBasis`, and it landed as its own change): a seam that cannot tell
   an abstention from a judgement cannot explain, in its audit row or its docs, which of the two an
   arm overruled.
2. Add the optional slot to `AppConfig`, documenting what the arm may decide and what it may not.
   If the arm may LOWER, name the FLOOR it lowers to and the outcome that floor protects (rule 3),
   and put the clamp in the composer — never in the arm.
3. Write the composer: built-in first, arm second, `try`/`catch` around the arm, then the floor —
   a re-application of the built-in where it never abstains, or a CLAMP on the arm's own answer
   where it does (rule 4).
   Read the config through a lookup that treats "no config registered" as "no arm" — `getConfig()`
   is fail-loud by design, and a pure helper reachable from a script test must not raise there.
   ⚠️ The audit seam's bare `catch` is exact only because `getConfig()` today has exactly one
   throw. If your lookup can fail for a second reason, narrow the catch to the not-registered case;
   a copied bare `catch` would swallow the other failure and resolve silently to the built-in.
4. If you RE-APPLY, check that doing so is **monotone** for your seam — that it can only tighten.
   That, not idempotence, is what makes the second pass safe. If you CLAMP, check the clamp is
   asymmetric: floor the arm's lowering, never its raise, or an arm agreeing with the built-in
   tightens an answer nobody moved. Either way, also enumerate the CONSUMERS: find every caller that
   treats the seam's answer as permission, and decide for each whether the floored answer is safe
   there. The tiering seam found two consumers whose surfaces the clamp alone did not cover.
5. Test the five cases: no arm is byte-identical to today; an arm raises (or adds); an arm lowers as
   far as the floor and no further; an arm that agrees with the built-in moves nothing; a throwing
   arm leaves the built-in standing. Add one test per floored consumer, driven by the worst arm you
   can write.
6. If the seam's decision is made in the PROVIDER packages rather than in core, add a per-surface
   DECLARATION and make the composer read it (the wake seam's `WAKE_ARM_SURFACE_CONTRACT`). A
   surface may decline the seam entirely, and most will: offering it means that surface's route can
   report a real abstention, which is a property of the route, not a choice of style. Declare the
   FIELDS too, and build the arm's input from the declaration — otherwise the table is a comment,
   and one route passing an extra field silently widens what every consumer's arm sees.
7. Say in the docs which seam gained an arm, what the floor covers, and — separately — what it
   does not (rule 4). If a model arm on the seam has a running cost, say what BOUNDS it rather than
   quoting a number you measured on one deployment.
