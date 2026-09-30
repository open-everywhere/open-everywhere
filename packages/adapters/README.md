# @open-everywhere/adapters

The reference Vercel-hosted backends for Open Everywhere.

Part of [Open Everywhere](https://github.com/open-everywhere/open-everywhere) — an open, self-hostable autonomous teammate you tag where your
team works. This package supplies the hosted backends the reference deployment runs on.

It implements core's host seams against concrete services:

- **AI Gateway** — model routing and the pricing the spend reports read
- **Sandbox** — the isolated workspace a turn runs its commands in
- **Blob** — file storage
- **Neon** — Postgres for the operational and memory stores
- **OpenTelemetry** — the traces and the telemetry export
- **AWS** and **Okta** — the directory and credential integrations

Core defines these seams and ships no host of its own, so a different host is a different adapters
package rather than a fork of the runtime.

## Install

```sh
npm i @open-everywhere/core @open-everywhere/adapters eve@0.54.3
npx oe-eve-patch
```

**Both commands are required.** Core refuses to boot on an unpatched `eve`. A registry `eve` carries
no patch, so `npx oe-eve-patch` applies the copy `@open-everywhere/core` ships.

`eve` and `@agent-browser/eve` are peer dependencies, pinned to exact versions. The `eve` version
above is the pin `@open-everywhere/core` declares as `peerDependencies.eve`.

`npx oe-eve-patch` applies the `eve` patch only. `@agent-browser/eve` installs unpatched, and
`@open-everywhere/core` packs no patch for it. Node 24 or newer.

## Docs

- [Hosting overview](https://github.com/open-everywhere/open-everywhere/blob/main/docs/deploy/hosting-overview.md)
- [Documentation index](https://github.com/open-everywhere/open-everywhere/blob/main/docs/README.md)

## Licence

Apache 2.0. The tarball carries `LICENSE` and `NOTICE`.
