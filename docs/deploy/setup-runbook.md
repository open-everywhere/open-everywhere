# Setup runbook — stand up a real workspace

The full operational runbook beyond the [quick start](../introduction/quick-start.md):
deploy Open Everywhere against a real workspace, wire real connectors, and configure
who-can-reach-what safely before you go live. It reads top to bottom so a person *or an
agent* can follow it. An agent driving the setup over MCP should start from
[Agent-driven setup](./agent-driven-setup.md) instead — same path, stated as the tool calls — and
come back here for the reasoning, above all the access section below.

> **Read this first — what's enforced vs advisory today.** Getting this wrong is how
> access leaks.
> - The **egress firewall** is the hard network control: default-deny on outbound hosts
>   plus [credential injection at the boundary](../security/credentials-and-planes.md)
>   (the secret never enters the sandbox). It is **enforced by default** on the Vercel
>   Sandbox backend, and on the self-host `docker()` deployment via the shipped
>   [egress-proxy sidecar](./platforms/self-host-egress.md). Eve's `microsandbox` backend
>   enforces the host-grain part only (per-host allow/deny) — not credential injection, and
>   not a selectable Open Everywhere backend today (measured, OPE-917). A backend that can't
>   apply fine-grained rules **aborts the session** (fail closed — `egress.allowUnenforced:
>   true` knowingly runs it unenforced, dev only). Set `egress.enforce: false` to opt out to
>   dry-run while your bundles don't yet cover every host the agent needs.
> - **Repo grants** in a bundle are **advisory today** — they are summarised into the
>   model's prompt ("you may use these repos"), not hard-enforced per repo. The real
>   network control is host-level egress to `github.com` plus your **GitHub token's own
>   scope** and **branch protection**. Treat the repo list as intent; treat token scope
>   and branch protection as enforcement.
> - **Egress credential types are static-only**: `bearer`, `basic`, and `github-app` (a
>   pre-provisioned installation token). They stamp a header at the firewall. OAuth and
>   token-exchange auth live in the [connector plane](../capabilities/connectors-and-providers.md),
>   not here.

## The access model in six lines

- A **bundle** is a named set of connections (credentials), connectors, providers, repos,
  domains, plugins, and instructions. Bindings attach a bundle to a **scope**:
  `org` → `tenant` → `domain` → `surface`. `tenant` and `surface` are written as
  platform-qualified keys (`slack/T_TEAM`, `slack/T_TEAM/C_CHANNEL`); `domain` is the
  domain's bare name.
- A surface resolves the **union** of every bundle in its chain. Narrower scopes **add**;
  they never subtract.
- Repos / domains / plugins / instructions are an **additive union**. **Credentials are
  narrowest-wins**, no fallback (surface beats tenant beats org for the same id).
- **Default-deny**: a host not listed is unreachable; a new channel with no surface bundle
  gets only the baseline.
- **DMs are a separate universe**: a DM resolves the *caller's* personal scope
  (`{ level: "principal", principal: "<principalId>" }` bindings) only — never the
  org/tenant/domain/surface service bundles.
- **Membership is the ACL**: anyone who can post in a channel gets that channel's full
  resolved access. There is no per-user gate below the channel.

Full narrative in [Access & scoping](../how-it-works/access-and-scoping.md).

## Steps

### 0. Prerequisites

- Node 24.x, then `npm install`.
- A **Vercel AI Gateway** key (dashboard → AI Gateway → API Keys), or run `eve link`.
- `cp .env.example .env.local` and fill it in as you go. Every config field and env var
  is catalogued in the [configuration reference](./configuration-reference.md).

### 1. Model + run locally

Set `AI_GATEWAY_API_KEY`, then `npm run dev` (= `eve dev`) for the TUI on
`http://127.0.0.1:3000`. This proves the model loop with no surface or access wiring
needed — the fastest sanity check that inference works.

### 2. Configure access — the crux

Your bundle and binding definitions **are** the admin console: config-as-code, versioned,
reviewed by PR. The whole "who can reach what" outcome is decided there. Follow these rules
— they are the difference between a tight setup and the classic all-repos-everywhere
misconfig:

1. **Keep the `org` baseline empty of repos and credentials.** Anything bound at `org` or a
   `tenant` scope reaches **every** surface under it — including channels created later
   and public ones anyone can join. The baseline is the de-facto wildcard. Put only
   org-wide standing instructions and genuinely-safe credential-less `domains` there.
2. **Bind repos and credentials at the channel's domain scope.** Every channel/page claimed by a
   domain receives that domain's static capability set, whether its sessions are unified or
   separate. A direct `surface` binding is allowed only for a standalone channel that belongs to
   no domain. `npm run lint:access` resolves domain precedence and tells you the domain binding to
   write when a surface is already a member.
3. **Keep sensitive grants in their own bundle on their own channel.** Infra / IAM /
   security repos and any write / prod / money credential must not ride in the same bundle
   as general product code, and must not be bound anywhere broad. One narrow bundle, one
   private, tightly-membered channel.
4. **Reuse a bundle across domains or standalone channels.** Make that shared bundle as narrow as
   the use case allows; never split one domain by binding only one of its member surfaces.
5. **Secrets are never inlined** — a connection names a `secretRef` (an env var name or
   broker key); the value is resolved at runtime via the [credential broker](../extending/credential-brokers.md).

After every change, preview the resolved access and heed the warnings:

```bash
npm run access:preview -- --platform slack --workspace T_TEAM --channel C_CHANNEL
```

The resolver emits a **`broad grant:` warning** whenever repos or credentials are bound at
`org` / `tenant` scope — that line is your "you just made it reachable everywhere"
alarm. The same warnings print to the server log (`[open-everywhere:access] warning: …`)
at runtime. Treat any `broad grant:` on a channel you didn't intend as a bug to fix before
shipping.

### 3. Secrets

**The credential store is the default home for a secret; an environment variable is the
on-ramp.** For each connection's `secretRef`, put the value where that credential's
[broker](../extending/credential-brokers.md) reads it — `broker: "db"` for the encrypted
store (recommended), `broker: "env"` for an environment variable. Only `bearer` / `basic` /
`github-app` egress connection types resolve today.

#### `oe secret` — the operator door (day 0, no surface required)

`oe secret` runs **on your machine** and writes the deployment's own encrypted store
directly. Its trust root is the environment you already hold to operate the deployment —
`DATABASE_URL` + `OE_CREDENTIAL_ENCRYPTION_KEY` — so it works
**before the agent has ever booted and before any chat surface exists**. There is no admin
token to mint first and no endpoint to expose.

```bash
# one secret — the value is read from STDIN, never from argv
printf %s "$THE_TOKEN" | npx oe secret set ACME_API_TOKEN

# a multi-line value (a PEM) — bytes preserved
npx oe secret set OE_GITHUB_APP_PRIVATE_KEY --value-file ./app.pem

# the 30-secret case: an existing .env-shaped file, KEY=VALUE per line
npx oe secret set --from-file ./secrets.env

npx oe secret list      # names + who set them + when. NEVER values.
npx oe secret rm ACME_API_TOKEN
```

`oe secret` reads `DATABASE_URL` / `OE_CREDENTIAL_ENCRYPTION_KEY` from
`./.env.local` when they aren't exported (`--root-env PATH` to point elsewhere — the flag is
not called `--env-file` because Node 24 parses that one out of the argv itself) — and lifts
**only** those root-of-trust names out of the file, never the rest of it. Point it at the
same `DATABASE_URL` your deployment uses: it writes the store the deployment reads, and
prints which store it wired so a wrong target is visible immediately.

**An agent can do this for you.** The repo's ops MCP server (`open-everywhere-ops`) exposes
the same three functions as `secret_set` / `secret_list` / `secret_rm`, so an operator-side
agent with your environment can provision a deployment conversationally. Same trust root,
same code path, same limits.

Three properties worth knowing before you build a habit on it:

- **Write-only, absolutely.** There is no `oe secret get`, no read-back tool, and no
  control-plane verb. A confirmation prints a **byte count** — never the value, never a
  prefix of it. If you lose a secret, you re-issue it at the vendor.
- **The deployed agent never holds a secret verb.** These are operator-side functions, not
  tools; the agent cannot provision its own credentials by construction.
- **Deleting a secret is not always a retirement.** `oe secret rm` (and the ops server's
  `secret_rm`) DELETE the ciphertext row. The name then fails closed — **unless** the
  process that RESOLVES it holds an environment variable of the same name, which
  resolution falls back to by design. So a delete can silently revert the name to an older
  value. Both doors report `envFallbackPresent` for the name they removed, as presence
  only, never the value. 🔴 **That read answers for the operator process you are running,
  not for the deployment.** Your laptop and a Vercel or Railway host hold different
  variables, so a `false` here does not mean the deployed agent fails closed. When the
  deployment runs elsewhere, delete the variable on that host too.
- **These writes are not on the audit hash chain — on purpose.** The chain is partitioned
  by org, and an operator CLI never loads the deployment's config, so it cannot learn the
  org by itself (see [Audit & provenance](../security/audit-and-provenance.md)). A row in
  the wrong tenant's chain is worse than no row, so provenance rides the row instead: `oe
  secret list` shows `operator:cli` / `operator:ops-mcp` (plus any `--as <label>`) and the
  write time. Keys pasted through the chat intake still audit `credential.stored`, because
  that path runs inside the agent, which knows its own org.

**Fail-closed:** with `OE_CREDENTIAL_ENCRYPTION_KEY` unset or malformed, every one of these
refuses rather than storing plaintext — and at resolution time a secret that IS stored but
cannot be decrypted **never** falls back to an environment variable of the same name (that
variable may be the value you just rotated away from).

**Backups:** the store rides your database's backups (Neon PITR on the default hosted path);
an environment variable survives a database wipe and the store does not. Whichever home you
choose, keep the original where you got it — neither home lets you read a value back.

### 4. Egress enforcement (on by default)

Egress is **enforced by default**. While your bundles don't yet cover every host the agent
legitimately needs, set `egress.enforce: false` to opt out to dry-run (the firewall compiles and
logs but blocks nothing). It fully *enforces* on the Vercel Sandbox backend, and on the
self-host `docker()` deployment via the egress-proxy sidecar. Eve's `microsandbox` backend
enforces host-grain allow/deny only, not credential injection (measured, OPE-917); plain
Docker without the sidecar is coarse allow/deny, and just-bash rejects the policy entirely —
on a backend that rejects the policy the session **aborts** rather than running unenforced
(`egress.allowUnenforced: true` is the knowing dev opt-out).

### 5. Surfaces

Add each chat surface and bind its credentials. The per-surface install guides cover app
registration, scopes, webhooks, and the surface-specific gotchas:
[Slack](./surfaces/slack.md), [Teams](./surfaces/teams.md),
[Discord](./surfaces/discord.md),
[Linear](./surfaces/linear.md). Each adapter binds **real identity** (workspace / surface /
mode / visibility / user) into the session context, so memory, access, and routines key off
the real surface rather than the `OE_*` local stand-ins.

### 6. GitHub

- **Source control**: register the GitHub App (`OE_GITHUB_APP_*`) so the agent clones
  granted repos and opens PRs under its own bot identity with short-lived,
  repo-scoped installation tokens. See [Source control](../capabilities/source-control.md).
- **Simple path**: a PAT in `GITHUB_TOKEN` powers the `open_pull_request` tool (the
  approved push + PR call). The PAT's own scope is a real enforcement boundary — scope it
  to only what's needed.
- **Branch protection is your backstop**: whatever the token can push, what *lands* is
  governed by your repo's protection rules. Require PR + review on sensitive repos so the
  write capability stays a proposal, not a merge.
- **Event routines**: point a repo / App webhook at `POST /eve/v1/github` and set
  `GITHUB_WEBHOOK_SECRET` so deliveries are HMAC-verified. The secret is **required**:
  unset means every delivery is rejected 401 (fail closed — this ingress fires routines
  into Slack channels). The `webhooks.allowUnverifiedGithub` setting accepts unverified
  deliveries for local dev only.

### 7. Webhook triggers

Declare a hook in `agent/webhooks/hooks.ts` (empty by default): a hook id, a `source` naming
which signature scheme its sender signs with, a `secretRef` naming *where* its shared secret
lives plus the `broker` that ref resolves through (`"env"` for an env var name, `"db"` for
the encrypted credential vault), who may read its events, and — optionally, and only together —
the `slack/TEAM/CHANNEL` surface it fires into plus the instruction the agent runs. Omit that
pair and the hook is emit-only: `event` routines decide what its deliveries cause. Point the
external provider at `POST /webhooks/<id>`.

Under `broker: "db"` nothing needs redeploying to make it live: ask the agent to rotate the hook
once the declaration is merged and it mints the secret and hands it over on a one-time link.

For a sender you control, use `source: "oe-standard-webhook"` — the public
[standard-webhooks](https://www.standardwebhooks.com/) spec, so most languages have a drop-in
sender library. Send `webhook-id: <unique per delivery>`, `webhook-timestamp: <unix seconds>`
and `webhook-signature: v1,<base64 HMAC-SHA256 over "<id>.<ts>.<rawBody>">` (300s skew
window). **The key is not always the secret's characters:** a `whsec_<base64>` secret's key is
the base64-**decoded** remainder, anything else is signed with its own UTF-8 bytes. In shell:

```sh
KEY=$(printf '%s' "${SECRET#whsec_}" | base64 -d | od -An -tx1 | tr -d ' \n')
SIG=$(printf '%s.%s.%s' "$ID" "$TS" "$BODY" | openssl dgst -sha256 -mac HMAC -macopt hexkey:"$KEY" -binary | base64)
curl -X POST "$URL" -H "webhook-id: $ID" -H "webhook-timestamp: $TS" \
     -H "webhook-signature: v1,$SIG" -H 'content-type: application/json' -d "$BODY"
```

For a **third-party
vendor**, name the vendor instead (`source: "github"`, `"notion"`, …) — the delivery is then
verified in that vendor's own scheme, so the vendor needs no adapter and signs exactly as it
always does. A source with no registered verifier fails closed 401.

**Declaring the hook is only half the job.** The declaration is code; the secret value never
is. Until someone provisions the value in that hook's broker, the hook is inert — every
delivery to it is rejected 401 (fail closed), and an id with no declaration at all 404s. So
deploying the merge and arming the ingress are two separate acts, by two people who need
different access; budget for both. The `webhooks.allowUnverified` setting accepts unverified
deliveries for local dev only — it collapses that second key, so never turn it on for a
deployment. Note also that replay defence on this ingress is a property of the **scheme**,
not of the ingress: an `oe-standard-webhook` delivery is single-use (stale past 300s, and
refused 409 if the same `webhook-id` is presented twice inside that window), while a `github` or
`notion` delivery — neither vendor signs a timestamp — replays **indefinitely**, and a fire
runs with the target channel's full grants. See
[Inbound webhook triggers](../capabilities/proactivity-and-routines.md#inbound-webhook-triggers).

### 8. Spend caps

Set per-surface / per-workspace monthly token caps (uncapped by default). Over-budget
scopes are **declined**, not truncated — DMs included (an org admin's own DM turn still gets through, visibly and audited). View with `npm run spend -w @open-everywhere/core` — `spend`, like `audit`,
`routines` and `control`, is a core-workspace script and does not resolve from the repository root.
See [Spend & cost controls](../security/spend-and-cost.md).

### 9. Operational store and memory backend

The operational stores (spend, routines, audit) and durable memory each sit behind a
provider seam. **`DATABASE_URL` selects both**: set it and each resolves to `postgres` (OPE-2230).
Neither selector below is required on a hosted deploy; each one overrides the derived default.

- `OE_OPERATIONAL_PROVIDER` — unset with **no** `DATABASE_URL` resolves to the **embedded Postgres
  (PGlite)** floor (zero-wiring, same dialect as prod); unset **with** a `DATABASE_URL` resolves to
  hosted `postgres`. Name `postgres` to pin it, or `sqlite` for the deprecated legacy floor — which
  boot nags about, and which is now reachable only by naming it.
- `OE_MEMORY_PROVIDER` — unset with no `DATABASE_URL` is `git` (single-operator dev); unset with a
  `DATABASE_URL` is `postgres`. Name `sqlite` for real `DELETE` erasure + `org_id` partitioning, or
  `postgres` to pin the hosted backing.

For Postgres, register the client once at startup and initialise the schema (tables + RLS
policies are idempotent). **Tenant isolation** is the `org_id` column on every query, which
is always correct. **GUC-keyed defense-in-depth RLS** (on the mutable tables) only enforces
under a role that is *neither a superuser nor the table owner* AND sets the per-session GUC —
on the default single-role Neon deploy the app connects as the owner and nothing sets the GUC,
so that backstop is inert until you adopt the two-role split (see
[Database & operational store](../extending/database.md)). The **append-only evidence
tables are the exception that enforces today**: `audit_entry` / `usage_events` /
`domain_skill_revisions` / `routine_prompt_revisions` use
`SELECT`+`INSERT`-only policies under `FORCE ROW LEVEL SECURITY`, so `UPDATE`/`DELETE` are
denied even to the owner (only a superuser / `BYPASSRLS` role could mutate them — the default
Neon role is neither). The tenant for a single-tenant deployment is `deploymentIdentity.org` in
`agent/identity/surfaces.ts` — tracked config, not an env var; `oe secret` runs before any boot, so
it takes `--org` when the declaration is not `default`. Backing details:
[Memory backings](../extending/memory-backings.md) and
[Database & operational store](../extending/database.md).

### 10. Verify before going live

- Run `npm run access:preview` for every channel that matters — confirm the resolved
  repos, credentials, reachable hosts, and instruction stack are what you intend, and that
  there are **no unintended `broad grant:` warnings**.
- Run a real task in a pilot channel; confirm the action shows up under the expected
  identity, and that a non-granted host is refused once enforcement is on.
- Run `npm run audit --workspace @open-everywhere/core -- --org <org>` — the `--` is required, or
  npm claims `--org` as its own config and the read silently runs as the `default` org. Confirm
  memory writes, egress and connector grants, and
  consequential tool actions (`pr.open`, `routine.create` / `routine.cancel`) land in the
  [append-only audit log](../security/audit-and-provenance.md) with the expected
  principal and scope. Filter with `--action pr.open`.
- If you armed a routine, confirm its first fire lands too: `--action routine.fire` (it
  ran, and names the session), `--action routine.skip` (it didn't, with a reason), or
  `--action routine.fire_lost` (dispatched but the delivery was rejected). See
  ["Did my 03:00 routine actually run?"](../capabilities/proactivity-and-routines.md#did-my-0300-routine-actually-run).

## Safety checklist (the anti-footgun list)

- [ ] `org` and `tenant` scopes carry **no** repos and **no** credentials — only safe
      domains and standing instructions.
- [ ] Every repo / credential grant is at a **surface** (or `domain`) scope, by its
      fully-qualified key (or bare domain name).
- [ ] Infra / IAM / security repos and write / prod / money credentials live in their
      **own** bundle on a **private, tightly-membered** channel.
- [ ] `npm run access:preview` shows **no unintended `broad grant:`** warnings.
- [ ] Channel **membership** for any elevated channel is treated as an access grant
      (adding someone = granting them that access).
- [ ] Egress enforcement is left **on** (the default) in any real deployment, on the Vercel
      Sandbox backend or the self-host `docker()` + egress-proxy sidecar
      (`egress.enforce: false` is not set).
- [ ] No secret is inlined in config; every connection uses a `secretRef`.
- [ ] GitHub token scope is minimal; sensitive repos have branch protection requiring review.
