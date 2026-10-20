# @open-everywhere/create

<!-- HERO LINE: the maintainer decides -->

**The scaffold and setup check for Open Everywhere: an open-source AI agent that your team runs on
its own infrastructure and works with in chat, issues, docs and code.**

```sh
npm create @open-everywhere my-agent
```

Then open the new app in your coding agent and ask it to finish the setup.

## What you get

One deployment of Open Everywhere gives your org all of these together:

- **Six platforms.** Slack, Microsoft Teams, Discord, GitHub, Linear and Notion, on one identity model.
- **One deployment for the whole org.** Each domain names the memory silos it uses and can bind its own credentials.
- **Changes by pull request.** The agent proposes changes to its own grants, and a human merges each one.
- **Governance you can verify.** Rules live in your repository, and the audit log is append-only and
  hash-chained.
- **Quiet routines.** A condition gate that says no costs no model spend.
- **Engineering work.** Repository checkout, edits and pull requests behind an approval gate.
- **Any model.** One setting switches every model role, closed or open-weights.

The [project README](https://github.com/open-everywhere/open-everywhere#how-the-parts-fit) links each
part to its docs.

## What this package does

This package is run, not imported, and it does two things: it scaffolds a new app from
the quickstart template, and it reports an existing app's setup status without touching it.

**Setup itself is agent-led.** There is no interactive wizard: you open the scaffolded app in your
coding agent and ask it to set up Open Everywhere. The agent reads the app's `AGENTS.md`, drives the
`open-everywhere-ops` MCP server, and reads this command's `--check` report. The agent asks which
route first: **Vercel** (the `vercel` CLI plus Marketplace Neon) or **Docker** (a self-hosted
container that satisfies the
[deployment contract](https://github.com/open-everywhere/open-everywhere/blob/main/docs/deploy/contract.md)).
Vercel is the one route that the project runs end to end. The Docker route is partly proven: a
scaffolded app carries its `Dockerfile` and a `docker-compose.yml` with the egress proxy and Postgres,
and the
[deployment contract](https://github.com/open-everywhere/open-everywhere/blob/main/docs/deploy/contract.md)
says which requirements that stack meets.

## Use

### Start a new app

```sh
npm create @open-everywhere my-agent
```

`npx @open-everywhere/create my-agent` does the same thing: npm maps a bare scope to
`@scope/create`, so both reach this package.

This scaffolds the quickstart app into `./my-agent`, prints the next steps and exits. It never
prompts. The directory must be new or empty. A fresh clone of an empty repository holds only `.git`,
and it counts as empty: run `npx @open-everywhere/create .` inside it. The scaffold refuses a
directory that holds anything else. Run inside an empty clone named `my-agent`,
`npx @open-everywhere/create my-agent` would make `my-agent/my-agent/`, so it refuses and prints the
`.` command instead. To nest on purpose, create the inner directory first. The app depends on the ten `@open-everywhere/*` libraries at
this CLI's own version — plus this package itself, as a dev dependency, for its `check` script — and
on `eve` at the pin core declares; its `postinstall` applies the eve patch. Its roster mounts the launch surfaces: Slack, Notion and GitHub. The app carries `AGENTS.md`,
a `.mcp.json` for the `open-everywhere-ops` MCP server and the `quickstart-open-everywhere` skill,
so the agent you open it in can drive the setup.

### The status report

```sh
npx @open-everywhere/create --check
```

`--check` prompts for nothing, changes nothing, sends no telemetry and never scaffolds. It reports
each setup step with what is missing and the next command for it. Add `--json` for the same report
as one JSON object, which is what an agent-driven setup reads. `--route docker` judges against the
Docker route (the default is `vercel`), and `--host https://<host>` probes a deployment. With
`--host`, the env step also reads the deployment's public status route (`/eve/v1/oe/status`), so a
value set only on the deployment (in the Vercel dashboard, say) counts. Without it, the step reads
only `.env.local` and the shell.

Run it from inside an Open Everywhere app — a scaffolded one, or a clone of the repository. From a
directory that is not an app, it reports an unsatisfied repo step and tells you to scaffold one.

The same step list written out for a human is
[Setup steps](https://github.com/open-everywhere/open-everywhere/blob/main/docs/deploy/setup-steps.md).
That page is generated from the step list this command reports, so the two cannot drift.

This CLI starts on Node 18 or newer, so `--check` can report an old Node. The app it scaffolds needs
Node 24, so a scaffold on an older Node exits non-zero and writes nothing.

The scaffolded app sends anonymous usage telemetry when it runs, ON by default. Its `README.md`
says how to turn it off (`telemetry: { enabled: false }` in `agent/settings/settings.ts`, or
`DO_NOT_TRACK=1` on the deployment), and the full disclosure is
[Telemetry](https://github.com/open-everywhere/open-everywhere/blob/main/docs/deploy/telemetry.md).
This CLI itself sends none.

## Docs

- [Setup steps](https://github.com/open-everywhere/open-everywhere/blob/main/docs/deploy/setup-steps.md)
- [Setup runbook](https://github.com/open-everywhere/open-everywhere/blob/main/docs/deploy/setup-runbook.md)
- [Documentation index](https://github.com/open-everywhere/open-everywhere/blob/main/docs/README.md)

## Status

This package is pre-1.0: the API surface is expected to change, and a minor release may
break you. Pin an exact version.

## Licence

Apache 2.0. The tarball carries `LICENSE` and `NOTICE`.
