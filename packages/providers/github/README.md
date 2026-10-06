# @open-everywhere/provider-github

GitHub issues and pull requests as a wake surface for Open Everywhere.

Part of [Open Everywhere](https://github.com/open-everywhere/open-everywhere) — an open, self-hostable autonomous teammate you tag where your
team works. This package is the GitHub provider. It supplies the identity mapper, the capability manifest, the post arm, the wake-origin codec, the timeline read adapter, the reaction feedback arm and the App installation lifecycle.

`@open-everywhere/core` owns the runtime — access and approvals, identity, memory, spend, the
audit chain. This package holds the GitHub half. The boundary between them is a vendor-coupling
one, and `packages/core/scripts/boundary-test.ts` checks it per provider: it names one or more
vendor fingerprint strings, asserts that **at least one** of them appears under this package, and
asserts that **every** one of them is absent from `packages/core/agent`. For GitHub those strings are
the webhook signature header `x-hub-signature-256`. Core's registries refuse a provider the deployment has not selected.

This package is the GitHub **chat surface** only. The source-control plane stays in core and uses
`api.github.com` and the GitHub App credentials from there, which is why the fingerprint above is the
webhook signature header rather than the API host.

## Install

```sh
npm i @open-everywhere/core @open-everywhere/provider-github eve@0.71.0
npx oe-eve-patch
```

**Both commands are required.** Core refuses to boot on an unpatched `eve`. A registry `eve` carries
no patch, so `npx oe-eve-patch` applies the copy `@open-everywhere/core` ships.

`eve` is a peer dependency, pinned to the exact version above, which is the pin
`@open-everywhere/core` declares as `peerDependencies.eve`. Node 24 or newer.

## Use

One call registers the bundle:

```ts
import { registerGithubProvider } from "@open-everywhere/provider-github/agent/register.js";

registerGithubProvider();
```

Credentials, the webhook and the GitHub app setup are in the runbook below.

## Docs

- [GitHub runbook](https://github.com/open-everywhere/open-everywhere/blob/main/docs/deploy/surfaces/github.md)
- [Documentation index](https://github.com/open-everywhere/open-everywhere/blob/main/docs/README.md)

## Licence

Apache 2.0. The tarball carries `LICENSE` and `NOTICE`.
