# create-open-everywhere

The install wizard for Open Everywhere.

Part of [Open Everywhere](https://github.com/open-everywhere/open-everywhere) — an open, self-hostable autonomous teammate you tag where your
team works. This package is the setup wizard. It is run, not imported.

It walks one setup engine through the steps a new instance needs — the environment file, the
credentials, the store and the first surface — and it can report on an existing instance without
touching it.

## Use

🔴 **Run it from an Open Everywhere checkout.** The wizard **configures** an instance; it does not
scaffold one. From an empty directory it reports an unsatisfied repo step and tells you how to get a
checkout — it never produces a runnable app on its own.

```sh
npm create open-everywhere
```

or:

```sh
npx create-open-everywhere
```

### Non-interactive status report

```sh
npx create-open-everywhere --check
```

`--check` prompts for nothing and changes nothing. It reports what is configured and what is
missing, which is what a scripted or agent-driven setup reads.

Node 18 or newer.

## Docs

- [Setup runbook](https://github.com/open-everywhere/open-everywhere/blob/main/docs/deploy/setup-runbook.md)
- [Documentation index](https://github.com/open-everywhere/open-everywhere/blob/main/docs/README.md)

## Status

Version 0.1.0 is the planned first public version. It is pre-1.0: the API surface is expected to
change, and a minor release may break you. Pin an exact version.

## Licence

Apache 2.0. The tarball carries `LICENSE` and `NOTICE`.
