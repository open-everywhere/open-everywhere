# Setup steps (reference)

The ordered step list a setup walks, written out for a human to read. Setup itself is agent-led:
you open the app in your coding agent and ask it to set up Open Everywhere, and the agent drives
the `open-everywhere-ops` MCP server plus the status report. This page is what to read when you
want the whole path on one page, or when you are doing a step by hand.

Two routes are supported, and you pick one first:

- **Vercel** — the Vercel CLI plus Marketplace Neon. The deployment authenticates to the AI
  Gateway with OIDC, so it needs no gateway key.
- **Docker** — self-host a container against the
  [deployment contract](./contract.md). Off Vercel there is no OIDC, so the model route needs a
  gateway key. Running a different model backend instead is an
  [adapter swap](../extending/adapter-model.md) in app code, which the status check cannot see.

Nothing else is supported. A local run (`npm run dev`) is the **development** loop, not a setup
route: it has no public HTTPS URL for a chat vendor to reach, and it keeps its state in a different
store, so a local success proves little about a deployment. See "Develop locally" below.

## The status report

`npx @open-everywhere/create --check` reports every step below and the next command for each
unsatisfied one. It changes nothing. `--json` prints the report as data — that is what a coding
agent reads. `--route docker` judges against the Docker route, and `--host https://<host>` probes a
deployment.

## The steps

Each step states what it is for and what to do. The Docker route's differences are called out
under the step they belong to; a step with no Docker note is the same on both routes.

<!-- BEGIN GENERATED: setup-steps (scripts/setup-steps-docs.ts) -->

### 1. Prerequisites (Node 24, git)

Open Everywhere needs the Node range @open-everywhere/core declares (>=24) and git.

- Install Node 24: `nvm install 24 && nvm use 24` (or your platform's installer).
- Install git if `git --version` fails (https://git-scm.com/downloads).

### 2. Repo (app + install)

Get an Open Everywhere app with deps installed.

- Easiest: `npx @open-everywhere/create my-agent` scaffolds the quickstart app into ./my-agent and prints the next steps.
- Or clone the repository: `git clone https://github.com/open-everywhere/open-everywhere && cd open-everywhere && npm install`.
- Then re-run this check FROM inside that app.

### 3. Roster (roster.config.ts → the eve slot tree)

`roster.config.ts` declares what your agent can do; `oe build` materialises the eve slot tree from it.

- roster.config.ts is terse: which packages contribute, which contributions this deployment EXCLUDES (with a reason), and which eve built-ins it takes away.
- roster.lock.json is the expanded, REVIEWED roll-call. Both are committed — the slot tree they generate is not.
- An upgrade that ships a NEW tool fails the build until you decide about it, then `npx oe build --accept` records the decision. There is no bypass flag.
- `npx oe build --show` prints the tree it would write, without writing it; `npm run lint:roster` is the gate.
- eve mounts NOTHING (and still boots) if the tree is missing — so never skip the build step.

### 4. Vercel project link

Link this app to a Vercel project. Every later `vercel` command acts on the linked project.

- `npx vercel link` — follow the prompts (device auth in your browser).

**Docker route.**

The Docker route needs no Vercel project.

- Nothing to do: `--route docker` skips this step. The deployment contract is the Docker route's reference.

### 5. Database (Postgres)

Both routes need Postgres: an ephemeral disk (Vercel) or a replaced container (Docker) loses every local store.

- `npx vercel install neon` provisions Neon and connects it to the linked project, which sets DATABASE_URL there. The project's Storage → Neon → Connect does the same thing. The integration can also enable Neon Auth (NEON_AUTH_BASE_URL, VITE_NEON_AUTH_URL): Open Everywhere does not use it, so leave it off, or ignore those two variables.
- Write the same connection string into .env.local with `npx oe env set DATABASE_URL`, run in your own terminal: it reads the value from a hidden prompt. It selects postgres for the operational store and the memory backing on its own — no provider selector needed. Never paste a connection string into the chat, and never pass it to an ops tool.
- The deployment needs it too: the Neon integration already set DATABASE_URL on the Vercel project.
- Harden later: the two-role split parks the owner credential as OE_DB_OWNER_URL and runs the app as the non-owner "oe_runtime" role, which the owner-DDL escape cannot reach. It is MANUAL — nothing provisions it for you. See https://github.com/open-everywhere/open-everywhere/blob/main/docs/extending/database.md.

**Docker route.**

- Provision a Postgres the container can reach (Neon, RDS, or your own server). The deployment contract states what it must satisfy.
- The deployment needs it too: DATABASE_URL is part of the container's environment.

### 6. Slack app

Create a Slack app from the manifest below, then copy its bot token and signing secret.

- https://api.slack.com/apps → Create New App → From an app manifest → pick the workspace → JSON → paste:

```json
{
  "display_information": {
    "name": "Open Everywhere"
  },
  "features": {
    "app_home": {
      "home_tab_enabled": false,
      "messages_tab_enabled": true,
      "messages_tab_read_only_enabled": false
    },
    "bot_user": {
      "display_name": "Open Everywhere",
      "always_online": true
    },
    "slash_commands": [
      {
        "command": "/oe",
        "url": "https://YOUR-DEPLOY-URL/eve/v1/slack/commands",
        "description": "Open Everywhere control-plane commands (stop, status, budget) — no model turn.",
        "usage_hint": "stop | status | budget [raise <usd> | clear] | rate <n> | help",
        "should_escape": false
      }
    ],
    "shortcuts": [
      {
        "name": "Send to Open Everywhere",
        "type": "message",
        "callback_id": "oe_message_shortcut",
        "description": "Wake the agent on this message."
      },
      {
        "name": "Ask Open Everywhere",
        "type": "global",
        "callback_id": "oe_global_shortcut",
        "description": "Wake the agent in a DM."
      }
    ]
  },
  "oauth_config": {
    "redirect_urls": [
      "https://YOUR-DEPLOY-URL/setup/callback"
    ],
    "scopes": {
      "bot": [
        "app_mentions:read",
        "chat:write",
        "channels:history",
        "commands",
        "channels:read",
        "groups:read",
        "im:history",
        "im:read",
        "im:write",
        "groups:history",
        "mpim:history",
        "mpim:read",
        "files:write",
        "files:read",
        "reactions:write",
        "reactions:read",
        "pins:read",
        "pins:write",
        "users:read"
      ]
    }
  },
  "settings": {
    "event_subscriptions": {
      "request_url": "https://YOUR-DEPLOY-URL/eve/v1/slack",
      "bot_events": [
        "app_mention",
        "message.im",
        "message.channels",
        "message.groups",
        "message.mpim",
        "member_joined_channel",
        "reaction_added",
        "reaction_removed"
      ]
    },
    "interactivity": {
      "is_enabled": true,
      "request_url": "https://YOUR-DEPLOY-URL/eve/v1/slack"
    },
    "org_deploy_enabled": false,
    "socket_mode_enabled": false,
    "token_rotation_enabled": false
  }
}
```

- The app is named "Open Everywhere" (the default — set identity.name in agent/settings/settings.ts to name it). A second install in one workspace needs its own name: re-run with --app-name "<name>".
- Install to Workspace, then OAuth & Permissions → copy the Bot User OAuth Token (xoxb-…) = SLACK_BOT_TOKEN.
- Basic Information → Display Information → App icon: upload the project mark, https://raw.githubusercontent.com/open-everywhere/open-everywhere/main/brand/png/mark-square-1024.png. Slack's manifest has no icon field, so this step stays by hand.
- Basic Information → App Credentials → copy the Signing Secret = SLACK_SIGNING_SECRET.
- Write both with `npx oe env set SLACK_BOT_TOKEN` and `npx oe env set SLACK_SIGNING_SECRET`, run in your own terminal: each reads the value from a hidden prompt. Never paste a secret into the chat, and never pass one to an ops tool.
- THE SHORT WAY, once the deployment is up: open https://<host>/setup. It creates the Slack app from this same manifest with one pasted Slack app configuration token, installs it, and keeps every credential in the deployment's own encrypted store — no env var to set. This check cannot see that store, so it still reports this step unsatisfied afterwards; the status endpoint can.
- The manifest's URLs say YOUR-DEPLOY-URL until you deploy. Slack cannot verify Event Subscriptions before a deploy that holds SLACK_SIGNING_SECRET is up. After the deploy, paste the manifest again with your host (App Manifest → Save Changes), then retry the verification under Event Subscriptions.
- Note two ids for the trust edits: the workspace (team) id T… (the segment after /client/ in the workspace URL at https://app.slack.com), and your own member id U… (your Slack profile → ⋮ More → Copy member ID).
- Full walkthrough: https://github.com/open-everywhere/open-everywhere/blob/main/docs/deploy/surfaces/slack.md.

### 7. Env var checklist

A presence-only checklist (it never prints a value). The full surface is in the configuration reference: https://github.com/open-everywhere/open-everywhere/blob/main/docs/deploy/configuration-reference.md

- Both routes need two values: DATABASE_URL and OE_CREDENTIAL_ENCRYPTION_KEY. DATABASE_URL resolves BOTH stores to postgres on its own (OPE-2230), so there is no provider selector to set — a selector pointing away from postgres is the only thing that breaks it.
- Mint OE_CREDENTIAL_ENCRYPTION_KEY with the ops tool `scaffold_credential_key`: it writes a base64 32-byte AES-256 key into .env.local and never prints it. The encrypted credential store fails closed on every read and write without it.
- The Vercel route needs NO AI_GATEWAY_API_KEY: a deployed project authenticates to the AI Gateway with OIDC.
- Each chat surface adds its own names — Slack reads SLACK_BOT_TOKEN and SLACK_SIGNING_SECRET from the environment.
- Not needed on a deployment: OE_PUBLIC_BASE_URL (only for a custom domain) and OE_INTAKE_PAGE_SIGNING_KEY (the deployment mints it into the credential store).
- Run `npx @open-everywhere/create --check --json`, or the ops tool `preflight`, for the live verdict per name. Both read .env.local and the shell only.
- Set the values on the deployment instead (the Vercel dashboard, say)? Add `--host https://<host>`: the step then also reads the deployment's own verdicts from its public `/eve/v1/oe/status` route.

**Docker route.**

- The Docker route also needs a model route: AI_GATEWAY_API_KEY. There is no OIDC off Vercel. Running a different model backend is an adapter swap in app code, not an env setting — https://github.com/open-everywhere/open-everywhere/blob/main/docs/extending/adapter-model.md.

### 8. Build + deploy

Build before you deploy — a broken build must never be promoted.

- `npm run build` (= `oe build`, then `eve build`) — must be green.
- Deploy is a SEPARATE, explicit step: `npx vercel deploy --prod` (confirm the scope and team first). A `git push` does NOT deploy.
- Then re-run `npx @open-everywhere/create --check --host https://<host>`: it probes the deployed Slack route.
- The probe passes on the route's own `401 unauthorized`, which proves the function booted and the route is mounted. It does NOT prove the deployment holds SLACK_SIGNING_SECRET: the route answers the same without it. Only Event Subscriptions showing **Verified** in the Slack console proves that.

**Docker route.**

- Deploy is a SEPARATE, explicit step: build the image and run it on your server, with the contract's environment set. See https://github.com/open-everywhere/open-everywhere/blob/main/docs/deploy/contract.md.

### 9. Final verification

Before going live, run a real task in a pilot channel and walk the setup runbook's safety checklist (access bundles, egress enforcement, spend caps).

- 🔴 THIS CHECK NEVER READS THE DEPLOYMENT'S OWN ENVIRONMENT. Every step above reads .env.local and your shell. `.env.local` is gitignored and never ships, so the deployment reads only what you set ON it: DATABASE_URL, OE_CREDENTIAL_ENCRYPTION_KEY, SLACK_BOT_TOKEN, SLACK_SIGNING_SECRET. A full house here says nothing about any of them.
- Set each one for Production without printing it: `npm run -s env:pipe -- <NAME> | npx vercel env add <NAME> production`. Always pipe it straight into `vercel env add`; never run `env:pipe` bare, because a shell that is not a terminal prints the value. The Neon integration already set DATABASE_URL there, and it selects postgres for both stores on its own — no provider selector to push. A variable added after a deploy reaches the functions only on the NEXT deploy.
- Mint OE_CREDENTIAL_ENCRYPTION_KEY with the ops tool `scaffold_credential_key`, which writes it to .env.local and never prints it. Without it the encrypted credential store fails closed on every read and write.
- Not needed on a deployment: the two store selectors (DATABASE_URL resolves both), OE_PUBLIC_BASE_URL (only for a custom domain) and OE_INTAKE_PAGE_SIGNING_KEY (the deployment mints it into the credential store). On the Vercel route, AI_GATEWAY_API_KEY is not needed either — OIDC covers it.
- Send the app a direct message in Slack, then @mention it in a channel you invited it to.
- Safety checklist: https://github.com/open-everywhere/open-everywhere/blob/main/docs/deploy/setup-runbook.md#safety-checklist-the-anti-footgun-list

**Docker route.**

- Set each one in the container's environment (a compose file, your orchestrator's secret store — not a tracked file). DATABASE_URL selects postgres for both stores on its own. A variable added after the container starts reaches the app only on the next start.

<!-- END GENERATED: setup-steps -->

## Two things this page's checklist cannot tell you

**The deployment's own environment is unchecked.** `--check` reads `.env.local` and your shell.
`.env.local` is gitignored and never ships, so the deployment reads only what you set **on it**:
`DATABASE_URL`, `OE_CREDENTIAL_ENCRYPTION_KEY`, `SLACK_BOT_TOKEN` and `SLACK_SIGNING_SECRET`. A
full house above says nothing about any of them, and the final step's own guidance is the only
place that puts them there. There is **no provider selector to set**: `DATABASE_URL` resolves both
stores to postgres on its own. Mint the credential key with the ops tool
`scaffold_credential_key`, which writes it to `.env.local` and never prints it; without it the
encrypted credential store fails closed on every read and write. On the Vercel route, push each
value without printing it:

```
npm run -s env:pipe -- <NAME> | npx vercel env add <NAME> production
```

Always pipe `env:pipe` straight into `vercel env add`. Never run it bare: a shell that is not a
terminal prints the value. The Neon integration already set `DATABASE_URL` on the project. In
Docker, the same names are the container's environment. A variable added after a deploy reaches the
app only on the next one.

**On the Docker route, `--check` cannot exit 0 unless those values are also in `.env.local`.** That
is not a bug: the operator tools (`oe secret`, the ops server's `secret_set`) write the store the
deployment reads, so they need the same connection string and the same key locally. A Docker
operator who keeps them only on the server will see the database, env and credential-key steps stay
unsatisfied, and the `next` line for each says where the check looked.

## What the build prints

`npm run build` prints some warnings that are expected:

- Several `Ignoring unsupported directory "<name>/" in the agent root` warnings. `eve` warns about
  each directory in `agent/` that is not one of its own slots. Those directories (`access/`,
  `identity/`, `settings/` and the rest) are Open Everywhere configuration, which the app loads
  itself.
- `[open-everywhere:sandbox] off-Vercel sandbox backend = docker` and an `egress NOT enforceable`
  warning. A build on your machine evaluates the agent's modules off Vercel, so they describe a
  local run. On Vercel the agent uses the Vercel Sandbox, which enforces egress. For a local run,
  read the warning: a session that needs network access aborts until you wire the egress proxy or
  set `egress.allowUnenforced` in `agent/settings/settings.ts` for development.

A Vercel deployment's logs also print one expected warning at each cold start:
`[open-everywhere:connector-scope:boot] channel-kind ALS reach: unavailable … Cannot find module
'eve/package.json'`. The Vercel build bundles `eve` into the function, so no `node_modules/eve`
exists at run time. Only an optional hint about the caller's channel kind is lost. The connector
gate still refuses a call with no caller identity, and the session's binding recovers the surface.

## Develop locally

After the deploy, `npm run dev` runs the agent on your machine and talks to it in a terminal UI.
That is the loop for changing tools and skills, running evals, and debugging a turn. It needs
`AI_GATEWAY_API_KEY` in `.env.local` (Vercel → AI Gateway → API Keys), and it keeps its state in an
embedded database under `.open-everywhere-data/`. A chat vendor cannot reach it without a public
tunnel, which is why it is never a setup step.

## Where to go next

- [The deployment contract](./contract.md) — what a running Open Everywhere needs, on any host.
- [Setup runbook](./setup-runbook.md) — the full path beyond this page, with the safety checklist.
- [Agent-driven setup](./agent-driven-setup.md) — the same path written for the agent driving it.
- [Configuration reference](./configuration-reference.md) — every config field and env var.
