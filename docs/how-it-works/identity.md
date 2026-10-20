# Identity

Who *is* the agent when it acts? The answer is per-surface, and it's the difference between
a teammate that operates safely in a shared channel and one that quietly carries your
personal logins where they don't belong.

Every session reads one **`SurfaceBinding`** shape
(`packages/core/agent/identity/binding.ts`), and the whole system reads from it — the access resolver,
the memory partition, routine dispatch. It carries the org, platform, workspace, surface,
`mode`, `visibility`, `trust`, the calling `principalId`, and a post-back `target`. `bindFrom`
holds no cache: it recomputes the binding at every call site from that delivery's own facts. A
context carrying no platform identity — a `send()`-created session's tool context — falls back to
the identity a hook of this session stamped (`identity/binding-bridge.ts`). A subagent child that
loses that stamp binds fail-closed to the org default (`subagentBindingLost`), with no grants.
A delegated worker binds to the dispatch binding of the wake that launched it
(`identity/delegated-binding.ts`). That binding is durable session state, and the worker reads it in
every process its turn runs in. A worker that cannot read it binds to the `subagent/…/unresolved`
sentinel, and its `grant.mount_refused` row names the reason `binding-unresolved`.

## Two principals, two universes

The single most important thing to understand is *which identity the agent acts as*:

- **App principal — the service identity.** One shared identity per org. It's what runs in
  **channels and team domains**. Everyone in a channel works with the same instance; its
  actions are attributable to the service account. What it can reach is gated entirely by
  the channel's [bundle](./access-and-scoping.md).
- **User principal — the calling human's own grant.** Obtained by an interactive browser
  OAuth consent, it exists **only in that person's DMs** with the agent. It's how personal
  tools (your own Notion, your own calendar) stay attached to *you*, not to the shared org
  identity.

**Channel work never authenticates in a user context.** This isn't a guideline — the resolver
refuses a `principal` or a `group` grant outside a DM: both scope levels answer `false` for a
channel or a domain request. So a personal login cannot leak into a shared channel, and a channel
cannot borrow your personal credentials.

One exception exists, and an operator arms it deliberately: the **member plane**
(`packages/core/agent/access/member-plane.ts`) admits a member's *own* connector credential into a
shared room. Five gates must all hold — both `connectors.memberPlane` and `connectors.opTiering`
armed, the domain declaring that `(connector, credential)` pair, exactly one verified requester on
the turn, a room the operator declared `internal`, and a read-tier operation. Both settings ship
off. [Access & scoping](./access-and-scoping.md#the-two-universes--service-vs-user) states the arm
in full. This is
the "two connector universes" rule; the access-side view is in
[Access & scoping](./access-and-scoping.md).

## Attribution — acts as itself, records who asked

The agent **acts on its own principal** and **attributes-to-human for audit**. In a channel
it acts as the service identity; it is not impersonating the person who tagged it. But every
action records *who asked* — the calling `principalId` — so the audit trail answers "the
agent did X, on behalf of Y." Authority and accountability are kept separate on purpose: the
agent has its own, bounded authority, and the human attribution is for the record. See
[Audit & provenance](../security/audit-and-provenance.md).

## One person, several accounts — identity linking

Attribution above answers "who asked" *on one surface*. The cross-surface version — knowing that
the Slack account in `#payments` and the GitHub login on the PR are **the same human** — is a
separate, explicitly-evidenced statement.

Two sources answer it, and the read path is their union:

- **The principals map** (`agent/identity/principals.ts`) — config-as-code, one entry per person,
  merged by PR. It stays the operator override and the zero-database fallback.

  One entry can hold **several accounts on the same platform**, each with the workspace that issued
  it — which is what a deployment serving two Slack workspaces needs, since the same human is a
  different `U…` id in each:

  ```ts
  ids: { slack: "U0EXOWNER", github: "example-owner" }                                    // one workspace
  ids: { slack: [{ tenant: "T0AB1CD2E", id: "U1" }, { tenant: "T9ZYX8W7V", id: "U7" }] }  // two
  ```

  A **bare id needs no change and means what it always did**: "this id, in whichever workspace this
  deployment serves" — exact, because a deployment refuses to boot with two workspaces of one
  platform unless the setting `identity.allowMultiTenantPrincipals: true` says so deliberately. What config load
  *refuses* is the **half-migrated** map: writing some of one platform's entries with a workspace and
  leaving others bare. A bare entry alongside a qualified one would match in every workspace,
  including the ones the qualified entries exist to tell apart. So a platform is all-bare or
  all-qualified, never in between — and a `tenant` on a platform whose ids are vendor-global
  (everything but Slack today) is refused too, because the key grammar has no workspace rung there
  and would silently discard it.
- **Link-sets** — runtime rows in the operational store, written **only** by a proof-of-control
  challenge. Config is a reviewed *belief*; a challenge is *proof of account control*, so the
  evidence is stronger, not weaker — which is why this one class of trust statement is allowed to
  be runtime state rather than a diff.

### One flow, two transports

The flow is always the same three acts, and the middle one is the point:

**A initiates, in a DM → B consents → A finalizes, in the same DM.**

What differs is how act 1 identifies B. There are two **transports** for that, and each carries
exactly one finalizer — never two finalize mechanisms on one link.

| | **Directory transport** (preferred) | **Code transport** (fallback) |
| --- | --- | --- |
| How B is named | A picks the account out of that platform's own user directory | A carries a short code to B |
| B's consent | a reply in **B's own DM** with the agent | posting `link <code>` from B |
| A's finalize | ratify — a peek that names B, then an acknowledged commit | **forced code-back**: a second code A must read on B's surface |
| Bearer secret in play | none | code-1, for ~10 minutes |
| Requires | a directory arm **and** a DM arm for B's platform | nothing |

The code transport is reached automatically whenever the directory one cannot run — no directory arm
for that platform, no way to DM an account there, or the person never named a platform. The fallback
**says which capability was missing**, so an operator can go and grant the scope rather than guess.
Directory rights are fine to require for the better path; they are never a precondition for linking
at all.

**Membership is checked at both ends** (`packages/core/agent/identity/link-initiator.ts`). A link-set
gives one person's identity reach across every surface the agent sees, so growing one is for
confirmed members: on a platform whose internal/external verdict is real evidence — Slack and
`local` — a caller the binding reports as `external` (in a DM that means an unverified partner, a
multi-channel guest, a Slack Connect stranger) is refused, and told so plainly. On every other
platform that verdict is *absence of a check*, not a finding, so it isn't grounds to refuse.
`confirm_link` applies the identical gate, so standing is checked when the request is opened *and*
when it is committed, not only at the start.

#### The directory transport

1. In a **DM**, the person names the platform and a name to search for. `link_identity` returns
   **candidates** and writes nothing — a directory hit says an account with that name exists and
   nothing whatever about whose it is. Names collide, and anyone can set theirs to yours.
2. The person picks one. `link_identity` opens a request naming that exact account, and DMs it a
   consent ask **that names the initiator**. No code exists anywhere in this transport.
3. In **their own DM**, the named account answers. `confirm_link` peeks first — naming who asked —
   and only then records the consent. Denying writes nothing and is terminal.

   **Or they tap a button.** On a surface with a component plane (Discord today) the ask carries two
   buttons and a tap resolves the whole consent with no model turn at all. The button is a
   **shortcut, not a second door**: it runs the same commit — the same code-back decision, the same
   compare-and-swap, the same notice to the initiator. It adds **no** security, because the consent
   was already scoped to the named account whatever the person types. It also takes none away: the
   lookup behind a tap is filtered on the tapping account's own `(platform, tenant, native id)`, so a
   tap by anybody else finds no request — and gets the same answer as somebody whose request expired,
   so the button is never an oracle for whether a challenge id names a real person. A tap carrying a
   server id is refused before any lookup: a consent ask only ever lands in a DM, and a private
   identity outcome must never surface in a room. The ask's own text never mentions a button, because
   a surface with no component plane delivers the text alone.
4. Back in the initiator's DM, `confirm_link` names the account that consented and commits it.

**Consent from the wrong account is refused by the database, not by a check.** The account the
request named is three columns on the challenge row, and they are conjuncts of the compare-and-swap
that records a consent — so a consent from any other account matches no row and writes nothing. The
same statement carries the single-use and TTL conditions, so a second consent and a late one lose it
too.

**The consent ask names the initiator** because that is the whole security value of initiating in
reverse: an attacker who starts a link *at* your account produces an unexpected DM naming a stranger,
which is an easy human judgement — far easier than spotting a wrong account in a confirmation you
were expecting.

#### The code transport

1. In a **DM**, the person asks to link an account. `link_identity` mints a short, single-use code
   with a ~10-minute life and the host posts it directly into that same DM. It links nothing.

   **The model never receives the live code.** The tool result only says that the private host post
   landed. If the platform later returns the bot's own post through backscroll or a read verb, the
   model-facing projection replaces the code with a fixed omission marker. Human-authored claim
   messages stay intact so the pre-model claim hook can spend the code. The same rule protects the
   second code below: it is host-delivered to the consenting account and removed from machine-authored
   history before a model can read it.
2. They post `link <code>` **as the other account**. The wake pipeline captures the author's
   `(platform, workspace, native id)` on every surface, and that captured author — never anything the
   message *says* about who wrote it — is what gets stamped onto the challenge.

   **On a platform the agent can DM, the claim must be made in a DM.** A code is a secret for as long
   as it lasts, and a room has an audience — so a claim addressed to the agent in a channel or a group
   DM is refused with a pointer to the DM, and **the code is not spent** (the venue check runs before
   the claim's compare-and-swap, so that is a fact rather than a reassurance). Every platform with no
   DM delivery arm keeps its room claim under this rule: a room is the only place a claim can be made
   there, and refusing it would delete cross-platform linking outright. That claim must still be
   *addressed* — see the next rule but one, which is a separate check.

   **"Can DM" means an arm is registered — Slack, Discord and Teams ship one.** The rule reads the arm
   registry on every claim, not a list, so any surface that ships a DM arm starts refusing room claims
   the same day with no change in the rule. Teams reaches a person through a stored Bot Framework
   conversation reference; where it holds none and cannot open one, the delivery is refused out loud
   rather than silently dropped (see *Teams needs a stored address* below).

   **The message must contain nothing but the claim.** `link <code>` is its *entire* body — no
   "thanks", no signature, no surrounding sentence. Where the surface reports the wake as
   *addressed*, one leading address token may precede it. A code sitting loose in a busy channel
   would otherwise be claimable as whoever happened to wake
   the agent next, so the agent only ever reads a claim out of one message it can attribute to one
   author. A claim that doesn't work is answered on the spot rather than left to expire.

   **The claim must also be addressed to the agent.** A `link <code>` line that addresses nobody
   claims nothing, wherever it is posted. A link binds one human to a second account, so the claim is
   the evidence that a person *meant* to bind it — and a bare line in a room the agent watches anyway
   is not that evidence.

   **Each surface's own addressing form counts, and the agent reads the surface's verdict rather than
   the text.** Every surface stamps that verdict on the wake itself, and the claim reads the stamp:

   - a **DM** is addressed by construction — Slack, Discord and Teams stamp every 1:1 delivery;
   - a **GitHub @mention** is stamped by the native comment leg. This one is load-bearing: the
     framework *removes* the `@bot` token from the body before delivery, so an addressed comment
     arrives as a bare `link <code>` line and only the stamp still says it was addressed;
   - a **Linear agent session** is stamped on the session itself — a person opened it by delegating
     to the agent, which makes it Linear's DM-shaped venue;
   - a **Notion name-drop** is stamped by the classifier. Notion lets no user @mention an integration
     at all, so the name-drop *is* Notion's addressing, and it claims exactly like an @mention;
   - a **single-window @mention** is stamped where `window.topology` is armed and the surface is
     vouched. That is an additional path, never the only one — it is off in the shipped default, so
     each surface's native leg above is what carries the claim.

   A surface with neither mentions nor DMs therefore keeps its claim path, and every surface is held
   to the one rule. An unaddressed line is answered on the spot, **the code is not spent** (the check
   runs before the claim's compare-and-swap), and the refusal lands on an
   `identity.link.claim_unaddressed` audit row.
3. The agent answers **the claiming account, where it posted**, with a **second code**, and comes back
   to the originating DM naming the account that claimed the first one. The link is committed when the
   initiator gives that second code — `confirm_link` refuses unless the caller is that same person, on
   that same platform and workspace, in a DM. Denying writes nothing at all.

**One live code per loop.** A turn that has just answered a link request cannot start a fresh link.
The rule covers both doors: the claimant of an open code challenge, and the consenter of an open
directory request. `link_identity` refuses in that conversation with one line, and the line names the
step that is still waiting — the pending second code, or, where that code could not be delivered, the
initiator's own confirmation. Without the rule, the answering turn can mint a second code into the
same DM: the person then holds two live codes and two contradictory instructions, and nothing tells
them which one the agent waits on. The rule narrows the tool and grants nothing. An expired answer is
not an open one, so the refusal always points at a loop the person can still finish.

**Why the second code.** On this transport the initiator's confirmation arrives exactly when they
expect one, so an intercepted code plus a reflexive "yes" would link an attacker's account — the
OAuth device-code-phishing shape. The second code removes the reflex: the initiator cannot finish
without *reading the other account's own conversation*. Code-1 proves the claimant saw the
initiator's DM; code-2 proves the initiator saw the claimant's surface. Together they prove one human
reads both, which is exactly what a link asserts.

The second code is **not a secret** and publishing it costs nothing — it may land in a public GitHub
or Linear comment. Only that challenge's own initiator can spend it, so a stranger who reads it holds
a value naming nothing they can act on.

**Where it cannot be delivered, the flow degrades rather than dead-ends.** A surface with no
mid-turn post arm has nowhere to post a second code. The claim still stands, the finalize falls back
to the acknowledged confirmation, and the downgrade lands on an
`identity.link.code_back_undeliverable` audit row — a fail-soft nobody can see is indistinguishable
from a bug.

**Every surface Open Everywhere wires today can receive the second code.** GitHub was the one that
could not, and it gained a mid-turn post arm with the uniform delivery surface, so the degradation
below is unreachable on the shipped surface set. It is documented because the branch is real and a
future surface can reach it.

**That degradation is reachable by design, and it is the price of the trade.** The claimant chooses
which surface they claim from, so somebody holding a stolen code could claim from a platform with no
post arm and *select* the weaker finalizer. The alternative is refusing every claim from such a
surface, which deletes cross-platform linking — the same over-strict shape that broke claiming once
already. What
still holds on that path is everything the flow had before the second code existed: a single-use,
10-minute, 39-bit code enforced inside the claim's compare-and-swap, one single-author message, the
captured author rather than anything the message says, and the initiator's own DM naming the claimant
before a single row is written. The residual closes on its own the day that platform gains a post arm.

#### Teams needs a stored address

Slack and Discord open a direct message from a bare person id under the bot token. Teams cannot. A
Bot Framework write goes to a **regional** `serviceUrl` and a Microsoft-minted conversation id, and
neither is derivable from a person id, a surface key, or anything else the agent holds. Both values
exist only on an inbound activity.

So the deployment **captures** them. Every inbound Teams activity the agent acts on records a
conversation reference: a **1:1 chat** reference keyed on the person, from a personal chat, and a
**team** reference keyed on the team, from a channel. The rows are refreshed by every later activity,
because Microsoft makes no promise that a tenant keeps its region. They are operational data and live
in the operational store, never in configuration.

Both Teams arms read that capture:

- The **DM arm** posts into a stored 1:1 chat. Where it holds none but knows exactly one tenant, it
  opens the chat first and remembers it. Microsoft refuses that open unless the person has installed
  the Teams app in the personal scope, so a Teams DM reaches the people who have the app and not the
  whole tenant — and where it cannot reach somebody the delivery is **refused out loud**, naming the
  reason, rather than silently dropped.
- The **account directory** reads the Bot Connector roster of the captured teams —
  `pagedmembers`, not Microsoft Graph. The reason is the id shape: a Teams link keys on the Bot
  Framework `29:` user id, and Graph answers with AAD object ids and UPNs, which no link can key on
  and no message can be addressed to.

Three consequences follow, and none of them is a bug to fix later. A deployment whose bot has never
seen a Teams channel has no directory. A person the bot has never met, in a deployment serving two
tenants, cannot be cold-messaged — the agent will not guess which organisation a bare `29:` id belongs
to. And a Teams consent ask carries no buttons: Teams has no component plane wired here, so the text
stands on its own, exactly as the ask is always written to.

#### Both transports: what the two-call shape is worth

**A commit takes two tool calls, and the first one writes nothing.** Every notice in this flow is
posted out of band, so it reaches the person's screen but not the model reading their DM.
`confirm_link` therefore answers a `confirm` that carries no `acknowledge` (and no code) by *naming
the account it is about* and writing nothing; the second call, carrying the `challengeId` the first
one returned, commits. Both fit in one turn when the person has already said yes, and the agent never
has to ask which account is involved — a question the person cannot answer.

**This repairs blindness. It is not a barrier against a model that ignores its instructions**, and it
would be wrong to read it as one. `link_identity` hands back the `challengeId` when the request is
opened, so a model that kept it can pass `acknowledge: true` with that id on its very first
`confirm_link` call and commit an account it never put in front of anybody. What the two calls buy is
that the account's identity is *in the model's context* before the commit, so what the person is shown
names a real account off the challenge row instead of a guess or a question.

**The code-back is the one step that does not rest on the model's cooperation.** Code-2 is minted at
consent time and posted to the *other* account's surface, so a model finalizing that link has to be
told it by a human who read it there — it cannot be produced from context. Where a row carries no
code-back — a directory link with the strictness knob off, or a claim from a surface with no post arm
— the paragraph above is the whole of the guarantee, and the human reading the named account is the
check that matters.

If a notice never arrives at all — a Slack bot missing `im:write`, a provider outage, or a platform
with no DM delivery arm, where it is never attempted — the flow still completes on the person's next
DM turn, and the missing delivery lands on an `identity.link.notice_undeliverable` audit row instead
of only in a log.

**The code-back requirement is read off the row, never off the setting.** The two calls are separated
in time, so a `identityLinking.codeBack` flipped in between must neither strand a person holding a
code the tool now refuses nor drop a requirement the consent already enforced. The knob is consulted
once, when the consent is recorded.

**One tool answers whatever is waiting.** `confirm_link` looks for three things, in order: a request
*this person started* whose target has consented, a request aimed *at their account*, and an account
an identity-directory sync suggested for them. With more than one waiting it refuses and lists them —
each with its role, because "you asked about X" and "X asked about you" are different questions.

**SSO is the enterprise answer to all of this.** An org on SSO/SCIM gets linking through directory
sync (below) and never touches the manual flow. What is described here serves small orgs, guests, and
platforms that sit outside the IdP.

**Every account in this flow is named for a human, not for a machine.** The person reading a notice
*is* the security check on their side of it — an expected confirmation gets approved reflexively, and
a name is what makes a wrong account visible at a glance. So every notice, every peek and every
directory candidate resolves a display name + handle where a platform arm exists
(`packages/core/agent/identity/account-display-name.ts` — Slack is wired today), and otherwise falls
back to platform-named prose (`the slack account "U0AAAA0000"`) — never a bare principal key such as
`slack/T0EXAMPLE/U0AAAA0000`. The resolution is fail-soft and best-effort: a lookup that fails or
finds nothing never blocks a notice, it only degrades the wording. `confirm_link`'s own output still
carries the exact principal key too (`claimant`), for a model that needs to match or record it —
`claimantName` is the field to show the person.

**The resolved name is that account's own choice, not a fact this deployment asserts.** It is a
self-set profile string (a Slack `real_name`/`display_name`), so anyone can make it read as anything
— the security value is entirely in the raw id staying visible alongside it, never in the name alone.
The name is sanitized before it reaches a notice or a model (control characters and newlines
stripped, length capped), and every model-facing use additionally fences it as untrusted content,
because a crafted name could otherwise be written to mimic one of this flow's own instructions.

**A claim is gated by trust, not just shape.** The claim leg derives its own tier from the binding
(`packages/core/agent/hooks/link-claim.ts`), in the same four-tier vocabulary the wake pipeline uses
(`packages/core/agent/identity/wake-trust.ts`). The shape checks run first: the body must be one
author's whole-message claim, and the wake must carry a captured author. The tier then decides
whether that claim is considered at all — before the venue check, and before the claim's
compare-and-swap, so a refused tier never spends the code. A `relay` author — a bot, a webhook, an
unattended or attested fire, in short: nobody acting — is refused on every platform, because
"nobody is acting" is a fact the binding establishes on its own, everywhere. An `unauth` author is
refused only on a platform whose internal/external verdict is actual evidence — today that's
Slack (a live membership recheck) and the `local` surface — because a real check there means an
`unauth` verdict really does mean "an outsider posted this." On every other stock platform —
GitHub, Linear, Notion, Discord, Teams — there's no membership mapper at all, so the binding can
only ever report `unauth`, whether the poster is a colleague or a stranger; treating that
absence of evidence as a refusal would silently delete the very cross-platform claim the code
transport depends on (a GitHub comment, a Linear comment) on every deployment that hasn't
hand-vouched each surface.

Refusing on tier is a belt, not the buckle: five guards hold on every platform regardless of
tier — the code is a 39-bit, single-use, 10-minute bearer token enforced inside the claim's
compare-and-swap, so it's neither guessable nor replayable; where the agent can be DM'd it must
arrive in a DM, so it is never published to a room; it must arrive as the whole body of
one single-author message, so the code and its claimant provably come from the same author; who
claimed it comes from the surface's own acting-principal resolution, never from what the message
says; and nothing is written until the initiator finalizes it in their own trusted DM, with the
second code where one could be delivered. A platform that later gains a real membership mapper is
simply added to the trusted set, and the gate tightens there automatically.

**Every account in the set is told when the set changes.** Adding an account or removing one sends a
DM to every *other* confirmed member — and an unlink also tells the account it just removed — so a
change to who you are here is never something that happens quietly. This is **notification, not a
vote**: any member may still grow or sever the set (that is what linking means), and nobody has to
approve anybody else's decision. It is best-effort by design: it only reaches accounts on a surface
the agent can DM, so a GitHub, Linear or Notion account in the set hears nothing, and a set whose
only DM-capable account is the one that was compromised hears nothing at all. The audit row
(`identity.link.confirmed` / `identity.link.unlinked`) carries the set's size and whether link-set
membership was credential-bearing at the time, which is the trace that survives either way. An unlink row also counts the removed account's purged credentials, and it names in `unrevoked` each
connection whose revocation call at the provider failed twice (OPE-2565).

**These notices are named for a human too, and are plain text.** The account that joined or left is
resolved the same way the claim notice is (a display name + handle where a platform arm exists, else
platform-named prose) — the growth notice also keeps the exact principal key in its "ask me to
unlink" sentence, so a stable, unrenameable anchor sits next to the name. And every notice this
feature sends is plain text, never `**bold**` — these strings travel through DM-delivery arms to
whichever platform the recipient is on, and GitHub-flavoured markdown renders literally almost
everywhere else (measured live on Slack, 2026-08-16).

`unlink_identity` is the off switch, and it is deliberately the easiest verb in the flow: DM-only,
one call, and it removes **any** account from the caller's own set — not just the one they are
speaking from, because someone who has lost access to an account is exactly who most needs to
detach it. A person never needs an admin's help to stop being associated with an account.

Three invariants, ported from the config map's load-time checks to write time:

- **An account is exactly one person.** A `(platform, workspace, native id)` belongs to at most one
  link-set — a primary key in both database backends, plus a check in the write API so the refusal is
  readable. The **workspace** is part of the account because on some platforms a person id is issued
  *per tenant*: two Slack workspaces can hand out the same `U…` string to two different humans, and
  without that column they would be one row and therefore one person. Platforms whose ids are
  vendor-global — everything but Slack today — store an empty workspace and behave exactly as before.
- **`confirmed` requires evidence.** Every confirmation records *what* convinced the system (which
  challenge, or which directory sync), on the row.
- **Nothing joins on a name.** Display handles are shown in admin lists and audit rows and are never
  lookup keys — an account renamed "Rowan Hale" does not become Rowan. Same rule, same reason as the
  config map's fail-closed-on-merge.

If both sources claim one account **for different people**, no merge happens for that account and a
loud warning surfaces in the unified-domain view. That account simply stays a distinct per-surface
identity, which costs it the cross-surface treatment and nothing else.

Admins get the offboarding levers on the [control plane](../security/control-plane.md):
`link_sets_list` shows every set with each account's status and the evidence behind it,
`suspend_link_set` / `reactivate_link_set` are the reversible hold, and `revoke_link_set` is
terminal — it tombstones every account on the set so none of them can be re-linked by a later
challenge. Every mutation appends an audit row (`identity.link.*`).

**Automatic offboarding when a surface reports a deactivation (OPE-2423).** When Slack sends a
`user_change` event whose user is `deleted`, OE runs the same `revoke_link_set` lever by itself:
the person's link-set is revoked, every account on it is tombstoned, and the credentials stored
against it are purged (below). The lever also ends the two holdings that live outside the vault
(OPE-2504): it revokes every credential grant a confirmed account on the set lends, and it forgets
each confirmed account's personal browser, which deletes the saved profile and its logins on the box
backend. The lever spares a `suggested` account on the set, because a suggestion does not prove the
account is this person. Gate 4 below covers the deactivated account itself. This is the one terminal revoke a machine signal can cause, so every
gate fails closed, and a refusal leaves things exactly as an admin would find them without it:

1. **The same workspace.** The deactivated account must belong to the workspace that delivered the
   signed event. A Slack-Connect partner's user, seen through our workspace, refuses here.
2. **A named workspace.** The delivering workspace (or its Enterprise Grid) must be named in config,
   in a domain's reach. The front-door tenant fence is inert when config names no workspace; that
   is not enough for a terminal revoke, so such a deployment never offboards automatically.
3. **A live confirmation.** OE re-reads the account with `users.info` under its own bot token. The
   account must come back `deleted` and in that workspace. The event body is never the evidence, so
   a forged or replayed event, or one that a reactivation has overtaken, causes nothing. Without the
   `users:read` scope every report refuses.
4. **A proven link.** Only a `confirmed` account revokes its set. An account with no link-set, or
   only a `suggested` one, has its own stored credentials purged, its lent grants revoked and its
   personal browser forgotten, and nothing else.
5. **One workspace's word covers one workspace.** The whole-set revoke is refused
   (`cross-workspace-set`) when the set also holds a confirmed account on the same platform in
   another workspace. Under the `identity.allowMultiTenantPrincipals` opt-in — the only posture in
   which an admitted Slack workspace can be a partner's — it is refused when the set holds ANY
   confirmed account outside the reporting workspace, Teams and Discord included. Only the
   deactivated account's own credentials are purged, its own lent grants revoked and its own
   personal browser forgotten, and an admin decides the rest. So a partner
   workspace cannot revoke a person's standing in ours.

A deactivated **guest** of an admitted workspace is offboarded exactly like a member. Each report
writes one `identity.offboard.applied` or `identity.offboard.refused` row, and a refusal names its
reason and the manual lever. Teams and Entra send no deactivation event to a bot, so on Teams the
daily [directory sync](#pre-populating-links-from-an-idp-okta) (when an IdP is configured) and the manual levers remain the
offboarding path.

**Revoking also destroys the credentials, not just the reach.** Tombstoning severs *reachability*:
no account resolves to a revoked set, so nothing derives the shared subject that keys the person's
stored OAuth tokens. That is necessary and it is not sufficient — the encrypted tokens would still
be sitting in the store, and still live at the provider. So a revoke additionally **purges** them:
each provider's token is **revoked at the vendor** (RFC 7009, where the authorization server
publishes a revocation endpoint — it is optional metadata, and a server that publishes none is
simply skipped) and then **deleted from the vault**. The local delete never waits on the vendor: a
provider being down, or refusing the call, never leaves the secret at rest with us. A refused call is
tried once more, and a second refusal is recorded, not only logged (OPE-2565): the audit row names the
connection in `unrevoked`, and the lever's note says the token stays valid at that provider until it
expires. A refused revocation of a person's identity-provider grant (an `xaa` sign-in) is named as
`idp:<issuer host>`, because that grant belongs to the identity provider, not to one connection.

The purge is **best-effort in the other direction too, deliberately**: if the vault is unreachable
the revoke still stands, because a credential store having a bad day must not be able to stop an org
offboarding somebody. The outcome is written into the audit row either way
(`credentialsPurged: <n>`, or `purgeFailed: true`), so a purge that did not happen is visible rather
than silent — and `purge_link_set_credentials` finishes the job afterwards. That same verb is what
you use for a set revoked *before* this existed, and for a suspected token compromise where you want
the credential dead without spending the terminal revoke.

**What the sweep covers.** A person's credentials live under two key shapes: the **link-set** subject
that their confirmed accounts share, and each account's own **per-account** subject (which is what a
caller keys by whenever no link-set applies — unlinked, suspended, or the feature off). A revoke
sweeps **both** — the set's shared subject, and the subject of every account it just tombstoned. It
has to: a per-person credential like an **AWS Identity Center token** is keyed per account and has no
shared form at all, so a shared-only sweep would leave an offboarded person's stored AWS token alive
and still minting credentials from their DM.

Only the accounts **on the set** are swept. Nothing else about the person is enumerable from a
link-set, and nothing else should be. `unlink_identity` follows the same rule at single-account
scale: severing an account destroys that account's own stored credentials and leaves the rest of the
set untouched, so a severed account cannot go on using a token it earned while it still had standing.
Re-linking is unaffected — the person simply re-consents.

The one credential class a revoke cannot reach is a **warm minted** one already cached in a running
process (AWS session credentials, git installation tokens, the Linear actor token). Revoking the
source stops the next mint; the bound on a warm copy is documented in
[What revoke actually reaches](../security/revocation-latency.md).

**The one-off re-consent, and the rows it stranded.** The per-account subject is a *composed* string,
so when the composition changes, the address of every row keyed by it changes with it. That has
happened once, when Slack keys gained their workspace rung: a Slack account's per-account subject
went from `p:<org>/slack/<member-id>` to `p:<org>/slack/<workspace-id>/<member-id>`, with no
read-through to the old shape — deliberately, because an unqualified key *is* the aliasing the rung
deletes, and having both grammars live at once would be the one state that must not exist. Everyone
holding a Slack per-account credential re-authorised once, which is the visible half.

The invisible half is that the old rows stayed. Nothing composes the two-segment subject any more,
so nothing can **resolve** one — it is dead weight rather than a live grant through this deployment.
But by the same token nothing can **purge** one either: the revoke sweep above finds an account's
credentials by *composing* its subject, and a pre-rung row's subject cannot be composed, so the
sweep skips it. A credential the product cannot destroy is not an acceptable residual, so it is
destroyed out of band instead, by an operator running

```
# from packages/core — dry run first; nothing is written without --apply
DATABASE_URL="postgres://…" npx tsx scripts/purge-orphaned-vault-rows.ts --org <org>
DATABASE_URL="postgres://…" npx tsx scripts/purge-orphaned-vault-rows.ts --org <org> --apply
```

It walks the org's stored-credential refs, matches only the exact old shape on a platform that is
workspace-scoped today, and writes an `identity.credential.orphan_purged` audit row per deletion.
The matching is fail-closed in the direction that matters: a platform whose ids are *not* issued
per workspace still keys by two segments, so a live `p:<org>/discord/<id>` row looks exactly like a
stranded Slack one. Anything today's grammar can still compose is left alone, and anything the tool
cannot classify with confidence is reported and left alone too.

### Pre-populating links from an IdP (Okta)

Typing `link_identity` once per account per person is fine at ten people and a wall at two
hundred. So an enterprise directory can **pre-populate the suggestions** — and only the
suggestions.

The rule that makes this safe is one sentence: **the IdP is a sync source, never a live
dependency and never a merge authority.** Concretely:

- **Never live.** Nothing on a request path calls the directory. The access resolver is pure and
  I/O-free by design; a query-time IdP call would make an Okta outage either kill all access
  resolution or silently widen it. A scheduled pass materialises state; runtime reads only ever
  see rows.
- **Never an authority.** Everything a sync proposes lands as a `suggested` link, which resolves
  to *nothing* — attribution is unchanged until the person taps confirm in their own DM. That
  confirmation goes through the same `confirm_link` tool as a proof-of-control challenge, requires
  the same standing (you must *be* one of the accounts in the set), and is recorded as the
  degenerate challenge it is. Denying writes nothing at all.
- **Narrowing is the exception, and it goes the safe way.** A person the directory reports as
  **deprovisioned** has their link-set **suspended immediately**, with no wait for the person's own
  confirmation — offboarding stops being a memory test. It is never a revoke. The sync leaves the
  terminal decision to a human (`revoke_link_set`) or to the surface's own confirmed deactivation
  report (automatic offboarding, above).
  The sync only suspends a set it built. A set holding any challenge-proven account is a
  human-built set, so the sync leaves it alone, records a no-op and warns. An admin then uses
  `suspend_link_set` or `revoke_link_set`.
- **Absence is not evidence.** An account the directory has simply stopped mentioning — or never
  knew about, like a personal GitHub login proven by a challenge — is never unlinked or revoked. A
  sync has no unlink step at all.
- **Ambiguity is a loud no-op.** If one directory record's accounts already sit in two different
  link-sets, or two directory records claim one account, nothing is written and the plan carries a
  warning naming the sets. `directory_sync_status` surfaces it.

Each proposed mapping carries an **evidence grade**, and the grade is a statement about *who
agreed*, not about how confident the IdP sounds:

| Grade | What it means | Who agreed |
|---|---|---|
| `attested` | The IdP **provisions** the account — a SCIM app assignment whose app-side id the downstream platform handed back at provisioning time. | Both sides. |
| `asserted` | The IdP **states** the mapping and nothing downstream ever confirmed it — an IdP-side field like Okta's `credentials.userName`, which a profile-mapping expression an app-admin or helpdesk role can edit. | The IdP only. |
| `email-match` | The two sides were joined on a **server-attested email** matching on both. An inference over a shared attribute. | Neither, about *this* account. |

The one org-level policy escape — the setting `directory.autoConfirm: "attested"`, **off by default** —
auto-confirms `attested` mappings only, because that is the only grade with a downstream fact
behind it. `asserted` and `email-match` always wait for a person.

The grade also decides **who may ratify a suggestion**. An `attested` suggestion can be confirmed
by any already-confirmed member of the set — there is a provisioning fact for them to corroborate.
Anything weaker is ratifiable **only from the named account's own DM**: an `asserted` mapping is
one editable IdP field, so a fellow member confirming it would be vouching for something nobody
downstream ever checked.

**The escape closes again wherever a confirmation would hand out a credential.** Two cases, and in
both the mapping simply lands as an ordinary suggestion awaiting the person's own DM tap, with a
loud warning in `directory_sync_status` saying why:

- the target link-set is **named by access config** — a `principal` credential binding or a
  person-group `{ linkSet }` member. Confirming into it would widen a credentialed grant on an IdP
  edit alone.
- **`connectors.linkSetVault` is armed** (the shared user-OAuth vault). It SHIPS armed (OPE-2414),
  so one consent covers all of a person's linked accounts. Then *every* link-set is
  credential-bearing — the vault is keyed by the set, so any confirmed member can mint the set's
  shared token — and auto-confirm is suppressed for **all** sets, named or not. With the shipped
  default, expect `attested` to confirm nothing; that is the guard working, not a misconfiguration.
  A person confirms each link. To let `attested` confirm again, set
  `connectors: { linkSetVault: false }`: each account then keys its own token, and one consent no
  longer covers the person's other accounts.

Okta's own adapter emits `attested` **and** `asserted` mappings, and which one you get is decided
by the field you configured for that app in the setting `directory.oktaApps`: the default
`externalId` grades `attested`, while an app opted into `field: "userName"` grades `asserted` — so such an app never
auto-confirms, whatever the policy. It never emits `email-match`: per-platform *enrichers* that
would produce those joins (Slack `users.lookupByEmail`, GitHub SAML/EMU `externalIdentities`,
Linear SCIM) are follow-up work, because only the platform can attest its own side of such a join.

An app-map entry can name **which workspace** an app's ids belong to —
`oktaApps: [{ platform: "slack", tenant: "T0AB1CD2E", appId: "0oa1" }, { platform: "slack", tenant: "T9ZYX8W7V", appId: "0oa2" }]`
under `directory` in `agent/settings/settings.ts` — so a deployment serving two
Slack workspaces can map both, and a suggestion for the second one is expressible at all. The
workspace is still **your** config's answer, never the IdP's: Okta knows which *app* somebody is
assigned to, not which of your admitted workspaces that app serves, so the rung is written by you in
your own settings file next to the app id, and the sync **refuses a workspace no domain's `reach` list
declares** (`agent/memory/config/domains/<name>.ts`) — such an account is skipped with a warning
rather than placed in a guessed one. Omit the rung and nothing changes: the accounts land in the
deployment's single workspace, as before.

Each account needs **its own** confirmation until one is confirmed. A caller who is only
`suggested` sees their own account and nothing else, so the first workspace confirms from its own
DM. After that, the grade decides: an `attested` suggestion may be ratified by a confirmed member
of the set, and every weaker grade stays own-DM only. The default Okta field `externalId` grades
`attested`, so a person with a Slack account in two workspaces usually confirms once and ratifies
the second. The "no blanket yes" rule holds throughout: with more than one account waiting, a bare
`confirm` is refused and the accounts are named, same-platform ones included.

**The person's own Okta account (OPE-2453).** When a connection declares a Cross App Access
sign-in (`mode: "xaa"`) whose `idpIssuer` is this Okta org, the arm also proposes each person's own
Okta account: platform `okta`, with the Okta user id as the native id, graded `attested` because
Okta is the authority for its own ids. The `xaa` sign-in admits a person only when the Okta account
that signed in is a **confirmed** `okta` account on their link-set, so this proposal is what makes
the sign-in usable. With no `xaa` declaration the arm proposes nothing new. See
[Cross App Access](../capabilities/connectors-and-providers.md#cross-app-access-xaa-a-personal-connection-with-no-per-app-consent).

`OE_DIRECTORY_OKTA_ORG_URL` must be **`https://`**. Every Okta request carries the API token in an
`authorization` header, so a plaintext org URL is refused at boot rather than leaking an admin
credential on every sync.

The sync runs **daily on a schedule** and on demand through the control plane
(`directory_sync_now`, with `directory_sync_status` for the last result, and
`directory_sync_preview` to see a plan without applying it). It is idempotent — a
second pass over an unchanged directory does nothing — and safe to run concurrently with itself.
The directory also reports each person's **IdP group names**, which feed person-groups below.
Configuration is in the
[configuration reference](../deploy/configuration-reference.md#identity-directory-sync-pre-populating-links-from-an-idp).

#### Observe first — arm the adapter and apply nothing (OPE-2644)

Arming the adapter with the shipped `directory.mode: "sync"` applies the plan at the first nightly
run (03:00 UTC). That run writes suggestions and **suspends** the directory-built link-set of every
person the directory reports as deprovisioned. To see what the adapter finds before anything
applies, arm it in **observe mode**. Deploy the mode first, then set `OE_DIRECTORY_PROVIDER`. The
variable is env and the mode is a setting, so the order is yours to keep: armed before the mode
deploys, the adapter runs in `sync` mode.

```ts
// agent/settings/settings.ts
export default defineSettings({
  directory: {
    mode: "observe",
    oktaApps: [{ platform: "slack", appId: "0oa1" }, { platform: "github", appId: "0oa2" }],
    groupAllowlist: ["Engineering", "Payments"], // optional: limits the group-member reads
  },
});
```

In observe mode, nothing writes identity state:

| Path | In observe mode |
|---|---|
| The nightly schedule | Makes **no** directory call. It writes one heartbeat row (`outcome: "no-op: observe mode"`), the same kind of row an unarmed deployment writes, so `deploy:census` still sees the cron alive. The row holds the provider id and the mode, and nothing the directory said. |
| `directory_sync_now` | Refused, before the directory is read. |
| `directory_groups_plan` with `deliver: true` | Refused, before the directory is read. No branch, commit or PR. |
| `directory_groups_plan` without `deliver` | Unchanged: it returns the overlay and opens nothing. It appends its own provenance audit row, as in sync mode. |
| `directory_sync_preview` | Reads the directory and the link store, and writes nothing, in **either** mode. |

No link is written, no link-set is suspended, no PR opens, and no person gets a message. The
writer itself (`syncDirectoryOrg`) refuses in observe mode, so a fork's own trigger cannot apply
the plan either. `packages/core/scripts/directory-preview-test.ts` digests every table in the store
before and after the preview and each refused writer, and fails if any row changes. For the nightly
entry point it allows exactly one new heartbeat row and no change to any other table. For the
plan-only `directory_groups_plan` it allows exactly its one provenance audit row.

**Read the report.** Call `directory_sync_preview` with `{ "org": "default" }` through the
deployed instance's [control plane](../security/control-plane.md). The adapter is registered at the
deployment's boot, so call the deployed control plane. The local `npm run control` entry does not
register the directory adapter, and there the verb answers `provider: null`. The answer has a
`report` field: the whole result as lines to read top to bottom. The same facts are in the JSON
fields beside it:

- **People:** how many the directory lists, how many are active or deprovisioned, and how many map
  at least one account.
- **Accounts per platform and workspace**, and for each configured app (`directory.oktaApps`
  entry): the field read, the grade it gives, how many assignments it returned, how many mapped,
  and each dropped assignment by reason. The reasons include no `externalId` written back, a
  DEPROVISIONED assignment, a blank `userName`, and a user that is not in the user list.
- **Unmatched and malformed mappings**, each with its reason. An account the planner places
  nowhere (a workspace no domain admits, an account two directory records claim) is listed. So is
  an id whose shape cannot match how this deployment keys that platform: a GitHub id that is
  numeric or not a login, a Slack id that is not a `U…`/`W…` member id, a Notion id that is not a
  UUID, or any email. The shape check is a heuristic. It catches the common case where a SCIM
  `externalId` is the vendor's internal id and the channel keys people by something else.
- **Groups:** how many the directory lists, which it read, how many `directory.groupAllowlist`
  left out, and each allowlisted name the directory does not have. The match is verbatim, so that
  last line usually means a typo. Then the counts of the person-group overlay that
  `directory_groups_plan` would propose.
- **What a real sync would do:** the planned suggestions (and how many land in new link-sets),
  confirmations, no-ops and **suspensions**. Each suspension names the link-set and the person.
- **Warnings** from the planner, and **per-person rows**: suspensions first, then people with a
  problem, then the rest. `limit` caps the rows (default 50, maximum 500). The counts always cover
  everyone.
- **Cost:** the number of HTTP requests the read made. A real sync makes the same reads each night.

The report is read through the control plane, so it leaves the deployment. It carries no token
and no group member list (the overlay section is counts only). Every email address in it is masked
to its domain (`…@acme.example`). That covers more than the directory's email field: an app mapped
with `field: "userName"` usually carries an email as its account id, and a display name falls back
to the login. Display names and Okta user ids stay readable, because the operator needs them to
find a person. A dropped-assignment example is an Okta user id, at most five per reason, and each
list holds at most 100 entries with its full count beside it.

**The allowlist limits the reads.** With `directory.groupAllowlist` set, the Okta adapter reads the
members of the listed groups only: one paginated `/groups` read, then one member read per listed
group. Without it, the adapter reads every group's members, which on an org with hundreds of
groups is hundreds of requests each night against Okta's org-wide rate limit.

**One gap the report shows and does not fix.** Okta's default `GET /api/v1/users` leaves out
DEPROVISIONED users. So a DEPROVISIONED person is not in the list the sync reads, and a sync
suspends only people Okta reports as SUSPENDED. Their app assignments that Okta still lists show
in the report as "not in the user list". Whether the sync should also read DEPROVISIONED users is
an open decision; until it lands, offboard a DEPROVISIONED person with `suspend_link_set` or
`revoke_link_set`.

To go live, set `directory.mode: "sync"` (or delete the key) and deploy. The next nightly run
applies the plan the preview showed, against the directory as it is then.

**Scope, stated plainly:** link-sets feed **attribution**, and — through a person-group's
`{ linkSet }` member *or* a `principal` binding addressed as `linkSet:<id>` — the DM access
universe. Both are live: a credential binding can be addressed to a human rather than to one of
their accounts. They are still **not** read by the admin rosters (`Domain.admins`), which take an
exact principal key only — `platform/<id>`, or `platform/<workspace>/<id>` on Slack — so no
link-set membership can ever confer admin standing.

### What identity linking writes to the audit log

Every mutation on this plane leaves a row. `link-store.ts` is the one writer over the link tables,
so it writes every row below except `identity.link.consent_click`, which the consent handler writes
from the click itself.
The rows below all carry the link-set or the challenge they are about, never an account's
credentials. Read them with the [audit trail](../security/audit-and-provenance.md#reading-it).

| Action | When the code writes it | What the row carries |
| --- | --- | --- |
| `identity.link.challenge_issued` | The initiating account asks to link a second account. | The challenge id, the transport, the expiry, and the target account label when the ask names one. The row lands on the initiating account. |
| `identity.link.challenge_claimed` | A second account claims that challenge. | The challenge id and the initiator's account label. The row lands on the claimant's own platform and surface. |
| `identity.link.denied` | A claimed challenge is denied. | The challenge id, and the claimed account label when the challenge reached that state. The row lands in the initiator's partition. |
| `identity.link.consent_click` | A person taps the link-consent control. | The click's own outcome. The action name is exported as one constant, so the code and its test share one spelling. |
| `identity.link.set_created` | A link set is created. | The set id and its handle. The row is stamped `directory`, because a set is created for a person rather than on a surface. |
| `identity.link.suggested` | A directory sync proposes an account for a set. | The set id and the evidence label. A suggestion is **not** a link: a `suggested` row stays invisible to link resolution until a person confirms it. |
| `identity.link.suspended` | An operator puts a set on hold. | The set id. The row names the operator as the principal. |
| `identity.link.reactivated` | An operator lifts that hold. | The set id, from the same writer and the same call. |
| `identity.link.revoked` | A set is revoked — the terminal offboarding lever. | The set id, how many account ids were tombstoned, how many credentials the purge destroyed, and a `purgeFailed` flag when the purge did not complete. `unrevoked` names each connection whose revocation call at the provider failed twice. Also how many lent credential grants were revoked (`grantsRevoked`), how many personal browsers were forgotten (`browsersForgotten`), and `holdingFailures` when one of those did not complete. |
| `identity.link.credentials_purged` | A set's credentials are purged without revoking the set. | The set id, the set's status at the time, the purged count, and the same `purgeFailed` flag and `unrevoked` list. |
| `identity.offboard.applied` | A surface's deactivation report passed every gate and the lever ran (OPE-2423). | The account, the source (`slack:user_change`), and the outcome: `revoked` with the set id, or `purged-unlinked` with the purge count. Both carry `grantsRevoked`, `browsersForgotten` and, on a failure, `holdingFailures`. A `purged-unlinked` row also carries `unrevoked` when a revocation call at the provider failed twice. A `revoked` outcome also writes `identity.link.revoked`. |
| `identity.offboard.refused` | A deactivation report was not acted on. | The account, the source, the reason (`external-workspace`, `unadmitted-tenant`, `unconfirmed`, `cross-workspace-set`, `revoke-failed`, `error`), and a sentence that ends by naming the manual lever. A `cross-workspace-set` row also carries the set id, the accounts that blocked the revoke (`blockedBy`), the account's own purge count, and `purgeFailed` when that purge did not complete, plus `grantsRevoked`, `browsersForgotten` and, on a failure, `holdingFailures` for the deactivated account's own holdings. It carries `unrevoked` when a revocation call at the provider failed twice. |

🔴 **A control-plane mutation writes two rows, not one.** The store writes the `identity.link.*` row
above because it is the writer that changed the table. The control plane then writes its own
`admin.identity.*` provenance row, which says **which front door** the mutation came through. Count
the mutations on the store's row and the doors on the control plane's row. Counting both together
doubles every control-plane change.

## Person-groups — grouping humans

Memory domains group *surfaces*. A **person-group** groups *humans*: "this set of people gets
these skills, MCPs and connections in their DMs", declared once instead of one binding per
person per platform. The model, the scope level and the specificity rules live in
[Access & scoping](./access-and-scoping.md#person-groups-grouping-people-not-rooms); what
belongs on this page is how groups relate to identity:

- **A member can be an account or a human.** `"slack/T0AB1CD2E/U0123ABC"` names one account —
  workspace and all, since a Slack member id is issued per workspace — and needs no
  database at all — that is the floor a five-person team uses. `{ linkSet: "…" }` names one
  *human* and expands, at resolve time, to every account they have **confirmed** through the
  challenge flow above. One entry then covers their Slack DM, their Discord DM and their Teams DM.
- **Only confirmed links count.** A `suggested` row — everything a directory sync proposes — is
  invisible to the expansion, so an IdP proposal can never widen access. Suspending or revoking a
  link-set removes the person's group access immediately, which is what makes the eager deprovision
  narrowing above a real access lever and not just an attribution one.
- **Groups themselves are config, not database state.** A link established by a proof-of-control
  challenge is a runtime fact with stronger evidence than a reviewed diff, which is why links live
  in the store. A group *membership* widens capability, so it goes the other way: it lives in a
  reviewed git diff. IdP group memberships are therefore synced as a **proposal** — the
  `directory_groups_plan` control verb returns the next overlay file for a human to commit, or (with
  `deliver: true`) opens a **bot-PR** whose merge is the approval, the same delivery the grants
  overlay uses. Either way nothing applies until a human commits/merges; there is deliberately no
  auto-apply-to-a-running-instance mode.

## Mode — channel, DM, group DM

`mode` comes from the surface:

- **`channel`** — a shared, persistent room. Service identity, the channel's bundle, durable
  team memory.
- **`dm`** — a 1:1 conversation. The caller's own universe; a per-user, isolated memory
  store that's always writable.
- **`mpim`** — a group DM. Treated as **execution-only**: the agent does tasks, but nothing
  is learned or persisted — an ad-hoc grouping with a stronger "this isn't recorded"
  expectation and no clean owner for shared credentials.

## Visibility and trust — two separate dimensions, only one gates memory

`visibility` and `trust` are both computed per surface, both **fail closed**, and are
genuinely independent — but only one of them decides what reaches shared memory:

- **`trust`** (`internal` / `external`) — is this surface *inside* the org boundary, or does
  it reach outside it (an externally-shared / Slack Connect / guest-bearing channel, or an
  unverified surface on a platform with no membership check yet)? **This is the memory gate**
  ([the resolver](../capabilities/memory.md#the-trust-gate-the-security-keystone) reads only
  this): an `external` surface routes to the read-only `public`
  [pseudo-domain](./access-and-scoping.md), never to an explicit domain's or the org's memory.
- **`visibility`** (`public` / `private`) — is this surface a confirmed world/team-visible
  channel? Anything not positively confirmed is `private`. It's tracked per surface (and
  shown alongside `trust` in each [surface guide](../deploy/surfaces/support-matrix.md)) but
  the memory resolver never reads it — a **private**, internally-trusted channel shares its
  domain's memory exactly like a public one does.

A private channel is still internal; an externally-shared channel is external even if it's
"public" within the workspace — don't infer one from the other. Whenever trust can't be
positively determined on a real platform, the binding fails closed to `external`.

## The trust registry — declaring what a room's audience is

`trust` is resolved from three sources, and the operator owns one of them: the **trust registry** in
`agent/identity/surfaces.ts`. Each line declares one thing about one set of rooms.

```ts
export const surfaces = [
  // Every channel in this Slack workspace is members-only…
  defineSurface({ key: "slack/T0ACME",            trust: "internal" }),
  // …except the customer lounge, which anyone can join.
  defineSurface({ key: "slack/T0ACME/C0LOUNGE",   trust: "public"   }),

  // Every repo under this owner is org property…
  defineSurface({ key: "github/acme",             trust: "internal" }),
  // …except the open-source ones, where anyone with a fork can comment.
  defineSurface({ key: "github/acme/oss-*",       trust: "public"   }),

  // A whole Microsoft Teams TEAM, which the surface key alone cannot name.
  defineSurface({ key: "teams/<tenantId>/team:<teamId>", trust: "internal" }),
];
```

**Two values, and `external` is not one of them.** `internal` says only organisation members can
type here. `public` says anyone can — the world, a community, a customer. `external` is the
fail-closed default of an *unlisted* surface, so writing it would confuse "the operator declared this
open" with "the operator said nothing", and those must stay apart in the audit trail.

**Four key shapes**, the same grammar a memory domain's `reach` entries use:

| Shape | Example | Denotes |
|---|---|---|
| tenant | `slack/T0ACME` | every surface under that workspace, at any depth |
| exact surface | `slack/T0ACME/C0LOUNGE` | that one room |
| same-level glob | `github/acme/payments-*` | every repo under `acme` whose name starts `payments-` |
| group rung | `teams/<tenant>/team:<teamId>` | every channel in that Teams team |

**Most specific wins**: an exact key beats a glob, a glob beats the group rung, the group rung beats
the tenant. So an explicitly-listed room can never be annexed by a broader pattern. Two equally
specific patterns that could match one room with *different* values are a **boot error**, not a
declaration-order coin flip.

**There is no exclude list, deliberately.** Trust has an opposite value, so a carve-out is written by
declaring the opposite — and every carve-out then lands in a *declared* state instead of the
undeclared hole an exclusion would leave behind.

### Notion trust roots — declaring a subtree

A Notion surface key names one page and carries no hierarchy, so `defineSurface({ key:
"notion/<ws>/<pageId>", trust: "internal" })` vouches **that one page** and nothing under it. To
declare a whole subtree, add `subtree: true` to that same line:

```ts
// this page, and every page under it
defineSurface({ key: "notion/<workspaceId>/<pageId>", trust: "internal", subtree: true }),
```

The widening is **opt-in on the line**, so no entry you already wrote changed meaning when the walk
shipped. At ingestion the Notion webhook walks the commented page's parent chain under the delivery's
own verified credential and asks whether any level is a declared root. A match binds `internal`; no
match changes nothing. Empty by default, so a deployment that declares no root spends no API call
on this.

The walk runs **once per delivery**, and both planes that ask "is this page internal?" read that one
verdict. It binds the page's memory, and it also admits the page to the **cross-surface window**
(the single-window privacy floor) — so a trust-root page joins the same shared window an explicitly
vouched page joins. The floor never re-walks anything: it reads the verdict the delivery carries, so
no network call enters that gate. A `public` declaration on the page still refuses it, on both planes
— see **Demote above the vendor, promote below it** below. One exception: under the
`identity.blanketTrust: "internal"` blanket the window floor admits every page **first**, above the `public`
demotion — as every platform's floor does — while the binding plane keeps the demotion above the
blanket. Under the blanket, a `public`-declared page therefore joins the shared window while its
org-memory binding stays external.

**`subtree` is refused wherever it would grant nothing** — the registry never accepts a line it then
ignores. Each of these is a boot error:

| Line | Why it is refused |
|---|---|
| `subtree` on a Slack / GitHub / Teams / Discord / Linear key | those keys already name a whole room, so there is nothing to walk. The Notion bundle declares that Notion honours the word; no other bundle does |
| `subtree` on a tenant key or a glob | a tenant already covers every surface under it, and a glob names a set nobody enumerated. A subtree hangs from **one exact surface key** |
| `subtree` with `trust: "public"` | only the promotion has a resolver — the walk answers "is this under a declared root?". A public subtree would be a demotion nothing reads |
| a last segment that is not a Notion page id | the Notion bundle validates its own keys at boot |

**A trust root does not satisfy a CONFIG-LOAD gate.** A multi-channel `mode: "unified"` domain checks
at boot that every source it lists is vouched, and it throws by name when one is not. Config load has
no delivery and no credential, so it cannot walk a page's ancestry — the register is the only trust it
can read there. List such a page in `agent/identity/surfaces.ts` as well as under its trust root. The
boot error says this.

What a root reaches, and what it does not:

- **every page under it, up to eight parent hops**, including pages nested inside a column or a
  toggle. A deeper chain exhausts the hop limit and stays untrusted;
- **not a database row.** The walk stops at a database, because a row is a separate page that
  commonly holds customer-submitted content. List a row you genuinely trust as its own entry;
- **not a page this integration cannot read.** The walk climbs by asking Notion for each level's
  parent, so an unreadable level ends the walk untrusted;
- **not for ever.** One resolved parent edge is cached for 60 seconds, so a page moved between trees
  keeps its old answer for at most that long — in both directions.

**A teamspace id will not work, and nothing can refuse it at config time.** A Notion teamspace id is
a 32-hex uuid, exactly like a page id, and a teamspace never appears as a parent on any Notion
object — so a teamspace root parses, registers, and then matches nothing. The first walk that fails
to match asks Notion what each root is; a root Notion serves as neither a page nor a block is logged
and audited by name (`unreachableRoots` on the `notion.dispatched` row). Declare the top **page** of
the teamspace instead.

Every verdict that RAN is audited with its reason — `self`, `ancestor`, `workspace-root`,
`database-boundary`, `hop-limit`, `cycle`, `unresolvable` — so a page that did not inherit trust says
which refusal decided it. The one exception is `no-roots`: a workspace with no declared root resolves
early, and the `notion.dispatched` row carries NO `trust` field at all (and the unreachable-root probe
never runs). An absent field, not a named verdict, is what "this workspace declares nothing" looks
like in the audit.

### 🔴 Demote above the vendor, promote below it

```
trust = (declared "public" ⇒ external)     ← the operator's DEMOTION, above everything
     ?? the platform mapper's own verdict  ← a real membership check, or a positively-shared room
     ?? the triggered fire's creator recheck
     ?? (declared "internal" ⇒ internal)   ← the operator's PROMOTION, below the vendor
     ?? identity.blanketTrust
     ?? external                           ← fail closed on every real platform
```

One blanket outranks this chain at the ADMISSION gates: on a deployment that sets
`identity.blanketTrust: "internal"`, the window and governance admission checks are satisfied by the blanket
itself, so a `public` declaration does not fence a room out of a private cross-surface window
there. Declare rooms `public` on deployments that vouch per surface, not through the blanket.

On Notion the "platform mapper's own verdict" line is the **trust-root walk** above — Notion refutes
no author and reports no room-grain external signal, so its mapper carries an operator declaration
rather than a vendor answer. It is positive-only: no root, no verdict, and the chain falls through to
the per-surface `internal` declaration below it. A `public` declaration on the page still wins, because
it sits above.

A `public` declaration maps to `external`, which is the floor, so putting it on top can never *raise*
anything — it is safe by construction. An `internal` declaration is a promotion, so it stays below
the vendor verdict: **there is no way to talk a Slack Connect channel, or a public GitHub repo, back
up into `internal`**, whatever the config claims.

**DMs and group DMs are out of scope for `public`.** The demotion applies to a channel only. On a
DM, `trust` does not mean "is this room external" — it
means "is the DM *partner* internal", because it selects the DM's shared read layer. A room
declaration answers a different question there, so the demotion does not apply.

### What a declaration is worth, per surface

A declaration is worth most where the platform can tell you least:

| Surface | Vendor's own room verdict | Can it refute an author? |
|---|---|---|
| Slack | strong (`is_ext_shared` and its siblings) | strongest of the six |
| GitHub | exact (`repository.private`) | on a private repo |
| Linear | none | for guest seats |
| Teams | present but often absent from an activity | yes, via a cached Bot Connector roster lookup |
| Discord | none | **no** — Discord has no organisation concept |
| Notion | none | **no** — the API exposes no member/guest field |

🔴 On Discord and Notion the room declaration is the **entire** room-grain trust statement. On Slack
and GitHub it is one of three signals. For the author grain on those two surfaces, see the
author-trust register below.

### Preflight tells you what you have not declared

`preflight` (the ops MCP) reports three things about the registry:

- an **undeclared surface with traffic** — red, naming the surface and the `defineSurface` line to
  add. A room covered ONLY by a container line lands here too — see the note below;
- a **dead declaration** — amber; it has matched no traffic, which is what a transferred repo, an
  archived channel or a deleted Linear team looks like;
- a **pattern's new matches** — amber; surfaces that have only just started matching a tenant, **group
  rung** or glob declaration. 🔴 This is a **detector, not a fence**: a repo renamed *into* a glob's
  prefix inherits that glob's trust, and a channel added to a declared Teams team inherits that team's
  trust. Nothing structural can prevent either — the whole point of a pattern is that it admits
  surfaces nobody enumerated. To pin one surface, give it an exact entry.

🔴 **A working declaration written at a CONTAINER reports as dead.** A traffic row names one workspace
and one room, and no rung above them. The check therefore matches neither the container line nor the
rooms under it. A Slack Grid line, a Teams group rung, and a Teams channel line whose traffic is all
reply chains each report as a dead declaration while they work. Where such a line is the only cover
for those rooms, the same rooms also report as undeclared traffic. Read the dead-declaration check's
own fix text before you delete a line: deleting one returns every workspace, channel or reply chain
under it to `external`. **OPE-1560** carries the audit-row half that closes this.

## The author-trust register — declaring whose requests are trusted

The trust registry above declares a **room**. The author-trust register in
`agent/identity/authors.ts` declares an **author**. They answer different questions and you may need
both:

| Registry | File | Question | Gates |
|---|---|---|---|
| Trust registry | `agent/identity/surfaces.ts` | Who can **see** what the agent prints here? | audience |
| Author-trust register | `agent/identity/authors.ts` | Whose bytes may the agent treat as a **member's**? | authority |

🔴 **They are additive.** A declared author does not make a public room safe to print into, and an
`internal` room does not vouch for everyone who types in it. A public community guild with three
trusted staff is exactly the case that needs both files.

Both registries **classify**. What the agent then *does* about an external author or an external room
is the separate `externalPolicy` block — see
[The external-participant policy](#the-external-participant-policy--what-follows-from-the-classification).

**Why it exists.** The per-wake author leg reads a *positive refutation* from the platform — Slack's
`is_restricted`, Teams' Bot Connector roster `userRole`. Discord and Notion produce none, ever: Discord has no
organisation concept (guild membership *is* the boundary, and community guilds admit the world), and
Notion exposes no membership fact on a comment author. On those platforms this register is the only
author-grain evidence there is.

```ts
// agent/identity/authors.ts
export const authors = [
  defineAuthorTrust({
    tenant: "discord/1300000000000000100",              // the guild this ARMS
    internal: [
      "discord/000000000000000000",                    // one account
      { group: "payments-team" },                       // a person-group from ./groups.ts
      { group: "directory:Engineering" },               // an IdP-synced group (merged overlay)
      { membership: "discord/1300000000000000100/role:111111111111111111" },  // one role
    ],
  }),
];
```

**Three ways to name a member.** A **qualified principal key** is one account — the floor, needing no
database and no IdP. A **`{ group }` reference** names a person-group from `agent/identity/groups.ts`,
expanded at boot to its principal keys on that platform. A **`{ membership }` pattern** is the
wildcard shape: every author holding that Discord role. A single trailing `*` is allowed, so
`role:*` admits every author holding *any* role — the usual "has been let in properly" test on a
community guild. Discord roles ride on the gateway message itself, so a membership pattern costs no
extra API call. Notion has no group concept, so a Notion entry uses principal keys only.

🔴 **Arming is per tenant and explicit.** A tenant with no entry is **undeclared**, and the leg does
nothing there — behaviour is identical to not having the file. Adding an entry **arms** that tenant:
from then on an author it does not name grades `external`, and their messages mark the turn as
carrying non-member content. An author with no readable id grades `external` too. So an entry is a
real commitment, not a hint — list everyone who belongs, or leave the tenant out.

**Fail-loud at boot.** A malformed tenant key, a member on another platform, a membership naming
another tenant, a reference to a group that does not exist, or a group with no principal key on that
platform are all boot errors. Each of those is *dead config* — it looks fine and can never match — so
it is refused rather than accepted and silently inert.

**Link-set members of a referenced group do not count here.** Expanding a link-set is an asynchronous
database read, and this resolver runs on the synchronous wake path — the same constraint that keeps
link-sets off the admin roster. A group whose members on that platform are all link-sets is refused
loudly.

🔴 **The register is operator config, not runtime-mutable.** No tool, control verb or model-reachable
path adds a member. It is populated once, at boot, from a reviewed diff.

### The IdP is a future source, and it plugs in through `{ group }`

The Okta directory sync already emits `directory:<idp-group>` groups into the machine-owned overlay
`agent/identity/groups.generated.ts`, on a bot PR that **a human merges**. Reference one of those
groups from the register and Okta becomes the member source with no new plumbing:

```
Okta → snapshot → groups codemod → bot PR → a human merges it → the group exists → the register names it
```

That is the suggestion-only doctrine with nothing extra to enforce it: the IdP *proposes*, a reviewer
*disposes*, and a directory that starts lying cannot widen author trust without a merged diff. There
is deliberately **no live directory lookup** in the register.

## The external-participant policy — what follows from the classification

The two registries above and the platform's own probe **classify**. They answer *who is external*.
They do not say what the agent should then do about it, and those are separate decisions on purpose:
change one and the other must not move with it.

The consequence lives in one typed block, `externalPolicy`, with two independent knobs. The **org
default** is the shipped block in `packages/core/agent/settings/settings.ts`, and a deployment may
override it in its own `agent/settings/settings.ts`; a **domain override** is
`externalPolicy` on a domain in its own `agent/memory/config/domains/<name>.ts` file. The override resolves **field by field**, so a
domain that states one grain keeps the org default for the other. The domain hop is **single**, the
same rule `nameDropWake` uses: a channel in an explicit domain reads *that*
domain's declaration and does not fall through to `org` (`ambientSupervisor` differs: it inherits
explicit → `org` → on); an unassigned channel reads the `org`
pseudo-domain's.

| Knob | Values | Shipped | Grain |
|---|---|---|---|
| `externalPolicy.authorGrain` | `withhold` · `taint` | `withhold` | one excluded **author's** message |
| `externalPolicy.roomGrain` | `silent` · `engage` | `silent` | a whole **room** the classification calls external |

**Both grains ship strict**: the shipped defaults are maximally locked
down for guests and external rooms. `taint` and `engage` are the deliberate opt-outs. Each strict
value acts only where a leg refutes an author or classifies a room external. A member's own new
messages are not withheld, and a room that no leg classifies external is never silenced. Two
changes still reach members: a guest's text in an internal room reaches the model as the
arrived-marker (in a wake and in `read_channel` / `read_thread`), and a session-tail row recorded
before OPE-1747 carries no author grade, so it shows as the arrived-marker too, a member's row
included. An existing deployment that wants the old behaviour sets the opt-out
values in its own `agent/settings/settings.ts` (see `packages/core/UPGRADING.md`).

### The author grain — `withhold` (shipped) or `taint`

Who counts as **excluded** is exactly the existing evidence, and nothing new: the platform's own
positive refutation (Slack's `is_restricted` / `is_ultra_restricted` / `is_stranger`, Teams' Bot
Connector roster `userRole: "guest"`, GitHub's `author_association`, Linear's `User.guest`), or the author-trust
register above on a tenant the operator has **armed**. Where the register is the only evidence — Discord
and Notion — an unarmed tenant excludes nobody, so turning `withhold` on there without arming a register
changes nothing at all. A machine (`relay`) author is never excluded.

**`taint`** is the opt-out: the text enters the context inside the untrusted-content envelope, the
ingestion marks the turn, and the approval plane carries the consequence. Choose it only where an
excluded author's text must reach the model.

**`withhold`** (shipped) stops the text *entering*. Four behaviours:

1. **An @mention or a DM from an excluded sender gets a private notice and no action.** No turn, no
   tool call, no affordance. On Discord the notice is a DM to the sender; if that DM cannot be opened
   the agent says **nothing** rather than replying in the channel, because an in-channel reply would
   announce to the whole room that this person is classified as an outsider.
2. **Ambient engagement never triggers on their messages.** Nothing is owed, so nothing is said.
3. **Inside a thread a permitted member started, their replies reach the agent as a marker that says
   a message arrived — no body, no pre-edit text.** Who and when survive, so the thread does not read
   as if it had holes.
4. **A chat READ returns the same marker in place of their text.** `read_channel` and `read_thread`
   grade the page's authors and replace an excluded author's message text with the arrived-marker.
   The author, the timestamp and the message count all survive, so the page still reads as a
   conversation. Without this the grain would suppress a body on the wake and hand the same body
   back the moment the agent read the channel.

🔴 **A withheld body never keys taint.** The chat-taint bit means *a non-member's bytes entered the
context*. Under `withhold` they did not, so the join is never told they did. This holds on the read
path as well: a read whose only refuted author was withheld leaves the turn clean, because nothing of
that author reached the model. The bit keeps discriminating instead of marking every withheld wake.

🔴 **Withhold does not replace the untrusted-content envelope, and the two are not the same
mechanism.** The envelope is **provenance**-based — "a trusted person asked me about this text, so
treat it as data". `withhold` is **identity**-based — "this sender may not task the agent". A
deployment on `withhold` still wraps everything it wrapped before; building `withhold` *instead* of
the envelope would leave a member unable to quote an outsider at the agent.

**Where it is wired.**

- **Notion**'s doc supervisor applies all three behaviours, with one honest exception: Notion has no
  private channel back to a commenter, so behaviour 1 there is a silent drop rather than a notice
  posted into a shared doc.
- **Discord**'s gateway applies behaviours 1 and 2 at the wake gate, above the engagement read, the
  spend gate and every affordance. The notice is a DM to the sender. ⚠️ Its **hydrated context lines
  are not filtered**: the gate reads the TRIGGER author only, so an excluded author quoted in a
  name-drop's backscroll still reaches the model when the person who name-dropped is permitted.
  Slack's name-drop route filters that slot; Discord's does not, because it has no per-author answer
  short of the operator's register.
- **Slack** applies behaviours 1 and 2 on all five wake paths — the engaged thread, the name-drop,
  the supervisor, the DM seat, and the native `app_mention` forward — and behaviour 3 over both the
  supervisor route's first-wake backscroll and the name-drop's hydrated context lines. Those two
  slots now meet on ONE wake: a name-drop wakes the room's standing seat, so the supervisor route
  renders the hydration the name-drop judge fetched, and it runs the per-author withhold over the
  whole wake — the envelope backscroll and the hydrated lines together. An unseated deployment keeps
  the native per-thread name-drop wake, which withholds the same slot on its own. The
  notice is a DM to the sender, opened on demand; a message that *arrived* in a DM is answered in
  that DM.

  Three details are worth stating, because each one is a consequence of how Slack works rather than
  a design choice:

  - On the **DM path** the gate sits above the seat resolve, so a suppressed DM mints no seat and
    consumes no tail. A **group DM (`mpim`)** has no partner to probe, so the gate grades its
    TRIGGER author with the same `users.info` probe a channel uses (OPE-1486), and a refuted author's
    group-DM message is suppressed like a 1:1's. The DM rule still turns the room leg off for the
    whole DM family, so `silent` never applies to a group DM.
  - On the **channel routes** the gate sits where the `users.info` refutation first exists, which is
    below the spend read: a suppressed message costs one budget read and never a model turn.
  - On the **native `app_mention` forward** — the path an @mention takes in an ordinary
    non-single-window channel, where eve's own `slackChannel` owns the turn — the gate sits above the
    forward, because there is no seam inside eve the policy could reach. That leg resolves no author
    facts of its own, so it checks first whether the policy can suppress anything at all and skips
    the probe entirely on the `taint` / `engage` opt-out pair. On the shipped grains it runs the
    probe. The native door eve hands the turn to (`channels/slack.ts`) runs the same probe again,
    TTL-cached, on every grain, and stamps a refuted author `oe_chat_nonmember` (OPE-2572). So on the
    opt-out pair a guest's @mention still reaches the turn with the non-member stamp, as on every
    other Slack road.
- **Teams** applies behaviours 1 and 2 in the front route, above both the DM divert and the
  single-window plan. Because a suppressed activity is never forwarded, the policy covers the native
  path as well as the window. Behaviour 1 posts into a **personal chat** only: Teams cannot open a
  1:1 with someone the bot has never met, and a notice posted into a team channel would announce that
  person's classification to the room, so a channel @mention is a silent drop. The author evidence is
  the Bot Connector **roster probe** plus the operator's author-trust register. The gate runs before
  the webhook ack, so it buys the roster answer **only when a grain could act on it** — on the
  `taint` / `engage` opt-out pair it skips the probe entirely, exactly as Slack's native `app_mention`
  forward does. On the shipped grains it buys the answer. The two dispatch paths (the shared window and the DM divert) run after the ack, so they always
  resolve it.
- **The chat READ verbs** apply behaviour 4 on every wired surface at once. `read_channel` and
  `read_thread` share one grade-and-project body, and the per-author evidence comes from the same
  join the turn mark uses — Slack's `users.info`, plus the operator's register on Slack, Teams and
  Discord. EVERY chat reader routes through that one body — the delegated worker's
  `read_work_channel` / `read_work_thread` (OPE-938) included — so the author-taint mark and the read
  half of `withhold` are declared once and no reader can declare them differently. Since OPE-1145 no
  PER-SURFACE chat reader stands beside them.
- **GitHub** (OPE-533) reads the comment's own `author_association`, which rides free on every
  `issue_comment` webhook. `OWNER`, `MEMBER` and `COLLABORATOR` each hold a deliberate access grant
  and are **internal**; every other value — `CONTRIBUTOR`, `FIRST_TIME_CONTRIBUTOR`, `FIRST_TIMER`,
  `NONE`, `MANNEQUIN` — is **excluded**. A past merged PR is not an access grant, and a `MANNEQUIN` is
  an import placeholder with no live person behind it. The check sits at the top of both wake legs —
  the native @mention and the ambient supervisor — above the ambient gate, the classifier and the
  spend gate. It needs no new call and no new installation permission: the org-membership probe
  (`orgs/{org}/members/{user}`) would need the "Members" permission, which every installed org would
  have to re-approve.
- **Linear** (OPE-533) reads the `User.guest` probe that OPE-60's window-admission floor already
  runs. A **workspace guest** is excluded; a full member is internal. The comment leg gets the flag
  free from `enrichComment`; the native agent-session leg resolves it with one cached
  `user(id) { guest }` query. **The author grain needs no room key** (OPE-541): the raw
  agent-session payload does not reliably carry `issue.team.id`, so the native leg resolves the team
  from the issue id (see the room grain below). When even that resolution fails, the leg asks the
  author question anyway against the `org` pseudo-domain's declaration, and the suppression row names
  the workspace with no `surface`.
- ⚠️ **Neither GitHub nor Linear posts the private notice of behaviour 1**, and behaviour 3 does not
  arise on either: a wake on both surfaces carries one comment, so there is no sibling body to
  withhold. Neither platform has a private channel back to a commenter, and that notice's own text
  names the organisation, so posting it in a world-readable repo or issue would announce the
  person's classification. An excluded author's AMBIENT comment is therefore a **silent drop** with
  an audit row (`github.external_policy_suppressed` / `linear.external_policy_suppressed`, verdict
  `withheld-author`) and nothing posted.
- **An explicit @mention still gets one fixed line** (OPE-885) — see
  [The mention ack](#the-mention-ack--what-an-explicitly-addressed-suppressed-wake-gets) below.
- ⚠️ **Both surfaces fail OPEN.** An absent or unrecognised `author_association`, and an unresolved
  Linear guest probe, all mean "not refuted". A payload change or an unreachable API must never take
  the agent off the air.


### The room grain — `silent` (shipped) or `engage`

A room is in the **external class** on any of three legs, each of them positive evidence somebody
already produced:

```
external  ⟸  the VENDOR reported the room spans another organisation   (Slack Connect / a Teams shared channel)
          ∨  the ingested set contains a REFUTED author                 (guest-present)
          ∨  the OPERATOR declared the room `public` in the trust registry
```

🔴 **An undeclared room is not external.** There is deliberately no fall-through here, and
`taint.undeclaredSurface` does not reach this classification. Silence from the operator means they
have not declared; reading it as "external" would take the agent off the air across a whole
un-configured deployment.

Under `silent` (shipped) the agent does not engage in such a room, and it says so **exactly twice, ever**: once
when it joins, and once on the first wake it suppresses. There is **no periodic re-announcement** —
that is a ruling, not a default. Each announcement is backed by a permanent claim row
(`notice_claim`), so a re-invite, a redeploy or a cold start cannot make the agent repeat itself. If
the claim cannot be proved unsaid, the agent stays quiet.

**`engage`** is the opt-out: the agent answers in an external room as it does in an internal one.

A **DM is never in the class**: on a DM the trust plane asks about the partner, not about the room.

**Where it is wired.** `silent` suppresses a wake on **Slack**, **Discord**, **Teams**, **GitHub**
and **Linear**. The announcement halves differ, and the reason is the platform rather than the
design:

- **Slack** is the only surface that can post **both halves**, and the two halves do not have the
  same reach:
  - the **suppressed-wake** half fires on every wake path, so an operator's `public` declaration
    silences the room and announces itself whether or not `conversations.info` also reports the
    channel shared;
  - ⚠️ the **join** half fires only inside `routeChannelJoinEvent`'s not-internal branch — the agent
    announces at join only when `conversations.info` already refused the channel. A channel the
    operator declared `public` but which Slack reports **internal** gets no join notice. It is still
    silenced, and it still announces once at the first wake it suppresses.
- **Discord** and **Teams** post the **suppressed-wake half only**. Neither surface delivers a join
  event to the agent — the Discord relay forwards messages, and the Teams front owns message
  activities — so there is no trigger to hang the join notice on. Each room is still announced once,
  at the first wake it suppresses, and never again.
- **GitHub and Linear** (OPE-529, OPE-533) read the **operator-declared** leg — a public repo or a
  public Linear team, declared in `agent/identity/surfaces.ts` — and the **guest-present** leg, which
  the author evidence above arms. Neither reads a vendor-external leg: each platform's own room
  signal (`repository.private`, `team.private`) is already the window-admission floor read elsewhere,
  a different question from "should the agent stay quiet here". **Neither posts an announcement, on
  either half.** GitHub and
  Linear have no private channel back to a commenter (the same reason Notion's behaviour 1 is a
  silent drop), and a public repo's or team's comments are visible to the world, so an in-thread
  "I'm staying quiet" notice would itself be the disclosure the silence is meant to avoid. A
  silenced AMBIENT wake is a SILENT drop: an audit row (`github.external_policy_suppressed` /
  `linear.external_policy_suppressed`) records it, nothing is posted. An explicit @mention in a
  silenced room gets the one fixed line instead — see
  [The mention ack](#the-mention-ack--what-an-explicitly-addressed-suppressed-wake-gets) below.
  ⚠️ **Linear's room key is resolved, not parsed** (OPE-543). The key is
  `linear/<organization_id>/<team_id>`, and the raw agent-session payload does not reliably carry
  `issue.team.id`, so the parse misses on the common live shape. The native leg then resolves the
  team from the reliably-present issue id in ONE `issue(id) { team { id private } }` query, which
  answers the team **and** its privacy together. The query runs at most once per webhook delivery:
  both legs — the native dispatch and the mention divert — read the answer off the same memoised
  routing verdict.
  **What fails closed, and what does not.** No credential, an API or GraphQL error, or an issue
  with no readable team all leave the delivery with no key. Routing and the binding's privacy fail
  closed: the binding treats the team as private. The **room grain** instead stands down rather
  than guess a room — so a `roomGrain: "silent"` declaration is enforced only when the team
  resolves, and a delivery whose resolution fails proceeds. The **author** grain is unaffected
  either way — it reads the person, not the place. The comment leg reads the team authoritatively
  from `enrichComment` and always has its key.
  A resolved team also supplies its real `private` flag: a **public** Linear team now binds
  `visibility: "public"` on the native leg, where the pre-resolution behaviour (the team id never
  parsed) bound effectively every native wake as private.
  The team is also the **memory silo grain**. A delivery whose team resolves binds to the team silo;
  one whose team stays unresolved falls back to the issue. Two issues in the same team therefore
  share a silo once the team resolves.

⚠️ One leg is not carried everywhere. The **vendor-external** leg needs the surface to report it:
Teams reads a shared channel off every activity, and Slack reads `is_ext_shared` off the TTL-cached
`conversations.info` probe the trust gate already ran. Discord has no shared-room concept at all, so
there guild membership *is* the boundary and the operator-declared and guest-present legs carry the
classification alone.

### The mention ack — what an explicitly addressed suppressed wake gets

Both grains suppress the wake **before any model turn runs**. What the room sees depends on one
question, and only one: **did somebody explicitly address the app?**

| The suppressed wake | What is posted |
| --- | --- |
| An **@mention** of the app (or a DM / personal chat / Linear Agent Session) | one fixed host line: **"I can't help with this request here."** |
| …unless the sender already got the **private notice** of behaviour 1 | nothing more — one answer per mention, and the private one says more |
| A **name-drop** | nothing |
| An **ambient** message | nothing |

A member who addresses the app and gets nothing back reads the agent as broken. A name-drop or an
ambient message was never owed an answer, so it stays fully dark.

**The line is fixed host copy, and it is the same string on every surface and for both grains.**
That is the disclosure argument, not a convenience: a silenced room and a withheld author produce
identical bytes, so a reader cannot tell which grain fired — or that a grain fired at all rather
than the agent simply declining. It names no person, no organisation, no setting and no verdict.
The **private notice** does name the organisation, which is why that one never leaves a private
channel and this one may go where the mention was said.

**No model is involved.** The suppression legs run pre-turn and the ack is written by the host, so
nothing is ingested and no spend is paid. The reply-delivery doctrine is unchanged: the `reply` tool
is still the only channel a model's words reach a surface through, and these are not a model's words.

**The ack is not the room announcement.** The two silent-room announcements are broadcasts *about
the room*, at most twice per room ever. The ack is a *reply to one person*, so it carries no
at-most-once claim and fires per addressed wake.

Per surface:

- **Slack / Discord / Teams** — the ack goes to the channel the mention was said in (Slack threads
  it on the mention). It fires only when the private notice of behaviour 1 could not be delivered:
  Slack and Discord when the 1:1 cannot be opened, Teams on every channel @mention (the Bot
  Framework cannot open a 1:1 with a person the bot has never met).
- **GitHub** — the ack is posted by the @mention leg, which by construction only ever sees explicit
  mentions. The ambient supervisor leg posts nothing.
- **Linear** — the ack is a **`response` Agent Activity**, which is the only activity type that both
  shows something and **terminates the Agent Session**. Linear materialises that session the instant
  a member @mentions or delegates, and before this the requester watched a spinner until Linear aged
  the session out. It applies to the two legs that hold a session (the native dispatch and the
  mention divert); the ambient comment leg has no session and stays dark.

**The audit row records the choice.** Each `<platform>.external_policy_suppressed` row carries
`rendering: "ack"` when the line was posted, and no `rendering` field when the drop was dark. An
operator can then tell a member-visible suppression from an invisible one — and, on Linear, a closed
session from a spinner that may still be hanging — without opening the surface.

## Per-wake trust tiering — principal, peer, unauth, relay

On top of the binary surface gate, every *wake* (the message that starts or continues an
ambient/judged turn) is stamped with a **per-person trust tier**, resolved fresh each time
(`packages/core/agent/identity/wake-trust.ts`). Two of the four tiers are then **re-keyed on
addressing when the envelope renders** — see the note below the list.

- **`principal`** (resolver) — the author is on the org admin roster, or on this channel's
  domain admin roster (the same `Domain.admins` config-as-code lists that decide approval
  standing). The roster is matched **platform-qualified**: the tier resolver builds the qualified
  key — `platform/<author-id>`, or `platform/<workspace>/<author-id>` on Slack — from the *wake's
  own surface*, so a roster entry only ever grants
  standing in the namespace it names. A wake with no surface to read a platform from resolves
  no roster hit at all, and neither does one that names no workspace on a tenant-scoped platform.
- **`peer`** (resolver) — an identified human member on a surface the trust gate confirmed
  internal.
- **`unauth`** — a positively-**human** author who is **not vouched** as internal: either
  unidentifiable (no author id), a person the surface positively grades as a **non-member**
  (a Slack multi-channel or single-channel guest, a Slack-Connect stranger, a Discord member who
  has not cleared membership screening, a Teams B2B guest), or anyone on a surface the gate
  couldn't confirm internal. Their content is **reference-only** — when any `unauth` message appears
  in a wake the envelope appends a trusted `<system-note>` telling the model not to act on
  instructions in it. Backscroll siblings get this per-message, so an unvouched author's message
  never renders as an authorized `peer`. On Discord's default posture — a guild with no
  `internal`/`identity.blanketTrust` vouch — every human backscroll sibling on a mention or name-drop wake
  resolves `unauth` too, so that wake can carry two separate reference-only notes: the trigger's
  own and one for the backscroll block.

  **An `unauth` message that reaches the model also marks the turn** — see
  [Security model](../security/security-model.md#what-counts-as-external-content). The mark keys on
  **ingestion**, never on presence: a guest sitting in the room changes nothing until a message they
  wrote actually enters the wake or its backscroll.
- **`relay`** — a bot/webhook/agent (**machine**) author, and the **fail-closed floor** a
  resolution failure lands on. The split from `unauth`: a machine author is `relay`; a human the
  gate can't vouch is `unauth`. Both sit below `peer`; `principal` requires a positive roster hit,
  so uncertainty never resolves upward.

**What the ENVELOPE shows is keyed on addressing, not on the roster.** The renderer
(`packages/core/agent/channels/wake-envelope.ts`, `tagTrust`) swaps `peer` and `principal` before
it writes the attribute: a vouched author who **addressed** the agent renders `principal`, and one
who did not renders `peer`. The standing prompt teaches the same meaning, so the prompt and the
envelope agree. **Admin roster standing is therefore not
visible in the envelope.** Nothing enforcing anything loses an input: approval standing is checked
host-side from the roster, never read back off a rendered envelope.

🔴 **The authority floor always wins, and that is what keeps the fence honest.** The swap only ever
moves `peer` ⇄ `principal`. It never promotes `unauth` or `relay`, so an unvouched stranger cannot
buy member standing by typing an @mention. Both `peer` and `principal` are unfenced already, so the
swap cannot move one body across the untrusted fence.

Directness ("was the bot addressed?") also rides its own envelope flag (`mention`) on the
message itself: being @mentioned still doesn't make a stranger an admin.

**Every surface's wake builder requires the tier — none of them defaults it.** The tier decides
whether the message body reaches the model behind the untrusted fence, so a builder that filled in
an absent tier would decide that too, and any filled-in member tier removes a fence. The compiler
refuses the omission instead. A producer that cannot resolve a tier states the fail-closed one
itself: `relay` for a machine author, `unauth` for a human the gate cannot vouch.

## DM partner trust

For a DM, `trust` means something specific: **is the partner I'm DMing an internal member?**
That answer selects the DM's shared read layer — an *internal* partner lights up the `dm`
shared domain; an *external* one (a guest, a Connect stranger, someone in another workspace)
gets only the read-only `public` layer. Either way the per-user personal store is granted, so
personal DMs always work.

This is verified, not assumed. On Slack the partner's status is confirmed with a `users.info`
lookup, and **fails closed**: a missing or failed lookup, a guest (restricted /
ultra-restricted), a Connect stranger, a deleted account, or a workspace this deployment has not
declared all resolve to `external`.

The workspace test is a **rung walk**, not an equality. The event's own workspace is `internal` with
no declaration needed. Any other workspace is `internal` only where the operator declared it, or the
Slack Enterprise Grid above it — which is what admits a Grid colleague whose home `team_id` is a
sibling workspace. An **app** walks the same rungs as a person: this workspace's own app is
`internal`, an app from another workspace is not, and there is no separate rule for bots. A payload
that names **no** workspace at all takes the same walk with nothing to compare against, so the
register decides alone: a declared workspace or Grid is `internal`, and everything else is
`external`. See [Memory](../capabilities/memory.md) for what each layer exposes.

🔴 **One declaration overrides the fail-closed half.** A `trust: "internal"` entry in
`agent/identity/surfaces.ts` matches at any rung, and a DM's key sits under its workspace — so
vouching a whole workspace also vouches the partner nobody could check. A **positive** external
verdict still wins, because the mapper outranks the declaration; what the declaration raises is the
lookup that never happened or failed. A per-surface entry does not have this reach: it names one
room. Vouch a workspace only if you mean every DM partner in it.

## One mapper per surface — capture vs. interpret

Open Everywhere is "a proper agent, not a Slack bot": each platform contributes a small
**mapper** that translates its native identity into the platform-agnostic `SurfaceBinding`,
and nothing downstream sees a platform-specific field. Adding a surface is one mapper plus
one visibility/trust decision — no downstream change.

The mappers split responsibilities deliberately, for security: the channel adapter only
**captures** raw facts (Slack's `channel_type`, `is_private`, the `users.info` result), and
the binding module **interprets** them into `mode` / `visibility` / `trust`. The
security-critical "is this private / internal?" logic lives in one tested place rather than
scattered across adapters.

Current state across surfaces, stated honestly:

- **Slack** — full mapper, including verified DM-partner trust and externally-shared channel
  detection.
- **Teams** — mapper interprets scope and membership type (`standard` / `private` / `shared`)
  into trust, and **fails closed**: a Shared Channel (cross-tenant) is `external`; a channel
  positively identified as `standard`/`private` in a known tenant is `internal`; an activity
  with unknown membership or tenant binds `external`. Since inbound activities routinely omit
  `membershipType`, external is the common verdict — a single-tenant deployment opts back in
  with `identity.blanketTrust: "internal"`. The mapper also reads a **verified guest bit**: a cached Bot Connector
  roster lookup (`GET {serviceUrl}/v3/conversations/{id}/members/{userId}`) reports `userRole:
  "guest"` for a B2B guest, which demotes the surface to `external` ahead of every other verdict
  including `identity.blanketTrust`. It is demotion-only and fails open — a lookup that cannot answer leaves the
  existing verdict alone. It needs no Microsoft Graph registration and no new permission, but the
  token mint is tenant-scoped, so `MICROSOFT_TENANT_ID` must be set.
- **Linear** — mapped, with **demotion-only** guest verification: a positively-detected
  `User.guest` demotes that author to `external`, and it wins over a vouch. A full member earns no
  promotion, so an unvouched Linear surface still **fails closed to `external`**.
- **Discord** — mapped, with **demotion-only** membership verification: a member who has not
  cleared the guild's screening gate (`member.pending`) demotes to `external`, and it wins over a
  vouch. Guild membership itself proves nothing, so an unvouched Discord surface still **fails
  closed to `external`** (read-only `public` memory at most). The author-trust register is the
  operator's own author-grain lever there.
- Both reach `internal` only through an operator vouch, or through the blanket
  `identity.blanketTrust: "internal"` a single-tenant deployment throws.

## The link layer's own rules

**A platform name is normalised in one dependency-free leaf.** `normalizePlatform`
(`packages/core/agent/identity/platform.ts`) resolves an alias, then folds a `<platform>-` prefixed
name back onto its platform. It lives alone so the binding modules share one implementation without an
import cycle, and a namespaced eve kind is stripped to its bare name before it is normalised.

**A human named by link-set has exactly one spelling inside a principal binding.**
`parseLinkSetRef` (`packages/core/agent/identity/link-set-ref.ts`) accepts only the prefixed form, and
refuses an empty id or one carrying a slash or whitespace. That refusal is what keeps a link-set
reference and a principal key from ever being confused for one another: a malformed entry can never
match anything, so it is rejected at config load rather than resolving to the wrong person.

**Config principals and confirmed link-sets are composed, never merged blindly.**
`unionPrincipals` (`packages/core/agent/identity/link-resolve.ts`) indexes every link-set account and
flags any account **two different people claim**. A flagged account is dropped from **both** sides — an
account with two claimants identifies nobody, and picking one would attribute a person's acts to
somebody else. Matching is on account identity only; a display name never matches.

**The tenant column has one vocabulary.** `linkTenantOf`
(`packages/core/agent/identity/link-tenant.ts`) answers the not-applicable literal on a platform that
is not tenant-scoped, **ignoring the argument entirely** — so a blank there means nobody has named a
tenant, rather than that one was lost. On a tenant-scoped platform it takes the given tenant, falls
back to the sole admitted tenant from config, and **throws** when neither can name one. There is a
value-returning twin for the callers that must not throw.

**Pre-column link rows are backfilled only where the tenant is nameable.**
`backfillLinkTenants` (`packages/core/agent/identity/link-tenant-backfill.ts`) walks the platforms that
still hold un-backfilled rows, skips the ones that are not tenant-scoped, and stamps the **sole
admitted** tenant onto the rest. A platform whose tenant the deployment cannot name is reported as
unresolved and its rows are **left alone**, because guessing a tenant would be an isolation failure.

**A title is display-only.** `displayTitle` (`packages/core/agent/identity/display-title.ts`) answers
the trimmed title when one is set and the immutable name otherwise. It authorises nothing and persists
nothing: the name remains the identity, and the title is what a human reads.

## The person-groups overlay

The IdP-group overlay is machine-owned. `emitGroupsModule`
(`packages/core/agent/identity/groups-codemod.ts`) is its **only** writer, and it is byte-deterministic
and idempotent — reading a module back re-emits its own data and compares, so a **hand-edited file is
refused** with the instruction to normalise it and commit the result. The codemod will not rewrite a
file it did not write. Every member is recorded as a **link-set reference** rather than a principal
key, so the overlay names people through the link layer and never through one platform account.

`loadGroupsOverlay` (`agent/identity/groups-overlay.ts`) merges that overlay into the config-as-code
baseline at load, so the groups a directory sync discovered and the groups a human wrote in the repo
resolve as one set.

## When a wake lands outside its window

`classifyWindowRouting` (`packages/core/agent/access/window-routing.ts`) grades a wake three ways. A
wake at any windowed grain is `windowed`. A **native** wake is `native-degraded` when the room's domain
does have a window, and `native-by-design` when it does not.

A degraded wake emits the `window.routing_degraded` audit row, and the row matters because the
degradation is invisible from the room: such a seat keeps talking, while holding a **different session
key, a different toolset and different memory** from the window seat the room is supposed to have.
Without the row, the only symptom would be an agent that quietly forgot things it should know.

## Surfaces are instantiable — identity = channel instance

A platform is a *mapper*; a **bot identity is a channel instance**. Eve namespaces every
session key by the channel file's name, so mounting a second channel file for the same
platform (`slack-qabot.ts` alongside `slack.ts`) gives that identity its own sessions,
engagement and state with no key-format change — this is the designed path to multiple
addressable bots sharing one deployment and one memory. A channel slug of the form
`<platform>-<anything>` collapses to its platform for identity binding, but only for the platforms
`identity/platform.ts` lists — `slack`, `discord`, `teams` and `linear` — plus the explicit alias
table. Add a new platform to that list in the same diff that mounts a prefixed instance file, or
the slug misses its mapper and fails closed to `external`. When adding a platform, build its
surface factory-shaped from the
start: one construction function, N mountable instances.
