# The `oe/cloud-proof` lane — an alternative to a paid Actions runner

This repo has no CI yet, so no workflow posts a check on a pull request. The suites run in a
session the maintainer controls, and a session that holds real `gh` auth posts the result as one
commit status, `oe/cloud-proof`. `npm run deploy:ci-gate` (`scripts/deploy/ci-gate-lib.ts`)
accepts that status as proof under the conditions below.

This page documents the evidence format, the two scripts, and — first — the trust model, stated
plainly.

## The trust model, stated honestly

**`oe/cloud-proof` is self-reported by a sandbox the operator configures.** The cloud session that
runs the suites is the same session that writes the evidence lines this status is built from. It
is not an independent third party attesting to the result; it is the worker reporting on its own
work, then mechanically checked and posted by a second, separate session (the maintainer) that
did not run the suites itself.

That is **the same trust root as a self-hosted GitHub Actions runner — no more, no less.** A
self-hosted runner is also a machine the operator configures and trusts to report its own exit
codes honestly; GitHub's own hosted runners are the only tier with a materially different trust
root (an infrastructure the operator does not control at all). `oe/cloud-proof` does not claim to
be that. If your threat model requires a third party who did not run the code to attest to the
result, this lane does not provide that — use hosted Actions runners for the commits where it
matters, or treat this status the same way you would treat a "tests passed" claim from any single
machine you configured and nobody else watched run.

Two design choices narrow the risk from there:

- **The evidence format is mechanical, never narrative** (see below) — a cloud session's own
  optimistic or mistaken summary ("all green!") cannot become a `success` status; only a literal
  `exit=0` on every reported suite can.
- **The maintainer, not the sandbox, holds the credential that posts.** A cloud sandbox session
  never has `gh` write access to this repo's statuses; it can only produce evidence text. The same
  split is what makes `oe/upgrade-fence` mean anything — see
  [the upgrade diff fence](../security/self-upgrade-fence.md#the-attestation--the-rung-outside-the-judged-session).
  The
  maintainer is the one session in this flow with the authority to make GitHub say anything, and
  it only ever does so after independently re-parsing the evidence itself
  (`scripts/deploy/cloud-proof-verify-lib.ts`) — it does not trust the sandbox's own "I passed"
  claim, only the mechanical evidence lines.

## The evidence format

A cloud run's evidence is a plain text file — a log, a report, whatever the sandbox's harness
writes — that MAY contain any narrative text at all. The only part that means anything is a line
matching, byte for byte after trimming a trailing `\r`:

```
OE_PROOF sha=<git sha, 7-40 lowercase hex chars> suite=<name, no whitespace> exit=<integer>
```

One line per suite the cloud run executed, e.g.:

```
OE_PROOF sha=abc1234 suite=typecheck:all exit=0
OE_PROOF sha=abc1234 suite=test exit=0
OE_PROOF sha=abc1234 suite=build exit=0
OE_PROOF sha=abc1234 suite=test:integration exit=0
```

Everything else in the file — build logs, an agent's own commentary, timestamps — is ignored.
`scripts/deploy/cloud-proof-verify-lib.ts`'s header comment is the canonical spec; this page
summarizes it.

A run whose sandbox cannot hold a whole tier splits it across N one-worker runs and names each one
`suite=<tier>--shard=k/N`. A COMPLETE, all-green series — every k in 1..N, one N, every shard
exit 0 — proves the tier itself, and the landing renders it `test:integration=0 (4 shards)`; an
incomplete series, a mix of two Ns, or one red shard proves nothing about the tier. The rule lives
in `collapseShardSeries` (`scripts/deploy/cloud-proof-verify-lib.ts`). `parseEvidence` reads it
(OPE-2282): evidence whose shard lines are all green but do not form a complete series, with no line
for the tier itself, is `unparseable`, so `deploy:cloud-proof-verify` exits 1 and
`deploy:cloud-proof-post` refuses it. A red shard is a `fail`. The `oe/cloud-proof`
status description reads the rule too. The status
description collapses the series for the same reason: four literal shard names cost about 120
characters, which pushed the description past GitHub's 140-character cap and cut it off mid-name.

Since OPE-1814 the split is no longer hand-made. `npm run test:integration` shards the tier itself
in a sandbox — `scripts/it-shards.ts` reads `OE_IT_SHARDS`, and with no value plans one shard per
32 tier files (at least 4) under `CI` or a memory cgroup, and 1 on an uncapped box — runs the
shards sequentially, takes the WORST shard's exit code as the tier's, and prints ONE
`OE_PROOF … suite=test:integration exit=<code>` line after the last shard. Since OPE-2235 NO shard
builds the target: `suite-lock-run.ts` runs `npm run test:integration:prepare` once, inside the suite
lock, before the first shard, which is what makes a split fine enough to hold the per-process file
count flat affordable. A prepare step that fails runs no shard at all and the run reports its exit, so
the tier's line still carries the exit the run really had. So a run's evidence carries the tier's own line and needs no shard rule at all; the
`--shard=k/N` names above stay supported for a run that splits the tier by hand, and for single-shard
mode below. A **targeted** leg
(`npm run test:integration -- <file>`) prints no tier line: it is not the tier.

**Single-shard mode fans the tier out (OPE-2282).** `OE_IT_SHARD=k/N npm run test:integration` runs
the prepare step, then ONLY the `--shard=k/N` pass the full series runs at position k, and prints ONE
`OE_PROOF … suite=test:integration--shard=k/N exit=<code>` line in place of the tier's. The
orchestrator runs the N shards in N sandboxes on one sha and joins their lines with the main run's
three. That file passes only when the series is complete and green, by the rule above. The split is
vitest's own: a sha1 of each root-relative path, sorted, then cut into N runs that differ by at most
one file. It reads nothing but the file list, so one sha plans one split in every clean sandbox (a
stray untracked test file changes the list; each run logs the list's digest, and nothing compares
the digests yet).
`npm run test:suite-lock` proves that N single-shard plans cover every tier file exactly once. A value
that is not `k/N` with 1 ≤ k ≤ N, a targeted leg, or an `OE_IT_SHARDS` that names another N exits 2
before the run takes the lock. With `OE_IT_SHARD` unset, nothing changes.

### The tier proves its own write fences on a root runner

A cloud sandbox runs every build as **uid 0**. Root holds `CAP_DAC_OVERRIDE`, which bypasses the
POSIX permission bits. Several integration tests prove that a write is **refused**, and they read
that refusal out of those bits. Under root the same write succeeded, so the assertions inverted:
`tests/integration/memory/memory.test.ts` reported two failures, and
`tests/integration/sandbox-session-sweep.test.ts` skipped its read-only arm. A run could not then
hand over its own `suite=test:integration exit=0` line.

`npm run test:integration` now drops that bypass before it spawns vitest. `scripts/dac-fence.ts`
measures whether a read-only directory really refuses this process. When it does not,
`scripts/suite-lock-run.ts` spawns the suite through
`capsh --drop=cap_dac_override,cap_dac_read_search`. The uid does not change, and no file changes
owner. The kernel then applies the ordinary permission check to the writes these tests make, so the
refusal reads the same as root and as an unprivileged user. The bounding set is inherited, so
vitest, its workers and each worker's agent host are all fenced by that one spawn.

🔴 The drop is **narrow on purpose**: only these two capabilities bypass the permission-bit checks
the tests read. The run keeps every other capability, `CAP_FOWNER` among them, and a fenced root is
therefore not an unprivileged user in general — it is one for the checks under test. The sweep's own
`chmod` needs no capability either way, because the test owns the fixture it chmods.

A host that cannot drop the capability **fails the run**. It never runs the tier unfenced, because a
suite that cannot fail is worse than one that will not start.

The earlier remedy was a non-root `runner` user. A cloud sandbox refuses both `useradd` and
`chown`, so that recipe is gone (OPE-1989, OPE-1990).

## `npm run deploy:cloud-proof-verify -- <evidence-file>`

Parses the file into `{ sha, suites: [{ name, exit }], verdict }`, where `verdict` is:

- **`pass`** — every evidence line agrees on one sha, at least one suite was reported, every
  `exit` is `0`.
- **`fail`** — every evidence line agrees on one sha, and at least one suite's `exit` is non-zero.
  A narrative claiming success elsewhere in the file changes nothing.
- **`unparseable`** — no evidence lines found (empty, truncated, or unrelated file), or the
  evidence lines disagree with each other (two different shas, or the same suite reported with two
  different exit codes), or an all-green shard series is incomplete and the tier has no line of its
  own (OPE-2282). Ambiguous evidence is refused, never guessed at — this can never become a
  `pass`.

Exits `0` only on `pass`.

## `npm run deploy:cloud-proof-post -- <evidence-file> --sha <sha> --session-id <id> [--target-url <url>] [--dry-run]`

Re-parses the same evidence file, then builds (and — without `--dry-run` — runs) the `gh api` call
that posts the `oe/cloud-proof` commit status: `state: success` on a `pass` verdict, `state:
failure` on a `fail` verdict, and a `description` that pins the `--session-id` the evidence came
from, so a reader of the commit status can always trace it back to the transcript that produced
it.

**It refuses to post — never touches `gh` — when:**

- the verdict is `unparseable`;
- the evidence's own sha does not exactly match the `--sha` the caller supplied (two disagreeing
  sources of "which commit is this" is exactly the ambiguity this lane fails closed on);
- no `--session-id` was given.

`--dry-run` prints the exact `gh` invocation and posts nothing — this is the ONLY mode a cloud
sandbox session should ever invoke this script in. Posting for real is the maintainer's job: a
session holding real `gh` auth, running this command against evidence it has independently
verified.

## `npm run deploy:merge-attest -- --pr <n> --transfer --merge-sha <sha> [--dry-run]`

**The per-tip gap this closes (OPE-1168).** A run's proof rides its BRANCH sha. A squash merge mints
a NEW commit, and a commit status does not follow a sha it was not posted on. So every `main` tip
needed its own proof run, and the deploy gate's walk-back distance grew with each proofless merge —
the first live case was 17 commits and 166 files behind the tip, and the gate correctly refused.

This leg moves the head's green `oe/cloud-proof` onto the merge commit. **Tree identity is what
makes the transfer sound.** A proof asserts that a set of bytes passes the suites. A commit's tree
*is* that set of bytes; the sha additionally hashes the parents, the author and the message, none of
which the suites read. A squash of a branch whose base did not move produces a different commit with
the same tree, so the proof holds. A squash that absorbed other work has a different tree, and this
refuses — that tip needs its own proof run.

The known assumption, stated rather than implied: the suites are a function of the tree. A suite
that read the commit sha or the git history would sit outside it. The `OE_PROOF` line records a sha,
but that is the evidence's own label, not an input to any assertion.

🔴 **ONE INPUT COULD SIT OUTSIDE THAT ASSUMPTION, AND IT IS OPT-IN FOR EXACTLY THIS REASON** (OPE-2235).
The integration tier's target is built by `npm run test:integration:prepare`, which can RESTORE `.output`
and `.eve/sandbox-cache` from a cache branch on a git remote instead of building them — and every fork
then `import()`s the restored bundle, so those bytes run. A restored tier is therefore a function of the
tree AND of a mutable branch, whose only credential is a key blob in the same commit whoever pushed the
archive wrote: the trust boundary is push access to that remote. So the remote half is **off by default**
(`OE_IT_PREPARE_CACHE` is `local` unless a caller says `remote`), which keeps an ordinary tier run a
function of the tree alone. A run that must be beyond question — a proof run for a deploy — either leaves
the default or sets `OE_IT_PREPARE_CACHE=off`, which also ignores the local stamps and rebuilds from source.
The default also reuses the `.output` that an earlier `npm run build` built from the same key in this
checkout (`.oe-it-built.json`, OPE-2280). In a proof run, that build is the `build` gate just before
the tier. Like the prepare stamp, it carries the hand-run-build residual that `tests/integration/prepare.ts`
names.
`tests/integration/prepare-cache.ts` carries the reasoning and the measurements.

**It refuses to post — the status is never written — when:**

- the pull request is not merged, carries no `merge_commit_sha`, or names a merge commit other than
  the `--merge-sha` given (two sources of truth about which commit the merge produced);
- either commit's tree cannot be read, after one `git fetch` for a shallow clone;
- the two trees differ;
- the head has no green `oe/cloud-proof` to move;
- 🔴 the merge commit already carries a red or pending `oe/cloud-proof`. A proof run that judged that
  exact commit outranks one transferred onto it, and the more convenient of two proofs must never
  win.

Unlike `deploy:cloud-proof-post`'s refusals, these are reached **after** one to three authenticated
reads — the leg has to fetch the pull request and both commits' statuses to decide. `--dry-run`
stops the post, not the reads.

Run it as the maintainer, straight after the squash. The other leg of the same rung,
`--fence`, runs before the merge — see
[the upgrade diff fence](../security/self-upgrade-fence.md#the-attestation--the-rung-outside-the-judged-session).

## How the deploy gate accepts it (`scripts/deploy/ci-gate-lib.ts`)

`npm run deploy:ci-gate` still reads GitHub check-runs first, exactly as before OPE-1113 (AGENTS.md
§ Deploy rule 4). `oe/cloud-proof` is consulted **only when a sha has no check-run evidence**. On this repo that is now EVERY sha, because no workflow posts a
check-run at all. The ordering still matters for a fork that runs its own Actions: `oe/cloud-proof`
is never consulted, and can never override, a check-run-based verdict that already exists — a red
or in-flight Actions run stands exactly as decided, whatever `oe/cloud-proof` says. Two independent
proofs that could disagree must never let the more convenient one win.

**Two reads reach that door (OPE-1239).** "No check-run evidence" means either of these, and they
open the identical `oe/cloud-proof` lane:

- **GitHub answered and reported zero check-runs.** The normal state on this repo.
- **The token may not read the check-runs endpoint at all** — HTTP 403 with GitHub's own message
  `Resource not accessible by personal access token`. A live run died here: the gate refused with
  "could not read CI state" and never read the statuses, where that sha's green `oe/cloud-proof`
  was already posted.

🔴 **The second story breaks the "a red Actions run stands" guarantee above, and only a fork can
feel it.** When the token cannot read the check-runs, the gate has not seen them, so it cannot
honour a red it never read: a head carrying BOTH a red check-run and a green `oe/cloud-proof`
passes. On this repo that is inert — this repo has no workflow to post a check-run. **A fork that
runs Actions must give its deploy token `checks=read` instead of relying on this door.** A read
that did not happen cannot be told apart from one that found nothing, so the gate cannot close
this gap itself.

🔴 **The 403 body is reported by OPE-1239, not measured.** `isTokenForbiddenResponse` matches the
JSON `message` above because that is the wording the ticket records for that run. No run has
reproduced it: the sandbox token probed on 2026-08-27 reads this endpoint at HTTP 200. If that
run's real body carried different wording — GitHub's App form, a bare-HTML 403, or a `gh` failure
rather than a REST one — the tolerance does not fire and the next release run refuses in the same place.
Capture the body on the next occurrence before widening anything. The failure mode is loud.

The 403 tolerance is narrow on three axes, and each one is load-bearing:

| Axis | Tolerated | Still refuses |
| --- | --- | --- |
| Endpoint | the check-runs read | the combined-status read — it carries the proof itself |
| Error class | HTTP 403 whose JSON `message` is GitHub's not-accessible-by-PAT wording | 401, 404, 429, 5xx, a timeout, a spawn failure, a truncated page, a non-JSON body, and a 403 carrying GitHub's *App* wording (`not accessible by integration`) |
| Transport | the REST fallback, which yields a real HTTP status | a `gh` process that exits non-zero — this gate never classifies a CLI's prose |

🔴 **Tolerating the READ is not passing the GATE — but it does grant two passes, not one.** A 403
only routes the decision to the `oe/cloud-proof` lane, which grants exactly what a zero-check-run
read already granted:

1. the tip's own `oe/cloud-proof` is `success`; **or**
2. the tip has **no** `oe/cloud-proof`, and the ancestor walk-back finds the nearest first-parent
   ancestor whose own `oe/cloud-proof` is green, with an entirely non-runtime diff since then.

Do not read "still needs a green `oe/cloud-proof`" as "needs one on this sha" — shape 2 is a real
pass. A pending status, a red status, a status page that cannot be read, an unreadable diff, an
unreadable ancestor list, and exceeding the depth bound all refuse exactly as before. The pass and
refusal messages say the check-runs read was *forbidden* rather than *empty*, so an operator is
never told "no check-run exists" about a read the gate never performed.

**The token CAN simply be given the permission.** A fine-grained PAT does accept `checks=read` —
measured 2026-08-27 against this repo (`X-Accepted-Github-Permissions: checks=read`, HTTP 200), and
re-measured 2026-09-04 from a second sandbox with the same result. That contradicts OPE-1239's own
"GitHub Apps only" claim. The tolerance is still worth having, because the gate must not lose its
proof lane to a token permission this repo does not otherwise need. Granting `checks=read` and
keeping the tolerance are complements, not alternatives — and per the fork warning above, a fork
that runs Actions needs the grant.

🔴 **THE RULING ON THIS REPO'S DEPLOY TOKEN: leave `checks=read` OFF (OPE-1243).** No workflow here
posts a check-run, so the permission buys nothing but a wider token. The gate reaches its proof lane
through the zero-check-run read on every sha, and through the 403 tolerance if a token ever cannot
read the endpoint at all. **A fork that runs Actions must decide the other way** — there the
permission is what makes a red check-run bind, per the fork warning above.

**Where the wrong reading came from.** OPE-1117's receipt (2026-08-24) was a read of GitHub's docs
plus community discussion #129512, never a live probe, and it concluded that a classic PAT with the
`repo` scope was the only shape that could read check-runs. A live 200 carrying
`X-Accepted-Github-Permissions: checks=read` from a `github_pat_` token beats a documentation read.
Nothing in the tree still recommends the classic-PAT remedy; the claim survived only on the tickets.

Within that narrow door:

- **The tip's own `oe/cloud-proof` status is `success`** → pass.
- **The tip has no `oe/cloud-proof` status at all** → walk back through first-parent ancestors
  (`listFirstParentAncestors` plus the shared `scripts/ci/skippable-paths.ts` predicate) for the
  nearest ancestor with a green `oe/cloud-proof`, and verify the cumulative diff since then is
  entirely non-runtime.

  This is the ONLY walk-back the gate has. A second one, keyed on a check-run named
  `eve build + integration tier`, existed until OPE-1224 and is deleted: that name came from the
  `.github/workflows/ci.yml` job that is now removed, so no check-run can carry it any more. A sha that
  HAS check-runs is now decided on those check-runs alone.

  🔴 **"No status" means a status page the gate READ COMPLETELY and found nothing in — never a
  page it could not finish reading (OPE-1118).** The walk-back is the one door through which an
  ANCESTOR's green proof stands in for this sha, so an unread status must never open it: a
  truncated page would let an ancestor's green proof substitute for this sha's own unread red.

  The gate asks GitHub for an explicit page size and **follows the pages** until one comes back
  SHORT (OPE-1124). It judges completeness by the **page bound**, not by `total_count`: GitHub
  returns `min(remaining, per_page)`, so a page shorter than the bound is provably the last one,
  and a page that fills the bound means there may be more — which is a reason to read page 2, not
  to refuse. A read that fills **every** page the gate will follow (10, so 1000 records for one
  commit) still refuses: that is either a repository shape nothing here anticipated or an endpoint
  ignoring `page`, and reading on forever is the one thing a deploy gate must not do.

  `total_count` is read as a second, independent check, and **only on a read that took one page** —
  there the two possible meanings of the field agree, so a disagreement with the delivered length
  means the response does not describe itself the way this code reads it. Across several pages the
  two meanings diverge, and this endpoint's `total_count` semantics are not documented, so the
  check is not applied there; the short final page already proves completeness. Every refusal lands
  as a transport failure, below.
- **`pending`, a red state (`failure`/`error`/anything unrecognised), a status page that cannot be
  shown to be complete, an unreadable ancestor chain, a runtime path in the cumulative diff, or
  exceeding the walk-back depth bound** → refuse. Fail closed on every ambiguity, same discipline
  as the rest of this gate.
