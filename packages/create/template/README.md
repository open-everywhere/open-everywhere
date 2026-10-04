# Open Everywhere app

This is an [Open Everywhere](https://github.com/open-everywhere/open-everywhere) app: an
autonomous teammate you tag in Slack, Notion and GitHub. The runtime comes from the
`@open-everywhere/*` npm packages; this repository holds only your configuration.

## Set it up

**Open this folder in your coding agent and ask it to set up Open Everywhere.**

It reads `AGENTS.md`, `.mcp.json` gives it the `open-everywhere-ops` MCP server, and
`.claude/skills/quickstart-open-everywhere/` is the runbook it follows. It will ask you to pick a
route first:

- **Vercel** — the `vercel` CLI plus Marketplace Neon. The deployment authenticates to the AI
  Gateway with OIDC, so it needs no gateway key.
- **Docker** — self-host a container that satisfies the
  [deployment contract](https://github.com/open-everywhere/open-everywhere/blob/main/docs/deploy/contract.md).

These are the two supported routes. Some steps stay with you: creating the Slack app, approving
each deploy, and pasting each secret where the agent's tools can read it but the chat cannot.

Want the whole path on one page, or doing a step by hand? Read the
[setup steps reference](https://github.com/open-everywhere/open-everywhere/blob/main/docs/deploy/setup-steps.md).
It is generated from the same step list the status check reports, so it cannot drift from it.

## Check where you are

`npx @open-everywhere/create --check` reports every setup step and the next command for each
unsatisfied one. It changes nothing. Add `--json` for the report as data, `--route docker` to judge
against the Docker route, and `--host https://<host>` to probe a deployment.

## Develop locally

After the deploy, `npm run dev` runs the agent on this machine and talks to it in a terminal UI.
That is the loop for changing tools and skills, running evals, and debugging a turn — not a way to
set the app up. It needs `AI_GATEWAY_API_KEY` in `.env.local` (Vercel → AI Gateway → API Keys), and
it keeps its state in an embedded database under `.open-everywhere-data/`. Slack cannot reach it
without a public tunnel.

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
write by pull request. Do not edit them by hand. `npx oe build --check` (or `npx oe overlays check`)
proves they hold only data. After a data edit, run `npx oe overlays normalize`.

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

Bump every `@open-everywhere/*` package to the same version, run `npm install`, then
`npx oe build --accept`, and review the `roster.lock.json` diff before you deploy. Keep `eve` at the
version `@open-everywhere/core` declares as its peer.

If `devDependencies` still names `create-open-everywhere`, replace that key with
`@open-everywhere/create` at the same version. The unscoped name is retired and publishes no further
version. `npx oe upgrade` does this rename for you.
