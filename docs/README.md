# Open Everywhere documentation

Open Everywhere is an open, self-hostable autonomous teammate you tag where your team
works — Slack, Teams, Discord, Linear, Notion and GitHub. It runs multi-step tasks over long
horizons, remembers context per team, and asks before doing anything consequential.
It is built on [Vercel Eve](https://eve.dev) and runs on a **named model stack** through the
Vercel AI Gateway — one alias picks every role at once, and switching between a closed stack and
an open-weights one (DeepSeek V4 Flash) is one word, proven live rather than asserted. You run
it, you own the data, you pick the model.

These docs are organised top-to-bottom: read them in order for a complete mental
model, or jump straight to a section. New here? Start with
**[What is Open Everywhere](./introduction/what-is-open-everywhere.md)** and the
**[Quick start](./introduction/quick-start.md)**.

> Two ideas run through everything. **Fixed spine vs swappable seams** — Eve gives you
> an agent; Open Everywhere gives you a *governed* agent, and the governance is held
> constant on purpose while everything else is a swappable adapter. **Repo vs runtime**
> — your config lives in your git repo and deploys with it; secrets, state, and spend
> live in the operational store and change at runtime. See
> [Core concepts](./introduction/core-concepts.md) and
> [The adapter model](./extending/adapter-model.md).

## 1. Introduction

- [What is Open Everywhere](./introduction/what-is-open-everywhere.md) — the one-screen pitch and mental model.
- [Built on Eve](./introduction/built-on-eve.md) — what Eve provides and what Open Everywhere adds on top.
- [Quick start](./introduction/quick-start.md) — from deploy button to a talking agent.
- [Core concepts](./introduction/core-concepts.md) — the glossary: surface, domain, bundle, grant, silo, adapter, broker, routine.
- [Glossary](./glossary.md) — the ratified runtime vocabulary: seat vs worker, grain vs posture, taint, tier vs verdict vs judge, the scope ladder — each anchored to the code that decides it.

## 2. How it works — the fixed spine

- [The agent & the loop](./how-it-works/agent-and-loop.md) — what the agent is, how a wake/dispatch runs.
- [Access & scoping](./how-it-works/access-and-scoping.md) ★ — bundles, grants, domains, narrowest-wins. The keystone.
- [Identity](./how-it-works/identity.md) — who the agent is per surface; app- vs user-principal.
- [Config-as-code](./how-it-works/config-as-code.md) — your repo is the config; the agent edits its own via PR.
- [Access requests](./how-it-works/access-requests.md) — ask in-channel, one tap opens a bot-PR; an admin's merge is the grant.
- [Pre-approval rules](./how-it-works/pre-approval-rules.md) — admin-authored prose that tells the approval judge what your org treats as routine; per-scope, additive, and never able to remove an ask that policy code forces.

## 3. Capabilities

- [Memory](./capabilities/memory.md) — opt-in domains, silos, materialised vs pointer, the trust gate.
- [Out-of-office cover](./capabilities/out-of-office-cover.md) — while a person is away, the agent answers questions people ask them in its channels, marked as cover and from what the room already knows, and sends them one recap when they are back.
- [Your DM can ask your domains](./capabilities/domain-questions.md) — the person's DM seat asks a domain they belong to, the domain's own seat answers under its own rules, and the answer comes back to the DM.
- [Your DM can ask other bots](./capabilities/bot-delegation.md) — the person's DM asks another bot in a shared channel in the person's name, and only that bot's replies in that thread come back to the DM.
- [Roles & personas](./capabilities/roles.md) — named presets: per-turn instructions, voice, themed verbs, domain knobs.
- [Connectors & providers](./capabilities/connectors-and-providers.md) — vendors as MCP connections + scoped credentials.
- [Skills & plugins](./capabilities/skills-and-plugins.md) — the capability units the agent runs.
- [Source control](./capabilities/source-control.md) — clone, commit, bot PR with attribution.
- [PR walkthroughs](./capabilities/pr-walkthrough.md) — being walked through a change before you merge it: CI-computed facts and a separate reviewer's narration, rendered as visibly different kinds of thing, each stated with what backs it. Merges nothing.
- [The browser](./capabilities/browser-qa.md) — the agent drives declared pages, screenshots and vision-verifies its own UI work; flag-gated in-sandbox browser.
- [Personal browser](./capabilities/personal-browser.md) — each person's own browser, which keeps their logins across turns and days: driven from their DM, watched live from a private link, and taken over for a sign-in, a code or a CAPTCHA, on your own sandbox backend.
- [Voice clips](./capabilities/voice-clips.md) — a person sends a voice clip instead of typing; the agent hears it through the stack's transcription role and answers in text. Slack ships; a clip in a room that did not address the agent is never downloaded.
- [Meetings](./capabilities/meetings.md) — OE's own meeting bot: "join this meeting" with a Meet or Teams link, an approval card, a bot in a long-lived box on your own sandbox backend, and a recap with decisions and actions in the thread; or, with no bot, a recap from the Teams, Meet or Zoom meeting's own transcript.
- [Proactivity & routines](./capabilities/proactivity-and-routines.md) — scheduled and event-driven work.
- [On-call conventions](./capabilities/on-call-conventions.md) — how to write a routine that watches production: escalation as a condition gate, the lessons log as a collector, runbooks per failure class, a report template that distinguishes quiet from blind, and the emitted time-to-first-output metric.
- [Analytics](./capabilities/analytics.md) — natural-language querying of your audit, usage, and spend data, scoped to what your access allows.
- [Self-documentation](./capabilities/self-documentation.md) — the agent answers questions about itself from these docs, scoped to the bundles you actually run.

## 4. Security & governance — the trust story

- [Security model](./security/security-model.md) — the threat model and fail-closed posture. Start here to evaluate.
- [Compliance by construction](./security/compliance-by-construction.md) — the controls that hold because of how the code is built, each with the file that enforces it and the gate that proves it; and, separately, what stays yours to configure.
- [Credentials & the two planes](./security/credentials-and-planes.md) — egress firewall vs connector plane.
- [The control plane](./security/control-plane.md) — runtime admin via MCP; the override doctrine.
- [What revoke actually reaches](./security/revocation-latency.md) — per-plane revocation latency, and the lever that forces the earliest one.
- [Audit & provenance](./security/audit-and-provenance.md) — how you know what the agent did.
- [Exit and your data](./security/exit-and-your-data.md) — the org export, per-person erasure, transcript delete and the retention setting, and what each one reaches on each backing.
- [Permission homeostasis](./security/permission-homeostasis.md) — the two loops that propose widening and tightening grants from run evidence.
- [The upgrade diff fence](./security/self-upgrade-fence.md) — why a self-upgrading agent cannot edit its own guardrails, and the deployment shape it needs.
- [Spend & cost controls](./security/spend-and-cost.md) — caps, budgets, break-glass.
- [Honesty ledger](./security/honesty-ledger.md) — what the agent can never do itself, and a curated list of known limitations.

## 5. Extending — the swappable seams

- [Core / app separation](./core-app-separation.md) — the dependency direction (`eve ← core ← {adapters, provider bundles} ← app`), the config dependency-inversion pattern, and how the boundary test enforces it. Background for everything below.
- [The adapter model](./extending/adapter-model.md) — the pattern every seam below follows. Read this first.
- [Drop-in arms](./extending/drop-in-arms.md) — the decision half of the adapter model: a consumer-supplied function on a seam, with the shipped built-in as the default arm. Absence of a drop-in IS the built-in; the built-in's answer is a floor an arm cannot lower; a throwing arm falls back to the built-in. Also: state a floor exactly, because it never makes an arm harmless.
- [Provider bundles](./extending/provider-bundles.md) — the staged chat/work/connector packaging unit (OPE-114); status: all six providers extracted to `packages/providers/*`.
- [Webhook ingress](./extending/webhook-ingress.md) — every webhook is an adapter: vendor contracts vs contracts we define, the topology doctrine, what decides whether we can mint a source's secret, and the lifecycle.
- [Tools & the roster](./extending/tools.md) — one declaration (`roster.config.ts`) plus a reviewed roll-call (`roster.lock.json`), materialised into Eve's slot tree by `oe build`: how to add a tool, how to decline one with a reason, and why those two files are the capability roster whose git diff is the review surface.
- [Models & the AI Gateway](./extending/models-and-gateway.md)
- [Surfaces](./extending/surfaces.md)
- [The chat-surface contract](./extending/chat-surface-contract.md) — the generic chat verbs any provider can implement (reply, edit, react, silence, the container-fenced reads, stop and the acks), what each one must do and may refuse, and a measured audit of the six shipped providers against it.
- [Provider rate limits](./extending/provider-rate-limits.md) — a measured per-provider audit of who honours 429/`Retry-After` at each write seam, the shared backoff, and how to add it to a provider that still lacks one.
- [Memory backings](./extending/memory-backings.md)
- [Credential brokers](./extending/credential-brokers.md)
- [Sandbox](./extending/sandbox.md)
- [Connectors](./extending/connectors.md)
- [A2A agents](./extending/a2a-agents.md) — delegating a task to another organisation's agent over the Agent2Agent protocol: MCP gives the agent tools and data, A2A gives it other agents. How to declare an agent, the approval card, the host pin and the untrusted answer — and the inbound half, dark by default: the agent card another agent calls, the declared callers, and where a call lands.
- [Source-control backends](./extending/source-control-backends.md)
- [Database & operational store](./extending/database.md)
- [Scheduler & control-plane identity](./extending/scheduler-and-identity.md)
- [Testing](./extending/testing.md) — which tier a new test belongs to: script test vs integration (booted host, scripted model) vs live e2e.
- [The tidy toolchain](./dev/tidy.md) — the contributor tools that measure comment weight and prove a change touched comments only.
- [The vitest fold — plan](./dev/vitest-fold-plan.md) — the inventory of this repo's hand-rolled `*-test.ts` runners, and the staged plan for folding them into vitest.
- [The e2e fixture inventory](./dev/e2e-fixtures.md) — every room the e2e pack drives, with its live name, its env var and the domain that claims it. Generated by `npm run e2e:fixtures -- inventory`.
- [Failure families](./dev/failure-families.md) — the seven families every defect ticket classifies into, the measured red behind each one, and the decision order that picks exactly one.
- [The coverage matrix](./dev/coverage-matrix.md) — how a behaviour row in `docs/inventory/` gets a machine answer to "is this proven?": the `proves` annotations, the `n/a` declaration, the `lint:coverage-matrix` gate, and THE BOARD.
- [Evals mined from transcripts](./dev/transcript-mined-evals.md) — the recipe that turns a failed turn from a soak or e2e run into an eval case, and the per-family bench it feeds.
- Behaviour inventories — [access planes](./inventory/access-planes.md) · [audit and spend](./inventory/audit-and-spend.md) · [settings](./inventory/settings.md) · [surfaces and seats](./inventory/surfaces-and-seats.md) · [tools](./inventory/tools.md). Every behaviour the code exposes on a plane, with the manual page that documents it and the test that covers it. These are audit artefacts, not guides, so they are the one section of `docs/` the compiled manual leaves out — the agent never reads them in-context (`UNCOMPILED_DOC_SECTIONS`, `packages/core/agent/docs/source-map.ts`).
- [Publishing to npm](./dev/publishing.md) — the maintainer's release path: the publish gate, the publish preview a human reads before the first publish, one version per milestone, the 72-hour unpublish window, and why provenance waits for the public repo.

## 6. Deploy & operate

- [The deployment contract](./deploy/contract.md) — what a host must provide (Node 24, a public HTTPS URL, Postgres, a sandbox backend, egress control, a model route, two secrets, eve's durable run storage), the two supported routes and what each has proven, and the `GET /eve/v1/oe/status` route a running deployment answers them on.
- [Hosting overview](./deploy/hosting-overview.md) — a platform is a curated set of adapters.
- [Hosting comparison](./deploy/platforms/comparison.md) — Vercel vs KVM self-host vs Docker self-host vs container PaaS, capability by capability.
- Platform guides: [Vercel](./deploy/platforms/vercel.md) · [Cloudflare](./deploy/platforms/cloudflare.md) · [AWS](./deploy/platforms/aws.md) · [Azure](./deploy/platforms/azure.md) · [GCP](./deploy/platforms/gcp.md) · [Self-roll](./deploy/platforms/self-roll.md)
- [Setup runbook](./deploy/setup-runbook.md) — the full path beyond quick start.
- [Agent-driven setup](./deploy/agent-driven-setup.md) — the same path written for an agent driving the `open-everywhere-ops` MCP server from the operator's own checkout: which tool each step calls, and the five steps a vendor console reserves for a human.
- [Setup steps](./deploy/setup-steps.md) — the ordered step list a setup walks, generated from the setup engine itself so the page cannot drift from the status check; plus the expected build warnings and what "Develop locally" is for.
- [Consuming as npm packages](./deploy/consuming-as-packages.md) — run Open Everywhere from your own repo instead of a fork: the ten packages, the exact-eve peer pin (and where it does *not* trip), and why nothing runs on install.
- [Rollback, verify, record](./deploy/rollback.md) — the post-deploy health probe, one-command rollback, and the known-good pointer that makes it one hop.
- [The `oe/cloud-proof` lane](./deploy/cloud-proof.md) — a cloud sandbox proof as an alternative to a paid Actions runner: the evidence format, the verify/post scripts, the deploy gate's acceptance rule, and the trust model stated honestly.
- [Self-upgrade: the per-release migration record](./deploy/self-upgrade-release-records.md) — the machine-readable `releases/<sha>/migration.json` format: what changed, what a deployer must do, how to verify, how to roll back.
- [Graduating the operational store](./deploy/database-graduation.md) — leaving the embedded-Postgres (or legacy sqlite) floor for a Postgres server or hosted, and the one supported migration command (chain-verified).
- [Observability](./deploy/observability.md) — durable logs, traces, and error alerting: what you get bare, and the vendor-neutral seams + free-tier setup.
- [SIEM export](./deploy/siem-export.md) — stream every audit row to a SIEM (OTLP, JSON or Splunk HEC), at least once, with the hash-chain fields a receiver verifies.
- [Telemetry](./deploy/telemetry.md) — the anonymous usage telemetry Open Everywhere sends by default: every event, the never-collected list, retention, opt-out.
- Surface setup: [Slack](./deploy/surfaces/slack.md) · [Teams](./deploy/surfaces/teams.md) ([admin-centre listing](./deploy/surfaces/teams.md#listing-in-the-teams-admin-centre)) · [Discord](./deploy/surfaces/discord.md) · [Linear](./deploy/surfaces/linear.md) · [Notion](./deploy/surfaces/notion.md) · [GitHub](./deploy/surfaces/github.md) · [Email](./deploy/surfaces/email.md) · [Google Chat](./deploy/surfaces/google-chat.md)
- [Surface support matrix](./deploy/surfaces/support-matrix.md) — what works where across Slack / Teams / Discord, evidence-based, with platform limitations called out.
- [Configuration reference](./deploy/configuration-reference.md) — every config field, env var, and adapter knob.

---

Open Everywhere is **pre-1.0** and under active development. Pages describing unbuilt
work are marked **Roadmap**. The project is independent and is not affiliated with,
endorsed by, or sponsored by Anthropic, Vercel, or any chat-platform vendor.
