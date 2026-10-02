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
