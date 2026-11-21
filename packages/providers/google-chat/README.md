# @open-everywhere/provider-google-chat

Google Chat for Open Everywhere: the agent as a Google Chat app. An @mention in a space or a direct message wakes a
seat, and the seat answers in the same thread.

Part of [Open Everywhere](https://github.com/open-everywhere/open-everywhere) — an open, self-hostable autonomous
teammate you tag where your team works. This package is the Google Chat provider. It supplies the identity mapper,
the capability manifest, the post arm, the wake-origin codec, the host-notice transport and the policy schema.

`@open-everywhere/core` owns the runtime. This package holds the vendor half. The boundary between them is a
vendor-coupling one, and `packages/core/scripts/boundary-test.ts` checks it: the Google Chat fingerprints
(`chat.googleapis.com`, `GOOGLE_CHAT_SERVICE_ACCOUNT_KEY`) appear under this package and nowhere under
`packages/core/agent`.

## What it does

- A **space** is a surface. A domain lists `google-chat/<workspace>/<space id>` in its `reach`, and an @mention of the
  app in that space wakes the domain's standing seat.
- A person's **direct message** with the app wakes that person's DM seat. Only people on the policy's
  `internalDomainIds` get one.
- Every event is verified against Google's keys and the policy's audience before it is read. The surface ships off:
  until `agent/google-chat/policy.ts` enables it, the endpoint answers 503.

The operator guide is the "Google Chat" surface page of the manual (`docs/deploy/surfaces/google-chat.md`).

## Install

```sh
npm i @open-everywhere/core @open-everywhere/provider-google-chat eve@1.0.2
npx oe-eve-patch
```

**Both commands are required.** Core refuses to boot on an unpatched `eve`. A registry `eve` carries
no patch, so `npx oe-eve-patch` applies the copy `@open-everywhere/core` ships.

`eve` is a peer dependency, pinned to the exact version above, which is the pin
`@open-everywhere/core` declares as `peerDependencies.eve`. Node 24 or newer.

## License

Apache-2.0. See `LICENSE` and `NOTICE`.
