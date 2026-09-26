<div align="center">

# Open Everywhere

**An autonomous teammate you tag in your chat tools — you pick the model stack, open or closed.**

Message it in Slack, Teams, Discord, or Linear — it runs multi-step tasks over long
horizons, remembers context per team, and asks before it does anything consequential.

[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](./LICENSE)
[![DCO](https://img.shields.io/badge/contributions-DCO-green.svg)](./CONTRIBUTING.md)

</div>

---

Open Everywhere is an open, self-hostable take on Anthropic's **Claude Tag** — the tag-the-bot-in-a-channel
teammate — built on **[Vercel Eve](https://eve.dev)** and run on a **named model stack** through the
Vercel AI Gateway. You run it. You own the data. **You pick the model** — the model layer is a
real market now, not one vendor's monopoly, and switching stacks, closed to open-weights or back,
is one word away and proven by a live test lane rather than asserted.

```
@open-everywhere triage the new Sentry errors, open a PR with the fix, and post the summary here
```

## Why

- **Model choice, not frontier lock-in.** Every model this deployment runs comes from a **named
  stack** (`agent/model/stacks.ts`) — one alias fills all five roles coherently, and switching is a
  one-word change. Two ship: `american-closed` (the default) and `chinese-open-weights`, whose
  cost is what makes always-on ambient surfaces affordable to leave running, and whose weights
  mean leaving the gateway entirely is a migration rather than a rewrite. The switch is
  **lane-proven, not asserted**: `npm run e2e:stack -- <alias>` runs live scenarios against a stack
  and checks, from the deployment's own usage rows, that those were the models that ran.
- **Your infrastructure, your data.** One-click deploy to Vercel + Neon is the ✅ supported,
  run-end-to-end path; a Docker/VM self-host is 📋 documented and community-verifiable
  (Eve's own framework docs cover it first-party) but not yet run by this project — see the
  [hosting matrix](./docs/deploy/platforms/comparison.md) for the honest breakdown, including
  what a coarse-egress self-host gives up. Memory lives in *your* store; DMs never leave it.
- **Security is the product, not an afterthought.** Default-deny egress with credential injection at the
  firewall (secrets never enter the sandbox), per-surface access scoping, fail-closed memory visibility, and
  an append-only audit log. See **[the security model](./docs/security/security-model.md)**.
- **Multiplayer by design.** A tiered memory model (a shared workspace brain + isolated per-silo memory) so
  one agent can serve many teams without cross-contaminating them.

## Surfaces

Tag it where your team already works. Each surface maps onto the same **memory model** — opt-in
domains with isolated, per-silo memory (see [memory](./docs/capabilities/memory.md)):

| Surface | Scope | Silo | Invoke with | Guide |
|---|---|---|---|---|
| **Slack** | workspace | channel / DM | `@mention` | [slack.md](./docs/deploy/surfaces/slack.md) |
| **Microsoft Teams** | tenant | channel / chat | `@mention` | [teams.md](./docs/deploy/surfaces/teams.md) |
| **Discord** | guild (server) | channel | **slash command** | [discord.md](./docs/deploy/surfaces/discord.md) |
| **Linear** | organization | team | assign / mention on an issue | [linear.md](./docs/deploy/surfaces/linear.md) |

Adding a surface is one identity mapper + one channel — the whole system keys off a single
platform-agnostic `SurfaceBinding`.

## Quickstart

### Deploy to Vercel (easiest path)

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https://github.com/open-everywhere/open-everywhere)

1. **Click the button.** It clones the repo into your GitHub and creates a Vercel project.
2. **Add a database.** From the Vercel dashboard → Storage → add **Neon** (Postgres) from the Marketplace.
   The connection string is injected automatically. Set `OE_MEMORY_PROVIDER=postgres` and
   `OE_OPERATIONAL_PROVIDER=postgres` (Vercel's filesystem is ephemeral — see the
   [setup runbook](./docs/deploy/setup-runbook.md)).
3. **Model auth is automatic.** On a linked Vercel project the AI Gateway uses OIDC — no key needed.
4. **Connect a surface.** The one manual step: create a Slack/Teams/Discord/Linear app and paste its
   secrets (app creation is inherently interactive). Follow the [surface guide](#surfaces) for your platform.

Full deploy walkthrough: **[the Vercel guide](./docs/deploy/platforms/vercel.md)** and the
**[setup runbook](./docs/deploy/setup-runbook.md)**.

### Run locally

**Requires Node 24.x** (`nvm use 24` — matched to `package.json` engines and CI). On Node 22 `npm install`
only warns, then you hit runtime failures.

```bash
git clone https://github.com/open-everywhere/open-everywhere
cd open-everywhere
npm install
cp .env.example .env.local      # fill in AI_GATEWAY_API_KEY (or run `eve link`)
npm run dev                     # eve dev — boots the agent on http://localhost:3000
npm test                        # deterministic unit/integration suites (no live model)
```

Prefer to let an agent set it up for you? The repo ships an **ops MCP server** (`open-everywhere-ops`) and a
`quickstart-open-everywhere` skill — clone, boot Claude Code in the checkout, and say
*"get Open Everywhere running locally."*

### Self-host (Docker / any VM)

Vercel is the only ✅ supported, run-end-to-end deploy. Self-hosting off Vercel is
📋 **documented and community-verifiable, not (yet) supported**: Eve itself documents
`eve build && PORT=3000 eve start --host 0.0.0.0` as a plain Node service you can run
behind your own reverse proxy, but Open Everywhere's own adapters haven't been
smoke-tested on that path. Start with the [hosting comparison](./docs/deploy/platforms/comparison.md)
(the honest tier-by-tier matrix, including the egress-firewall trade-off a coarse
self-host makes) and [self-roll](./docs/deploy/platforms/self-roll.md) (the seam-by-seam
contract). If you self-host and verify it, that's exactly the community verification
those pages are asking for.

## How it works

- **Stack.** Vercel Eve (agent framework + chat adapters + sandbox + workflows) → Vercel AI Gateway →
  whichever **model stack** you named. One Vercel app; no separate dashboard.
- **Memory.** Tiered and agent-centric: a **workspace** brain shared across surfaces + an isolated
  **surface** silo per channel/team. Public surfaces contribute up; private surfaces and DMs stay
  walled (fail-closed). Pluggable backend (`git` → `sqlite` → Neon Postgres with RLS + pgvector).
- **Identity & access.** Every message resolves to one `SurfaceBinding`; capability **bundles**
  (config-as-code) grant narrowly, the resolver is deterministic narrowest-wins/no-fallback, and egress is
  default-deny.
- **Proactivity.** Durable, surface-owned **routines** (scheduled / watch / event) created in-thread, with
  spend caps and self-disabling on repeated failure.
- **Reliability.** Semi-autonomous with `needsApproval` human gates on consequential or outward actions —
  governance, not model-weakness compensation.
- **Management is MCP, not a web UI.** Two role-split MCP servers (a local ops/deploy plane and a remote
  runtime-admin plane with OAuth + RBAC) drive everything a dashboard would.

How it's governed, the fixed-spine-vs-swappable-seams model, and self-hosting:
**[the documentation](./docs/README.md)**.

## Documentation

The full manual lives in **[docs/](./docs/README.md)**. Starting points:

| | |
|---|---|
| **Start here** | [What is Open Everywhere](./docs/introduction/what-is-open-everywhere.md) · [Quick start](./docs/introduction/quick-start.md) · [Core concepts](./docs/introduction/core-concepts.md) |
| **Understand it** | [How it works](./docs/how-it-works/access-and-scoping.md) · [Memory](./docs/capabilities/memory.md) · [Security model](./docs/security/security-model.md) |
| **Set it up** | [Setup runbook](./docs/deploy/setup-runbook.md) · [surface guides](./docs/deploy/surfaces/) · [Vercel deploy](./docs/deploy/platforms/vercel.md) |
| **Extend it** | [The adapter model](./docs/extending/adapter-model.md) · [Hosting overview](./docs/deploy/hosting-overview.md) · [Config reference](./docs/deploy/configuration-reference.md) |
| **Contribute** | [CONTRIBUTING](./CONTRIBUTING.md) · [security policy](./SECURITY.md) · [code of conduct](./CODE_OF_CONDUCT.md) · [support](./SUPPORT.md) |

## Telemetry

Open Everywhere sends anonymous usage telemetry by default — **opt out with `OE_TELEMETRY=off`
or `DO_NOT_TRACK=1`, no restart tricks, no residual calls.** It's a closed, 6-event
vocabulary (install/heartbeat/turn-outcome/error-class/feature-used — never message
content, memory, DM data, ids, or precise counts), disclosed in full — including a
`OE_TELEMETRY_DEBUG=1` mode that prints every payload instead of sending it — at
**[docs/deploy/telemetry.md](./docs/deploy/telemetry.md)**.

## Status

Open Everywhere is **pre-1.0** and under active development. The agent, memory tiers, identity/access,
proactivity, connector plane, source-control plane, and admin MCP are built and unit-/integration-tested
against real Eve; the first live end-to-end boot (model + a real surface app + Neon) is the current milestone.
Non-Vercel hosting isn't uniformly unbuilt: a Docker/VM self-host is documented and
community-verifiable (see the [hosting matrix](./docs/deploy/platforms/comparison.md)),
while Cloudflare/AWS/Azure/GCP and non-GitHub source control remain genuinely unbuilt and
are marked **Roadmap**.

## Contributing

Issues and PRs welcome. Contributions are accepted under the **[Developer Certificate of Origin](https://developercertificate.org/)** —
sign your commits with `git commit -s`. The pre-merge fence (`npm run deploy:merge-fence -- --pr <n>`)
refuses a PR whose commits carry no `Signed-off-by:` trailer. Start with
[CONTRIBUTING.md](./CONTRIBUTING.md).

## License

[Apache 2.0](./LICENSE). Open Everywhere is an **independent project** and is **not affiliated with,
endorsed by, or sponsored by Anthropic, Vercel, or any chat-platform vendor.** "Claude" and "Claude Tag" are
trademarks of Anthropic; "Slack", "Microsoft Teams", "Discord", and "Linear" are trademarks of
their respective owners. See [NOTICE](./NOTICE).
