# create-open-everywhere

The install wizard for Open Everywhere.

Part of [Open Everywhere](https://github.com/open-everywhere/open-everywhere) — an open, self-hostable autonomous teammate you tag where your
team works. This package is the setup wizard. It is run, not imported.

It scaffolds a new app from the quickstart template. It then walks one setup engine through the
steps a new instance needs — the environment file, the credentials, the store and the first
surface — and it can report on an existing instance without touching it.

## Use

### Start a new app

```sh
npx create-open-everywhere my-agent
```

This scaffolds the quickstart app into `./my-agent` and runs the wizard from inside it. The
directory must be new or empty: the wizard refuses one that holds anything. The app depends on the
eight `@open-everywhere/*` packages at this wizard's own version, plus `eve` at the pin core
declares, and its `postinstall` applies the eve patch. Its roster mounts the launch surfaces: Slack,
Notion and GitHub. The app's own `README.md` carries the numbered steps from there to a deployed
agent that answers a Slack DM.

`--skip-wizard` scaffolds and stops. Without a terminal (a coding agent's shell, a script), the
scaffold also stops after it writes the app: it prints the next steps and exits 0, and never waits on
a prompt. The app carries `AGENTS.md`, a `.mcp.json` for the `open-everywhere-ops` MCP server and the
`quickstart-open-everywhere` skill, so an agent opened in it can drive the setup.

### Configure an existing app

Run it with no directory from inside an Open Everywhere app — a scaffolded one, or a clone of the
repository:

```sh
npx create-open-everywhere
```

The wizard **configures** the app: the environment file, the credentials, the store and the first
surface. From a directory that is not an app, it reports an unsatisfied repo step and tells you to
scaffold one.

### Non-interactive status report

```sh
npx create-open-everywhere --check
```

`--check` prompts for nothing, changes nothing and never scaffolds. It reports what is configured and
what is missing. Add `--json` to get the same report as one JSON object, which is what a scripted or
agent-driven setup reads.

The wizard starts on Node 18 or newer. The app it scaffolds needs Node 24.

## Docs

- [Setup runbook](https://github.com/open-everywhere/open-everywhere/blob/main/docs/deploy/setup-runbook.md)
- [Documentation index](https://github.com/open-everywhere/open-everywhere/blob/main/docs/README.md)

## Status

The 0.1 line is the first public release. It is pre-1.0: the API surface is expected to
change, and a minor release may break you. Pin an exact version.

## Licence

Apache 2.0. The tarball carries `LICENSE` and `NOTICE`.
