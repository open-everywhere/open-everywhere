# Models & the AI Gateway

Open Everywhere runs on a **named model stack** through the Vercel AI Gateway: one alias picks
a coherent model for every role at once, and switching stacks is a one-word change. Three ship —
`american-closed` (the default), `chinese-open-weights` and `european-open-weights`. This is one of the
[swappable seams](./adapter-model.md).

## Roles, and the stacks that fill them

Config in this repo refers to a **role**, never a model id:

| Role | Job |
|---|---|
| `primary` | every conversational turn, and the declared subagents |
| `utility` | the dream judge/distiller, mode-3 digests |
| `vision` | `describe_image`'s out-of-band describer — the only role that must be vision-capable |
| `supervisor` | every turn on a seat-shaped token: a standing seat, a task worker (`t/`), a thread seat or a container supervisor. A DM seat runs on `primary`, and a routine that names its own model role overrides this (`isSupervisorSession`) |
| `judge` | the LLM approval judge |

A **stack** fills all five at once. Every model id in the deployment lives in **one file**,
`agent/model/stacks.ts`, and `agent/model/models.ts` resolves the selected stack into the role
consts the rest of the config imports:

| Stack | primary / utility / supervisor / judge | vision |
|---|---|---|
| `american-closed` *(default)* | `openai/gpt-6-luna` | `google/gemini-3.8-flash` |
| `chinese-open-weights` | `deepseek/deepseek-v4.1-flash` | `alibaba/qwen3-vl-instruct` |
| `european-open-weights` | `mistral/mistral-small` (Mistral Small 4) | `mistral/mistral-small` |

The reason the unit is a stack rather than five independent roles is that the interesting
question is "which family of weights is this instance running", and five separate knobs cannot
answer it. Before stacks, the shipped set here was four open-weights roles and a **closed
judge** — so the project's own "runs on open weights" line was wrong about one role, and
nothing in the tree could notice, because nothing expressed the grouping the claim was about.

Coherence is **convention, not validation**. There is no per-id `openWeights` flag and no
import-time check that an "open" stack contains no closed model: the grouping *is* the control,
and a stack that mixes families is visible in one screenful of `stacks.ts`.

`chinese-open-weights` splits vision off the family. Its first pin, DeepSeek V4 Flash 0731, was
text-only. DeepSeek V4.1 Flash (the pin since OPE-2531) passed the vision probe, but
`alibaba/qwen3-vl-instruct` stays until a lane run proves V4.1 as the describer.
`european-open-weights` runs one model in all five roles. Its roles go through the `mistral`
target, so the provider pin and the zero-retention demand travel with the stack (see
[the European stack](#the-european-stack)).
An American open-weights stack is deliberately **absent** rather than stubbed — the open
American checkpoints are not competitive with these three today, and an alias nobody should pick
is worse than no alias. Adding one is an entry in `STACKS`; nothing else changes.

The org **allow-list** in `agent/model/policy.ts` is *derived* from the resolved roles, and the
route pins in `agent/memory/config/domains/<name>.ts` import the role consts. So re-pointing the whole
deployment is one word, and `npm run lint:model-ids` reds the `test` chain on a bare model id in any other
git-tracked file under `agent/`. Three things are out of its reach, by design: the price table
`agent/spend/model-pricing.ts` (it is keyed by model id), the compiled manual (generated into
`@open-everywhere/core`, outside `agent/`), and anything you have not `git add`ed yet. The extracted
plugin definitions under `agent/plugins/generated/` are **in** its reach: they are code, not prose.

### The transcription role: speech to text, with a fallback

The meeting bot's speech to text is a sixth role with a different shape. It names a **primary
route** and a **fallback route**, and each route names its transport as well as its model. A
meeting is other people's speech, so every route must be zero-data-retention, and one provider is
one outage. When the primary route fails (an outage, a refusal, no answer in 40 seconds), the
chunk goes to the fallback route. The table is `TRANSCRIPTION` in `agent/model/stacks.ts`; the
transports are `packages/adapters/agent/model/transcription-routes.ts`.

The same role hears **voice clips** sent to the agent in chat (OPE-2524). The app's
`registerGatewayMeetingModels(…, TRANSCRIPTION_ROLE)` line registers both, so an app that passes its
role needs no other change. A clip is one call along the same primary and fallback routes. See
[Voice clips](../capabilities/voice-clips.md).

| Stack | primary | fallback |
|---|---|---|
| `american-closed` | `microsoft/mai-transcribe-2` through the AI Gateway (Azure, ZDR) | `spacexai/grok-stt` through the AI Gateway (xAI, ZDR) |
| `chinese-open-weights` | `Qwen/Qwen3-ASR-1.7B` on DeepInfra (states zero retention) | `Qwen/Qwen3-ASR-1.7B` on your own server |
| `european-open-weights` | `mistralai/Voxtral-Mini-3B-2507` (Mistral's Voxtral) on your own server | `Qwen/Qwen3-ASR-1.7B` on a second server of your own |
| fully local (`TRANSCRIPTION_PLACEMENT = "local"`) | `Qwen/Qwen3-ASR-1.7B` on your own server | none |

> **These defaults are pending the bake-off.** They follow published word error rates, not a test
> on meetings. `npm run bakeoff:stt -- --live` runs every candidate over AMI Meeting Corpus meetings
> in the bot's own chunking, and scores word error rate, damage at chunk seams, and whether the
> timestamps can place speaker names. It prints the cost of each run. Without `--live` it replays
> the committed recordings in `scripts/fixtures/stt-bakeoff/`. The two self-hosted candidates join
> a live run only when you name your server: `--self-hosted-url` for Qwen3-ASR, and `--voxtral-url`
> for Voxtral, the `european-open-weights` primary. The Gateway serves no Voxtral id (probed
> 2026-10-15), so the bake-off has no Gateway route for Voxtral.

What was checked on 2026-10-12, and what was not:

- Both American ids are `transcription` models with `zdr: "all"` in the public Gateway
  catalogue, on one provider each. The catalogue calls the xAI model "Grok STT".
- A live call to `spacexai/grok-stt` returned one segment per word, with start and end seconds.
  MAI-Transcribe-2 was refused by the test team's Provider Allowlist, so its timestamps through
  the Gateway are not confirmed. A gateway that does not allow `azure` transcribes on the fallback.
- The Gateway serves no Qwen3-ASR model, so the open-weights stack calls DeepInfra directly. Its
  key is the `DEEPINFRA_API_KEY` entry of the secret store (`oe secret set DEEPINFRA_API_KEY`), never
  an environment variable. DeepInfra documents segment and word timestamps; no call was made.
- The self-hosted route expects an OpenAI-compatible `/audio/transcriptions` server (vLLM serving
  Qwen3-ASR) at `http://qwen3-asr:8000/v1`. Change `baseUrl` in `stacks.ts` to point at yours. The
  route asks for word and segment timestamps; whether a given server returns them is not confirmed.
  Use `Qwen/Qwen3-ASR-0.6B` if the 1.7B model is too slow on CPU.
- `openai/gpt-4o-transcribe` and `google/gemini-3.5-transcribe` have no ZDR route on the Gateway.
  They are bake-off baselines only.
- The Gateway lists no Mistral speech model (checked 2026-10-15), and a call to Mistral's own API
  needs a credential this repo does not hold. So the European stack sends audio to your own servers
  only: Voxtral at `http://voxtral:8000/v1`, then the Qwen3-ASR server at `http://qwen3-asr:8000/v1`.
  vLLM serves Voxtral on the same OpenAI-compatible path. No call
  was made: whether that server returns segment or word timestamps is not confirmed. Without them
  the text still arrives, but a recap cannot place speaker names.

🔴 **The `deepinfra` and `self-hosted` routes do not pass through the AI Gateway.** The gateway's
ZDR policy and its Provider Allowlist do not apply to them: meeting audio on those routes goes to
`api.deepinfra.com` or to your own server whatever the gateway says. The control for them is
`TRANSCRIPTION` and `TRANSCRIPTION_PLACEMENT` in `agent/model/stacks.ts`. Only the `american-closed`
routes are inside the gateway's ZDR policy and Provider Allowlist. A `gateway` route carries the rows
of [`models.dataPolicy`](#data-governance-the-data-policy) on every call. With any row set, the
`deepinfra` route refuses, so the audio never reaches it.

The meeting policy's `transcription.model` is not read while the app registers a transcription
role. The approval card's sentence names every route the audio can reach, in order.

### Picking a stack, and overriding one role

| What you want | Where |
|---|---|
| a different stack, reviewed in a PR | `models.stack` in `agent/settings/settings.ts` |
| this stack, but one different model | the per-role overrides argument in `agent/model/models.ts` |
| a different **primary** over the stack | `models.primary`, or `models.force` to pin every route |

Per-role overrides are field-wise, so `{ vision: { id: "…" } }` keeps that role's tier and
context window. The three settings **compose** rather than compete: `models.stack` moves all five
roles, then `models.primary` / `models.force` are layered on top of the primary role last. All
three live in `agent/settings/settings.ts`, and no environment variable overrides them (the
`OE_MODEL_STACK`, `OE_PRIMARY_MODEL` and `OE_FORCE_MODEL` variables were deleted in OPE-2411).

An unknown alias fails **loudly** at config load, naming the shipped ones. A deployment that
thinks it switched but did not is the one failure mode worth being noisy about.

### Proving a switch, not asserting it

```
npm run e2e:stack -- chinese-open-weights
```

runs a lean live scenario set against a named stack and asserts, from the deployment's own
usage rows, that the models which ran were *that stack's* — both that nothing else appeared
**and** that the stack's own ids actually did. (The second half matters: a pin that only fails
on an unexpected model passes vacuously when a run produces no model rows at all.) Set
`models.stack` in the TARGET deployment's `agent/settings/settings.ts` and deploy first — the value
is read by the deployed process, so the driver cannot flip it.

The lane pins the harness's own grading model, which does **not** follow the stack: changing
the ruler and the thing being measured in the same run makes a green meaningless.

It also **preflights the runtime domain-model picks** and refuses to run when one names a model
outside the chosen stack. A `set_domain_model` pick overrides routing for its domain underneath
`models.stack`, so a leftover pick can make a correctly-switched target answer on a model the
stack never names. The preflight reads the picks directly from the database (there is no
control-plane route that enumerates them), so it needs `DATABASE_URL`; without it the lane prints
a loud SKIPPED warning rather than quietly checking nothing.

### Before you put a model in a stack: probe it

```
npm run probe:models                              # every role of every shipped stack
npm run probe:models -- --id vendor/some-model    # a candidate
npm run probe:models -- --rates                   # also solve the measured $/Mtok
```

**Catalog membership is not a route.** A model listed in the gateway's public catalog can still
403 on *your* gateway if the team restricts the only provider that serves it — that took
`describe_image` down in production once, with an id the liveness check considered healthy.

**And a vision model can route, return `200`, and describe an image that was never in the
request.** That is strictly worse than a refusal: `describe_image` is fail-closed on a throw, so
an unroutable model degrades honestly, while a confabulation defeats the contract entirely. The
probe therefore checks the *answer* against a known fixture over repeated trials, rather than
just checking for an error. This is why `chinese-open-weights` ships `alibaba/qwen3-vl-instruct`
for vision: the alternative under consideration routed fine, described ordinary images
correctly, and invented three different scenes for the 32×32 fixture the e2e pack uploads.

### What a stack declaration holds, and what reads it

A role binding is a `ModelRoleSpec` (`agent/model/stacks.ts`): the gateway model `id`, the `tier` a
role or domain pick resolves to, and `contextWindowTokens`.

🔴 **The window is stated, never probed at run time, and it must be sourced rather than guessed.** It
is the AI Gateway catalogue's `context_window` for that id, which is a public unauthenticated read and
therefore always checkable. It is the number eve takes the compaction fraction of, so a window declared
**too large** means compaction fires after the model has already refused the prompt. Where a new
model's window cannot be sourced, the safe direction is to understate it. The catalogue's `max_tokens`
is a separate, smaller number and is not what this field holds.

`STACK_ALIASES` is every shipped alias, sorted from the stack table itself, so an error message and the
docs table enumerate one list rather than two. `isStackAlias` reports whether a string names a shipped
stack.

`resolveStack(alias, overrides)` returns the complete role set: it **throws** on an unknown alias,
naming every shipped one, and otherwise merges any per-role field override onto that stack's base
binding, field by field.

`stackModelIds(stack)` answers every distinct id the stack names, de-duplicated and sorted. Both e2e
model-routing expectations derive from it rather than each carrying a copy.

`compactionThresholdTokens(window, percent)` mirrors eve's own arithmetic —
`max(1, floor(window × percent))`. **Nothing configures eve with it.** It exists so the absolute count
can be printed and pinned per stack.

### The five resolved roles

`agent/model/models.ts` resolves the selected stack once and exports one id per role:

| Constant | Role | What runs on it |
| --- | --- | --- |
| `PRIMARY_MODEL` | `primary` | The conversational turn. |
| `UTILITY_MODEL` | `utility` | Every non-conversational call — the cheap model. |
| `VISION_MODEL` | `vision` | A call carrying an image. |
| `SUPERVISOR_MODEL` | `supervisor` | Every turn on a seat-shaped token: a standing seat, a task worker (`t/`), a thread seat or a container supervisor. A DM seat runs on `primary`, and a routine that names its own model role overrides this (`isSupervisorSession`). |
| `JUDGE_MODEL` | `judge` | The approval judge and the memory judge. |

**Four of the five are that stack's own declared id, and no environment variable rewrites them** — to
change one, change the stack, or set the role in `agent/model/stacks.ts`. Moving every role at once is
what the stack alias is for.

🔴 **`PRIMARY_MODEL` is the exception.** It is not read off the stack directly: the primary role is
built as the stack's own binding with its `id` replaced by core's `defaultAgentModelId()`
(`agent/model/models.ts`). That resolver answers, in order, `models.force`, `models.primary`, the
id the app published, and a committed literal last — so either setting really does move the
conversational model, layered on top of the stack's primary. The other four roles reach no such
resolver.

`registerDefaultAgentModelId` (`packages/core/agent/model/default-model.ts`) is what publishes the
resolved primary id into core at config load. Three surfaces read that one seam — the root agent
config, the plugin extractor's generated subagents, and each hand-authored declared subagent — and the
publish is what stops those subagents sitting on core's committed literal whenever a deployment selects
a non-shipped stack.

`PRIMARY_MODEL_CONTEXT_WINDOW_TOKENS` is the primary role's window, stated to eve on every selection.
There is deliberately **no utility counterpart**: the compaction slot names no model, so no other
role's window reaches eve.

### The allow-list, and the one non-selectable entry

`allowListForStack(stack, extra)` derives the model-policy allow-list from **any** role set,
de-duplicated by id, first occurrence winning; extra entries are appended and de-duplicated the same
way. `modelAllowList()` is that derivation for the roles this process resolved, and it is what
`agent/model/policy.ts` declares.

🔴 **The `vision` role's entry is allow-listed but marked non-selectable.** The image describer needs
the id to be allowed, and a tier pick or a fail-soft substitution must never land a text turn on a
vision model — so the entry is present with `selectable: false` rather than absent.

**An armed experiment whose two arms resolve to one model is refused at boot.**
`abTestCollidesWithChampion` (`agent/model/ab-test.ts`) is true when the experiment is armed and its
challenger **is** the resolved champion, and the module throws on that at load. No run can therefore
produce a comparison of a model against itself. The refusal names the two fixes: point the challenger
stack elsewhere, or set the percentage to zero.

## How inference is routed

The `primary` role reaches the wire through two swappable layers:

- a **model backend adapter** owns the transport — how a model id becomes a live model and
  how per-route provider hints map onto a call. The reference backend is the **Vercel AI
  Gateway** (`@open-everywhere/adapters`); the routing schema and everything downstream are
  vendor-neutral, so a different backend (OpenRouter, a direct provider SDK) is a swap, not
  a rewrite.
- **per-channel-group routing** can override the default per [memory domain](../capabilities/memory.md):
  `models: { primary, utility }` routes (model id / provider constraint / reasoning effort)
  inherit org → domain, field by field — see the
  [configuration reference](../deploy/configuration-reference.md#memory-domain--silo).
  Routing is fail-soft: any resolution failure falls back to the static default.

On the reference Gateway backend, the model id routes to an upstream provider, so there's
no per-provider SDK or API key baked into the app:

- **Auth is to the Gateway**, not to the model vendor: Vercel OIDC when deployed on a linked
  project (no key needed), or an `AI_GATEWAY_API_KEY` / `eve link` for local dev.
- The Gateway can pin a single upstream provider for a validated setup, or load-balance the
  same model string across providers with automatic failover.
- The Gateway adds **zero token markup**, so routing through it costs the same as going direct.

## A/B testing a challenger model

You can run a share of a room's conversations on a second model and compare the two — see "It covers
turns that resolve the `primary` role" below for which rooms that reaches. Declare the experiment in
`agent/model/ab-test.ts`:

```ts
export const CHALLENGER_STACK: StackAlias = "chinese-open-weights";
export const MODEL_AB_TEST: ModelAbTest = {
  challenger: STACKS[CHALLENGER_STACK].primary.id,
  percent: 0, // share of CONVERSATIONS on the challenger; 0 = off, and that is how it ships
};
```

Both values are tracked config, like every other model choice here. There is **no environment
variable** for either: what a percentage of real rooms runs is behaviour, so it changes by pull
request.

**The unit is a conversation, not a turn.** A turn's bucket is
`<surfaceKey>::<threadKey>` hashed to 0-99, and the arm is `bucket < percent`. One thread therefore
stays on one arm for its whole life. Splitting a single conversation across two models would make
every human judgement about it meaningless — the reader would be rating a conversation neither model
held.

**The challenger substitutes for the champion and for nothing else.** If a domain route, a role
preset or a runtime `set_domain_model` pick already names a concrete model for that room, the pin
stands and no A/B decision is taken. The substitution also happens **before** the model-policy
envelope, so a challenger outside the allow-list is clamped away like any other model — and the arm
recorded is the one that actually ran, never the one the bucket asked for.

**It covers turns that resolve the `primary` role, and only those.** An OE-structured seat — a
unified or domain **window**, a task or thread-seat worker, a container-supervisor session — resolves
the `supervisor` role instead, so its turns are outside the experiment and no arm is recorded for
them. That exclusion is larger than it sounds: a `mode: "unified"` domain runs entirely on a window
token, so **a unified domain gets zero A/B turns**. The arm applies to ordinary addressed
conversation — a Slack thread, a Discord or Teams thread, a DM — in a room whose route names no model
and no tier of its own.

If you arm the test and see near-empty arms in the report, check this first: `/oe rate` in those
rooms will correctly answer "nothing to rate here yet", and the reason is the seat, not the
percentage.

**Arming the test widens the allow-list by exactly one entry**, added in `agent/model/policy.ts`
while `percent > 0`. Setting `percent` back to 0 removes it again.

### Marking the answers

```
/oe rate 4
```

`/oe rate <1-5>` records one human mark against the room's most recent A/B turn. It reads that
turn's own `model.ab_arm` audit row, so the rating carries the arm that answered — not a
recomputation that would go wrong the moment you change `percent`. The reply deliberately does not
tell the rater which model they marked.

Two limits worth knowing before you read any numbers:

- a Slack slash command carries **no thread**, so in a channel with several live threads `/oe rate`
  marks the most recent A/B turn in the *channel*, whichever thread it was in;
- ratings are voluntary, so they are biased toward answers somebody noticed. A silent arm is not a
  good arm.

Rating the same turn twice is a correction, not a second vote: the report counts one mark per person
per turn and keeps the newest.

There is no reaction ingest in this version: a 👍 is not a scale.

### Reading the result

```
npm run report:model-ab            # every org
npm run report:model-ab -- --org acme
```

The report prints, per arm: armed turns, ratings and their mean, model calls, tokens and derived $.
The quality half comes from the `model.ab_rating` audit rows; the cost half from the `modelArm` key
on each turn's `usage_events` row, so the split is read off the calls themselves rather than
inferred from a model id. No significance is computed — at these volumes there is none to compute,
and the row counts are printed beside every mean so you can see what the mean is made of.

### What the gate checks

`npm run lint:model-ids` walks the challenger id **whether or not the test is armed**, so an
unpriced or misspelled challenger fails while the experiment is still switched off — rather than
after a percentage of real conversations has run on a model whose calls the spend ledger counts as
$0.

## Data governance: the data policy

`models.dataPolicy` in `agent/settings/settings.ts` states what **every** model call demands of the
provider that serves it (OPE-2535). It names no vendor. The model adapter maps each row onto its
target's own options. All three rows are optional, and the shipped value `{}` demands nothing.

```ts
export default defineSettings({
  models: { dataPolicy: { zeroRetention: true, noTraining: true, region: "eu" } },
});
```

| Row | What it demands | On the Vercel AI Gateway |
|---|---|---|
| `zeroRetention: true` | only providers with a zero-data-retention agreement | `zeroDataRetention: true` |
| `noTraining: true` | only providers that do not train on prompt data | `disallowPromptTraining: true` |
| `region: "eu"` or `"us"` | only providers that run the inference in that region | `inferenceRegion: { scope: "zone", geoRegion }` |

**Every call carries the rows.** The adapter (`packages/adapters/agent/model/gateway.ts`) puts them
on each request it sends: the turn, compaction, the dream and failure-facet judges, the approval
judge, the meeting recap, the image describer, gateway transcription, and a declared subagent's
`model: "<id>"` string or eve's own `evaluate()` (the adapter installs the AI SDK's default
provider, so a bare id resolves through it too). A bare id goes through the target of the stack role
that names it, else the primary role's target (OPE-2566), so it carries that target's rows as well.
Every model kind the provider builds carries them:
language, evaluation, reranking, embedding, transcription, video and batch (each batch request
too). The rows win over a call's own gateway options, so no call can remove one. A call that cannot
carry the rows refuses under a policy: a realtime client secret, and a streaming-transcription or
realtime session token, which the client uses to open the session itself.

Two exceptions, stated plainly:

- Under `eve dev`, eve resolves a literal model id string through its own local gateway, not
  through the AI SDK's default provider. Those calls do not carry the rows. A deployed host does
  not take this path.
- If another module set the AI SDK's default provider before the adapter loaded, the adapter keeps
  it and logs an error at boot. That provider cannot carry the rows, so under a policy every call
  through it refuses. It cannot reach a target either, so a bare id whose target is not `gateway`
  refuses too.
`npm run lint:model-adapter` refuses any module in shipped agent code that builds a gateway model
itself, or that writes the AI SDK's default provider, because such a call would leave without the
rows.

**It fails closed.** A row narrows the providers a call may use. When no provider for the model meets
every row, the gateway answers a 400, and the call errors and names the rows and the model, for example
`models.dataPolicy (region eu): no provider serves "deepseek/deepseek-v4-flash-0731" under these rows`.
It never falls back to a provider outside the policy, or to another model. Where a call site has no
`try`/`catch` (eve's compaction), that is a failed turn. So check a policy against your stack before
you deploy it: `npm run check:model-config` does that (see
[the live config check](#the-live-config-check)).

What a keyed probe through the gateway showed on 2026-10-14:

- `region: "eu"` refuses every model of the `chinese-open-weights` stack
  (`deepseek/deepseek-v4-flash-0731`, `alibaba/qwen3-vl-instruct`). No provider of either model
  serves the EU. The `american-closed` stack's `openai/gpt-6-luna` and `google/gemini-3.8-flash`
  answered under `region: "eu"`. The transcription models were not probed.
- On 2026-10-15, `region: "eu"` also refused `mistral/mistral-small`, the `european-open-weights`
  model: "No provider for mistral/mistral-small supports the requested inference region". A European
  lab is not an EU region. See [the European stack](#the-european-stack).
- `zeroRetention: true` does **not** exclude China-hosted providers: under it,
  `deepseek/deepseek-v4-flash-0731` was served by `alibaba`. To fence a jurisdiction, set
  [`providers.only`](#model-targets-where-calls-go) on the target.
- `noTraining: true` was met for all four language models of both stacks probed that day.
- A zero-retention route can carry a surcharge. On 2026-07-13 the gateway charged one for
  `deepseek/deepseek-v4-flash-0731` (see the note in `agent/agent.ts`).

**The `deepinfra` transcription route refuses under any row.** It does not pass through the gateway,
so it cannot carry the rows, and it refuses before any audio leaves. A `self-hosted` route is your
own server, so the provider rows do not apply to it. See
[the transcription role](#the-transcription-role-speech-to-text-with-a-fallback).

## Model targets: where calls go

`models.targets` names the places model calls go (OPE-2556). One kind is implemented,
`"vercel-ai-gateway"`. The shipped value is one target, `gateway`, on the gateway's default URL, with
no rows. It changes no request.

```ts
export default defineSettings({
  models: {
    targets: {
      gateway: {
        kind: "vercel-ai-gateway",
        url: "https://gateway.example.com/v4/ai", // optional: a relay or an on-prem gateway
        providers: { only: ["openai", "azure"], order: ["azure"] }, // optional
        dataPolicy: { zeroRetention: true }, // optional: rows this target adds to models.dataPolicy
        options: { caching: "auto" }, // optional: Vercel-only passthrough
      },
    },
  },
});
```

| Key | What it does |
|---|---|
| `kind` | The target's adapter. Only `"vercel-ai-gateway"` exists. An unknown kind fails config load. |
| `url` | The target's base URL. It replaces the `OE_AI_GATEWAY_URL` env var (see below). The adapter reads it once, at the target's first call, so a change needs a restart. |
| `providers.only` | A **demand**: only these providers may serve a call through this target. A call cannot widen the list. A call that sets its own `only` gets the intersection, and an empty intersection refuses. |
| `providers.order` | A **preference**: the order the gateway tries providers in. A route's `providerOrder` wins over it. Every name in `order` must also be in `only`, when `only` is set. |
| `dataPolicy` | Rows (`zeroRetention`, `noTraining`, `region`) that every call through this target demands **on top of** `models.dataPolicy` (OPE-2531). A target adds a row and never removes one: a `false` here does not turn off a deployment row. Two different regions cannot both be met, so a call under them refuses, and the live config check names it. |
| `options` | Gateway options for every call through the target, as a floor: a call's own key wins. An option that a typed row owns (`only`, `order`, `zeroDataRetention`, `disallowPromptTraining`, `inferenceRegion`) fails config load. |

**`providers.only` fails closed, as the data policy does.** It rides every call the adapter sends
through the target, side calls and a bare model id included. When no allowed provider serves the
model, the call errors and names the row and the model, for example
`models.targets.gateway.providers.only (openai, azure): no provider serves "deepseek/deepseek-v4-flash-0731"`.
A call that cannot carry the row (a realtime client secret, a session token) refuses. Under `eve dev`,
eve resolves a literal model id through its own local gateway, and that call carries no `only` row. Use
it to fence a jurisdiction: `zeroRetention` alone does not.

**`via` picks the target.** A domain or role route (`models: { primary: { via: "eu" } }`) and a
stack role (`{ id, tier, contextWindowTokens, via }` in `agent/model/stacks.ts`) can name a target.
With no `via`, a call uses the target named `gateway`, so `models.targets` must hold one. A `via`
that names no target fails config load. A route's `via` inherits field by field, like `reasoning`:
a target is where the deployment sends calls, not a fact about one model id. A route's own `via`
wins over its role's. One limit: a TURN uses the primary role's `via` unless its route names one.
That holds for a standing seat (the `supervisor` role) and a routine that runs on `utility` too. So a `utility` or
`supervisor` route that a turn resolves must name its own `via`. The shipped org domain does that for
the supervisor role. The utility side calls (the dream and facet judges, the meeting recap) use the
utility role's `via`.

**`OE_AI_GATEWAY_URL` is deprecated.** It still retargets the `gateway` target when that target has no
`url`, for one release, and the process warns once, the first time the process reads the target. When both are set, the setting wins, and the process
warns once, the first time the process reads the target to say that the env var is ignored. Move the value to `models.targets.gateway.url`: it is config, and config
lives in Git.

**The route key `providers` is now `providerOrder`.** The gateway always read it as an order hint,
never as an allowlist, and the old name hid that. A route that still names `providers` fails config
load, and the error names the new key. For an allowlist, use the target's `providers.only`.

**Prompt caching is not a setting.** The adapter always asks for it (`caching: "auto"`).

### The live config check

A demand that no provider can meet fails every call of that model. The live config check finds it
before a deploy. For the models the deployment can resolve (the stack roles, the gateway
transcription routes, every domain and role route that names a model, and `models.force`), it reads
the gateway's public
`/v1/models/<id>/endpoints` and checks three things:

1. the model id exists on the gateway;
2. at least one `providers.only` provider serves it. A name in `only` that serves none of the
   checked models gets a warning, not a failure: it is most likely a typo, but a call can still be
   served;
3. at least one allowed provider meets every `models.dataPolicy` row at once (`has_zdr`,
   `has_no_training`, `inference_regions`).

A row no provider can meet is named, for example `region eu: no provider for deepseek/deepseek-v4-flash-0731`.
A declared subagent's own literal model id is not checked. A target with a `url` that does not serve
the endpoints read (a relay) gives "unknown", never a failure.

The endpoint fields are not documented, so a missing field is **unknown**, never a pass. One rule
reads more than a field. Most endpoints omit `inference_regions`. When at least one endpoint of a
model lists regions, an endpoint that omits them counts as serving none of the listed regions. That
matches the gateway's answer on 2026-10-14. When no endpoint lists regions, the region row is
unknown.

It needs the network, so it is not an offline gate. Three places run it:

- `npm run check:model-config` runs it from the app: a clone of this repository, or an app
  scaffolded at 0.8.0 or later (the template ships the same script). It exits 1 when a demand cannot
  be served. Run it before you deploy a change to `models.dataPolicy`, `models.targets` or the stack.
  The setup skill runs it after the model settings are written, before the deploy, and stops on a red.
- On a deployment, the `model-route` row of `GET /eve/v1/oe/status` carries it. A demand no provider
  can meet turns the row `no`. The route is public, so its detail names no model, provider or target,
  and counts nothing: run `npm run check:model-config` for the names. The answer is cached for ten
  minutes.
- `npx @open-everywhere/create --check --host <url>` reads that row, so the setup skill sees it too.

### The data policy and the gateway's own team settings

The Vercel AI Gateway also has team settings: a *"ZDR models only"* restriction and a *Provider
Allowlist* (AI Gateway → Settings). They are a second layer, and they apply to every caller of that
gateway, not only to this deployment (OPE-323). The two layers combine: a call goes out only to a
provider that both allow.

| Enforced at | When it fails | What you see |
|---|---|---|
| the **app** (`models.dataPolicy`) | per call, at request time, for every call this deployment sends | the call errors, and the error names the rows and the model |
| the **gateway** (team settings) | at routing, for every model and every caller of the gateway | the gateway declines to route that model |

Use the app layer to make the demand part of the deployment's reviewed config, and to state it per
deployment when several share one gateway team. Use the gateway layer to cover callers that are not
this deployment. Nothing stops you setting both.

### Residency covers inference AND sandbox compute.

Inference is one leg of a residency claim. Sandbox compute is another, and both are pinnable. Be
exact about which is which:

| Leg | Pinnable today | How |
| --- | --- | --- |
| Inference | **Yes** | `models.dataPolicy.region`, on every call (see [the data policy](#data-governance-the-data-policy)) |
| Database | **Yes** | your Postgres instance's own region |
| Hosted functions | **Yes** | the Vercel project's function region |
| Sandbox compute | **Yes** | `sandbox.region` — see below |

Vercel Sandbox takes a region (`iad1`, `sfo1`, `cle1`, `cdg1`; `cdg1` is Paris). Open Everywhere
never creates a sandbox itself. Eve does, through its **own vendored copy** of `@vercel/sandbox` —
a package-internal import, so floating this repo's `@vercel/sandbox` dependency forward does not
change it. Since Eve 0.52.2 that vendored copy types `region` on `Sandbox.create` and posts it to
the API, so `sandbox.region` reaches Vercel and the sandbox boots where you asked.

Set it on Vercel and the region applies at sandbox **create**. Sandboxes that already exist keep
the region they were created in. Off Vercel the setting is inert and logs a warning: the host you
run the container on is where sandbox compute happens.

**Both halves are required, and one without the other is worse than neither.** Eve's create call
**enumerates** the fields it forwards. A `region` that is typed but missing from that enumeration
compiles and is then *dropped* — the sandbox runs in the default region while you believe it runs
in Paris. So Open Everywhere does not read this off a version number. A guard re-derives it from
Eve's own files on every `npm test` run, demanding both halves, and also fails if Eve renames what
it reads or moves creation to a different vendored copy. Should a future Eve withdraw the
passthrough, that guard turns red. The red is the signal, and it is the only automatic part. The
answer ships as a hand-maintained constant, and the boot keeps pinning the region until a human
flips that constant to `false`. The flip is what makes the setting **fail closed**: a set region
then refuses the boot and names the gap, instead of running in `iad1` under a pin Eve cannot
honour.

**What this means for an EU claim.** A managed EU deployment can pin inference, database,
functions and sandbox compute in the EU. Set `sandbox.region` to `cdg1` for the last one; the
agent's shell then reads and writes the working tree in Paris.

**A model id is not where your data goes — the serving *provider* is.** `alibaba/qwen3-vl-instruct`
names whose weights run, not which datacenter processes the request: the Gateway resolves that id
to whichever *allowed* provider wins routing (Fireworks, DeepInfra, Baseten, the model's own
first-party host, …), and it's that provider's jurisdiction that matters for a residency
requirement. Concretely, the `chinese-open-weights` stack's Alibaba and MiniMax open-weight models
are served from US-based resellers (DeepInfra, Fireworks) rather than each model's Chinese
first-party host — verified 2026-08-11 through this repo's own transport via the routing metadata
every response carries (`providerMetadata.gateway.routing.finalProvider`; `npm run probe:models`
re-checks it). If you need a hard fence — e.g. "never send inference to a China-hosted provider" —
set [`providers.only`](#model-targets-where-calls-go) on the deployment's target, or set it in
**your AI Gateway's Provider Allowlist** (dashboard → AI Gateway → Settings → *Restrict allowed
providers*), the gateway team setting described above. `models.dataPolicy.zeroRetention` is not such
a fence: a zero-retention provider can be China-hosted. The gateway's allow-list covers every caller,
not just this app. The exception is the meeting bot's `deepinfra` and `self-hosted`
transcription routes: they send audio around the gateway, so this fence does not cover them (see
[the transcription role](#the-transcription-role-speech-to-text-with-a-fallback)).

## The European stack

`european-open-weights` (OPE-2531) runs Mistral Small 4 in every role, vision included. The weights
are Apache 2.0 and come from a European lab, so a buyer is never stuck with the US or the Chinese
bloc. Switch to it with one word: `models: { stack: "european-open-weights" }`.

**The route travels with the stack.** Every role names `via: "mistral"`. The app's settings declare
that target, in this repo and in the template:

```ts
models: {
  targets: {
    gateway: { kind: "vercel-ai-gateway" },
    mistral: { kind: "vercel-ai-gateway", providers: { only: ["mistral"] }, dataPolicy: { zeroRetention: true } },
  },
},
```

So every call through a stack role (the turn, compaction, the dream and facet judges, the meeting
recap, the approval judge and the image describer) goes only to the `mistral` provider and demands
zero retention. A role with no `via` uses `gateway`, so the target changes no call of the other
stacks.

**A bare model id goes through the `mistral` target too (OPE-2566).** The AI SDK resolves a
declared subagent's bare `model: "<id>"` string and eve's own `evaluate()` through the default
provider, which sees only the id. So the app registers its stack roles (`agent/model/models.ts`,
`registerBareModelRoutes`), and the default provider sends each bare id through:

1. the target of the first role that names the id (`fresh_eyes_review` uses the primary's id, so it
   goes through the primary's target);
2. else the primary role's target, the deployment default;
3. else, in a process that registered no role, `gateway`.

On this stack every role goes `via: "mistral"`, so every bare id carries the provider pin and the
zero-retention row. A bare id that no role names (a plugin subagent that maps its own model, or
eve's `evaluate()` default) also goes through `mistral`, and a model that no `mistral` provider
serves fails closed. `npm run check:model-config` checks each declared subagent's id on its target
and names each declared subagent whose id no role names, and each one whose module does not load. It
does not list eve's `evaluate()` model. An app scaffolded before 0.8.0 does not call
`registerBareModelRoutes`, so every bare id still goes through `gateway`. When a role names another
target, the check says so and exits 1. Add the line from the template (`packages/core/upgrading.json`
has the step). If another module set the AI SDK's default provider first, a
bare id whose target is not `gateway` refuses, because that provider cannot reach the target. If your
app replaces `models.targets`, keep the `mistral` entry, or a switch to the stack fails config load
and names the missing target.

What a probe through this repo's own transport showed on 2026-10-15:

| Check | `mistral/mistral-small` (Small 4) | `mistral/mistral-large-4` (Large 4) |
|---|---|---|
| a text reply | yes | yes |
| a two-tool chain, 3 runs | 3/3 | 3/3 |
| the 32×32 vision fixture, 3 runs | 3/3 | 0/3 (it called the red square black, then white) |
| price per 1M tokens, in / out | $0.15 / $0.60 | $0.68 / $2.09 |
| weights published | yes (Apache 2.0) | no, a preview |

Small 4 is the pick in every role. Large 4 fails the vision fixture, costs about 4× as much, and is
not open weights yet. The judged quality comparison needs the live lane
(`npm run e2e:stack -- european-open-weights`); it has not run.

- **The window is 262,144 tokens, checked live.** A 238,918-token prompt answered, and a
  348,918-token prompt was refused at "262144 maximum context length". Compaction fires at half the
  window, 131,072 tokens, under the shipped `agent.compactionThresholdPercent`.
- **One provider.** The gateway lists one endpoint for the model, `mistral`, with zero retention. A
  call with the stack's rows routed with "ZDR requested: all 1 attempts support ZDR". One provider is
  also one outage: there is no failover.
- **The reply cap.** The catalog lists a 4,000-token reply cap. A request for 8,000 tokens was
  accepted, and the longest reply seen stopped on its own at 3,844 tokens, so the cap is not proven
  to bind.
- **The id is undated.** `mistral/mistral-small` is an alias that Mistral can move to a later Small.
  Re-probe after a move.

**EU-region inference is not available through the gateway.** The gateway documents no EU routing
for Mistral, and `region: "eu"` refuses the model (see [the data policy](#data-governance-the-data-policy)).
The stack fixes who serves its role calls (Mistral, under zero retention; see the two call paths
above that skip the target), not where the inference runs.
To pin EU-region inference you need your own contract and key with Mistral, on Mistral's own EU
endpoint, outside the gateway. This repo has no target kind for that today: only
`"vercel-ai-gateway"` exists. The other option is to run the open weights on your own servers.

## Choosing between the stacks

All three are capable enough to run the product; the choice is about lock-in, cost and where
inference happens, not about one being "the good one".

`american-closed` is the shipped default and what this project's own deployment runs. One
model does all five jobs, which makes the whole configuration trivially coherent, and it is
the stronger seat today.

`chinese-open-weights` is the answer to frontier lock-in. Open weights mean you can leave the
gateway entirely — the same checkpoints run on your own hardware, so the ceiling on "what if
the vendor changes the deal" is a migration rather than a rewrite. It is also markedly cheaper,
which is what makes the ambient/always-on surfaces (standing seats, compaction, dream
cycles) affordable to leave running — and leaving them running is what the product actually is.

The bump to DeepSeek V4.1 Flash (OPE-2531) changed that cost. The 0731 pin measured $0.09 to $0.14
in and $0.18 to $0.28 out per 1M tokens. V4.1 Flash measured $0.30 in and $1.20 out, all on
`baseten`, which is about 2.1× the input and 4.3× the output of the old upper bound. Cache reads are
cheaper on V4.1 ($0.007 against $0.028 per 1M on `baseten`). On the illustrative month of
`npm run pricing:stacks`, which prices no cache read, the stack goes from $3.72–$5.76 to $15.03.
The catalog lists cheaper ZDR upstreams outside China, for example `deepinfra` at $0.14 / $0.42 and
`morph` at $0.022 / $0.60; your gateway's Provider Allowlist decides which one serves you.

`european-open-weights` is the answer to bloc lock-in. It is open weights, as the Chinese stack is,
from a European lab, and every stack role is served by that lab under zero retention (two call
paths skip the target; see [the European stack](#the-european-stack)). At $0.15 / $0.60 it sits between
the other two on the illustrative month ($7.53). It has one provider and a 262,144-token window, a
quarter of the other stacks' windows.

**Compaction runs on `primary`, not on `utility`.** eve cannot summarise with an authored
compaction model while this agent's turn model is dynamic — it resolves that slot through the
agent-level model field and fails the turn (OPE-670, `agent/agent.ts`'s `compaction` block
carries the chain). So the summariser is the turn model itself. Two consequences worth knowing:
a stack that gives `utility` a cheaper model than `primary` still pays the primary's rate for
its compaction summaries, and the old "keep `utility`'s window ≥ `primary`'s or a long session
dies at compaction" rule no longer applies, because the two windows are one window.

The approval gates and harness limits elsewhere in Open Everywhere are **governance, not
weak-model compensation** — they'd apply to any autonomous agent doing irreversible outward
actions, regardless of model strength.

### Costs are measured here, not quoted

`packages/core/agent/spend/pricing.ts` carries a hand-solved rate for the shipped primary,
fitted from real Gateway bills, and it deliberately **wins** over the catalog. That is not
paranoia: the published rate has been wrong for every id checked so far.

Worse, an id may not *have* one rate. Probing `deepseek/deepseek-v4-flash-0731` across eight
otherwise-identical calls produced **three** exact per-token rates — $0.09/$0.18, $0.13/$0.26
and $0.14/$0.28 per 1M tokens — each fitting its own rows to the last digit, because the
gateway load-balances that id across upstreams that charge differently. Two calls a second
apart differed by 1.56×. So for an open-weights id the honest answer is a **band**.

If you re-point a role, re-measure with `npm run probe:models -- --rates`, which solves the
rates and then checks the solution against a row it did not use — the check that tells you
whether "one rate" was even the right shape of answer. `lint:model-ids` enforces that the
pricing entry names the current default; it cannot tell you the number is right.

> One thing to know if you build cost reporting on top: the gateway bills the prompt-cache
> discount **without** populating `usage.cachedInputTokens`, which reads `0` on cached calls.
> Cache savings show up in the cost, not in the token split.

### A long prompt costs more per token — the long-context tier

A model can carry a **second price tier** charged on a single call's prompt size. The shipped
primary does. Past 272,000 input tokens the gateway doubles the input and cache rates and
charges 1.5× for output:

| dimension | below the boundary | at 272,001 input tokens or more |
| --- | --- | --- |
| input (uncached) | $0.125 / 1M | $0.25 / 1M |
| cached input read | $0.01 / 1M | $0.02 / 1M |
| output | $0.50 / 1M | $0.75 / 1M |

**The whole call reprices — this is a cliff, not a tax bracket.** A prompt of 272,001 tokens
bills *every* token at the tier rate, so crossing the boundary by one token nearly doubles the
bill. The output rate moves with the prompt's size, not with the reply's length: a one-line
answer to a 300,000-token prompt is billed at $0.75 / 1M.

This matters in ordinary use, not at the edge. A session compacts at 525,000 tokens, so a long
session sits past the boundary for many of its turns. Before OPE-2055 the ledger priced those
turns at the base rate and understated them by up to 2×.

Declare a tier with the `longContext` field on a pricing entry
(`packages/core/agent/spend/pricing.ts`). Omit it for a model billed at one rate; omitting it
on a model that *does* tier is the understatement above. `lint:model-ids` RULE 5 holds the tier
equal to its band in `stack-pricing.ts`, so the two tables cannot drift apart.

> **These four tier numbers are catalog-read, not probe-solved**, and the code says so where it
> declares them. No call past the boundary has been billed and measured. What admits the read is
> that the same catalog fields match our own probe *exactly* at the tier we did measure — all
> three dimensions, including the awkward one where the bill charges an uncached prompt at the
> catalog's cache-*write* rate rather than its `input` rate. That is good evidence, and it is
> still weaker than a bill. To replace it, bill one prompt over 272,000 tokens and solve it the
> way `probe:models` solves the base rates.

**Only a reader that can see one call applies the tier.** The boundary is a boundary on a single
prompt, so a usage record that *sums* several calls has no prompt size in it — 40 ordinary
7,000-token turns also total 280,000. Charging such a total the surcharge would report roughly
double what the gateway billed. Every consumer therefore states its own grain:

| applies the tier (one call) | withholds it (a sum of calls) |
| --- | --- |
| the ledger write path (`usdMicrosAtWrite`) — the figure a USD cap is enforced on | `spend_report`'s per-surface groups, which carry an `events` count |
| `session_cost`, walking raw `usage_events` rows | the control plane's usage view and its cross-workspace rollup |
| the analytics executor, pricing each row before summing | routine cost predictions, whose average is per *fire* and so spans a whole session |
| the session checkpoint gate | `npm run pricing:stacks`, whose profile is a period total |

The default is to **withhold** it, so a consumer that names no grain keeps its pre-OPE-2055
behaviour rather than silently gaining a surcharge. The cost of that default is an understated long
call at a reader that forgot to opt in; the cost of the opposite default is an overstated figure
that looks like a real bill.

## Changing the model

In increasing order of escape:

1. **A different stack** — set `models.stack`. One word; all five roles,
   the allow-list, the route pins and `/oe status` follow. Prove it with
   `npm run e2e:stack -- <alias>`.
2. **A different model for one role** — a per-role override in `agent/model/models.ts`, or a
   new stack in `agent/model/stacks.ts` if the change is really a different family. Probe a
   `vision` id before you ship it (see above).
3. **A different model for some channels** — don't change any role: give those channels'
   domain a `models` route (see above). This is the right tool for "the exec channel gets
   the stronger model" or "support runs on low reasoning".
4. **One pin over the stack** — the setting `models.primary` overrides the primary role's id;
   `models.force` is a blunter hard pin that overrides *every* resolved route, including
   concrete per-domain pins. Both are settings in `agent/settings/settings.ts`, so a change is a
   reviewed diff and a deploy (they were the env-only `OE_PRIMARY_MODEL` / `OE_FORCE_MODEL` until
   OPE-2411). Both layer on top of whichever stack is selected, and `npm run lint:model-ids`
   prices the committed pins.
5. **A different upstream** — see below; this is your gateway's configuration, not the app's.
6. **Leave the Gateway entirely** — implement a `ModelBackend` for your transport (two
   functions: id → model instance, route hints → call options) and wire it in `agent.ts`
   in place of the gateway backend, or pass a raw `@ai-sdk/*` provider instance directly
   as `model` if you don't need per-domain routing. You lose the Gateway's zero-markup
   billing, multi-provider failover, and routing — but you're fully off Vercel for inference.

No other code changes: the routing schema, domains, and everything downstream of
`defineAgent` are model- and vendor-agnostic.

> After changing the primary, re-check `packages/core/agent/spend/pricing.ts`. Its single entry
> doubles as the assumed model for usage rows that carry no model stamp, so a stale entry
> misprices them silently. `lint:model-ids` fails if it no longer matches the shipped stack.

## Which provider serves your models is your gateway's job

A stack names **weights per role**. It does not name a serving provider, a region or a routing
order, and that omission is deliberate. A region is a demand on every call, so it lives in
[`models.dataPolicy`](#data-governance-the-data-policy), not in a stack.

Wanting open weights served from a particular jurisdiction — Fireworks or Together rather than
a first-party endpoint, or Bedrock / Azure / Vertex rather than either — is a completely
reasonable requirement, and it is **your AI Gateway's configuration**, not this app's. The
gateway is the layer that knows which upstreams exist for a model id, which are ZDR-attested,
what they cost and which are up; putting a competing preference list in application config
would mean maintaining a worse copy of that knowledge in a place that cannot see any of it.

So:

- **Restrict or order providers** in your gateway's own settings (on the Vercel AI Gateway,
  *Settings → Restrict allowed providers*). This applies to every caller of that gateway and
  preserves failover across whatever remains enabled.
- **Restrict or order providers for this deployment only** with the target's
  [`providers.only` and `providers.order`](#model-targets-where-calls-go). `only` is a demand that
  fails closed; `order` is a preference.
- **Per-domain preference**, if you really want it in code, is the optional `providerOrder` field on
  a domain's model route — mapped to the gateway's `order` hint, which is a first-try preference
  that still fails over. A routing hint must never be able to hard-fail a turn.

One consequence worth internalising: because provider selection lives there and not here, a
model id that your gateway team has restricted **has no route at all**, whatever the catalog
says. That is the failure `npm run probe:models` exists to catch before a deploy rather than
after one.

## On Vercel / Off Vercel

- **On Vercel:** the AI Gateway is wired by default and authenticates via OIDC on a linked
  project — no model key in the app. The committed default works out of the box.
- **Off Vercel:** the Gateway still works with an `AI_GATEWAY_API_KEY`. To avoid Vercel for
  inference entirely, swap the `model` for a raw AI SDK provider instance (route 5 above)
  pointed at any OpenAI-compatible endpoint.
