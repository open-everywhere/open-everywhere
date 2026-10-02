# Agent-driven setup — the MCP runbook

This runbook is written for an **agent**, not for a person. You are Claude Code (or any agent with
MCP) running in the operator's own checkout of this repository. You drive the setup; the operator
gives consent and does the few steps a vendor console reserves for a human. The path is: get a
minimal deployment up, then configure the rest from here, over MCP.

> The human-first version of the same ground is the [setup runbook](./setup-runbook.md). It explains
> *why* each control exists. This page states *what you call, in what order*. Read the setup runbook
> when a decision here needs the reasoning behind it — above all the access section, which is the
> one part of the setup nothing here can decide for the operator.

## What you are driving

The repository registers an MCP server in `.mcp.json`:

| Server | Command | What it is |
| --- | --- | --- |
| `open-everywhere-ops` | `npx tsx scripts/ops-mcp.ts` | The **outside-in** plane. It stands an instance up. |

It exposes seven tools:

| Tool | What it does | Writes anything? |
| --- | --- | --- |
| `preflight` | Reports every prerequisite, plus each configured provider's live posture. | no |
| `surface_manifest` | Returns the chat app's paste-ready manifest for a surface, with your deploy host substituted. | no |
| `scaffold_env` | Merges `KEY=VALUE` settings into the project's `.env.local`. | `.env.local` |
| `scaffold_credential_key` | Mints the credential store's AES-256-GCM key into `.env.local`. Never returns the value. | `.env.local` |
| `secret_set` | Encrypts secrets into the deployment's own credential store. | the store |
| `secret_list` | Lists stored secret **names**, who set them, and when. Never a value. | no |
| `secret_rm` | Deletes one stored secret. | the store |

A second MCP server, `open-everywhere-control` (`npm run control -w @open-everywhere/core`), manages
a **running** instance — spend, routines, audit, access. It is not part of standing one up. Use it
after step 12.

Three rules govern everything below.

- **You run the shell commands; the tools do not.** The ops server does checks and scaffolding
  only. Show the operator each install, deploy or resource-creating command, get a yes, then run it.
- **Config lives in Git. Environment variables are infrastructure only.** Connection strings and the
  bootstrap credentials that reach a store go in the environment. Everything else — the deployment's
  identity, access bundles, spend caps, trust vouches — is tracked code that changes by pull
  request. Never invent an environment variable for a list, a room key, a tenant id or a roster.
- **Never echo a secret.** No value the operator gives you goes into a message, a log, a commit or
  a tracked file. `.env.local` is gitignored; the credential store is encrypted; both are fine.

## Step 1 — Prove the toolchain

```bash
node --version   # 24.x is required
npm install
```

If `node --version` reports below 24, tell the operator to run `nvm use 24`. Do not work around it.

## Step 2 — Read the two checks

Run both, from the repository root. They share one engine but answer different questions.

1. The `preflight` MCP tool — the model key, the store providers, the durable database, the
   credential store's key, the control-plane auth, plus each provider's live posture.
2. `node packages/create/bin/create-open-everywhere.js --check` — the read-only report over the
   setup engine's nine steps, including two `preflight` cannot see: whether this checkout is linked
   to a Vercel project, and whether the roster matches the built slot tree. Add `--json` for the
   report as data. Both checks take the route: `--route docker` here, `target: "docker"` for
   `preflight`.

Every `missing` line carries a `fix`. Treat the union of both reports as your checklist. Re-run
`preflight` after each step that writes a value, and let it — not your memory — decide what is done.

## Step 3 — Take the route

**Ask the operator which route, before anything else.** Two are supported:

| Route | What it is | The one difference |
| --- | --- | --- |
| `vercel` | The `vercel` CLI plus Marketplace Neon. | The deployment authenticates the AI Gateway with OIDC, so it needs no gateway key. |
| `docker` | A self-hosted container that satisfies the [deployment contract](./contract.md). | Off Vercel there is no OIDC: the model route needs `AI_GATEWAY_API_KEY`. A different model backend is an [adapter swap](../extending/adapter-model.md) in app code, which `--check` cannot see. |

Nothing beyond these two is supported. For any other host, read the contract and follow the Docker
route; do not invent a recipe. Pass the answer to both checks from now on (`--route <r>` and
`target: "<r>"`), and walk the steps `--check` reports.

**There is no plan tool.** The `quickstart` tool that returned a second ordering of these same
steps was retired in OPE-2233: `--check` is the one answer to "what is left to do", and
[Setup steps](./setup-steps.md) is the same list written for a human, generated from the engine so
it cannot drift.

**Never offer a local run as the route.** `npm run dev` is the development loop AFTER the deploy.

## Step 4 — The model key

**Human step, briefly.** Open Everywhere runs its model stack through the Vercel AI Gateway. The
operator gets a key at Vercel → AI Gateway → API Keys, or runs `eve link` themselves. On a project
already linked to Vercel, the gateway authenticates through OIDC and there is no key to paste — see
the [quick start](../introduction/quick-start.md). `preflight` still reports the key as `missing`
there; read that line as "no key set", not as "broken".

Ask for the value, then write it and nothing else:

```
scaffold_env { "values": { "AI_GATEWAY_API_KEY": "<the key>" } }
```

Then `preflight` again. The model line reads `ok`.

## Step 5 — A local smoke check (optional, and never the finish line)

```bash
npm run dev
```

That is `eve dev` — a terminal UI on `http://127.0.0.1:3000`. It proves inference works with no
surface and no access wiring, which is worth a minute when the model key is in doubt. It is NOT
setup, and it is never where you stop: a local run has no public HTTPS URL for a chat vendor to
reach and keeps its state in a different store, so it proves little about the deployment. Carry on
to step 6 either way.

## Step 6 — The durable store

**Human step.** The operator creates a Neon Postgres project and copies its connection string. You
cannot: it needs their Neon account.

Serverless hosting makes this mandatory, and `preflight` says so unconditionally. The `git` and
`sqlite` defaults are process-local, so a hosted deployment loses memory and operational state on
every deploy and every cold start.

```
scaffold_env { "values": { "DATABASE_URL": "<the connection string>" } }
```

That one value is the whole step. A present `DATABASE_URL` selects `postgres` for the operational
store AND the memory backing (OPE-2230), so `OE_OPERATIONAL_PROVIDER` and `OE_MEMORY_PROVIDER` are
no longer part of the hosted setup. Set either one only to override the derived default.

`preflight` then adds an **append-only role posture** line. It reads `single-role` on a plain Neon
setup, which is safe but leaves the owner-DDL escape open. Hardening it is the two-role split in
[Database & operational store](../extending/database.md) — offer it, do not force it.

## Step 7 — The credential store's key

No human step. Call:

```
scaffold_credential_key {}
```

It mints a base64 32-byte AES-256-GCM key into `.env.local` and reports the byte count. **It never
returns the value**, which is the point: the deployment's master key does not pass through your
context, and it cannot be mis-encoded by a shell one-liner.

The tool refuses to mint over a key already in `.env.local` unless you pass `replace: true`. Honour
that refusal. A new key orphans every secret already in the store — those rows can never be read
again, and the operator has to re-issue each one at its vendor.

A key exported in the operator's **shell** is refused outright, `replace` included. That value is
the one the secret tools use, so a file key would be a rival that never takes effect. Push the
exported value to the deployment instead.

Both writing tools — this one and `scaffold_env` — share one target gate, so the `path` override
cannot put a secret where it must not go. The target must sit at the **project root**, and its name
must be `.env`, `.env.local` or `.env.<name>.local`: the three names this repository never tracks.
Any other name is refused, `.env.example` included. `.gitignore` ignores `.env*` and then negates
the two `.example` files back into the tree, so "it starts with `.env`" is not the same question as
"git ignores it".

## Step 8 — The deployment's identity

**Edit tracked code, not the environment.** The deployment's tenant org, its ambient workspace and
its ambient surface live in the `deploymentIdentity` object in `agent/identity/surfaces.ts`. The
`OE_ORG`, `OE_WORKSPACE`, `OE_SURFACE` and `OE_CHANNEL` environment variables are not read at all —
setting one has no effect.

Edit the file, and open a pull request for the change. The same is true of access bundles
(`agent/access/bundles.ts`), spend budgets (`agent/spend/budgets.ts`) and webhook hooks
(`agent/webhooks/hooks.ts`). This is the config-as-code property the whole security model rests on:
the git diff is the review surface.

## Step 9 — Control-plane auth

The remote control plane is an OAuth resource server. Without this it answers 401, and the operator
cannot inspect spend, audit or access from outside the box. Local stdio needs nothing.

```
scaffold_env { "values": { "OE_ADMIN_STATIC_TOKEN": "<a long random string>" } }
```

Unlike the credential store's key, this one has no mint-and-forget tool, and that is deliberate: the
admin token is a bearer credential the operator must also hold to call the control plane, so it can
never be write-only. Have them generate it (`openssl rand -hex 32`) and keep it, rather than
inventing one for them.

Offer the OIDC form instead — `OE_ADMIN_OIDC_ISSUER` plus `OE_ADMIN_OIDC_AUDIENCE`, against any
provider the operator already runs. Prefer it for anything beyond a trial: nothing is then held on
either side.

## Step 10 — Link the Vercel project

**Human step.** `npx vercel link` is interactive: it authenticates through a browser. Ask the
operator to run it themselves, in this directory. It writes `.vercel/project.json`, which is how
the `--check` report and every later `vercel` command find the project.

## Step 11 — Build, then push the environment to the deployment

```bash
npm run seed:model-catalog   # makes the build offline-safe
npm run build
```

Now the step that is easy to miss and silently fatal: **`.env.local` is gitignored and never ships.**
The hosted functions read the Vercel project's own environment. Set each value for Production, with
the operator's consent:

| Variable | Why the deployment needs it |
| --- | --- |
| `DATABASE_URL` | The Neon Marketplace integration sets it on the project. Push it only for a database you created elsewhere. |
| `OE_CREDENTIAL_ENCRYPTION_KEY` | The deployment and the operator tools must hold the same key. |

The two store selectors are **not** on that list any more (OPE-2230): `DATABASE_URL` selects
`postgres` for both stores on its own. Pushing them is harmless and redundant.

Three variables a local run uses are not needed on Vercel:

- `AI_GATEWAY_API_KEY` — a deployed project authenticates to the AI Gateway with OIDC.
- `OE_PUBLIC_BASE_URL` — the deployment reads its production host from `VERCEL_PROJECT_PRODUCTION_URL`
  (`packages/core/agent/channels/self-dispatch.ts`, `packages/core/agent/credentials/page-token.ts`). Set it only for a custom
  domain.
- `OE_INTAKE_PAGE_SIGNING_KEY` — the deployment mints it into the credential store on first use
  (`packages/core/agent/credentials/self-secrets.ts`).

Pipe each value out of the file rather than reading it into your own context. The CLI takes the
value on standard input when it is not attached to a terminal. A literal value goes the same way,
with no trailing newline:

```bash
grep '^OE_CREDENTIAL_ENCRYPTION_KEY=' .env.local | cut -d= -f2- | tr -d '
'   | vercel env add OE_CREDENTIAL_ENCRYPTION_KEY production
```

An app scaffolded by `npx @open-everywhere/create` carries `npm run -s env:pipe -- <NAME>` for the same
job. Its own setup skill (`.claude/skills/quickstart-open-everywhere/SKILL.md`, step 9 of the Vercel
route) lists the same variables in the same order; its README does not — that README is one screen
and hands setup to the agent.

If the operator's `vercel` version prompts instead, ask them to paste the value at the prompt. Do
not read the value back yourself to relay it — that puts the deployment's master key in your
context for no gain.

## Step 12 — Deploy

```bash
vercel deploy --prod
```

Confirm the scope and the team with the operator first. `git push` deploys nothing — this command is
the deploy.

## Step 13 — Prove the agent answers

A moved alias is not proof. A deployment whose function dies at cold start still reports `Ready`,
and background work goes through the database rather than HTTP. Only a request the agent itself
serves is proof.

```bash
npm run deploy:verify -- --no-rollback
```

It needs `OE_DEPLOY_SCOPE`, `OE_DEPLOY_ALIAS`, `OE_DEPLOY_CONTROL_TOKEN` and `OE_VERCEL_API_TOKEN`
— see [Rollback, verify, record](./rollback.md). The last one is **not** spelled `VERCEL_TOKEN`:
that name is the CLI's own auto-read variable, and setting it breaks `vercel deploy` itself. Where those are not set yet, fall back to fetching the
deployment URL and confirming it answers, and say plainly that this is the weaker check.

Then run the **deployed-state census**:

```bash
npm run deploy:census
```

It joins what the shipped config requires against what the running deployment actually holds —
credential rows and ingress routes. It is the only check that catches the defect class where the
code is correct and the deployment is missing a row.

## Step 14 — Mint the chat app

**Human step, and the hardest one to hand over.** Slack, Discord and Teams all reserve app creation
for a person with workspace-admin rights. You cannot do it, and you should not pretend to.

For Slack, the exact action:

1. Get the manifest. The repository ships one, with the scopes, the `/oe` command, both shortcuts
   and the event subscriptions already correct:

   ```
   surface_manifest { "surface": "slack", "baseUrl": "https://<the deployment's host>" }
   ```

   `baseUrl` is substituted into all three request URLs — Event Subscriptions, Interactivity and
   the `/oe` slash command. The response reports `placeholdersRemaining`; read it. `0` means the
   document is paste-ready. Omit `baseUrl` before the first deploy and the count tells the operator
   how many `YOUR-DEPLOY-URL` placeholders they must replace by hand. A `baseUrl` that is not a
   host — a full webhook URL, say — is refused rather than substituted, because Slack accepts the
   paste and only fails at request-URL verification.

   The app is named "Open Everywhere" unless you pass `appName` (at most 35 characters). A second
   install in one workspace needs its own name, or the two apps look the same. The manifest also
   turns the App Home Messages tab on: without it, Slack refuses every DM to the bot with
   *"Sending messages to this app has been turned off"*.

   The response also carries `steps` (the ordered clicks) and `collect` (the values to ask for).
   The rest of this step is what those two fields say.

2. Give the operator this instruction verbatim: *open https://api.slack.com/apps → Create New App →
   From an app manifest → pick the workspace → paste the manifest → Create → Install to Workspace.*
3. Ask them for two values from the created app: the **Bot User OAuth Token** (`xoxb-…`, under OAuth
   & Permissions) and the **Signing Secret** (under Basic Information → App Credentials).

Both are environment variables, not credential-store secrets — the Slack bundle reads
`SLACK_BOT_TOKEN` and `SLACK_SIGNING_SECRET` from the environment:

```
scaffold_env { "values": { "SLACK_BOT_TOKEN": "<xoxb-…>", "SLACK_SIGNING_SECRET": "<the secret>" } }
```

Then push both to the deployment with `vercel env add`, exactly as in step 11, and redeploy. Slack verifies the Event Subscriptions URL with a signed challenge, so the verification fails until a deploy that holds `SLACK_SIGNING_SECRET` is up: after that redeploy, ask the operator to choose **Retry** under Event Subscriptions.

The per-surface details, including the scopes each capability needs and the surface-specific traps,
are in the surface guides: [Slack](./surfaces/slack.md), [Teams](./surfaces/teams.md),
[Discord](./surfaces/discord.md), [Linear](./surfaces/linear.md), [Notion](./surfaces/notion.md),
[GitHub](./surfaces/github.md).

## Step 15 — Load the remaining secrets

Every secret past the root-of-trust pair belongs in the encrypted credential store, not in a file:

```
secret_set { "secrets": { "ACME_API_TOKEN": "<the token>" } }
secret_list {}
```

`secret_set` writes the same store the deployment reads, through the same code path as the
`oe secret` CLI. Point it at the same `DATABASE_URL` the deployment uses; the response names the
store it wired, so a wrong target is visible at once.

The store is **write-only, absolutely**. There is no `secret_get` and no read-back tool anywhere —
not for you, not for the operator, not for the deployed agent. `secret_list` returns names,
provenance and timestamps. Tell the operator to keep the original wherever they got it.

## Step 16 — Configure access, and prove it

This is the step that decides whether the setup is safe, and it is a decision you must not make
alone. Bundles and bindings are the admin console. Read
[the access section of the setup runbook](./setup-runbook.md#2-configure-access--the-crux) and walk
the operator through it. The short form:

- Keep the `org` baseline free of repositories and credentials. Anything bound there reaches every
  surface under it, including channels created later.
- Bind repositories and credentials at `surface` scope, by fully-qualified key.
- Keep sensitive grants in their own bundle, on their own private channel.

Then prove it, per channel:

```bash
npm run access:preview -- --platform slack --workspace T_TEAM --channel C_CHANNEL
```

A `broad grant:` warning on a channel the operator did not intend is a bug to fix before going live.
Report every one you see. Never silence one.

## Where you must stop

Five steps in this runbook belong to a human, and no MCP tool closes them. Say so early — an
operator who learns at step 14 that they need workspace-admin rights has wasted the whole session.

| Step | Why it stays human | The exact action |
| --- | --- | --- |
| The model key (4) | The key lives in the operator's Vercel account. | Vercel → AI Gateway → API Keys, or `eve link`. |
| The database (6) | Resource creation in the operator's Neon account. | Create a Neon project; copy the connection string. |
| The Vercel link (10) | `vercel link` authenticates through a browser. | `npx vercel link`, in this directory. |
| The chat app (14) | Vendors reserve app creation for a workspace admin. | api.slack.com/apps → From an app manifest → paste → Install. |
| Merging config (8, 16) | Config-as-code means an approving human on the diff. | Review and merge the pull request. |

Two more things you cannot do by construction, and should not try:

- **You cannot read a stored secret back.** There is no such verb, in any plane. If a value is lost,
  it is re-issued at the vendor.
- **The deployed agent holds no secret verb at all.** These tools work because they run on the
  operator's own machine, under the operator's own environment. That is the trust root, and it is
  why the setup path is an operator-side agent rather than a hosted one.
