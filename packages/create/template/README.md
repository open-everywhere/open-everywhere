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
  This app carries the image (`Dockerfile`) and the stack (`docker-compose.yml`: the app behind the
  egress proxy in `deploy/egress-proxy/`, with Postgres). Run `npm install` once, then
  `docker compose up --build` on the server. This stack runs the `justbash` sandbox backend: the
  agent's shell shares the app process's filesystem and environment. That is development grade, and
  it does not meet the contract's `sandbox-backend` requirement.

These are the two supported routes. Some steps stay with you: creating the Slack app, approving
each deploy, and pasting each secret where the agent's tools can read it but the chat cannot.

Want the whole path on one page, or doing a step by hand? Read the
[setup steps reference](https://github.com/open-everywhere/open-everywhere/blob/main/docs/deploy/setup-steps.md).
It is generated from the same step list the status check reports, so it cannot drift from it.

## Check where you are

`npx @open-everywhere/create --check` reports every setup step and the next command for each
unsatisfied one. It changes nothing. Add `--json` for the report as data, `--route docker` to judge
against the Docker route, and `--host https://<host>` to probe a deployment. With `--host`, the env
step also reads the deployment's own verdicts, so values set only in the Vercel dashboard count.

## Telemetry

The deployed app sends **anonymous usage telemetry, ON by default**: event names, enums, coarse
buckets, public model ids and the app version. Each event carries a random per-install id
(`service.instance.id`). It never sends message or memory content, org names, workspace, channel,
user or session ids, or env values. **To turn it off, set `OE_TELEMETRY=off`** (or `DO_NOT_TRACK=1`) on the deployment:
the Vercel project's environment or the container's. `.env.local` alone does not do it, because it
never ships. Every event and attribute is listed in the
[telemetry disclosure](https://github.com/open-everywhere/open-everywhere/blob/main/docs/deploy/telemetry.md).
The `@open-everywhere/create` CLI sends none.

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
| `scripts/goldens/roster-plan.txt` | The roster review surface: one line per slot file `oe build` writes, with the package that mounts it. `oe build` keeps it current and `npx oe build --check` fails when it drifts. Commit it, and review its diff with the lock's. |
| `agent/agent.ts` | The eve agent definition. |
| `agent/access/` | Bundles and bindings (what the agent may reach, and where), connector credentials, browser hosts, and the pre-approval rules (what runs with no approval card). |
| `agent/identity/` | Trusted surfaces, principals and groups. |
| `agent/memory/config/` | Memory domains and silos. |
| `agent/model/` | Model stacks and the org model policy. |
| `agent/settings/settings.ts` | Behaviour settings. Empty means the shipped defaults. |
| `agent/spend/` | Spend caps and model pricing. |
| `agent/webhooks/hooks.ts` | Inbound webhook triggers. |
| `AGENTS.md`, `CLAUDE.md` | The guide a coding agent reads in this repository. |
| `.mcp.json`, `scripts/ops-mcp.ts` | The `open-everywhere-ops` MCP server: setup status, `.env.local` values and stored secrets, for a coding agent. |
| `Dockerfile`, `.dockerignore`, `docker-compose.yml` | The Docker route: the app's image, and the stack that runs it behind the egress proxy with Postgres. |
| `deploy/egress-proxy/` | The egress proxy's image: the only container on the Docker route with a route to the internet. It is a copy of the Open Everywhere repository's `deploy/egress-proxy`. |
| `scripts/env-pipe.mjs` | `npm run -s env:pipe`: writes one `.env.local` value to a pipe for `vercel env add`. It refuses a terminal or a file. Never run it bare. |
| `.claude/skills/quickstart-open-everywhere/` | The setup skill that drives that server. |

`agent/tools/`, `agent/channels/`, `agent/hooks/`, `agent/schedules/`, `agent/skills/`,
`agent/connections/` and `agent/lib/providers.generated.ts` are `oe build` output. They are not
committed. The `*.generated.ts` files are machine-owned overlays that the agent's own approval flows
write by pull request. Do not edit them by hand. `npx oe build --check` (or `npx oe overlays check`)
proves they hold only data. After a data edit, run `npx oe overlays normalize`.

## Approvals

The agent asks a person before a gated act: it posts a card, and a person approves or rejects it.
The approval judge skips the card for routine acts. It runs in `enforce` mode by default, and it
runs an act with no card only when one of the rules in `agent/access/pre-approval-rules.ts` covers
that act. The audit row (`approval.judge.verdict`) records which rule. The app ships five starter
rules: a pull request, a routine, an access request, a connector write (a Notion page, a Linear
issue) and a connector delete of one item the requester named, each only when a person in the conversation asked for it. Edit the rules in that file and
deploy the change.

Every admin act and every memory erasure always posts a card, whatever the rules say. So does a connector op whose name
carries no recognised verb, unless the tool annotations of its registered server bring its final
tier down to `read`. So do an op that a raise or a server annotation made destructive, and a
connector write or delete on a person's own account. A judge allow of a connector write or
delete runs that one call only. When the judge model cannot be
reached or does not answer in time, the card is posted. A consult costs up to two calls to the
`judge` model role. To turn the judge off, set `approvals: { judgeMode: "off" }` in
`agent/settings/settings.ts`. See the
[pre-approval rules guide](https://github.com/open-everywhere/open-everywhere/blob/main/docs/how-it-works/pre-approval-rules.md).

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
