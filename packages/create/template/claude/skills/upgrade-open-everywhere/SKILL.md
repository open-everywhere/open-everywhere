---
name: upgrade-open-everywhere
description: Upgrade this Open Everywhere app to a newer release — read the release notes between the installed and the target version, run `oe upgrade`, review the roster.lock.json diff, open a pull request, and confirm the deployment after it ships. Use when the user wants to upgrade, update, or take a new version of Open Everywhere, or asks what is in a newer release.
---

# Upgrade Open Everywhere

One procedure, two drivers. You run it here, in a checkout of this app. The agent runs the same
steps on itself, in its own sandbox, against this same repository. Nothing below differs between
the two.

The procedure is `npx oe upgrade`. It is deterministic: it reads the release record that ships
inside `@open-everywhere/core`, bumps every package together, installs, applies the config
codemods the notes name, rebuilds the roster and proves the tree still builds.

## Golden rules

- **`oe upgrade` writes and installs.** Show the command, get a yes, then run it. `--plan` writes
  nothing, so run that first, every time.
- **Never merge the pull request yourself.** An admin merges it, and the merge deploys.
- **Never hand-edit `roster.lock.json`.** `oe build --accept` writes it. Your job is to READ the
  diff: every line is a capability decision, and a new tool that nobody looked at is how an
  upgrade quietly widens what the agent can do.
- **Never edit `UPGRADING.md`.** It is generated from `upgrading.json` beside it.
- **No secret reaches the chat, the branch or the pull request.** An upgrade never needs one. A
  release that adds an env NAME tells the admin to set the value in the deployment's environment.
- Every command runs from this directory (the app root).

## 1. Where you are, and where you are going

```
node -p "require('./node_modules/@open-everywhere/core/package.json').version"  # installed
node -p "require('./package.json').dependencies['@open-everywhere/core']"       # pinned
npm view @open-everywhere/core version                                          # latest published
```

**Read the installed one, not the pin.** `oe upgrade` writes the pins before it installs, so an
upgrade that stopped part way leaves a manifest that names a version the app is not running.

The eleven packages publish in lockstep, so one version answers for all of them. Agree the target
with the user before you go on. Taking the latest is the normal choice.

## 2. Read the notes between the two versions

```
npx oe upgrade --to <target> --plan
```

It prints the window — every release above the installed version, up to the target — and writes
nothing. Each entry names:

| Field | What it means for this deployment |
| --- | --- |
| BREAKING | behaviour that changes. Read it before anything else. |
| CONFIG | a change to this app's own config files. A codemod applies some; the rest are yours. |
| ENV + / ENV - | an env NAME the deployment starts or stops needing. The admin sets the value. |
| MANUAL | a step outside the files — a dashboard change, a URL to re-paste, a key to rotate. |

The installed copy of the record cannot know about a release published after it, so `--plan`
says plainly which crossed versions it has no entry for. The full window is printed again in
step 3, after the install puts the target's own copy on disk. The same text is in
`node_modules/@open-everywhere/core/UPGRADING.md`.

**Stop and ask the user** when the window holds a breaking change, an env change or a manual step.
Those are decisions, not steps.

`--plan` also prints a **template drift** report. It compares every file the scaffold copied into
this app with the TARGET release's `@open-everywhere/create` template, and lists each one that
differs, with a one-line size of its diff. An upgrade changes only `package.json` and
`package-lock.json`, so a scaffolded
file stays as the old template wrote it. A stale copy can typecheck and build and still break the
deployment: the 0.1.2 `agent/lib/register-adapters.ts` registers no Postgres client on a bare
`DATABASE_URL`, so a Vercel+Neon deployment of 0.1.4 fails at its first write.

`agent/lib/register-adapters.ts` is the exception once it is current. The current template's copy
is ONE call, `registerDefaultAdapters()` from `@open-everywhere/adapters`, plus a `customAdapters`
hook. The adapter wiring, the store selection rules and the floors live in that package, so the
package upgrade carries them, and the file needs no hand-merge. Sync it ONCE, from a copy that wires
the adapters by hand to the one-call copy: move any adapter the user registered by hand into the
`customAdapters` hook. After that, a SYNC line for this file is a comment or hook difference only.

| Line | What to do |
| --- | --- |
| SYNC | a template-owned file — wiring, a script, `AGENTS.md`, `README.md`, `.env.example`, a skill. Plan to copy the target's file over this one, after you read the diff. |
| config | the app's own config-as-code. A difference is normal once the app is configured. Merge the template's change by hand only if the user wants it. |
| DELETE | a release up to the target removed this file from the template, and the app still has it. Plan to delete it. eve 0.69 and later refuse `agent/instrumentation.ts` at build. |
| app-owned | `.oe-template-ignore` names the file, so the app owns it. Nothing to do. |

`.oe-template-ignore` at the app root lists the template files the app removed or owns on purpose:
one app-relative path per line, a trailing `/` for a directory, `#` for a comment. The report prints
nothing for an ignored file the app does not have, and one `app-owned` line for one it has. Add a
path only when the user says the app owns that file. Never add one to silence a SYNC line you have
not read.

The report never writes a file. If it says the drift check did not run, compare the files with the
target's template by hand. An installed core without the report prints none: `oe upgrade` runs the
INSTALLED core's code. So when `--plan` prints no "Template drift" heading, run
`npx oe upgrade --to <target> --plan` once more after step 3. The target's own code prints the report then.

## 3. Run the upgrade

```
npx oe upgrade --to <target>
```

In order, and it stops at the first step that fails:

1. bump every `@open-everywhere/*` package to the target, renaming a dependency on the retired
   unscoped `create-open-everywhere` to `@open-everywhere/create` as it goes;
2. pin `eve` to the version the target core declares as its peer;
3. `npm install` — its `postinstall` runs `oe-eve-patch`, which the app refuses to boot without.
   Before it, the run drops the `package-lock.json` entries of `eve`, of every
   `@open-everywhere/*` package and of every package that peers on one of them, so npm resolves
   that set again. If the install still stops with ERESOLVE (a core at 0.2.1 or earlier does not
   drop them), run `rm package-lock.json && npm install`, then run `oe upgrade` again;
4. run the config codemods the target's notes name, and print the migrations that are yours;
5. `oe build --accept` — this rewrites `roster.lock.json`;
6. `npm run typecheck`;
7. `npm run build`.

A failed step prints which one and leaves the tree where it stopped. Fix the cause and run
`oe upgrade` again: it RESUMES, from whichever step stopped it.

It can do that because it writes `.open-everywhere/upgrade-resume.json` just BEFORE the install
and deletes it only when the run completes. Before, not after: a failing `npm install` can still
leave the new packages on disk, because npm writes the tree first and runs `postinstall` after.
That file records the version the run started from, so the retry reads the SAME release notes,
runs the same codemods and takes the same refusals — a retry never quietly forgets a migration
you still owe. The directory is gitignored, so the marker never reaches a pull request, and it
survives `rm -rf node_modules && npm ci`.

Never delete the marker to make `oe upgrade` say there is nothing to do. It is the only record
that a run began taking the target and never proved the tree.

**If it refuses with "the release notes name codemods this CLI does not hold":** the running core
is 0.1.4, and it runs codemods from its own registry. When it stops after the install, the
target's own `oe` is installed now. Run `oe upgrade` again: the resume marker keeps the window, and
the target's registry applies the codemod. Apply the migration by hand only if that run refuses
too. Do not work around the refusal — it exists because a half-applied migration that reports
success is worse than a stop. A later core only WARNS with that text before the install, because
the target's own registry decides.

**If it refuses with "the installed core's registry does not hold":** the target release names a
codemod that it does not ship, and no codemod ran. Run `oe upgrade --to <a later release that holds
it>`. The resume marker keeps the refused release in that run's window, so that run applies the
codemod. Do not delete the marker to get past this refusal.

## 4. Review the diff

```
git diff roster.lock.json
git diff package.json package-lock.json
git status
```

Read `roster.lock.json` line by line. A new mounted tool, channel, schedule or connection is a new
thing the agent can do. If a line surprises you, say so to the user before the pull request — this
is the review surface, and it is the only one.

Then run the app's own checks once more if anything above was fixed by hand:
`npm run typecheck && npm run build`.

Then act on the template drift report. A core that carries it prints it again after the install;
if this run printed no "Template drift" heading, run `npx oe upgrade --to <target> --plan` now to get it. For
each DELETE line, delete the file. If the user says the app owns it, keep it and name it in
`.oe-template-ignore`. For each SYNC line, read the diff against the installed template, for example
`diff node_modules/@open-everywhere/create/template/agent/lib/register-adapters.ts agent/lib/register-adapters.ts`.
Keep any edit the user made on purpose, and copy the template's file otherwise. For
`agent/lib/register-adapters.ts`, the user's edits belong in the `customAdapters` hook of the
template's one-call copy, never in a hand-wired copy: a hand-wired copy does not get the product's
wiring changes on the next upgrade. A file under the
template's `claude/` directory lands in the app's `.claude/`, and the template's `gitignore` is the
app's `.gitignore`. Name every synced file in the pull request.

Run `npx oe build --check`. It also proves the machine-owned `*.generated.ts` overlays hold only
data. If it says an overlay has older header text, that is not a failure: run
`npx oe overlays normalize` and commit the header change with the upgrade.

## 5. Open a pull request

Commit on a branch, never on the default branch. The body carries:

- the versions: `<installed> → <target>`, and the `eve` pin;
- the release-note window, as `oe upgrade` printed it;
- what changed in `roster.lock.json`, in your own words;
- **the env names the deployment needs before this merges**, names only;
- the manual steps, and who does each one.
- the template files you synced or deleted, and each SYNC or DELETE line you left as it is, with the reason.

Then stop. The admin reviews the lock diff and merges. The merge deploys.

## 6. Confirm the deployment after it ships

A green build is not a working deployment.

**Read the status route, `GET /eve/v1/oe/status`.** It ships from core 0.1.4. It is an
unauthenticated, non-sensitive JSON route that reports the deployment's version, whether the
database is reachable, the sandbox backend, whether egress is enforced, whether the model route
answers, and the Slack posture. A deployment can hide it on purpose, with a roster exclusion or an
edge rule (`docs/deploy/contract.md` § Hiding the status route). A 404 or a 403 there can be that
choice, not a fault: ask the operator before you call it broken. Never read some other route as if
it were this one. When the route answers, report each field, in this order:

1. **version** — it reads the target. If it still reads the old version, the deploy has not
   finished, or it failed. Nothing below is meaningful until this matches.
2. **database reachable** (the `postgres` verdict).
3. **sandbox backend**, and **egress enforced**.
4. **model route answers.**
5. **Slack** — credentials present, workspace installed, events verified.

**When the route does not answer**, on a core older than 0.1.4 or on a deployment that hides it,
confirm what you can and say plainly what you could not:

- the deploy finished, from the host's own deployment log;
- `npx @open-everywhere/create --check --json --host https://<host>` — its `build-deploy` step
  passes only on the deployed Slack route's own `401 unauthorized`, which proves boot and
  routing;
- Slack's **Event Subscriptions** still shows **Verified**.

A fact that went from good to bad across the upgrade is the upgrade's fault until proven
otherwise: say so, and offer to roll the pull request back rather than patching forward on a live
deployment.

Last, ask the user to send the app a direct message. An answer is the only proof that holds.
