# Telemetry

Open Everywhere ships **anonymous usage telemetry, default ON**. This page is the
canonical disclosure: every event, every attribute, the full never-collected list,
retention, and how to turn it off, redirect it, or rotate your instance's id. If
you're a DPO/security reviewer evaluating a deploy, this page — plus
`OE_TELEMETRY_DEBUG=1` (below) — is everything you need.

**Opt out with one env var: `OE_TELEMETRY=off` (or `DO_NOT_TRACK=1`) — full stop, forever.**

## Every default outbound call

This table lists each call that Open Everywhere and eve 0.71.0 make by default to a host that you
did not configure. A call to a service you connect (Slack, Notion, GitHub, your database) is not in
it. The source was read on 2026-10-14 (OPE-2526).

| Call | Host | When | Default | How to turn it off |
|---|---|---|---|---|
| Open Everywhere usage telemetry (this page) | `oe-telemetry.vercel.app` | Boot, turns, and a heartbeat at most once every 6 hours | **On** | `OE_TELEMETRY=off` or `DO_NOT_TRACK=1`. `OE_TELEMETRY_OTLP_URL` sends it to your own collector instead. |
| eve CLI telemetry | `telemetry.vercel.com` | Each `eve` command (`dev`, `build`, `start`, `info`, …) | **Off in Open Everywhere** | Open Everywhere sets `EVE_TELEMETRY_DISABLED=1` (below). |
| Model calls | `ai-gateway.vercel.sh` | Each model step | On: this is the product's function | `models.targets.<name>.url` moves it to your own gateway (`OE_AI_GATEWAY_URL` was deleted in 0.9.0, OPE-2650). Nothing turns it off. |
| eve's model catalog at build | `ai-gateway.vercel.sh/v1/models/catalog` | `eve build`, and `eve dev` or `eve start` when they compile, unless `.eve/cache/model-catalog.json` is at most 5 minutes old | On | No switch. A failed fetch falls back to a stale cache, and `npm run seed:model-catalog` writes one. |
| eve's model catalog at run time | `ai-gateway.vercel.sh/v1/models/catalog` | A turn whose selected model has no context window | Not reached: every model selection in `agent/agent.ts` gives `contextWindowTokens` | An app that changes its model resolver must keep that field. |
| Model route probe | `ai-gateway.vercel.sh/v1/models/catalog`, and `/v1/models/<id>/endpoints` for each model the deployment can resolve | Only when the deployment status is read (`/eve/v1/oe/status`); the endpoints reads at most once every 10 minutes | On request | `models.targets.<name>.url` moves it with the model calls. The endpoints reads carry no credential. The status detail names no model or provider. |
| Model config check | `ai-gateway.vercel.sh/v1/models/<id>/endpoints` | Only when you run `npm run check:model-config` | On request | Do not run it. It carries no credential. |
| eve workflow state | `api.vercel.com`, `vercel-workflow.com`, `oidc.vercel.com` | Each durable step on a Vercel deployment | On Vercel only | This is Vercel's own platform. Off Vercel, the workflow state stays local. |

`oe build` makes no outbound call. The setup CLI, `@open-everywhere/create`, calls only the
deployment that you give it with `--host`. The pages the app serves load no external script, font
or stylesheet.

### eve's CLI telemetry is off

eve collects its own CLI usage telemetry, and in eve it is **on by default**. Each `eve` command
posts these keys:

- `version` (the eve version), `platform`, `arch` and `stdin_is_tty`.
- `command` (an allowlisted command name, never your input) and `outcome`.
- `identity_kind`, `installation_id` (a random id) and `project_id`.

`eve dev` also sends `target` (local or remote) and `ui`. The `eve init` and setup flows also send
their `setup_*` steps, `registry_selected_count` and failure codes. Each event also carries a random
event id and a timestamp, and each request carries a random session id. The project id is a salted SHA-256 hash of the git remote
URL, of `REPOSITORY_URL`, or of the working directory. eve sends no prompt, transcript or config.
In CI or inside Docker the ids are new for each run. Elsewhere they persist in your eve config file,
so the project id is stable for one repository. A Vercel function never runs the eve CLI, so a turn
on Vercel sends none.

Open Everywhere turns it off where it starts eve (OPE-2526):

- Every npm script that runs `eve`, in this repository and in the scaffold, starts with
  `EVE_TELEMETRY_DISABLED=1`. Vercel's remote build runs the `build` script, so the build on Vercel
  carries it too.
- Each stage of the `Dockerfile`, in this repository and in the scaffold, declares
  `ENV EVE_TELEMETRY_DISABLED=1`. The image's `npx eve start` inherits it.
- The integration tier's `eve build` (`tests/integration/prepare.ts`) and the quickstart test's
  `eve build` (`scripts/quickstart-test.ts`) set it too.

The script prefix is POSIX shell syntax. On Windows, use WSL or set npm's `script-shell` to a POSIX
shell. An app scaffolded before 0.8.0 has no prefix: `packages/core/UPGRADING.md` gives the manual
step.

`OE_TELEMETRY` does not change eve's switch: the two are separate. `npm run lint:eve-telemetry`
pins every script, Dockerfile stage and source file that starts eve. It also runs the installed eve
with `EVE_TELEMETRY_DEBUG=1` and proves that the switch still stops the payload. So an eve upgrade
that renames the switch fails the test. When you run `eve` by hand, set `EVE_TELEMETRY_DISABLED=1`
yourself, or run `eve telemetry disable` once.

## Why default-on, and why this should be trustworthy

Open Everywhere is a **self-hosted server**, not an end-user tool: the person who
"consents by deploying" is the org admin who read the setup docs and saw the boot
line (below); the people whose data is actually sensitive — DM users, channel
members — are **structurally absent** from every payload. There is no field a
message, a memory item, or a person's identity could ride in on. This follows the
norms that have actually held up for default-on telemetry in practice — Homebrew
(post-2016), .NET, Next.js, Sentry's self-hosted beacon, Meilisearch — dev tools and
self-hosted servers with full disclosure, not an OS or a developer-machine tool
(where default-on has repeatedly flamed out, e.g. Fedora 2023, Go's telemetry
proposal).

## What is collected — the complete vocabulary

Twelve events, total: the ten runtime events below, plus two **retired** install-wizard
funnel events (`wizard.started`/`wizard.completed` — see
["The retired install-wizard events"](#the-retired-install-wizard-events) below).
**These tables are the entire payload — nothing else is ever sent.** The code enforces this
as a closed vocabulary (`packages/core/agent/observability/telemetry.ts`'s `EVENT_SCHEMA`): an
event name or attribute outside these tables is dropped before it ever reaches the
network.

🔴 **The event list here is not pinned to this page.** `packages/core/scripts/telemetry-test.ts`
pins the `oe.feature` and `oe.outcome` **enum rows** to the code's own `FEATURE_VALUES` /
`OUTCOME_VALUES`, so widening either vocabulary edits this page. The event NAMES are pinned to
the test's own hardcoded `EXPECTED_SCHEMA` copy instead, not to this table — so a new entry in
`EVENT_SCHEMA` reds that test, but can still ship without a row here once the test's copy is
updated. Read `EVENT_SCHEMA` itself when you need the authoritative list.

### Resource attributes (stamped once per batch, on every event)

| Attribute | Value | Why it cannot leak |
|---|---|---|
| `service.name` | `"open-everywhere"` | Constant. |
| `service.version` | Your deploy's app version, or `unversioned` when your deploy carries none | Public release string. Never your commit sha — a sha identifies the build, but on a private fork it is not a public fact. |
| `service.instance.id` | A random UUIDv4, minted on first boot, persisted in your operational store | The OTel-canonical anonymous install id. Never derived from your org name, URL, or env — there is nothing to reverse it from. Deleting the stored row (see "Rotate your instance id" below) mints a new one. |
| `deployment.environment.name` | `production` \| `preview` \| `development` | A 3-value enum. |
| `oe.host` | `vercel` \| `node` | Coarse hosting type — no region, no URL, no hostname. |
| `oe.node.major` | e.g. `24` | Major Node version only. |
| `oe.instance.ephemeral` | `true` (only present when your operational store was unreachable at boot) | Tells you this boot's id is NOT durable — it'll be a fresh id next cold start. |

Deliberately **never** sent as a resource attribute: `host.id` / `host.name` /
`host.ip` / any `os.*` fact — directly identifying, and excluded on principle even
though some OTel semantic conventions suggest them.

### Events

| Event | Attributes | Why each attribute cannot leak |
|---|---|---|
| `oe.instance.first_boot` | *(resource attributes only)* | Fires once per instance id — it IS the install event. Deferred to the boot **after** the one that mints the id (see "First-boot grace window" below) — the very first boot sends nothing at all. |
| `oe.instance.heartbeat` | `oe.surfaces` (sorted list of surface **types** with credentials configured — from: `slack`, `discord`, `teams`, `github`, `linear`, `webhooks`) · `oe.memory_provider` (`git`\|`sqlite`\|`postgres`\|`github`\|`notion`) · `oe.operational_provider` (`sqlite`\|`postgres`) · `oe.model.primary` / `oe.model.utility` (public AI-Gateway model-id strings, e.g. `deepseek/deepseek-v4-flash-0731`) · `oe.domains.bucket` (`0`\|`1`\|`2-5`\|`6+`) · `oe.telemetry.dropped` (count of telemetry records **this instance** has dropped) | Surface *types* are product vocabulary — never a workspace/channel id. Providers are enums. Model ids are public catalog strings (a config choice, not user data). The domain count is bucketed so it can never fingerprint your org's exact structure. The dropped-count is purely self-referential health. Sent at most once per 6h per **process**, lazily on turn activity or cold boot. The throttle is an in-memory variable (`lastHeartbeatAt` in `packages/core/agent/observability/telemetry.ts`), so it bounds one process and not the instance: a serverless deploy runs many concurrent lambdas and recycles them often, and each cold boot starts a fresh 6h window. The collector dedupes on (`instance_id`, 6h window). So the **stored** record is at most one per instance per 6h window, while the sender may emit more than that. |
| `oe.turn.completed` | `oe.surface` (type enum: `slack`\|`teams`\|`discord`\|`linear`\|`webhook`\|`local`) · `oe.kind` (`channel`\|`dm`\|`mpim`\|`routine`\|`webhook`) · `gen_ai.request.model` (the routed model id) · `oe.tokens.bucket` (`<1k`\|`1-10k`\|`10-100k`\|`100k-1M`\|`>1M`, the turn's total) · `oe.steps.bucket` (`1`\|`2-5`\|`6-20`\|`>20`) · `oe.latency.bucket` (`<5s`\|`5-15s`\|`15-60s`\|`1-5m`\|`>5m`) | Every field is an enum or a log-scale bucket. No surface key, session id, or principal id — and no precise count. The buckets are deliberately too coarse to correlate to one specific conversation, even with collector-side timing. |
| `oe.turn.first_output` | `oe.surface` · `oe.kind` · `oe.latency.bucket` (`<5s`\|`5-15s`\|`15-60s`\|`1-5m`\|`>5m`, from the turn's start to the END of its FIRST completed step) | One row per turn. A separate event rather than an attribute on `oe.turn.completed`, because a turn that HANGS emits no completion row and that is the case worth watching. 🔴 The window **includes that step's tool execution**, so it is an **upper bound** on time-to-first-output, not a floor — a turn whose first act is a long `bash` reports the whole wait. It says nothing about usefulness: nothing reads what the step produced. Same three enum/bucket labels — no surface key, session id, or principal id. See [On-call conventions](../capabilities/on-call-conventions.md). |
| `oe.turn.failed` | `oe.surface` · `oe.error.code` (Eve's failure **code** only — never the message) | Failure codes are a bounded platform vocabulary. Messages are excluded *by type*, because a message can embed your org's content. |
| `oe.error.uncaught` | `oe.component` (the `[open-everywhere:x]` component name — code-defined, ships in the OSS source) · `oe.error.name` (the Error **class** name only, e.g. `TypeError`) | Component names are public source. Class names are JS builtins/code-defined identifiers. No message, no stack trace — ever (a stack can contain file paths or environment details). |
| `oe.feature.used` | `oe.feature` (bounded enum: `agent_created`\|`approval_requested`\|`approval_decided`\|`approval_judge_contradicted`\|`bash_hang_guard`\|`pr_opened`\|`routine_cancelled`\|`routine_fired`\|`routine_permission_card`\|`routine_permission_card_wait`\|`skill_created`\|`skill_deleted`\|`spend_cap_hit`\|`spend_checkpoint`\|`stall_guard`\|`webhook_declared`\|`webhook_received`\|`webhook_rotated`) · `oe.outcome` (bounded enum: `ok`\|`failed`\|`noop`\|`declined`\|`denied`\|`withheld`\|`deduped`\|`approved`\|`autoapproved`\|`rejected`\|`granted`\|`continued`\|`tripped`\|`expired`\|`unverified`\|`deadline`\|`stale`\|`gone`\|`unreadable`\|`unknown`\|`not-judge-lift`\|`already-recorded`\|`recorded`\|`halted`) | Two enums, and nothing else. The pair tells us which *capabilities* get exercised and how they ended — never on what, by whom, or about what. Both lists are the code's own (`FEATURE_VALUES` / `OUTCOME_VALUES` in `packages/core/agent/observability/telemetry.ts`), and a test pins this row to them in both directions, so this table cannot drift from those lists. What that test checks in the *code* is every call site that passes a **literal** value: a new literal outside the lists fails the build. The **emitter** closes the rest: `emitTelemetry` checks each `oe.feature` / `oe.outcome` value against these lists and drops an undeclared one before the record is queued, naming it in the deploy log. So a call site that passes the value in a variable — which the source scan cannot read — cannot put an undeclared string on the wire either. The event still sends, minus that one attribute. |
| `oe.audit.dropped` | `oe.action` (the audit row's own action name, e.g. `pr.open` — an OE-defined label) · `oe.platform` (the surface type the write came from) | Fired when an audit write is dropped after its retries fail, so audit-write health is visible without the audit log being the only witness to its own gaps. Both fields are OE-controlled labels — never an org id, a principal, or any row detail. |
| `oe.reaction.added` / `oe.reaction.removed` | `oe.surface` (type enum: `slack`\|`discord`) · `oe.on_bot_reply` (bool — did the reaction land on one of the bot's own replies) · `oe.emoji_class` (bounded enum: `positive`\|`negative`\|`other`) | Fired when an inbound reaction is ingested. Three low-cardinality fields: the surface *type*, a boolean, and a coarse emoji *bucket* — never a channel id, a user id, or the raw emoji name (a custom emoji name can itself carry text, so it is bucketed and dropped). |

### The never-collected list (verbatim)

**Never, under any circumstance, in any event:** org names · workspace/channel/user/
session ids · surface keys · message content · memory content · anything from a DM ·
error messages or stack traces · environment variable values · repo or domain names ·
IP addresses (the collector discards these — see below) · precise token counts ·
user or channel counts.

## The retired install-wizard events

`wizard.started` and `wizard.completed` are **retired.** The emitter lived in the unscoped
`create-open-everywhere` releases; `@open-everywhere/create` ships none of it, and no version of this
product sends them from anywhere else.

| Event | Attributes | Status |
|---|---|---|
| `wizard.started` | `oe.wizard.version` (that package's own semver) · `oe.wizard.platform` (`darwin`\|`linux`\|`win32`\|`other`) | No longer emitted. |
| `wizard.completed` | `oe.wizard.version` · `oe.wizard.platform` · `oe.wizard.steps_completed` (a bucketed step count) | No longer emitted. |

**Why they went.** These two were gated differently from the other ten: they additionally required
an explicit accept / decline / redirect answer to a prompt the interactive install wizard showed
before either could fire — the wizard *was* the disclosure surface, so a person was always at the
keyboard when consent was captured. OPE-2233 retired that wizard: setup is agent-led, the CLI
scaffolds and reports status and nothing more, and a CLI with no terminal has nowhere to show a
consent prompt. An accept could therefore never be recorded again, so the events could never fire
again, and the emitter, the prompt and the `.open-everywhere/wizard-state.json` consent file went
with it. The deliberate trade that was always stated here still holds, now absolutely: **a
`@open-everywhere/create` run sends genuinely nothing — not a "declined" beacon, not a
differently-shaped byte, nothing at all.**

**The two names stay in the closed vocabulary** (`EVENT_SCHEMA` in
`packages/core/agent/observability/telemetry.ts`) and in the collector's schema
(`deploy/oe-telemetry/src/schema.ts`). That is not an oversight: already-published versions of
`create-open-everywhere` — the unscoped name the scaffolder shipped under before OPE-2234 moved it
to `@open-everywhere/create` — are on npm and still emit them under their own consent prompt, so
removing the names would make the collector drop a payload a user explicitly agreed to send. The
names are kept so those events are still accepted; nothing in this repository emits them.

## First-boot grace window

The exact failure this design avoids: shipping data in the **same run** that first
discloses telemetry to you (.NET's most-cited flaw; Homebrew's 2016 flame, fixed in
24 hours). So:

- **The disclosure line prints before anything is ever transmitted, every boot.**
- On the **very first boot** — the one that mints your instance's anonymous id —
  **zero bytes are sent.** No `first_boot`, no heartbeat, nothing.
- `oe.instance.first_boot` fires on the **next** boot (or, if your operational store
  was unreachable at first boot, the next call within that one warm process — there's
  nothing durable to defer across a cold start in that fallback case).

You will always have seen this page (or at least the boot line pointing at it)
before your deployment ever sends a byte.

## The boot line

Every boot prints, before anything is transmitted:

```
[open-everywhere:telemetry] anonymous usage telemetry is ON — see docs/deploy/telemetry.md; OE_TELEMETRY=off or DO_NOT_TRACK=1 disables
```

(or, when disabled: `anonymous usage telemetry is OFF (OE_TELEMETRY / DO_NOT_TRACK)`).

## Where the setup path discloses it

The boot line is not the only disclosure. A scaffolded app states that telemetry is on, and how to
turn it off, in four files the setup path reads (OPE-2399):

- `README.md` — a "Telemetry" section.
- `AGENTS.md` — tells the coding agent to tell the person before the first deploy.
- The `quickstart-open-everywhere` skill — a section the agent follows before the first deploy. It
  asks the person to choose, and sets `OE_TELEMETRY=off` on the deployment when they opt out.
- `.env.example` — a commented `# OE_TELEMETRY=off` line.

An agent-led setup that follows the skill therefore shows the person the disclosure before the first
deploy.
`@open-everywhere/create`'s own tests pin all four. The default itself is unchanged: ON.

## One full example payload

The exact OTLP/JSON wire shape (`resourceLogs[].scopeLogs[].logRecords[]`,
lowerCamelCase field names, int64s as **decimal strings** — OTLP spec 1.10.0) for one
`oe.turn.completed` event:

```json
{
  "resourceLogs": [
    {
      "resource": {
        "attributes": [
          { "key": "service.name", "value": { "stringValue": "open-everywhere" } },
          { "key": "service.version", "value": { "stringValue": "0.4.0" } },
          { "key": "service.instance.id", "value": { "stringValue": "00000000-0000-4000-8000-000000000002" } },
          { "key": "deployment.environment.name", "value": { "stringValue": "production" } },
          { "key": "oe.host", "value": { "stringValue": "vercel" } },
          { "key": "oe.node.major", "value": { "intValue": "24" } }
        ]
      },
      "scopeLogs": [
        {
          "scope": { "name": "open-everywhere-telemetry" },
          "logRecords": [
            {
              "timeUnixNano": "1783430400000000000",
              "eventName": "oe.turn.completed",
              "attributes": [
                { "key": "oe.surface", "value": { "stringValue": "slack" } },
                { "key": "oe.kind", "value": { "stringValue": "channel" } },
                { "key": "gen_ai.request.model", "value": { "stringValue": "deepseek/deepseek-v4-flash-0731" } },
                { "key": "oe.tokens.bucket", "value": { "stringValue": "10-100k" } },
                { "key": "oe.steps.bucket", "value": { "stringValue": "2-5" } },
                { "key": "oe.latency.bucket", "value": { "stringValue": "5-15s" } }
              ]
            }
          ]
        }
      ]
    }
  ]
}
```

## How the vocabulary is enforced at run time

The event list above is a **closed** vocabulary, and `emitTelemetry` holds it closed at the moment
of the call rather than only at review time. It never throws, and it drops at two different grains:

- **An unregistered event name is dropped whole**, with a warning emitted once.
- **An attribute key outside that event's own allow-list is dropped on its own**, and the rest of
  the event still sends.
- **An attribute whose value is outside its closed value list is dropped the same way.** 🔴 **The
  attribute goes, not the event.** Losing the whole event would turn a vocabulary slip into a hole
  in the operator's own numbers.

The value lists are enforced at run time as well as in the types, so a hoisted variable is held to
exactly the same closure a string literal would be. `emitTelemetry` is also a no-op when telemetry
is disabled, when the instance id is not resolved yet, and — in debug mode — after logging the
payload it would have queued.

**The queue is bounded at 200 records, dropping the oldest**, so a dead endpoint cannot grow memory.
`droppedTelemetryCount` reports the drops from both causes — queue overflow and a failed flush — and
the heartbeat reports that count back, so the gaps are visible rather than silent. `flushTelemetry`
posts the batch fire-and-forget, counting every rejection and warning once.

**The surface census is built fail-closed.** A provider bundle registers its own credential probe,
so core never holds a vendor's environment-variable name. `surfacesWithCreds` then calls each probe
inside its own guard: a probe that is not registered, or that throws, simply never reports its
surface as present — a misbehaving probe must not break the heartbeat. The census is collected into
a set, so a platform registered twice cannot double-count.

**A probe may be async (OPE-2241).** A credential that `/setup` stored in the encrypted credential
store can only be read with an await. So the census awaits each probe, and the heartbeat is queued
only when the census has its answers. Only an answer of `true` reports a surface. A probe that
resolves `false`, rejects, or does not answer within two seconds reports its surface absent. The
Slack probe reads both homes of the bot token, env first and then the store, so a deployment that
`/setup` configured reports `slack`. `flushTelemetry` waits for a pending heartbeat before it posts.

`telemetryStatusLine` renders the status line the slash command shows.
`resetTelemetryConfigCache` drops the memoized config so the next read re-derives it from the
current env. It is module-private: its one caller outside tests was the install wizard's "redirect
to your own collector" answer, which went with the wizard (see above), and nothing else mutates
`OE_TELEMETRY_OTLP_URL` after the first emit.

### The turn clock

The per-turn accumulator behind the latency and token fields lives in the session context, and every
one of its four entry points is best-effort.

- `readTurnClock` returns this turn's accumulator, or nothing outside a session context — a
  schedule, an eval, a CLI. It never throws at a caller.
- `resetTurnClock` starts a fresh accumulator. It is called from the turn-start hook **and by
  nothing else**.
- `bumpTurnClock` folds one step's tokens into the running totals, minting a turn when none was
  started. The start time then dates from that first step rather than from the wake.
- `turnElapsedSeconds` reports this turn's elapsed seconds.

🔴 **Undefined is not zero, and a caller must not read it as "the turn just started."** No turn slot
means no session context at all, and a caller that bounds work against this clock has to fall back
to its own assumption. A **negative** reading — a clock the host moved backwards — answers undefined
for the same reason: an elapsed time this module did not observe must never be reported as one it
did.

## Retention

**Raw events: 90 days. Aggregates: indefinitely.** The collector is a separate,
small project with its own deploy. Its code is open source and lives in this
repository, in [`deploy/oe-telemetry/`](../../deploy/oe-telemetry/) — so a claim like
"we don't store IP addresses" is checkable by reading the code that ingests your
payload, not just a promise on this page.

## Config

| Var | Default | Behaviour |
|---|---|---|
| `OE_TELEMETRY` | `on` | `off` / `0` / `false` disables everything. Checked first — wins over every other setting. |
| `DO_NOT_TRACK` | — | Any truthy value disables everything (honored as a courtesy — the same convention Dagger, Turborepo, Scarf, and netdata respect). Checked second. |
| `OE_TELEMETRY_DEBUG` | — | `1` prints every would-be payload to the console **without sending it** — inspect exactly what would go out before you decide whether to opt out. Costs nothing to check. |
| `OE_TELEMETRY_OTLP_URL` | Our default collector | Any OTLP/HTTP logs endpoint. **Setting this redirects 100% of the payload — nothing is ever teed to the default collector.** Point it at your own Grafana/Axiom/collector and the identical payload lands there instead. |
| `OE_TELEMETRY_OTLP_HEADERS` | — | `Name=value,Name2=value2` — auth headers for a redirected, authed collector (mirrors `OTEL_EXPORTER_OTLP_HEADERS`). |
| `EVE_TELEMETRY_DISABLED` | `1`, set by Open Everywhere | eve's switch for its own CLI telemetry, not Open Everywhere's. See [eve's CLI telemetry is off](#eves-cli-telemetry-is-off). |

Precedence: `OE_TELEMETRY=off` > `DO_NOT_TRACK` > the redirect URL. Same never-throw,
never-block contract as the rest of Open Everywhere's observability seams (see
[Observability](./observability.md)): telemetry is a bounded, drop-oldest, fire-and-
forget queue — it can never fail or slow down a turn.

## Rotate your instance id

The instance id is one row in your operational store (`instance_meta`, key
`telemetry.instanceId`). Delete that row (or point `OE_OPERATIONAL_PROVIDER` /
`OE_SQLITE_PATH` at a fresh store) and the next boot mints a new one — the grace
window above applies again, exactly as on a first-ever deploy.

## See also

[Observability](./observability.md) for the separate (opt-in) structured-log-shipping
and tracing seams — telemetry is intentionally its own module with its own env
surface, closed vocabulary, and default, so it can be reasoned about independently.
