# @open-everywhere/create

The scaffold and setup check for Open Everywhere.

Part of [Open Everywhere](https://github.com/open-everywhere/open-everywhere) — an open, self-hostable autonomous teammate you tag where your
team works. This package is run, not imported, and it does two things: it scaffolds a new app from
the quickstart template, and it reports an existing app's setup status without touching it.

**Setup itself is agent-led.** There is no interactive wizard: you open the scaffolded app in your
coding agent and ask it to set up Open Everywhere. The agent reads the app's `AGENTS.md`, drives the
`open-everywhere-ops` MCP server, and reads this command's `--check` report. Two routes are
supported, and the agent asks which first: **Vercel** (the `vercel` CLI plus Marketplace Neon) or
**Docker** (a self-hosted container that satisfies the
[deployment contract](https://github.com/open-everywhere/open-everywhere/blob/main/docs/deploy/contract.md)).

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
`.` command instead. To nest on purpose, create the inner directory first. The app depends on the eight `@open-everywhere/*` libraries at
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
says how to turn it off (`OE_TELEMETRY=off` on the deployment), and the full disclosure is
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
