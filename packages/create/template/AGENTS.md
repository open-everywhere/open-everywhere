# AGENTS.md

This is an **Open Everywhere app**: an autonomous teammate for Slack, Notion and GitHub. The runtime
is the `@open-everywhere/*` npm packages on the `eve` agent framework. This repository holds only
the app's configuration.

## Setting it up

Setup is yours to drive, with the user's consent at every command. Use the
`quickstart-open-everywhere` skill (`.claude/skills/`) and the `open-everywhere-ops` MCP server
(`.mcp.json`).

- **Step 1 is to ask which route**: **Vercel** (the `vercel` CLI plus Marketplace Neon) or
  **Docker** (self-host against the deployment contract,
  `https://github.com/open-everywhere/open-everywhere/blob/main/docs/deploy/contract.md`). These
  are the two supported routes. Do not invent a third, and do not pick one for the user.
- **Never propose a local run as a setup step.** `npm run dev` is the development loop after the
  deploy — changing tools and skills, evals, debugging a turn. A local run has no public HTTPS URL
  for Slack to reach and a different store, so it proves little about the deployment.
- **Never ask the user to paste a secret into the chat, and never pass one to a tool.** The user
  types each secret into their own terminal with `npx oe env set <NAME>` (a hidden prompt into
  `.env.local`). You handle names only: `scaffold_env { secretNames }` gives the command per name,
  and `scaffold_credential_key` mints the store key without printing it.
- **Tell the user about telemetry before the first deploy.** The deployed app sends anonymous usage
  telemetry, and it is ON by default: event names, enums, coarse buckets, public model ids and the
  app version, with a random per-install id (`service.instance.id`). It never sends message or
  memory content, org names, workspace, channel, user or session ids, or env values. To turn it off, they declare
  `telemetry: { enabled: false }` in `agent/settings/settings.ts` and deploy, or set `DO_NOT_TRACK=1`
  on the deployment itself. The full list of events is
  `https://github.com/open-everywhere/open-everywhere/blob/main/docs/deploy/telemetry.md`. Ask which
  they want, and do not decide for them.
- `npx @open-everywhere/create --check --json` is the status report: every step, with `satisfied`,
  `detail` and a `next` command. Add `--route docker` for the Docker route and
  `--host https://<host>` to probe a deployment and read the env verdicts it reports for itself. The human-readable version of the same step list is
  `https://github.com/open-everywhere/open-everywhere/blob/main/docs/deploy/setup-steps.md`.

## Where things live

- `roster.config.ts` — what the agent can do. `roster.lock.json` is the reviewed roll-call of every
  contribution. Both are committed.
- `scripts/goldens/roster-plan.txt` — the roster review surface: one line per slot file `oe build`
  writes, with the package that mounts it. The slot tree is not committed, so this file is how a
  pull request shows what the agent gains or loses. `oe build` keeps it current, and
  `npx oe build --check` fails when it differs from the plan. Commit it, and read its diff with the
  lock's. Never edit it by hand.
- `agent/agent.ts` — the eve agent definition.
- `agent/` — the config: access bundles, identity and trust, memory domains, models, settings, spend
  caps, webhooks. Each file's header says what it controls.
- `agent/tools/`, `agent/channels/`, `agent/hooks/`, `agent/schedules/`, `agent/skills/`,
  `agent/connections/` and `agent/lib/providers.generated.ts` — `oe build` output. Never edit or
  commit them.
- `*.generated.ts` — machine-owned overlays that the agent's own approval flows write by pull
  request. Never edit them by hand. `npx oe overlays check` proves each one holds only data, and
  `npx oe overlays normalize` re-emits them after a data edit.
- `scripts/ops-mcp.ts` — the ops MCP server. `scripts/env-pipe.mjs` — `npm run -s env:pipe`, which
  pipes one `.env.local` value into `vercel env add`. Always pipe it; never run it bare.

## The pipeline

- `npm install` runs the `postinstall` script, `oe-eve-patch`. It applies the Open Everywhere patch
  to the installed `eve` and verifies it. The app refuses to boot on an unpatched `eve`.
- `npm run build` runs `oe build` (writes the slot tree from the roster), then `eve build`.
  `npm run dev` and `npm start` run `oe build` first too.
- `oe build` refuses a contribution the lock has not reviewed. Decide about it in
  `roster.config.ts`, then run `npx oe build --accept`, and review the lock diff.
- `npx oe build --check` verifies the slot tree without a write, and proves the overlays hold
  only data. Run it before you merge a pull request that changes an overlay.
- `npm run typecheck` type-checks the app.
- `npm run check:model-config` reads the list of endpoints for each model from the model's target
  (the AI Gateway, unless `models.targets` names another URL). It names a demand that no provider
  can meet, two regions that conflict, a model id the gateway does not know, and a `via` that
  names no target. Run it after a change to the model settings, before the deploy. It needs the
  network and no credential.
- `npx oe sovereignty --host vercel` (or `--host docker`) prints where each piece of the app's data
  lives, which region, and which company could be compelled to hand it over. It changes nothing.
- Deploy is a separate, explicit step. On the Vercel route that is `npx vercel deploy --prod`; a
  `git push` does NOT deploy.

## Rules

- Never commit a secret, a token, an `.env` value or a credential. Secrets go in `.env.local`
  (gitignored), and the deployment reads them from its own environment. A credential whose
  `broker` is `"db"` goes in the encrypted credential store instead (`npx oe secret set <NAME>`).
  The secret values of the Slack, Discord, GitHub and Linear surfaces are operator secrets: the
  Slack bot token and signing secret, the GitHub App private key and `LINEAR_CLIENT_SECRET`, for
  example. Store each with `npx oe secret set <NAME>`. An id or a public value (`LINEAR_CLIENT_ID`,
  `DISCORD_PUBLIC_KEY`) is not an operator secret, so do not move it to the store. The Teams app
  password and a Linear app slot's `LINEAR_APP_<SLOT>_*` values stay in the environment. Where `agent/access/connector-credentials.ts`
  names one (the Slack `work-token` and `chat-token` ids), it stamps it `broker: "db"`.
- Upgrade every `@open-everywhere/*` package together, to one version. Keep `eve` at the exact
  version `@open-everywhere/core` declares as its peer. A `devDependencies` key that still reads
  `create-open-everywhere` is replaced by `@open-everywhere/create`, not bumped: the unscoped name is
  retired. `npx oe upgrade` does that rename.
