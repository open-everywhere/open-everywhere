# Upgrading Open Everywhere

This page is GENERATED from `upgrading.json` beside it. A hand edit here is lost at the next
regenerate. To change it, edit that file and run `npx tsx scripts/upgrading-notes-generate.ts`
in the Open Everywhere repository; `npm run lint:upgrading-notes` there refuses a tree where the
page and the record disagree.

`npx oe upgrade` reads the same record. It bumps every `@open-everywhere/*` package together, pins
`eve` to the target release's declared peer, installs, runs the config codemods the notes name,
then `oe build --accept`, `npm run typecheck` and `npm run build`. `npx oe upgrade --plan` prints
the plan and writes nothing.

The codemods run from the TARGET release's own registry, so a release can ship a codemod for its
own upgrade. A core at 0.1.4 runs them from its OWN registry instead: after the install, it
refuses a codemod a later release introduces. Run `npx oe upgrade` again: the target's own `oe`
is installed by then, and it runs the codemod.

A `devDependencies` key that still reads `create-open-everywhere` is RENAMED to
`@open-everywhere/create`, not bumped. Every app scaffolded at 0.1.3 or earlier carries the old
key, and the unscoped name is retired: it publishes no further version.

A core that carries the template drift report prints it in `npx oe upgrade` and in `--plan`:
every scaffolded file that differs from the target release's `@open-everywhere/create` template,
with a one-line size of its diff. An upgrade never overwrites an app file. `npx oe upgrade` runs
the INSTALLED core's code, so an upgrade from a core without the report prints none. Run
`npx oe upgrade --plan --to <target>` once more after it: the target's own code then prints the
report, even when there is nothing left to install. A stale template-owned file can typecheck and build and
still break the deployment, so read each SYNC line and copy the target's file after you read the
diff.

Read the entries between your installed version and your target, oldest first.

## An app below 0.1.4

An app scaffolded at 0.1.3 or earlier has no `oe upgrade`. The subcommand first shipped in 0.1.4,
and the installed core ships no `upgrading.json`. Install the target core beside the app, in its
gitignored `.open-everywhere/` directory, and run that core's `oe` from the app root:

```sh
npm install --prefix .open-everywhere/bootstrap @open-everywhere/core@0.1.5 tsx@4
node .open-everywhere/bootstrap/node_modules/@open-everywhere/core/bin/oe.js upgrade --to 0.1.5
```

The run renames `create-open-everywhere`, bumps every pin, installs, and then reads the target's
own record for every entry above your version. If the run stops at any step, run the second
command again. The run resumes, and it keeps the version you started from. After a green run,
delete `.open-everywhere/bootstrap`. From then on, `npx oe upgrade` is the command.

Do not use `npx -p @open-everywhere/core@<version> oe upgrade`. The `oe` bin needs `tsx`, which
core does not install, so that command fails before `oe upgrade` starts.

## 0.1.5 — 2026-10-04

Boot refuses an unwired Postgres selection, `oe upgrade` reports template drift, `oe-eve-patch` restores pristine eve over an older OE patch, every NOTICE declares the eve modification core ships, the universal manual ships inside `@open-everywhere/core`, `oe build --check` also checks the overlays, `oe upgrade` runs codemods from the target release, the status route keeps a durable record of verified Slack events, the seat rotation counter counts a cached token once, and eve patch part 10 makes `eve build` faster.

eve peer: `0.54.3`

**Breaking**

- A deployment whose store selection is Postgres now REFUSES TO BOOT when no Postgres client is registered for it. Before this release the same deployment booted and failed at its first audit write, while `npm run typecheck` and `npm run build` both passed. The usual cause is an `agent/lib/register-adapters.ts` from the 0.1.2 or 0.1.3 template, which registers the Neon client only when `OE_MEMORY_PROVIDER` or `OE_OPERATIONAL_PROVIDER` reads `postgres`. The refusal is one sentence in the deployment log. Sync that file from the template (see the manual steps), or run `npx oe upgrade --plan --to 0.1.5` to list every file that differs. The embedded PGlite floor is not affected.
- `npx oe build --check` now also runs the overlay check over the five machine-owned overlays at their default paths: `agent/access/grants.generated.ts`, `agent/access/credential-bindings.generated.ts`, `agent/webhooks/hooks.generated.ts`, `agent/memory/config/agents.generated.ts` and `agent/identity/groups.generated.ts`. The check reads each one strictly: after the header, the file must hold data only, in the exact layout the codemod emits. An overlay that holds anything else, or data in another layout, now turns `oe build --check` red, where 0.1.4 passed it. Edit only the data, then run `npx oe overlays normalize` to re-emit it. A header that an earlier release wrote still passes, because the check reads the header for its shape, not its bytes.

**Manual steps**

- Run the recovery commands that `oe-eve-patch` prints, if it cannot fetch eve@0.54.3. This release adds part 10 to `patches/eve+0.54.3.patch` with the eve peer unchanged, so a tree that already ran `oe-eve-patch` keeps an eve that holds the 0.1.4 patch. The 0.1.5 `oe-eve-patch` restores pristine eve from `npm pack eve@0.54.3` and applies the patch again, in a checkout and on a build host that restores a cached `node_modules` alike. With no registry access and no npm cache, the `postinstall` exits 1, leaves eve unchanged and prints the commands: delete `node_modules/eve`, then install again.
- Sync these template files from the 0.1.5 `@open-everywhere/create` template, if the app was scaffolded at 0.1.4 or earlier: `agent/lib/register-config.ts`, `agent/lib/register-adapters.ts`, `agent/sandbox/backend-select.ts`, `agent/sandbox/sandbox.ts`, `AGENTS.md`, `README.md` and `.claude/skills/upgrade-open-everywhere/SKILL.md`, and add `agent/lib/register-docs.ts`. The app owns its scaffolded files, so `oe upgrade` changes none of them. The `register-docs.ts` and `register-config.ts` edits matter most: without `register-docs.ts` and its import in `register-config.ts`, `read_docs` serves the provider runbooks only, as on 0.1.4. With them, the manual follows the installed core version. The other changes in this window are comments and docs. A 0.1.5 core lists every file that differs in `npx oe upgrade --plan`.
- Merge by hand, if you want them, the template changes to the app's own config files: `agent/instructions.md` (the hint that names the notion-rest skill's `page markdown current` command, on the line that ends "never put an id you inferred"), and comment-only changes in `agent/access/network-access.ts`, `agent/blob/hosting.ts` and `agent/spend/checkpoints.ts`. The five overlays (`*.generated.ts`) carry a newer header too: `npx oe overlays normalize` refreshes it, and the old header still passes the check.
- Review `rotation.tokenBudget` and `rotation.contextSizeTokens` if you lowered either one to offset early seat rotation. Before this release, the counter added the cache-read tokens to `inputTokens`, which already holds them, so a cache-heavy seat rotated early. Each cached token now counts once, and the shipped thresholds are unchanged. With an unchanged override, a seat therefore rotates later than on 0.1.4.

## 0.1.4 — 2026-10-03

Agent-led setup on two routes, Postgres by default on DATABASE_URL with a status route to read, Slack installed from `/setup`, and the scaffolder renamed to `@open-everywhere/create`.

eve peer: `0.54.3`

**Breaking**

- The MEMORY backing is derived from `DATABASE_URL`. A deployment that holds a connection string and never set `OE_MEMORY_PROVIDER` was on the `git` floor before this release, and is on Postgres after it. Nothing errors: every unpinned tier reads an EMPTY Postgres store, and the agent reads as though it has forgotten what it learned. The git store is untouched, and simply no longer read. Choose a route before you deploy — see the manual steps.
- The OPERATIONAL store is Postgres by default: hosted when `DATABASE_URL` is set, else the embedded PGlite floor. `sqlite` is deprecated, and reachable only by naming it in `OE_OPERATIONAL_PROVIDER`. A deployment that holds a connection string and never set `OE_OPERATIONAL_PROVIDER` was on the sqlite floor before this release and is on hosted Postgres after it. Nothing errors, and the audit chain, the spend ledger, the routine run-status and the break-glass connector revocations are all read from an EMPTY store — so a recorded `revoke_connector` stops being enforced, spend caps reset, and scheduled routines stop firing. The per-boot sqlite deprecation notice goes quiet at the same time, which removes the one signal that named the old state. The shipped `docker-compose.yml` pins the provider, so the shipped Docker route is unaffected; a self-rolled host is the exposed case.
- The install wizard, the quickstart plan tool and the local goal are retired. Setup is agent-led now, on two routes: Vercel and Docker. The scaffolded app carries `AGENTS.md`, a `.mcp.json` that starts the `open-everywhere-ops` MCP server, and the `quickstart-open-everywhere` skill, so a coding agent drives the setup.
- The scaffolder publishes as `@open-everywhere/create`. The unscoped `create-open-everywhere` name is retired rather than bumped: it keeps pointing at the releases up to and including 0.1.3.
- `@open-everywhere/core` withdraws the retired wizard's public API. `agent/adapter-api.js` and `agent/adapter-api-ops.js` no longer export `registerQuickstartSurfaceGoal`, `PlanStep`, `SurfaceGoalStep` or `SurfaceHostedPlan`, and `agent/ops/quickstart.js` drops those four plus `quickstartPlan`, `Goal` and `PlanFacts`. A provider bundle that registered a setup plan through that call drops it: the step list `@open-everywhere/create --check` reports replaces it.
- `StatusVersions.core` is `string`, no longer `string | null` (`@open-everywhere/core/agent/ops/status.js`). The status route always answers a real core version now, so a reader that branched on `core === null` must drop that branch, and a caller that injects a version bag into `deploymentStatus` must stop passing `core: null`. Both are compile errors on the upgrade, never a silent change.
- `PreflightTarget` (`@open-everywhere/core/agent/ops/quickstart.js`) is now `"local" | "vercel" | "docker"`. The `"hosted"` member is gone. In TypeScript a caller passing `target: "hosted"` is a compile error. In JavaScript it is worse, because it matches neither deployment route: the gateway exemption and every route-specific sentence then answer as though the deployment were Docker, so a correct Vercel deploy can be reported not ready. Pass `"vercel"` or `"docker"`.
- `@open-everywhere/core/agent/observability/telemetry.js` no longer exports `resetTelemetryConfigCache` or `resolveInstanceId`. Both existed for the retired install wizard's mid-process collector redirect. `__resetTelemetryForTest` is the remaining reset seam.
- `GET /eve/v1/oe/status` is a NEW PUBLIC, UNAUTHENTICATED route on every deployment. It is built to be safe to publish — no secret, id, hostname, content or count — but it does disclose this deployment's contract posture (including `sandbox-backend` and `egress-control` verdicts) and its exact core version to any caller that knows the host. Block the path at the edge if that is not wanted.
- The Slack bundle mounts `GET`/`POST /setup` and `GET /setup/callback` on every deployment that registers it. The page is OPEN, and the deployment logs a one-time setup code on every start while it is, unless a Slack install is already recorded, `SLACK_BOT_TOKEN` or `SLACK_SIGNING_SECRET` is set in the environment, or `OE_CREDENTIAL_ENCRYPTION_KEY` is unset or malformed. 🔴 A deployment that ships the Slack bundle but does NOT use Slack meets none of those conditions, so it upgrades into an open setup page. The trust root is read access to the deployment's logs — a platform permission (`vercel logs`, `docker logs`), not this product's `admin` role — so whoever holds it can complete the setup and bind a Slack app to this deployment. The lock fails closed and the page closes for good at the first install. Block both paths at the edge, or drop `slack-setup-page` from the roster, if the deployment will never use Slack.

**Config migrations**

- `npm create @open-everywhere <dir>` (or `npx @open-everywhere/create <dir>`) replaces `npx create-open-everywhere <dir>`. An app scaffolded at 0.1.3 or earlier pins the retired name, so `oe upgrade` RENAMES that dependency instead of bumping it. An app below 0.1.4 reaches this release or a later one through the section "An app below 0.1.4" in UPGRADING.md. (apply by hand)
- `OE_MEMORY_PROVIDER` and `OE_OPERATIONAL_PROVIDER` are no longer needed on a hosted deploy. A present `DATABASE_URL` selects Postgres for both, and either variable still overrides that in either direction. (apply by hand)

**Manual steps**

- Choose the memory backing BEFORE you deploy this release, if the deployment already holds a `DATABASE_URL` and never set `OE_MEMORY_PROVIDER`. Set `OE_MEMORY_PROVIDER=git` to pin exactly today's behaviour, or migrate the memory first and let the derived default take effect. `docs/deploy/database-graduation.md` states both routes.
- Choose the operational backing BEFORE you deploy this release, on the same test: the deployment holds a `DATABASE_URL` and never set `OE_OPERATIONAL_PROVIDER`. Set `OE_OPERATIONAL_PROVIDER=sqlite` to pin exactly today's behaviour, or bring the rows across first with `DATABASE_URL=… npx tsx scripts/migrate-operational.ts` from `packages/core` and let the derived default take effect. The migration copies the audit chain verbatim and verifies it at the target. `docs/deploy/database-graduation.md` states the route.
- Re-apply the Slack app manifest, then REINSTALL the Slack app. This release subscribes the manifest to every event the front route reads, and adds the `mpim:history`, `files:read` and `files:write` scopes. Slack grants a new scope only on an install, so a manifest update alone leaves the app short.
- Install Slack from the `/setup` PAGE if this deployment has no Slack credentials yet. The page asks first for the one-time setup code, which the deployment logs on every start while Slack is not installed — read it with `vercel logs` or `docker logs`. It then takes one pasted Slack app configuration token, and writes every credential Slack issues to the encrypted store. The page answers 404 while `OE_CREDENTIAL_ENCRYPTION_KEY` is unset or malformed, or a Slack install is already recorded, and it closes entirely while `SLACK_BOT_TOKEN` or `SLACK_SIGNING_SECRET` is set in the environment — an env-configured deployment keeps its credentials and skips this step. `docs/deploy/surfaces/slack.md` walks the page through.
- Read `GET /eve/v1/oe/status` after the deploy to confirm the result. It answers one verdict per deployment-contract requirement id, and it reports the core version it is running. `docs/deploy/contract.md` explains the payload.
- Sync these template files from the 0.1.4 `@open-everywhere/create` template, if the app was scaffolded at 0.1.3 or earlier: `agent/lib/register-adapters.ts`, `scripts/ops-mcp.ts`, `scripts/env-pipe.mjs`, `AGENTS.md`, `.env.example`, `README.md` and `.claude/skills/quickstart-open-everywhere/SKILL.md`, and add `.claude/skills/upgrade-open-everywhere/SKILL.md`. The app owns its scaffolded files, so `oe upgrade` changes none of them. 🔴 `agent/lib/register-adapters.ts` is the one that breaks a deployment: the 0.1.2 and 0.1.3 copies register the Neon client only when `OE_MEMORY_PROVIDER` or `OE_OPERATIONAL_PROVIDER` reads `postgres`. On this release a bare `DATABASE_URL` selects Postgres for both stores, so with the old copy a Vercel+Neon deployment registers no client and fails at its first audit write, while `npm run typecheck` and `npm run build` both pass. A core that carries the boot refusal for this wiring names it in its own release entry. That core refuses to boot over the old copy instead, and its `npx oe upgrade --plan` lists every scaffolded file that differs from the target's template.

## 0.1.3 — 2026-10-03

Four first-install fixes: a pretypecheck build, pinned undici overrides, allowed install scripts, and a scaffold into a fresh clone.

eve peer: `0.54.3`

**Config migrations**

- package.json gains "pretypecheck": "oe build", so `npm run typecheck` passes on a fresh scaffold. (apply by hand)
- package.json `overrides` gain `eve > undici` 8.11.2 and `guarded-fetch > undici` 7.30.0, with a nested `@ai-sdk/provider-utils > undici` 7.30.0 so only eve's own undici changes. eve stays on 0.54.3. (apply by hand)
- package.json gains an `allowScripts` block naming `esbuild` and `@mongodb-js/zstd`, so the install prints no allow-scripts warning. (apply by hand)

## 0.1.2 — 2026-10-01

`npx create-open-everywhere <dir>` scaffolds a quickstart app, and the hosted path has one order.

eve peer: `0.54.3`

**Manual steps**

- The ops deploy plan stops pushing AI_GATEWAY_API_KEY, OE_PUBLIC_BASE_URL and OE_INTAKE_PAGE_SIGNING_KEY to the Vercel project. All three are still read where they are set, so remove one only to take the default: OIDC for the gateway, VERCEL_PROJECT_PRODUCTION_URL for the base URL, and a deployment-minted intake page key.

## 0.1.1 — 2026-09-30

The install wizard starts on a fresh machine and on Windows.

eve peer: `0.54.3`

No breaking change, no config migration, no env change and no manual step.
