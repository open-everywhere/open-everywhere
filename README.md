<div align="center">

# Open Everywhere

### Your team's AI chief of staff. On infrastructure you own.

An open-source AI agent that works with your team in chat, issues and docs. It runs multi-step
tasks and remembers context for each team.

[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](./LICENSE)
[![DCO](https://img.shields.io/badge/contributions-DCO-green.svg)](./CONTRIBUTING.md)

</div>

---

## Start

```bash
npm create @open-everywhere my-agent
```

Then open the new app in your coding agent and ask it to finish the setup. The app carries the
instructions, the ops MCP server and the setup skill that the agent needs. The app's `AGENTS.md`
tells the agent to ask for your consent at each command. See the
[quick start](./docs/introduction/quick-start.md).

## What stays yours

"Infrastructure you own" means the host account, the database and the Git repository that you
choose. You choose where the memory, the logs, the keys and the config live. You hold the gateway
setting, and you choose where the models run.

| What | Where it is, and what decides it | Backed in |
|---|---|---|
| **Data** | Memory, the audit log and the encrypted credentials live in the Postgres you choose. Config lives in your Git repository. Behaviour changes by pull request, and the environment holds connection strings and bootstrap credentials. No Open Everywhere vendor runs your deployment. | [data map](./docs/security/sovereignty.md#the-data-map) |
| **Models** | `models.stack` moves all five model roles in one line. Three stacks ship. `models.dataPolicy` demands zero retention, no training or an EU or US region on every call through the model adapter. A call that no provider can serve fails. | [models](./docs/security/sovereignty.md#the-model-is-one-config-line) · [data policy](./docs/extending/models-and-gateway.md) |
| **Gateway** | Each model call through the model adapter goes to a target in `models.targets`. A target's `url` points it at a gateway you run, and `providers.only` names the providers that may serve it. | [gateway](./docs/security/sovereignty.md#the-claim-in-layers) |

The limits: the model provider sees each prompt it serves, and the chat platform keeps its
messages. On Vercel, Vercel runs the compute and holds the transcripts, the logs and the credential
key. The project environment also holds `DATABASE_URL`, so Vercel alone can reach both the key and
the ciphertext. `npx oe sovereignty` prints, for your own deployment, where each piece of data lives and which
company could be compelled to hand it over.
[Your agent, your ground](./docs/introduction/your-agent-your-ground.md)

## How the parts fit

No single feature is the point. The parts work together:

1. **A member of six platforms.** It works in Slack, Microsoft Teams and Discord. In GitHub, Linear
   and Notion it also acts on the issues, pull requests and pages there. Every message resolves to
   one identity model, and `lint:surface-parity` checks each platform against one shared contract.
   [Platforms](#platforms) · [contract](./docs/extending/chat-surface-contract.md)
2. **One deployment for the whole org.** Access binds at four scopes: org, tenant, domain and
   surface. Each domain names the memory silos it uses and can bind its own credentials. Private
   surfaces and DMs stay walled off.
   [Access and scoping](./docs/how-it-works/access-and-scoping.md) · [memory](./docs/capabilities/memory.md)
3. **It proposes changes to its own access, agents and skills, and a human approves each one.** It opens a pull request to
   widen its own grants on request, to add a channel agent (`create_agent`) or to declare a webhook.
   A report reads the audit log and proposes wider grants from repeated refusals and narrower
   grants from disuse. A human merges every pull request. By default, a new skill lands only when a
   human confirms its card. Only the operator's own config can waive that card, and never on a
   tainted turn.
   [Access requests](./docs/how-it-works/access-requests.md) · [permission homeostasis](./docs/security/permission-homeostasis.md)
4. **Governance you can verify.** The rules are config in your own repository.
   `lint:human-only-invariants` fails if any agent tool imports the code that decides an approval.
   The approval judge lets an act skip the card only when it cites a pre-approval rule in your
   repository. The scaffold ships five starter rules for you to review. The audit log is
   append-only and hash-chained, and a verifier reports every broken link. No outside witness
   anchors the chain yet.
   [Security model](./docs/security/security-model.md) · [pre-approval rules](./docs/how-it-works/pre-approval-rules.md) · [audit](./docs/security/audit-and-provenance.md)
5. **Always-on routines that spend no model tokens while their condition gate says no.** The host
   evaluates a routine's condition gate before any model runs. A "no" costs one audit row and no model spend. A spend
   cap declines an over-budget fire before its session starts.
   [Routines](./docs/capabilities/proactivity-and-routines.md) · [spend](./docs/security/spend-and-cost.md)
6. **Real engineering work.** It checks out a repository, edits the code and opens a pull request
   behind an approval gate, under its own GitHub App identity. On Vercel, with the browser layer
   on (a new app from `@open-everywhere/create` turns it on; the framework default is off), it starts the dev server and checks a screenshot of the page. It
   walks a reviewer through a pull request from the diff.
   [Source control](./docs/capabilities/source-control.md) · [browser](./docs/capabilities/browser-qa.md) · [walkthroughs](./docs/capabilities/pr-walkthrough.md)
7. **Any model.** One setting, `models.stack`, switches every model role at once. Three stacks
   ship: an American closed default, a Chinese open-weights stack and a European open-weights
   stack. A live lane, `npm run e2e:stack`, checks
   which models really ran.
   [Models](./docs/extending/models-and-gateway.md)

```
@open-everywhere triage the new Sentry errors, open a PR with the fix, and post the summary here
```

## Where it runs

**Vercel with Neon Postgres is the one host that this project runs end to end.** A Docker route
is partly proven: on 0.3.0 the Docker Compose stack answered one real turn, with two open caveats,
and no test drives a turn on every change. The
[deployment contract](./docs/deploy/contract.md) states what each route has proven, and the
[hosting comparison](./docs/deploy/platforms/comparison.md) covers other hosts.

## Platforms

| Platform | Tenant | Surface (one container) | Invoke with | Guide |
|---|---|---|---|---|
| **Slack** | workspace | channel / DM | `@mention` | [slack.md](./docs/deploy/surfaces/slack.md) |
| **Microsoft Teams** | tenant | channel / chat | `@mention` | [teams.md](./docs/deploy/surfaces/teams.md) |
| **Discord** | guild (server) | channel | `@mention` (relay) or slash command | [discord.md](./docs/deploy/surfaces/discord.md) |
| **GitHub** | repository owner | repository | `@mention` on an issue or pull request | [github.md](./docs/deploy/surfaces/github.md) |
| **Linear** | organization | team | assign or mention on an issue | [linear.md](./docs/deploy/surfaces/linear.md) |
| **Notion** | workspace | page | name it in a page comment | [notion.md](./docs/deploy/surfaces/notion.md) |

The scaffold mounts Slack, Notion and GitHub. The
[support matrix](./docs/deploy/surfaces/support-matrix.md) shows which features are live-verified
on each chat platform.

## Other ways to start

- **Deploy button.** [![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https://github.com/open-everywhere/open-everywhere)
  Then add Neon from the Vercel Marketplace and follow the
  [setup runbook](./docs/deploy/setup-runbook.md).
- **From a clone.** Node 24 is required.

  ```bash
  git clone https://github.com/open-everywhere/open-everywhere
  cd open-everywhere
  npm install
  cp .env.example .env.local      # fill in AI_GATEWAY_API_KEY (or run `eve link`)
  npm run dev                     # boots the agent on http://localhost:3000
  ```

## Documentation

The full manual lives in **[docs/](./docs/README.md)**. Starting points:

| | |
|---|---|
| **Start here** | [What is Open Everywhere](./docs/introduction/what-is-open-everywhere.md) · [Quick start](./docs/introduction/quick-start.md) · [Core concepts](./docs/introduction/core-concepts.md) |
| **Understand it** | [How it works](./docs/how-it-works/access-and-scoping.md) · [Memory](./docs/capabilities/memory.md) · [Security model](./docs/security/security-model.md) |
| **Set it up** | [Setup runbook](./docs/deploy/setup-runbook.md) · [platform guides](./docs/deploy/surfaces/) · [Vercel deploy](./docs/deploy/platforms/vercel.md) |
| **Extend it** | [The adapter model](./docs/extending/adapter-model.md) · [Hosting overview](./docs/deploy/hosting-overview.md) · [Config reference](./docs/deploy/configuration-reference.md) |
| **Contribute** | [CONTRIBUTING](./CONTRIBUTING.md) · [security policy](./SECURITY.md) · [code of conduct](./CODE_OF_CONDUCT.md) · [support](./SUPPORT.md) |

## Telemetry

A running app sends anonymous usage telemetry by default. Turn it off with the setting
`telemetry: { enabled: false }` in `agent/settings/settings.ts`, or with `DO_NOT_TRACK=1` on the
deployment. The events never carry message content, memory, DM data, or a workspace, channel or user id.
[docs/deploy/telemetry.md](./docs/deploy/telemetry.md) discloses every event, and
the setting `telemetry.debug: true` prints each payload instead of sending it.
eve's own CLI telemetry is off: every npm script that runs `eve`, and the Dockerfile, set
`EVE_TELEMETRY_DISABLED=1`. The same page lists every outbound call the app makes by default.

## Status

Open Everywhere is **pre-1.0**, and a minor release can break you. The packages are on npm under
`@open-everywhere/*`. Slack and Teams answer an `@mention` on a live Vercel deployment. Discord
answers through its always-on Gateway relay.
Cloudflare, AWS, Azure and GCP hosting, and source control other than GitHub, are not built.

## Contributing

Issues and pull requests are welcome. Contributions are accepted under the
**[Developer Certificate of Origin](https://developercertificate.org/)**: sign your commits with
`git commit -s`. The pre-merge fence (`npm run deploy:merge-fence -- --pr <n>`) refuses a pull
request if any of its non-merge commits carries no `Signed-off-by: Name <email>` trailer. Start with
[CONTRIBUTING.md](./CONTRIBUTING.md).

## License

[Apache 2.0](./LICENSE). Open Everywhere is an **independent project**. It is **not affiliated with,
endorsed by, or sponsored by Anthropic, Vercel, or any platform vendor.** "Slack", "Microsoft
Teams", "Discord", "GitHub", "Linear" and "Notion" are trademarks of their respective owners. See
[NOTICE](./NOTICE).
