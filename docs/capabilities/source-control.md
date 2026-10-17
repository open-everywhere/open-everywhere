# Source control

The agent doing real git work: it clones a repo on demand, branches, commits, and opens
a pull request **authored by its own bot identity** — so the fixes it investigates can
actually ship.

Source control is its own plane, distinct from connectors and the egress firewall: it's
git transport plus the pull-request API, fronted by a **GitHub App** that gives the agent
its own GitHub identity. It is **optional** — only teams handing the agent code work need
it.

## Its own identity, not impersonation

Open Everywhere uses a **GitHub App**, so a pull request the agent opens is authored by
the bot (`open-everywhere[bot]`), not by a person. OAuth / the web flow is used only to
*install and link* the App to your org and repos — never to act. Commits are attributed
to the bot's committer identity; the PR links back to the surface and thread it came
from.

**There is no fallback.** A deployment signs in to GitHub ONE way, and it says which in
`github.auth` in `agent/settings/settings.ts` (OPE-2530): `app` (the shipped default) or `token`, a
personal access token. In `app` mode `GITHUB_TOKEN` is never read, even when it is set, and a repo
the App is not installed on is refused by name. Until OPE-2530 the pull-request and ticket paths
silently fell back to the token there. See
[A personal access token instead of the App](#a-personal-access-token-instead-of-the-app) for the
other mode.

This mirrors how GitHub Actions authenticates: a clean runner, a per-job scoped token,
the token dies with the job. Open Everywhere applies the same model per session.

## A personal access token instead of the App

Some organisations will not create a GitHub App, and their only repository is the agent's own. For
them, set `github: { auth: "token" }` in `agent/settings/settings.ts` and put a personal access
token in `GITHUB_TOKEN`.

- **The token reaches only the repositories declared for it.** By default that is the deployment's
  own repository (`OE_ACCESS_CONFIG_REPO`). `github.tokenRepos` names more, each `owner/repo`. A
  repository is reached only where a bundle ALSO grants it to the room. `list_repos` lists only those.
- **Checkout, pull requests and the config-change pull requests work there.** `checkout_repo`
  injects the token at the sandbox firewall on exactly two requests per reached repository: the
  `GET …/info/refs?service=git-upload-pack` and the `POST …/git-upload-pack` that a clone and a
  fetch make. Each rule matches the WHOLE path (an exact path, or an anchored pattern), never a
  prefix, so a path with extra segments after the clone path gets no token. A push's own requests
  (`service=git-receive-pack` and `git-receive-pack`) match no rule: on Vercel they reach GitHub
  with no credential and are refused, and the self-host proxy in Tier B (`OE_EGRESS_MITM=1`) denies
  them. In Tier A the proxy sees no path, so it adds no token anywhere: a push reaches GitHub with
  no credential and is refused, and a clone gets no token either. So on the self-host proxy, a
  token-mode checkout needs Tier B (the App's read token has the same limit). The approved publish
  lifts these rules off `github.com` for its one push, carries the token in that one command, and
  then re-arms them, as in `app` mode. On a backend without the firewall, `checkout_repo` refuses:
  there it would have to store the token in the clone, and the token can push.
- **The App is never used in this mode**, even when its secrets are still set. The GitHub webhook
  route still verifies each delivery and runs the event-routine fan-out (that needs no GitHub
  credential), but it starts no conversation: no @mention session, no ambient seat, no stop or
  reaction leg. GitHub search and GitHub-backed memory are off too.
- **What the host check is, and what it is not.** The reach list decides which repositories the
  host presents the token for. The token itself carries whatever its owner gave it, and the work
  is authored by that owner. Use a **fine-grained** token limited to the declared repositories, with
  `Contents: read and write` and `Pull requests: read and write`. Then the token's own scope matches
  the host's list.

**Moving to the App takes four steps, in this order.**

1. Create the App in one click with the ops MCP tool `surface_app_create`
   ([GitHub § Setup](../deploy/surfaces/github.md#setup)). Pass `variant: "source-control"` to keep
   what the token mode does today. The default `full` also turns on the GitHub conversation surface.
2. The tool writes the App's keys into `.env.local` only. Push every name it wrote to the
   deployment's environment.
3. Set `github.auth` to `"app"` and redeploy.
4. Install the App on your repositories. Do this AFTER the redeploy: the deployment learns the
   installation from the App's `installation` delivery, and a token-mode deployment ignores that
   delivery. Until this step the agent cannot reach GitHub.

Nothing else changes: the bundle grants are the same in both modes, and `github.tokenRepos` stops
being read. Delete `GITHUB_TOKEN` afterwards; nothing reads it. An admin who asks the agent about
its setup gets the same steps.

**The App brings its own `GITHUB_WEBHOOK_SECRET`, and step 2 replaces the deployment's old one.**
If `.env.local` already holds the old secret, the tool refuses until you pass `replace: true`. A
repository webhook that feeds your event routines then needs the new secret, or its deliveries are
refused. With `source-control` the App subscribes to no events, so keep that webhook and give it the
new secret. With `full` the App subscribes to the same events itself, so delete the repository
webhook, or each event reaches your routines twice.

## Two-level scope: installation universe ∩ bundle repos

Which repos the agent can touch is the intersection of two layers:

- **Installation universe** — the repos the GitHub App is installed on (org-level setup,
  "connect all" or a selection). The superset.
- **Bundle repos** — `bundle.repos`, the per-scope narrowing in your access bundle.

Effective repos = installation universe ∩ bundle repos — the same two-surface shape as
the egress firewall. A bundle only *names* repos; this plane resolves each name to a
clone URL plus a freshly-minted, scoped token. See
[Access & scoping](../how-it-works/access-and-scoping.md).

**The repo grant is also GitHub's work grant.** A session that is granted no repo sees none
of the GitHub tools that take a repo — `checkout_repo`, `open_pull_request`,
`check_pr_status`, `get_pr_feedback`, `walk_pr`, `post_pr_walkthrough` and `subscribe_pr`.
They are absent, not refusing, so the agent can never report that it tried to clone or that
it read a PR. It is the same grant→mount rule the
other providers' work tools follow, and the grant works from **any** surface: a domain that
talks in Slack and holds a repo grant may file GitHub issues and open pull requests with no
GitHub channel anywhere in it. Naming a repo the grant does not cover is still refused at
the call, so the mount rule narrows what a session sees and never widens what it may reach.

## Lazy checkout, gated writes

A session starts with **rights but no code** — and reads and writes carry different
rights:

- **`list_repos`** tells the agent which repos this session is allowed, so it doesn't
  have to guess.
- **`checkout_repo`** clones one of the allowed repos into the sandbox on demand. At
  that moment the host mints a **read-only** installation token — scoped to the *union*
  of every repo this session is granted, not just the one being cloned — and injects it
  **at the sandbox firewall**, then configures the bot's git identity. It refuses any
  repo not in the allowed set — **fail-closed**, like the connector hard-gate. See
  [The token never reaches the model](#the-token-never-reaches-the-model) for how the
  read credential is delivered.
- The agent then branches, edits, and commits with the `bash` it already has. It
  **cannot push**: the persisted credential has no write permission.
- **`open_pull_request`** is the write gate, and it rides the same **approvals plane**
  as every other consequential action (frozen args, a code-rendered card, a verified
  clicker — see the [security model](../security/security-model.md)):
  the call **proposes**, a card posts, and the branch + PR publish only when a human in
  the channel approves. One path skips the card: an **approver chain** that lowers this verb
  publishes at once and posts a notice instead. Taint does not close that path — this verb declares
  `taint: "disclose"`, so a tainted turn discloses its provenance on the row and the verdict is
  unchanged. (The floor-to-a-human rule is narrower: it covers the verbs that arm or disarm a
  post-turn surface, which declare `taint: "gate"`.) Under the hood it's two phases: at propose time the host mints a
  **write** token (`contents:write`, `pull_requests:write`, `metadata:read`) and
  stage-pushes the head branch's exact commit to a hidden `refs/oe-pending/…` ref in a
  single one-shot command — no branch appears, no CI runs, no watcher is notified, and
  the token is never stored in the clone. The approval card pins that commit sha **and names
  the token the click mints** — every permission family with its grade, plus every capability
  set this repo is declared with and what each one buys. A repo opted into `workflows` shows
  `workflows: write` on its card, so the grant is stated where the click happens. The card
  renders those lines from the same derivation the **App** mint body is built from, so those two
  cannot drift. In `token` mode the card names no grade. It says the click uses the personal access
  token, with its owner's rights, because no derivation can read those rights. On the
  click, the host publishes the real branch **at exactly the frozen sha**
  (fast-forward only) and opens the PR as the bot — entirely host-side, so approval can
  land long after the session's sandbox is gone. Follow-up pushes to a PR branch go
  through the same gate: if a PR is already open for that head, the approved publish
  delivers the new commits **and re-applies the approved title/body** to the PR (the card
  is the authority for the copy, not just the commits).

  The card offers three buttons: **Approve** publishes this one proposal; **Reject**
  declines it (the agent may re-propose, which posts a fresh card). A card in a
  conversation has no third button: each click approves one PR, and a second identical
  proposal gets a card again (repeated approvals are the approval judge's job). Only a
  card that a **routine** raised has **Approve for this routine (up to N h)**: it publishes
  this one *and* remembers the approval for that routine, so its later fires publish
  immediately (no card), posting a short note like *"PR #12 updated — approved for this
  routine by @you"* so the action stays visible. That click also **releases up to 32
  sibling cards** of the same kind the routine has pending, and executes each. The grant
  covers `open_pull_request` only (never skill/memory/routine gates, which stay per-click).
  It ends when it expires (`approvals.routineGrantTtlHours`, 24 h by default), when the
  routine's instruction is edited, or at a `revoke_session_grants` with the routine's key; a
  turn that reads external content always gets a fresh card regardless.

This is lazy-clone-on-name: **tell your team to name the repository in the first message
of a code task**, and the agent clones it then.

## Reading a PR's feedback

When someone @mentions the agent on a pull request, the wake carries only the **single
triggering comment** plus a one-shot diff — not the rest of the review. So the read tools
close that loop:

- **`check_pr_status`** returns a PR's state (open/closed/merged, draft, title, last
  updated) and one **summary line**. That line counts the passing, failing and pending checks and
  names up to 20 failing ones, and it carries a PR-activity roll-up too — reviews, approvals,
  change requests, comments and commits. Read-only, no approval.
- **`get_pr_feedback`** returns the actual **feedback**: review verdicts (approved /
  changes-requested / commented), inline review comments (with file + line), issue-thread
  comments, and check runs — with a **failure excerpt** for red checks so the agent can
  see *why* CI is failing. It's the read that lets the agent understand the changes it's
  being asked to make before it makes them. The digest is **bounded** (counts and per-item
  text are capped) and reports what it truncated, so a huge thread can't blow the context
  or hide that it was clipped. Both tools mount on the same repo grant as checkout, and both
  take the same `repoAllowed` check at the call — a repo the channel isn't granted is
  refused, fail-closed. It is **PR-only**: it opens on `/repos/{repo}/pulls/{number}`, which
  GitHub 404s on a plain issue. The conversation read that serves both is `read_channel`
  ([GitHub § Reading the conversation](../deploy/surfaces/github.md#reading-the-conversation)).
- **`read_github_issue`** reads ONE issue by target: its title, state, author, opening body
  and newest 30 comments (OPE-2305). It opens on `/repos/{repo}/issues/{number}`, so it
  serves a pull request's opening description too. A `search` hit for an issue that is not
  this conversation names it as the read road. It mounts on the same repo grant, takes the
  same `repoAllowed` check, and passes the acting-identity gate. It uses the
  **conversation-read** credential (`issues` + `pull_requests`), because the PR-read set
  has no `issues` family and GitHub refuses a plain issue under it. Each body is capped,
  each title and body is fenced as untrusted text, and the result says what it dropped.

The whole read loop is host-side with the **read-scoped** credential. A repo grant never opens
`api.github.com` on the sandbox's compiled policy. An operator declaration that names the host
opens it: a bundle connection or `domains` entry, or a declared browser host. So does the `full`
network-access level. The loop: **mention-wake → `get_pr_feedback` → fix in the sandbox →
`open_pull_request`**, where the follow-up push rides the same approval card as the
original PR.

### Subscribing to a PR

**`subscribe_pr`** binds a PR to the channel you ask from — no webhook, no repo-admin
setup, just the read-scoped credential the SCM plane already brokers. Two surfaces refuse it: a
group DM (execution-only), and any platform this deployment cannot fire a routine on, because the
chain below would dry-run forever under a cheerful "subscribed". It re-checks on an
interval (default 15 min, min 5, max 24 h) and posts **only when something actually
changed**: merged or closed, draft ↔ ready, a retitle, **a review submitted (approval or
changes-requested, with who), new comments, new inline review comments, a push**, and CI
going red or green. That diff is decided **in code** — each check hands the next one a
compact fingerprint, and the tool reports the change list — so a quiet check is reliably
silent rather than leaving the model to compare two prose summaries.

Mechanically it's a chain of **one-shot routines**: each fired check re-arms the next by
calling `subscribe_pr` again, so no new scheduler exists and the routine prompt is always
code-templated (the model never authors routine text). The chain **retires itself** when the
PR merges or closes, or after 96 checks — a day of the default interval — at which point it
says so and can be re-subscribed. To stop one early, cancel the pending check with
`cancel_routine` on the returned `routineId`; that's deliberately the only manual off switch,
because cancelling a standing behaviour is [gated on a human](../security/security-model.md)
and a second, ungated path would undo that.

## Ticket actions: `set_state` / `assign` / `add_label`

Beyond code, the agent can mutate a GitHub issue/PR's own **state, assignee, and labels** —
`set_state`, `assign`, `add_label`. These are **neutral, cross-surface verbs**, not
GitHub-specific tools: the same three tools also act on a Linear issue (see
[Linear § Ticket actions](../deploy/surfaces/linear.md#ticket-actions)), taking a
`{ platform, id }` ref rather than a GitHub- or Linear-shaped schema — a core tool's params
never encode which surface it's talking to. **Entity-gated**: they need an entity. A turn that
passes no `ref` and holds no ticket entity of its own refuses cleanly rather than faking a
mutation. A chat turn that names a `ref` works when the ref's platform is one of this session's
**work destinations** — the memory domain must hold a work credential for it. Talking on a
platform grants nothing about mutating its tickets.

Per-verb consequence, not a mega-tool: `add_label` is trivially reversible (react-class) and
runs immediately, audited (`ticket.add_label`). `set_state` and `assign` are
**audience-expanding** — every watcher of the entity sees a state change or a new assignee, not
just the asking room — so both **propose** (freeze the change, post an approval card) and only
mutate on a human's click, riding the same approvals plane as `open_pull_request`
(`ticket.set_state` / `ticket.assign`, member policy). On GitHub, the entity acted on can be a
*different* platform's issue — a Slack channel whose domain holds a `repos:` grant for that repo —
because the fence reads the repo straight off the entity id and checks it against the channel's
own bundle grant, with no dependence on which surface woke the session.

**Linear works the same way, on its own grant.** `set_state` / `assign` / `add_label` on a Linear
issue run from any surface once the memory domain declares its Linear **work credential** (see
[Linear § Working from another surface](../deploy/surfaces/linear.md#working-from-another-surface-the-linear-work-grant)).
That one declaration names the workspace the write is made in *and* selects the token it is made
with. A Slack/Discord/Teams/GitHub caller in a domain that declares nothing gets
`target-unresolvable` — absence is a refusal, never the deployment default. The domain wall stands
under the grant: an issue on a team **another** domain owns is refused `cross-domain`.

And the converse now holds too, on any platform: you can propose **from the tracker itself**, or
from any other surface with no approval-card path. Only the **card** moves, to a card-capable
channel in the same domain
(see [Control plane § Asking from a surface that can't host a card](../security/control-plane.md#in-slack-approvals));
which issue is acted on is still resolved from the conversation you asked in, and so is the
per-surface fence. No venue in the domain ⇒ a refusal naming the config to change, never a
silently different target.

The GitHub credential is a **separate, narrower** installation-token permission set —
`issues:write` + `metadata:read` — minted host-side per call, same as every other SCM token:
it cannot touch contents or open a PR even if it leaked. **Your GitHub App needs the Issues
(read & write) permission** for these three verbs to work (the same App the PR flow uses; grant
it alongside Contents + Pull requests).

## Filing new work: `create_ticket`

The verbs above mutate an item that already exists. `create_ticket` **files a new one** — a
GitHub issue or a Linear issue — closing the triage → tracked-work → fix loop (before it, the
agent could open a PR but not file the ticket that PR should reference).

It is **surface-agnostic in exactly the same way**: no vendor field in its schema. `platform`
(`"github"` / `"linear"`) is a runtime dispatch key, and `target` is that platform's own
destination shape — a repo as `owner/repo`, or a Linear team key such as `ENG`. **Both are
optional**: a window with exactly one work surface infers the platform, and a turn already
anchored to a repo/issue infers the target (a Linear wake on `ENG-42` files onto team `ENG`). On
GitHub, a turn anchored to nothing falls back to the channel's granted repo when the grant names
exactly **one concrete** repo. A wildcard grant (`owner/*`) is never expanded into a guess.
Ambiguity is never guessed at — two work surfaces, or no inferable destination, refuses and
asks. **Which backend a domain files into is its own config — the work credentials it declares
plus the surfaces it is woken on — not a tool argument.**

**Filing across surfaces takes a grant.** Asking in Slack for a GitHub issue works when the bundle
bound to that room grants the `repos:` entry; asking in Slack for a Linear issue works when the
memory domain declares its Linear **work credential** (see
[Linear § Working from another surface](../deploy/surfaces/linear.md#working-from-another-surface-the-linear-work-grant)).
Neither is implied by a memory domain listing the repo or the team as a channel — that routes
wakes, and grants nothing. With no grant the filing refuses rather than guessing which tracker
you meant.

**Chat presence is neither a precondition nor a substitute.** A domain that tracks its work in
Linear and talks in Slack needs no Linear channel to file there: the work credential alone makes
Linear an admissible destination. Most tools a domain works with will never be chat surfaces at
all. The rule runs both ways — a chat channel on a platform grants **no** filing there, even to a
session woken on that very platform. A chat channel confers the chat verbs (reply, react, read the
container you arrived in) and nothing else, so exactly one mechanism decides work: the grant.

Support is per-provider and **fail-closed**: a surface with no registered create adapter refuses
naming the ones that work, rather than faking a filing. Notion is deliberately absent — a
"ticket" there is a database row whose property schema (which property is the title, which is
status) is per-database and cannot be inferred.

`create_ticket` is **gated** (`ticket.create`, member policy — the same plane as
`open_pull_request` and `set_state`): a filed issue reaches repo/team watchers, triage
automation and subscribers. It **proposes** — the approval card renders the exact title *and
body*, because the model authors that text and the card is the injection gate before it
publishes. A human click files the issue — on a surface that can't host a card, in the
card-capable channel the domain provides, with the agent telling you where it went. The one
card-less path is the same approver-chain lowering `open_pull_request` carries: the chain can file
at once and say so in the reply. **Where it
files is never affected by where the card lands**: the work surface and target are inferred from
the window you asked in, so two rooms sharing one approval channel can still file into two
different trackers. Unlike `pr.open` it is **never
session-grantable**: every filing takes its own card. It also files title + body only —
state, assignee and labels stay the individually-gated verbs above, runnable on the returned
ref. On GitHub it uses the same narrow `issues:write` credential as the three verbs above.

## The token never reaches the model

The App's private key is **server-side only** — never in a sandbox, image, or the
model's context. Installation tokens are minted **host-side** from the App key,
**down-scoped** to exactly the repo(s) in play (a mint can only ever *narrow* below the
installation grant, never widen), and last one hour. Checkout-read, PR-read and write are
minted **separately**, with different rights and different delivery:

- **Checkout mints read-only, and delivers it at the firewall, not into the sandbox.**
  `checkout_repo` mints one `contents:read` + `metadata:read` token per owner, scoped to
  the *union* of every repo this session is granted (not just the repo being cloned that
  moment), and injects it as a header **transform on the sandbox's network policy**
  (`github.com` / `codeload.github.com`) — the same mechanism, and the same header shape
  (`Authorization: Basic base64("x-access-token:<token>")`), the platform's own GitHub
  checkout integration uses. The clone command itself carries no token at all: nothing
  rides in the git command, nothing is written to `.git/config`. The rule is recompiled
  and reapplied on **every** `checkout_repo` call, which is what keeps it fresh (tokens
  live ~1 hour) and what makes later fetches of *other* granted repos in the same turn
  work without a fresh clone. The brokered policy lasts until the next turn's
  [egress re-apply](../security/revocation-latency.md#egress-is-turn-grained) replaces it
  with the session's base policy, which has no broker rule. The apply records the brokered
  policy as the one in force (OPE-2303), so that next turn re-applies rather than skipping
  as unchanged. A `git fetch` in a later turn therefore carries no firewall credential; call
  `checkout_repo` again in that turn. This bound holds for a root session. A subagent
  child shares its parent's firewall but not its parent's applied record, so after a child's
  checkout the parent's next turn can skip as unchanged, and the brokered policy can stay in
  force until the parent's base policy changes. Because the token never enters the sandbox process,
  there's nothing there to leak or replay.
- **The PR *read* verbs mint their own set, and it is deliberately not the checkout one.**
  `check_pr_status`, `get_pr_feedback`, `walk_pr`, `subscribe_pr` and `post_pr_walkthrough`
  all begin at `GET /repos/{owner}/{repo}/pulls/{number}`, which GitHub refuses to a token
  that did not **ask** for `pull_requests` — a mint narrows to its request body, so the
  installation's own grant is irrelevant. They mint `contents:read` + `pull_requests:read` +
  `metadata:read`, host-side, held in memory for the API call and written nowhere. The
  checkout set stays exactly as it is precisely because it is the one credential that
  *persists* (into the clone's git config on the fallback path); the transient one carries the
  extra read scope so the persisted one never has to.
- **The conversation verbs mint a set that names *both* permission families.** A GitHub
  conversation is an issue **or** a pull request, and both are reached through the same
  `/issues/{n}` endpoints. GitHub does not follow its own API model here: it routes those
  endpoints by the **resource the number names**, so a token that asks for only one family is
  refused 403 on the other. The conversation *read* (`read_channel` / `read_thread` and the
  event-hydration re-read) therefore mints `issues:read` + `pull_requests:read` +
  `metadata:read` — and no `contents`, because it fetches comments, never files. The
  conversation *write* (the `reply` / `edit_reply` / `react` arm) mints `issues:write` +
  `pull_requests:write` + `metadata:read` — and no `contents`, so the reply credential still
  cannot push code. Both were measured: with one family each, the read was refused on every
  plain issue and the reply was refused on every pull request.
- **The PR flow mints write, and it never touches the firewall.** `open_pull_request`
  mints the write set (`contents:write`, `pull_requests:write`, `metadata:read`)
  host-side per call: at propose time it rides inline in the single staging-push command
  (to the hidden `refs/oe-pending/…` ref — nothing publishes), and on the approval click
  a fresh mint drives the host-side Refs + PR API calls that publish the frozen commit.
  It is never written to disk, git config, or a standing firewall rule. A firewall-level
  write credential would be reachable by *any* concurrent code in the sandbox, not just
  the gated push — so write intentionally stays a one-shot, in-memory credential scoped
  to each call.
- **Fallback, only where firewall enforcement genuinely isn't available.** On a
  deployment or backend that can't enforce the sandbox network policy (the
  `egress.allowUnenforced` dev escape hatch, or `egress.enforce: false` dry-run —
  see [Credentials & the two planes](../security/credentials-and-planes.md)),
  `checkout_repo` falls back to baking the read-only token into the clone directly (as
  an `http.extraheader` in local `.git/config` — never in the remote URL, so `remote -v`
  stays clean), same as before this was firewall-brokered. A deployment with enforcement
  actually working never takes this path.

Tokens are redacted from logs and errors. Every token expires on its own; nothing revokes one
early. They are never a shared long-lived secret. This bounds blast
radius and gives a clean per-session audit trail. See
[Credentials & the two planes](../security/credentials-and-planes.md).

## Per-binding capability sets

Every set above is a **job set**: what one kind of work needs, declared narrow and uniform
across every repo and every domain. That is the default, and a repo granted as a plain string
gets exactly it:

```ts
defineBundle({ name: "coding", repos: ["acme/web"] })
```

A binding can **opt one repo into more**, by naming a capability set:

```ts
defineBundle({
  name: "infra",
  repos: ["acme/web", { repo: "acme/infra", capabilities: ["pr-admin", "workflows"] }],
})
```

The mint for a call is then the job set **plus** the families those named sets carry, keeping
the stronger grade for a family both name. An expansion can only add; it can never narrow a job
set, and it can never lower a grade the job already holds. An expansion is visible at the point
of consent: where the App covers the repo, the `open_pull_request` approval card names the
expanded grade the click mints.

The sets this deployment implements:

| Capability | What it adds | Why you would name it |
|---|---|---|
| `pr-admin` | `pull_requests: write` | GitHub lists the issue-mutation endpoints under the Pull requests permission too, so the narrow ticket-action set is refused on a **pull request**. Name it in a domain that triages and closes PRs. |
| `workflows` | `workflows: write` | GitHub refuses a push that adds or changes a file under `.github/workflows` unless the token carries this. Name it in a domain whose work includes CI changes. |

Four rules hold this together, and each one is deliberate:

- **A capability is a name, never a permission string.** `capabilities: ["pr-admin"]` is
  writable; `{ pull_requests: "write" }` is not. Config load refuses an unknown name. So the
  reachable permission families stay closed in code. Capability sets are GitHub-only today:
  GitHub's mint composes a fresh permission body per call, and a named set maps onto that body.
  Linear mints one token per workspace, cached up to 30 days; Notion's secret is static, scoped
  once in Notion's UI. Neither has a per-call body to map onto, so a non-GitHub work source needs
  its own enforcement point, not a mapping onto this schema.
- **The App installation is the only global ceiling, and this config never restates it.** If
  you do not want the agent doing something, do not grant the App that permission. GitHub
  refuses a mint that asks past the installation, and that refusal is audited
  (`github.token_mint_failed`) — the always-on backstop.
- **No expansion can reach `contents`.** The checkout set is the one credential that persists
  (into a clone's git config on the fallback path), so a raisable `contents` would hand cloned
  code a pushable token. The rule is enforced at the mint, not left to review.
- **Grants are per repo, so org-level GitHub power is not expressible here.** Every binding
  names repositories and every family is a repository-resource family.

`permission_fit_report` answers the config question before you write the PR: for each repo the
domain grants, it lists every capability set, whether this domain already declared it, the exact
config line to add, and whether the App installation can honour it today — including the
owner-approval step when it cannot.

## Reading the repo's own conventions

A lazily-cloned repo's agent guidance is **not** auto-loaded — the runtime's rule system
is the deployment's own instructions and skills, not a cloned repo's files. So on clone,
`checkout_repo` **detects** the repo's convention file — `AGENTS.md` preferred,
`CLAUDE.md` as a fallback, root only — and returns a lightweight **flag**
(`{ file, lines, bytes }`) plus a nudge to read it before changing code. It returns the
flag, **not** the content: the editing agent reads the file on demand with its file tools,
so a large guide doesn't pollute the caller's context. This closes the exact gap that bites
an agent which hand-edits a generated file without first reading the repo's rules.

## Skills shipped in the repo

A repo can also ship **skills** the agent should have while working on it — deploy
runbooks, migration workflows, test conventions — as `SKILL.md` packages. On checkout,
`checkout_repo` looks for a skills root: **`.agents/skills/` is preferred**; only if that
directory is *absent* does it fall back to `.claude/skills/`. The two are never merged.
Each `<root>/<name>/SKILL.md` becomes a session skill, re-resolved every turn alongside
the bundle-granted set (see [Skills & plugins](./skills-and-plugins.md)), and the
checkout result lists what was found.

Two rules keep this from widening anything:

- **Namespaced, never bare.** A repo skill is exposed as `<repoSlug>--<skill>` (e.g.
  `payments-api--deploy`); if two checked-out repos share a short name, the slug falls
  back to `owner--repo`. Bundle-granted skills and runtime-authored
  [domain skills](./skills-and-plugins.md#runtime-domain-skills) keep their bare names and
  **always win** a collision — a repo can never shadow either.
- **The grant is the gate.** Repos are only checkoutable when a bundle grants them
  (fail-closed), so repo skills arm only for repos the deployer already trusted with the
  session — no separate skill gate is needed. A re-checkout refreshes the repo's skills
  wholesale; discovery is capped (20 skills, 32 KB per `SKILL.md`) so a repo can't flood
  the session.

Note this is *skills*, not connections: a cloned repo's `.mcp.json` is still never
loaded (see [Skills & plugins](./skills-and-plugins.md)) — repo skills carry know-how,
and their scripts still only reach the hosts and credentials the bundle granted.

### Delegation personas (repo agents)

Repos can also ship Claude Code-style **agent definitions** — `<name>.md` files with
YAML frontmatter (`name`, `description`, optional `model`/`tools`) and a persona body.
The same discovery applies: **`.agents/agents/` is preferred**, `.claude/agents/` only
when that directory is absent, never merged, capped (10 agents, 32 KB each).

The runtime's own sub-agents are **deploy-frozen** (defined in code, compiled into the
build — the dynamic seam covers tools, skills, and instructions, not sub-agents), so a
repo agent can't become a real sub-agent at runtime. Instead each becomes a
**delegation-persona skill**, named `<repoSlug>--<agentName>` under the same
namespacing and granted-wins rules (within one repo, a same-named *skill* beats the
agent). The skill's description is the agent's `description` — the same when-to-delegate
signal it carries in Claude Code — and its content is a trusted header explaining how to
consult the persona (call the built-in `agent` tool, which spawns a copy of the agent;
the message starts with the persona verbatim, then the task plus all needed context,
since the child sees none of the conversation), followed by the persona body.

Two degradations of this mapping, stated plainly:

- **`model` is ignored.** The agent-tool child runs as the same agent on the same model
  (per-domain model routing still applies). The field is parsed and stored so a future
  real-sub-agent mapping can honour it.
- **`tools` allowlists are advisory.** The child inherits the parent's tools; the
  delegation header tells the model to pass restrictions along as binding instructions,
  but they are enforced by instruction, not by the harness. No security boundary weakens
  — approvals, egress, connector scoping, and repo grants all still hold — what's lost
  is intra-agent tool *narrowing*.

## What it owns at setup

The plane is configured once, as a fundamental (optional) setup step:

- **App credentials** — app id, private key, webhook secret, and installation id(s), all
  via `secretRef` (env or a secret manager), never inlined.
- **Repo universe** — which repos the installation makes reachable.
- **Bot identity** — the committer name comes from the App slug. The no-reply email needs
  `OE_GITHUB_BOT_USER_ID`, which the operator sets once. Without it the plane falls back to the
  app id, which builds an email GitHub cannot match to the bot user, so commits show no App avatar.

A self-hosted deployer **registers their own GitHub App** (one-time: app id + private
key), the same model GitHub Enterprise Server uses — you can't install someone else's
hosted App. The registration is one click: the ops MCP tool `surface_app_create` generates
the App's manifest from this plane's mint bodies, and GitHub hands the App's id, key and webhook
secret back into `.env.local` ([GitHub § Setup](../deploy/surfaces/github.md#setup)). The setup preflight detects whether the plane is configured and treats it as
optional throughout: a deployment that never hands the agent code work simply doesn't set
it up.

## Backends

GitHub (via the GitHub App) is the built backend. The seam shape for GitLab and Bitbucket,
and what a non-GitHub backend must provide, is covered in
[Source-control backends](../extending/source-control-backends.md). **Roadmap** for
non-GitHub backends.
