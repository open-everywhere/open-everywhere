# PR walkthroughs — being walked through a change you're about to merge

Everyone ships code through agents now. The pull request is still the gate — and it is the least
AI-native part of the loop: a human is asked to approve a diff they did not write, often in a
codebase they did not read this week. Reviewing well means knowing what the change *does to the
running system*, and that is not something a diff shows you.

A **PR walkthrough** is that briefing. Ask in an admin channel — *"walk me through PR #412"* — and
you get one document with five sections: what changed, what it means, the blast radius, what could go
wrong, and — always — what none of it can tell you.

It **cannot merge, approve or block anything.** The merge stays a human act behind branch protection
and CODEOWNERS. This is a decision *input*, and the whole design is about making it one you can
trust.

---

## The problem it has to solve first

An agent that both **proposes** a change and **vouches for its safety** is not a reviewer — it is a
conflict of interest with a summary attached. Under prompt injection it is worse than that: by this
project's own doctrine the session that authored a change is the **least-trusted context in the
system** (it read channel text, so it is assumed injectable — see
[Access & scoping](../how-it-works/access-and-scoping.md)). If that session also writes the
ramifications, the walkthrough inherits whatever the diff got wrong, including on purpose.

So the walkthrough is not built on a promise that the agent will be honest. It is built on **what
each layer can physically touch.**

| Layer | Who | What it can contribute | What it structurally cannot do |
|---|---|---|---|
| **Proposer** | any session, possibly the one that wrote the change | the repo and PR number | write a word of the document; frame the review; supply a fact |
| **Facts** | a run of `scripts/config-diff.ts`, no model anywhere in it | the computed config delta | be edited, selected or omitted by a model |
| **Narrator** | the `fresh_eyes_review` declared subagent — fresh session, zero tools | a verdict (prose on this pin — see § *The result*) | see the proposer's history; read the repo; reach the network |
| **Relay** | the proposing session again — it carries the verdict back | the narration text, as passed on | fake the *spend rows* a delegated run leaves behind |
| **Render** | `packages/core/agent/review/pr-walkthrough.ts`, pure code | the document | be replaced by model prose |
| **Merge** | **you** | the decision | be taken by anything above |

Four of those five layers are fences. The **relay** is not — and the document says so out loud rather
than papering over it. See [Whether an independent reviewer really ran](#whether-an-independent-reviewer-really-ran).

---

## Facts and narration are different kinds of thing

The document is deliberately **two-toned**, and it tells you so before you read anything:

- 🧮 **FACTS** — computed from the *resolved* config by a run with no model in the path. Section 1
  links the run or the vouching status, so you can open it and reproduce every line.
- 🗣️ **NARRATION** — a language model's opinion, which reached the document through the session that
  asked for the walkthrough. Section 2 opens by saying what the host could verify about where that
  opinion came from.

This is not decoration. A reader who has to *guess* which half they are looking at gets no value from
either, because the point of the factual half is that it is checkable. Every model-authored string is
additionally collapsed to a single line and rendered inside a blockquote, so it cannot open a
heading, a fence or a table and forge structure around the decision being asked for — the same bound
`packages/core/agent/approvals/review-surface.ts` applies to approval cards and config-PR bodies.

Narration about a subject the facts *do* name is marked ⚓; narration about anything else is marked ◌
**(subject not named in the facts)**. A reading about the code is legitimate — it just must not read
with the authority of one derived from a computed row.

---

## Where the facts come from — and the one place they never come from

The [config-diff gate](../how-it-works/config-as-code.md) runs on every PR touching `agent/**`. It
resolves the whole deployer config at the base revision and at the head revision, in two separate
checkouts with their own dependencies, and diffs them: effective access per bound scope, domain
rosters, declared webhooks, providers, roles, bundles, plugin expansions, and the filesystem-convention
tool/skill/subagent rosters. It posts a report as a PR comment **and** uploads it as a workflow
artifact.

🔴 **The walkthrough reads the artifact. It never reads the comment.** Anyone who can comment on a
pull request can post something that looks exactly like that report, and a briefing built on comment
text would inherit the forgery. There is no comment code path in
`packages/core/agent/review/facts-artifact.ts` — not a fallback, not a flag. The GitHub comment API is
never called, so "the facts came from a forged comment" is not a risk that has to be argued about;
it is unreachable.

### Two provenances, because one of them cannot run here

There are **two** accepted sources, and neither is ever a comment. The reader tries them in this
order and returns whichever produces a document:

| Provenance | Who vouches | Where it runs |
|---|---|---|
| **Actions artifact** | a CODEOWNED workflow file | tried first, on any repository |
| **`oe/config-diff` commit status** | the principal who posted the status | tried whenever the first produced no document — always, on a repository with no Actions at all, like this one |

The second lane is reached on **any** repository once the first produces nothing — including when
the first found a run and *refused* what it carried (an expired artifact, an unreadable zip, a failed
download). So a repository that runs the workflow can still end up on the status lane. What keeps
that honest is that section 1 always names *which* provenance supplied the document, and section 5
states that lane's own bound.

🔴 **The Actions lane cannot run on Open Everywhere's own repository.** A past change deleted
`.github/workflows/`, and nothing re-adds one. Before the second provenance existed, a walkthrough of
one of this repo's own pull requests therefore stated its facts section as an UNKNOWN, every time —
the two-toned design's whole trust argument, dark on the repository that built it.

Three checks make the artifact **attributable**:

1. the run's workflow file is exactly `.github/workflows/config-diff.yml` — which is CODEOWNED, so a
   workflow's identity is itself a reviewed fact. An artifact named `config-diff` uploaded by some
   other workflow a PR added is rejected.
2. the run's head SHA equals the PR's current head, so a stale run cannot be presented as describing
   the current diff.
3. the run was triggered by `pull_request` — the only event the gate declares, and the only one whose
   token cannot write to the repository.

The run id and URL travel with the facts and are printed in section 1. A walkthrough that cannot name
its run is not a walkthrough.

⚠️ **The honest bound on that claim:** a GitHub Actions artifact is **not signed**. What is
established is *"these facts came from a named run of a CODEOWNED workflow at this exact head SHA"* —
strictly stronger than a comment, strictly weaker than a signature. Anyone with `actions: write` on
the repository could produce a run that says something else. Section 5 of every walkthrough says so.

### Whether the facts really ran — the commit-status provenance

On a repository with no Actions, a **cloud run** computes the same document and a **commit status**
vouches for it. The trust shape is the one `oe/cloud-proof` already uses: identity is the status
context plus the posting principal, not a workflow file.

1. the run executes `npx tsx scripts/config-diff.ts --base-ref origin/main --json config-diff.json
   --publish`. `--publish` prints one evidence line and posts nothing:
   `OE_CONFIG_DIFF head=<40-hex> sha256=<64-hex> bytes=<n> file=<path>`.
2. the **orchestrator** — a separate principal, holding real `gh` auth — publishes the document where
   GitHub serves it for this repository, and posts a commit status on the same head SHA: context
   `oe/config-diff`, description `sha256:<hex> session=<run>`, `target_url` the document.
3. `walk_pr` reads the latest `oe/config-diff` status at the head SHA, fetches the document, and
   **hashes it**. Bytes that do not match the digest the status named are refused.

The script never posts its own status, deliberately. A driver that could vouch for what it just
computed would be a driver a reviewed session could ask to vouch for anything.

Because the digest decides, the hosting location carries no trust: a swapped release asset, a
redirect or a stale cache is a refusal, not a wrong answer. The URL fence — the API host, the
raw-content host, or a release download, each serving this repository — is defence in depth on top
of that, and it is why a read token is only ever offered to `api.github.com`.

⚠️ **The honest bound on this claim too:** a commit status is **not signed** either. What is
established is *"a principal who can write commit statuses on this repository vouched for exactly
these bytes at this head SHA"* — strictly stronger than a comment, strictly weaker than a signature.
Anyone with `statuses: write` could post an `oe/config-diff` status vouching for a different
document. Section 5 of every walkthrough says so, in those words.

Two things the Actions lane has that this one does not, and the document states both rather than
letting them read as clean:

- a **run id**, and therefore the staleness check `post_pr_walkthrough` performs against
  `factsRunId`. On the status lane that check is *unperformed*, not passed — the head SHA is what
  binds the facts to the revision instead.
- the **overlay single-scope gate's report**, which rides as a second file inside the workflow's zip.
  The status vouches for one document, so section 3 reports that gate as an UNKNOWN on this lane.

`scripts/pr-walkthrough-facts-test.ts` ⑤ pins the whole no-Actions path: the real reader, a run
listing with no workflow run in it, the 🧮 section on the rendered document, and every refusal —
swapped bytes, an off-repo link, a status naming no digest, and no status at all.

---

## The five sections

### 1. What changed — 🧮 facts

The config delta, per section, verbatim from the facts document, each section in exactly one of
three states: **computed** (with the rows that moved), **not computable** (with the reason), or a
**finding**. Plus the overlay single-scope gate's own report — the one step that can *fail* a config
PR — quoted rather than summarised, when the document carried it.

### 2. What it means — 🗣️ narration

Opens with **where this narration came from** — attested or not (below) — then the reviewer's
summary, then one plain-language reading per subject a decision has to be made about: *"this channel
can now write to Notion, where before it could only read."* Concrete and per-scope, not "access may
be affected".

### 3. Blast radius — 🧮 facts

Computed, never narrated:

- **`widens`** — true iff a bound scope gained an access item, or a domain roster gained a member.
  Deliberately narrow. A new standing instruction does **not** set it, because it widens no access —
  it changes what the agent *does* with access it already had. Folding the two together would make
  the flag mean "something worrying happened", which is not a fact, and a reader who learned that
  `widens: false` sometimes means "a standing prompt landed" would stop trusting it.
- **per-scope gains and losses**, decomposed to the item: `slack/T…/C… gains hosts:
  api.notion.com [auth via notion] methods=POST`. Newly-bound and newly-unbound scopes are called
  out as such.
- **domain rosters** — which rooms inherit a domain's access. A gained container entry is flagged as a
  whole-tenant claim: it confers on surfaces that do not exist yet and can never be enumerated.
- **standing instructions** — 🔴 the most consequential thing in a config diff. A webhook
  `instruction` runs **unattended**, with the target channel's full grants, forever, on anyone's
  POST. When the producer digested the text (anything over ~200 characters is stored as a length +
  hash), the walkthrough says the instruction *changed* and that its **content is not visible** —
  never nothing.

### 4. What could go wrong — 🗣️ narration

The reviewer's findings with severity and category, and its `approve`/`block` recommendation — stated
as what it is: a model output that decides nothing. An `approve` is not permission.

### 5. What this walkthrough cannot tell you

**Always present, never empty.** Seven limits are true of every config diff no matter what it found,
so "nothing to report" would be a lie in every case:

1. **Runtime-declared state** — a hook declared at runtime, stored credentials, armed routines,
   spend rows, control-plane model overrides. They live in the database, not in git, so no config
   diff sees them before or after the merge.
2. **Environment** — no env var is a row. A deployment flipped by an `OE_*` flag looks identical.
3. **Code** — `packages/core/**` and `packages/providers/**` are outside the gate's trigger, and
   nothing inspects a tool's or the resolver's *body*. A resolver change that widens what every
   bundle reaches moves zero rows. Code is reviewed as code, and by the diff in sections 2 and 4.
4. **Approval policy** — whether an action is `policy: "member"` or admin is code, not config.
5. **Prompt text above a length** — visible as *changed*, never as *what it now says*.
6. **Unenumerable breadth** — a container `reach` entry is a predicate over surfaces that do not exist yet.
7. **DM / `principal` scopes** — the binding is visible; its effective reach is not computed.

Then the situational ones: a clipped diff, a capped file list, a missing facts document, a section
that could not be compared, the not-signed caveat for whichever provenance supplied the facts, a reviewer that saw nothing, **whose words
sections 2 and 4 are** — and the standing reminder that the document has no view on whether the
change is a *good idea*, and cannot merge, approve or block anything.

That list is kept honest by a test, not by discipline: `scripts/pr-walkthrough-facts-test.ts` parses
the numbered limits out of `scripts/config-snapshot-build.ts` and reds the `test` chain if the walkthrough stopped
mirroring one.

---

## Using it

Two verbs, in order.

**`walk_pr`** — read-only. Fetches the PR's state, its unified diff and the config facts, and returns
a `narratorBrief`. Its input schema is exactly `{repo, number}`: there is **no free-text field**, so
the calling session cannot add its own framing to what the independent reviewer reads. Pass the brief
verbatim to `fresh_eyes_review`.

**`post_pr_walkthrough`** — takes that verdict as `narration`, **re-fetches the facts itself**, checks
its own spend ledger for a delegated subagent run in this session, renders the document in code, and
posts it to the governance admin channel (the same channel the
[access-request](../how-it-works/access-requests.md) and webhook-declaration flows already notify).
There is no input through which a model could supply, alter or omit a fact, and no channel input —
it does not choose the venue either.

Both **mount** on the repository grant (a bundle's `repos`, see
[Access & scoping](../how-it-works/access-and-scoping.md)) and both need a read-scoped GitHub
credential. A channel that is granted no repo does not see either verb — the same grant→mount rule
`checkout_repo` follows, so the agent cannot offer a walkthrough it could only refuse. Both
are withheld from unattended routine wakes: a walkthrough exists to brief a human who is in the room,
and an unattended fire holding the second verb would be a way to page the admins on a schedule.

A follow-up question in the same thread re-derives the facts for the same head SHA, which resolves to
the same document. If the head moved in between, the render says so rather than quietly answering
against a newer one.

### What the narrator can and cannot do

`fresh_eyes_review` is a [declared subagent](./skills-and-plugins.md#declared-subagents-the-specialist-unit):
eve gives it a fresh session with **no parent history**, and every slot in its `tools/` directory is
taken over. Every framework tool eve mounts by default carries a `disableTool()` sentinel — `bash`,
`read_file`, `write_file`, `edit_file`, `web_fetch` and `web_search` — so there is no bash, no
`read_file`, no file write, no `web_fetch` and no `web_search`.

**The skill loader and the connector routes are kept out by eve, not by a sentinel, and one
condition of that is unproven.** eve reserves its `eve__` tool namespace: `eve build` throws on any authored module at a
reserved name, a `disableTool()` sentinel included. So no file in `tools/` can remove `eve__skill`,
`eve__search` or `eve__tool`. eve mounts them only from the session's catalog: `eve__skill` while the
catalog holds a skill, and `eve__search` and `eve__tool` while it holds a connection or a deferred
entry. This subagent declares no `skills/` and no `connections/`. So it holds none of the three, on one
condition: eve must build a subagent's catalog from that subagent's own node, not from the root's. On
that condition, an instruction embedded in the diff cannot make it go and find the proposing
session's reasoning, or anything else.
🔴 `npm run test:subagent-zero-hands` pins, against the real tree and the installed eve: that the
subagent authors nothing at a reserved name, that every authored file is a sentinel, that a sentinel
exists for every tool eve mounts by default, that eve's catalog still mounts the three routes only
under those conditions, and that the subagent declares no skills and no connections. The test does
NOT prove the condition above. On eve 1.x it is unproven, so the containment of the three `eve__`
routes is unproven too.
Everything it knows arrives in the brief, and the diff inside that brief is wrapped in
the untrusted-content envelope, with embedded delimiters defanged so a diff containing a literal
closing tag cannot break out and address it as trusted instruction.

### Whether an independent reviewer really ran

eve lowers a declared subagent into a **model-visible tool**. There is no host-side way to invoke one
and no host-side way to receive its answer: the verdict goes back to the *model*, which passes it to
`post_pr_walkthrough`. So the tool is handed an object it cannot inspect its way to trusting, and a
tool description saying *"do not write your own"* is an instruction to precisely the thing being
constrained.

What the host *can* see is **spend**. Every declared subagent must author its own `hooks/spend.ts`
(hooks are not inherited across eve's isolation boundary, so this is pinned by
`scripts/subagents-lint.ts`), which means a delegated run's model calls are written to the
`usage_events` ledger by Open Everywhere's own hook, from inside the child run. Those rows file under
the **parent's** session id, so `post_pr_walkthrough` can read its own session's ledger and see
whether this conversation delegated at all. Nothing on any tool's input surface can create one.

Section 2 therefore opens with one of two lines:

> ✅ **DELEGATION ATTESTED** — the spend ledger carries 4 model call(s) from 1 delegated subagent
> session(s) under the session that asked for this walkthrough …

> ⚠️ **NOT COMPUTABLE** — **the narration below is UNATTESTED.** the spend ledger holds no
> delegated-subagent usage row for this session, so nothing establishes that an independent reviewer
> produced any of it …

**Read the attested line for exactly what it says.** It establishes that a delegated session ran and
made model calls. It does **not** establish:

- **which subagent** — eve's parent linkage carries a call id, never a name, and the built-in `agent`
  delegation mints the same shape. (What *is* true of any declared one: every default-mounted
  framework slot is a `disableTool()` sentinel, and the reserved connector slots mount nothing for a
  subagent that declares no connections, so whichever ran held no tools.)
- **that the words are its words** — the narration was relayed by the session being reviewed, which
  could have edited, truncated or replaced it in transit. This is the gap that stays open while eve
  returns a subagent's output to the model rather than to the host.
- **that the run was for this request** — any delegation earlier in the same conversation counts.

An **unattested** verdict is not deleted; deleting it would be the same "silently shorter document"
failure the three-state honesty rule exists to prevent. It is **relabelled**: *"Summary as supplied —
UNATTESTED"*, *"Recommendation as supplied — UNATTESTED"*, and a section 5 entry telling you to read
it as the asking session's own words about its own change. An empty finding list from an unattested
verdict is called out as *not* evidence that anyone looked.

Two more properties worth knowing. **Forgetting to check is treated as finding nothing** — a render
given no attestation produces the unattested wording, so a future caller cannot get the stronger
document by skipping the step. And **an unreadable ledger is an absence, not an attestation**: if the
database read fails, section 2 says so with the failure as its reason, and the walkthrough still
renders.

What a fabricated verdict buys an adversary is bounded either way: it is rendered as **narration**,
in a block labelled as a model's opinion, next to a facts half it cannot touch and a section 5 it
cannot suppress. And a *missing* verdict is not a clean bill — sections 2 and 4 render **not
computable**, and section 4 says in as many words that nobody looked for problems.

---

## Related

- [Config-as-code](../how-it-works/config-as-code.md) — why the config is a diff in the first place.
- [Access requests](../how-it-works/access-requests.md) — the flow that opens a config PR the agent
  itself asked for; this is the other end of it.
- [Access & scoping](../how-it-works/access-and-scoping.md) — what "effective access per scope" means.
- [Audit & provenance](../security/audit-and-provenance.md) — every walkthrough writes a
  `review.pr_walkthrough` row: which PR, which facts run, what the narrator recommended, how many
  findings at which severities, and **whether the narration was attested**. Never the prose — the
  document is reproducible from the run.
- [Spend & cost controls](../security/spend-and-cost.md) — the ledger the attestation reads. A
  delegated subagent's model calls are recorded against the conversation that delegated them, which
  is also why `session_cost` includes them.
