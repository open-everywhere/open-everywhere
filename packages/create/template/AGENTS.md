# AGENTS.md

This is an **Open Everywhere app**: an autonomous teammate for Slack, Notion and GitHub. The runtime
is the `@open-everywhere/*` npm packages on the `eve` agent framework. This repository holds only
the app's configuration. To set the app up, use the `quickstart-open-everywhere` skill
(`.claude/skills/`) and the `open-everywhere-ops` MCP server (`.mcp.json`).

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
- `npm run typecheck` type-checks the app. `npx create-open-everywhere --check --json` reports setup
  status for the hosted goal, with a `next` command per step (`--goal local` for `npm run dev` only,
  `--host https://<host>` to probe a deployment).
- Deploy is a separate, explicit step: `npx vercel deploy --prod`. A `git push` does not deploy.
  README.md § "Deploy to Vercel with Slack" is the ordered hosted path.

## Rules

- Never commit a secret, a token, an `.env` value or a credential. Secrets go in `.env.local`
  (gitignored), and a deploy reads them from the Vercel project's environment. A credential whose
  `broker` is `"db"` goes in the encrypted credential store instead (`npx oe secret set <NAME>`).
- Upgrade every `@open-everywhere/*` package and `create-open-everywhere` together, to one version.
  Keep `eve` at the exact version `@open-everywhere/core` declares as its peer.
