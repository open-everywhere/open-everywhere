# Open Everywhere app

This is an [Open Everywhere](https://github.com/open-everywhere/open-everywhere) app: an
autonomous teammate you tag in Slack, Notion and GitHub. `npx create-open-everywhere` scaffolded
it. The runtime comes from the `@open-everywhere/*` npm packages. This repository holds only your
configuration.

## Quickstart

A coding agent can do most of this for you. Open this directory in Claude Code and ask it to set up
Open Everywhere: it reads `AGENTS.md`, and `.mcp.json` gives it the `open-everywhere-ops` server.
`npx create-open-everywhere --check --json` reports the setup status as data.

You need Node 24, git, a Vercel account and a Slack workspace where you can create an app.

1. **Install.** Run `npm install`. The `postinstall` script runs `oe-eve-patch`, which applies the
   Open Everywhere patch to the installed `eve`. The app refuses to boot on an unpatched `eve`.
2. **Run the wizard.** Run `npx create-open-everywhere`. On a terminal, the scaffold already ran it
   once, so it skips what is done. After `--skip-wizard`, or from a shell with no terminal, the
   scaffold did not run it. It walks each setup step, skips the ones
   that are done, and prints the Slack app manifest. `npx create-open-everywhere --check` reports
   status and changes nothing.
3. **Create the Slack app.** At <https://api.slack.com/apps>, choose **Create New App → From a
   manifest**, and paste the manifest from step 2. Install the app to your workspace.
4. **Set the environment.** Copy `.env.example` to `.env.local` and fill in the values. On Vercel,
   add each one with `vercel env add <NAME>`. Never commit a value.
5. **Vouch your workspace.** In `agent/identity/surfaces.ts`, add your Slack workspace as
   `internal`. Until you do, every room is `external` and gets no shared memory.
6. **Name your admins.** In `agent/memory/config/domains/org.ts`, add your own Slack member id to
   `admins`.
7. **Build.** Run `npm run build`. It runs `oe build` (writes the eve slot tree from
   `roster.config.ts`) and then `eve build`.
8. **Deploy.** Run `vercel link`, then `vercel deploy --prod`. A `git push` does not deploy.
9. **Point Slack at the deployment.** In the Slack app settings, replace `YOUR-DEPLOY-URL` with your
   deployment's host in three places: Event Subscriptions and Interactivity
   (`https://<host>/eve/v1/slack`), and the `/oe` slash command (`https://<host>/eve/v1/slack/commands`).
10. **Say hello.** Send the app a direct message in Slack.

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
| `.claude/skills/quickstart-open-everywhere/` | The setup skill that drives that server. |

`agent/tools/`, `agent/channels/`, `agent/hooks/`, `agent/schedules/`, `agent/skills/`,
`agent/connections/` and `agent/lib/providers.generated.ts` are `oe build` output. They are not
committed. The `*.generated.ts` files are machine-owned overlays that the agent's own approval flows
write by pull request. Do not edit them by hand.

## Add a surface

Notion and GitHub are in the roster. Each one needs its own setup before it answers:

- **Notion** — create an internal integration, subscribe its webhook to
  `https://<host>/eve/v1/notion`, and put the pages it may act on in a memory domain's `reach`. See
  `docs/deploy/surfaces/notion.md` in the Open Everywhere repository.
- **GitHub** — create a GitHub App, point its webhook at `https://<host>/eve/v1/github`, and set
  `GITHUB_WEBHOOK_SECRET`. See `docs/deploy/surfaces/github.md` in the Open Everywhere repository.

Discord, Microsoft Teams and Linear are installed too. To add one, add it under `providers` in
`roster.config.ts`, then run `npx oe build --accept`.

## Upgrade

Bump every `@open-everywhere/*` package and `create-open-everywhere` to the same version, run
`npm install`, then `npx oe build --accept`, and review the `roster.lock.json` diff before you
deploy. Keep `eve` at the version `@open-everywhere/core` declares as its peer.
