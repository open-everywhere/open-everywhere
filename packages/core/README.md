# @open-everywhere/core

The portable, host-agnostic agent runtime behind Open Everywhere.

Part of [Open Everywhere](https://github.com/open-everywhere/open-everywhere) — an open, self-hostable autonomous teammate you tag where your
team works. This package is the runtime every deployment loads.

Core owns the parts that do not depend on a chat platform or a host:

- **access and approvals** — the tool consequence table, window and work-grant planes, approval cards
- **identity** — principals, seats and the member planes
- **memory** — per-team stores over git, SQLite, Postgres, GitHub or Notion
- **spend** — the ingress spend gate and the cost reports
- **routines and webhooks** — scheduled and event-driven wakes
- **connectors** — host-side connections whose token is attached outside the sandbox
- **the audit chain** — one row per decision, and the control-plane read route over it
- **the `oe` roster build** — `oe build` compiles `roster.config.ts` into the generated tables

Each chat surface ships as a separate `@open-everywhere/provider-*` package, and core's registries
refuse a provider this deployment has not selected. The boundary is a vendor-coupling one, checked
per provider by `packages/core/scripts/boundary-test.ts`: it names one or more vendor fingerprint
strings — a host literal, a credential env key or a signature header — then asserts that **at least
one** of them appears under that provider's package, and that **every** one of them is absent from
`packages/core/agent`.

It is **not** a rule that core never mentions a platform, and some vendor surface is core's on
purpose: the source-control plane calls `api.github.com` from core, and the spend plane renders
Slack's own shortcodes.

## Install

```sh
npm i @open-everywhere/core eve@0.54.3
npx oe-eve-patch
```

**Both commands are required.** Core refuses to boot on an unpatched `eve`. It reads one runtime
marker for each patch part before the first wake is served, and it throws when a marker is missing.
A registry `eve` carries no patch, so `npx oe-eve-patch` applies the copy in this tarball. The
applier is idempotent: a second run on a patched tree changes nothing and exits 0.

`eve` is a peer dependency, and the version above is the pin this package declares as
`peerDependencies.eve`. Install that exact version yourself. npm can still nest a second `eve` for a
package that asks for another version. `oe-eve-patch` patches only the copy at
`<project root>/node_modules/eve`, and the boot check reads only the copy core itself resolves. A
nested copy is therefore neither patched nor checked, so one resolved, pinned `eve` is your own
step — run `npm ls eve` and confirm it prints one version. Node 24 or newer.

## Bins

- `oe` — the roster build and the operator commands
- `oe-eve-patch` — applies the `eve` patch this version pins, which a registry install of `eve`
  does not carry. It is a required install step, not an optional tool: see § Install.

## Docs

- [Documentation index](https://github.com/open-everywhere/open-everywhere/blob/main/docs/README.md)
- [Consuming Open Everywhere as packages](https://github.com/open-everywhere/open-everywhere/blob/main/docs/deploy/consuming-as-packages.md)

## Status

The 0.1 line is the first public release. It is pre-1.0: the API surface is expected to
change, and a minor release may break you. Pin an exact version.

## Licence

Apache 2.0. The tarball carries `LICENSE` and `NOTICE`.
