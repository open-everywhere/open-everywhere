# Rollback, verify, record — the deploy safety net

A deploy is safe to automate only if the undo is as cheap as the deploy. This page covers the
three operator scripts that make that true:

| Command | What it does |
|---|---|
| `npm run deploy:verify` | Probe the deployed agent over HTTP; **roll back automatically** if it's down. |
| `npm run deploy:smoke` | Drive one real turn through the webhook ingress and assert the audit rows it writes. Reds, never rolls back on its own. |
| `npm run deploy:census` | Assert the deployment **holds the state its config requires** — every credential row, every ingress route. Reds, never rolls back. |
| `npm run rollback` | Re-point the production alias at the last known-good deployment. One command. |
| `npm run deploy:record` | Stamp the known-good pointer after a deploy has passed its probe. |

None of them run on the `test` chain — they need a live deployment and a real credential, and that
chain is secret-free by invariant. Their logic is unit-tested offline instead (`npm run test:deploy`,
`npm run test:deploy-smoke` and `npm run test:deploy-census`), with the Vercel REST API, the
credential store and every HTTP call stubbed.

## How these scripts reach Vercel

They call the **Vercel REST API** directly. They never run the `vercel` CLI.

The reason is measurable (OPE-1045). The CLI loads a *user* identity before it runs any command,
and a **team-scoped token has no user** — so `vercel ls` and `vercel inspect` fail with `Not able
to load user because of unexpected error: User not found. (404)` on any machine with no `vercel
login` session. That failure is identical whether the token reaches the CLI through `VERCEL_TOKEN`
or an explicit `--token` flag. The same team-scoped token answers `200` on every REST endpoint
these scripts use. A CI runner is exactly the token-only case, so the CLI path could never work
there.

Three endpoints carry all of it, each qualified by `teamId` when it is known and `slug` otherwise:

| Call | Used for |
|---|---|
| `GET /v13/deployments/<idOrHost>` | What the alias points at. It accepts a `dpl_…` id, a deployment hostname **or an alias hostname**, so the alias lookup is one request. |
| `GET /v6/deployments?…&target=production` | Rollback discovery, newest first. |
| `POST /v2/deployments/<id>/aliases` | The alias move — the rollback's one write. |

`vercel deploy --prod` itself is still a CLI command and is unaffected: `deploy` takes `--token`
and works with a team-scoped token.

## Why a probe, and why this one

`Ready` in the Vercel dashboard, a moved alias, and background work still ticking over are **all
true of a deployment whose function dies at cold start**. The build succeeded; the alias moved;
scheduled work goes through the database rather than HTTP. The only thing that proves the agent is
up is a request the agent itself has to serve.

So the probe is an authenticated GET against the control plane's read route:

```
GET $OE_DEPLOY_BASE_URL/control/v1/audit?since=<one hour ago, ISO-8601>
Authorization: Bearer <control read token>
```

An empty audit window is still a `200` — what is being proved is that the function **boots**, not
that anything happened. A 200 is a floor, not a ceiling: it does not prove wake, routing or session
behaviour. `npm run deploy:smoke`, below, is what proves those.

## The cron registration check

A passing probe does not prove the cron registration is current. A Vercel cron's `host` field is
an **absolute URL to the deployment that built it**, not the alias — so the alias can move, the
health probe above can pass, and every scheduled tick can still run a stale deployment's code,
because scheduled work reaches the agent through the database rather than the alias. This is not
hypothetical: the registration once froze on a stale deployment for 22 days across roughly 50
production deploys, and no other gate saw it.

So after a passing probe, `deploy:verify` reads `GET /v9/projects/<id>` (Vercel's REST API) and
checks three things against the deployment the alias resolves to:

1. `crons.deploymentId` names that deployment.
2. `crons.definitions` has the same count as the `crons` array in the local
   `.vercel/output/config.json`, when that file exists.
3. `crons.updatedAt` is not older than the deployment's own `created` timestamp.

This API's shape is **measured, not treated as a fixed contract**. A field that is missing or
renamed prints a warning and does not block the deploy; a field that is present but wrong fails
loud. The same split applies to the prerequisites: no Vercel API token, no resolvable project, or
a non-200 response all warn and skip rather than block. A rollback is never attempted for a cron
mismatch — re-pointing the alias does not change which deployment last registered the crons, so
only a fresh `vercel deploy --prod` fixes it.

The Vercel API token comes from `OE_VERCEL_API_TOKEN` when set, otherwise from the `vercel` CLI's
own stored login (`~/.local/share/com.vercel.cli/auth.json` or `~/.vercel/auth.json`). Never
printed — and if a rejected request's body echoes it, the token is redacted out of the error these
scripts raise.

**Never name this variable `VERCEL_TOKEN`.** That name is the vercel CLI's own auto-read
environment variable. The CLI loads a user identity before any call, and a team-scoped token has
no user identity — so setting `VERCEL_TOKEN` in the shell makes every `vercel` CLI invocation fail
with "User not found", even though the same token works fine for the direct REST calls this file
describes (OPE-1031). `OE_VERCEL_API_TOKEN` exists precisely so this file's REST calls and the
CLI's own auth path never read the same variable.

## The post-deploy smoke

`npm run deploy:smoke` drives one real turn end to end and asserts it **only from audit rows**:

1. A signed `POST /webhooks/<hook>` is accepted (`200`).
2. The deployment audits **that delivery** — a `webhook.fired` row carrying the `webhook-id` the
   smoke minted. The join is the delivery id, not a time window, so another sender's traffic in the
   same seconds cannot satisfy it.
3. The delivery **fired** rather than being declined.
4. A `reply.post` row carries **that fire's wake id** — this delivery produced this reply, not a
   reply that merely landed nearby. The declared fire mints the id, the `webhook.fired` row stamps
   it, and both reply routes stamp it back. When the seat forwards the fire to a worker and the
   worker posts the answer, the worker's row carries the same id: the host stamped the fire's wake
   on the forward, so no model input reaches it. One case names another job's wake: when the work
   session starts two jobs in one step, one job's worker can inherit the other job's stamp
   (`hooks/work-task-key.ts`), and its `work.task_keyed` row carries the mismatch verdict. A hook
   that fires natively (delegation disarmed, or a surface with no unified window) carries no wake id to its reply, so the gate falls back to the
   hook's target surface and renames itself to say which join it made.
5. An unsigned POST is refused (`401`) **and leaves no audit trace**. The second half is the one
   that matters: a `401` with a fire behind it would pass a status-only check.

**No model grades anything.** That is deliberate, and it is the difference between this and the
live end-to-end scenario it replaced. The old post-deploy gate ended in an LLM-judged
reply-quality assertion, and that assertion flipped between runs against an unchanged deployment.
A gate that flips without a code change cannot carry a go/no-go, so reply quality moved to a
**report**: the e2e scenario still grades it and prints the verdict, and that verdict never sets an
exit code. Read it; do not roll back on it.

A red here does **not** roll anything back automatically, unlike `deploy:verify`. This leg drives a
real turn, so it has environmental ways to be red that a bare HTTP probe does not. It exits `1` and
you run the rollback below. Exit `2` means the smoke could not run at all (misconfigured, or the
audit route was unreadable) — that is not a verdict about the deployment.

```bash
npm run deploy:smoke
npm run deploy:smoke -- --target https://my-agent-9f2h1kq0x.vercel.app   # a specific deployment
npm run deploy:smoke -- --reply-timeout-ms 300000                        # a slow cold start
```

It needs `E2E_WEBHOOK_SECRET` (the signing secret for the `e2e-smoke` hook in
`agent/webhooks/hooks.ts`) and a control read token, on top of the target URL.

## The deployed-state census

`deploy:verify` proves the deployment answers. `deploy:smoke` proves one webhook path drives a turn.
Neither proves the deployment **holds the state its own config requires** — and that state is not in
the repository, so no offline tier can see it either.

That gap is measured, not theoretical. The Notion webhook path was dead in production for the
feature's whole life because the credential store had no `db:notion:channel-key` row. Every delivery
died after a `200` ack, with no audit trace. `npm run deploy:census` closes it:

```bash
npm run deploy:census
npm run deploy:census -- --target https://my-agent-9f2h1kq0x.vercel.app
npm run deploy:census -- --json                        # machine-readable result
npm run deploy:census -- --require db:acme:some-key    # ADD a required ref (see below)
npm run deploy:census -- --no-key-check                # skip the encryption-key check
npm run deploy:census -- --no-heartbeat-check           # skip the cron-liveness check
npm run deploy:census -- --no-runtime-signal-check      # skip the roster-refresh signal check
npm run deploy:census -- --no-credential-key-armed-check  # skip the key-armed signal check
```

Before any of that, it asserts the store it opened IS the deployment's own — see "Store identity"
below. It then asserts seven more things, and states plainly what it does not prove:

1. **Every required credential row exists.** The required set is DERIVED, never declared: a bundle's
   db-brokered egress `connections[]` entry, a bundle's `connectors[]` grant, a domain's
   `credentials[]` binding, a `broker: "db"` webhook hook, and a mounted provider's own channel
   plumbing. Add a grant and the census requires another row. There is no manifest to keep in step.
2. **The AES key opens the stored rows.** Listing refs needs no key, so a presence-only census would
   stay green while `OE_CREDENTIAL_ENCRYPTION_KEY` is absent or rotated — the state in which every
   `broker: "db"` credential fails closed at once. The check opens ONE envelope and discards it; no
   plaintext, prefix or length is ever returned or printed.
3. **Every ingress route answers.** The routes come from the channels the roster mounts, read off
   eve's own route declarations — every provider ingress, plus one probe per declared webhook hook.
   An unsigned `POST` must be refused (`401`/`403`): a `404` means the route is not on this
   deployment, and a `2xx` means the ingress accepted an unauthenticated body. An UNDECLARED hook id
   is probed as a negative control and must `404`; if it answers, every id answers and the hook
   probes prove nothing.
4. **No config names a credential its connector does not configure** — a grant that reads as a live
   capability and resolves to nothing.
5. **The scheduled crons are still firing.** `directory-sync`, `tidy` and `dream-mode3` are host
   logic, not a request path a probe can hit, so this reads the AGE of the most recent audit row
   each one writes on every tick, gated against a ceiling derived from that schedule's own cron
   string (a daily cron gets ~26h, weekly ~172h). Before this check existed, a schedule that stopped
   firing looked identical to one with nothing to do — measured live for `directory-sync`, which is a
   genuine daily no-op on a deployment that never armed `OE_DIRECTORY_PROVIDER`. `routine.fire` is
   also reported (its age, when a row exists) but never gates: it only writes when a routine is
   actually due, so its total absence is legitimate on a deployment with none configured. A mounted
   channel can contribute its own heartbeats the same way: the Discord gateway REPORTS
   `discord.dispatched`'s age (the last message the always-on relay actually delivered — silent on a
   quiet guild too, so absence alone proves nothing), and — since OPE-785 — GATES on
   `discord.heartbeat`'s age (OPE-775 — the relay POSTs it on its own timer, independent of guild
   traffic, and the deployment appends the row once its relay gate accepts that POST, so it CAN
   tell a dead relay from a quiet one). The ceiling is derived from
   `OE_RELAY_HEARTBEAT_MS` (interval × 3: the beat due, plus two missed beats of slack) the same way
   the cron ceilings derive from their schedules — see the Environment table below for how to mirror
   the relay's own configured interval into the census run. Set `OE_RELAY_HEARTBEAT_MS=0` (the same
   value that disables the heartbeat at the relay itself) to keep this signal REPORTED-only instead.
6. **The deployed function's env carries `VERCEL_DEPLOYMENT_ID`.** Eve's dynamic-tool-roster refresh
   (a standing seat re-derives its tools on the first turn after a deploy) keys off this env var —
   pinned offline against the installed eve dist, but the var's presence is a Vercel platform fact
   only the running function can answer. `GET /control/v1/runtime-signal` asks it, over the same
   service-token family as the audit/usage routes, and reports presence only — never the id itself.
   This proves the SIGNAL the refresh depends on, not that any standing session has consumed it; no
   route exposes a durable session's internal tool-lifecycle context today. Needs
   `OE_DEPLOY_CONTROL_TOKEN` (or `E2E_CONTROL_READ_TOKEN`); absent, the check is skipped and named
   in the limits, never silently passed.
7. **The deployed function's own env carries a valid `OE_CREDENTIAL_ENCRYPTION_KEY`.** The AES-key
   check in point 2 tests the key **this census process** holds, not the deployment's — if the key
   is dropped from the deployment's own environment, the db credential broker never registers and
   every `broker: "db"` credential fails closed at once, behind `200` responses, with no audit
   trace, and nothing observable from outside used to say so. `GET /control/v1/runtime-signal`
   answers this too (the same call point 6 makes — one route, one token, one audit row), reporting
   `credentialBrokerArmed`: presence only, never the key itself. Needs `OE_DEPLOY_CONTROL_TOKEN`
   (or `E2E_CONTROL_READ_TOKEN`); absent, the check is skipped and named in the limits, never
   silently passed.

Exit `0` is a complete clean census. Exit `1` names the missing rows, the dead routes and the stale
crons. Exit `2` means the census could not run — that is not a verdict about the deployment.

The census reads **the deployment's own store**, so it needs `DATABASE_URL` (and
`OE_OPERATIONAL_PROVIDER` when your deployment sets one). It refuses to run against a local PGlite
or sqlite floor rather than report a clean census of a store the deployment never reads.

### Store identity

A `DATABASE_URL` that is real, reachable and simply the WRONG database is a harder failure than a
local floor store: it answers every query correctly, so no credential error ever catches it. Before
reading anything else, the census compares the newest `audit_entry` row its own store holds against
the newest row the deployment reports over `GET /control/v1/audit` (same service-token family as
points 6–7 above) for the same org, and refuses — `DeployConfigError`, exit `2` — if they diverge by
more than a few minutes. This is an EQUALITY check, not a recency one: a quiet deployment where both
sides are hours old still passes, because the check's own read call writes a fresh `control.
service_call` audit row into the deployment's store an instant before reporting it, so a matching
store has every chance to show that exact row as its own newest a moment later. `rotate-all-
windows.ts` and `rotate-window.ts` (the deploy-time mass-rotation-mark sweep and the per-run e2e
isolation tool) run the same check before they write. Needs `OE_DEPLOY_CONTROL_TOKEN` (or
`E2E_CONTROL_READ_TOKEN`) — unlike points 6–7, this check is REQUIRED, not soft-skippable: an
unverified store can report a clean census of the wrong database, so a missing token fails the
census closed rather than degrading it to a named limit.

To prove the gate still bites without breaking anything, `--require <ref>` ADDS a ref to the derived
set. Point it at a ref nobody stored and the census must go red naming it. Nothing is ever deleted
to test the gate.

**What it does not prove**, printed on every run: a refused probe shows the ingress serves and
refuses, not that a correctly signed delivery reaches a session (`deploy:smoke` proves that, for the
declared-webhook hook, when `E2E_GITHUB_WEBHOOK_SECRET` is configured the GitHub App installation
leg (OPE-774), and when `E2E_LINEAR_WEBHOOK_SECRET` is configured the Linear external-policy
ROOM-grain leg (OPE-783). Since OPE-2154 the smoke ENDS with a "what this run did not prove" block
that names every rung it skipped and why, and a skipped **launch-surface** rung (today: the GitHub
one) reds the run unless the caller waived it by name — so a green `deploy:smoke` now states its own
coverage rather than only its verdict. Teams has no deploy-time signed-delivery rung and none is possible:
Microsoft holds the Bot Framework signing key, so no deploy-time forge can ever produce a token the
deployed instance's own verifier accepts; its live e2e leg (`teams-driver.ts`) is this ingress's
deploy-time proof instead); the AES key point 2 tests is the LOCAL one — point 7's `credentialBrokerArmed` is the
observable proof of the deployment's own key, when that check runs; env-brokered secrets are not
store rows and stay invisible; `/eve/v1/discord-gateway` answering says nothing about the always-on
relay that feeds it directly — the two heartbeats in point 5 are the closest available signal, and
`discord.heartbeat`'s ceiling (since OPE-785) is only as trustworthy as the census run's own
`OE_RELAY_HEARTBEAT_MS` matching the relay's actual configured interval — an operator who changes
the relay's interval and forgets to mirror it here gets a ceiling derived from the wrong number; and
a fresh heartbeat proves the cron RAN, not that its business logic did
anything useful that run — a `directory-sync` heartbeat is green on a deployment that never armed a
provider, because that is now a named, audited outcome rather than silence (see
[identity](../how-it-works/identity.md)); a green runtime-revision signal proves
`VERCEL_DEPLOYMENT_ID` is non-empty, not that a standing session has actually re-derived its roster
under it; and a green `credentialBrokerArmed` proves the key was valid AT THE MOMENT OF THE CALL — a
key rotated or dropped a moment later is not observed until the next census.

**Bootstrap window — the heartbeat check is expected RED right after the build that introduces a
cron's heartbeat row lands.** The check gates on "a row exists newer than the schedule's own
ceiling", and a brand-new action name has no row until its cron first fires: up to ~26 hours for
the daily crons (`identity.directory.sync` at 03:00 UTC, `memory.tidy_tick` at 04:00 UTC) and up
to 7 days for `dream.mode3_tick` (Mondays 05:00 UTC). Until each has fired once, run the census
with `--no-heartbeat-check`; a red inside this window is the bootstrap, not an incident. The same
window applies to `discord.heartbeat` (OPE-785) on a Discord-mounted deployment: the relay needs one
tick of its own configured interval (~5 minutes at the default `OE_RELAY_HEARTBEAT_MS`) after a
relay redeploy before the census can see a row to gate against.

## Environment

Everything operator-specific is read from the environment — nothing about any particular
deployment is committed to this repository.

| Variable | Required by | Meaning |
|---|---|---|
| `OE_DEPLOY_SCOPE` | all three | Vercel team/scope slug, passed as `--scope`. |
| `OE_DEPLOY_ALIAS` | all three | The production alias the agent is served on, e.g. `my-agent.vercel.app`. This is the pointer rollback moves. |
| `OE_DEPLOY_PROJECT` | optional | The project's name or its `prj_…` id. Names the project for every REST call. When unset the scripts read `VERCEL_PROJECT_ID`, then the `projectId` in a local `.vercel/project.json`. |
| `OE_DEPLOY_BASE_URL` | optional | Base URL the probe hits. Defaults to `https://$OE_DEPLOY_ALIAS`. |
| `OE_DEPLOY_CONTROL_TOKEN` | `deploy:verify`, `deploy:smoke`, `deploy:census` (store-identity guard — required; runtime-signal + credential-broker-armed checks — soft), and `npm run control` (the `session_transcript` tool — soft: absent, only that one tool is unconfigured) | A control-plane **read** token — its sha256 must be listed in the deployment's `OE_CONTROL_READ_TOKENS`. `E2E_CONTROL_READ_TOKEN` is accepted as an alias, since the e2e driver pack's env file already carries that secret. Never printed by these scripts. |
| `OE_DEPLOY_STATE_FILE` | optional | Where the known-good pointer lives. Default `.open-everywhere-deploy/known-good.json`. |
| `OE_VERCEL_API_TOKEN` | all three | Vercel REST API token. Every deployment read and the alias move use it. Falls back to the `vercel` CLI's own stored login, so an operator who ran `vercel login` sets nothing. A **team-scoped** token is correct here. Never printed. Deliberately not `VERCEL_TOKEN` — that name is the CLI's own auto-read variable, and setting it breaks `vercel deploy` itself (OPE-1031). |
| `VERCEL_PROJECT_ID` / `VERCEL_ORG_ID` | optional | The pair `vercel link` prints. Read when `OE_DEPLOY_PROJECT` is unset. A CI runner's checkout has no `.vercel/project.json`, so on a runner one of these two sources is required. |
| `OE_VERCEL_API_BASE` | optional | Override the API host (default `https://api.vercel.com`). It exists so the offline test can point the scripts at a loopback server; no operator needs it. |
| `E2E_WEBHOOK_SECRET` | `deploy:smoke` | Signing secret for the smoke's hook — the same value the deployment resolves from that hook's `secretRef`. Never printed. |
| `E2E_WEBHOOK_HOOK_ID` | optional | Which hook the smoke fires. Default `e2e-smoke`. |
| `E2E_GITHUB_WEBHOOK_SECRET` (or `GITHUB_WEBHOOK_SECRET`) | **required unless waived** (`deploy:smoke`) | OPE-774 — the deployment's own GitHub App webhook secret, so the smoke can drive a signed `installation` delivery at `/eve/v1/github`. GitHub is a **launch surface**, so since OPE-2154 this rung's absence GATES: absent ⇒ the rung is SKIPPED, reported in the closing summary, and the run exits **non-zero**. To ship without it, waive that rung by name — `--allow-skip github` (or `OE_SMOKE_ALLOW_SKIP=github`) — and the waiver is printed in the summary too. Never printed. |
| `E2E_LINEAR_WEBHOOK_SECRET` (or `LINEAR_WEBHOOK_SECRET`) | optional (`deploy:smoke`) | OPE-783 — the deployment's own Linear webhook secret, so the smoke can drive a signed `AgentSessionEvent` at `/eve/v1/linear` against a SCRATCH surface (`agent/memory/config/domains/e2e-linear-signed-delivery.ts`), proving the ROOM grain of `externalPolicy` is wired to a real `linear.external_policy_suppressed` audit row. Linear is **not** a launch surface, so this rung stays opt-in: absent ⇒ the rung is SKIPPED and reported in the closing summary (OPE-2154), and it does **not** gate the exit code. Never printed. |
| `OE_SMOKE_ALLOW_SKIP` | optional (`deploy:smoke`) | OPE-2154 — comma-separated rung names whose skip is waived on purpose, the env form of `--allow-skip`. Precedence: a `--allow-skip` **with a value** wins; a valueless `--allow-skip` names nothing and defers to this variable. Only a launch-surface rung needs a waiver, and a waiver waives **only the rungs it names** — an empty opt-out waives nothing. Every waiver is printed in the run's closing summary. |
| `E2E_TARGET_URL` | optional | The deployment the smoke posts at. `--target`, then this, then `OE_DEPLOY_BASE_URL`, then `https://$OE_DEPLOY_ALIAS`. `npm run control` reads the same three, in the same order, to point `session_transcript` at a deployment. |
| `OE_RELAY_HEARTBEAT_MS` | optional (`deploy:census`, Discord only) | OPE-785 — the census run's own mirror of the SAME env var name the always-on Discord relay (`deploy/discord-relay/index.js`) reads for its heartbeat interval. Unset defaults to the relay's own documented default (300000ms = 5min). `0` matches the relay's own "disabled" meaning: `discord.heartbeat` stays REPORTED instead of gating. Mirror the relay's actual configured value here, or the derived ceiling is wrong. |

Mint a read token with `npm run mint:control-token -w @open-everywhere/core -- <name>` and put the
printed `name:<sha256>` entry in the deployment's `OE_CONTROL_READ_TOKENS`. See
[Control plane](../security/control-plane.md).

Every variable marked **required by** fails **loud, by name** when it is missing — the error
message is the whole onboarding path. An unresolvable Vercel token or project stops the run with
exit code 2 before the probe, because a verify that cannot read the alias cannot roll back, and a
verify that cannot roll back is not a safety net. The one soft input is
`.vercel/output/config.json`: when the local build output is absent the cron **count** check warns
and skips rather than blocking the deploy — see
[The cron registration check](#the-cron-registration-check) above.

`npm run deploy:record -- --url <deployment-url>` is the exception that needs no Vercel
credential at all: an explicit url is recorded without any lookup. That is the documented remedy
when the API is unreachable.

## An unresolvable alias is FATAL

`deploy:verify` treats "the probe passed but I cannot say which deployment the alias resolves to"
as a hard failure, never a warning. Four checks read that value, and each of them fails soft on its
own: the cron `deploymentId` check, the cron staleness check, the `--record` pointer write, and the
rollback no-op guard. An unresolved target used to disarm all four in silence.

> 🔴 **This was a real, silent failure** (OPE-1028). The `vercel` CLI could not be spawned,
> `execFile` returned `ENOENT`, and the result was flattened to "empty output" — which every one of
> those checks read as "no data, skip me". `deploy:verify -- --record` printed one `✗` line and
> **exited 0**, so a deploy verified green while the known-good pointer still named the deploy before it. The
> lookup is a REST call now, and a non-200 raises an error naming the endpoint and Vercel's own
> reason. The exit code is still the only thing the chain gates on.

## Exit codes

The deploy chain gates on `$?`, so **every failure exits non-zero**. In particular:

| Situation | `deploy:verify` exit |
|---|---|
| probe passed, all checks passed | `0` |
| probe passed, but the alias could not be resolved to a deployment | `1` |
| probe passed, but `--record` recorded nothing | `1` |
| cron registration check failed | `1` |
| probe failed, rolled back | `1` |
| probe failed and the rollback also failed | `2` |
| configuration error (missing variable, unresolvable CLI) | `2` |

An unresolved alias is **fatal rather than a warning**. A passing probe proves only that the agent
answers; it says nothing about *which* deployment the alias points at, and every check listed in
the callout above needs exactly that. Read the log for detail, but gate on the exit code.

`deploy:verify -- --record` also accepts `--url <deployment-url>` and `--id dpl_…`, with the same
meaning they have on `deploy:record`: record the deployment you name rather than the one `vercel
inspect` reports.

## The known-good pointer

`.open-everywhere-deploy/known-good.json` is **per-operator local state and is gitignored**. It
records the deployment that last passed a probe, plus a bounded history (10) of the ones before
it:

```jsonc
{
  "version": 1,
  "lastGood": {
    "url": "https://my-agent-9f2h1kq0x.vercel.app",
    "id": "dpl_…",
    "commit": "d67ab39",
    "recordedAt": "2026-08-08T12:00:00.000Z",
    "note": "OPE-376"
  },
  "history": [ /* previous lastGood entries, newest first */ ]
}
```

It holds deployment URLs and commit shas — no secrets — but it is one person's record of their own
deploys, not a shared fact about the project. A missing or corrupt file never blocks a rollback;
the scripts fall back to discovery.

## Where rollback points

In priority order:

1. **`--to <deployment-url>`** — you named a deployment; it always wins.
2. **The pointer's `lastGood`**, when the alias isn't already on it. The normal case: the fresh
   deploy broke, the pointer still names the one that last worked.
3. **One hop further back** (`history[0]`), when the alias *is* already on `lastGood` — i.e. the
   broken deployment got recorded, or you're rolling back a second time.
4. **Discovery** — the newest `READY` production deployment in the project listing that isn't the
   current alias target. The no-pointer path.

A rollback that would change nothing **fails** rather than reporting a green no-op.

## The chain

```bash
npm run build                        # eve build — must be green
npm run lint:hosted-externals        # cold-start check: source pass, then the built output
vercel deploy --prod --scope "$OE_DEPLOY_SCOPE"
vercel alias set <new-deployment-url> "$OE_DEPLOY_ALIAS" --scope "$OE_DEPLOY_SCOPE"
npm run deploy:verify -- --record    # probe; on 200 stamp the pointer, on failure roll back
npm run deploy:smoke                 # one real turn, asserted on audit rows; red ⇒ run the rollback
npm run deploy:census                # every required credential row + every ingress route
```

`deploy:verify` runs first because it is fast and it undoes a deployment that will not answer at
all. `deploy:smoke` runs second because it costs a real turn and only makes sense against a
deployment that answers. `deploy:census` runs last because it costs no turn and its reds are
operator actions (store a row, redeploy), never a rollback.

`vercel deploy --prod` does **not** move a custom-domain alias — that is the separate `alias set`
step above, and it is also the whole of what a rollback does.

### The chain has no command-registration rung, and does not need one

A surface's slash commands live on the **vendor's** side, so a build that adds a subcommand changes
nothing a user can see until somebody writes that command set to the vendor. That used to be an
operator step nobody could take — the bot token lives with the deployment, not with the operator —
so a declared command could ship invisible.

The deployment now registers its own. Every process start reconciles the command set the code
declares against what the vendor holds, and writes only on a difference
([Discord](./surfaces/discord.md#register-oe--the-deployment-does-it-itself) is the one surface wired
today). **`deploy:verify` is what makes that land at deploy time**: its probe is an HTTP request the
new deployment has to serve, so it forces the cold start the reconcile rides. No extra rung, no
control token, and nothing in `scripts/deploy/` knows about commands at all.

What that means for reading a deploy:

- the reconcile is **fail-soft and never rolls anything back**. A vendor outage leaves the command
  list exactly as stale as it already was, which is not a reason to undo a healthy deployment;
- it reports itself in the deployment's own **boot log**, one line per platform
  (`[open-everywhere:command-registration] discord: unchanged — …`), not in any script's exit code;
- a deployment that declares no room registers nothing and makes no vendor call.

### Options

```bash
npm run deploy:verify -- --no-rollback         # probe only, never touch the alias
npm run deploy:verify -- --attempts 5 --delay-ms 8000
npm run rollback                               # to the last known-good
npm run rollback -- --to https://my-agent-1d0e5ff9y.vercel.app
npm run rollback -- --dry-run                  # print the plan, touch nothing
npm run deploy:record -- --url <url> --note "OPE-376"
npm run deploy:smoke -- --fired-timeout-ms 90000 --unsigned-grace-ms 30000
npm run deploy:census -- --org acme --timeout-ms 30000
```

### What auto-rollback deliberately will **not** do

Its worst failure mode is a false red rolling back a *healthy* deploy, so the probe retries (a
cold start is slow), and two answers never trigger a rollback because both prove the deployment
**answered**:

- **401** — the probe token is wrong. Check `OE_DEPLOY_CONTROL_TOKEN` against the deployment's
  `OE_CONTROL_READ_TOKENS`.
- **404** — the control read route is fail-closed off (`OE_CONTROL_READ_TOKENS` unset on the
  deployment) or genuinely missing. Ambiguous, so it stops and says so.

The cron registration check, after a passing probe, follows the same principle from the other
direction: it never rolls back on its own, because a rollback cannot fix a stale cron registration
(only a fresh deploy re-registers). A real mismatch there still fails the run — exit `1` — but
leaves the alias exactly where it is.

Exit codes: `0` healthy · `1` unhealthy (rolled back, `--no-rollback`, or the cron registration
check found a real mismatch) · `2` misconfigured, or the rollback itself failed.

`deploy:smoke` uses the same three codes for the same reasons, and never rolls back on its own:
`0` every gate passed · `1` the deployment failed a gate — run the rollback · `2` the smoke could
not run.

## Related build-time gates

Rollback is the last resort. These catch the same class **before** a deploy exists:

- `npm run test:boot` — boots the whole agent graph and fails on any module-load throw, duplicate
  channel route, or malformed schedule cron. In `npm test`.
- `npm run lint:traced-externals` — an import that eve force-externalises but nothing traces into
  the bundle: a dead lambda at cold start. In `npm test`.
- `npm run lint:hosted-externals` — two passes. The source pass reads hand-written runtime source
  for a dynamic import whose specifier is computed at runtime, which no bundler can inline;
  `npm run test:hosted-externals-lint` proves it, and that suite IS in `npm test`. The output pass
  asserts the same invariant over real build output, needs a build, and is the deploy-checklist step.
- `npm run lint:eve-patch` — the committed dependency patches are really in the installed bytes,
  and every workspace pins the patched version. In `npm test`.
- `npm run lint:env-docs` — a new env var the runtime reads that no operator could know to set.
  In `npm test`.
