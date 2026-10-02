# Upgrading Open Everywhere

This page is GENERATED from `upgrading.json` beside it. A hand edit here is lost at the next
regenerate. To change it, edit that file and run `npx tsx scripts/upgrading-notes-generate.ts`
in the Open Everywhere repository; `npm run lint:upgrading-notes` there refuses a tree where the
page and the record disagree.

`npx oe upgrade` reads the same record. It bumps every `@open-everywhere/*` package together, pins
`eve` to the target release's declared peer, installs, runs the config codemods the notes name,
then `oe build --accept`, `npm run typecheck` and `npm run build`. `npx oe upgrade --plan` prints
the plan and writes nothing.

A `devDependencies` key that still reads `create-open-everywhere` is RENAMED to
`@open-everywhere/create`, not bumped. Every app scaffolded at 0.1.3 or earlier carries the old
key, and the unscoped name is retired: it publishes no further version.

Read the entries between your installed version and your target, oldest first.

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

- `npm create @open-everywhere <dir>` (or `npx @open-everywhere/create <dir>`) replaces `npx create-open-everywhere <dir>`. An app scaffolded at 0.1.3 or earlier pins the retired name, so `oe upgrade` RENAMES that dependency instead of bumping it. (apply by hand)
- `OE_MEMORY_PROVIDER` and `OE_OPERATIONAL_PROVIDER` are no longer needed on a hosted deploy. A present `DATABASE_URL` selects Postgres for both, and either variable still overrides that in either direction. (apply by hand)

**Manual steps**

- Choose the memory backing BEFORE you deploy this release, if the deployment already holds a `DATABASE_URL` and never set `OE_MEMORY_PROVIDER`. Set `OE_MEMORY_PROVIDER=git` to pin exactly today's behaviour, or migrate the memory first and let the derived default take effect. `docs/deploy/database-graduation.md` states both routes.
- Choose the operational backing BEFORE you deploy this release, on the same test: the deployment holds a `DATABASE_URL` and never set `OE_OPERATIONAL_PROVIDER`. Set `OE_OPERATIONAL_PROVIDER=sqlite` to pin exactly today's behaviour, or bring the rows across first with `DATABASE_URL=… npx tsx scripts/migrate-operational.ts` from `packages/core` and let the derived default take effect. The migration copies the audit chain verbatim and verifies it at the target. `docs/deploy/database-graduation.md` states the route.
- Re-apply the Slack app manifest, then REINSTALL the Slack app. This release subscribes the manifest to every event the front route reads, and adds the `mpim:history`, `files:read` and `files:write` scopes. Slack grants a new scope only on an install, so a manifest update alone leaves the app short.
- Install Slack from the `/setup` PAGE if this deployment has no Slack credentials yet. The page asks first for the one-time setup code, which the deployment logs on every start while Slack is not installed — read it with `vercel logs` or `docker logs`. It then takes one pasted Slack app configuration token, and writes every credential Slack issues to the encrypted store. The page answers 404 while `OE_CREDENTIAL_ENCRYPTION_KEY` is unset or malformed, or a Slack install is already recorded, and it closes entirely while `SLACK_BOT_TOKEN` or `SLACK_SIGNING_SECRET` is set in the environment — an env-configured deployment keeps its credentials and skips this step. `docs/deploy/surfaces/slack.md` walks the page through.
- Read `GET /eve/v1/oe/status` after the deploy to confirm the result. It answers one verdict per deployment-contract requirement id, and it reports the core version it is running. `docs/deploy/contract.md` explains the payload.

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
