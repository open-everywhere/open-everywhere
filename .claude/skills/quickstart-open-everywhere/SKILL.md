---
name: quickstart-open-everywhere
description: Set up, configure or deploy an Open Everywhere app — from a fresh scaffold to an agent that answers in Slack. Use when the user wants to set up Open Everywhere, deploy it, or connect Slack, Notion or GitHub. Two routes are supported, Vercel and Docker, and step 1 is to ask which. Drives the open-everywhere-ops MCP server (preflight, surface_manifest, surface_app_create, scaffold_env, scaffold_credential_key, secret_set/list/rm, sovereignty), the `@open-everywhere/create --check --json` status report and the `npm run check:model-config` model check.
---

# Quickstart Open Everywhere

This directory is an **Open Everywhere app** — either a scaffolded app (it depends on the
`@open-everywhere/*` npm packages and holds only configuration) or a clone of the Open Everywhere
repository, which contains those packages and is itself an app. `AGENTS.md` describes which one you
are in. Its `.mcp.json` gives you the `open-everywhere-ops` MCP server. You supply the judgement,
and you run commands **with the user's consent**.

🔴 **Two commands differ between the two homes.** In a scaffolded app, run
`npx @open-everywhere/create --check --json` and `npm run -s env:pipe`. In a clone of the
repository, run `node packages/create/bin/create-open-everywhere.js --check --json` (the checkout's
own CLI, not the published one) and use the `grep`/`cut` form of the env push given in step 9 —
that repository ships no `env:pipe` script. Everything else is the same.

## Golden rules

- The ops MCP tools check and scaffold. **You** run install, build and deploy commands in the
  user's shell: show the command, get a yes, then run it. Never run a deploy, create a cloud
  resource, or write a secret without explicit confirmation.
- **Never ask the user to paste a secret into the chat, never pass one to a tool, and never echo or
  commit one.** A tool call is part of your transcript. The user types each secret into their OWN
  terminal with `npx oe env set <NAME>`: it reads the value from a hidden prompt and writes it to the
  gitignored `.env.local`. You only ever handle the NAME: `scaffold_env { secretNames: [...] }`
  returns the command per name and whether the file holds a value yet. `scaffold_env { values }`
  takes non-secret config only, and its schema refuses a secret name. Mint the credential-store key
  with `scaffold_credential_key`, which never prints it.
- **Never propose a local run as a setup step.** `npm run dev` is the development loop AFTER the
  deploy. A local run has no public HTTPS URL for Slack to reach and keeps its state in a different
  store, so it proves little about the deployment. See "Develop locally" below.
- **Where each secret lives.** The deployment reads `DATABASE_URL`,
  `OE_CREDENTIAL_ENCRYPTION_KEY`, `SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET` and
  `GITHUB_WEBHOOK_SECRET` from its **environment**: the Slack bundle and the GitHub webhook check
  never read the credential store. So these go in `.env.local`, and then into the deployment's own
  environment. `secret_set { names: [...] }` is for a credential whose `broker` is `"db"` (and
  `NOTION_WEBHOOK_SECRET`): it moves each named value from `.env.local` into the store, so the user
  runs `npx oe env set <NAME>` first. It needs `DATABASE_URL` and the key in `.env.local` too.
  Nothing reads a stored secret back out (`secret_list` returns names only).
- **If an ops tool answers "the app now runs @open-everywhere/core X; this ops server runs Y"**, the
  server predates an upgrade. Ask the user to restart it (`/mcp`, then reconnect
  `open-everywhere-ops`) and call again. Never work around it: a stale server serves old code. A
  server whose core predates this check cannot refuse: after an upgrade, an input-validation error
  that names `values` or `secrets`, a `scaffold_env` reply with no `secrets` list for the
  `secretNames` you sent, or "Tool … not found", means the same thing. Restart it. Never fall back
  to passing a value.
- Every command runs from the app root.

## Step 1 — ask which route

**Two routes are supported. Ask the user to pick one before anything else.**

- **Vercel** — on rails: the `vercel` CLI plus Marketplace Neon. The deployment authenticates to
  the AI Gateway with OIDC, so it needs no gateway key.
- **Docker** — self-host a container that satisfies the **deployment contract**
  (`https://github.com/open-everywhere/open-everywhere/blob/main/docs/deploy/contract.md`). Off
  Vercel there is no OIDC, so the model route needs `AI_GATEWAY_API_KEY`. Running a different model
  backend instead is an adapter swap in app code, not an env setting
  (`https://github.com/open-everywhere/open-everywhere/blob/main/docs/extending/adapter-model.md`),
  and `--check` cannot see it.

Nothing beyond these two is supported. For any other host, read the contract and follow the Docker
route; do not invent a recipe.

## Tell the user about telemetry, before the first deploy

**The deployed app sends anonymous usage telemetry, and it is ON by default.** Tell the user that
before the first deploy, and ask whether they want it. Do not decide for them. It sends event names,
enums, coarse buckets, public model ids and the app version, with a random per-install id
(`service.instance.id`). It never sends message or memory content, org names, workspace, channel,
user or session ids, or env values. The full list
of events is `https://github.com/open-everywhere/open-everywhere/blob/main/docs/deploy/telemetry.md`.

To turn it off, `OE_TELEMETRY=off` (or `DO_NOT_TRACK=1`) must be set on the DEPLOYMENT: a value in
`.env.local` reaches only a local run. On the Vercel route, at step 9:
`printf off | npx vercel env add OE_TELEMETRY production`. On the Docker route, put it in the
container's environment. Every boot prints a line that says whether telemetry is on.

eve's own CLI telemetry is separate: Open Everywhere sets `EVE_TELEMETRY_DISABLED=1` where it
starts eve (its npm scripts and `Dockerfile`), and `OE_TELEMETRY` does not change it. For an `eve`
command run by hand, or an app scaffolded before 0.8.0, read the eve section of the page above.

## Status, at every step

- `npx @open-everywhere/create --check --json` — the step list as data: `satisfied`, `detail`, and a
  `next` command per unsatisfied step. It changes nothing. Pass `--route docker` on the Docker
  route, and `--host https://<host>` once a deployment exists: the env step then also reads the
  deployment's own verdicts from its public status route. In a clone of the repository, run
  `node packages/create/bin/create-open-everywhere.js --check --json` instead.
- The `preflight` tool — the env verdict per name. Pass `target: "vercel"` or `target: "docker"`.

Re-run both after each step. They are the only answer to "what is left to do": there is no plan
tool. The same step list, written for a human, is
`https://github.com/open-everywhere/open-everywhere/blob/main/docs/deploy/setup-steps.md`.

## Check the model config, after every model setting

Run `npm run check:model-config` after the model settings are written, and before the deploy that
carries them. The Vercel route runs it at its build step, and the Docker route at its model route
step. Run it again after each change to `models` in `agent/settings/settings.ts` (`dataPolicy`,
`targets`, `force`), to the stack in `agent/model/stacks.ts`, or to a model route of a domain or a
role. The command is the same in both homes. For each model, it reads the public list of endpoints
from the model's target: the AI Gateway, unless `models.targets` names another URL. So it needs the
network and no credential. It changes nothing.

Read the result to the user in plain words:

- **Exit 0, no `✗` line and no `?` line.** Each model the app can use has a provider that meets
  every demand. Go on.
- **A `?` line that says "did not answer", "answered HTTP" or "not in the expected shape".** The
  check did not run for that model. This is not a green. Fix the network, then run it again. A
  target URL that "does not serve the endpoints read" (a relay) cannot be checked here: say so.
- **A `?` line that says a `providers.only` name "serves none of the checked models".** The name is
  most likely a typo. Show it to the user.
- **A `?` line that says "does not say whether".** The gateway does not publish that fact, so the
  demand is unknown. Name the model and the demand to the user, then go on.
- **Exit 1, a `✗` line.** Each line names one demand and one model. Read it to the user:
  - `region eu: no provider for deepseek/deepseek-v4.1-flash` (or `zeroRetention`, `noTraining`,
    `providers.only`): no provider meets the demand. Under it every call of that model fails
    closed: the call errors, and it never goes to a provider outside the demand. The choices are a
    stack whose models meet the demand, a wider `providers.only` list, or fewer rows in
    `models.dataPolicy` or in the target's own `dataPolicy`.
  - `models.dataPolicy and target <name> name two different regions`: no call can meet both.
    Keep one region.
  - `the gateway does not know this model`: correct the model id in the stack or the route.
  - `models.targets names no such target`: add the target to `models.targets`, or correct the
    `via` name.

  **Do not deploy on this red.** Let the user pick the fix, then run the check again. One role
  differs: transcription tries the fallback route that `agent/model/stacks.ts` names when the
  primary route fails. So a red on the primary transcription model sends the audio to the fallback
  route. Check that route too.

After the deploy, `--check --host` reads the same check in the `model-route` row of the status
route. That row names no model, so on a `no` there, run `npm run check:model-config` for the names.
An app scaffolded before 0.8.0 has no `check:model-config` script: its upgrade notes say how to add it.

## Tell the user where their data lives

Before the first deploy, offer the data map once: `npx oe sovereignty --host vercel` (or
`--host docker`), or the `sovereignty` ops tool. For each piece of data it says where it lives,
which region, and which company could be compelled to hand it over. It reads the app's own config
and changes nothing. Give the user the short version. Run it again after a change to the model
settings or the store.

## The Vercel route

1. **Install.** If `node_modules` is missing: `npm install`. Its `postinstall` runs `oe-eve-patch`,
   which patches the installed `eve`. The app refuses to boot without the patch.
2. **Link.** `npx vercel link` (interactive: the user signs in). Every later `vercel` command acts
   on the linked project.
3. **Database.** `npx vercel install neon` provisions a Neon database and connects it to the linked
   project, which sets `DATABASE_URL` there. (`vercel install` is an alias of
   `vercel integration add`; the Marketplace slug is `neon`.) The dashboard path — project →
   **Storage → Neon → Connect** — does the same thing. The integration can also enable **Neon
   Auth** (`NEON_AUTH_BASE_URL`, `VITE_NEON_AUTH_URL`). Open Everywhere does not use it: leave it
   off, or ignore those two variables. Then get the same value into `.env.local`
   for the operator tools, either with `npx vercel env pull` (it writes the project's environment
   into `.env.local`, overwriting it, so pull before you add anything local) or by asking the user
   to run `npx oe env set DATABASE_URL` and paste the connection string at its prompt. **That one value is the whole
   step:** it resolves both the operational store and the memory backing to postgres on its own, so
   set no provider selector. A selector pointing AWAY from postgres is the only thing that breaks
   it.
4. **Key.** `scaffold_credential_key`.
5. **Slack app.** Call `surface_manifest { surface: "slack" }` and hand the user the manifest and
   the steps it returns. Before the first deploy the manifest keeps `YOUR-DEPLOY-URL`. The user
   creates and installs the app, then runs `npx oe env set SLACK_BOT_TOKEN` and
   `npx oe env set SLACK_SIGNING_SECRET` in their own terminal. Confirm with
   `scaffold_env { secretNames: ["SLACK_BOT_TOKEN", "SLACK_SIGNING_SECRET"] }`: both read `present: true`.
   **App icon.** With no `identity.name` set, the agent presents as the project, so its default
   avatar is the project mark. Unless the user set `identity.name` and chose their own icon, tell
   them to upload
   `https://raw.githubusercontent.com/open-everywhere/open-everywhere/main/brand/png/mark-square-1024.png`
   under **Basic Information → Display Information → App icon**. The manifest has no icon field.
   The same file is the icon for a Discord application, a GitHub App, and a Notion or Linear
   integration. For Teams, the package icons are the mark:
   `https://raw.githubusercontent.com/open-everywhere/open-everywhere/main/teams-app/color.png` and
   `https://raw.githubusercontent.com/open-everywhere/open-everywhere/main/teams-app/outline.png`.
6. **Vouch the workspace.** Ask for the team id (`T…`: the segment after `/client/` in the
   workspace URL at app.slack.com). In `agent/identity/surfaces.ts` add
   `defineSurface({ key: "slack/<team-id>", trust: "internal" })`.
7. **Admin.** Ask for the user's member id (`U…`: Slack profile → ⋮ More → Copy member ID). In
   `agent/memory/config/domains/org.ts` set `admins: ["slack/<team-id>/<member-id>"]`. Offer to
   commit both edits. They take effect on the next deploy, so make them before it.
   Then OFFER the optional window step below. Do not make it for the user unasked.
8. **Build.** `npm run build`. It must pass. Then `npm run check:model-config`, and read it as
   "Check the model config" above says. A `✗` line stops the route here.
9. **Deployment env.** `.env.local` never ships, so the deployment reads only what you set ON it.
   The names are `OE_CREDENTIAL_ENCRYPTION_KEY`, `SLACK_BOT_TOKEN` and `SLACK_SIGNING_SECRET`. The
   Neon integration already set `DATABASE_URL` there, and that one value resolves both stores — so
   there is no `OE_OPERATIONAL_PROVIDER` or `OE_MEMORY_PROVIDER` to push. Add `OE_TELEMETRY` (value
   `off`) only when the user chose to turn telemetry off (see the telemetry section above).
   Confirm each command first, and **never let a value reach your own output.**
   - **In a scaffolded app:** `npm run -s env:pipe -- <NAME> | npx vercel env add <NAME> production`.
     Always pipe `env:pipe` straight into `vercel env add`, as written. Never run it bare: your
     shell is never a terminal, so a bare run prints the secret into your output. `env:pipe`
     refuses a file or a terminal, but it cannot tell a pipe into your own shell from a pipe into
     `vercel`.
   - **In a clone of the repository** (it ships no `env:pipe`):
     `grep "^<NAME>=" .env.local | cut -d= -f2- | tr -d '\n' | npx vercel env add <NAME> production`.
     Same rule: the value only ever crosses a pipe.
   Do not push `AI_GATEWAY_API_KEY` (OIDC covers it), `OE_PUBLIC_BASE_URL` (only for a custom
   domain) or `OE_INTAKE_PAGE_SIGNING_KEY` (the deployment mints it). A variable added after a
   deploy reaches the functions only on the NEXT deploy.
10. **Deploy.** `npx vercel deploy --prod` (confirm first). Note the production host it prints. A
    `git push` does NOT deploy.
11. **Slack URLs.** Call `surface_manifest { surface: "slack", baseUrl: "https://<host>" }`. The
    user pastes it under the Slack app's **App Manifest** and saves. Slack verifies the Event
    Subscriptions URL. If it fails, the user chooses **Retry** under Event Subscriptions.
12. **Prove it.** `npx @open-everywhere/create --check --json --host https://<host>`. The
    `build-deploy` step is satisfied only when the deployed Slack route answers an unsigned request
    with its own `401 unauthorized`. That proves boot and routing, not `SLACK_SIGNING_SECRET`: ask
    the user to confirm Event Subscriptions shows **Verified**.
13. **Hello.** Ask the user to send the app a direct message in Slack.

## The Docker route

Read the deployment contract first: it states what a running Open Everywhere needs — Node 24, a
public HTTPS URL, Postgres, a sandbox backend, egress control, a model route, and the secrets list.
Then:

1. **Install and build.** `npm install`, then `npm run build`.
2. **Postgres.** Provision one the container can reach. The user runs `npx oe env set DATABASE_URL`
   and pastes its connection string at the prompt. That one value resolves both stores to postgres;
   set no provider selector. The compose stack of step 6 also carries a Postgres of its own.
3. **Key.** `scaffold_credential_key`.
4. **Model route.** There is no OIDC off Vercel, so the user supplies `AI_GATEWAY_API_KEY` (Vercel
   → AI Gateway → API Keys issues one for any host) with `npx oe env set AI_GATEWAY_API_KEY`. Running a different model backend instead is
   an **adapter swap in app code**
   (`https://github.com/open-everywhere/open-everywhere/blob/main/docs/extending/adapter-model.md`),
   which `--check` cannot see: that step stays `missing` on the Docker route either way, so read it
   and move on rather than chasing a green it cannot give. On the gateway, run
   `npm run check:model-config` once the model settings are written, and read it as "Check the
   model config" above says. A `✗` line stops the route here.
5. **Slack app.** Exactly as steps 5–7 of the Vercel route.
6. **Run it.** The app ships its own `Dockerfile` and `docker-compose.yml`: the image, the egress
   proxy (`deploy/egress-proxy/`), Postgres and its WebSocket bridge. On the server, the user puts
   the contract's environment in `.env`, with `OE_EGRESS_PROXY_TOKEN` (`openssl rand -hex 32`) and
   a `POSTGRES_PASSWORD`, then runs `docker compose up --build`. The compose file sets
   `DATABASE_URL` to its own `postgres` service. For the managed Postgres of step 2 instead, put
   its `DATABASE_URL` in `.env`, then delete the app's `DATABASE_URL` and `OE_NEON_WS_PROXY` lines
   and the `postgres` and `neon-wsproxy` services from the compose file. Put a TLS-terminating
   reverse proxy in front that forwards `/eve/` and `/.well-known/workflow/`.
   Tell the user plainly: this stack runs the `justbash` sandbox backend, so the agent's shell
   shares the app process's filesystem and environment, every `.env` value included. That is
   development grade, and it does not meet the contract's `sandbox-backend` requirement.
7. **Prove it, then the Slack URLs and the hello.** As steps 11–13 of the Vercel route, with
   `--route docker --host https://<host>`.

## Optional: one cross-surface window

Offer this step once, after the admin step. Skip it when the user declines. Every channel the bot
is in already has its own standing seat, because `window.topology` ships on. The `org` catch-all
always stays solo: the boot refuses `mode` on it, because the whole org is never one window.

A cross-surface window lets a few rooms share ONE conversation and one brain. To make one:

1. Ask for the window's **name** (for example `team`) and its **reach**: the exact surface keys of
   the rooms that share it, such as `slack/<team-id>/<channel-id>` or `github/<owner>/<repo>`.
2. Say the cost plainly: each room's seat sees what the other rooms said, so the window is a wider
   data blast radius than a solo seat.
3. Write `agent/memory/config/domains/<name>.ts`:
   `export const domain = defineDomain({ name: "<name>", reach: [ … ], memory: "org-brain", mode: "unified" });`
   Then add `import * as <name> from "./<name>.js";` and `<name>` to `MODULES` in
   `agent/memory/config/domains/index.ts`. Declare ONE such domain, not one per room.
4. Every member outside Slack must be declared internal in `agent/identity/surfaces.ts`, or the
   boot refuses the window at config load.

## Optional: add an MCP server

Offer this step when the user names a tool their team uses that has a hosted MCP server (for
example FullStory). An admin declares the server, and the declaration lands by pull request: a
person in chat cannot add one.

1. Ask for the server's **name** (lowercase, for example `fullstory`), its **URL** from the
   vendor's own MCP documentation, and one line that says what it is for.
2. Add one entry to `MCP_SERVERS` in `agent/access/mcp-servers.ts`:
   `{ name: "fullstory", url: "https://<the vendor's MCP endpoint>", description: "…" }`.
   The default sign-in is MCP OAuth discovery with dynamic client registration, so the entry
   needs no client id and no secret. Only a vendor WITHOUT dynamic registration takes a
   `signIn: { mode: "static-confidential", … }` block, and that block names the secret's
   credential-store REF (`clientSecretRef`), never the value.
3. Run `npx oe build`. Commit `agent/access/mcp-servers.ts` and the updated
   `scripts/goldens/roster-plan.txt`, then open the pull request.
4. Say what the user gets. In a DM, each person uses the server as THEMSELVES: their first call
   posts a "Connect my account" card, and they sign in with their own account once. A channel
   gets nothing until an admin grants the server's `workspace-oauth` credential (the org's own
   account) on a bundle in `agent/access/bundles.ts`.
5. Say who "each person" is: every account that can DM the agent, an external one included (a
   Slack Connect user, a Discord user who shares a server with the bot). If external people can
   DM the agent, offer to narrow the entry with `people: { groups: ["<group>"] }`.

With no server declared, nothing changes: the build writes no connection for one, and only the
shipped connections (Notion) stay mounted.

## Optional: connect GitHub

Offer this step after the first deploy, when the user wants the agent to work in GitHub. The
GitHub App is one click: the ops server generates its manifest, and GitHub hands the App's keys
back to a page on this computer, so the user copies nothing.

1. Call `surface_app_create { surface: "github", baseUrl: "https://<host>" }`. Pass
   `owner: "<org login>"` to create the App under an organization. The default App also answers
   @mentions on issues and pull requests; `variant: "source-control"` creates one for checkout,
   pull requests and ticket actions only.
2. Give the user the `openUrl` from the reply. It is a local page: they open it in a browser on
   this computer. GitHub opens with the App filled in. They check the name (GitHub App names are
   unique, so they change it if GitHub says it is taken) and confirm.
3. Call `surface_app_create { surface: "github", action: "status" }`. `state: "done"` lists the
   env names written to `.env.local` and the App's install link. Keep the link for step 5.
4. On the Vercel route, push each name in `written` exactly as in step 9, then redeploy. On the
   Docker route, add each one to the server's `.env` (Docker step 6), then restart the stack.
5. Only after that redeploy or restart, ask the user to open the install link and install the App
   on the repositories the agent works in. The install sends one `installation` delivery, and the
   deployment learns the installation from it. Before the redeploy the deployment does not hold the
   App's webhook secret, so it refuses that delivery and never learns the installation.

The tool never returns a value, and it refuses to overwrite names `.env.local` already holds.

## Develop locally

Only when the user asks to change or debug the agent — never as a setup step. The user creates
`AI_GATEWAY_API_KEY` (Vercel → AI Gateway → API Keys) and writes it with
`npx oe env set AI_GATEWAY_API_KEY`, then `npm run dev`. A local run keeps its state in an embedded database under
`.open-everywhere-data/`, and Slack cannot reach it without a public tunnel.

## Notes

- `roster.config.ts` decides what the agent can do. After any change to it, or after a package
  upgrade, run `npx oe build --accept` and show the user the `roster.lock.json` diff: accepting it
  is their review decision.
- `.env.example` names every variable this app reads. Read it when unsure what a key does.
- The deployment's own identity (`deploymentIdentity`) is code in `agent/identity/surfaces.ts`, not
  env.
- `@open-everywhere/create` has no interactive wizard and sends no telemetry. It scaffolds
  (`npx @open-everywhere/create <dir>`) and reports status (`--check`). Nothing else. The deployed
  app is a different matter: its telemetry is on by default (see the telemetry section above).
- 🔴 **Without `--host`, `--check` reads `.env.local` and your shell, never the deployment's own
  environment.** With `--host`, the env step also reads the deployment's status route, which reports
  `DATABASE_URL` and the credential key (its `secrets` row), the store selection and the model route.
  The env step does not judge the Slack secrets, so even a "9/9 satisfied" is not proof that the
  deployment holds `SLACK_BOT_TOKEN` and `SLACK_SIGNING_SECRET`. The same status document's
  `surfaces.slack.credentials` reports whether both are present: read it with
  `curl -s https://<host>/eve/v1/oe/status`. Slack's **Verified** is what proves the signing secret.
