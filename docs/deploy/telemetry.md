# Telemetry

Open Everywhere ships **anonymous usage telemetry, default ON**. This page is the
canonical disclosure: every event, every attribute, the full never-collected list,
retention, and how to turn it off, redirect it, or rotate your instance's id. If
you're a DPO/security reviewer evaluating a deploy, this page — plus
`OE_TELEMETRY_DEBUG=1` (below) — is everything you need.

**Opt out with one env var: `OE_TELEMETRY=off` (or `DO_NOT_TRACK=1`) — full stop, forever.**

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

Twelve events, total: the ten runtime events below, plus two install-wizard funnel
events (`wizard.started`/`wizard.completed` — see
["The install wizard's events"](#the-install-wizards-events-a-different-consent-regime)
below, which is a **different, stricter consent regime** from the ten). **These
tables are the entire payload — nothing else is ever sent.** The code enforces this
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
| `oe.instance.heartbeat` | `oe.surfaces` (sorted list of surface **types** with credentials configured — from: `slack`, `discord`, `teams`, `github`, `linear`, `webhooks`) · `oe.memory_provider` (`git`\|`sqlite`\|`postgres`\|`github`\|`notion`) · `oe.operational_provider` (`sqlite`\|`postgres`) · `oe.model.primary` / `oe.model.utility` (public AI-Gateway model-id strings, e.g. `deepseek/deepseek-v4-flash-0731`) · `oe.domains.bucket` (`0`\|`1`\|`2-5`\|`6+`) · `oe.telemetry.dropped` (count of telemetry records **this instance** has dropped) | Surface *types* are product vocabulary — never a workspace/channel id. Providers are enums. Model ids are public catalog strings (a config choice, not user data). The domain count is bucketed so it can never fingerprint your org's exact structure. The dropped-count is purely self-referential health. Sent at most once per 6h per instance, lazily on turn activity or cold boot. |
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

## The install wizard's events — a different consent regime

The `create-open-everywhere` install wizard (`packages/create`) can send two more
events, completing the adoption funnel (npm downloads → `wizard.started` →
`wizard.completed` → `oe.instance.first_boot` → heartbeat = conversion → activation
→ retention):

| Event | Attributes | Why each attribute cannot leak |
|---|---|---|
| `wizard.started` | `oe.wizard.version` (this package's own semver) · `oe.wizard.platform` (`darwin`\|`linux`\|`win32`\|`other`) | A version string and an OS-family enum. Fires **once per install**, immediately after the disclosure prompt below records an accept/redirect decision — never before, never speculatively. |
| `wizard.completed` | `oe.wizard.version` · `oe.wizard.platform` · `oe.wizard.steps_completed` (bucketed count of the 10 v1 steps satisfied at run end: `0`\|`1-3`\|`4-6`\|`7+`) | Same as above, plus a coarse progress bucket — never the exact count, never which steps. Fires **once per install**, at the end of an interactive wizard run. |

**These two are gated differently from the other ten.** The ten runtime events
above obey `OE_TELEMETRY`/`DO_NOT_TRACK` only — the org admin "consents by
deploying, having read the boot line." The wizard events additionally require an
**explicit accept / decline / redirect answer** to a prompt the wizard shows before
either event can ever fire — the wizard itself *is* the disclosure surface, so a
human is always at the keyboard when consent is captured (a stronger guarantee than
a boot-line notice, which the wizard doesn't need to fall back on).

**Consent ordering, pinned by test:** nothing from these two events is ever queued
or sent before that prompt records a decision (`packages/create/scripts/
telemetry-test.ts` proves this directly, including the ordering itself, not just
the outcome). **Declining sends genuinely nothing — not a "declined" beacon, not a
differently-shaped byte, nothing at all — for this install, ever.** The deliberate
trade this implies: a declined install is invisible to the funnel. That's
considered correct, not a gap — an opt-out that still phones home to say so isn't
really an opt-out. `DO_NOT_TRACK`/`OE_TELEMETRY=off` set ahead of time skips the
prompt entirely and auto-records a decline, honouring the exact same signal the ten
runtime events do. Consent (and a one-time-per-install guard for each event) is
persisted in `.open-everywhere/wizard-state.json` inside the target checkout —
wizard-internal bookkeeping, not app config; gitignored, never shared.

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

`telemetryStatusLine` renders the status line the slash command shows.
`resetTelemetryConfigCache` forces a config re-read, which is what lets the install wizard change
the endpoint mid-process and have the change take effect.

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
small project (its own repo, its own deploy) that will be **published open source**
— so a claim like "we don't store IP addresses" is checkable by reading the code
that ingests your payload, not just a promise on this page.

## Config

| Var | Default | Behaviour |
|---|---|---|
| `OE_TELEMETRY` | `on` | `off` / `0` / `false` disables everything. Checked first — wins over every other setting. |
| `DO_NOT_TRACK` | — | Any truthy value disables everything (honored as a courtesy — the same convention Dagger, Turborepo, Scarf, and netdata respect). Checked second. |
| `OE_TELEMETRY_DEBUG` | — | `1` prints every would-be payload to the console **without sending it** — inspect exactly what would go out before you decide whether to opt out. Costs nothing to check. |
| `OE_TELEMETRY_OTLP_URL` | Our default collector | Any OTLP/HTTP logs endpoint. **Setting this redirects 100% of the payload — nothing is ever teed to the default collector.** Point it at your own Grafana/Axiom/collector and the identical payload lands there instead. |
| `OE_TELEMETRY_OTLP_HEADERS` | — | `Name=value,Name2=value2` — auth headers for a redirected, authed collector (mirrors `OTEL_EXPORTER_OTLP_HEADERS`). |

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
