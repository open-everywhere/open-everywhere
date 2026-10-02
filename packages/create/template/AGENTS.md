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
- **Never ask the user to paste a secret into the chat.** They paste it where a tool reads it; you
  write it with `scaffold_env`, or mint it with `scaffold_credential_key`, which never prints it.
- `npx @open-everywhere/create --check --json` is the status report: every step, with `satisfied`,
  `detail` and a `next` command. Add `--route docker` for the Docker route and
  `--host https://<host>` to probe a deployment. The human-readable version of the same step list is
  `https://github.com/open-everywhere/open-everywhere/blob/main/docs/deploy/setup-steps.md`.

## Where things live

- `roster.config.ts` — what the agent can do. `roster.lock.json` is the reviewed roll-call of every
  contribution. Both are committed.
- `agent/agent.ts` — the eve agent definition.
- `agent/` — the config: access bundles, identity and trust, memory domains, models, settings, spend
  caps, webhooks. Each file's header says what it controls.
- `agent/tools/`, `agent/channels/`, `agent/hooks/`, `agent/schedules/`, `agent/skills/`,
  `agent/connections/` and `agent/lib/providers.generated.ts` — `oe build` output. Never edit or
  commit them.
- `*.generated.ts` — machine-owned overlays that the agent's own approval flows write by pull
  request. Never edit them by hand.
- `scripts/ops-mcp.ts` — the ops MCP server. `scripts/env-pipe.mjs` — `npm run -s env:pipe`, which
  pipes one `.env.local` value into `vercel env add`. Always pipe it; never run it bare.

## The pipeline

- `npm install` runs the `postinstall` script, `oe-eve-patch`. It applies the Open Everywhere patch
  to the installed `eve` and verifies it. The app refuses to boot on an unpatched `eve`.
- `npm run build` runs `oe build` (writes the slot tree from the roster), then `eve build`.
  `npm run dev` and `npm start` run `oe build` first too.
- `oe build` refuses a contribution the lock has not reviewed. Decide about it in
  `roster.config.ts`, then run `npx oe build --accept`, and review the lock diff.
- `npm run typecheck` type-checks the app.
- Deploy is a separate, explicit step. On the Vercel route that is `npx vercel deploy --prod`; a
  `git push` does NOT deploy.

## Rules

- Never commit a secret, a token, an `.env` value or a credential. Secrets go in `.env.local`
  (gitignored), and the deployment reads them from its own environment. A credential whose
  `broker` is `"db"` goes in the encrypted credential store instead (`npx oe secret set <NAME>`).
- Upgrade every `@open-everywhere/*` package together, to one version. Keep `eve` at the exact
  version `@open-everywhere/core` declares as its peer. A `devDependencies` key that still reads
  `create-open-everywhere` is replaced by `@open-everywhere/create`, not bumped: the unscoped name is
  retired. `npx oe upgrade` does that rename.
