# What revoke actually reaches

You have taken something away — a connector, a person's standing, a host, a silo. The question this
page answers is **when it stops being true for a session that is already running**, and **what you
can do to make it stop sooner**.

Every grant in Open Everywhere is *read* somewhere and *re-read* on some rhythm. That rhythm is the
revocation latency. A grant re-read on every tool call dies almost instantly; a grant read once when
a session started stays alive for as long as the session does — and a standing channel seat can run
for days. None of this is about whether the fence holds. It is about **when a change to the fence
takes effect for work already in flight.**

The contract, in one sentence:

> **Connector grants and identity links are step-grained. Config is deploy-grained. Egress is
> turn-grained, and so is memory *removal* for a standing seat. Session approval grants are
> revocable. Warm minted credentials are the one thing you cannot flush.**

---

## The matrix

| Plane | Where the grant is read | When it is re-read | Revocation latency | Forcing the earliest revocation |
|---|---|---|---|---|
| **Connector grants** (which connectors a surface may use) | inside the credential resolver's `getToken`, before any token exists | **every connector call** | next connector call | `revoke_connector` |
| **Identity links** (which accounts are one person; whose credentials a DM reaches) | the link-set membership read on each connector resolve | **every connector call** | next connector call | `revoke_link_set` (terminal) or `suspend_link_set` (reversible) |
| **Stored per-person credentials** (OAuth tokens, AWS Identity Center tokens) | the encrypted vault, by subject | on demand | **destroyed** by the revoke itself | `revoke_link_set`, or `purge_link_set_credentials` on its own |
| **Config-as-code** (bundles, bindings, domains, silos, roles, repos, AWS roles, egress hosts) | compiled into the deployment | on deploy | **deploy** | ship the change |
| **Spend caps** | the override store, per spend check | every check | next check | `set_spend_limit` / `clear_spend_limit` |
| **Runtime domain skills** | the skill store, per session's skill resolve | per session | next session | `delete_skill` |
| **Egress firewall** (reachable hosts + the credential injected at the boundary) | compiled and applied to the sandbox | **every turn** | next turn of that session | ship the config change, rotate the credential, or `revoke_connector` (narrows any egress connection whose id it names, same as it narrows the Eve connector plane) — all land on the next turn by itself |
| **Memory materialised into the sandbox** | the plan, resolved per session | session start; **plus every turn for a standing seat** | next turn (standing seat) / **session end** (thread seat) | narrow the plan, then wait a turn — or start a fresh thread |
| **Routine standing grants, unspent one-call approvals** | the session-grant memo, per proposal | every proposal | immediate, once revoked | `revoke_session_grants` |
| **Warm minted credentials** (AWS session creds, both GitHub installation tokens, the Teams Graph token, the Linear actor token) | an in-process cache | when the cached copy nears expiry | **≤ 59 min**, or ≤ 30 days for the Linear actor token | *no lever* — see [The one thing you cannot flush](#the-one-thing-you-cannot-flush) |

---

## The step-grained planes: connectors and identity

These are the ones that behave the way people expect a revoke to behave.

**A connector grant is re-derived on every call.** The credential resolver re-resolves the calling
surface, overlays the runtime override store, and refuses before a token exists. So `revoke_connector`
is effective from the agent's very next connector operation — no redeploy, no session restart. If the
override store cannot be read, the resolver refuses rather than falling back to the config grant: a
break-glass revoke lives *only* in that store, so falling back would re-grant exactly what you just
took away.

**An identity link is read on the same edge.** A revoked or suspended link-set resolves to nothing,
so the accounts on it immediately stop reaching the set's shared credentials and fall back to their
own. `revoke_link_set` additionally tombstones every account (so a later proof-of-control challenge
cannot re-link them) and **destroys the credentials stored against them** — the set's shared subject
*and* each account's own per-person rows, which is where an AWS Identity Center token lives. That
purge is best-effort *on top of* the revoke: a vault outage can never block an offboarding, and the
audit row records `credentialsPurged` / `purgeFailed` so a purge that did not happen is visible and
can be finished with `purge_link_set_credentials`.

### `revoke_connector` reaches egress too (OPE-311)

A break-glass revoke is one override row, keyed by whatever string you pass as `connector` —
and it narrows **every** plane that reads a grant under that same string, not only the Eve
connector plane. The egress compiler (`compileNetworkPolicy`) now consults the same live
`connector_override` store, keyed by egress `Connection.id`: if a bundle's credentialed
connection shares an id with the revoked string, its host — and the credential injected at
that host — drops out of the compiled firewall policy on the session's very next turn, exactly
like a config change or a rotated secret. A store-read failure fails closed the same way the
credential gate does: every credentialed host is denied, not just the one actually revoked,
rather than risk silently re-granting a revoke that couldn't be confirmed.

The one thing to get right operationally: **name the right string**. `revoke_connector({
connector: "notion" })` closes the Eve MCP connector `notion` (`bundle.connectors`). If the
same bundle *also* reaches the vendor directly over the egress firewall — a `connections`
entry such as `{ id: "notion-rest", allowedWebsites: ["api.notion.com"], … }` — that is a
*different* id, and revoking `"notion"` does not touch it. To cut the credential-injected
egress route too, revoke the connection's own `id` (`revoke_connector({ connector:
"notion-rest" })`) — the SAME override table narrows whichever plane's identifiers the string
matches, on the next turn either way.

---

## Config is deploy-grained, and that is the design

Bundles, bindings, domains, silos, roles, repo grants, AWS role grants and declared egress hosts are
**config-as-code**. They change by reviewed PR and take effect on deploy. There is deliberately no
runtime *grant* anywhere on this plane: access widens only through a merge.

The corollary is that the runtime narrow lane is a **break-glass exception**, and it exists for
**connectors only**. There is no runtime narrow for an AWS role grant, a repo grant, or an egress
host — those are deploy-grained in both directions. That asymmetry is deliberate rather than an
oversight: the connector override earned its lane because a leaked connector token is the incident
people actually have at 3am. If a second plane ever needs one, the shape to copy is the connector
override — an operational-store row, narrow-only at the point of effect, consulted live by the same
resolver that reads config, so a widening override is not expressible.

---

## Egress is turn-grained

The sandbox network policy is not just an allow-list. It also carries **the credential values
themselves**, baked into header transforms so the agent never holds a secret. Both halves are live
state: a bundle can stop granting a host, and a secret can rotate.

That policy is recompiled and re-applied **on every turn**. Only when the recompiled policy actually
differs from what is in force does it reach the sandbox, so the steady-state per-turn cost is a
recompile rather than a firewall round-trip — but a revoked host or a rotated credential changes the
policy, and therefore lands on the next turn.

Two properties worth knowing:

- **A bundle that stops compiling mid-session cuts egress off.** If the policy cannot be compiled —
  a bundle naming a secret that is no longer set, say — the result is `deny-all`, applied. It never
  coasts on the policy it compiled an hour ago, and it never falls through to the runtime's
  allow-everything default.
- **A mid-turn apply updates the record.** `checkout_repo` and `open_pull_request` replace the
  whole policy inside a turn with one that carries the git read-broker's token. They apply it
  through `applyAndRecordEgressPolicy` (`agent/hooks/egress.ts`), which records its fingerprint
  and shape as the policy in force (OPE-2303). The next turn's recompile therefore differs from
  the record, and the hook re-applies the base policy, which drops the broker's token. A failed
  re-apply then compares the base policy with the brokered shape. The base policy does not cover
  it, so the turn is refused, as the last item in this list describes. This holds for a root
  session. A subagent child shares its parent's firewall but not its parent's applied record, so
  a brokered apply that a child makes is not on the parent's record. The parent's next turn can
  skip as unchanged, and the brokered policy can stay in force until the parent's base policy
  changes.
- **The session can see that it moved.** A turn that re-applies also regenerates the sandbox's
  `egress/STATUS.json` under a new `policyFingerprint`, so an agent that finds a host it used
  yesterday is now unreachable can read what it is on today rather than guessing. Same skip gate: an
  unchanged turn rewrites nothing. (The redaction rules and the protocol that file carries are in
  [Credentials & the two planes](./credentials-and-planes.md#what-the-agent-can-see-about-its-own-policy).)
- **A failed re-apply that narrows refuses the turn.** At session start a failed apply aborts,
  because there the alternative is running with no firewall at all. Mid-session the
  previously-applied policy is still in force. The hook compares the new policy with that one by a
  shape: per host, a keyed HMAC-SHA256 of the host's rules, never the values
  (`egressPolicyCovers`, `agent/hooks/egress.ts`). The shape rides the serialized session state. The
  key is an HKDF-SHA256 subkey of `OE_CREDENTIAL_ENCRYPTION_KEY`, label `egress-state-digest`
  (OPE-2302), and it is not in that state. So a reader of the state cannot test a guess at a
  low-entropy credential offline against the shape. The same state still carries the unkeyed policy
  fingerprint ([Credentials & the two
  planes](./credentials-and-planes.md#what-the-agent-can-see-about-its-own-policy) names that
  limit). So a reader who also knows every other byte of the policy can still test a guess against
  that fingerprint. The keyed shape removes only the per-host digest as an oracle. The deployment
  adds no new secret. A rotation of the credential key changes every digest. The next turn then
  re-applies the unchanged policy once (reason `digest-key-rotated`), so the shape on record is
  under the current key again. A failure of that re-apply does not refuse the turn. The plan picks
  this reason only when the recompiled fingerprint equals the one on record. That is the condition
  under which an unchanged turn skips the apply, so the failure leaves the turn no worse off than an
  unchanged turn. Without `OE_CREDENTIAL_ENCRYPTION_KEY` the key is random per process. Then a shape
  that another process recorded never matches, and a failed re-apply refuses unless the new policy is allow-all. The turn continues
  only when the
  new policy opens everything the old one opens, with identical rules on every shared host. Then the
  failure is staleness: it is audited (`reapplyFailed` on the `egress.policy` row) and the next turn
  retries. In every other case the turn is REFUSED (OPE-2158), and the row also carries `aborted:
  true`. That covers a removed host, a revoked or rotated credential, a compile-error `deny-all`,
  and, without `egress.allowUnenforced`, a session whose enforced shape is unknown. The comparison
  is conservative: a changed rule counts as a narrowing, because the code cannot rank two rules.
  `egress.allowUnenforced` follows the session-start rule: it keeps warn-and-continue for a backend
  that cannot enforce, which means no enforced policy is on record for the session (just-bash
  rejects every apply). It does not lift the refusal once the session has an enforced policy on
  record. In a task-mode session a refused turn ends the session. The residual is named rather than
  hidden: between a failed widening re-apply and a successful one, the session enforces an *older*,
  narrower policy than its config says.

---

## Memory: removal is turn-grained for a standing seat, session-grained otherwise

Memory is materialised into the sandbox as plain files. A **standing seat** (an ambient supervisor,
in a deployment running the windowed topology) re-resolves its memory plan every turn, and that
re-resolve now works in both directions:

- silos whose durable store advanced are **re-pulled** (so cross-surface recall is fresh), and
- tiers that have dropped **out** of the plan are **un-materialised** — the files leave the sandbox
  and the on-disk index stops listing them.

That second half is the revocation reach. Un-vouch a surface, or remove a silo from a domain, and the
old silo's files stop being readable in the live sandbox on the next turn instead of lingering — and,
for a writable tier, they leave the persist path with it. The change is announced to the session
through a `memory.index_change` audit row carrying the removed silo *names* (never content), which is
what tells the seat on its next wake that the frozen index in its instructions has moved.

**Everything else is session-grained.** A per-thread seat, a task worker and a native session do not
re-resolve their memory plan at all: they materialise once and keep what they have until they end. If
you need memory gone from one of those *now*, the session has to end — start a fresh thread.

---

## Session approval grants are revocable

A click in a conversation approves **one act** and keeps nothing (OPE-2363). A `pr.open` card or a
connector-op card in a thread, a DM or at the top level of a channel offers Approve and Reject only,
and a second identical proposal gets a card again. Repeated approvals there are the approval judge's
job. Two kinds of approval memo outlive a click, and `revoke_session_grants` reaches both:

- **A routine's standing grant.** The only card with a middle button is a routine's `pr.open` card:
  **Approve for this routine (up to N h)**. It writes a memo keyed on the routine, so later fires of
  that routine skip the card for the same kind. It ends at the first of three things: it expires after
  `approvals.routineGrantTtlHours` (24 by default); `revoke_session_grants` deletes it, with
  `sessionId` set to the routine's grant key; or an `edit_routine` moves the routine's key, which
  carries its generation. The same revoke deletes the routine's declared permissions too (the
  `connector.tool:` rows).
- **An unspent one-call connector-op approval.** A click on a connector-op card writes a memo keyed on
  the input's digest, under the key of the thread or DM that asked. The agent's next identical call
  spends it. Until then it waits, for at most 24 hours. `revoke_session_grants` with only `surfaceKey`
  deletes every unspent one in that room. A Discord thread or a Teams reply chain is reached through
  its parent channel's surface key.

The click on a routine's card also releases the cards the grant *already* covers: a routine fire that
fans out several workers has all of them carded before any click exists, so one click decides that
whole fan-out rather than leaving stale buttons behind. That release runs **off the click's response
path** and is capped at 32 sibling cards (`MAX_SESSION_GRANT_RELEASES`) — a chat vendor answers a
click in about three seconds, and each released card runs a real action. Cards past the cap stay
pending and clickable.

Keep two things straight:

- It narrows **discretion, not access**. A grant only ever skipped the human card; every capability
  gate ran underneath it regardless. To cut access, use `revoke_connector`.
- It is **not** a side effect of `revoke_connector`, deliberately. A revoked connector already fails
  closed at the credential wall, so an approval left behind can skip no card that matters. Sweeping
  memos from `revoke_connector` would take out every other connector's approvals as collateral. See
  [The control plane](./control-plane.md).

A `sessionId` must be a key of the named room: a conversation key of that room, or the grant key of
a routine stored under that `surfaceKey`. Any other key is refused, so the verb never deletes another
room's approval. `revoked` counts the memos deleted.

## The one thing you cannot flush

Some credentials are **minted**, not stored: AWS session credentials from STS or Identity Center,
the two GitHub installation tokens the conversation-write arm and the memory backing hold, the
Teams Graph app-only token, and the Linear app actor token. Each is cached warm in the process that minted it and re-minted a set
margin before it expires. The margin is five minutes by default, and a credential may name its own.

Revoking the *source* — the role, the app installation, the person's Identity Center entitlement —
stops the **next** mint immediately. It does not reach a copy already warm in a running process.
The bound:

- **AWS session credentials: ≤ 55 minutes.** A one-hour credential, re-minted five minutes before
  expiry.
- **the GitHub installation token the conversation-write arm holds: ≤ 55 minutes.** Same shape: a
  one-hour token, re-minted five minutes early, cached per installation and repository.
- **the GitHub installation token the memory backing holds: ≤ 59 minutes.** A separate warm token,
  one hour with a 60-second margin, cached per repository. Revoking the App installation to cut a
  domain off its memory repo therefore leaves that copy reading and writing for up to another hour.
- **the Teams Graph app-only token: ≤ 59 minutes.** A one-hour token with a 60-second margin.
- **the Linear actor token: ≤ 30 days.** Linear's client-credentials tokens are documented to live
  30 days, and that is the outer bound on how long a warm one can outlive a revoked app.

The git **checkout** path is the exception that proves the rule: it mints an installation token per
call and caches nothing, so revoking the installation stops the next checkout at once. A token
already handed to a running sandbox still lives out its own hour.

**There is deliberately no flush lever**, and that is a judgment rather than a gap. The caches are
per-process: a serverless deployment has an unknown number of live instances at any moment, and a
"flush" that reached whichever instance happened to serve the control call — and none of the others —
would read as done while several warm copies carried on. A half-working revoke lever is worse than a
documented bound, because it converts a bound you can plan around into a false belief. So the bound
is stated here and the vendor-side revoke is the real answer: revoke at AWS, at GitHub, at Linear,
and treat the number above as how long to keep watching.

---

## See also

- [The control plane](./control-plane.md) — every runtime verb, and the override doctrine.
- [Credentials & the two planes](./credentials-and-planes.md) — why the egress firewall and the
  connector plane revoke on different rhythms.
- [Identity](../how-it-works/identity.md) — link-sets, offboarding, and what a revoke destroys.
- [Access & scoping](../how-it-works/access-and-scoping.md) — the layers a grant crosses.
