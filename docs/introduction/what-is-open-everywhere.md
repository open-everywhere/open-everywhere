# What is Open Everywhere

**An open, self-hostable autonomous teammate you tag in your chat tools — governed by config in your own git repo.**

Open Everywhere is an autonomous agent that lives where your team already works — Slack,
Microsoft Teams, Discord, Linear, Notion or GitHub. You `@mention` it (or assign it an issue, or
fire a slash command) and it runs multi-step tasks over long horizons: triage the new errors,
open a PR with the fix, post the summary back in the thread. It remembers context per team,
and it asks before it does anything consequential.

It is built on **[Vercel Eve](./built-on-eve.md)** (the agent framework) and runs on a **named
model stack** through the Vercel AI Gateway — the model layer is a genuine market now, not one
vendor's monopoly, and Open Everywhere is the harness built to actually use it: the same
deployment has run green end-to-end on an all-closed stack and an all-open-weights one (DeepSeek V4
Flash), a config flip apart. You run it. You own the data. You pick the model. One-click deploy
to Vercel + Neon, or self-host the whole thing. Apache-2.0 licensed, and an independent project —
not affiliated with Anthropic, Vercel, or any chat vendor.

```
@open-everywhere triage the new Sentry errors, open a PR with the fix, and post the summary here
```

## The mental model in three sentences

Everything in Open Everywhere hangs off three layers. If you hold these three, the rest of the
docs are detail:

1. **Surfaces — where it talks.** A surface is a platform the agent listens on. Six ship:
   Slack, Teams, Discord, Linear, Notion and GitHub. The agent talks on all six; Linear,
   Notion and GitHub also act on the vendor's own objects (an issue, a page). Every
   inbound message resolves to one
   platform-agnostic identity, so the agent core behaves identically everywhere and adding a
   platform is one small mapper.
2. **Domains & bundles — what it's allowed to reach.** A *domain* groups the channels that
   share one memory; an access *bundle* is a named set of credentials, repos, reachable hosts,
   connectors, and standing instructions. Bundles bind to scopes (`org` → `tenant` →
   `domain` → `surface`) and a deterministic resolver computes exactly what one session may
   touch — **narrowest-wins, default-deny, no fallback**.
3. **Memory, connectors & skills — what it knows and can do.** Per-team *memory* (opt-in, with
   a pluggable backing), *connectors* (host-side integrations like Notion or Linear), and
   *skills/plugins* (packaged know-how) give the agent its long-term context and its hands.

## Why "governed" is the headline

An autonomous agent that holds your credentials and acts in your tools is only as good as the
fence around it. Open Everywhere's whole reason to exist is that fence. Eve gives you *an*
agent; Open Everywhere gives you a **governed** agent:

- **Per-surface access scoping.** A grant in channel A does not leak to channel B. The resolver
  is deterministic and additive-only for capabilities, narrowest-wins for credentials.
- **Default-deny egress with credential injection at the firewall.** Secrets are stamped into
  requests at the network boundary — they never enter the sandbox the model runs in.
- **Fail-closed everywhere.** Unknown trust, unconfirmed visibility, an ungranted host: the
  safe answer is "no", computed before any secret is resolved.
- **An append-only audit trail + git/deploy provenance.** You can see what it did and why it was
  allowed to.

This governance is the **fixed spine** of the product — held constant on purpose. Almost
everything else (the model, the surfaces, the memory backing, the credential broker, the
sandbox, even the hosting platform) is a **swappable seam**. "Here's what you can swap, here's
what we hold fixed and why" is the trust story, not a limitation.

## Who it's for, and what it replaces

It's for teams who want a tag-the-bot-in-a-channel teammate but on **their own infrastructure,
their own data, and a model they choose** — rather than a closed SaaS bot tied to one vendor's
frontier model and billing. If you've wanted something like an in-channel AI teammate but
needed it self-hosted, scoped to your security posture, and free of frontier lock-in, that's
the gap Open Everywhere fills.

## Where to go next

- **[Quick start](./quick-start.md)** — the fast path to a talking agent: deploy
  button → live agent answering in a channel.
- **[Core concepts](./core-concepts.md)** — the glossary. Every term above, defined once, each
  linking to its deep page.
- **[Access & scoping](../how-it-works/access-and-scoping.md)** — the keystone. How bundles,
  domains, grants, and narrowest-wins resolution actually decide who can reach what.
- **[Built on Eve](./built-on-eve.md)** — the division of labour: what Eve provides and what
  Open Everywhere adds on top.
