# The deployment contract

This page states what a host must provide for Open Everywhere to run correctly. It is prescriptive
about the **contract**, not about the **host**. Your coding agent maps these requirements onto your
infrastructure; Open Everywhere supplies the context, the tools and a deterministic self-check.

Two routes are proven end to end:

| Route | What it is |
| --- | --- |
| `vercel` | A Vercel project with Neon from the Marketplace. |
| `docker` | The shipped `Dockerfile` plus the `docker-compose.yml` sidecars, on a server you run. |

Any other host is inferred from this page plus the Docker route. Nothing beyond those two is
tested.

## The three readers of one table

The requirements are DATA, in `packages/core/agent/ops/contract.ts`. Three readers share them, and
each uses the same **requirement id**:

- [`contract.json`](./contract.json) — the machine-readable copy. It is **generated**; never edit
  it by hand. Run `npm run docs:contract`.
- This page — the prose. `npm run lint:deploy-contract` fails when the two drift apart.
- `GET /eve/v1/oe/status` — the running deployment's own answer, one verdict per requirement id.
  See [Reading the status route](#reading-the-status-route).

The ids are stable. A reader can join "the contract asks for `postgres`" to "this deployment
answers `postgres`" with no mapping table.

---

## The requirements

<a id="req-node-24"></a>

### `node-24` — Node 24

The host runs the app on Node 24.x — the range the deploying app declares in `engines.node`
(`@open-everywhere/core` itself accepts `>=24`). An older runtime fails at install, or at the first
use of a language feature the tree assumes.

The range is a **literal** in `packages/core/agent/ops/contract.ts` (`CONTRACT_NODE_RANGE`), not a
manifest read: a deployed bundle ships no package manifest to read, so a status route that resolved
it at runtime would answer "cannot tell" on every real deployment. A test fails the tree when the
literal and `engines.node` disagree.

- **Vercel:** set the project's Node.js Version to 24.x (Project → Settings → Build and Deployment).
- **Docker:** the shipped `Dockerfile` pins the base image. A hand-rolled image must match the range.

<a id="req-public-https-url"></a>

### `public-https-url` — A public HTTPS URL

The deployment answers on one stable, public HTTPS origin, **and knows that origin**. Every chat
vendor verifies a webhook URL, and every OAuth callback is built from it. Without the origin, Slack
cannot verify Event Subscriptions and no callback resolves.

- **Vercel:** the production domain. The deployment reads it from `VERCEL_PROJECT_PRODUCTION_URL`.
  Set `OE_PUBLIC_BASE_URL` for a custom domain.
- **Docker:** a TLS-terminating reverse proxy in front of the container, with `OE_PUBLIC_BASE_URL`
  set to the public origin.

<a id="req-postgres"></a>

### `postgres` — Postgres

A Postgres database the deployment can reach, named by `DATABASE_URL`. It holds the operational
store — the audit chain, the spend ledger, approvals and break-glass connector revocations — and
the durable memory backing.

`DATABASE_URL` is the **only** value needed. It selects `postgres` for both stores on its own;
`OE_OPERATIONAL_PROVIDER` and `OE_MEMORY_PROVIDER` still override it, and neither is required.

On a multi-instance host a local store is per-instance. A break-glass revocation then writes to one
instance while the others read their own empty copy, the spend ledger resets on every cold start,
and the audit trail evaporates. Core refuses to boot into that state rather than report a
success-shaped lie.

- **Vercel:** Neon from the Marketplace (Project → Storage → Neon → Connect). The integration sets
  `DATABASE_URL` on the project.
- **Docker:** any Postgres the container can reach — a managed service, or the `docker-compose.yml`
  sidecar.

See [Database graduation](./database-graduation.md) for moving off a local floor.

<a id="req-sandbox-backend"></a>

### `sandbox-backend` — A sandbox backend

The agent's shell runs in a **contained, per-session filesystem** that is not the app process's
own. The dev-only `justbash` backend shares the app process's filesystem, so a model holding `bash`
reads the deployment's own files and environment. Use it for development and nothing else.

- **Vercel:** Vercel Sandbox, selected automatically.
- **Docker:** the default off-Vercel backend. `OE_SANDBOX_BACKEND` names it explicitly.

<a id="req-egress-control"></a>

### `egress-control` — Egress control

The host enforces the compiled per-session network policy: default-deny, with credentials injected
**at the firewall** rather than handed to the sandbox.

Unenforced, the agent reaches any host, and the credential the policy would have injected at the
boundary is not withheld from the sandbox. A session that resolves a host allow-list **aborts**
rather than run unfirewalled, unless the deployment declares `egress: { allowUnenforced: true }` in
`agent/settings/settings.ts`.

- **Vercel:** the Vercel Sandbox firewall applies the fine-grained policy natively.
- **Docker:** the egress-proxy sidecar (`docker-compose.yml`). `OE_EGRESS_PROXY_URL` points the
  deployment at it, and the policy is pushed on every session. See
  [self-host egress](./platforms/self-roll.md).

<a id="req-model-route"></a>

### `model-route` — A model route

The deployment reaches the Vercel AI Gateway and authenticates to it. No turn can run otherwise:
every role in the model stack resolves through the gateway.

- **Vercel:** OIDC. A deployed project authenticates with no key to set.
- **Docker:** `AI_GATEWAY_API_KEY`, or `OE_AI_GATEWAY_URL` pointed at a compatible relay.

<a id="req-secrets"></a>

### `secrets` — The root-of-trust secrets

The host holds two **bootstrap** values in its environment:

| Name | What it is |
| --- | --- |
| `DATABASE_URL` | the Postgres connection string |
| `OE_CREDENTIAL_ENCRYPTION_KEY` | a base64-encoded 32-byte AES-256 key |

Every credential a bundle resolves through the **broker plane** then lives encrypted in the store
that key arms. Load those with `oe secret set <NAME>`, or with the ops MCP server's `secret_set`.
Without the key the store fails closed on every read and write: only `broker: "env"` credentials
resolve.

🔴 **A surface whose bundle reads its credentials from the ENVIRONMENT is the exception, and today
Slack is one.** `SLACK_BOT_TOKEN` and `SLACK_SIGNING_SECRET` are read from env on every path
(`slack-web-api.ts`, `slack-front.ts`), so they must be set as environment variables on the host.
Putting them in the credential store instead leaves the deployment silent: every inbound delivery
fails signature verification and every post throws. Follow each
[surface runbook](./surfaces/slack.md) for which of its values go where.

The machine-readable `contract.json` lists only the two bootstrap names. A surface's env names are
its own bundle's, and `packages/core` carries none of them by design — read that surface's own
runbook. No ops tool lists them: the `quickstart` plan that once did was withdrawn with the wizard
(OPE-2233), and `OPS_TOOL_NAMES` in `packages/core/agent/ops/server.ts` is the live set.

Do not hand-roll the key in a shell. The ops tool `scaffold_credential_key` mints it into
`.env.local` and never prints the value.

<a id="req-workflow-storage"></a>

### `workflow-storage` — eve's durable workflow storage

Off Vercel, eve persists every workflow run on the **local disk of the process that serves it**,
under `.eve/.workflow-data` relative to the server's working directory. A run whose store is lost
cannot resume, and an in-flight turn is stranded.

The path is **not configurable in a built server**. eve compiles the local world with
`dataDir: resolveLocalWorkflowWorldDataDirectory(process.cwd())`
(`eve/dist/src/internal/application/compiled-artifacts.js`, and the constant in
`eve/dist/src/internal/workflow/local-world-data-directory.js`), so `WORKFLOW_LOCAL_DATA_DIR` does
not move it. A second server started over the same directory recovers the first one's active runs.

- **Vercel:** Vercel Workflow holds the runs. Nothing on the filesystem is durable, and nothing
  needs to be. eve's own documentation states the split: *"In local development and in a
  self-deployed `eve start` process, eve uses the SDK's local world by default; that world persists
  workflow runs on disk under `.eve/.workflow-data`… On Vercel, the same workflow code runs against
  Vercel Workflow instead"*
  (`eve/docs/concepts/execution-model-and-durability.mdx`, re-read at eve 0.71.0).
- **Docker:** mount a durable volume at the app's working directory (or at `<workdir>/.eve`), and
  run **one** server process against it.

---

## Reading the status route

A running deployment answers `GET /eve/v1/oe/status` with one verdict per requirement id:

```json
{
  "contract": 1,
  "version": { "app": "unversioned", "core": "0.2.1", "eve": "0.71.0" },
  "host": "vercel",
  "requirements": [
    { "id": "node-24", "met": "yes", "detail": "running node 24.21.0, which satisfies 24.x" }
  ],
  "surfaces": { "slack": { "credentials": "yes", "installed": "yes", "eventsVerified": "unknown" } },
  "checkedAt": "2026-10-02T00:00:00.000Z"
}
```

The route is **unauthenticated**, because its reader is an operator's coding agent, usually before
any admin credential exists. The payload is built for that: every value is a closed-vocabulary
verdict plus a sentence this repository wrote. No secret, id, hostname, content or count reaches it.

Three verdicts, and `unknown` is load-bearing:

| Verdict | Meaning |
| --- | --- |
| `yes` | measured, and the requirement holds |
| `no` | measured, and it does not |
| `unknown` | **not measured** — never "probably not" |

Two requirements need a live call, so they arrive through probes the app registers: `postgres`
(does the store answer a read?) and `model-route` (does the gateway answer?). An unregistered probe
reads `unknown`.

`workflow-storage` reads `unknown` off Vercel on purpose. Whether the server's working directory is
a durable volume is a host fact no read from inside the process can settle, and answering `yes`
because the directory is writable would be the lie the whole surface exists to avoid.

`version.core` is always a string, a deployed bundle included. It reads a literal committed in
core (`agent/ops/package-info.ts`), so the value travels inside the compiled bundle. It used to read
`null` there, because core's version came from a manifest read and a bundled server has none —
`version.app` and `version.eve` already avoided that by coming from values the app registers at
boot with literals the bundler baked in. The deployment's commit sha is deliberately **not** in the
payload — the route is public, and a sha is an id.

The document is assembled at most once every 15 seconds **per server process**, concurrent callers
included. The route is public, so one caller must not be able to drive a database round trip and a
gateway call per request. On a serverless host the memo is per instance: a burst fans across cold
instances and each assembles its own document, so the platform's own rate limiting is what bounds
the instance count.

<a id="hiding-the-status-route"></a>

### Hiding the status route

The route has no setting that turns it off. It is public on every host the deployment answers on,
and that includes a custom domain that Vercel deployment protection leaves open (see
[Public exposure on a custom domain](surfaces/slack.md#public-exposure-on-a-custom-domain)). What it
discloses is limited, but real: the exact `core` and `eve` versions, the host label, the
`sandbox-backend` and `egress-control` verdicts, and per surface whether an install is recorded. An
exact version tells a caller which published defects apply. A Slack `installed` that reads `no` tells
a caller that `/setup` can be open.

There are two ways to hide it. Use one of them on a deployment whose host is public.

1. **Exclude the channel from the roster.** In `roster.config.ts`, give `core` an exclusion with a
   reason:

   ```ts
   core: { exclude: { "channel/oe-status": "this deployment does not publish its status" } },
   ```

   Then run `npx oe build --accept`, and commit `roster.config.ts` and the `roster.lock.json` diff.
   The build writes no `agent/channels/oe-status.ts`, and eve mounts no route for it, so the path
   answers 404. `scripts/roster-test.ts` proves the plan with core's real manifest. The cost: no
   reader gets the verdicts any more, the operator's own agent included.
2. **Block the path at the edge.** The route stays mounted, and the edge refuses it. On Vercel, add a
   custom rule in the project's Firewall: the request path starts with `/eve/v1/oe/status`, and the
   action is Deny. On Docker, refuse every path with that prefix in the reverse proxy. Match the
   prefix, not the exact path: the router also serves `/eve/v1/oe/status/`, so an exact-path rule
   leaves the trailing-slash form open. The verdicts stay readable from inside the network, or from a
   host the rule does not cover.

Neither way changes the payload itself.

### The surface fields

| Field | What it means |
| --- | --- |
| `credentials` | the surface's credentials are present. Presence only — never which, never a value. |
| `installed` | the deployment holds an install artefact for the surface. For Slack that is a bot token, which Slack issues only on an install. It is **not** evidence that the install is still live: a revoked app leaves a stale token in place. |
| `eventsVerified` | this deployment has verified a **signed** event from the surface. `yes` is proof that one was verified at some point — not proof about the *current* signing secret, since a rotation or a restored database leaves the evidence behind. Absence reads `unknown`, never `no`: see below. |

For Slack the evidence is a **stamp** that the `/eve/v1/slack` signature gate writes right after a
`v0=` HMAC verify passes (`stampSurfaceEventVerified` in
`packages/core/agent/operational/surface-evidence.ts`). The gate writes it on every accepted delivery
and before any classification, so the install-time `url_verification` handshake counts as well. The
stamp is one deployment-level row in the operational store's `instance_meta` table, so it reads the
same for every domain topology: `solo` and `unified` mode, a named window group and a DM-only
deployment. A forged or unsigned request is refused before the stamp, and writes nothing.

A delivery that the gate forwards to eve, the handshake included, waits for the write before it
answers. On the other deliveries the write rides the delivery's background work. There, a serverless
instance that is reclaimed before the write lands can lose it, and the next verified delivery on a
new instance writes it again.

The stamp is refreshed at most once an hour per server process, so its stored instant is accurate to
about an hour. The route publishes only the verdict, never the instant.

A deployment whose Slack traffic all predates the stamp still reads `yes` from a `channel_session`
row, in the two key shapes that carry the platform (`slack/…` and `oe-domain::slack/…`). Its first
verified delivery after the upgrade writes the stamp. `unknown` therefore means no verified delivery
since the upgrade, no legacy row, or a store the route could not read.

---

## Changing the contract

Edit `packages/core/agent/ops/contract.ts`, then run `npm run docs:contract`. Add a section here
with the matching `<a id="req-<id>"></a>` anchor, and a verdict for the id in
`packages/core/agent/ops/status.ts` — the status assembly throws on an id it cannot answer, so a
half-landed requirement is a red, not a silently missing line.

Bump `CONTRACT_VERSION` when a row is added, removed, or changed in what it demands.
