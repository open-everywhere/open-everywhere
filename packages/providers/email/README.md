# @open-everywhere/provider-email

The agent's own email address for Open Everywhere: inboxes on a domain the org controls, mail from allowed
senders in, threaded replies out.

Part of [Open Everywhere](https://github.com/open-everywhere/open-everywhere) — an open, self-hostable autonomous
teammate you tag where your team works. This package is the email provider. It supplies the identity mapper, the
capability manifest, the post arm, the wake-origin codec, the thread read adapter and the first transport recipe
(AgentMail).

`@open-everywhere/core` owns the runtime and the provider-neutral half of email: the policy
(`agent/email/policy.ts` in the app), the gate that admits or refuses each mail, the reply-recipient plan, the
body split and the `EmailTransport` port. This package holds the vendor half. The boundary between them is a
vendor-coupling one, and `packages/core/scripts/boundary-test.ts` checks it: the AgentMail fingerprints
(`api.agentmail.to`, `AGENTMAIL_API_KEY`) appear under this package and nowhere under `packages/core/agent`.

## What it does

- A **room inbox** (`launch@agent.acme.com`) is a surface. A domain lists `email/agent.acme.com/launch` in its
  `reach`, and mail to the inbox wakes that domain's standing seat.
- A **personal inbox** wakes the DM seat of the declared person who wrote (a principal whose `ids.email` names
  the address).
- Mail from anyone not allowed is refused unread and audited. Nobody gets an automatic reply.
- The agent replies in the same thread, only to people already on the thread who may receive mail from the inbox.
  There is no way to start a mail to anybody: no cold mail, no bulk mail.

The operator guide is the "Email" surface page of the manual (`docs/deploy/surfaces/email.md`).

## Install

```sh
npm i @open-everywhere/core @open-everywhere/provider-email eve@0.71.0
npx oe-eve-patch
```

**Both commands are required.** Core refuses to boot on an unpatched `eve`. A registry `eve` carries
no patch, so `npx oe-eve-patch` applies the copy `@open-everywhere/core` ships.

`eve` is a peer dependency, pinned to the exact version above, which is the pin
`@open-everywhere/core` declares as `peerDependencies.eve`. Node 24 or newer.

## License

Apache-2.0. See `LICENSE` and `NOTICE`.
