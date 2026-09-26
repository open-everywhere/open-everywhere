# Built on Eve

**Eve is the agent engine. Open Everywhere is the governance layer on top of it.**

Open Everywhere is one [Vercel Eve](https://eve.dev) app. Eve is Vercel's agent framework —
the loop that drives the model, the chat adapters, the sandbox, the connection system, the
workflow/durability machinery, and the tool plumbing. Open Everywhere does not reinvent any of
that. Instead it adds the layer Eve deliberately leaves to you: **scoping, governance, a
team-centric memory system, multi-surface identity, and a control plane.**

## The division of labour

| Eve provides (the engine) | Open Everywhere adds (the governance) |
|---|---|
| The **agent loop** — model dispatch, tools, turns, the approval primitive | The **access resolver** + the **consequence registry** — bundles, domains, grants, narrowest-wins, default-deny, and the lint-pinned tier deciding which verbs pause for a human |
| **Chat adapters** (Slack/Teams/Discord/Linear underneath) | The **identity seam** — one `SurfaceBinding` per message; app- vs user-principal |
| The **sandbox** + network policy primitive | The **egress firewall** — default-deny hosts + credential injection at the boundary |
| The **connection system** (`defineMcpClientConnection`, etc.) | The **connector plane** — per-surface scoping the connection system has no seam for |
| **Durability** (Workflows), **scheduling** (Cron), **tracing**, **evals** | The **memory system** — opt-in domains, silos, fail-closed visibility, pluggable backings |
| `defineSandbox`, `defineSchedule`, model-as-`LanguageModel` — the swap seams | The **control plane** — runtime admin via MCP, audit/provenance, spend caps |

Put plainly: **Eve runs the agent; Open Everywhere decides what the agent is allowed to be.**

## Why build on Eve rather than reinvent

The hard, undifferentiated parts of an autonomous agent — a durable loop that survives restarts,
approval gates that cost zero compute while waiting, a sandbox with a network-policy primitive,
chat adapters for five platforms, sub-agents, tracing, evals — are exactly what Eve already
ships. Rebuilding them would be months of work that adds no governance value. By sitting on Eve,
Open Everywhere spends all of its effort on the part that *is* differentiated: the fence around
the agent. It also inherits Eve's swap seams, which is what makes Open Everywhere portable off
Vercel at all (the model, sandbox, scheduler, and durability backends are all Eve adapters).

## What Open Everywhere deliberately does *not* take from Eve

Open Everywhere keeps its **own** scoping rather than leaning on anything Eve offers, because
**Eve has no per-surface scoping seam.** Eve's connections are global to the app: the connection
system has no public per-surface filter, hooks are observe-only, and the approval context carries
no surface identity. So "this credential is usable in channel A but not channel B" is something
Eve cannot express — and it is the single most important property Open Everywhere needs.

Open Everywhere therefore owns the resolver outright (`packages/core/agent/access/`), and the
connector plane self-scopes by reading the inbound surface identity and refusing an ungranted
surface *before any credential resolves* — quarantined to one file and pinned by a contract test
so an Eve upgrade can never silently degrade it.

This is the **fixed spine vs swappable seams** framing in one sentence: the governance (resolver,
egress firewall, two credential planes, audit) is the fixed spine
Open Everywhere holds constant; the engine underneath (model, sandbox, scheduler, durability,
even the surfaces) is a set of swappable Eve seams.

## Honest about the seams

Building on Eve means inheriting Eve's edges, and the docs name them rather than hand-wave:

- Per-surface connection scoping is an Eve gap Open Everywhere works around with an internal seam
  (pinned by a contract test; an upstream request to make it public is on file).
- Configuration is snapshotted at session start — a running session keeps the connections and
  instructions it began with.
- Adapter APIs in Eve are beta and may shift before GA.

These are stated where they matter so the trust story stays honest. See
**[Access & scoping](../how-it-works/access-and-scoping.md)** for the resolver and
**[Credentials & the two planes](../security/credentials-and-planes.md)** for the egress vs
connector split.
