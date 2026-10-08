# Quick start

**The fast path to a talking agent: deploy button → a live agent answering in a channel.**

This is the fastest path to a working Open Everywhere. It gets you a deployed agent that
responds when you `@mention` it in one channel, with a minimal config — one surface, one
bundle, an env-backed credential. For the full production runbook (real connectors, egress
enforcement, going live safely) see the **[setup runbook](../deploy/setup-runbook.md)**; for
the per-platform app registration, see **[surface setup](../deploy/surfaces/)**.

## Scaffold the app, then let your coding agent set it up

Setup is **agent-led**. `@open-everywhere/create` does two things — it scaffolds the app and it
reports setup status — and your coding agent does the rest, with your consent at every command.

```bash
npm create @open-everywhere my-agent          # scaffold ./my-agent, then open it in your agent
npx @open-everywhere/create@latest --check    # report setup status (--json for data)
```

The scaffold writes the quickstart app: a small repository of your own that depends on the
`@open-everywhere/*` npm packages and holds only your configuration — a roster that mounts Slack,
Notion and GitHub, and the agent config under `agent/`. The directory must be new or empty. It
never waits on a prompt: it writes the app, prints the next steps and exits. The app carries
`AGENTS.md`, a `.mcp.json` that starts the `open-everywhere-ops` MCP server, and the
`quickstart-open-everywhere` skill, so a coding agent opened in it drives the setup.
[Consuming as packages](../deploy/consuming-as-packages.md) explains what the app contains.

`npm create @open-everywhere` and `npx @open-everywhere/create` are the same package: npm maps a
bare scope to `@scope/create`. Inside a checkout you can also run it from the tree itself:
`node packages/create/bin/create-open-everywhere.js`.

**Two routes are supported, and the agent asks which first:** **Vercel** (the `vercel` CLI plus
Marketplace Neon — the deployment authenticates the AI Gateway with OIDC, so no gateway key) and
**Docker** (a self-hosted container that satisfies the
[deployment contract](../deploy/contract.md)). Nothing else is supported. A local run is the
**development** loop after the deploy, never a setup route.

`--check` walks nine steps, in order: prerequisites (Node 24, git), the repo checkout itself, the
tool roster, a Vercel project link, the database, a Slack app (manifest included), an env-var
presence checklist (never prints a value), `npm run build` plus the deploy, and a final go/no-go
verification. It prints a `next` command under each unsatisfied one. The same list written out for
a human is **[Setup steps](../deploy/setup-steps.md)**, generated from the engine itself, so it
cannot drift from what the check reports.

`--route docker` judges against the Docker route (the default is `vercel`). `--host <url>` probes a
deployment: the build + deploy step is satisfied only when the deployed Slack route answers an
unsigned request with its own `401 unauthorized`. That proves the function booted and the route is
mounted. It does not prove the deployment holds `SLACK_SIGNING_SECRET`; Slack's Event Subscriptions
**Verified** does. The first request to a fresh deployment boots the function, so a timeout or a
5xx gets one retry with a longer timeout, and a pass on the retry says "cold start". `--check`
reads `.env.local` and the shell, never the deployment's own environment. A value you set only in
the Vercel dashboard still reads as missing, and the miss says so. `--app-name <name>` names the
Slack app in the printed manifest (default "Open Everywhere"); a second install in one workspace
needs its own name.

`--check` changes nothing: no prompts, no writes, no telemetry. **There is no interactive wizard,
and this CLI sends no telemetry at all** — see [Telemetry](../deploy/telemetry.md) for the two
retired install-wizard events and why their names are still accepted by the collector. The ops MCP
server's tools write non-secret config: `scaffold_env` writes it to `.env.local`, and
`scaffold_credential_key` mints the credential-store key without printing it. A secret value never
passes through a tool: you type it into your own terminal with `npx oe env set <NAME>`, which reads
it from a hidden prompt into `.env.local`.

Without a directory name, `--check` reports on the app in the current directory. Its repo step
checks that the directory is an Open Everywhere app — a scaffolded one, or a clone under
**Run locally** — and names `npm install` as the next command when its dependencies are missing.
In a directory that is not an app, that step reports unsatisfied and tells you to scaffold one.

**Dependency cooldown (recommended for your project, not ours):** npm's `min-release-age`
setting delays a dependency version from resolving until it has aged on the registry for a
number of days you choose. A malicious release then has that long to be caught and unpublished
before your `npm install` can touch it. It gates any version npm must resolve, floating or
exact-pinned. We considered this cooldown for Open Everywhere's own installs and ruled it out:
eve, our largest-blast-radius dependency, ships several times a day, and a multi-day cooldown
would keep this repo permanently behind it. Your own project does not carry that constraint.
Once `@open-everywhere/core` and its sibling packages publish to npm and your project depends
on them like any other package, a `.npmrc` with `min-release-age=7` (or another value that
fits your update cadence) is worth adopting.

## Deploy to Vercel (easiest path)

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https://github.com/open-everywhere/open-everywhere)

1. **Click the deploy button.** It clones the repo into your GitHub account and creates a
   Vercel project from it.
2. **Add a database.** In the Vercel dashboard → **Storage** → add **Neon** (Postgres) from
   the Marketplace. The connection string is injected automatically, and that is the whole step:
   a present `DATABASE_URL` selects Postgres for the memory backing and the operational store on
   its own. Vercel's filesystem is ephemeral, so the local backings do not persist between
   invocations. Postgres is the deploy baseline, not an upgrade.
3. **Model auth is automatic.** On a linked Vercel project the AI Gateway authenticates via
   OIDC — no model key to paste. The agent runs the `american-closed` stack out of the box, one
   env var away from switching to `chinese-open-weights` (DeepSeek V4 Flash) or back — see
   [Models & the AI Gateway](../extending/models-and-gateway.md).
4. **Connect one surface.** This is the only inherently manual step: create a Slack (or Teams /
   Discord / Linear / Notion / GitHub) app and paste its secrets into your Vercel env. App creation is
   interactive by nature, so follow the guide for your platform under
   [surface setup](../deploy/surfaces/). The minimal Slack path: paste the bot token
   (`SLACK_BOT_TOKEN`) and signing secret (`SLACK_SIGNING_SECRET`), subscribe to the
   `app_mention` event, and point its request URL at the agent's Slack route.

That's the whole happy path. `@mention` the agent in the channel you wired up and it answers.

## Just ask — there's nothing to build

There is no workflow builder, no prompt library, no setup step between you and useful work.
You ask in plain language; the agent picks the right shape:

- **One-off asks** it just does, and reports the outcome.
- **Big or vague asks** it breaks into steps itself — you don't sequence the work.
- **Facts about how your team works** (a convention, an owner, a preference) it
  [remembers](../capabilities/memory.md), so you're never asked twice.
- **Anything recurring** it offers to make a
  [routine](../capabilities/proactivity-and-routines.md) ("want me to do this every
  Monday?") so nobody has to ask again.
- **A repeated multi-step way of doing things** it captures as a
  [skill](../capabilities/skills-and-plugins.md) so next time it's one named move.

You never need to learn those words — the agent proposes each in plain language when it
spots the pattern. Persistence doesn't loosen the rules: memories, routines, and skills
are context, not access, and anything consequential still pauses for
[approval](../how-it-works/agent-and-loop.md) when it runs.

## Run locally

If you'd rather see it run on your machine first (**requires Node 24.x** — `nvm use 24`, matched to
`package.json` engines and CI; Node 22 only warns at install, then fails at runtime):

```bash
git clone https://github.com/open-everywhere/open-everywhere
cd open-everywhere
npm install
cp .env.example .env.local      # fill in AI_GATEWAY_API_KEY (or run `eve link`)
npm run dev                     # eve dev — boots the agent on http://localhost:3000
npm test                        # deterministic unit/integration suites (no live model)
```

`npm run dev` proves the model loop in a local TUI with no chat surface or access config
needed — the quickest way to confirm the model end works. Locally (on a persistent disk) you can
leave memory on the default `git` and the operational store on its zero-wiring floor — an
**embedded Postgres (PGlite)**, the *same dialect* as production, no database to provision. You
only need hosted Postgres on ephemeral Vercel. The embedded floor is **single-process, local-disk
durable** (fine for dev / a small self-host); for real production org data, graduate the
operational store to a Postgres server or hosted Postgres with the supported migration
([Graduating the operational store](../deploy/database-graduation.md)).

Setting it up for real? That is the agent's job, not this page's: open the app in your coding
agent and ask it to set up Open Everywhere. It reads the `quickstart-open-everywhere` skill, drives
the `open-everywhere-ops` MCP server, asks you to pick a route — Vercel or Docker — and walks
whatever `--check` reports as unsatisfied.

## The minimal config

The "who can reach what" outcome is decided in **config-as-code** — versioned in your repo,
reviewed by PR. The smallest meaningful setup is:

- **One surface** — the Slack/Teams/etc. channel you wired above.
- **One bundle** — a named set of grants. Keep the `org` baseline empty of repos and
  credentials (anything bound at `org`/`tenant` reaches *every* surface under it); bind real
  grants at `surface` scope, by fully-qualified key (`"slack/T0123ABC/C0123ABC"`).
- **One env-backed credential** — a connection names a `secretRef` (an env var name); the value
  is read from the environment at runtime and never inlined in config.

Before shipping any access change, preview the resolved access and heed the warnings:

```bash
npm run access:preview -- --platform slack --workspace T_TEAM --channel C_CHANNEL
```

A `broad grant:` warning means you've made something reachable everywhere — fix it before you
go live. The full anti-footgun checklist lives in the
**[setup runbook](../deploy/setup-runbook.md)**.

## Where to go next

- **[Setup runbook](../deploy/setup-runbook.md)** — the full operational path: real workspace,
  real connectors, egress enforcement, spend caps, going live.
- **[Surface setup](../deploy/surfaces/)** — per-platform app registration and gotchas.
- **[Core concepts](./core-concepts.md)** — the vocabulary (surface, domain, bundle, grant…).
- **[Access & scoping](../how-it-works/access-and-scoping.md)** — how the resolver decides
  reach.
