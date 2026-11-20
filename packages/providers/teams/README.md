# @open-everywhere/provider-teams

Microsoft Teams channel and chat surfaces for Open Everywhere.

Part of [Open Everywhere](https://github.com/open-everywhere/open-everywhere) — an open, self-hostable autonomous teammate you tag where your
team works. This package is the Microsoft Teams provider. It supplies the identity mapper, the capability manifest, the post arm, the wake-origin codec, the Microsoft Graph read adapter, and the proactive routine dispatcher a Teams wake needs.

`@open-everywhere/core` owns the runtime — access and approvals, identity, memory, spend, the
audit chain. This package holds the Microsoft Teams half. The boundary between them is a vendor-coupling
one, and `packages/core/scripts/boundary-test.ts` checks it per provider: it names one or more
vendor fingerprint strings, asserts that **at least one** of them appears under this package, and
asserts that **every** one of them is absent from `packages/core/agent`. For Microsoft Teams those strings are
the hosts `graph.microsoft.com` and `smba.trafficmanager.net`. Core's registries refuse a provider the deployment has not selected.

## Install

```sh
npm i @open-everywhere/core @open-everywhere/provider-teams eve@1.0.0-rc.18
npx oe-eve-patch
```

**Both commands are required.** Core refuses to boot on an unpatched `eve`. A registry `eve` carries
no patch, so `npx oe-eve-patch` applies the copy `@open-everywhere/core` ships.

`eve` is a peer dependency, pinned to the exact version above, which is the pin
`@open-everywhere/core` declares as `peerDependencies.eve`. Node 24 or newer.

## Use

One call registers the bundle:

```ts
import { registerTeamsProvider } from "@open-everywhere/provider-teams/agent/register.js";

registerTeamsProvider();
```

Credentials, the webhook and the Microsoft Teams app setup are in the runbook below.

## Docs

- [Microsoft Teams runbook](https://github.com/open-everywhere/open-everywhere/blob/main/docs/deploy/surfaces/teams.md)
- [Documentation index](https://github.com/open-everywhere/open-everywhere/blob/main/docs/README.md)

## Licence

Apache 2.0. The tarball carries `LICENSE` and `NOTICE`.
