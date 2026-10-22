# Provider rate limits — who handles 429

Every vendor this repo writes to answers a rate-limited call with HTTP 429 and a `Retry-After`
header. This page records, per provider, WHERE that call leaves the host and WHETHER anything
honours the header. It started as a measured audit (OPE-1211, 2026-08-27) and is updated as each
gap closes — OPE-1253/OPE-1255/OPE-1237/OPE-1288/OPE-1236 closed the ones this page names below.

## The headline finding

**No provider package in this repo depends on a vendor SDK.** Not `@slack/web-api`, not `discord.js`,
not `@notionhq/client`, not `@linear/sdk`, not `octokit`, not `@microsoft/microsoft-graph-client`.
Every `packages/providers/*/package.json` lists only `@open-everywhere/core` and `zod` as runtime
dependencies (Slack adds `undici`). `eve` is a peer dependency, and it is a framework, not a vendor
SDK.

That answers the question a reader usually asks first. A vendor SDK often ships a retry policy, and
where one does, the provider needs no backoff of its own. **No such policy applies anywhere here.**
Every provider talks raw HTTP, so every provider seam needs a backoff written in this repo.

One near-miss is worth naming, because it looks like coverage and is not. eve's bundle DOES contain
Slack's official `WebClient`, which reads `retry-after` and pauses its request queue
(`node_modules/eve/dist/src/compiled/@chat-adapter/slack/index.js`). That client is NOT on the path
this repo uses. eve's `callSlackApi` comes from a different module in the same directory —
`.../@chat-adapter/slack/api.js` — which is a bare `fetch` POST with no 429 handling at all. Grepping
the bundle for `retry-after` finds the first file and suggests the write path is covered. It is not.

## The audit

| Provider | The write seam | Vendor SDK | Honours 429/`Retry-After`? | Evidence |
| --- | --- | --- | --- | --- |
| **Slack** | `callSlackWebApi` — `packages/providers/slack/agent/channels/slack-web-api.ts` | none | **PARTLY** — since OPE-1211 | Covers every call this repo issues DIRECTLY. The eve-binding paths do NOT — see below. `slack-web-api-seam-test.ts` pins that boundary. |
| **Discord** | `discordFetch` — `packages/providers/discord/agent/channels/discord-rest.ts` (created by OPE-1236 over the reply seam `discord-post.ts` and the message ops `discord-message-ops.ts`, 10 calls; extended by OPE-1311 over the gateway's own 5 writes in `discord-gateway.ts`, and by OPE-1282 over the deferred-interaction edit in `discord-interaction-defer.ts`) | none | **PARTLY** — since OPE-1236, extended OPE-1311 and OPE-1282 | Covers every WRITE in those four files — 16 calls — and is the ONE seam that honours a body field: Discord states the delay in a JSON `retry_after` field as well as the header, and the body wins. The four READ channels (`discord-read.ts`, `discord-backscroll.ts`, `discord-directory.ts`, `discord-bot-name.ts`) still use raw `fetch` — see below. `discord-rest-seam-test.ts` and `discord-rate-limit-test.ts` pin it. |
| **Teams** | `teamsConnectorWrite` — `packages/providers/teams/agent/channels/teams-connector.ts` (created by OPE-1237, host-side, replacing eve's `sendTeamsActivity`/`replyToTeamsActivity`/`updateTeamsActivity`/`callTeamsConnectorApi`) | none | **PARTLY** — since OPE-1237 | Covers every Connector WRITE this repo issues: the mid-turn and unified post/reply arms, the edit arm, the 1:1-conversation create, the direct-message send, and `teams-front.ts`'s fail-soft external-policy notice. `teams-read.ts` (Microsoft Graph reads) AND `teams-roster.ts`/`teams-directory.ts`/`teams-graph-team-id.ts` (Bot Framework CONNECTOR reads, via eve's still-imported `callTeamsConnectorApi`) all still use raw `fetch` with no backoff — see below. `teams-connector-seam-test.ts` (OPE-1298) pins the eve-client boundary: it reds when a NEW file *calls* `callTeamsConnectorApi`, when a tracked caller stops calling it, when a tracked caller gains a **double-quoted uppercase method literal** (`method: "POST"`), or when any file reaches eve's `sendTeamsActivity`/`replyToTeamsActivity`/`updateTeamsActivity`. Since OPE-1408 its §5 also tracks every module reaching the global `fetch` — the seam plus the two Microsoft Graph transports (`teams-read.ts`, `agent/ops.ts`) — in both directions, so a Connector write issued as a raw `fetch` to a `serviceUrl` reds when it arrives in a module that holds no transport today. 🔴 Three things it still does NOT see, all pinned by its own §0 controls: a write whose method is a variable, template literal, spread or lowercase string; a call through an INJECTED `fetch`, which no matcher here names; and a raw Connector write added INSIDE one of the two already-tracked Graph modules, which changes neither the set nor either entry's route. The three Connector READS above stay a tracked, open gap. The team-details read is cached per team, so it costs one uncovered read per team per process ONCE RESOLVED; a team that does NOT resolve is re-read on every wake, by design — a failure is never cached, so one blip can never freeze a surface as unreadable. |
| **Notion** | `notionFetch` — `packages/providers/notion/agent/channels/notion-api.ts` (a single funnel already), plus the memory backing's `NotionClient` (OPE-1255) | none | **PARTLY→mostly covered** — since OPE-1233, extended OPE-1255 | Covers every REST call in `notion-api.ts`, reads and writes alike, AND the memory backing's client, its subtree read and its block append alike. `notion-rate-limit-test.ts` and `notion-write-seam-test.ts` pin it. The granted plane no longer appears here as a Notion REST funnel: personal lending borrows an MCP tool (OPE-1136), and that borrow transport carries its OWN backoff since OPE-1311's sibling OPE-1338 — see "The granted plane" below. |
| **Linear** | `callLinear` / `createLinearActivity` — `packages/providers/linear/agent/channels/linear-graphql.ts` (created by OPE-1234 over the ~20 call sites that each reached eve directly); the token mint (`mintLinearAppActorToken`, `linear-credentials.ts`) is covered separately (OPE-1288) | none | **YES for the package** — since OPE-1234, mint since OPE-1288 | Covers every GraphQL query and mutation this package issues, reads and writes alike, AND eve's own Agent-Session calls: `linearChannelApi()` is passed to both `linearChannel({...})` configs, and eve threads `config.api` into its default `message.completed` poster, its `LinearHandle` and the agent-session dispatch. The mint honours a 429 via `withRetryAfterLoose`. Those two modules are the package's WHOLE transport inventory: `linear-write-seam-test.ts` §3 reds when a third module opens its own `globalThis.fetch`, §5 when any `agent/` file calls a bare `fetch(`, and §2 when any file but the seam names one of eve's Linear transport exports — that inventory is derived at test time (widened by OPE-1400) from EVERY module of eve's `channels/linear/` that can issue a request — its `.js` reaches a `fetch`, or it imports the transport module — intersected with what `index.d.ts` re-exports, so a request-issuing export added anywhere in that directory is watched the day it lands. The grain is the MODULE, so a red there is a triage prompt rather than a proof of a bare call; `linearChannel` is excluded by name because §4 watches it better. §2 is what catches a call site that would make its request from INSIDE eve, where a source scan of this package sees nothing. §4 refuses a `linearChannel(cfg)` config passed by name, because the gate reads the `api:` out of an inline literal and can read nothing else. `linear-rate-limit-test.ts`, `linear-write-seam-test.ts` and `linear-credentials-test.ts` pin it. |
| **GitHub** | `githubWrite` — `packages/providers/github/agent/channels/github-post-arm.ts` (created by OPE-1235 over the comment, edit and reaction writes); core's SCM write plane and the read adapter are covered separately (OPE-1253/OPE-1255) | none | **PARTLY→mostly covered** — since OPE-1235, extended OPE-1253/OPE-1255 | Covers the three CHANNEL writes in that package, `github-read.ts`'s issue/PR reader, and core's `scm/{issue-actions,pr,contents,refs}.ts`. It does NOT cover the installation-token mint (`scm/mint.ts`) — a PROTECTED path no diff may touch without a reviewed override — see below. `github-rate-limit-test.ts`, `github-write-seam-test.ts` and `scm-rate-limit-test.ts` pin what it covers. |

A "NO" row means a rate-limited write fails on the first refusal. What the caller does with that
failure varies, and some callers swallow it — `slack-wake-backscroll.ts`'s `liveRequest` and
`slackForm` both fail soft by design — so on those paths a 429 reads as "no answer" rather than as
an error anyone sees.

A "PARTLY" row means the named seam is covered and something else on the same provider is not. Every
such gap is listed below. A gap INSIDE the provider package is also pinned by that package's source
scan, so it reds when a new transport appears. A gap in `packages/core` is NOT pinned by anything —
the provider scans read their own package only — so those are listed here and nowhere else.

## The shared backoff

`packages/core/agent/channels/rate-limit-retry.ts` is the one primitive a seam wraps its request in.
It is deliberately small:

- A response that is **not** a rate-limit refusal comes back unchanged. A refusal is a 429 — and, on the one seam that opts in, a 403 carrying a readable `Retry-After` (see *The 403 spelling* below). A 5xx, a transport throw, and an
  application-level refusal such as Slack's HTTP-200 `ok:false` all keep their exact behaviour.
- A 429 waits what `Retry-After` names — both RFC 9110 forms, delta-seconds and HTTP-date — capped
  per wait (`DEFAULT_CAP_MS`, 30 s), bounded in attempts (`DEFAULT_MAX_ATTEMPTS`, 4) AND bounded in
  total wait (`DEFAULT_TOTAL_BUDGET_MS`, 60 s). Attempts and the per-wait cap alone do not bound
  latency — `(maxAttempts - 1) x capMs` is 90 s — which is why the total budget exists.
- When the attempts run out it throws `RateLimitExhaustedError`, which names the surface and the
  operation. Naming it is not the same as making it loud: a fail-soft caller still swallows it, so
  the two Slack callers that do (`slackForm` and the wake-backscroll fetcher) log it by name first.

It does **not** read `X-RateLimit-*` headers and does **not** pace calls ahead of a refusal. It also
never retries a request the vendor left unanswered: such a request may already have applied, and
repeating it could post a message twice.

Two adapters put a caller onto this one road rather than growing a second: `withRetryAfterLoose`, for
a fetch shape whose declared type carries no `headers`, and `withRetryAfterThrown`, for a client that
turns the 429 into an error before its caller sees a response. Both are covered below.

## What the Slack seam does not cover

A Slack Web API call reaches Slack two ways, and only one of them is OE's to wrap:

1. **Directly**, through `callSlackWebApi` — `slackForm` (so every reply, card and edit),
   `callSlackRead`, the `auth.test` probes, and the wake backscroll. These carry the backoff.
2. **Through eve's session binding** — `ctx.slack.request(...)` and `ctx.thread.post*(...)`. These
   resolve inside eve to the same bare `callSlackApi`. OE never sees the request, so it cannot wrap
   it, and these calls still fail on the first 429.

The category-2 sites, as of this audit:

| File | Calls |
| --- | --- |
| `slack.ts` | `conversations.info`, `users.info`, `pins.list`, and `thread.post` for the intro and unmapped-wake notices |
| `slack-context.ts` | `auth.test`, `conversations.history` |
| `slack-input-response.ts` | `thread.postEphemeral` |

Plus eve's own machinery, which OE cannot reach at all: the thread `refresh` (`conversations.replies`)
and `uploadSlackFiles`. eve's `startTyping` (`assistant.threads.setStatus`) never reaches Slack: since
OPE-2668 the channel's transport answers it locally (`slack-working-signs.ts`).

`slack-web-api-seam-test.ts` holds that list and fails when a **new** binding call appears or a
listed one disappears, so the gap is a tracked inventory rather than a comment that rots. Closing it
means either moving those call sites onto the seam — which changes their token source from the bound
session to the env, so it is a real decision, not a mechanical edit — or wrapping them upstream in
eve.

## What the Notion, GitHub and Linear seams do not cover — and what closed

OPE-1255 closed the two read-only gaps (`NotionClient`, GitHub's `PrFetchFn` reader) and OPE-1253
closed core's SCM write plane. ONE gap remains, and it is a deliberate one — not an oversight:

| Provider | Uncovered transport | What it is | Why it is still uncovered |
| --- | --- | --- | --- |
| **GitHub** | `mintInstallationToken` — `packages/core/agent/scm/mint.ts` | The App installation-token mint | 🔴 A WRITE-PATH GAP, not a read one. It is a bare `fetch` POST to `api.github.com`, and it runs immediately BEFORE every covered write. A 429 there loses the reply exactly as a 429 on the write used to. `scm/mint.ts` is a PROTECTED PATH (`scripts/upgrade-fence/manifest.ts`'s `github-permission-sets` rule — "the GitHub installation-token mint bodies... decide what the agent's own credential may do"), so any diff touching it is refused by `deploy:merge-fence`, whoever authored it. Closing this needs the orchestrator's explicit review-and-override. |

**Closed as of OPE-1253/OPE-1255/OPE-1288** (kept here for the record, since the closed state is
itself worth naming — a "PARTLY" that quietly becomes "done" and stops saying so is the false
reliability claim this page exists to prevent):

- `mintLinearAppActorToken` (`packages/providers/linear/agent/channels/linear-credentials.ts`) — the
  client-credentials token mint, and the last Linear transport outside the OPE-1234 GraphQL seam.
  Typed over `LinearMintFetch` (`{ok, status, text, json}`) rather than `Response`, so it carries the
  backoff via `withRetryAfterLoose`. It never ran before every write the way GitHub's mint does: the
  token is held warm for its whole 30-day life. `linear-credentials-test.ts` proves the behaviour and
  `linear-write-seam-test.ts` §3 tracks the module `covered: true`.

- `NotionClient` (`packages/providers/notion/agent/memory/memory.ts`) — the memory backing's
  block-children client: `children` reads the subtree and `appendChildren` writes it back (OPE-70).
  Typed over `HttpFetch` rather than `Response`, so BOTH carry the
  backoff via `withRetryAfterLoose` (see "Adding the backoff to a `{ok, status, text, json}`
  transport" below) rather than `withRetryAfter` directly. `notion-write-seam-test.ts` § 2 tracks it
  `covered: true`.
- `PrFetchFn` (`packages/providers/github/agent/channels/github-read.ts`) — the issue/PR reader
  behind the describe/container reads. Same shape, same adapter. `github-write-seam-test.ts` § 4
  tracks it `covered: true`.
- `callIssueApi`, `createGithubIssue`, and the PR/contents/refs writers —
  `packages/core/agent/scm/{issue-actions,pr,contents,refs}.ts`. Every call now goes through
  `withRetryAfterLoose`, each with its own vendor route name (`issues.update`, `pulls.create`,
  `repos.contents.put`, `git.refs.create`, and so on). `scm-rate-limit-test.ts` pins it.

`notion-write-seam-test.ts` § 2 and `github-write-seam-test.ts` § 4 hold the in-package transport
inventories and red when a NEW module grows its own transport, when a listed one disappears, or when
a module's `covered` flag disagrees with its source. Neither scan can see `packages/core`, which is
why `scm-rate-limit-test.ts` exists as core's own proving suite rather than a scan.

## What the Discord seam does not cover

OPE-1236 put `discordFetch` over the reply seam and the message ops. OPE-1311 added the gateway's own
write path — the completion post-back, the open-DM, the typing indicator, the 👀 reaction and the
thread open. Every Discord WRITE now carries the backoff. The READ transports do not:

| Uncovered transport | What it is | Why it is still uncovered |
| --- | --- | --- |
| `discord-read.ts`, `discord-backscroll.ts`, `discord-directory.ts`, `discord-bot-name.ts` | The Discord READ transports (channel history, backscroll, directory, bot name) | Reads, not writes — out of the write-path scope OPE-1236 and OPE-1311 shared. |

`discord-rest-seam-test.ts` § 3 holds these as a tracked KNOWN-UNCOVERED inventory: it reds when a
NEW file grows its own bare `fetch(` (a write that would bypass the seam) or when a listed one
disappears, so the gap cannot widen unnoticed.

### Two policies on the gateway's writes

The gateway's five writes do not all take the shared defaults, and the split is about LATENCY, not
correctness. `triggerDiscordTyping` and `setDiscordReaction` are awaited INLINE on the turn's own
path — typing runs inside the streaming loop. The shared 4-attempt / 30 s-per-wait / 60 s-budget
policy would stall a live turn for up to a minute to deliver an indicator Discord expires after 10
seconds, which is worse for the room than dropping the affordance. So those two take
`AFFORDANCE_RETRY` — one retry, a 2 s ceiling — and the three writes that must LAND (the completion
post-back, the open-DM, the thread open) keep the shared defaults. `slack-web-api.ts` makes the same
call for the `auth.test` probe on Slack's 3-second ack path.

🔴 **Every gateway write is fail-silent, so each names a `RateLimitExhaustedError` before swallowing
it.** The turn has already run and no failure arm may throw into the caller, so an exhausted retry
would otherwise leave no trace anywhere — the silent drop the backoff exists to prevent. This is the
posture `slackForm` and the wake-backscroll fetcher take. `openDiscordDm`'s catch was BARE before
OPE-1311, which made it the one Discord write whose give-up was invisible.

## The granted plane (OPE-1338)

A BORROWED call — personal lending, where the requester spends the OWNER's credential (OPE-1136) —
does not leave through any provider write seam. It goes out through the MCP SDK's
`StreamableHTTPClientTransport`, which has no backoff of its own and turns a 429 into a throw. So a
rate-limited borrow failed on the vendor's FIRST refusal.

That cost more here than on any other path. A `once`-mode grant is BURNED BEFORE the vendor call:
`runGrantedCall` (`agent/access/credential-grant-broker.ts`) takes the single-use CAS at step 4 and
sends at step 6, deliberately, so a crashed call cannot be re-spent. A 429 is not a
`GrantUndispatchedError`, so it took the fail-closed arm and the burn was KEPT — the owner's one-shot
grant spent on a call the vendor never ran.

`borrowRetryFetch` (`agent/connections/grant-mcp-borrow.ts`) now wraps the BASE fetch inside
`withBorrowClient`. Two properties make it sound:

- **It sits BELOW the burn** — three modules and about four frames under `runGrantedCall` — so it
  re-sends under the ONE consumption already taken and cannot re-enter the CAS. A retry installed
  ABOVE the broker would burn again and be refused `burned`.
- **It sits BELOW the fence.** `withBorrowClient` fences the value `borrowRetryFetch` returns, so the
  pin check runs once per logical request and the retry re-sends bytes the fence already approved.

When a deadline is passed — the approve-time catalogue read runs inside a button press with a ~2 s
budget — `borrowRetryFetch` reads what is LEFT of it **per request**, not once at construction. That
is what makes the budget bound the whole read rather than bound each of `initialize`,
`notifications/initialized` and `tools/list` separately. 🔴 It matters more than it looks: the flow
races the consent probe and the token mint through `withinBorrowDeadline`, but calls
`readBorrowToolSchema` BARE — so on that leg this cap and the SDK's `connect` timeout are the only
bounds, with no outer race to cut an overrun off. `deps.retry` is spread BEFORE the budget so a
caller cannot widen it.

🔴 **The session-teardown `DELETE` is deliberately NOT retried.** `withBorrowClient` sends it in a
`finally`, after the borrow already has its result, and swallows whatever it raises — the session
ages out at the vendor when the DELETE does not land. Waiting out a rate limit there would buy
nothing and would stall the turn for up to the whole budget in a block the caller is already past.

🔴 **RESIDUAL: an EXHAUSTED retry still keeps the burn.** That is unchanged and deliberate. This repo
classifies 429 as AMBIGUOUS (`channels/platform-failure.ts`) — a refused call MAY have applied — so
refunding one could double-spend. Turning an exhausted borrow 429 into a refundable
`GrantUndispatchedError` is a change to the refund contract in `agent/access/`, not to this seam.

`grant-mcp-transport-test.ts` § 7 pins the behaviour and the mint-once witness;
`tests/integration/connectors/credential-grant-borrow.test.ts` leg ⑨ proves the wrap is REACHED on
the wiring a real turn uses. No offline tier drives a once-mode burn through a rate limit.

## Adding the backoff to a `{ok, status, text, json}` transport

`withRetryAfter` needs `res.headers.get("retry-after")`, and several fetch shapes in this repo
declare no `headers` field — `PrFetchFn` (`scm/pr.ts`), the Notion memory client's `HttpFetch`
(`memory/memory.ts`), and the Linear mint's `LinearMintFetch` (`linear-credentials.ts`). OPE-1255
posed the choice as "widen the type to add `headers`, or give the primitive an adapter for the
narrower shape." Widening turned out to be the wrong call: `PrFetchFn` alone also types eight
READ-ONLY modules this ticket set never touches (`pr-status.ts`, `pr-feedback.ts`, `github-search.ts`,
`pr-activity.ts`, `pr-diff.ts`, `review/facts-artifact.ts`, `routines/github-entity-read.ts`,
`credentials/config-pr-github.ts`), and `HttpFetch` (`scm/contents.ts`) also types `scm/refs.ts`,
while five further modules consume it indirectly through `GitHubContents`
(`identity/groups-delivery.ts`, `credentials/config-pr-github.ts`, `approvals/webhook-declare.ts`,
`approvals/agent-create.ts`, `approvals/access-request.ts`). A REQUIRED `headers` field on either
type would force every test fake across all of those — unrelated to any backoff — to grow one just
to keep compiling.

So the primitive grew an adapter instead: `withRetryAfterLoose` (`channels/rate-limit-retry.ts`)
wraps `withRetryAfter`, reading `res.headers` when the response happens to carry one (every REAL
`fetch` response does) and falling back to "no usable `Retry-After`" — the SAME answer
`withRetryAfter` gives an unreadable header — when it does not. A caller whose fake response has no
`headers` property still gets real retry-and-eventually-exhaust behaviour, just on the fallback wait
rather than the vendor's named delay; `scm-rate-limit-test.ts`'s `refs.ts` block proves this
explicitly with a 429 fake that carries no `headers` at all.

Every write function that gained the backoff this way also grew an optional `retry?: RetryPolicy`
parameter (`pr.ts`'s `createOrUpdatePullRequest`, `issue-actions.ts`'s `GithubActionOpts`,
`contents.ts`'s `GitHubContents` constructor, each `refs.ts` function, `memory.ts`'s `NotionClient`
constructor, `linear-credentials.ts`'s `mintLinearAppActorToken`) — without it, a test exercising the
429 path would sleep the real default 1–30 s waits. `RetryPolicy` (exported alongside
`RateLimitRetryOptions`) is the tunable half of the retry options a funnel exposes to its caller —
everything except the funnel-fixed `surface`, `operation`, `retryAfterMs` and
`retryForbiddenWithRetryAfter`. **A seam names `RetryPolicy` itself, never an `Omit` of the full
options.** The Linear seam's `LinearRetryPolicy` was such an `Omit` and re-exposed the last two knobs
by accident (OPE-1332): core is the one place that decides what a caller may tune, and an `Omit` list
written at the seam silently stops agreeing with it the moment core fixes another field.

## Adding the backoff to a transport that THROWS its 429 (OPE-1871)

Every seam above reads a rate-limit refusal as a **response**. One caller in this repo never sees
one: the **wake dispatch**, the hop where Open Everywhere hands an inbound wake to eve's queue.
eve's queue client maps a non-2xx to an error class before the call returns, so a 429 on its
`send message` POST arrives as a thrown `TooManyRequestsError` with no status to read.

That gap was live and it lost messages. A live run measured it on Slack: a seat's wake wrote its
`wake.ingress` row, then `surface.wake_failed {"message":"Too many requests — please retry later"}`
14 seconds later, with no `wake.turn_start` at all. The member's mention was answered by nothing,
and nothing retried it.

`withRetryAfterThrown` (`channels/rate-limit-retry.ts`) is the adapter onto the same road — there is
no second backoff. It calls the function, and a rejection that proves itself a rate-limit refusal is
dressed as the response shape `withRetryAfter` already reads, so the attempts, the per-wait cap, the
total budget and the named `RateLimitExhaustedError` are all that loop's, unchanged.

**What counts as a refusal is a SHAPE, never a word in the message** — the same rule
`channels/platform-failure.ts` states for its own classifier. Two signals answer yes: a numeric
`status` of 429, and the vendor client's own error-class `name`. A `cause` chain is walked, because
a re-wrap keeps the wrapped error's class only there. Everything else — a transport throw, a 5xx, a
permission denial — rejects on the **first** attempt as the same error object.

**Retrying the dispatch is safe because a refusal is an answer.** The primitive never repeats a
request the vendor left unanswered: such a request may already have applied. A 429 is the queue
saying it did **not** take the call, so repeating it cannot deliver one wake twice.

**One policy, two dispatch funnels, every topology.** A windowed wake funnels through
`channels/unified.ts` `divertToUnifiedWindow`; all six surfaces use that road. A topology-off wake
funnels through `channels/native-wake-retry.ts` `dispatchNativeWakeWithRetry`; five surfaces have a
native road, while Teams always diverts because `teams-supervisor` requires a window. Both funnels
call `withRetryAfterThrown` with `WAKE_DISPATCH_RETRY_POLICY`, so arming or disarming
`window.topology` does not change the retry answer.

The native wrapper encloses only eve's queue `send`. The provider's existing catch remains outside
it, so a refusal that exhausts the policy still reaches pruned-deployment strand classification in
the same order as before. Slack has three native launch closures in `slack-events.ts` (engaged,
name-drop and supervisor); GitHub, Linear, Notion and Discord each have one. The parity test pins
those seven launch closures to the shared wrapper and pins Teams as the no-native positive control.

The two funnels cannot claim the same audit join. A windowed wake already has a `wakeId`, which
joins ingress, turn-start and reply rows. A native wake has no `wakeId`, so the wrapper mints one
`deliveryId` for the queue dispatch and keeps it stable across refused attempts. That id groups the
native retry rows with each other; it deliberately does not claim an ingress or turn join.

**The wake path passes its own policy**, `WAKE_DISPATCH_RETRY_POLICY` (`channels/wake-timing.ts`), as
the section above tells a latency-critical caller to. One thing is different here and it is worth
naming: eve builds its `send message` error **without** passing the response's `Retry-After` — it
passes one only for its acknowledge and visibility calls — so a refused wake names no delay at all,
and `fallbackMs` is what **every** wait on this road uses rather than the malformed-answer floor it
is elsewhere.

**Two numbers, and they are not the same one.** The wall this road actually hits is **6 s** — three
waits of the 2 s fallback, with neither the per-wait cap nor the 20 s total budget binding at that
size. The **20 s** total budget is the ceiling, and it binds only if eve starts naming a
`Retry-After` on its `send message` error. Size against the 6 s. Two costs of that 6 s are worth
knowing: a Slack channel's wake FIFO is serial, so a refused wake holds that channel's next wake
behind it for the same 6 s; and Notion's route awaits its delivery inline, so the 6 s lands on the
ack Notion is waiting for. Neither sits on a vendor's signature-verification deadline.

Each refused attempt writes a `surface.wake_retry` audit row before its wait — see
[Observability](../deploy/observability.md#when-the-wake-is-refused--surfacewake_retry) for how to
read those rows beside `surface.wake_failed`.

## What a 429 costs on a multi-call path

🔴 THE BUDGET IS PER CALL, NOT PER OPERATION. A path that fires several sequential calls pays the
per-call budget once EACH, so its worst case is the sum, not the shared 60 s ceiling — the backoff
makes a failure SLOWER rather than merely survivable on any such path. This is no longer only
Notion's ingress; OPE-1253/1255/1237 added two more shapes with the same property, so the table below
is now the general accounting, not a Notion-only note:

| Path | Sequential calls | Worst case | Tightened policy? |
| --- | --- | --- | --- |
| One `notionFetch` | 1 | 60 s (the shared total budget) | no |
| `handleNotionDelivery`, awaited before the webhook is acked | ~15 — `retrieveBotUser`, `retrieveComment`, up to 5 `retrieveBlock` parent hops, `listBlockComments`, the ancestry walk. Plus ONE `retrieveBotUser` per SIBLING integration on a multi-integration deployment (OPE-1921), memoised per credential — so N-1 extra calls on a process's FIRST delivery and none after it, and zero on a single-integration deployment | ~30 s on a single-integration deployment, plus the N-1 sibling resolves on a process's first delivery — each one bounded by the same `NOTION_INGRESS_RETRY` (2 attempts / 2 s cap), so a multi-integration deployment's first delivery exceeds the 30 s figure by that much (tightened from ~15 min) | **yes** — `NOTION_INGRESS_RETRY`, 2 attempts / 2 s cap per call (OPE-1254), sized against the ingress function's measured 300 s ceiling. Covers the four calls `deliver` issues directly AND `retrieveBotUser` behind `deps.resolveBotUserId`, which is awaited first |
| `readNotionComments`, a full page sweep | up to ~82 — one `listBlockComments` per scanned block, plus `getBlockChildren` pages. A `blockScanOrder: "newest-first"` sweep (the seat catch-up) pages the children to the END first, so add up to `maxChildPages` = 10 more `getBlockChildren` calls on a page over 100 blocks | ~92 min | no |
| `github-read.ts`'s `readChannel` (OPE-1255) | up to 3 — `issues.get`, up to 2 `issues.comments.list` pages | 60 s (bounded) | **yes** — one `READ_WALK_BUDGET_MS` deadline for the whole read, read per call (OPE-1299) |
| `github-read.ts`'s `readThread` | up to `MAX_REVIEW_PAGES` = 5 `pulls.comments.list` pages (no `issues.get` — the walk is the whole read) | 60 s (bounded) | **yes**, the same deadline — this is the walk it was built for; it was ~5 min |
| The reaction-feedback poll (`github-reaction-feedback.ts`, OPE-1502) | up to 13 — `issues.get`, 1-2 `issues.comments.list` pages, and one reactions read per agent comment the page says carries one, capped at `GITHUB_REACTION_POLL_COMMENT_BUDGET` = 10 | bounded by the calls, not by a deadline | **yes — by SCOPE rather than by retry** (OPE-1540, `github-reaction-scope.ts`). It runs at all only in a conversation the agent is in — one this bundle's reply path has commented in, or one an `@mention` engaged — and roughly `GITHUB_REACTION_POLL_HOURLY_BUDGET` = 60 times per repository per clock hour, so ~780 GETs in a repository's worst hour. The counter is a non-atomic read-then-write, so simultaneous deliveries can push an hour slightly over; a tripped budget writes one `github.reaction_poll_budget` audit row for that hour. It shares `github-read.ts`'s `getJson` backoff (`withRetryAfterLoose`), so a 429 inside an admitted poll is already covered above |
| `teams-front.ts`'s `postTeamsNotice` (OPE-1237) | 1, but AWAITED before the route's `OK()` on the Bot Framework activity ack | 4 s (tightened) | **yes** — 2 attempts / 2 s cap, the `auth.test` shape below, because the Bot Framework redelivers on a slow ack and this file's own dedupe is fail-open on redelivery |
| `postDiscordReply` — the gateway's completion post-back (OPE-1311) | one `discordCreateMessage` per 2000-char chunk, so ~5 for a long completion | ~5 min | no — the post-back must LAND, and it runs off the socket rather than on an ack path |
| The gateway's typing and 👀 reaction (OPE-1311) | 1 each, but AWAITED inline in the streaming loop | 4 s (tightened) | **yes** — `AFFORDANCE_RETRY`, 2 attempts / 2 s, the same shape as `postTeamsNotice`: Discord expires a typing indicator after 10 s, so a longer wait delivers nothing and stalls a live turn |
| One borrowed grant call (OPE-1338) | 3-4 per session — `initialize`, `notifications/initialized`, `tools/call` (the teardown DELETE is not retried) | 60 s per request on the SPEND path, ~3 min for the session | **on the approve path only** — a deadline is passed there and read PER REQUEST, so the whole read is bounded by the ~2 s budget. The spend path passes none and takes the shared defaults per request. |

Notion publishes an average of three requests per second per integration, so the 82-request sweep is
exactly the shape that draws a 429 in the first place. Before OPE-1233 each of those calls failed in
one round trip; now each can wait. Slack answered this class with `PROBE_OPERATIONS` — a tightened
2-attempt, 2-second policy for the calls its 3-second ack path awaits; `postTeamsNotice` copies that
policy exactly, because it sits on the identical shape (a synchronous webhook ack awaiting a
best-effort send). Notion's ingress now has the same answer (OPE-1254): `handleNotionDelivery` builds
its call options in ONE place, `ingressCallOpts`, which passes `NOTION_INGRESS_RETRY` — 2 attempts, a
2 s per-wait cap and a 4 s total budget the cap already binds before. About 15 sequential calls then
spend at most ~30 s of backoff, leaving ~270 s of the ingress function's measured 300 s ceiling for
the work itself. `retrieveBotUser`, awaited ahead of them all behind `deps.resolveBotUserId`, takes
the same policy at its own call site in `notion.ts` — without that it alone could spend 60 s. The
budget is still PER CALL; a budget shared ACROSS the sequence is a change to the primitive every
provider inherits, and OPE-1254 still holds it open. `readNotionComments` is untightened — it runs on
the turn function's 800 s ceiling, so its ~82 minutes is the more distant problem of the two. GitHub's
two read paths ARE bounded: `readChannel` and `readThread` each build one per-walk deadline since
OPE-1299, and that case is settled differently. The `ReadAdapter` interface `readChannel`/`readThread` implement
takes no options object, and all six adapters already spend their trailing parameter on their own
transport seam — so no caller could tighten those paths without a cross-provider interface change.
The adapter tightens them ITSELF instead, which is the shape Slack already uses for
`PROBE_OPERATIONS`: each read builds ONE `READ_WALK_BUDGET_MS` deadline and hands every call what is
left of it. The first call still gets the full budget, so an ordinary single-call read is not made
more likely to fail; what disappears is the multiplication. (The measured `maxDuration` these budgets
run against is [below](#measured-the-function-maxduration-against-the-backoff-ope-1289).)

## What it costs when Slack does rate-limit you

Attempts and the per-wait cap alone do not bound latency, so the numbers are worth stating:

| Path | Worst case |
| --- | --- |
| One `callSlackWebApi` | 60 s (the total budget; the raw `(4-1) × 30 s` would be 90 s) |
| One tier-bearing `postSlackMessage` | ~120 s — `slack-post-arm.ts` retries bare once when the first answer is not ok, so two full sequences |
| A `PROBE_OPERATIONS` identity probe | ~2 s — deliberately tightened, see below |

The probe exception matters. `slack-front.ts` awaits `auth.test` **before** returning `OK()` on the
route Slack posts events to. Slack times that ack out at 3 seconds and re-delivers, and an app that
keeps missing the ack has its event subscription disabled — so the shared defaults would turn a
rate-limit episode into a delivery outage. `slack-web-api.ts` therefore gives a named
`PROBE_OPERATIONS` set — `auth.test`, `conversations.info`, `users.info` and `conversations.open` —
its own 2-attempt, 2-second policy, which those callers tolerate because they all degrade gracefully
when the probe answers nothing.

## What a 429 costs on the Linear path

Linear has no ack-timeout class, and that is a measured property of the route rather than a hope.
`wrapRoute` (`linear.ts`) awaits eve's native handler and then schedules EVERY leg — ambient,
mention, stop, event-plane — through `args.waitUntil`. eve's own handler verifies the signature,
parses the body, hands the agent-session dispatch to `waitUntil` and answers `jsonOk` at once. So no
Linear GraphQL call this repo issues sits on the response Linear is waiting for. Slack's
`PROBE_OPERATIONS` exists because `slack-front.ts` awaits `auth.test` BEFORE its `OK()`; Linear needs
no equivalent for that reason, and has none.

What a 429 costs instead is background time:

| Path | Sequential calls | Worst case |
| --- | --- | --- |
| One `callLinear` or `createLinearActivity` | 1 | 60 s (the shared total budget) |
| The ambient leg — `enrichComment`, `resolveViewer`, then the reply's `commentCreate` | 3 cold, 2 warm | ~3 min |
| The native agent-session leg — `linearOnAgentSession`: the routing hop, `enrichUserGuest`'s `OeUserGuest` probe, then eve's `response` activity | 3 cold, 2 warm | ~3 min |
| The @mention divert leg — `mentionSessionDelivery`: the routing hop, `enrichComment`, `resolveViewer`, then the hand-off `thought` activity | 4 cold, 3 warm | ~4 min |

🔴 THE TWO AGENT-SESSION LEGS ARE DIFFERENT PATHS AND COST DIFFERENT AMOUNTS. They share one routing
verdict (`mentionRoutingFor`, memoised per delivery) and then diverge. `linearOnAgentSession` awaits
the OPE-60 guest probe `enrichUserGuest` (in `linear.ts`) and ends on eve's default
`message.completed` `response`. `mentionSessionDelivery` never calls `enrichUserGuest` — it reads the
guest flag off `enrichComment` — and ends on a `thought` hand-off (in `linear.ts`) or an `error`.

Every count above is the COLD one, and each leg has its own warm path. `resolveViewer`'s `OeViewer`
query is memoised per organization for the process lifetime (`viewerCache`), so only a cold process
pays it — that is the third call on the ambient leg and the fourth on the divert leg.
`enrichUserGuest` is cached per user for `dmTrustTtlMs()`. Size a budget from the cold number.

One case runs longer than any row: on the native leg, a delivery whose team id parsed but whose
privacy did not adds a conditional `enrichTeamPrivacy` (in `linear.ts`), for four cold calls rather
than three.

Before this change each of those calls failed in one round trip and the reply was simply lost.
`LinearApi.retry` is the seam a caller uses to tighten its own policy, and no call site passes one.

🔴 HOW A CHAINED WAIT MEETS THE FUNCTION'S MAXIMUM DURATION: these legs run on the INGRESS
function, whose measured ceiling is 300 s (see [the measurement below](#measured-the-function-maxduration-against-the-backoff-ope-1289)).
The four-cold-call legs — the @mention divert leg, and the native leg that also parses privacy —
spend 240 s of that ceiling in waits alone. About 60 s is left, and it must cover the ack, the
routing hop, and every round trip that never retries. Size a budget against that margin. A
cut-short leg loses the reply anyway, having spent the compute.

## Adding the backoff to a remaining provider

Slack, Notion, GitHub, Teams, Linear and Discord (its reply/message-ops write path) carry
it. The recipe, for a new provider or for a remaining Discord path (the gateway, the reads):

1. Find or create the ONE place that provider's HTTP call leaves the host. Notion already had one
   (`notionFetch`); GitHub did not, and creating `githubWrite` over its three write call sites was
   most of that ticket's work. **Teams had none EITHER, and worse than GitHub's case**: its writes
   ran entirely through eve's own `sendTeamsActivity`/`replyToTeamsActivity`/`updateTeamsActivity`/
   `callTeamsConnectorApi` (`eve/channels/teams`), which THROWS AWAY the response headers before
   returning (`{body, ok, status}`, no `headers`) — so there was no way to read a `Retry-After` even
   by wrapping eve's own return value. OPE-1237's fix moved the Connector fetch host-side
   (`teams-connector.ts`'s `teamsConnectorWrite`), reusing eve's `resolveTeamsAccessToken` for the
   token but doing the write's own `fetch` — the same move `githubWrite` made for GitHub's App-token
   writes. Discord's `discordFetch` (OPE-1236) took a lighter path: rather than a JSON funnel it
   takes `(operation, url, init)` and wraps the caller's own `fetch`, so the multipart upload, the
   no-body reaction PUT and the JSON posts each keep their exact request shape.
2. Wrap the request in `withRetryAfter` (a real `Response`) or `withRetryAfterLoose` (a
   `{ok, status, text, json}` shape with no `headers` of its own — see below), giving it the
   `surface` and the vendor `operation`.
3. Add a stubbed 429 sequence test that asserts the honoured delay against recorded sleeps, plus a
   negative control proving non-429 responses are neither retried nor slept on.
4. Add a source scan like `slack-web-api-seam-test.ts`, `github-write-seam-test.ts` or
   `linear-write-seam-test.ts` so a later call site cannot bypass the seam. Not every seam has one —
   the core SCM plane (OPE-1253) is proven by `scm-rate-limit-test.ts` directly rather than a source
   scan, because it does not sit inside a provider PACKAGE an `agent/`-tree scan can watch (core has
   no such scan at all; see the previous section). Linear's mint (OPE-1288) DOES sit inside one:
   `linear-credentials-test.ts` proves its behaviour, and `linear-write-seam-test.ts` §3 additionally
   tracks the module `covered: true`, so removing the wrap reds the scan.
   Teams carries `teams-connector-seam-test.ts` (OPE-1298), on the same model. It pins the funnel's
   wrap and its three route names, and it holds the tracked inventory of files calling eve's
   `callTeamsConnectorApi` directly — `teams-roster.ts`, `teams-directory.ts` and
   `teams-graph-team-id.ts`, all three READS. Those three are why the package is honestly "PARTLY"
   and not falsely "done" in the audit table above, and
   the scan is what keeps that honest: it reds when an UNLISTED file appears, when a listed one stops
   calling it, and — the assertion the ticket exists for — when a listed file gains a DOUBLE-QUOTED
   UPPERCASE `method: "POST"`/`"PUT"`/`"PATCH"`/`"DELETE"` literal, which would be a Connector WRITE
   bypassing the backoff. That write half is a LITERAL scan and not a proof: a method passed as a
   variable, a template literal, a spread or a lowercase string is a write it does not see. All three call
   sites spell the method inline today, which is what makes the literal form worth pinning; §0 asserts
   each miss so the gate's reach is a measured fact rather than a claim in a comment. It also reds on any file reaching eve's `sendTeamsActivity`/`replyToTeamsActivity`/
   `updateTeamsActivity`, which is the second route around the seam. It reads the CONNECTOR plane
   only: the Graph transports (`teams-read.ts`, `agent/ops.ts`) are a different
   vendor API and the scan claims nothing about them.
   🔴 **AND SINCE OPE-1408 IT ALSO WATCHES THE THIRD ROUTE — A RAW `fetch` TO A `serviceUrl`.**
   Linear's §5 and GitHub's §3 forbid a bare `fetch(` anywhere in the package. Teams cannot use that
   blanket rule, because modules there legitimately hold their own transport. §5 tracks them as an
   inventory instead, on `github-write-seam-test.ts`'s §4 model: the Connector seam itself
   (`globalThis.fetch`, host-side, so a `Retry-After` header can be read at all), plus the two
   Microsoft GRAPH transports — `teams-read.ts` (the client-credentials token mint and the Graph
   read) and `agent/ops.ts` (the ops CLI's own mint). Graph is a different vendor API with a
   different rate-limit contract and the scan claims no backoff for it. The set is asserted in BOTH
   directions and each entry's route is checked against the source, so a FOURTH transport reds — and
   that is where a Connector write issued as a raw `fetch`, the shape every Teams write had before
   OPE-1237, arrives when it is a new call site. It names neither `callTeamsConnectorApi` nor an eve
   activity writer, so §3 and §4 both miss it and only §5 sees it.
   🔴 §5 BOUNDS NEW TRANSPORTS, AND ONLY THOSE — its two limits are pinned by §0 controls rather
   than described. A module handed a `fetch` through a parameter or an import reaches the network
   without appearing here at all. And a raw Connector write added INSIDE one of the two tracked Graph
   modules changes neither the set nor that entry's route, so the gate stays green: a per-entry
   write-method scan cannot close that, because both of those modules POST to the Graph token
   endpoint and the literal would red on correct code every run.
5. Give the named failure an operation the vendor would recognise, and keep ids OUT of it.
   `RateLimitExhaustedError` states that every field on it is safe to log. GitHub passes the route
   name (`issues.createComment`). Notion has no route names, so `notionOperation` redacts the path
   into a shape — `GET /v1/comments/{id}` — rather than naming the comment. Linear passes the
   GraphQL `queryName` (`OeSetIssueState`), which names the mutation and never the issue.

Discord needed one extra decision that Slack did not: Discord states its delay in a `retry_after`
field in the JSON body as well as in the header, and the body value is authoritative (fractional
seconds), so a header-only read would miss it. `discordFetch` extends the shared primitive rather
than relying on the header: the primitive grew an optional `retryAfterMs` override, and the Discord
seam feeds it a reader that takes the body's `retry_after` over the header (`discordBodyRetryAfterMs`,
which reads a CLONE so the primitive can still cancel the original body). A body with no usable
`retry_after` falls back to the header, so both sources compose. (Discord also marks global limits
with `X-RateLimit-Global`; the honoured delay is the same either way, so the seam does not branch on
it.)

**Check for a transport seam before porting anything.** Slack's seam is a full port of eve's
primitive, because eve's `callSlackApi` exposes no `fetch` override and drops the response headers.
Linear needed no port at all: eve's `callLinearGraphQL` dispatches through `input.api.fetch`, and
every other Linear helper eve exports routes through that same function with the same `api` option.
So `linear-graphql.ts` injects a retrying fetch and delegates — eve still owns the request encoding,
the token resolution and the `LinearApiError` a non-2xx raises, so none of that could drift. Teams
is the remaining case worth checking this way: `callTeamsConnectorApi` returns `{body, ok, status}`
rather than a `Response`, which is the shape that forces a port or a shim.

## The 403 spelling — a per-seam opt-in (OPE-1256)

GitHub documents a rate-limit refusal as "403 Forbidden or 429 Too Many Requests" for both its
primary and secondary limits, often with `Retry-After` on either. `withRetryAfter` branched on 429
alone, so a 403-shaped refusal failed on the first answer.

🔴 **The primitive was NOT widened globally, and must not be.** A 403 is the ordinary spelling of a
permission denial on every other provider, and retrying one is a hot loop against an API that already
said no. Instead `RateLimitRetryOptions` grows `retryForbiddenWithRetryAfter`, off by default and
funnel-fixed (it is absent from `RetryPolicy`, so no caller can set it while tuning waits). One seam
in the repo sets it: `githubWrite` in `github-post-arm.ts`.

The discriminator is `isRateLimitedForbidden`: a 403 counts as a rate-limit refusal only when it
carries a `Retry-After` the shared parser can read. **A bare 403 stays a permission refusal on every
seam, the opted-in one included.** GitHub's PRIMARY limit marker (`x-ratelimit-remaining: 0`) is
deliberately NOT admitted — that limit resets at the top of the hour, and no bounded budget reaches
it, so treating it as retryable would spend the whole budget sleeping and then fail anyway.

🔴 **The live residual stands, and it is why this shape was buildable when a body-marker
discriminator was not.** GitHub's real 403 rate-limit response has never been measured in this repo;
the vendor half comes from documentation. Be precise about what the narrow discriminator buys:

- A **bare 403 is closed by construction** — no `Retry-After`, no retry, on any seam, whatever the
  vendor does. That is the overwhelmingly common permission denial, and it needs no measurement.
- A **`Retry-After`-bearing 403 rests on an unmeasured assumption**: that a genuine permission denial
  never carries one. An intermediary — a WAF or edge proxy answering 403 with its own `Retry-After` —
  would be retried. The cost is bounded: up to 3 extra refused POSTs and up to the total budget in
  waits, then a named failure. Not a hot loop, and not silent.
- It can also **under-fire**: if GitHub omits `Retry-After` from its 403, the flag never fires and the
  seam behaves exactly as before. The change is then inert.

A live measurement would settle both directions; do not widen this from documentation alone.

**Not covered:** GitHub's other paths do not set the flag — core's SCM write plane
(`scm/{pr,issue-actions,contents,refs}.ts`) and `github-read.ts` carry the 429 backoff only.

## Measured: the function `maxDuration` against the backoff (OPE-1289)

The worst-case cost table above assumes the work runs to completion. The deployed app runs on TWO
functions, and they carry DIFFERENT ceilings. Measured 2026-09-03 against the production deployment
`dpl_EXAMPLE000000000000000000002` (alias `my-agent.vercel.app`, commit `66a4e27`).

| Function | Routes | `maxDuration` |
| --- | --- | --- |
| **Turn function** | `/.well-known/workflow/v1/flow` only | **800 s** |
| **Ingress function** | the other 47 routes — every `eve/v1/*` webhook, the control plane, `connect/v1/*`, `.well-known/workflow/v1/webhook/[token]` | **300 s** |

**Method: three configuration reads of the live deployment through the Vercel REST API, plus one
read of eve's build-output emitter in `node_modules`.** No long-held live turn was driven. The four
sources agree, and the last one explains the split:

- `GET /v13/deployments/<id>` → `config.functionTimeout` = `300`, `config.functionType` = `fluid`,
  `plan` = `pro`, `nodeVersion` = `24.x`, `functions` = `null`.
- `GET /v9/projects/<id>` → `defaultResourceConfig.functionDefaultTimeout` = `300`, `fluid` = `true`.
- `GET /v11/deployments/<id>/builds` → the build output holds two lambdas. One serves 47 routes at
  `timeout: 300`. One serves `/.well-known/workflow/v1/flow` alone at `timeout: 800`.
- `node_modules/eve/dist/src/internal/nitro/host/vercel-build-output-config.js` writes that rule:
  it emits `maxDuration: "max"` plus a queue trigger for the flow route, and nothing for any other
  route. The platform resolves `"max"` per plan. On Pro with Fluid compute it resolves to 800 s.

So the repository still pins no `maxDuration` of its own — `deploy/oe-telemetry/vercel.json` remains
the only `maxDuration` in the tree, and it configures a DIFFERENT deployment. The 800 s comes from
eve's build output, and the 300 s is the project default.

🔴 **VERDICT: a 60 s total retry budget FITS inside the turn function, with wide headroom.** One
call's budget is 7.5 % of the 800 s ceiling. That leaves 740 s for the model call and for the rest
of the step. The exposure is not one call's budget. It is a CHAIN of calls, and the ingress
function's ceiling is lower.

Which ceiling binds a path depends on where the path runs:

- **Turn function, 800 s** — every agent tool read. `read_channel`, `read_thread`,
  `read_work_channel` and `read_work_thread` are the only production callers of `readChannelResult`
  and `readThreadResult`, so `ReadAdapter.readChannel`/`readThread` run here. `read_notion_comments`
  and the Notion `ReadAdapter` are the only production callers of `readNotionComments`, so it runs
  here too.
- **Ingress function, 300 s** — the webhook routes, and the background legs they start with
  `waitUntil`. The two shapes differ in what they block, not in which function they run on.
  `handleNotionDelivery` is awaited INLINE in the Notion `POST` route (in `notion.ts`), so it delays the ack to Notion. The Linear mention leg
  runs on the same function through `args.waitUntil` (in `linear.ts`), so it delays nothing — but
  the 300 s ceiling still cuts it.

| Path | Function | Worst case | Ceiling | Survives? |
| --- | --- | --- | --- | --- |
| one `notionFetch` | either | 60 s | 300 s / 800 s | yes |
| `github-read.ts` `readChannel` | turn | 60 s — bounded by `READ_WALK_BUDGET_MS` | 800 s | yes, ~740 s spare |
| `github-read.ts` `readThread` | turn | 60 s — the same deadline | 800 s | yes, ~740 s spare |
| Linear @mention divert leg, 4 cold calls | ingress | ~4 min | 300 s | yes, but only ~60 s spare |
| `handleNotionDelivery` | ingress | ~30 s — bounded by `NOTION_INGRESS_RETRY` (OPE-1254; it was ~15 min) | 300 s | yes, ~270 s spare |
| `readNotionComments` full sweep | turn | ~82 min | 800 s | **no — killed at 800 s** |

OPE-1299 already bounded the two GitHub read paths to one 60 s deadline for the whole walk, so the
ceiling never binds them.

🔴 **The Linear @mention divert leg is the thin one, and the margin is thinner than it looks.** Four
cold calls at 60 s each spend 240 s of a 300 s ceiling. The ceiling covers the WHOLE invocation, not
only the retry waits, so the remaining ~60 s must also absorb the route's own ack work, eve's native
handler, the routing hop, and every round trip that never retries. The native leg reaches four cold
calls too, whenever a delivery parses a team id but not its privacy (`enrichTeamPrivacy` in
`linear.ts`). Size any `LinearApi.retry` policy against 300 s and four calls, not against 60 s
and one.

Both Notion paths still die mid-sequence, and a partial multi-call sequence is a worse failure than
a fast refusal. **OPE-1254 owns that fix** — it names both Notion paths and both candidate policies,
and it asked for exactly this number before sizing them.

**What a configuration read cannot settle.** 800 s and 300 s are the configured wall ceilings.
`functionType: "fluid"` means active-CPU billing, and this measurement did not drive a long-held
live turn to check whether a Fluid function's wall clock behaves identically under load. A single
empirical run would close that.
