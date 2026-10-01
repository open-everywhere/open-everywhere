---
name: quickstart-open-everywhere
description: Set up, configure or deploy this Open Everywhere app — from a fresh scaffold to an agent that answers in Slack. Use when the user wants to set up Open Everywhere, connect Slack, Notion or GitHub, run it locally, or deploy it. Drives the open-everywhere-ops MCP server (preflight, quickstart, surface_manifest, scaffold_env, scaffold_credential_key, secret_set/list/rm) and the wizard's `--check --json` report.
---

# Quickstart Open Everywhere

This directory is an **Open Everywhere app**: a small repository that depends on the
`@open-everywhere/*` npm packages and holds only configuration (`AGENTS.md` describes it). This
repository's `.mcp.json` gives you the `open-everywhere-ops` MCP server. You supply the judgement,
and you run commands **with the user's consent**.

## Golden rules

- The ops MCP tools check and scaffold. **You** run install, build and deploy commands in the
  user's shell: show the command, get a yes, then run it. Never run `vercel deploy`, create cloud
  resources, or write a secret without explicit confirmation.
- Never echo a secret, and never commit one. Ask the user to paste a secret value. Write it to the
  gitignored `.env.local` with `scaffold_env`, then forget it. Mint the encryption key with
  `scaffold_credential_key`, which never prints it.
- **Where each secret lives.** The deployment reads `DATABASE_URL`, `OE_CREDENTIAL_ENCRYPTION_KEY`,
  `SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET` and `GITHUB_WEBHOOK_SECRET` from its **environment**:
  the Slack bundle and the GitHub webhook check never read the credential store. So these go in `.env.local`, and
  then into the Vercel project's environment (step 9 below). `secret_set` is for a credential whose
  `broker` is `"db"` (and `NOTION_WEBHOOK_SECRET`). It needs `DATABASE_URL` and the key in
  `.env.local` first. Nothing reads a stored secret back out (`secret_list` returns names only).
- Every command runs from this directory (the app root).

## Status

Run `npx create-open-everywhere --check --json`. It reports the wizard's ten steps as JSON, each
with `satisfied`, `detail`, and a `next` command when it is not satisfied. It changes nothing. It
judges against the hosted goal unless you pass `--goal local`. Also call the `preflight` tool
(`target: "hosted"` for a deploy). Re-run both after each step.

Call `quickstart { goal: "deploy" }` for the same path as ordered plan steps marked `done`, `todo`
or `optional`. A step the plan cannot observe (anything the Vercel project holds) stays `todo`;
confirm it with the user.

## The hosted path (Vercel + Neon + Slack)

Do the steps in this order. It is the same order as README.md and the `deploy` plan.

1. **Install.** If `node_modules` is missing: `npm install`. Its `postinstall` runs `oe-eve-patch`,
   which patches the installed `eve`. The app refuses to boot without the patch.
2. **Link.** `npx vercel link` (interactive: the user signs in).
3. **Database.** The user adds Neon in the Vercel dashboard: project → **Storage → Neon →
   Connect**. The integration sets `DATABASE_URL` on the project. Ask for the connection string,
   then `scaffold_env { values: { DATABASE_URL, OE_OPERATIONAL_PROVIDER: "postgres",
   OE_MEMORY_PROVIDER: "postgres" } }`.
4. **Key.** `scaffold_credential_key`.
5. **Slack app.** Call `surface_manifest { surface: "slack" }` and hand the user the manifest and
   the steps it returns. Before the first deploy the manifest keeps `YOUR-DEPLOY-URL`. The user
   creates and installs the app, then pastes `SLACK_BOT_TOKEN` and `SLACK_SIGNING_SECRET`: write
   both with `scaffold_env`.
6. **Vouch the workspace.** Ask for the team id (`T…`: the segment after `/client/` in the
   workspace URL at app.slack.com). In `agent/identity/surfaces.ts` add
   `defineSurface({ key: "slack/<team-id>", trust: "internal" })`.
7. **Admin.** Ask for the user's member id (`U…`: Slack profile → ⋮ More → Copy member ID). In
   `agent/memory/config/domains/org.ts` set `admins: ["slack/<team-id>/<member-id>"]`. Offer to
   commit both edits. They take effect on the next deploy, so make them before it.
8. **Build.** `npm run build`. It must pass.
9. **Deployment env.** `.env.local` never ships. For each name, run (confirm first)
   `npm run -s env:pipe -- <NAME> | npx vercel env add <NAME> production`. The names are
   `OE_CREDENTIAL_ENCRYPTION_KEY`, `SLACK_BOT_TOKEN` and `SLACK_SIGNING_SECRET`. For the two
   selectors, send the literal value: `npm run -s env:pipe -- OE_OPERATIONAL_PROVIDER=postgres |
   npx vercel env add OE_OPERATIONAL_PROVIDER production`, and the same for `OE_MEMORY_PROVIDER`.
   Always pipe `env:pipe` straight into `vercel env add`, as written. Never run it bare: your shell
   is never a terminal, so a bare run prints the secret into your output. `env:pipe` refuses a file
   or a terminal, but it cannot tell a pipe into your own shell from a pipe into `vercel`. Do not push
   `AI_GATEWAY_API_KEY` (OIDC covers it), `OE_PUBLIC_BASE_URL` (only for a custom domain) or
   `OE_INTAKE_PAGE_SIGNING_KEY` (the deployment mints it).
10. **Deploy.** `npx vercel deploy --prod` (confirm first). Note the production host it prints.
11. **Slack URLs.** Call `surface_manifest { surface: "slack", baseUrl: "https://<host>" }`. The
    user pastes it under the Slack app's **App Manifest** and saves. Slack verifies the Event
    Subscriptions URL. If it fails, the user chooses **Retry** under Event Subscriptions.
12. **Prove it.** `npx create-open-everywhere --check --json --host https://<host>`. The
    `build-deploy` step is satisfied only when the deployed Slack route answers an unsigned request
    with its own `401 unauthorized`. That proves boot and routing, not `SLACK_SIGNING_SECRET`: ask the
    user to confirm Event Subscriptions shows **Verified**.
13. **Hello.** Ask the user to send the app a direct message in Slack.

## The local path

Write `AI_GATEWAY_API_KEY` with `scaffold_env` (the user creates it: Vercel → AI Gateway → API
Keys), then `npm run dev`. Check it with `npx create-open-everywhere --check --goal local`. A local
run needs no database. Slack cannot reach a local server without a public tunnel.

## Telemetry

The wizard asks one telemetry question. Only the person answers it: never answer it for them.
Either they run `npx create-open-everywhere` in a terminal and answer the prompt, or, if they say
to decline, you run `npx create-open-everywhere --decline-telemetry`, which sends nothing.

## Notes

- `roster.config.ts` decides what the agent can do. After any change to it, or after a package
  upgrade, run `npx oe build --accept` and show the user the `roster.lock.json` diff: accepting it is
  their review decision.
- `.env.example` names every variable this app reads. Read it when unsure what a key does.
- The deployment's own identity (`deploymentIdentity`) is code in `agent/identity/surfaces.ts`, not
  env.
