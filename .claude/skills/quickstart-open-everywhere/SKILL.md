---
name: quickstart-open-everywhere
description: Stand up an Open Everywhere instance (local or deployed) from zero. Use when the user wants to set up, configure, or deploy Open Everywhere — e.g. "set up Open Everywhere for my Slack workspace" or "get Open Everywhere running locally". Drives the open-everywhere-ops MCP server (preflight, quickstart, scaffold_env, secret_set/list/rm).
---

# Quickstart Open Everywhere

You are helping the user stand up an **Open Everywhere** instance — a config-as-code agent
that lives in Slack/GitHub/Linear with scoped memory, spend caps, routines, and an
MCP control plane. The repo's `.mcp.json` gives you the `open-everywhere-ops` MCP server; you
supply the judgement and run the commands **with the user's consent**.

## Golden rules
- The ops MCP tools do checks + scaffolding. **You** run install/deploy commands in
  the user's shell — show the command, get a yes, then run it. Never run `vercel
  deploy`, create cloud resources, or write secrets without explicit confirmation.
- **Secrets belong in the deployment's encrypted credential store, not in a file.** Once
  `DATABASE_URL` + `OE_CREDENTIAL_ENCRYPTION_KEY` are set, load every other secret with
  `secret_set` (`{ secrets: { NAME: "<value>" } }`) — it encrypts straight into the store the
  deployment reads, and nothing can read it back out (there is no `secret_get`; `secret_list`
  returns names only). `scaffold_env` stays for NON-secret config and for the root-of-trust vars
  themselves; anything it writes lands in gitignored `.env.local`. Never echo a secret back or
  commit one.
- Prefer the **local** path first (`eve dev`) so the user sees it working before
  committing to cloud infra.

## Flow

1. **Clarify the goal.** Ask what they want: just try it **local**ly, add a **slack**
   or **github** surface, or **deploy** a hosted instance. Map it to a goal:
   `local` | `slack` | `github` | `deploy`.

2. **Preflight — TWO checks, same underlying engine.** Run BOTH, from the repo root
   (not a subdirectory — the install wizard checks the real checkout at `cwd`):
   - Call the `preflight` MCP tool for the model/DB/control-plane-auth facts
     (`.env.local` presence, with fix hints).
   - Also run the broader **install wizard's `--check` mode**. Inside a checkout that is
     `node packages/create/bin/create-open-everywhere.js --check`; with no checkout yet, the
     same wizard runs from npm as `npx create-open-everywhere@latest --check`. It reports on
     the SAME 10-step checklist a human running the wizard themselves would see
     (prerequisites, repo, tool roster, Vercel link, database, Slack app, env checklist,
     telemetry disclosure, build, final verification). It's read-only: no prompts,
     no writes, no telemetry. Use its unsatisfied steps as your walk-the-user-through
     list — this skill is thin on purpose; the wizard engine (`packages/create/src/
     engine.ts` + `src/steps/*.ts`) owns the actual step logic, this skill just reads
     its report and talks the human through it in the surface they're in (Slack, a
     terminal, wherever this agent is running).
   Walk the user through anything `missing`/unsatisfied from either check.

3. **Get the plan.** Call `quickstart` with the goal. It returns ordered steps, each
   marked `done`/`todo`/`optional`, with the command to run. Use it as your checklist.

4. **Gather + scaffold config.** For each `todo` that needs a value (model key, Slack
   tokens, GitHub token, `DATABASE_URL`, admin-auth vars), ask the user, then write it
   with `scaffold_env` (`{ values: { KEY: "..." } }`) — but put SECRETS in the credential store
   with `secret_set` instead once the DB + encryption key exist (`secret_list` shows what is
   already loaded). Re-run `preflight` to confirm.

5. **Run it.**
   - First time, ensure deps: `npm install` (in the project dir).
   - **Local:** `npm run dev` (Eve dev server). Tell them how to exercise it (mention
     the bot / hit the local webhook). For Slack/GitHub locally, they'll need a tunnel
     for webhooks — mention it.
   - **Deploy:** `npm run build`, then `vercel deploy --prod` (confirm first). For a
     hosted instance they need **Neon** (`DATABASE_URL`, `OE_MEMORY_PROVIDER=postgres`,
     `OE_OPERATIONAL_PROVIDER=postgres`) and **control-plane auth** (any OIDC
     issuer via `OE_ADMIN_OIDC_ISSUER/_AUDIENCE`, or `OE_ADMIN_STATIC_TOKEN`).
     After deploy, wire the webhook URLs back into the Slack app / GitHub repo.
     For the Slack app itself, do not hand-build the manifest: call the ops MCP tool
     `surface_manifest { surface: "slack", baseUrl: "<deploy host>" }` and paste what it
     returns into the Slack app console (the same template the create wizard reads).

6. **Verify.** Local: confirm the dev server is up. Deployed: confirm the URL
   responds. Then point them at the **control plane** (`npm run control`, the
   `open-everywhere-control` MCP server) to inspect spend / routines / audit / access and,
   as admin, set limits or grant connectors.

## Notes
- **The install wizard (`packages/create`) is the same setup engine a human runs
  themselves** (`node packages/create/bin/create-open-everywhere.js`, or
  `npx create-open-everywhere@latest` with no checkout, no flags, for the interactive
  version — it prompts and can write `.env.local` values, never echoing a secret back).
  With no checkout, the user creates the app with `npx create-open-everywhere@latest <dir>`:
  it scaffolds the quickstart app (a small repo that depends on the npm packages) into a new or
  empty `<dir>` and runs the wizard there. Without a `<dir>`, the wizard only CONFIGURES the app in
  the current directory.
  This skill only ever drives its `--check` mode (read-only);
  if the user wants the wizard to actually make changes (write env vars, run the
  build), tell them to run it directly themselves rather than relaying prompts
  through this agent — the wizard's own telemetry-consent step needs a human
  actually at that keyboard, not a relayed answer.
- `.env.example` documents every variable; read it when unsure what a key does.
- Open Everywhere is **config-as-code**: access bundles (`agent/access/bundles.ts`) and spend
  caps (`agent/spend/caps.ts`) are edited in-repo and reviewed by PR. Runtime tweaks
  (set a spend limit, grant a connector) are done through the control plane, not here.
- 🔴 **The deployment's own identity is config, not env.** Its tenant org, ambient workspace and
  ambient surface live in `agent/identity/surfaces.ts` (the `deploymentIdentity` object, beside the
  surface trust vouches) and change by PR. `OE_ORG`, `OE_WORKSPACE`, `OE_SURFACE` and `OE_CHANNEL`
  are no longer read — never scaffold one into `.env.local`, and edit the file instead when the
  user wants a different tenant or a different local room. Env keeps infrastructure only:
  connection targets and the bootstrap credentials that reach a store.
- These tools assume the Open Everywhere repo is the working directory (that's where the agent
  was booted). If the user hasn't cloned it yet, help them clone it first, then
  `npm install`.
