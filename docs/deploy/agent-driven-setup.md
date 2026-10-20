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

It exposes ten tools:

| Tool | What it does | Writes anything? |
| --- | --- | --- |
| `preflight` | Reports every prerequisite, plus each configured provider's live posture. | no |
| `surface_manifest` | Returns the chat app's paste-ready manifest for a surface, with your deploy host substituted. | no |
| `surface_app_package` | Builds the upload-ready Teams app zip for the admin-centre (`org`) or store route, checks it, and writes it into the project. See [Listing the Teams app](./surfaces/teams.md#listing-in-the-teams-admin-centre). | the zip, inside the project |
| `surface_app_create` | Creates a surface's app in one click from a generated manifest (GitHub): it opens a local page, the person confirms the app on the vendor's site, and the vendor's keys go straight into `.env.local`. Never returns a value. See [step 14](#step-14--mint-the-chat-app). | `.env.local` |
| `scaffold_env` | Writes non-secret config into the project's `.env.local`. For a secret, it takes the **name** and returns the command the operator runs. | `.env.local` |
| `scaffold_credential_key` | Mints the credential store's AES-256-GCM key into `.env.local`. Never returns the value. | `.env.local` |
| `secret_set` | Encrypts secrets, **by name**, from `.env.local` into the deployment's own credential store. | the store |
| `secret_list` | Lists stored secret **names**, who set them, and when. Never a value. | no |
| `secret_rm` | Deletes one stored secret. | the store |
| `sovereignty` | For each piece of the deployment's data, where it lives, which region and which company could be compelled to hand it over, from the app's own config. The same map as `npx oe sovereignty` ([Sovereignty](../security/sovereignty.md)). | no |

**A server started before an upgrade refuses every call.** The server holds the core it loaded at
start. After an `npm install` moves the app to a new `@open-everywhere/core`, each call compares the
two versions, and on a mismatch it answers `the app now runs @open-everywhere/core X; this ops
server runs Y` instead of serving the old code (an old Slack manifest, an old tool set). That
includes a call the old tool's schema rejects and a call to a tool the old server lacks. Restart
the server — in Claude Code, `/mcp`, then reconnect `open-everywhere-ops` — and call again. Two
cases are not judged: a project with no installed core to read, and a reinstall that keeps the same
version number. A server whose core predates this check cannot refuse at all: after an upgrade, an
input-validation error that names `values` or `secrets`, a `scaffold_env` reply with no `secrets`
list for the `secretNames` you sent, or a "Tool … not found", means the same thing — restart the server. Never fall back to passing a value.

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
- **Never hold a secret.** No secret value passes through you: not in a message, a tool call, a
  log, a commit or a tracked file. A tool call is part of your transcript, and the transcript goes
  to your model provider. The operator types each value into their **own** terminal with
  `npx oe env set <NAME>` (a hidden prompt), which writes it to the gitignored `.env.local`. The ops
  tools take secret **names** only. No tool has an input for a secret value, and
  `scaffold_env`'s `values` refuses every name outside its short config list. A schema cannot stop a
  value typed into a free text field (a name, a path), so that part is on you.

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

Do not ask for the value. Name the secret instead:

```
scaffold_env { "secretNames": ["AI_GATEWAY_API_KEY"] }
```

The reply gives the command — `npx oe env set AI_GATEWAY_API_KEY` — and `present: false`. Ask the
operator to run it in their own terminal, from the project root, and paste the key at its hidden
prompt. Then `preflight` again. The model line reads `ok`.

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

The connection string carries the database password, so it is a secret. Ask the operator to run
`npx oe env set DATABASE_URL` in their own terminal and paste it there. Confirm with
`scaffold_env { "secretNames": ["DATABASE_URL"] }`: the reply reports `present: true`.

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

Both writing tools — this one and `scaffold_env` — share one target gate with `oe env set`, so a
path override cannot put a secret where it must not go. The target must sit at the **project root**, and its name
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

Unlike the credential store's key, this one has no mint-and-forget tool, and that is deliberate: the
admin token is a bearer credential the operator must also hold to call the control plane, so it can
never be write-only. Have them generate it (`openssl rand -hex 32`), keep it, and store it with
`npx oe secret set OE_ADMIN_STATIC_TOKEN` in their own terminal. It is an operator secret in the db
credential store, not an env var (OPE-2650, 0.9.0). Never invent one for them.

Offer the OIDC form instead — the `control.adminOidc` setting, against any provider the operator
already runs. Prefer it for anything beyond a trial: nothing is then held on either side. Neither
value is a secret, and both are tracked config since 0.9.0 (they were the `OE_ADMIN_OIDC_*` env
vars), so you write them yourself into `agent/settings/settings.ts`:

```ts
export default defineSettings({
  control: { adminOidc: { issuer: "<the issuer URL>", audience: "<the audience>" } },
});
```

## Step 10 — Link the Vercel project

**Human step.** `npx vercel link` is interactive: it authenticates through a browser. Ask the
operator to run it themselves, in this directory. It writes `.vercel/project.json`, which is how
the `--check` report and every later `vercel` command find the project.

## Step 11 — Build, then push the environment to the deployment

```bash
npm run seed:model-catalog   # makes the build offline-safe
npm run build
npm run check:model-config   # can every model be served under the model settings?
```

The last command reads, for each model the app can use, the public list of endpoints from the
model's target: the AI Gateway, unless `models.targets` names another URL. It needs the network and
no credential, and it changes nothing. Each `✗` line names one demand and one model, and the
command then exits 1. **Do not deploy on this red.** Tell the operator the fix, let them pick, and
run the check again:

- A `models.dataPolicy` row, a target's own `dataPolicy` row or a `providers.only` list that no
  provider can meet: every call of that model fails closed. The choices are another stack, a wider
  `providers.only`, or fewer data policy rows.
- `models.dataPolicy and target <name> name two different regions`: no call can meet both. Keep one
  region.
- `the gateway does not know this model`: correct the model id in the stack or the route.
- `models.targets names no such target`: add the target, or correct the `via` name.

A `?` line exits 0, but it is not always a green. "Did not answer", "answered HTTP" or "not in the
expected shape" means the check did not run for that model: fix the network and run it again. A
`providers.only` name that "serves none of the checked models" is most likely a typo. "Does not say
whether" is a fact the gateway does not publish, so name it to the operator and go on. The
transcription role tries its fallback route when the primary route fails, so a red on the primary
transcription model sends the audio to the fallback. See
[the live config check](../extending/models-and-gateway.md#the-live-config-check).

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
  (`packages/core/agent/credentials/self-secrets.ts`). It is not an env var at all since 0.9.0.

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
for a person with workspace-admin rights. You cannot do it, and you should not pretend to. GitHub
also needs a person to confirm the App, but the setup generates everything else (below).

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

   The manifest is rendered from the deployment's settings. The `identity.name` setting names the
   app, the bot user, both shortcuts and the command description, and `identity.commandName` names
   the slash command (`/oe` when unset). With no name configured the app is named "Open
   Everywhere". An explicit `appName` (at most 35 characters) overrides the configured name. A
   second install in one workspace needs its own name, or the two apps look the same. The manifest also
   turns the App Home Messages tab on: without it, Slack refuses every DM to the bot with
   *"Sending messages to this app has been turned off"*.

   The response also carries `steps` (the ordered clicks) and `collect` (the values to ask for).
   The rest of this step is what those two fields say.

2. Give the operator this instruction verbatim: *open https://api.slack.com/apps → Create New App →
   From an app manifest → pick the workspace → paste the manifest → Create → Install to Workspace.*
3. Ask them to copy two values from the created app into their own terminal — never into the
   chat: the **Bot User OAuth Token** (`xoxb-…`, under OAuth & Permissions) and the **Signing
   Secret** (under Basic Information → App Credentials).

Both are **operator secrets** (OPE-2650): the Slack bundle reads `SLACK_BOT_TOKEN` and
`SLACK_SIGNING_SECRET` from the deployment's credential store first, and an env var of the same name
only as the on-ramp. Name them:

```
scaffold_env { "secretNames": ["SLACK_BOT_TOKEN", "SLACK_SIGNING_SECRET"] }
```

The reply gives one `npx oe env set <NAME>` command per name. The operator runs each in their own
terminal and pastes the value at its hidden prompt. Call the tool again with the same names: both
read `present: true`.

Then store both in the deployment's credential store: `secret_set { "names": ["SLACK_BOT_TOKEN",
"SLACK_SIGNING_SECRET"] }` reads each value from `.env.local` and writes it encrypted, with the
`DATABASE_URL` and key step 11 put there. No env push and no redeploy is needed for them: a stored
value takes effect within thirty seconds. Slack verifies the Event Subscriptions URL with a signed challenge, so the verification fails until a deploy is up and the store holds `SLACK_SIGNING_SECRET`: after that, ask the operator to choose **Retry** under Event Subscriptions.

For GitHub, the App is one click (OPE-2529). GitHub's App manifest flow creates a pre-configured App
and hands its keys back, so the person copies nothing:

```
surface_app_create { "surface": "github", "baseUrl": "https://<the deployment's host>" }
```

Give the person the `openUrl` from the reply. It is a page on THIS computer, so they open it in a
browser here. GitHub opens with the App filled in, and they confirm it. Then call
`surface_app_create { "surface": "github", "action": "status" }`: `state: "done"` lists the env names
written and the App's install link. Store the two operator secrets with `secret_set { "names":
["GITHUB_APP_PRIVATE_KEY", "GITHUB_WEBHOOK_SECRET"] }` (OPE-2650), push each other written name to the
deployment as in step 11, and redeploy. Only then ask the person to install the App on the repositories the agent works in. The
deployment learns the installation from the App's one `installation` delivery, and before the
redeploy it does not hold the App's webhook secret, so it refuses that delivery. The
[GitHub guide](./surfaces/github.md#setup) lists the permissions and events, the `owner` and `variant`
options, and the by-hand route.

**Which surfaces generate their app.** Every surface that asks a person to create an app is listed
here. Where the vendor offers a manifest or a one-click flow, the setup generates it:

| Surface | What the person creates | What the setup generates |
| --- | --- | --- |
| Slack | a Slack app | The app manifest (`surface_manifest`). The person pastes it, then copies two values into their own terminal. |
| Teams | an Azure Bot with its Entra app, and a Teams app package | The app package zip (`surface_app_package`). The setup generates nothing for the Azure Bot: the person creates it in the Azure Portal. |
| GitHub | a GitHub App | The App manifest flow (`surface_app_create`). One click, and the keys land in `.env.local`. |
| Discord | an application with a bot | Nothing. Discord has no app manifest and no one-click create flow. The person creates the application in the Developer Portal and builds the invite link with its URL Generator. |
| Notion | an internal integration | Nothing. Notion has no manifest for an internal integration. The person ticks its capabilities by hand. |
| Linear | an OAuth application | Nothing. Linear has no app manifest. The person fills in the application form by hand. |
| Google Chat | a Chat app on a Google Cloud project, with a service account | Nothing. Google Cloud has no manifest for a Chat app's configuration. The person sets it in the Cloud console. |
| Email | no app: a mailbox service account and its webhook | Nothing to generate. |

The per-surface details, including the scopes each capability needs and the surface-specific traps,
are in the surface guides: [Slack](./surfaces/slack.md), [Teams](./surfaces/teams.md),
[Discord](./surfaces/discord.md), [Linear](./surfaces/linear.md), [Notion](./surfaces/notion.md),
[GitHub](./surfaces/github.md).

## Step 15 — Load the remaining secrets

Every secret past the root-of-trust pair belongs in the encrypted credential store, not in a file.
The operator has two doors, and neither puts the value in front of you:

- **Straight to the store:** `npx oe secret set ACME_API_TOKEN` in their own terminal, with the value
  on standard input. This is the shorter path.
- **Through `.env.local`:** `npx oe env set ACME_API_TOKEN` in their own terminal, then you move it by
  name:

  ```
  secret_set { "names": ["ACME_API_TOKEN"] }
  secret_list {}
  ```

  `secret_set` reads each value from `.env.local` and reports a byte count only. A name the file
  does not hold is refused before the store opens, and the reply names the command to run. The
  value stays in `.env.local` afterwards; delete the line once nothing reads it as an env var.

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
