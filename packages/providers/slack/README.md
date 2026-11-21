# @open-everywhere/provider-slack

Slack channel and DM surfaces for Open Everywhere.

Part of [Open Everywhere](https://github.com/open-everywhere/open-everywhere) — an open, self-hostable autonomous teammate you tag where your
team works. This package is the Slack provider. It supplies the identity mapper, the capability manifest, the post arm, the wake-origin codec, the channel and DM read adapter, the reaction surface, the approval and connector cards, and the slash commands.

`@open-everywhere/core` owns the runtime — access and approvals, identity, memory, spend, the
audit chain. This package holds the Slack half. The boundary between them is a vendor-coupling
one, and `packages/core/scripts/boundary-test.ts` checks it per provider: it names one or more
vendor fingerprint strings, asserts that **at least one** of them appears under this package, and
asserts that **every** one of them is absent from `packages/core/agent`. For Slack those strings are
`SLACK_SIGNING_SECRET` and `SLACK_BOT_TOKEN`. Core's registries refuse a provider the deployment has not selected.

## Install

```sh
npm i @open-everywhere/core @open-everywhere/provider-slack eve@1.0.2
npx oe-eve-patch
```

**Both commands are required.** Core refuses to boot on an unpatched `eve`. A registry `eve` carries
no patch, so `npx oe-eve-patch` applies the copy `@open-everywhere/core` ships.

`eve` is a peer dependency, pinned to the exact version above, which is the pin
`@open-everywhere/core` declares as `peerDependencies.eve`. `undici` is a dependency. Node 24 or newer.

## Use

One call registers the bundle:

```ts
import { registerSlackProvider } from "@open-everywhere/provider-slack/agent/register.js";

registerSlackProvider();
```

Credentials, the webhook and the Slack app setup are in the runbook below.

## Docs

- [Slack runbook](https://github.com/open-everywhere/open-everywhere/blob/main/docs/deploy/surfaces/slack.md)
- [Documentation index](https://github.com/open-everywhere/open-everywhere/blob/main/docs/README.md)

## Licence

Apache 2.0. The tarball carries `LICENSE` and `NOTICE`.
