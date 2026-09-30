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
- **Secrets belong in the encrypted credential store, not in a file.** Once `DATABASE_URL` and
  `OE_CREDENTIAL_ENCRYPTION_KEY` are set, load every other secret with `secret_set`. Nothing reads a
  stored secret back out (`secret_list` returns names only). `scaffold_env` is for non-secret config
  and for the root-of-trust variables. It writes to the gitignored `.env.local`. Mint the encryption
  key with `scaffold_credential_key`, which never prints it. Never echo a secret, and never commit one.
- Every command runs from this directory (the app root).

## Flow

1. **Status as data.** Run `npx create-open-everywhere --check --json`. It reports the wizard's ten
   steps (prerequisites, repo, roster, Vercel link, database, Slack app, env checklist, telemetry
   disclosure, build, final verification) as JSON, and changes nothing. Also call the `preflight`
   MCP tool. Work through every unsatisfied step from either report.
2. **Install.** If `node_modules` is missing: `npm install`. Its `postinstall` runs `oe-eve-patch`,
   which patches the installed `eve`. The app refuses to boot without the patch.
3. **Get the plan.** Call `quickstart` with the goal (`local`, `slack`, `github` or `deploy`). It
   returns ordered steps marked `done`, `todo` or `optional`.
4. **Config.** Ask the user for each value a `todo` needs, then write it with `scaffold_env`, or
   `secret_set` for a secret. Two edits are code, not env:
   - vouch the user's Slack workspace as internal in `agent/identity/surfaces.ts`;
   - add the user's own Slack member id to `admins` in `agent/memory/config/domains/org.ts`.
5. **Slack app.** Call `surface_manifest { surface: "slack", baseUrl: "<deploy host>" }`, and have
   the user paste the result into Slack's **Create New App → From a manifest** flow.
6. **Run it.**
   - **Local:** `npm run dev`. Slack and GitHub need a public tunnel to reach a local server.
   - **Deploy:** `npm run build`, then `vercel deploy --prod` (confirm first). A hosted instance
     needs Postgres (`DATABASE_URL`) and the encryption key. A `git push` does not deploy.
7. **Verify.** Re-run `npx create-open-everywhere --check --json`, then ask the user to DM the app in
   Slack.

## Notes

- The interactive wizard (`npx create-open-everywhere`, no flags) needs a human at the keyboard: its
  telemetry-consent step must be answered by the person, not relayed. Drive only `--check`.
- `roster.config.ts` decides what the agent can do. After any change to it, or after a package
  upgrade, run `npx oe build --accept` and show the user the `roster.lock.json` diff: accepting it is
  their review decision.
- `.env.example` names every variable this app reads. Read it when unsure what a key does.
- The deployment's own identity (`deploymentIdentity`) is code in `agent/identity/surfaces.ts`, not
  env.
