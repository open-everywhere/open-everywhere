# `scripts/` — root-level (app-tier) checks

This directory and `packages/core/scripts/` are **two tiers of the same test suite**, both wired
into `npm test`. The split is structural, not stylistic — read this before adding a new file to
either side.

## The two-tier convention

**`packages/core/scripts/` = core-tier.** `packages/core` is the portable, vendor-SDK-free spine
(see `AGENTS.md`'s "core/app split"). A core script may **not** import a provider package
(`@open-everywhere/provider-*`) — that's boundary rule 1, enforced by
`packages/core/scripts/boundary-test.ts`. So core-tier tests exercise the engine against
*synthetic* config and pin the **fail-closed / UNREGISTERED** posture: what core does when no
platform bundle has registered anything (identity mapper, capability manifest, post-arm, wake-
origin codec, …). That posture — refuse, treat as untrusted, no-op — is exactly what a bare core
checkout does before any deployer wires up a provider, and it's what must never silently regress.

**`scripts/` (this directory) = app-tier.** The deployed app is core **+** the provider bundles it
registers at boot (`registerDiscordProvider()`, `registerNotionProvider()`, …). Only code running
at this level can import a provider package, so this is where the **REGISTERED** behaviour lives —
the rows and code paths a core-alone suite can no longer see once a platform's registrations moved
into its bundle. These tests compose core + one or more real bundles exactly the way the deployed
app does, then assert the same things the old core-tier tests used to pin for that platform, before
extraction.

**Why the split, concretely:** OPE-114 (2026-07-25) extracted each provider (Slack, Discord,
GitHub, Linear, Teams, Notion) out of `packages/core` into its own
`@open-everywhere/provider-*` package, so a fork can ship without vendor SDKs it doesn't use. Every
test that needs a REAL bundle registered — not just core's synthetic stand-ins — had to move here.
That's most of what's in this directory today; it grew in one sitting rather than by deliberate
layout, hence this README.

## What lives here, by shape

- **`<provider>-provider-integration-test.ts`** (`discord-`, `linear-`, `notion-`,
  `teams-`) — the canonical app-tier shape: `registerXProvider()` then re-run the cross-cutting
  assertions (capability-manifest row, `reply`/`entity-actions`/read-verb routing, …) that used to
  live inside core's own suites for that platform. Mirror each other's structure; if you add an
  eighth provider package, its integration test should look like these five.
- **`discord-*-test.ts`** (`discord-approvals`, `discord-backscroll`, `discord-engagement`,
  `discord-gateway`, `discord-read`, `discord-test`) — Discord-*native* mechanism tests: the relay
  HMAC gate, the engagement model, the backscroll fetcher, the read adapter, the end-to-end
  identity harness. These test `agent/channels/discord*.ts` directly and were never core-tier —
  Discord's webhook/gateway surface has always lived at the app tier (custom relay, admin approval
  cards, guild-admin bypass) because it composes too deeply with core internals to synthesize.
- **`discord-scenario-test.ts` / `discord-scenario-security-test.ts` / `discord-scenario-harness.ts`
  / `goldens/`** — the golden-transcript scenario suite for the Discord gateway surface: real
  inbound relay payloads through the real route handler, every outbound effect (REST calls, session
  dispatches) recorded into an ordered timeline and diffed byte-for-byte against
  `goldens/<name>.golden.txt`. `discord-scenario-harness.ts` is the shared machinery; the two
  `-test.ts` files are behaviour-sequencing and attacker-shaped/zero-effect suites respectively.
  Regenerate with `UPDATE_GOLDENS=1 npm run test:scenarios` (see each file's header) — a deliberate
  act, since the diff is the review surface.
- **`<concern>-test.ts`** (`chat-audit`, `dispatch`, `generic-read-verbs`, `normalized-wake`,
  `post-file`, `reaction-ingest`, `reply`, `window-tool-gate`, `oe-commands`, `unified-window`) —
  cross-cutting tool/spine tests that are **not** about one provider, but moved here because
  exercising their full behaviour needs at least one bundle registered (most drive Slack-shaped
  fixtures through `packages/core/scripts/_slack-test-stubs.ts` plus the real Discord/other bundle
  for the platform-specific arms). Named for the concern under test, same as their core-tier
  siblings — no provider prefix.
- **`e2e-driver-test.ts`** — offline, secret-free unit tests *for* the live e2e driver pack
  (`packages/core/scripts/e2e/*`): scenario-table shape, dry-mode planning, signature/payload
  builders round-tripped against the real verifiers, the judge fallback, the polling backoff. Not
  to be confused with the live pack itself, which drives a real deployment and is not part of
  `npm test` (see AGENTS.md's "Live e2e driver pack").
- **`wake-origin-fixtures-boot.ts`** — a boot wrapper around the FROZEN core oracle
  (`packages/core/scripts/wake-origin-fixtures-test.ts`, which must never change). The oracle
  covers every platform's wake-origin codec, but codecs now live in their provider bundles — so the
  full six-arm set only exists once the app's boot wiring (all `registerXProvider()` calls) has
  run. This file does that boot, then re-runs the same frozen oracle against it.
- **`notion-connectors-test.ts`** — an app-level test unlike the synthetic-config core suites: it
  resolves the REAL `agent/access/bundles.ts` + `providers.ts` + plugin registry (the exact config
  the app ships), the same way `access-preview.ts` and `connections-lint.ts` do.
- **`sandbox-backend-test.ts`** — a plain unit test for the off-Vercel sandbox backend selection
  logic. Pure module, no eve/app graph, no provider-boundary reason to be here — it's app-tier by
  historical placement, not by the OPE-114 split.
- **`boot-smoke-test.ts`** — the COLD-START gate (OPE-376). Imports every module under `agent/`
  against a throwaway state dir and fails on any module-load throw, then asserts channel-route
  uniqueness, schedule-cron validity and the dynamic model's `step.started` binding. App-tier by
  necessity: it boots the app's real graph, which is the one thing no other test in the tree does.
- **`deploy-test.ts`** — offline unit tests *for* the deploy-ops scripts (`scripts/deploy/*`):
  rollback target selection, known-good pointer read/write, Vercel REST response parsing, the
  credential and project resolution a CI runner needs, probe→decision, env validation, and the
  `deploy:verify` exit codes on the real script. The Vercel API and the HTTP probe are both
  stubbed — nothing here touches the network. Same "tests for a live pack" shape as
  `e2e-driver-test.ts`.
- **`scripts/deploy/`** — the operator/agent deploy safety net itself: `lib.ts` (all the logic,
  every seam injected), plus the three thin CLIs `rollback.ts`, `record.ts`, `verify.ts`. NOT in
  any `test:*` chain — they need a live deployment and a credential; `deploy-test.ts` is their
  offline coverage. See `docs/deploy/rollback.md`.
- **Cold-start / supply-chain lints** (`traced-externals-lint.ts`, `eve-patch-lint.ts`,
  `env-docs-lint.ts`, OPE-376) — static gates in the `test` chain for the three change classes
  that pass typecheck + tests and then break the *running* agent: an untraced external (dead lambda
  at cold start), a dependency patch that silently didn't apply, and an env var no operator could
  know to set. Same shape as `model-ids-lint.ts` — derive the expected facts from the real source
  (eve's own bytes, the committed patch file) rather than hard-coding a list that rots.
- **Non-test infra** (not part of the app/core split, don't wire these into a `test:*` chain):
  `access-diff.ts`, `access-lint.ts`, `access-preview.ts`, `config-validate.ts`,
  `connections-lint.ts`, `consequence-lint.ts`, `window-gate-lint.ts`, `source-gate-lint.ts` (CLI
  lint/preview tools over the real app config), `ops-mcp.ts` (the ops MCP server entry point),
  `register-discord-commands.ts` (the one-off GLOBAL Discord slash-command registration CLI — the
  deployment registers its own guild-scoped commands at boot, OPE-1687),
  `docker-smoke.sh` (shell smoke check for the Docker sandbox tier).

## Adding a new file

- **Provider-specific, needs the real bundle:** name it `<provider>-provider-integration-test.ts`
  if it's the cross-cutting "pin the registered rows" suite for that provider, or
  `<provider>-<mechanism>-test.ts` if it's testing that provider's own native surface code
  end-to-end (mirror the `discord-*` files above).
- **Cross-cutting, just needs *some* bundle registered:** name it `<concern>-test.ts`, same as its
  core-tier peers, and register whatever fixtures it needs via
  `packages/core/scripts/_slack-test-stubs.ts` plus a real bundle import.
- **Doesn't need a bundle at all:** it almost certainly belongs in `packages/core/scripts/`
  instead — a core script can synthesize everything it needs and stays portable. Only add it here
  if there's a concrete reason it can't live in core (import a provider package, exercise the app's
  own boot wiring, resolve the app's real config file).
- Wire it into `npm test` via a `test:<name>` entry in the root `package.json`, and into the
  `test:discord-provider` (or a new) aggregate chain if it belongs to one.
