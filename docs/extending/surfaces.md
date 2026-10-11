# Surfaces

A **surface** is a place the agent talks — Slack, Teams, Discord, Linear. Each
surface is an Eve channel plus an Open Everywhere identity binding. Adding a surface is an
[adapter-shaped](./adapter-model.md) extension; this page is the *seam shape*. For per-surface
install and config, see the [surface setup guides](../deploy/surfaces/slack.md). For what the
agent's verbs *mean* on a surface — what `reply`, `react`, the reads and `stop` must do, may refuse
and how they report — see [the chat-surface contract](./chat-surface-contract.md).

> **This page is the *communication*-surface contract.** A place the agent talks needs a channel
> wrap and an identity binding, and nothing on this page assumes more. A **work surface** — a
> ticketing or document system that emits events about *things*, like GitHub, Linear or Notion —
> needs all of the above only if it also carries conversation, **plus** the event-ingress plane:
> a signature verifier, an event normalizer and an event scope grant. That contract is
> [Webhook ingress](./webhook-ingress.md#2-topology-how-many-hooks-and-where), and the taxonomy
> there predicts which one you are writing before you open the vendor's docs.

> Every surface shipped today lives in its own installable
> [provider bundle](./provider-bundles.md) under `packages/providers/<name>/` — Slack, Teams,
> Discord, Linear, GitHub, Notion and Email. Each bundle registers itself through core's
> identity/capability/post/read seams from its own `agent/register.ts`. Core holds no surface's
> channel wrap and no surface's identity binding; it keeps only the two bridges it calls back
> through (`packages/core/agent/channels/slack-bridge.ts` and `teams-bridge.ts`).

## How a surface plugs in

Surfaces ride on Eve's **channel** system (which uses the Chat SDK underneath for messaging).
Eve auto-discovers a channel from the files in the app's `agent/channels/*`; it ships
Slack, Discord, Teams, and Linear (plus Twilio SMS/WhatsApp), and a generic
`defineChannel` for anything else. That app directory is **build output**: `npm run oe:build`
writes it from each package's `contributions.ts`, and `.gitignore` excludes it. Never author a
channel there — write it in a bundle and let the build render the stub. Surfaces are **additive**
— you add a platform, you don't swap one for another.

Each Open Everywhere surface is two parts, both authored in its provider bundle:

1. **The channel wrap** (`packages/providers/<surface>/agent/channels/<surface>.ts`) — wires the
   platform's webhook to an Open Everywhere session. For example, the Slack surface overrides
   `onAppMention` / `onDirectMessage` to attach richer auth than Eve's default.
2. **The identity binding** (`packages/providers/<surface>/agent/channels/<surface>-identity.ts`) — the
   **security-load-bearing** part. It captures raw webhook facts (workspace/channel/user ids,
   channel type, private/external flags) and the binding layer interprets them into the
   `partition`, `mode` (channel / dm / mpim), and `visibility` (public / private), **fail-closed**:
   an undetermined private-or-external flag resolves to the *tighter* answer, never the looser
   one. See [identity](../how-it-works/identity.md).

Everything downstream — memory partition, [access resolver](../how-it-works/access-and-scoping.md),
routine dispatch — keys off that resolved identity with no further change. The binding is the
one place each surface's "is this private / external?" decision lives, so it's unit-tested in
isolation.

## The platform-agnostic shape

Because the binding produces a uniform `(partition, mode, visibility)` triple regardless of
platform, the rest of Open Everywhere is **surface-agnostic**. The resolver, memory, spend,
audit, and control-plane views all consume that triple, never a Slack- or Discord-specific
field. That's what lets the same bundle govern the agent across every surface at once.

## Adding your own surface

Author the surface in its own bundle, `packages/providers/<x>/`, then mount it through the roster:

1. **Write the two files.** The channel wrap
   (`packages/providers/<x>/agent/channels/<x>.ts`) and the identity adapter
   (`packages/providers/<x>/agent/channels/<x>-identity.ts`), which maps the platform's raw facts
   to the binding inputs, fail-closed. For a platform Eve does not support, also build the
   transport with Eve's generic `defineChannel`, then add the same identity adapter on top.
2. **Register the seams** from the bundle's `agent/register.ts` — at least
   `registerIdentityMapper("<x>", bind<X>)` and `registerCapabilityManifest("<x>", …)`, both from
   the [adapter-api barrel](./adapter-model.md#import-the-ports-from-one-door-the-adapter-api-barrel).
   Read `packages/providers/slack/agent/register.ts` for the full seam set a shipped surface fills.
3. **Declare the channel** in the bundle's `agent/contributions.ts`:
   `{ kind: "channel", name: "<x>", module: "agent/channels/<x>.js" }`.
4. **Mount the bundle** in `roster.config.ts`, run `npx oe build --accept`, and commit
   `roster.lock.json`. The build writes the app's `agent/channels/<x>.ts` stub. See
   [tools & the roster](./tools.md).

The identity adapter is the part you must get right — it's where the trust boundary is drawn.
Lean on the seven shipped `packages/providers/<name>/agent/channels/<name>-identity.ts` files as
templates: capture raw facts only, and leave the private/external interpretation to the shared
binding layer.

## A surface with no eve channel: email

Email (`packages/providers/email`) is the worked example of a surface eve does not ship. Its channel is a
generic `defineChannel` route (`POST /eve/v1/email`), and everything a chat surface gets from eve's adapter it
builds from core's seams instead: a pure front (verify, parse, dedupe, gate, seat route) in
`email-front.ts`, the shared inbound divert into a domain's standing seat or a person's DM seat, and a post arm
whose one verb is the reply. The vendor sits behind a second, smaller port in core (`email/transport.ts`), so the
surface is provider-neutral and a new mail service is one more transport, not a new surface. See
[Email](../deploy/surfaces/email.md).

## On Vercel / Off Vercel

- **On Vercel:** Eve's channels run as part of the deployed agent with no extra infrastructure;
  webhooks land on your Vercel functions. Each shipped surface (Slack/Teams/Discord/
  Linear) is configured per the [surface setup guides](../deploy/surfaces/slack.md).
- **Off Vercel:** surfaces are pure Eve channels with no Vercel dependency, so they work
  anywhere Eve runs — you just point each platform's webhook at your own host.
