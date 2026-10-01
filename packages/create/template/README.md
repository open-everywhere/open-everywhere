# Open Everywhere app

This is an [Open Everywhere](https://github.com/open-everywhere/open-everywhere) app: an
autonomous teammate you tag in Slack, Notion and GitHub. `npx create-open-everywhere` scaffolded
it. The runtime comes from the `@open-everywhere/*` npm packages. This repository holds only your
configuration. To scaffold into a fresh clone of an empty repository, run
`npx create-open-everywhere .` inside the clone.

A coding agent can do most of the setup. Open this directory in Claude Code and ask it to set up
Open Everywhere: it reads `AGENTS.md`, and `.mcp.json` gives it the `open-everywhere-ops` server.
Some steps stay with you: creating the Slack app, approving each deploy, and the telemetry
question.

## Check where you are

`npx create-open-everywhere --check` reports every setup step and the next command for each one.
It changes nothing. Add `--json` for the report as data. It judges against the hosted goal (a
Vercel deploy) unless you add `--goal local`.

`npx create-open-everywhere` with no flags is the interactive wizard. It needs a person at a
terminal. It walks the same steps, asks for each secret without echoing it, writes `.env.local`,
prints the Slack app manifest, and asks the telemetry question. To decline telemetry from a shell
with no terminal, run `npx create-open-everywhere --decline-telemetry`.

## Run it locally

1. Run `npm install`. The `postinstall` script runs `oe-eve-patch`, which applies the Open
   Everywhere patch to the installed `eve`. The app refuses to boot on an unpatched `eve`.
2. Add `AI_GATEWAY_API_KEY` to `.env.local` (Vercel dashboard → AI Gateway → API Keys).
3. Run `npm run dev`, and talk to the agent in its terminal UI. A local run keeps its state in an
   embedded database under `.open-everywhere-data/`, so it needs no database setup.

`npx create-open-everywhere --check --goal local` reports this path. Slack cannot reach a local
server without a public tunnel, so the Slack path below deploys to Vercel.

## Deploy to Vercel with Slack

You need Node 24, git, a Vercel account and a Slack workspace where you can create an app. Do the
steps in this order. Run every command from this directory.

1. **Install.** Run `npm install`.
2. **Link a Vercel project.** Run `npx vercel link`. Every later `vercel` command acts on the linked
   project.
3. **Add the database.** In the Vercel dashboard, open the project, then **Storage → Neon →
   Connect**. The Neon integration sets `DATABASE_URL` on the project. Copy the same connection
   string into `.env.local`, with the two store selectors:

   ```
   DATABASE_URL=<the Neon connection string>
   OE_OPERATIONAL_PROVIDER=postgres
   OE_MEMORY_PROVIDER=postgres
   ```

   The wizard's database step writes these three for you. A Vercel function's disk is ephemeral,
   so without both selectors core throws there at the first store or DM-memory use.
4. **Mint the credential store key.** This command appends a fresh key to `.env.local` and prints
   nothing:

   ```
   node -e "console.log('OE_CREDENTIAL_ENCRYPTION_KEY=' + require('crypto').randomBytes(32).toString('base64'))" >> .env.local
   ```

5. **Create the Slack app.** At <https://api.slack.com/apps>, choose **Create New App → From an app
   manifest**, pick your workspace, choose JSON, and paste the manifest. The wizard prints it, and
   the ops tool `surface_manifest` returns it. Its URLs say `YOUR-DEPLOY-URL` until step 11. The app
   is named "Open Everywhere". A second install in one workspace needs its own name: run the wizard
   with `--app-name "<name>"`, or pass `appName` to `surface_manifest`. Install the app to your
   workspace. Then put two values in `.env.local` (the wizard asks for them):
   - `SLACK_BOT_TOKEN`: **OAuth & Permissions → Bot User OAuth Token** (`xoxb-…`).
   - `SLACK_SIGNING_SECRET`: **Basic Information → App Credentials → Signing Secret**.
6. **Vouch your workspace.** In `agent/identity/surfaces.ts`, add
   `defineSurface({ key: "slack/<team-id>", trust: "internal" })`. The team id starts with `T`. It
   is the segment after `/client/` in the workspace URL at <https://app.slack.com>. Until you vouch
   the workspace, every room is `external` and gets no shared memory.
7. **Name yourself an admin.** In `agent/memory/config/domains/org.ts`, set
   `admins: ["slack/<team-id>/<member-id>"]`. Your member id starts with `U`. Find it in Slack:
   your profile → **⋮ (More) → Copy member ID**. Commit both edits.
8. **Build.** Run `npm run build`. It runs `oe build` (writes the eve slot tree from
   `roster.config.ts`) and then `eve build`. It must pass before you deploy.
9. **Set the deployment's environment.** `.env.local` never ships. Copy each value to the Vercel
   project's Production environment. Pipe `npm run -s env:pipe` straight into `vercel env add`, as
   below, and never run it bare. It writes only to a pipe, and the pipe keeps the value off your
   screen. In Git Bash's terminal a bare run still prints the value, because that terminal is a pipe:

   ```
   npm run -s env:pipe -- OE_OPERATIONAL_PROVIDER=postgres | npx vercel env add OE_OPERATIONAL_PROVIDER production
   npm run -s env:pipe -- OE_MEMORY_PROVIDER=postgres | npx vercel env add OE_MEMORY_PROVIDER production
   npm run -s env:pipe -- OE_CREDENTIAL_ENCRYPTION_KEY | npx vercel env add OE_CREDENTIAL_ENCRYPTION_KEY production
   npm run -s env:pipe -- SLACK_BOT_TOKEN | npx vercel env add SLACK_BOT_TOKEN production
   npm run -s env:pipe -- SLACK_SIGNING_SECRET | npx vercel env add SLACK_SIGNING_SECRET production
   ```

   You can also add them in the dashboard: **Settings → Environment Variables**. The Neon
   integration already set `DATABASE_URL`. Vercel does not need three variables that a local run
   uses:
   - `AI_GATEWAY_API_KEY`: a deployed project authenticates to the AI Gateway with OIDC.
   - `OE_PUBLIC_BASE_URL`: the deployment reads its production host from Vercel. Set it only for a
     custom domain.
   - `OE_INTAKE_PAGE_SIGNING_KEY`: the deployment mints it into the credential store.
10. **Deploy.** Run `npx vercel deploy --prod`. It prints the production host,
    `https://<project>.vercel.app`. A `git push` does not deploy. A variable you add after a deploy
    reaches the functions only on the next deploy.
11. **Point Slack at the deployment.** In the Slack app settings, open **App Manifest**, replace
    `YOUR-DEPLOY-URL` with your host in all three places, and save. The three URLs are Event
    Subscriptions and Interactivity (`https://<host>/eve/v1/slack`) and the `/oe` slash command
    (`https://<host>/eve/v1/slack/commands`). Slack then verifies the Event Subscriptions URL. The
    verification fails until a deploy that holds `SLACK_SIGNING_SECRET` is up. If it fails, open
    **Event Subscriptions** and choose **Retry**.
12. **Check the deploy.** Run `npx create-open-everywhere --check --host https://<host>`. Its
    build + deploy step sends one unsigned request to the Slack route. The Slack route's own
    `401 unauthorized` means the function booted and the route is mounted. It does not prove the
    deployment holds `SLACK_SIGNING_SECRET`: the route answers the same without it. Event
    Subscriptions showing **Verified** in step 11 proves that.
13. **Say hello.** Send the app a direct message in Slack.

## What the build prints

`npm run build` prints some warnings that are expected:

- Several `Ignoring unsupported directory "<name>/" in the agent root` warnings. `eve` warns about each
  directory in `agent/` that is not one of its own slots. Those directories (`access/`,
  `identity/`, `settings/` and the rest) are Open Everywhere configuration, which the app loads
  itself.
- `[open-everywhere:sandbox] off-Vercel sandbox backend = docker` and an `egress NOT enforceable`
  warning. A build on your machine evaluates the agent's modules off Vercel, so they describe a
  local run. On Vercel the agent uses the Vercel Sandbox, which enforces egress. For a local run,
  read the warning: a session that needs network access aborts until you wire the egress proxy or
  set `egress.allowUnenforced` in `agent/settings/settings.ts` for development.

The deployment's logs also print one expected warning at each cold start:
`[open-everywhere:connector-scope:boot] channel-kind ALS reach: unavailable … Cannot find module
'eve/package.json'`. The Vercel build bundles `eve` into the function, so no `node_modules/eve`
exists at run time. Only an optional hint about the caller's channel kind is lost. The connector
gate still refuses a call with no caller identity, and the session's binding recovers the surface.

## What is in this repository

| Path | What it is |
| --- | --- |
| `roster.config.ts` | What the agent can do: which packages contribute, and which eve built-ins it takes away. |
| `roster.lock.json` | The reviewed roll-call of every contribution. `npx oe build --accept` updates it. Review its diff. |
| `agent/agent.ts` | The eve agent definition. |
| `agent/access/` | Bundles and bindings (what the agent may reach, and where), connector credentials, browser hosts. |
| `agent/identity/` | Trusted surfaces, principals and groups. |
| `agent/memory/config/` | Memory domains and silos. |
| `agent/model/` | Model stacks and the org model policy. |
| `agent/settings/settings.ts` | Behaviour settings. Empty means the shipped defaults. |
| `agent/spend/` | Spend caps and model pricing. |
| `agent/webhooks/hooks.ts` | Inbound webhook triggers. |
| `AGENTS.md`, `CLAUDE.md` | The guide a coding agent reads in this repository. |
| `.mcp.json`, `scripts/ops-mcp.ts` | The `open-everywhere-ops` MCP server: setup status, `.env.local` values and stored secrets, for a coding agent. |
| `scripts/env-pipe.mjs` | `npm run -s env:pipe`: writes one `.env.local` value to a pipe for `vercel env add`. It refuses a terminal or a file. Never run it bare. |
| `.claude/skills/quickstart-open-everywhere/` | The setup skill that drives that server. |

`agent/tools/`, `agent/channels/`, `agent/hooks/`, `agent/schedules/`, `agent/skills/`,
`agent/connections/` and `agent/lib/providers.generated.ts` are `oe build` output. They are not
committed. The `*.generated.ts` files are machine-owned overlays that the agent's own approval flows
write by pull request. Do not edit them by hand.

## Add a surface

Notion and GitHub are in the roster. Each one needs its own setup before it answers:

- **Notion** — create an internal integration, subscribe its webhook to
  `https://<host>/eve/v1/notion`, and put the pages it may act on in a memory domain's `reach`. See the
  [Notion guide](https://github.com/open-everywhere/open-everywhere/blob/main/docs/deploy/surfaces/notion.md).
- **GitHub** — create a GitHub App, point its webhook at `https://<host>/eve/v1/github`, and set
  `GITHUB_WEBHOOK_SECRET`. See the
  [GitHub guide](https://github.com/open-everywhere/open-everywhere/blob/main/docs/deploy/surfaces/github.md).

Discord, Microsoft Teams and Linear are installed too. To add one, add it under `providers` in
`roster.config.ts`, then run `npx oe build --accept`.

## Upgrade

Bump every `@open-everywhere/*` package and `create-open-everywhere` to the same version, run
`npm install`, then `npx oe build --accept`, and review the `roster.lock.json` diff before you
deploy. Keep `eve` at the version `@open-everywhere/core` declares as its peer.
