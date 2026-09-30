# @open-everywhere/provider-discord

Discord channel and DM surfaces for Open Everywhere.

Part of [Open Everywhere](https://github.com/open-everywhere/open-everywhere) — an open, self-hostable autonomous teammate you tag where your
team works. This package is the Discord provider. It supplies the identity mapper, the capability manifest, the post arm, the wake-origin codec, the read adapter, the reaction surface, the message operations, the approval cards, the gateway wiring and the guild-admin check.

`@open-everywhere/core` owns the runtime — access and approvals, identity, memory, spend, the
audit chain. This package holds the Discord half. The boundary between them is a vendor-coupling
one, and `packages/core/scripts/boundary-test.ts` checks it per provider: it names one or more
vendor fingerprint strings, asserts that **at least one** of them appears under this package, and
asserts that **every** one of them is absent from `packages/core/agent`. For Discord those strings are
the Bot API host `discord.com/api`. Core's registries refuse a provider the deployment has not selected.

## Install

```sh
npm i @open-everywhere/core @open-everywhere/provider-discord eve@0.54.3
npx oe-eve-patch
```

**Both commands are required.** Core refuses to boot on an unpatched `eve`. A registry `eve` carries
no patch, so `npx oe-eve-patch` applies the copy `@open-everywhere/core` ships.

`eve` is a peer dependency, pinned to the exact version above, which is the pin
`@open-everywhere/core` declares as `peerDependencies.eve`. Node 24 or newer.

## Use

One call registers the bundle:

```ts
import { registerDiscordProvider } from "@open-everywhere/provider-discord/agent/register.js";

registerDiscordProvider();
```

Credentials, the webhook and the Discord app setup are in the runbook below.

## Docs

- [Discord runbook](https://github.com/open-everywhere/open-everywhere/blob/main/docs/deploy/surfaces/discord.md)
- [Documentation index](https://github.com/open-everywhere/open-everywhere/blob/main/docs/README.md)

## Licence

Apache 2.0. The tarball carries `LICENSE` and `NOTICE`.
