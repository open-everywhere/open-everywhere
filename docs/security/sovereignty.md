# Sovereignty: where your data lives

This page answers one question for each piece of data an Open Everywhere deployment keeps or sends:
where does it live, in which region, and which company could be compelled to hand it over? It also
names the controls that keep each piece yours, and the limits of each claim.

`npx oe sovereignty` prints the same map for **your** deployment, from its own config. See
[The report for your deployment](#the-report-for-your-deployment).
To take the data out or delete it, read [Exit and your data](./exit-and-your-data.md): `oe export`,
`oe erase` and `oe transcript delete`.

## The claim, in layers

Open Everywhere is self-hosted software, not a hosted service. No Open Everywhere vendor runs your
deployment, so no Open Everywhere vendor holds your data. That makes the claim layered: each layer
is as sovereign as the operator you choose for it.

- **You choose where the memory, the logs, the keys and the config live.** They live in your
  database, your host account and your Git repository. On Vercel, Vercel holds the runtime logs, the
  transcripts and the credential key in the project's environment. The map below names each store.
- **You hold the gateway setting.** Every model call through the model adapter goes to a target in
  `models.targets`. A route or stack role with no `via` uses the `gateway` target. Its default is the
  Vercel AI Gateway, and `models.targets.gateway.url` moves its calls to a gateway you run. Each
  target's `providers.only` names the only upstream providers that may serve a call through that
  target. One exception: a transcription route that names `via: "deepinfra"` or `"self-hosted"`
  calls that host directly, outside the gateway.
- **You choose the models.** The model family is one settings line, `models.stack`. The data policy,
  `models.dataPolicy`, demands zero retention, no training or an inference region of every call
  through the model adapter.
- **You do not hold the chat messages or the model's view of a prompt.** The chat platform keeps the
  messages people send there. The model provider sees each prompt it serves. The data policy sets
  terms for the provider; it does not move the model to you.

## The data map

"You" means you and whoever runs the machine or cloud account you deploy to. The company names state
where each operator is incorporated. A company can be compelled under the law of each country it
operates in, not only that one. This page does not give legal advice.

| Piece | On Vercel | Self-hosted (Docker) | Who could be compelled | What decides it |
| --- | --- | --- | --- | --- |
| **Compute** (the functions and the sandbox) | Vercel functions and the Vercel Sandbox | your container host | Vercel Inc. (US) / you | the deploy route; `sandbox.region` pins the Vercel Sandbox region (`packages/core/agent/settings/settings.ts`) |
| **Memory** | Postgres at `DATABASE_URL` | Postgres at `DATABASE_URL` | the database's operator (for example Neon, US) | `OE_MEMORY_PROVIDER`, else `DATABASE_URL` selects `postgres` (`packages/core/agent/memory/backing-selection.ts`) |
| **Transcripts** (every message and model step) | Vercel Workflow, eve's durable session store | `.eve/.workflow-data` on the server's disk | Vercel Inc. (US) / you | the host: eve keeps the session event stream in its workflow world ([deployment contract](../deploy/contract.md)), unless `experimental.workflow.world` in `agent/agent.ts` names another world, such as Postgres |
| **Tool-call logs** (each call's arguments and result) | the same event stream, plus one audit row per consequential act | the same | Vercel Inc. (US) and the database's operator / you and the database's operator | the session event stream (`packages/core/agent/control/read-route.ts`, the transcript route) and the audit log |
| **Run state** (in-flight turns, routines) | Vercel Workflow | `.eve/.workflow-data` | Vercel Inc. (US) / you | the host, unless `experimental.workflow.world` in `agent/agent.ts` names another world |
| **Audit** | the operational store, hash-chained | the same | the database's operator, and each SIEM you export to | `OE_OPERATIONAL_PROVIDER`, else `DATABASE_URL` (`packages/core/agent/operational/selection.ts`); `auditExport.targets` |
| **Credentials** | AES-256-GCM ciphertext in the operational store; the key `OE_CREDENTIAL_ENCRYPTION_KEY` in the project environment | the same; the key in your container's environment | the database's operator holds ciphertext; the host holds the key | `packages/core/agent/credentials/db-broker.ts` |
| **Config** | your Git repository | your Git repository | your Git host (for example GitHub, US) | a pull request ([Config-as-code](../how-it-works/config-as-code.md)) |
| **Gateway** | the Vercel AI Gateway, or your own | the same | Vercel Inc. (US), or your gateway's operator | `models.targets.<name>.url`, with the deprecated `OE_AI_GATEWAY_URL` as the `gateway` target's fallback (`packages/core/agent/model/targets.ts`, `packages/adapters/agent/model/target-url.ts`) |
| **Model route** | the upstream provider the gateway picks for each call | the same | that provider | `models.stack` (`agent/model/stacks.ts`), `models.dataPolicy` (`packages/core/agent/model/data-policy.ts`) and `models.targets` `providers.only` |
| **Transcription** (voice clips and meeting audio) | the stack's transcription role: the gateway, or a direct route | the same | the gateway's provider; DeepInfra (US) for a `deepinfra` route; your server for a `self-hosted` route | the transcription role in `agent/model/stacks.ts` (`packages/adapters/agent/model/transcription-routes.ts`); `voiceClips.enabled: false` keeps voice clips in the deployment |
| **Chat surface** | the chat platform (Slack, Teams, Discord, …) | the same | the platform's operator (for example Salesforce, Microsoft) | the roster's `providers` (`roster.config.ts`) |
| **Runtime logs** | Vercel's log store | your container's log driver | Vercel Inc. (US) / you | `OE_LOG_SHIP_URL` ships a copy (`packages/core/agent/observability/ship.ts`) |
| **Telemetry** | `oe-telemetry.vercel.app`, unless off or redirected | the same | Vercel Inc. and Neon (US), for the Open Everywhere maintainers | `OE_TELEMETRY=off` or `DO_NOT_TRACK=1`; `OE_TELEMETRY_OTLP_URL` ([Telemetry](../deploy/telemetry.md)) |
| **Other outbound calls** | the model catalog during `eve build`; eve's CLI telemetry, off in the scripts Open Everywhere ships (an app scaffolded before 0.8.0: see `packages/core/UPGRADING.md`; `oe sovereignty` reads yours) | the same | Vercel Inc. (US) | [Every default outbound call](../deploy/telemetry.md#every-default-outbound-call) |

Four rows need a closer reading:

- **Credentials on Vercel.** The project environment holds both the encryption key and the
  `DATABASE_URL` that reads the ciphertext. So Vercel alone can reach both halves. Self-hosted, the
  key stays in your own environment, and the database operator holds ciphertext only.
- **The floors.** With no `DATABASE_URL`, the operational store is embedded Postgres (PGlite) on
  local disk (`packages/core/agent/operational/selection.ts`), and memory is files under
  `.open-everywhere-memory` (`packages/core/agent/memory/store.ts`). Both deployment routes need
  Postgres, and `preflight` says so.
- **Tool-call logs.** A tool call's arguments and result ride the session event stream, not the audit
  log. The audit log records the act. The transcript records the bytes
  ([Audit & provenance](./audit-and-provenance.md)).
- **Telemetry carries no content.** Its vocabulary is closed in code, and the never-collected list is
  in [Telemetry](../deploy/telemetry.md#the-never-collected-list-verbatim).

## The report for your deployment

`npx oe sovereignty` prints the map above with your deployment's answers. It reads:

- the app's `agent/settings/settings.ts` (the stack, the data policy, the model targets
  `models.targets`, the audit export targets, the egress settings, the sandbox region);
- the app's `agent/model/stacks.ts` (each role's model id and the transcription routes) and
  `roster.config.ts` (the chat platforms);
- the app's `package.json` (whether each script that starts eve sets `EVE_TELEMETRY_DISABLED=1`)
  and `agent/agent.ts` (whether it names a workflow world);
- the app's `.env.local` over the shell environment (the stores, the deprecated `OE_AI_GATEWAY_URL`
  fallback of the `gateway` target, the telemetry switches, log shipping);
- `vercel.json`'s `regions`, `.vercel/project.json` and the Git `origin` remote.

```
npx oe sovereignty --host vercel     # or --host docker; add --json for the report object
```

Without `--host`, the report reads `VERCEL=1` or a linked `.vercel/project.json`. Without either, it
prints both hosts' answers. The ops MCP server's `sovereignty` tool returns the same report, so the
setup agent can answer the question too ([Agent-driven setup](../deploy/agent-driven-setup.md)).

The report reads config. It probes no host. It prints no secret and no part of one: of
`DATABASE_URL` it prints a recognised operator and region (Neon, AWS RDS, Supabase), never the host.
A settings file that does not load stops the report with exit 1, because a map of the shipped
defaults would describe a deployment that does not exist.

- Built by: `packages/core/agent/ops/sovereignty.ts` (the map) and
  `packages/core/agent/ops/sovereignty-facts.ts` (the reads), through the runtime's own resolution
  rules (`resolveMemoryProviderId`, `resolveOperationalSelection`, `telemetrySwitches`).
- Proved by: `npm run test:sovereignty -w @open-everywhere/core`.

## The controls, named in sovereignty terms

Each control below exists for its own reason. This section names what each one means for the
question on this page.

### The kill switch: stop, halt and spend limits

- **Stop a turn.** `/oe stop` cancels the turn that runs in the channel, with no model call
  (`packages/core/agent/channels/turn-cancel.ts`; `npm run test:turn-cancel`).
- **Halt the deployment's acts.** The break-glass halt stops every consequential act at every
  enforcement arrow, and a store it cannot read answers "halted" (`packages/core/agent/access/halt.ts`;
  `npm run test:halt`). It does not stop reading, and
  [Compliance by construction](./compliance-by-construction.md#there-is-a-break-glass-halt-and-it-fails-closed)
  states the exact reach.
- **Cap the spend.** Monthly caps per channel and per workspace refuse a turn over budget
  (`packages/core/agent/spend/check.ts`; `npm run test:spend`). `/oe budget` shows them. A cap is a
  cost guard, not a security boundary: the check fails open when the store cannot be read, an admin
  steps over a cap visibly, and the turn that crosses a cap completes (`spend/check.ts`,
  `spend/bypass.ts`).

### Egress is default-deny

The sandbox the model drives reaches only the hosts the deployment allows. A credentialed host gets
its secret at the firewall, so the secret is not in the sandbox
(`packages/core/agent/access/egress.ts`; `npm run test:egress`). The enforcement depends on the host:
[Compliance by construction](./compliance-by-construction.md#egress-is-default-deny-and-credentials-stay-out-of-the-sandbox--with-two-recorded-exceptions)
names the three things that narrow it.

### The audit log is hash-chained, and it streams to your SIEM

Every audit row stores the hash of the row before it (`packages/core/agent/audit/chain.ts`;
`npm run test:audit`). `auditExport.targets` streams the log to your SIEM, with each row's hash, so
your copy can verify the chain (`packages/core/agent/audit/siem-export.ts`;
`npm run test:audit-export`; [SIEM export](../deploy/siem-export.md)). The chain is
tamper-detectable, not publicly tamper-evident: nothing outside the deployment witnesses its head.

### Config lives in Git, and upgrades are opt-in

Behaviour lives in typed files under `agent/**` and changes by pull request. Environment holds
infrastructure only (`scripts/env-read-allowlist.ts`; `npm run lint:env-docs`). A release changes
your deployment only when you upgrade and deploy (`packages/core/scripts/oe-upgrade.ts`;
[New defaults reach a deployment only by upgrade](./compliance-by-construction.md#new-defaults-reach-a-deployment-only-by-upgrade)).

### The model is one config line

`models.stack` picks a coherent model for all five roles. Three stacks ship: `american-closed`,
`chinese-open-weights` and `european-open-weights` (`agent/model/stacks.ts`; `npm run test:model-stacks`).
A stack names weights, not a serving provider, with one exception: every role of
`european-open-weights` goes through the `mistral` target, which allows only the `mistral` provider
and demands zero retention on each call through it (OPE-2531). A declared subagent's bare model id and
eve's `evaluate()` go through the target of the role that names the id, else the primary role's
target, so they take that target too (OPE-2566;
[the European stack](../extending/models-and-gateway.md#the-european-stack)). This holds only when
`agent/model/models.ts` calls `registerBareModelRoutes`. An app scaffolded before 0.8.0 does not, so
its bare ids go through `gateway`: the process logs that once, `npm run check:model-config` exits 1
on it, and `oe sovereignty` reports every bare id via `gateway`. `oe sovereignty` names each
declared subagent with its target. Each target's `providers.only` (for example
`models.targets.gateway.providers.only`) names the providers that may serve a call through that
target, and a call that no listed provider serves refuses. Without it, that gateway's provider
allowlist decides.

### The data policy demands terms of every model call through the adapter

`models.dataPolicy` puts `zeroRetention`, `noTraining` and `region` on every model call through the
model adapter, side calls included. A call that no provider can serve under the policy fails closed.
It never falls back (`packages/adapters/agent/model/gateway.ts`; `npm run test:model-data-policy`;
[Models & the AI Gateway](../extending/models-and-gateway.md)).

Two transcription routes sit outside the adapter
(`packages/adapters/agent/model/transcription-routes.ts`). A `deepinfra` route cannot carry the rows,
so it refuses under any row. A `self-hosted` route goes to your own server, and the policy does not
apply to it.

### Nothing phones home without your switch

[Every default outbound call](../deploy/telemetry.md#every-default-outbound-call) lists each call to a
host you did not configure. Usage telemetry is on by default and carries no content; `OE_TELEMETRY=off`
turns it off. eve's own CLI telemetry is off in every script Open Everywhere ships
(`npm run lint:eve-telemetry`). The model calls themselves go to the targets in `models.targets`, and
a direct transcription route goes to its own host. Nothing turns those calls off: they are the
product's function.

## The three questions buyers ask

**"What if our models are restricted?"** Change `models.stack` in one line, or point the target's
`url` (`models.targets.gateway.url` for a route or stack role with no `via`) at a gateway that serves
the models you can still use. The limits: a route or stack role whose `via` names another target moves
only with that target's `url`, a direct transcription route does not move with the gateway, and both shipped
stacks run through an AI Gateway-compatible endpoint. A backend that is not compatible needs its own
model adapter, which is a code change ([Models & the AI Gateway](../extending/models-and-gateway.md)).

**"Does a vendor train on our data?"** No Open Everywhere vendor receives your data: telemetry carries
no content, and you can turn it off. The model provider receives each prompt. Set
`models.dataPolicy: { noTraining: true, zeroRetention: true }`, and a call goes only to a provider
that agrees to those terms, or it fails. Your gateway's own team settings can demand the same terms.

**"Is it sovereign?"** It is as sovereign as where you host it and which providers you pick. Run
`npx oe sovereignty` and read the "Who could be compelled" answers for your own deployment.

## Limits

- **Each operator answers to its own law.** A US-incorporated operator can be compelled under US law,
  wherever its region is. A region pin moves where the data is processed, not who operates it.
- **The model provider sees the prompt.** The data policy demands terms; it cannot verify that a
  provider keeps them.
- **The chat platform holds the messages.** Open Everywhere reads them through the platform's API.
  It does not move them out.
- **No certification.** Open Everywhere holds none. See
  [Compliance by construction](./compliance-by-construction.md).
- **The report reads config, not reality.** A region it prints is the one your config states. It does
  not probe a host, and a value set only on the host's dashboard is not in your `.env.local`.
