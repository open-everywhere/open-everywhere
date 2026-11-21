# The upgrade diff fence

An agent that can upgrade itself can, in principle, edit its own guardrails while it does it. This
page is the control that stops that, and the deployment shape it depends on.

## The residual it closes

A self-upgrade routine needs a declared `pr.open` permission. An unattended fire can wait on a
permission card only for a bounded window (120 s by default, `approvals.routineCardWaitSeconds`), so
the permission is normally armed once on the routine's creation card and then stands. A routine's declared permissions are visible in
`list_routines`, revocable without cancelling the routine, and invalidated wholesale when the
routine's text is edited.

But `pr.open` is **kind-grain**. The declaration is the bare string `pr.open`. It names no repository and
no diff shape. So a routine holding it may open a pull request against any repo its bundle grants,
with any diff — including one that rewrites the access plane. The invariant that violates:

> The upgrade path is version bumps plus declared migrations. It is never an arbitrary self-edit.

Two fences hold that invariant. One is configuration you write; one is code that ships.

## Fence 1 — the repo fence (your configuration)

Bundles grant repositories by exact `owner/name`, and a repo the bundle does not name is refused at
the call. So: **bind the self-upgrade routine to a domain whose bundle grants only your own Open
Everywhere fork.**

```ts
defineBundle({ name: "self-upgrade", repos: ["acme/open-everywhere"] })
```

This closes "any repo". It needs no code and it is the required deployment shape — the diff fence
below assumes it.

The chat driver ("upgrade yourself", `upgrade_self`, OPE-2237) needs the same shape: its first step,
`checkout_repo`, refuses in a room whose bundle does not grant `accessRequests.configRepo`. Its
org-admin check is a front door. Fence 2 below runs only at this repository's merge preflight, not
on a deployment's config repository, so there the person who merges is the control: set branch
protection so that only an admin can merge. See
[Upgrade from chat](../deploy/consuming-as-packages.md#upgrade-from-chat-upgrade-yourself).

Two configuration rules go with it:

- **Never name the `workflows` capability on that binding.** GitHub refuses a push that adds or
  changes a file under `.github/workflows` unless the token carries `workflows: write`, and the
  default job set does not. On a deployment whose runner is a GitHub Actions workflow, that refusal
  is what stops an "upgrade" from deleting the job that judges it. (This repo's own runner is an npm
  rung, not a workflow — see [the runner](#the-runner-the-self-merge-preflight) — so the rule matters
  to your deployment, not to this repo.) Naming the capability on the upgrade repo gives it away. See
  [Source control § Per-binding capability sets](../capabilities/source-control.md).
- **Configure the GitHub App, not a `GITHUB_TOKEN` personal access token** (`github.auth: "app"`, the
  shipped default; the token mode is OPE-2530's). The App gives the agent
  its own identity and its own narrow permission set, which is what
  [Source control](../capabilities/source-control.md) rests on. The diff fence below does not depend
  on it: since OPE-1315 the fence reads no author at all.

## Fence 2 — the diff fence (code, armed at the self-merge preflight)

`scripts/upgrade-diff-fence.ts` is the judgement. **`npm run deploy:merge-fence` is what calls it.**
The rung reads a pull request from the GitHub API, extracts the fence from that pull request's base
ref, runs that copy against the pull request's own changed-file list, and exits 1 on a `refuse`
verdict. A cloud session runs it as the last rung before a self-merge and merges only on exit 0 —
see [the runner](#the-runner-the-self-merge-preflight) below for why that seam and what it does not
reach.

The rule the driver applies is one sentence:

> A pull request must not change a protected path.

**It does not read who wrote the pull request.** The fence once refused only an *agent-authored*
diff and warned on a person's. That distinction is gone (OPE-1315) — see
[Why there is no authorship test](#why-there-is-no-authorship-test).

### Why a merge rung and not the tool

- `open_pull_request` freezes `{repo, head→base, title, body, headSha}` onto an approval card and
  stage-pushes to a hidden `refs/oe-pending/<head>`. Publication is host-side on a member's click,
  pinned to that sha. So the sha the rung judges is exactly the sha the human approved.
- A merge rung is the only one that sees the **whole diff**. A card shows a title, a body and a sha.
  Asking an approver to review a hundred version-pin lines is a gate in name only.
- Merge is what ships. A gate at merge is a gate on the consequence.
- A gate inside the tool would have to judge **intent** ("is this really an upgrade?"). A gate at the
  merge judges **bytes**.

### Why there is no authorship test

The changed-file list is the whole input. Every byte of a diff is written by whoever proposes the
diff, so nothing *in* a diff can prove a pull request is safe. That argument used to pick which
**out-of-diff** signals armed the fence: `pull_request.user.type == "Bot"` (GitHub derives it from
the token the pull request was opened with) and an `oe-upgrade:` trailer. A diff that fired neither
read as person-authored, and the fence warned instead of refusing.

**Both signals stay silent when an agent opens a pull request under a person's identity.** An agent
that acts through a person's GitHub token writes no trailer, and `user.type` reads `"User"`. Nothing
armed, and an agent's access-plane diff got a warning and an exit 0. This was measured twice
(OPE-1279 and OPE-1315).

The rule is:

> Every pull request whose diff touches a protected path refuses at the fence, whoever authored it.
> The merge then requires an explicit review-and-override.

The rationale is that an agent can open a pull request under a person's identity, so a signal that
can misclassify is weaker than no signal at all. What the fence gives up is the ability
to wave a person's hand-written config change through. That change now takes the same override —
which is what a guardrail change was always meant to get, and the override is the hand-review flow
that already existed, now mechanically forced.

The refusal names that remedy in its own text: **`protected path — requires orchestrator
review-and-override`**.

### The protected set

The list lives in `scripts/upgrade-fence/manifest.ts`, one entry per reason. A path that ends in `/`
is a directory prefix, and it covers that directory and everything under it. Every other path is an
exact file. The manifest holds no globs.

| Rule | Paths | Why |
|---|---|---|
| `core-access-plane` | `packages/core/agent/access/` | The bundle resolver, capability sets, the untrusted-content envelope, the seat shape, the egress fence, the human-only-invariants manifest. |
| `core-approvals-plane` | `packages/core/agent/approvals/` | The gate that requires a human. One file decides which pending kinds may carry a standing grant. |
| `core-audit-chain` | `packages/core/agent/audit/` | The hash-chained record of what the agent did. |
| `github-permission-sets` | `packages/core/agent/scm/mint.ts` | The mint bodies that decide what the agent's own GitHub credential may do. |
| `deployment-access-config` | `agent/access/` | Your hand-written bundles, grants, credential bindings and network access. |
| `merge-gate-surface` | `scripts/deploy/`, the three `scripts/deploy-{ci-gate,cloud-proof-verify,cloud-proof-post}-test.ts` suites, `.github/CODEOWNERS` | Everything that decides whether a change may merge: the deploy enforcement scripts, the tracked run definitions a cloud session follows, those enforcers' own proving suites, and the code-owner list. A neutered test reports a clean scan, so a test is protected with its enforcer. The post-deploy rungs (`deploy-smoke` and friends) stay outside — they gate a deploy, not a merge. |
| `the-fence-itself` | `scripts/upgrade-fence/`, `scripts/upgrade-diff-fence.ts`, `scripts/upgrade-diff-fence-test.ts`, `scripts/deploy-merge-fence-test.ts`, `scripts/deploy-merge-attest-test.ts` | An upgrade that may rewrite its own fence has no fence. The last two are the suites that prove the pre-merge rung is reached and that its verdict lands on the pull request head. |
| `security-lint-drivers` | the six security lint scripts | A protected manifest read by a neutered driver still reports a clean scan. |

It is a blocklist, not an allowlist of "the upgrade surface". An allowlist is not writable: a release
legitimately changes almost any source file, and every new file an upstream release adds would red
the fence for a reason that is not a security reason. The set above is small on purpose — it is the
files whose edit changes what the agent is *allowed* to do, not what it does.

Every path in the manifest is joined to the tree by `npm run test:upgrade-diff-fence`. A rule that
names a file somebody renamed away protects nothing and would read as green, so the suite refuses
instead. Matching is case-insensitive: git stores a path byte for byte, but a case-insensitive
checkout resolves `.../Access/bundle.ts` to the same file, and a case-exact match would let a
re-cased path through.

### The fence judges with the base branch's copy

A pull request can change `scripts/`. A fence executed from the head would therefore be a fence the
proposal rewrites. The runner extracts `scripts/upgrade-fence/` and `scripts/upgrade-diff-fence.ts`
from the **base ref** into a scratch directory and runs that copy.

`npm run deploy:merge-fence` does exactly that, from the pull request's own `base.sha`. It derives
the module list from the base tree rather than naming the files, so a base that grew a fence module
has that module extracted too — a half-copied fence would die on an import, and a fence that dies is
a fence that refuses everything. It **refuses a base with no fence at all** rather than fall back to
the head's copy. The design allows that fall-back for exactly one pull request in history, the one
that introduces the fence to a base without it; this repo passed that point at OPE-992, and a
fall-back that can still fire is one a proposal could arrange for by deleting the fence from the
base.

### It fails closed

No credential, an unreadable event payload, a failed API call, or a file listing GitHub truncated at
its 3000-file cap: each exits 1. A fence that cannot see the diff never reports that the diff is
clean.

The runner fails closed on its own failures too, and each one refuses the merge rather than the
diff: no `GH_TOKEN`/`GITHUB_TOKEN`, no resolvable `owner/repo`, an unreadable pull-request record, a
base commit this clone cannot resolve after one `git fetch`, a driver that never spawned, or a head
sha that disagrees with the one the caller says it is about to merge. That last one is the same
discipline `deploy:cloud-proof-post` applies to its own evidence: clearing a sha the fence did not
judge proves nothing about the merge.

### The runner — the self-merge preflight

The only rung that runs **before** a merge on this repo is the maintainer's merge preflight.
`deploy:merge-fence` is that rung, and [CONTRIBUTING.md](../../CONTRIBUTING.md) names it as a
merge condition.

The alternative candidate was `deploy:ci-gate`. It judges a sha that is already on `main`, so it is
post-merge by construction and gates the consequence rather than the proposal. That rules it out on
its own.

Two bindings keep the rung from rotting back into an unarmed fence, which is what OPE-1169 found:

- `scripts/deploy-merge-fence-test.ts` runs the **real** rung against the **real** base-ref driver as
  a subprocess. It asserts reachability, not judgement: remove the spawn and the suite reds. The
  fence's own unit test cannot catch that — it was green throughout the period in which nothing
  called the fence.
- The same suite joins the rung to the contributor guide that invokes it. Drop
  `npm run deploy:merge-fence` from `CONTRIBUTING.md` and the suite reds.

### The second rung — DCO sign-off

`deploy:merge-fence` carries one more check, and it is not part of the upgrade fence's threat model.
`scripts/deploy/dco-lib.ts` reads the pull request's commits and refuses the merge when one
carries no `Signed-off-by: Name <email>` trailer. It exists because four documents —
`CONTRIBUTING.md`, `.github/PULL_REQUEST_TEMPLATE.md`, the `README.md` badge and `AGENTS.md` — stated
that this project enforces the Developer Certificate of Origin, while the job that enforced it was
deleted with every other workflow. The claim outran the receipt for months (OPE-1226).

What it is worth, stated exactly:

- It checks that a trailer is **present and well formed** on every non-merge commit. It does not
  join the trailer's identity to the commit author's, and it verifies nobody.
- **It reads one page of commits, and a full page refuses.** The rung asks GitHub for the commit
  list at the API page size and takes that one page. A page that comes back full may hide an
  unsigned commit behind it, so the rung refuses rather than read a partial list as complete. A
  pull request with that many commits therefore refuses even when every commit is signed. An empty
  commit list refuses too: "every commit is signed" must not pass by vacuity.
- **Merge commits are exempt.** A merge certifies no new authored work, and this repo's up-to-date
  policy makes every builder merge `main` in, which `git merge` writes without a sign-off. The cost
  is that a conflict resolution carried in a merge commit is not signed for. The upgrade fence still
  judges the pull request's whole changed-file list, so such a resolution is refused on its own
  account if it touches a protected path.
- It gates a merge only when the session doing the merge **runs the rung**. Every agent merge is
  told to run it, and nothing verifies that it did — see § "The attestation — the rung outside the
  judged session" below, which says the same of the upgrade fence. The exit code reaches the
  orchestrator as a reported line, not as an attestation. The attestation leg closes this for the
  DCO rung too, because it runs the whole of `runMergeFence`.
- It does **not** gate a maintainer clicking the merge button. `oe/upgrade-fence` is not among
  `main`'s required status contexts, so nothing behind the button reads this rung's verdict.

It runs AFTER the upgrade fence and only on the clear path, so it can turn a `clear` into a
`refuse` and never the other way round. The order is about which refusal a reader sees: the upgrade
fence is the security control, a missing trailer is a formality, and burying the first under the
second would hide the finding that matters.

Unlike the upgrade fence, this rung is **not** extracted from the base ref — it runs from the
working tree, like the rest of the pre-merge runner. What protects it is the upgrade fence itself:
`scripts/deploy/` is inside `merge-gate-surface`, so any pull request that edits `dco-lib.ts` is
refused before the rung is reached, and merges only on a reviewed override. `scripts/deploy-merge-fence-test.ts` asserts that rule covers the path rather than assume
it, and a further leg asserts that each of the four documents names `deploy:merge-fence` — so the
claim cannot outrun the receipt again in silence.

Both halves of the rung sit under `scripts/deploy/`, which the `merge-gate-surface` rule already
protects, and the binding suite is named by exact path under `the-fence-itself` — it sits at
`scripts/` root, outside that prefix, so without its own entry a pull request could delete the suite
and its chain leg quietly and drop the rung afterwards. The suite asserts both rather than assuming
them.

One thing the base ref does **not** supply: the toolchain. The extracted fence is the base's source,
but it runs under the head's installed `tsx`, resolved from the working tree's `node_modules`. A
pull request that changes the dependency therefore changes what transforms the fence. The protected
set cannot close this — an upgrade legitimately bumps `package.json`, which is the whole point of the
path the fence exists to allow — and the realistic failure modes are fail-closed (a moved or missing
`tsx` makes the spawn fail, which refuses). Stated because "runs the base ref's copy" is otherwise
read as more than it is.

### The attestation — the rung outside the judged session

`deploy:merge-fence` runs *inside* the session that is about to merge. Nothing makes that session
run it, and the pull request records nothing about whether it did. Three things narrow that and none
closes it: the run definition is a protected path, the suite binds the rung to the run definition,
and the exit code is part of the reported Definition-of-done block. All three check **bytes**. None
checks the **run**.

**`npm run deploy:merge-attest -- --pr <n> --fence` is the check on the run** (OPE-1182). The
*orchestrator* runs it, not the builder. It reads the pull request, runs the same base-ref fence,
and posts the verdict as a commit status on the pull request head under the context
**`oe/upgrade-fence`**:

| Verdict | Status | What it means |
|---|---|---|
| fence pass, DCO pass | `success` | the diff touches no protected path, and every commit is signed off |
| fence pass, **DCO refuse** | `failure` | the fence is happy; a commit carries no `Signed-off-by:` trailer, or the commit list could not be read. Do not merge |
| fence refuse, or the fence could not run | `failure` | do not merge. The DCO rung does not run on this path — the fence's refusal is terminal |
| the fence never read the pull request | *nothing is posted* | the head stays unattested |

The status context stays `oe/upgrade-fence` for both rungs, so one required check covers both. The
description names which rung refused, because `fence: pass` with `verdict: refuse` is the one
combination the fence's own verdict does not describe.

**A missing status is what blocks.** Add `oe/upgrade-fence` to the default branch's protection rule
as a required status check, and GitHub itself refuses a merge the fence never judged — including a
self-merge. The rung reads that rule back on every run and says whether it is in place. Without
`--require-protection` it still posts and only prints the advisory; **under that flag** an
unconfirmed rule is a refusal, so an attestation that would gate nothing is never posted as though
it did.

**Exit code.** `0` clears the merge — a `success` status is in place. `1` means do not merge, and
covers both "nothing was posted" and "a `failure` status was posted": posting is not success. `2` is
a bad invocation. `--dry-run` stops the post, not the reads: by the time it is consulted the rung
has already read the pull request and run the fence.

🔴 **The base ref must be the repository's default branch, and the rung refuses otherwise.** The
fence is extracted from the pull request's base and **run in the attesting session**. In the sandbox
that was harmless — extracted code and the session running it had the same author. Here the session
holds the credential that posts, so a pull request based on an agent-authored branch would have the
orchestrator execute that branch's own fence, which could print a clean report and earn a `success`.
The rung refuses any base that is not the default branch, and refuses just as hard when it cannot
read what the default branch is. **Both refusals land before the extraction, not after it** — the
attesting session reads the default branch first and hands it to the fence runner as
`requiredBaseRef`, which checks it immediately after the pull-request parse. A refusal that only
decided whether to post would arrive once the base's code had already run. There is no override: a
stacked pull request is judged in the sandbox with `deploy:merge-fence`, whose session carries no
more authority than the pull request's own author.

A commit status belongs to one sha, so **a push after the attestation leaves the new head
unattested** and the merge blocks again. That is the property doing the work: the status names the
bytes the fence read, and new bytes need a new run.

**Why the orchestrator runs the fence rather than relaying the sandbox's evidence.** The
`oe/cloud-proof` lane relays evidence because the *suites* are expensive — the integration tier was
~85% of this repo's Actions spend. The fence is not a suite: one pull-request read, one `git`
extraction, one subprocess over a changed-file list. There is no cost argument for a relay, and a
relay puts the judged session back inside the trust path. A relay also cannot tell "the session
skipped the rung" apart from "the orchestrator has not looked yet" — both are an absent evidence
line. Running the fence here makes the absent **status** the only signal, and the protection rule
turns that absence into a refused merge.

The same rung carries the post-merge leg, `--transfer`, which moves a squash-merged branch's
`oe/cloud-proof` onto the new tip when the two commits have identical trees — see
[The `oe/cloud-proof` lane](../deploy/cloud-proof.md).

## What it does not close

- 🔴 **The sandbox must not hold a credential that can post commit statuses.** The attestation's
  whole value is that a different principal posts it. That is a property of how the deployment
  distributes credentials, not a property of any code here. It is the same trust root
  [the `oe/cloud-proof` lane](../deploy/cloud-proof.md) already states for itself.
- 🔴 **Repository admin rights bypass a required check.** Branch protection binds everyone else. Do
  not give the agent's credential admin rights on the upgrade repository.
- **Nothing here creates the protection rule.** A person adds it, because it is a guardrail change.
  Until it exists, `oe/upgrade-fence` is a record on the pull request rather than a gate, and
  `deploy:merge-attest` says so on every run.
- **The override itself.** The fence refuses; a person decides. Nothing here checks that the
  orchestrator really read the protected files before overriding, and nothing records the reasoning.
  The refusal makes the review happen; it cannot make the review good.
- **A pull request that deletes the fence step from its runner**, on a deployment whose runner is a
  GitHub Actions workflow and that named the `workflows` capability on the upgrade binding. Actions
  runs the *head's* workflow on a pull request, so a deleted job is a job that never runs. Two
  things close it: do not name that capability (above), and make the check required through a branch
  protection rule so a missing check blocks the merge.
- **Anything after merge.** The fence judges a proposal. What ships is decided by merge and deploy —
  see [Rollback](../deploy/rollback.md).

## Related

- [The per-release migration record](../deploy/self-upgrade-release-records.md) — the upgrade context
  an agent reasons over.
- [Security model](./security-model.md) — the threat model this control sits inside.
- [Honesty ledger](./honesty-ledger.md) — the standing list of known limitations.
