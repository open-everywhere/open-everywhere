# The chat-surface contract

Open Everywhere talks to people through **chat surfaces**. Six ship today: Slack, Discord, Teams,
GitHub, Linear and Notion. Each one is a different vendor with a different API, and the agent's
model sees none of that difference. It sees **one small set of generic verbs** that mean the same
thing everywhere.

This page is that verb set, written as a contract. It states what a chat provider must deliver,
what each verb must do, what a verb may refuse, and how a provider declares an ability it does not
have. A provider that meets this contract joins the "everywhere" without a core change and without
a vendor name anywhere in core.

> **Scope.** This page is the **semantic** contract — what the verbs mean. The **mechanical**
> contract — which `register*` function to call, in which module, from which package — is
> [provider bundles § chat-surface plane](./provider-bundles.md#chat-surface-plane). Read this page
> for what to build, that page for where to plug it in.

---

## 1. Chat surface and work surface are different things

The rule (ratified 2026-08-21, OPE-928):

> A domain works with **tools**. A tool is a credential the domain holds, plus egress to that
> vendor at the firewall, plus an optional skill that describes the API. That is the whole model.

Two consequences shape this contract, and both run in one direction only:

1. **Chat presence is never a precondition for work.** A domain that files Linear issues but never
   talks in Linear has full Linear work capability. It holds the credential.
2. **Chat presence never grants work capability either.** A domain with a Linear chat channel and
   no Linear work credential gets the generic chat verbs on that channel and nothing more
   (OPE-953).

So a chat surface carries **only** the verbs on this page. Ticket creation, issue state, page
writes, workspace search — all of it is the work plane, mounted from the domain's own credential
declaration. The same vendor is often both. The two roles never derive from each other.

**Three vendor tools read a chat container, and they belong to the delegated worker** (OPE-1014).
`read_linear_issue`, `read_notion_page` and `read_notion_comments` predate this contract, and each
still has a chat-plane arm that reads the container the turn arrived in on the chat credential. That
arm mounts on the **worker** grain only, with NO domain grant required — a delegated worker holds no
`read_channel` / `read_thread` (that pair is the seat's vocabulary), so this arm is its container
read in an UNGRANTED domain. A **work-granted** domain's worker now also holds the generic
`read_work_channel` / `read_work_thread` pair on a Linear or Notion origin (OPE-1064: Linear and
Notion hold a `kind: "container"` `WORK_ROLES` row too, on the same role their entity row already
names) — so the two overlap in a granted domain and this vendor arm is the ONLY route in an
ungranted one. A conversational seat has the generic pair and uses it regardless of grant. Each
tool's WORK arm is untouched and grain-blind, so a domain that declares the vendor's work credential
still mounts the tool on its seats.

That separation is what makes this contract publishable. A chat provider implements a closed set of
conversation verbs. It does not have to model anybody's issue tracker.

---

## 2. What a provider delivers: the wake

Before any verb runs, the provider must turn a vendor event into a **wake** — one delivery that
names a conversation and a turn. The contract has four required parts.

### 2.1 The binding — who and where

The identity mapper (`registerIdentityMapper`) reads the raw vendor payload and resolves:

- the **partition** (which workspace, which container),
- the **mode** — `channel`, `dm` or `mpim`,
- the **visibility** — `public` or `private`.

It resolves **fail-closed**. An undetermined private-or-external flag resolves to the tighter
answer, never the looser one. This is the security-load-bearing part of a provider; see
[identity](../how-it-works/identity.md).

### 2.2 The addressing — which container this turn arrived in

`ReadAdapter.wakeAddress(ctx)` answers one question: **which container, and which thread root, does
this turn's wake name — in the exact ids this provider's own read calls take?**

It is a **required** member, and it is required because no two surfaces spell the address the same
way:

| Surface | Read container | Thread root |
|---|---|---|
| Slack | the channel id | the `thread_ts` |
| Discord | the channel id | the thread's **own** channel id (a Discord thread is a channel) |
| Teams | the Teams **channel** id | the `;messageid=` root inside the conversation |

A Teams channel activity binds the reply chain as its conversation, while the read needs the
channel id. A core-side guess is wrong on at least one of those three, and wrong **silently** — it
fetches a different room rather than failing. So each provider states its own mapping.

`wakeAddress` is pure and synchronous. It reads the binding; it never touches the network. It
returns `undefined` when this turn names no readable container, and the caller then refuses out
loud. It never guesses an id.

### 2.3 The stored origin — how the answer gets back

`registerWakeOriginCodec` gives core a `validate` / `threadRef` / `isThreadScoped` / `containerId`
quartet over the provider's own stored-origin shape. Origins are serialised into the durable store
at dispatch time and re-validated fail-closed on read, so this is a compatibility contract with
rows already on disk.

A platform with no registered codec is fail-closed by omission: the reply path posts nothing.

One OPTIONAL fifth member, `carryPlacement`, exists for a surface that holds the reply's PLACEMENT
separately from the identity `threadRef` reads. Slack is the surface with an arm today: a top-level
origin's thread key is its channel id, so two top-level wakes in one channel are one conversation
carrying two different `replyAnchorTs` values — and an origin minted for a message that answers
nothing carries none. The reply fence admits a sibling wake of the same conversation, and core then
calls `carryPlacement` so that sibling posts under the message the turn was woken by instead of flat
in the channel.

The arm's contract is: fill a placement the target LACKS, never overwrite one, change no other field.
Core cannot check the first two — `validate` tolerates any well-formed row, which is the price of
stored-data compatibility — so they are a requirement on the provider. Core DOES enforce the
conversation: it re-validates what the arm returns and re-tests it against the target's own thread
ref, so an arm that changed the container or invented a thread scope is discarded. An arm can place a
post; it cannot move one.

Discord is the same shape with no arm yet: its `threadRef` keys on `channelId` alone while its post
arm reads `messageId` (and `autoThreadName`) for placement, so a Discord sibling answer can still
post unanchored. Carrying a `messageId` there would also decide whether an auto-thread opens, which
is a UX choice nobody has made. Teams, GitHub, Linear and Notion keep their placement inside the
thread key (Teams keys on `replyToActivityId`), so two origins that pass the conversation test
already agree on placement and need no arm.

### 2.4 The capability manifest — what this surface honours

`registerCapabilityManifest` declares which verbs this platform can actually honour **today**:

| Field | Gates | Means |
|---|---|---|
| `midTurnPost` | the `reply` tool | a real mid-turn post primitive is wired |
| `reactions` | the `react` tool | a real reaction primitive is wired |
| `closingProseDropped` | every conversational seat's reporting arm | **every** seat on this surface has its turn-final text dropped, so `reply` is the only route out. Declare it only when no seat of any shape posts its closing prose — every seat reads the arm, a supervisor-shaped one inside its persona and a native one through the delivery slot |
| `supervisorProseDropped` | a supervisor-shaped seat's reporting arm | the narrow half: a supervisor-shaped seat drops its turn-final text, and a **native** session's closing prose still posts. Declare one of the two facts, never both. Linear is the one surface that declares this one |

The manifest declares **what OE can honour, not what the vendor's surface does**. Teams delivers
reaction events natively, so a reader could expect `reactions: true`. Its manifest says
`reactions: false` because those events are inbound only. The vendor exposes no outbound reaction
write an application identity can drive, which §7.3's probe measures. That is the rule working, not
a bug in the rule — see the audit in §7.

### 2.5 The ambient engagement seam — optional, and its absence is visible

A person who pulls the agent into a conversation expects to keep talking without a new @mention.
The policy for that is core-resident and pure (`packages/core/agent/channels/engagement.ts`), but
each provider wires its own event handler into it. Three steps:

1. **Engage** the conversation when the agent is @mentioned — `markThreadEngaged`.
2. On a later **non-mention** message, ask `shouldDeliverReply` whether to wake the live session.
3. **Honour the durable `stopped` flag** that `stand_down` sets (§4.10). `shouldDeliverReply` reads
   it as its last disqualifier.

A provider that skips this seam still holds a conversation. What it gives up is the
**thread-following registry**: a plain reply never pulls the agent back into a thread, and
`stand_down` has no row to mark. Under §10 item 5 that absence is a **gap**,
not a posture. A provider that cannot wire the seam declares the capability unsupported with a named
platform reason, and a lint reds a silent gap (OPE-1499).

**Wiring it is three concrete things**, and Teams is the worked example (OPE-1500):

1. The **identity mapper publishes the anchor** as `binding.engagementKey` — the id of the container
   the engagement is kept per, and the same id the surface's own wake gate reads the row back at. On
   Teams that is `conversation.id`: the reply chain in a team channel, the chat in a group chat. A
   mapper publishes it only where its gate reads it, which is why a 1:1 chat carries none.
2. The **ingress marks and reads**: `markThreadEngaged({ participating: true })` on an @mention (the
   promotion that also clears a stop), and `shouldDeliverReply` over the ROW — not a boolean — on a
   later plain message. 🔴 A promotion the agent's OWN POST makes carries `byOwnPost: true` as well,
   and that one never clears a stop: only a person can invite the agent back. Omitting it is how a
   stand-down acknowledgement lifted the very stop it was acknowledging (OPE-1669).
3. The **platform must deliver the plain message at all.** Teams delivers a non-mention activity only
   where the tenant consented to an RSC grant — `ChannelMessage.Read.Group` for a channel,
   `ChatMessage.Read.Chat` for a chat. Nothing can probe that consent, so the provider states the
   dependency out loud: it proves the grant present on the first non-mention message and logs the
   named reason once until then (`teams-engagement.ts`). That is §3's rule applied to a gap the
   provider cannot itself close.

🔴 **The seam is NOT the only ambient wake, and the two must not be confused.** Four surfaces run a
non-mention leg on a different mechanism — the ambient supervisor on GitHub, Linear and Notion, and
the single-window front's Leg A on Teams. Those legs answer a DOMAIN's posture; the seam
answers a CONVERSATION's own invitation, and needs no domain posture. The two are not alternatives:
Slack runs the ambient supervisor AND the seam (§10 item 5). Every surface now shares one suppressor
— a stood-down conversation is dropped above both legs, so `stand_down` silences the ambient leg too,
for a conversation an address enrolled. Teams adds a second, ROOM-grain stop for the undirected wake
the conversation grain cannot address (§7.6).

**Which leg answers an engaged follow-up differs by surface, and only two of the three ticketing
surfaces open their ambient leg.** On **Linear** and **Notion** the registry does open it: an engaged
container's plain follow-up runs even where the domain turned ambient off. On **GitHub** it does not —
the ambient leg returns on the domain flag before it reads the registry, and the engaged follow-up
is answered by the NATIVE leg (`githubOnComment`) instead. The registry only SUPPRESSES and DROPS on
GitHub's ambient leg.

🔴 **GitHub's follow-up arm has two floors of its own** (`githubEngagedFollowUpReach`), and they are
the exception to "no domain opt-in" rather than a widening of it. The arm refuses a repo that is not
positively private — a plain follow-up wakes a full native turn, so on a public repo any passer-by
could buy one — and refuses an INLINE REVIEW comment, because the anchor is `owner/repo#N` and a
review thread shares its pull request's row. An `@mention` is unaffected by both.

All six surfaces wire this seam. §7.1's seam row and §7.2's `stand_down` row are generated from the
providers' own declarations, so they carry the same reading.

🔴 **Ruled 2026-09-07: the engaged seam is a capability every surface offers** (§10 item 5). The
ambient leg is not a substitute: it wakes the session, and it stores no row, so `stand_down` has
nothing to mark. Teams landed first (OPE-1500), then GitHub, Linear and Notion (OPE-1501). Each
provider declares the capability supported or unsupported with a named platform reason, a lint reds a
silent gap, and a `supported` declaration must pass a contract test (OPE-1499).

🔴 **An unenrolled conversation changes what `stand_down` does, and a provider must know which
answer its surface gives.** With no engagement row the verb can mark nothing, and it says so on every
surface: all six now refuse for want of a ROW rather than for want of an anchor, because every mapper
publishes one. Wiring the seam is what turned the verb from a standing refusal into a working stop —
see §4.10 and §7.6.

### 2.5.1 What the engagement registry answers, and which way each read fails

The registry holds one row per engaged conversation. Five predicates read it, and each one fails in
the direction its own question needs. The directions differ on purpose, so read this table before you
copy a posture from one predicate to another.

| Predicate | Question it answers | What a store error answers |
| --- | --- | --- |
| `isThreadEngaged` (`packages/core/agent/channels/engagement.ts`) | May the agent join in here? | **Not engaged.** Fail-closed — an unknown answer must never barge in. |
| `isThreadStopped` (same file) | Was the agent asked to stop, right now? | **Not stopped.** Fail-open — an unknown answer must never swallow a reply the model already wrote. |
| `getThreadEngagement` (same file) | The whole row. | `null`. |
| `conversationEnrolledForSilence` (`engaged-wake.ts`) | Is this conversation an enrolled participant? | **False.** A healthy turn never waits on a store read. |
| `markThreadEngaged` (`engagement.ts`) | Write the engagement or refresh it. | Logged and swallowed. A write never fails a turn. |

`isThreadStopped` also reads an absent anchor as not stopped: a turn that holds no anchor holds no
row that could have been marked.

**The agent's own post is not a re-invitation.** `ownPostMustNotRevive` downgrades a promotion to a
plain refresh while the row is stopped. A refresh advances the last-turn time and touches nothing
else, so the stop survives and the conversation stays quiet until a person addresses the agent again.
Without the downgrade the acknowledgement that `stand_down` posts would clear the very stop it had
just recorded. The rule fires only when the caller declares the promotion its own post, the promotion
asks for `participating`, and the row is already stopped.

**Enrolment is a positive answer, never a default.** `conversationEnrolledForSilence` requires a row
whose `participating` is exactly `true` and whose `stopped` is not `true`. No anchor, no row, or an
unreadable store all answer false.

**On an enrolled conversation the silence verb loses exactly one reason.** `no_reply` refuses
`addressed_to_other` there, and the refusal text
(`NO_REPLY_ADDRESSED_TO_OTHER_REFUSAL`, `engaged-wake.ts`) states the enrolment and names the two
endings that remain: answer the message, or call `no_reply` again with `nothing_to_add`. It also
points at `stand_down` for a conversation the people asked the agent to leave. `nothing_to_add` and
`stand_down` stay available on every wake.

### 2.5.2 How certain the agent is that a wake was meant for it

`classifyParticipation` (`packages/core/agent/channels/engagement.ts`) grades every wake into
`addressed`, `participating` or `uncertain`. It is a pure predicate over the wake envelope's own
signals — the mention flag, the wake reason, the author's trust tier and the author kind. It makes no
model call and reads no store.

The order is the policy, most certain first:

1. An explicit mention, a `dm` reason, or a `dispatch` or `spawn` reason reads **addressed**.
2. An unaddressed post from a foreign bot reads **uncertain**, whatever the wake reason says.
3. An unaddressed post from an `unauth` author reads **uncertain**, on the same terms.
4. A `thread-activity` reason that survived both reads **participating**.
5. Everything else reads **uncertain**.

`uncertain` sets `conservative`, which tells the turn to lean toward silence. It is a signal to the
model, not a host-side suppression: the host still dispatches the turn.

**Which message reaches an engaged conversation's live session** is `shouldDeliverReply`'s answer, and
its order is fail-safe — every disqualifier runs before the single delivering answer. A message
delivers only when it carries no subtype other than `message_changed`, its author is not a bot, it is
not itself a mention, it sits in a thread, the thread is engaged, and the thread is not stopped. The
stopped check is deliberately last: a stopped conversation is still engaged, because the row must
survive for the marker to be readable at all.

### 2.6 The owned-thread ingress divert — who hears a thread's follow-up

A spawn can hand ONE thread to its own session — a task worker or a thread seat — and it records a
durable ownership row for that thread. The row is only half the mechanism. The other half is the
INGRESS: when the next message lands in that thread, something has to read the row and dispatch the
wake to the OWNER's token instead of the standing seat's. Without that read the owner never hears
from the thread it was spawned for.

**One core function does the whole decision: `divertInboundToUnifiedWindow`** (core
`channels/unified.ts`). A provider's single-window ingest calls it in place of the raw
`divertToUnifiedWindow`, and that call IS the seam — there is nothing else to wire, and no
per-surface copy of the rule. The rule stays core's: the owner acts, and the standing seat stays
ambiently aware through backscroll on its next wake.

**It is fail-closed to the standing seat at every step**, so a surface that wires it changes nothing
until a thread is genuinely owned. The flag off is a straight passthrough with no store read. A wake
that is not thread-scoped goes standing with NO lookup at all. No row, a store error, or a stale
owner means standing, and the dead row is reaped. Even an owner dispatch that throws falls back to
the standing divert, because a message is never dropped.

**A surface must carry a POSITIVE thread signal in its stored origin**, or the guard reads every
wake as top-level and routes it standing. That guard is not optional: a top-level wake keys on its
container id, so an ownership row recorded off a top-level spawn would otherwise match every
top-level message in the container and blind the standing seat. The six signals: Slack's `threadTs`,
Teams' `replyToActivityId`, Discord's `thread` (stamped at mint from the relay payload's channel
type, because a Discord thread is its own channel id and the id alone proves nothing), and — on
GitHub, Linear and Notion — the container itself, where the thread and the container coincide.

**A DM leg is wired exactly when its DM origin can carry a thread signal.** Slack's can — a DM
message that genuinely sits in a thread keeps its `threadTs` — so a Slack DM thread can be owned and
that leg consults ownership like the channel leg. Discord's and Teams' DM origins carry no thread
signal at all (the Discord codec forbids the field on the DM shape; the Teams DM leg mints no
`replyToActivityId`), so those two legs keep the raw divert: a lookup there would buy a store read
and no routing. The rule is the signal, not the container.

§7.1's `owned-thread-ingress` row is generated from the providers' own declarations, and its probe
scans each bundle's sources for the import — the same shape the ambient engagement seam's probe
uses, because neither seam has a registry to read. `scripts/owned-thread-ingress-wiring-test.ts`
drives each surface's REAL ingest against a real store and asserts the wake reaches the owner and
not the standing seat, which is the question a declaration alone cannot answer.

---

### 2.6.1 Thread ownership — who a thread's follow-up wakes

A thread ownership row records which session owns one thread. `recordThreadOwner`
(`packages/core/agent/channels/thread-ownership.ts`) writes it with a **seven-day** TTL
(`THREAD_OWNER_TTL_MS`), so a thread nobody handed back returns to the standing seat rather than
staying owned forever. The TTL clock is the thread's **last activity**, not the spawn: every message
routed to a thread seat moves it forward (`touchThreadSeat`), and the idle sweep (§2.6.2) closes a
quiet thread seat with a hand-back before this backstop could drop its row in silence.

`resolveThreadOwner` **fails closed**: a store error answers `null`, and the message then routes to
the standing seat. `clearThreadOwner` answers `false` on the same error, so a failed release never
reads as a release.

`routeThreadMessage` decides the route from the stored token alone, and every doubt routes to the
standing seat. It returns `standing` when there is no owner token, when the token does not parse as a
window token, when the window id is neither task-grain nor thread-seat-grain, when a **task** owner's
**generation** differs from the live one, and when the token's **domain** differs from the caller's.
A retired task worker therefore cannot swallow a thread's traffic after the seat rotated.

🔴 **A thread seat's generation never makes it stale** (OPE-2428). Its token carries the generation
its parent had at the spawn, but the seat is its own eve session — a dispatch, not a child — so the
parent's retirement does not end it. Reading that generation as staleness orphaned every delegated
thread that outlived a rotation (12 quiet hours or 7 days): its messages went back to the standing
seat, its row was reaped, and it never handed back. The domain check still applies to a seat, and a
seat that fails it is **closed with a hand-back** at the ingress reap, never just dropped. The spawn's
idempotency check reads the same rule (`isLiveThreadSeatOwner`): a second spawn on a thread reuses
the live seat whatever generation spawned it.

The **owner's grain is read from the token's own shape**: a `t/` window id is a wide-hands task
worker, an `s/` window id a narrow thread seat. Nothing else carries that fact, so the route and the
hands agree by construction.

### 2.6.2 The thread-seat lifecycle

A thread seat is a persistent conversational presence that owns one thread and stays live across
turns.

**Its state row lives exactly as long as the ownership row it shadows** — the same seven-day window
(`THREAD_SEAT_STATE_TTL_MS`, `thread-seat-state.ts`). The row records the seat token, the parent's
registry key, the stored wake origin and the state.

`threadSeatOrigin` **re-validates the stored origin on every read**. Unparseable JSON and a value that
is not a known origin both answer "no origin", so a corrupted row cannot misroute a delivery.

`recordThreadSeatClose` **rewrites the row rather than appending to it**: it reads the open record,
rewrites it with how the thread closed — `completed`, `expired` or `closed` — and the seat's report
when it gave one, and answers the row with whether it was still open. With **no record it answers
`null`**, and no hand-back fires. 🔴 The write is **one conditional store UPDATE that names the
closing seat** (`closeThreadSeatState`): it lands only while the row is `open` and still names that
seat. So two racing closes of the same kind close the record once and hand back once, and a late
close by an OLD seat never closes, un-routes or marks the record a NEWER seat wrote. One exception is
deliberate: a `completed` close by the SAME seat supersedes an `expired` row. When the sweep closes a
thread first and the seat then completes it, the parent gets a SECOND hand-back, which says it
replaces the first, and the seat's report is kept. `readThreadSeatState` is fail-soft in the other
direction — a store error reads as no record — and the caller tells the two apart.

**Every close goes through one function, and every close hands the thread back** (OPE-2428,
OPE-2430). `closeThreadSeat` (`packages/core/agent/channels/thread-seat-close.ts`) records the close,
clears the ownership row only while it names that seat itself (so closing an old seat never releases
a thread a newer seat holds), wakes the parent with a **host-written** hand-back, and — for a finished
thread only — places the done reaction. Its three callers are the three ways a thread ends:

| Reason | Caller | Done reaction |
|---|---|---|
| `completed` | the seat's own `complete_thread` | yes, on the thread's root message |
| `expired` | the idle sweep, `sweepIdleThreadSeats`, from the daily tidy pass: an open seat whose thread had no message for `THREAD_SEAT_IDLE_MS` (three days) | no |
| `closed` | the ingress reap of a thread seat that can no longer be routed to (a re-homed domain) | no |

**The hand-back is written by the host, from recorded facts.** It names the thread and its channel,
when it opened, when it was last active, when it closed and how. The seat's report, when it gave one,
rides inside it verbatim; a seat that gave none still hands the thread back, and the hand-back says
it left no report. Before OPE-2428 only the model's own `complete_thread` summary reached the parent,
so a seat that forgot, went quiet or lost its route left the parent knowing nothing.

**A finished thread shows its completion in the thread.** `complete_thread` posts nothing when the
seat already posted this turn — that post is the completion. Otherwise the host posts the seat's
report, or a fixed done line when it gave none, into the thread through the ordinary reply road. The
host then places a ✅ on the thread's **root message**, which the surface's origin codec names
(`WakeOriginCodec.threadRootMessage`) and `setSurfaceReaction` reaches. §7.1's `thread-done-reaction`
row says which surfaces can: Slack, and Linear on a reply thread. There is no channel post and no
mirror of thread traffic into the standing seat (OPE-2427).

**Spawning a seat fails closed on the delegation flag.** `canSpawnThreadFromWindow`
(`packages/core/agent/tools/spawn_thread_session.ts`) answers `false` whenever
`delegation.oneshotAgent` is disarmed, and the tool throws the same refusal. A session that carries a
continuation token must have one that parses as a **window** token; a session with no token at all is
admitted.

**A worker or a thread seat can never open another thread seat.** `isOwnTokenTaskOrThread` refuses
the call, so there are no recursive thread trees. The refusal names the two ways forward: delegate
with `agent`, or ask the channel watcher to open one.

**The child's wake id derives from the tool call id.** `deterministicChildWakeId` hashes
`oe-oneshot:<callId>`, so an in-attempt retry mints the same id and cannot deliver the brief twice.

**A spawned seat is told what it is.** `renderThreadSeatBrief` prefixes the caller's brief with the
seat's own posture: the standing seat handed it this task and this thread and no longer watches the
thread, it holds the conversational kit only, and it runs the real work through its own work session
with `work`. It is told to post the completion in the thread with `reply` and then call
`complete_thread`. Its persona says the same at length: a thread seat reads a thread opening, its own
side of the routing decision, and a "Finishing the thread" section, never the channel seat's
"standing session for this channel".

**A steer names a role, never a person.** `renderSeatSteer`
(`packages/core/agent/tools/message_thread_seat.ts`) opens with "A message from the channel seat that
opened your thread", so the steer carries no authority of its own beyond that role. It then states
**explicitly** whether the thread's people can see the message. `mirror` is a required input with no
default, so the caller decides per message.

`threadKeyArgument` (`packages/core/agent/tools/read_thread_seat.ts`) strips colons from a supplied
thread id, exactly as the spawn path strips them, so one thread always has one key.

**Only a session running on a thread-seat window token may complete a thread.**
`isOwnTokenThreadSeat` (`packages/core/agent/tools/complete_thread.ts`) gates the verb; every other
session is refused.

**The hand-back resolves the parent's live token from its registry row**, never the token recorded at
spawn time, so a parent that rotated its generation still receives it. With no parent row, or a
parent token that names no domain, the hand-back answers `false` and no wake is sent; the record
still holds the close for `read_thread_seat`. The wake carries no addressing attributes — so the
parent treats it as ambient and stays silent unless it decides otherwise. The message says so
outright: nothing is owed to the room.

## 3. The honest-absence rule

This rule governs every optional member in the contract, so read it before the verb list.

> A provider either has the primitive or it does not. It never fakes one, and it never registers a
> stub that throws.

There are exactly two shapes for "this surface cannot do that", and which one applies is decided
per verb, not per provider:

- **Absent.** The verb does not mount at all. Used where an absent verb teaches the model the truth
  — `react` on a surface with no reaction primitive, `read_channel` on a window with no sources.
- **Mounted and refusing, out loud.** The verb mounts everywhere and answers with copy that names
  the surface and steers to an alternative. Used where the model needs something to fall back
  *from* — `edit_reply` is the worked example (OPE-793): an absent verb teaches nothing, an explicit
  refusal teaches both that the surface cannot edit and that a new `reply` is the way round it.

A silent no-op is never an option. Neither is a success answer for something that did not happen.

---

## 4. The core verbs

Twelve verbs. Every chat provider is expected to reach all of them or to declare, in the shape §3
prescribes, that it cannot.

Two of the twelve are not model verbs at all: `stop` (§4.8) is the person's control and `ack` (§4.9)
is the host's own signal. §4.11 then states which of the remaining ten a **durable-job** wake holds,
which is a narrower set than any provider declares.

### 4.1 `reply` — put a message in the room

**MUST** post text into the conversation this turn arrived in, mid-turn, and return the new
message's id. A post is an action the agent takes, not the end of its turn.

**MUST NOT** take a destination from the model. The target is host-resolved from the binding (base
sessions) or from the frozen wake origin (unified single-window sessions). There is no parameter
through which the model can name a room.

**MAY REFUSE**, with a named reason the audit trail carries:

| Reason | Meaning |
|---|---|
| `stale-conversation` | newer messages arrived in the target since the wakes this turn was shown. Overridable with `force` |
| `should-be-edit` | this seat's own last post is still the newest message there — fold the new text into it with `edit_reply`. Overridable with `force` |
| `answered-this-turn` | this wake already has an answer from this same turn. Overridable with `force`, except where the surface's own terminal post CLOSED the conversation — a Linear mention reply ends its agent session, so nothing further can land and the refusal stands |
| `declined-this-turn` | this wake has a declared silence from this same turn. Not overridable |
| `delegation-pending` | a delegated worker still owes this turn its result |
| `task-wake-unread` | a task wake this turn holds has not been read |
| `mismatch` / `expired` / `answered` | the **wake fence**, on a unified single-window session only. The model named a wake id this turn does not hold, or the id aged past its TTL, or an earlier turn already answered it (`channels/unified-window.ts`) |
| `answer-delivered` | the **wake fence**, on a unified single-window session only (OPE-2335). The turn's own wake is marked answered with no turn id, so it takes no reply of its own. The unified question bridge's answer leg wrote that mark until OPE-2389 deleted it; the fence still refuses the shape. It fires only on a turn whose auth bag changed in-turn. Not overridable with `force`. Reply to the wake of the conversation that asked the question |

The last two rows are a different class from the six above them. The six judge **whether this turn
may put this text in this room**. The wake fence judges **the address the model named**, so a
provider that joins a unified window inherits it whole and implements none of it. One wake-fence
reason is also prose-blocking, like `stale-conversation`, `should-be-edit`, `answered-this-turn` and
`declined-this-turn`: `answer-delivered` withholds a dropped prose and suppresses its redrive
(`PROSE_BLOCKING_REFUSALS`), because the host refused the turn's own host-resolved wake.

**REPORTS** the created message id. Every post is written to the own-post ledger, which is the fence
that decides what `edit_reply` may later touch.

**Delivery doctrine.** `reply` is the **only** channel through which the agent's words reach a
person. Turn-final prose is not a second delivery channel: five of the six shipped surfaces declare
`closingProseDropped`, the host drops that text, and it writes a `turn.supervisor_prose_dropped` row
instead of posting it. A seat is told so by its reporting arm, whose copy states that the closing
text is discarded.

**One residual, stated rather than left to be found.** Linear's *native* mention arm still hands a
non-silent completion to the framework's own default poster, which emits the terminal text as a
visible comment. So Linear declares `supervisorProseDropped` instead, and its native seat reads the
arm that says the closing text posts — the one claim that surface can still honour. It is also the
one door `channels/stand-down-silence.ts`'s latch is still load-bearing on. Closing it needs an
inline arm of this deployment's own, which is a separate change.

### 4.2 `edit_reply` — correct one of your own posts

**MUST** rewrite the text of a message **this deployment posted**, in place, on the surface it was
posted to. Cosmetic use — a typo, a list that moved on.

**MUST NOT** be treated as a second delivery channel. An edit adds no message and notifies nobody.
Anything new to say still needs a `reply`.

**MUST** pass two fences, neither of which trusts the model: the locus is host-resolved exactly as
`reply` resolves it, and the message id is checked against the own-post ledger. A miss is refused
and audited (`not-own-post`) before any byte leaves.

**MOUNTS EVERYWHERE** and refuses where it cannot work (`no-edit-arm`) — the §3 second shape, and
the rule.

**MAY REFUSE** for a platform limit, and that refusal must name the limit. Linear's ambient reply is
a real `Comment` and is editable; its native @mention reply is an Agent Activity and Linear's API
has no mutation that updates one. That is a permanent platform limit, and the copy says so.

### 4.3 `react` — leave an emoji

**MUST** place one of the agent's own reactions, at the granularity the surface actually tracks. On
Slack and Discord that is a specific message; on GitHub and Linear it is the conversation
**anchor** (the issue or PR), because that is the only granularity those surfaces track.

**MUST** map the model's bare lowercase emoji name onto the platform's own vocabulary, and **MUST**
throw an honest, token-free error naming the surface's real options when the name has no
equivalent. Never a silent no-op.

**IS NOT TERMINAL ON AN ADDRESSED MESSAGE** (OPE-906, ruled). A message that @mentioned
or DM'd this session is owed a `reply` as well, even when the seat hands the work to a delegated
session. A react alone is the right answer only for an **unaddressed** message in a busy thread,
where a bare "got it" would add a line and nothing else.

**MOUNTS** on the manifest's `reactions` flag on a single-surface session. On a **unified**
single-window session it is always mounted and enforces a per-turn fence against this wake's origin
instead, because `session.started` saw only the opener and is the wrong layer to decide presence.

### 4.4 `no_reply` — decline to answer

**MUST** be available on every surface. It is a plain always-mounted tool, not a gated one.

**MUST** end the turn's reply obligation with a **closed reason** and an audit row. The model's own
words are always dropped.

**The vocabulary is universal; the host rendering is per-surface.** Calling it means the same thing
to the model everywhere. What the host then leaves in the room is the surface's decision. Slack,
Discord, Teams, GitHub and Notion leave nothing. Linear's native @mention route leaves one fixed
host line, because a Linear Agent Session is a UI state with no invisible close. A per-surface
caveat never enters the tool's description: the model's contract is unchanged by it.

### 4.5 `read_channel` — read this room

**MUST** read the container this wake arrived in, and no other.

**MUST NOT** expose a target parameter. This is the whole security property, and it is structural
rather than a check: a cross-container read is **not expressible**, so there is nothing for the
model to be argued into attempting. The single remaining input is `limit`.

**MUST** normalise the vendor's messages into the neutral line shape — `author`, `ts`, `text`, plus
two grading fields (`authorId`, `bot`) that stop at the adapter boundary and never reach the model.

**MUST** enforce the domain allowlist inside the adapter, fail-closed.

**REPORTS** the page wrapped as untrusted data. Channel messages are member-authored data, never
instructions. The result addresses itself by the opaque channel key, never by the raw vendor
container id.

**Discloses what it could not reach.** By default, core infers this from the line count: when the
fetch lands exactly on its page size, the result carries a coverage note — older history may exist
beyond this page. When the page busts the inline cap it is trimmed and the full render is spooled to
a file, with a note that explains the disagreement between `count` and the lines shown.

**MAY declare its own coverage fact instead of the line count** (OPE-1015). `readChannel` and
`readThread` may return `{ lines, possiblyIncomplete?, partialReason? }` in place of the bare line
array. A vendor page limit or a permission-trimmed thread the adapter can see but the returned line
count cannot — a container-shaped read (Linear's topic-then-roots, GitHub's opening-post-then-
timeline) can fetch a full vendor page and still return a SHORT list of lines, which the line-count
heuristic alone reads as complete. `possiblyIncomplete: true`/`false` overrides the heuristic either
way; `partialReason` (free text) rides into the coverage note as the adapter's own stated cause.
A provider that returns the bare array, as every provider did before this field existed, keeps the
line-count heuristic and renders unchanged.

**MAY carry a dated-read provenance** (OPE-1039, ported from the OPE-1012/1026 vendor read tools).
A line MAY set `readAt` (the moment its fact was fetched) and `live` (this line IS the container's
current state, not a message in its history — a ticket's status, say). Unlike `authorId`/`bot`,
these two DO reach the model: the render ages a non-live line against `readAt` ("27 minutes before
this read"), and when at least one line is `live`, it states the contrast once — "Read live at
`<ts>`: the first line above is the current state. Everything else is HISTORY — a message's claim
about status, approval or progress is not the present state." A provider that sets neither field
renders exactly as it did before this contract existed — the fix exists for the surfaces whose
content mixes a live field with a history stream (Linear's topic line, OPE-1038); a surface with no
such field (Slack, Discord, Teams) sets neither and is unaffected.

**MAY carry the message's files.** A line MAY set `files`: one `{ id, name, mimetype? }` per file
the message carries (`ReadFile`, `channels/channel-read.ts`). The id is the platform file id, the
same id `describe_image` resolves as `{ kind: "attachment", ref }`, so a delegated worker can find an
upload in its thread by name and read it. The id resolves only while the attachment plane holds it:
on Slack, an upload the front saw in an event in about the last 24 hours (`slack-attachments.ts`; the
durable row is pruned on a later write). An older upload is still listed, and `describe_image` can
refuse its id. Set nothing else: no download URL and no token, because a
reader that held a URL could fetch outside the attachment plane. Core drops an id that could not be
a file id, strips the frame characters from a name, caps the list at eight files, and withholds a
withheld author's files with the body. The render puts the name first:
`[files: probe.png (image/png, attachment id F0…)]`. Slack sets it today
(`slack-read.ts` `slackMessageFiles`), and a file shared with no comment is a read line too.

### 4.6 `read_thread` — read this thread

As `read_channel`, addressed to the thread root `wakeAddress` returned.

**MUST refuse** when this turn is at the top level of its container, and the refusal points at
`read_channel`. A channel read wearing a thread read's name is never an acceptable answer.

### 4.6.1 One contract, six containers

The two verbs are identical everywhere. What "the room" and "the thread" MEAN is the surface's own
answer, and each bundle states it in `wakeAddress`. Core never guesses.

| Surface | `read_channel` reads | `read_thread` reads |
|---|---|---|
| slack | the channel | the `thread_ts` root and its replies |
| discord | the channel (a thread IS a channel) | that thread channel |
| teams | the Teams channel | the `;messageid=` reply chain |
| github | the issue or PR conversation | one review thread on a PR |
| linear | the issue: its topic, then its top-level comments | one root comment and its replies |
| notion | the page's discussions, each headed by its anchor | ONE discussion |

Two of the six deserve their reason stated, because a reader who assumes Slack everywhere gets both
of them wrong.

**Linear is Slack-shaped, plus a topic.** A Linear issue is a conversation ABOUT one work item. Its
comments thread one level, so roots are channel messages and replies are thread messages, exactly as
on Slack. The issue's title, state and description are context about the room rather than a message
in it, so they open the channel read as its topic — the same place GitHub puts an issue's opening
post. The neutral render carries no topic slot, so the topic rides as the first line, attributed to
whoever filed the issue, bracketed with the issue's state when Linear reports one (OPE-1038) and
marked `live` — the dated-read provenance's current-state line (§4.5, OPE-1039). `read_thread` has
no topic line, so every line there is dated but none is `live`.

**Notion is thread-first, and it is the inverse of Slack.** A Slack message has no thread id until
somebody replies. A Notion comment carries `discussion_id` from birth, and a new top-level comment
MINTS a new discussion. So there is no bare-channel state on Notion, and sibling discussions are
unrelated — each is anchored to its own block and is about that block. Two rules follow:

- A Notion wake ALWAYS arrives thread-scoped. `bindNotion` builds its post-back target only when a
  discussion id is present, so a Notion turn either names a container AND a thread root or names
  neither. `read_thread` is the default view; `read_channel` is the deliberate wider one.
- A new top-level comment must NEVER render as a channel-style continuation of the previous one.
  Every discussion's first line in `read_channel` carries a header naming the discussion and quoting
  its anchor block, so two siblings can never read as one conversation.

Notion's page CONTENT stays off the chat plane. The page is the work object; the comment layer is
Notion's chat surface. A seat that needs the document reads it through the grant-mounted vendor verb
or delegates to a worker. Every line Notion's `read_channel`/`read_thread` return is dated (OPE-1039)
— but since the page's own state never rides these verbs, no line is ever `live`; the provenance
sentence never fires here, only the per-line age.

### 4.7 `search` — the deliberate cross-container exception

**BUILT** (OPE-929 piece 3 / OPE-961). One tool, `packages/core/agent/tools/search.ts`, federates
across whichever connectors the caller's domain holds a work grant on — Notion, Linear and GitHub
today (`packages/core/agent/channels/work-search.ts` is the registry; a fourth connector registers
by implementing `WorkSearchAdapter` and calling `registerWorkSearchAdapter`, or
`registerCoreWorkSearchAdapter` for a core-resident plane like GitHub's SCM).

**ONE verb, not per-vendor variants.** Search joins the same generic family as `reply` and `react`.
Vendor work tools are untouched and are reached through their own skills and connectors
(`notion_search` still exists as its own standalone tool; `search` wraps the same call).

**MOUNTS behind the work grant.** It is the one verb in this family that reaches outside the wake
container, which makes it an exfiltration surface. Abstraction and gating are orthogonal: one
vocabulary, two planes. The candidate connector set is the RAW grant (`searchGrantedConnectors`),
deliberately not the ticket-create-registry-filtered set `workDestinationPlatforms` reads — Notion
holds no ticket-create adapter and would otherwise never appear as a search connector.

**`scope?: string`** restricts one call to a single named connector; omitted, every granted
connector is searched and a granted connector with no registered adapter comes back as a NAMED
absence (`{ connector, reason }`), never a silent drop.

**CARRIES `insideDomain?: boolean`** (OPE-961) — a per-call convenience that narrows the QUERY sent
to a connector, never a grant restriction. What "the domain's own space" resolves to differs by
connector, and is documented on each adapter file:
- **GitHub** — a documented no-op. The work grant already IS the domain's own repo list
  (`resolveAccessFor(ctx).repos`), so every call — scoped or not — is already `repo:`-qualified to
  exactly that list. There is no wider reach to narrow away from.
- **Notion** — narrows to the pages this domain's own roster names (`reach` entries shaped
  `notion/<workspace>/<page>`), the same roster `read_notion_page`'s fence reads. A shared Notion
  integration used by several domains can then ask "just my declared pages" without touching what
  the credential itself can see.
- **Linear** — narrows to the TEAMS this domain's own roster names (`reach` entries shaped
  `linear/<org>/<team>`) — a different declaration from the work grant, which (OPE-937) names only
  the workspace. Reading the roster here is safe precisely because it can only DROP hits, never add
  a team the credential could not already reach; using the same roster to WIDEN the work grant is
  the "massive security hole" §4.6's Linear section rejects.

**MUST NOT filter results as a boundary.** The rule: search's reach **is** the
credential's reach. A post-hoc filter is not enforcement, and shipping one that looks like
enforcement is worse than shipping neither. An organisation narrows search by minting a narrower
credential. `insideDomain` does not violate this: it is opt-in, documented as a convenience, and
every adapter's UNSCOPED call still reaches everything the credential can see.

**MUST NOT return bodies.** Every hit is an id + a title (+ optional url) — the same shape
`notion_search` already used. Search widens what the agent can **find**; it does not widen what it
can **read**.

**EVERY HIT NAMES ITS READ ROAD, OR SAYS IT HAS NONE** (OPE-2178). A hit carries an optional
`readWith: { tool, args }` — the tool and the arguments that read what the hit points at — and the
render prints it under the hit as a `read with:` line. A hit with no road prints "no tool takes this
item as a target." A bare id and title read to a live model as the whole of what it could reach:
in a live run a worker cloned the repo of a GitHub issue hit and reported the body as inaccessible.
The road names a tool and opens nothing. The named tool runs its own fence when the model calls it,
and it can refuse. An unscoped search returns Notion pages and Linear issues outside the caller's
domain. `read_notion_page` refuses any page outside the caller's domain. `read_linear_issue`
refuses an issue on a team in another domain, but under the Linear work grant it admits an issue
on a team that no domain holds.
- **Linear** — `read_linear_issue` with the issue identifier.
- **Notion** — `read_notion_page` with the page id, for a PAGE hit only. A database hit has no road.
- **GitHub** — the hit that is the turn's OWN conversation names `read_work_channel`, which reads
  its opening post and newest comments. It takes no target, so it is the road for no other hit.
  Another pull request names `get_pr_feedback` with `repo` and `number`. That tool reads the
  reviews, the comments and the checks; it does NOT read the PR's opening description. Another plain
  issue names `read_github_issue` with `repo` and `number` (OPE-2305). That tool reads the opening
  post and the newest comments, and it refuses a repo outside the session's repo grant. It reads a
  PR's opening description too, but a PR hit keeps `get_pr_feedback` as its road. GitHub has no
  REST skill, and a repo grant does not open `api.github.com` in the sandbox, so this read runs
  host-side on the App installation token.

### 4.7.1 `post_message` — the deliberate cross-CONTAINER exception (tier P1)

**BUILT** (OPE-1064 tier P1). `packages/core/agent/tools/post_message.ts` posts a message into a
container this turn did NOT arrive in. It is the write-plane twin of `search`: the one verb in this
family whose effect leaves the wake container.

**THE TIER LADDER.** `access/chat-write-grant.ts` holds it in full:

| tier | act | posture |
|---|---|---|
| **P0** | post in the container this turn arrived in | open — `reply`. No grant, no target parameter |
| **P1** | post in another container **in this domain** | this verb. A named grant, plus the domain fence, plus a card, plus an audit row |
| **P2** | DM a person | §4.7.2. A named grant, a card on the FIRST message only, then deliveries flow — and the recipient's own stop |
| **P3** | post outside this domain | **no route.** The domain fence has no arm that admits it |
| **P4** | anything the bot token reaches | **unnameable.** The config vocabulary cannot express it |

**MOUNTS behind a RESOURCE GRANT**, never on chat presence. A bound bundle names containers with
ARN-like addresses (`access/resource-grant.ts`):

```ts
defineBundle({ name: "eng", resourceGrants: [{ connector: "slack", resources: ["slack:channel/C0123ABC"] }] })
```

`capabilities` is optional and defaults to `["post"]`, the one act this tier implements. Config
writes NAMES this deployment implements and can never write a raw vendor permission string — an
unknown connector, a malformed address or an unknown capability refuses at config load.

**TAKES A TARGET, which is the one relaxation.** §5's registry says `channelId` is always
host-resolved and never model-authored. This verb relaxes that sentence behind a gate: the model may
only name an address an operator already wrote, and a human reads the destination and the full body
on the card before a byte is posted.

**REFUSES with the boundary NAMED.** The two refusals are different messages because the remedies
live in different files — an ungranted container needs a bundle row, a cross-domain container needs
the domain's own `reach` roster. Both refusals write a `chat.post_refused` audit row.

**IS CONSEQUENTIAL** (`chat.post`, policy `member`). The card renders the destination and the full
text; the post happens on a human's click and writes a `chat.post` audit row naming the target
container and the grant address that allowed it.

🔴 **WHAT THE GRANT IS NOT.** It narrows no vendor token. The chat bot tokens are static and mint
nothing per call, so a delegated worker with a shell still reaches the vendor API wherever the token
permits. The grant is a **routing and honesty** control, the card is the **injection** control, and
the operator's own vendor console is the **reach** control — invite the bot only where it belongs.

**Slack, Discord and Teams are the implemented instances.** The seam is generic; the closed table in
`access/resource-grant.ts` names which connectors it admits, and a connector is added in the diff
that drives its transport.

🔴 **An address id is the id in its SURFACE-KEY SPELLING, not the vendor's string.** The container
fence admits an address only when the id is in the caller's domain roster, and a roster id is a
surface-key segment — which `identity/binding.ts` pushes through `[^a-zA-Z0-9._-]`. For Slack and
Discord the spelling *is* the raw id, so the rule was invisible until Teams. A Teams conversation
`19:x@thread.tacv2` is spelled `19-x-thread.tacv2` — in its surface key, in its memory partition, in
its `memory/config/domains/<name>.ts` reach entry, in its audit rows, and so in a grant address too.

🔴 **The fence reads the caller's CONTAINER grain, not its surface key.** A domain roster lists
containers, and two surfaces name something finer than the container in their surface key: a Teams
channel activity binds `surface` to the per-reply-chain conversation id
(`19:x@thread.tacv2;messageid=<root>`), and a Discord thread binds its own thread id. Both carry the
container in `domainSurface`, which `memory/partition.ts` exposes as `domainKey`. The container fence
and the tier-P2 platform check both read that key (`access/chat-write-grant.ts`,
`access/chat-dm-grant.ts`). Reading the raw surface key instead looked up a key no roster lists, so
the roster collapsed to the caller's own reply chain and every granted container was skipped — on
Teams that made `post_message` mount nowhere at all (OPE-1106). Slack, and a Discord channel,
resolve no `domainKey`, so the two grains coincide there.

The Bot Framework accepts only the raw id, so the Teams provider keeps a **spelling-to-raw index**
written off real inbound activities and restores at the transport edge
(`providers/teams/agent/channels/teams-id-restore.ts`). It does **not** rebuild the raw id by
grammar: that would be a guess about a vendor id shape, and a shape this tree has not seen would
rebuild into an id addressing a different conversation or none. An unknown spelling comes back
unchanged and the transport's own refusal fires.

A surface whose ids do not survive the spelling and which registers no such seam must stay out of the
table. A row without one is the mounted-but-impossible class — config an operator reads as a working
grant that can never work.

### 4.7.2 `dm_person` — the deliberate cross-AUDIENCE exception (tier P2)

**BUILT** (OPE-1064 tier P2). `packages/core/agent/tools/dm_person.ts` sends a direct message to a
person an operator granted. It is the first chat write whose audience is one named human rather than
a room, and it is deliberately NOT symmetric with §4.7.1.

**THE RULING THAT SHAPES IT** (OPE-893):

> "personally i'd ask for forgiveness, not permission. so let it work but give the user a way to make
> it stop."

So the consent gate sits at the **operator's** grant, not at the recipient — and the recipient's
protection is a stop that really works, not a prompt they must answer before the first useful
message.

**FOUR CONTROLS, EACH ANSWERING A DIFFERENT PARTY:**

| # | control | whose decision |
|---|---|---|
| 1 | the named `slack:person/<id>` grant in a bound bundle | the **operator**: does this deployment DM people at all |
| 2 | the approval card on the **FIRST** message to a person | a **human reviewer**: the injection gate before a correspondence starts |
| 3 | the recipient's **stop** (`set_dm_delivery`) | the **person**: it outranks every live grant |
| 4 | an audit row per delivery, naming the person and the grant | the **reviewer, afterwards** |

**MOUNTS behind a RESOURCE GRANT**, never on chat presence, in the same grammar §4.7.1 uses with a
`person` type:

```ts
defineBundle({ name: "eng", resourceGrants: [{ connector: "slack", resources: ["slack:person/U0123ABC"] }] })
```

`capabilities` is optional and defaults to `["dm"]` for a person row (and stays `["post"]` for a
channel row). **One row names one resource type**: a row that mixes a channel and a person refuses at
config load, because a row's capabilities apply to every address in it and each capability acts on
exactly one type. There are no wildcards — a grant names people one at a time.

**THE SAME-DOMAIN RULE, STATED PRECISELY.** The caller's own memory domain must declare at least one
container on the person's connector. That is the same-domain rule at the grain a domain can actually
express, and it is narrower than it may sound: a domain rosters CONTAINERS, not people, so no check
can say a person "belongs to" a domain. What it proves is that **this domain works on this surface at
all** — a domain that rosters no Slack container cannot DM a Slack person, however a bundle is bound.
Between two domains that both work on Slack, the fence that separates them is the grant, because a
bundle binds at a scope.

**TWO PATHS, AND THE SPLIT IS THE RULING:**

- **the FIRST message to a person** is consequential (`chat.dm`, policy `member`). The card renders
  the recipient, the full text and the host footer, and says plainly that approving also opens the
  flowing path. Nothing is sent until a human confirms.
- **every later message** flows. The verb sends and writes its own `chat.dm` audit row with
  `first: false`.

🔴 **WHAT THAT COSTS, STATED PLAINLY.** After the first message, model-authored bytes reach a human
with no reviewer between. That is the ruling, not an oversight. Never describe tier P2 as "carded"
without the word **first**.

**EVERY DELIVERY CARRIES A HOST-AUTHORED FOOTER.** The model authors none of it. It names who asked,
which room the ask came from, and how to stop it — a person who did not ask for the message can end
it from the message itself. It names them in words, never as ids: a mention or a display name for the
person, a channel mention or plain words for the room (`channels/friendly-ids.ts`, OPE-2462). The one
DM with no footer is a DM to the person who asked, in the conversation they asked from.

**THE RECIPIENT'S STOP is a first-class verb**, `set_dm_delivery`
(`packages/core/agent/tools/set_dm_delivery.ts`). It mounts in a one-to-one DM and nowhere else, and
it is INFERENCE, not a button and not a pattern match: only one surface renders DM buttons and routes
the tap back, and a phrase match over "stop DMing me" produces false positives at about the rate it
produces true ones. The same verb resumes, because a stop with no lift is a trap.

🔴 **NO CONFIG LIFTS A STOP.** Removing the grant and adding it back writes the same address, so the
row is still found and the person is still stopped. Only the person who set it lifts it, in their own
DM. That property is what makes the flowing path defensible.

🔴 **THE STOP IS SCOPED TO THE DM ROAD, NOT TO ONE VERB.** Several planes start a direct message with
a person, and the stop is read in exactly one place they all pass through: `deliverProactiveDm`
(`packages/core/agent/channels/dm-audience.ts`). That function reads the stop, appends the footer,
records the delivery and writes the audit row, so a plane cannot obey one of the four and skip the
rest. It is read at the SEND, which is why a stop set after an approval card was proposed still
refuses the message that card was about.

Every plane that starts a DM is declared in `packages/core/agent/channels/proactive-dm-manifest.ts`,
with the stop's standing on it and, where the stop does not reach it, the reason. Today the stop
reaches the chat DM, the credential-grant card, the grant's first-use notice and the grant's connect
link. **Three planes are declared exempt, and a stopped person can still receive all three:** the
alert that their own linked identity changed, the link-handshake challenge — which a stranger who
names their account can make arrive, repeatedly — and a governance pane they asked for themselves.
Whether the stop should reach any of them is an open ruling, written down rather than left as a gap
nobody can see. `npm run test:proactive-dm-road` refuses a post-arm DM call in any module that is
neither the road itself nor an exempt row's module, the planes already on the road included: a plane
on the road opening a second one beside it is how this defect was born.

Each row also says whether its plane's text is the model's (`generated`, OPE-2542). The road copies
that fact onto the arm's `DirectMessageRequest`, so a caller on the road cannot set it alone. Only
the road reads it, so an exempt plane may not set it: the lint refuses `generated` on an exempt row. Today two planes
carry model text: the chat DM and the ping a blocked job sends its person. An arm whose surface has a
native "AI generated" mark applies it on the flag (Teams); every other arm ignores it.

🔴 **A STOP REFUSES A MESSAGE. IT DOES NOT ANSWER OR END A GRANT.** A credential-grant ask raised
against a stopped owner is refused and closed, and the requester is told that this deployment cannot
send that person a direct message. It is told nothing about the stop: the requester is a third party,
and a boundary the owner drew in their own DM must not be readable from somebody else's room. The
`dm.refused` and `grant.refused` audit rows carry which boundary it was, for an operator. A live
grant that the owner already approved keeps working — a stop suppresses the first-use notice, and
never the call.

**IT IS NOT `stand_down`.** That verb marks a thread-engagement row and refuses in a DM on purpose
(OPE-665): no DM wake gate reads that marker and no @mention could ever clear it. Neither half is
true of this stop — the delivery path reads it on every send, and the person's own messages still
wake the seat and are still answered, so the conversation never goes dead. The two markers are
disjoint and `stand_down` still refuses in a DM.

**REFUSES with the boundary NAMED.** Five boundaries, five messages, because the remedies differ: a
malformed address (the model's typo), an ungranted person (a bundle row), a cross-domain person (the
domain's own `reach` roster), a **stopped** person (no operator remedy at all) and an **unreadable**
stop (the store could not answer). `unreadable` is deliberately never folded into `stopped`:
reporting an outage as a person's decision states a fact about them that nobody established. All
five write a `dm.refused` audit row. A caller with no grant is refused `ungranted` whether or not that person ever
stopped anything, so a stop can never be probed by a scope that could not reach them anyway.

🔴 **WHAT THE GRANT IS NOT.** The same sentence §4.7.1 carries. It narrows no vendor token — Slack's
`im:write` is what makes a DM possible at all, and that is the operator's to set. The grant is a
**routing and honesty** control, the first card is the **injection** control, and the vendor console
is the **reach** control.

**Slack, Discord and Teams are the implemented instances.** Slack and Discord cold-address a person
from a bare member id under the bot token, and both ids survive the surface-key sanitiser unchanged.

🔴 **A Teams person is addressed by the spelling of their `29:` id, and `personAddress` is what makes
the stop work.** The address grammar still refuses a second colon — widening it would collide with
the trust plane's `<marker>:<id>` group rung, which `memory/domain.ts` refuses by name for that
reason — so the one spelling both halves of tier P2 quote is the surface-key one.
`channels/dm-audience.ts`'s `personAddress` composes it from a raw id, which is what makes the
operator's grant and the **recipient's own stop** land on identical bytes: `set_dm_delivery` starts
from the raw id on the recipient's live binding. A stop keyed on a string no grant can name is a stop
that does not work.

Teams also cannot cold-address a person from an id alone (**OPE-887**): the arm needs a Bot Framework
conversation reference or a single known tenant, and it refuses out loud when it holds neither.
GitHub, Linear and Notion have no DM primitive at all and report honest absence.

### 4.8 `stop` — the human's cancel

Not a model verb. It is the affordance a **person** uses when they watch the agent do the wrong
thing, and every surface owes one.

**MUST run at the ingress**, before any session is minted and before any model call. Two properties
follow, and both are the reason it cannot be an inference decision:

1. It never queues behind the turn it stops.
2. It costs nothing, so it keeps working for exactly the person most likely to need it — whose
   scope is already over its spend cap.

**MUST funnel into the one shared cancel path.** A provider parses its own event, checks who acted,
and hands over the keys. It never adds a second cancel implementation.

**MUST fail closed on the actor check.** The agent's own reactions ride the same webhook. A
fail-open identity check is a self-cancel: the app's own reaction would cancel a live turn. A stop
needs a positively resolved app identity and an actor who is not it.

**The trigger is the surface's choice, and the honest one wins.** Slack, Discord and Linear use a ✋
reaction. Teams has six fixed reaction values and no ✋ at all, so it uses `angry` — the one of the
six that people already use to mean "this is wrong". GitHub sends no webhook for a reaction at all,
so its trigger is a comment whose **entire** body is the word `stop`. That is not a magic string: a
magic string is a hidden second grammar competing with what a person would say to the agent, and
this matches one thing only. "please stop" and "stop, wrong repo" are messages for the agent to
read.

**COPY DISCIPLINE.** "Stood down", never "stopped" and never "undone". A cancel rolls the model's
history back to the last completed step, but the side effects of tool calls inside the aborted step
already happened and are irreversible. A running sandbox command cannot be killed at all. Promising
more is the one way this feature can actively mislead.

### 4.9 `ack` — the host's own signals

Three host-placed acknowledgements ride the same registry, and none of them is model-driven:

- **The ✋ stop glyph.** A job that a seat forwards to its work session gets a ✋ on the message that
  asked for it, from the job's start to its settlement (`hooks/work-status.ts`). A turn that calls a
  declared subagent gets a ✋ on its anchor message, removed on completion, failure or cancel
  (`hooks/turn-anchor.ts`). The trigger is work that runs, not "the turn started". Ambient
  deliberation and quick replies get no glyph — which is the no-surveillance rule for free.
- **The cancel acknowledgement.** After a cancel lands, the host posts one note into the room saying
  what had already run. It is a plain post through the same ancillary-ops registry.
- **A working-status reaction.** Slack alone carries a 👀-class status glyph, driven by the channel
  and never by the model.

All three are **best effort**. They sit beside work that is already happening, so a missing scope
must degrade to "no glyph on this turn" and never fail the turn.

### 4.10 `stand_down` — stop following this conversation

**MUST** end the agent's ambient following of the conversation this turn arrived in. It is the
model's answer to "will you stop replying to everything", and it is **inference**, not a pattern
match. `channels/engagement.ts` records the regex that used to do this job and why it is not coming
back: the phrasing is unbounded, so a pattern produces false positives at about the rate it produces
true ones.

**IS NOT `stop` (§4.8).** `stop` is the person's affordance and it cancels the RUNNING turn at the
ingress. `stand_down` is a model verb and it suppresses LATER wakes. The two markers are disjoint.

**MUST NOT mark a 1:1 direct message.** A 1:1 has no @mention, so its marker could never be cleared.
The verb refuses in a `dm` conversation on mode alone and tells the model to say it could not stop.
A GROUP conversation (`mpim`) refuses **unless the surface published an engagement anchor** — a Teams
group chat can be @mentioned and its wake gate reads the row, so it stands down; a Slack mpim and a
Discord group DM still refuse. Their refusal has its **own sentence**, because the 1:1 reason is false
about them: a group DM can be @mentioned, so what it lacks is not a way back but a wake gate that
consults the registry at all. See §7.6.

**MARKS THE ENGAGEMENT-REGISTRY KEY, never the reply anchor** (OPE-661). It reads the platform's own
key first (`binding.engagementKey` — Discord's channel id, Teams' conversation id) and falls back to
the Slack shape (`binding.threadTs`). A mark on the wrong key suppresses nothing, because the wake
gate reads a different row back.

**A re-invitation is the only way back in.** An @mention clears the flag. There is no TTL.

**REPLAYING AN @MENTION IS NOT A RE-INVITATION** (OPE-1527). A platform that redelivers an activity
replays the invitation it carried, and that used to lift a stand-down nobody asked to lift. A
provider passes the platform's own event id as `markThreadEngaged({ engagedBy })`, and the store
refuses to clear `stopped` for any id its list still holds. A dedupe cannot do this job: every dedupe
expires and a stand-down does not, so a redelivery after the window sails through. A second, genuine
@mention carries a different id and still brings the agent back.

The row keeps a **bounded list** of its recent promoters, not one id (OPE-1562), so a mention a
LATER mention has since superseded is guarded like the latest one: mention A, mention B, a
stand-down, then a redelivery of A leaves the flag set. State the guard at the reach of that list
and no wider — the bound is the residual. A replay of a mention that `PROMOTER_LIST_MAX` distinct
later promotions have pushed off the list clears the flag again. The bound is deliberate: an
unbounded list on a hot row is its own defect.

**A ROOM-GRAIN WAKE GETS A ROOM-GRAIN STOP** (OPE-1511). Some surfaces wake on a room rather than on
a conversation — Teams' single-window Leg A wakes on any message in a vouched channel, including a
reply chain no @mention ever engaged. The conversation grain holds no row there, so the verb refused
on a wake the person in the room could plainly see, and the only off switch was an operator
un-vouching the surface. The rule is that **a stored stop exists exactly where a stored wake
exists**: such a leg stores a room-grain row on each ambient wake (`roomEngagementAddress`), its own
gate reads that row's flag, and the verb marks it when the conversation grain held nothing. A mapper
opts in by publishing `binding.roomEngagementKey`, and only where a room row is actually stored — a
key with no row behind it would make the verb report a stop that suppressed nothing. An @mention
clears the room flag as well as the conversation's, or the stop would be a trap. Slack and Discord
publish no room key, so their grain is unchanged.

**REFUSES OUT LOUD WHEN THIS TURN CARRIES NO ANCHOR.** Slack sets `threadTs`; every other surface
sets `engagementKey` — Discord the channel id, Teams the conversation id, GitHub `owner/repo#N`,
Linear the issue id, Notion `<workspace>/<page>`. A turn that carries neither makes the verb throw
before it marks anything, and its copy tells the model to report that it could NOT stop following.
That is the §3 shape, and it is the right answer.

**REFUSES OUT LOUD WITH AN ANCHOR BUT NO ROW, TOO.** `markStopped` sets the flag on an **existing**
engagement row and answers false when no row exists; it never inserts one, and only an address or an
earned reply ever does. So on every surface a conversation the registry never enrolled takes the mark
and keeps nothing. The verb reads that answer and throws, in the same shape as the refusal above, and
its copy points at the remedy: addressing the agent enrols the conversation, so a second ask lands on
a row the verb can mark. The audit row is still written first, stamped `marked: false`, because a
refused attempt belongs in the trail. See §7.6.

### 4.11 What an UNATTENDED wake holds

A durable job fire with no human present is narrowed at the model-call seam to one allow-list
(`JOB_WAKE_TOOLS` in `access/window-gate-manifest.ts`, applied by `access/job-posture.ts`). The
posture is `restricted` or `unrestricted`, and the **fire stamp is read first**: a stamped job fire
is narrowed unconditionally, because a human signal on a scheduler-built delivery is a bug or a
forge. A positively present principal escalates only a job SESSION's later, unstamped wake.
The list never grants — it only removes — so a provider's own declarations are unchanged.
The decision is per **wake**, because a durable-job session is resumed and its mount-time decision
freezes at the first fire.

Measured against the ten MODEL verbs of §4 (`stop` and `ack` are excluded — neither is a tool the
model calls), plus `set_dm_delivery` and `post_file`, which the job kit also rules on:

| verb | an un-escalated durable-job wake |
|---|---|
| `reply`, `edit_reply`, `react`, `no_reply`, `read_channel`, `read_thread` | **held** |
| `search`, `post_message`, `dm_person`, `set_dm_delivery`, `post_file`, `stand_down` | **withheld** |

Most of the withheld column reaches OUTSIDE the wake container — the exceptions of §4.7, §4.7.1 and
§4.7.2, and the file transport — and an unattended wake has nobody to approve that. Two rows do not
fit that reading and are withheld for their own reasons: `set_dm_delivery` mounts only inside a 1:1
DM, and `stand_down` is a same-room act the manifest classes as bookkeeping a job does not do. So
read the column as the kit's own enumeration, not as one rule.

🔴 **THIS NARROWING IS NOT A GENERAL "UNATTENDED" CONTROL, AND MUST NOT BE QUOTED AS ONE.** It fires
only on a **stamped durable-job fire**, or on a session already known to run jobs. An ordinary
scheduled routine fire carries no job stamp, so `resolveJobWakePosture` returns `unrestricted` and
the full mount set applies — unattended though that fire is. A verb like `dm_person` is therefore
reachable from a plain routine in a domain that holds the grant. §10 item 3's proactive-DM question
is a real design question for that reason, not a settled one.

---

### 4.12 The reply choke point — target, de-duplication and what lands

`resolveReplyTarget` (`packages/core/agent/channels/reply-post.ts`) resolves the post target from the
session binding alone. The model names no target. It answers `null` when the platform's capability
manifest declares no `midTurnPost`, and again when the platform registers no post arm or no target
resolver. The per-surface `reply` tool is then hidden on that surface rather than offered and refused.

**A post is de-duplicated by an idempotency claim, and the claim is released only on a definitive
failure.** `releasePostKeyOnFailure` releases the claim when the platform's failure class is
`definitive`. An **ambiguous** failure keeps the claim, so an identical retry cannot double-post a
message that may already be in the room. When a byte-identical repost is suppressed, the path returns
the sentinel `deduped:reply` (`REPLY_DEDUPE_SKIPPED_ID`) instead of a platform message id, so a caller
can never mistake a suppressed post for a landed one.

**The per-surface `reply` posts only into the conversation that woke the turn**, and the tool's own
description says so. It records the landed post with no wake id, because that variant holds no
wake-authority fence and no `wake` input. The unified variant is the one that carries a wake. Both
variants are pre-registered under one dispatcher, so a replayed turn runs the exact variant the
session mounted rather than whichever resolver last won the shared slot.

**Two transforms run on the model's own text at every reply and edit choke point.**
`truncateMemoryCitationPaths` (`packages/core/agent/channels/turn-delivery.ts`) rewrites every memory
citation — markdown link, Slack link or bare reference — to its bare silo-relative path, rendered as
plain text. The mount path is real only inside that turn's sandbox, so a member would otherwise see an
unresolvable link. `applyReplyProvenance` (`reply-provenance.ts`) then strikes any model-forged
Sources-read line out of the body. Since OPE-2487 it appends nothing: the sources line goes on the
reply's `reply.provenance` row (`detail.sources`), and the room reads the model's text alone.

**An answer hands the arm two extras on its `PostIntent` (OPE-2520).** `dispatchReply`,
`dispatchUnified` and `editMessage` take an optional `intent`. On a model's answer the choke point sets
`feedback: true` (never on a host notice, and never on a `done: false` part), and `sources` holds the
numbered source links the reply may show. The choke point decides the links, not the arm: they go out
only when the arm's `isDirectConversation(locus)` says the reply lands in a 1:1 conversation with one
person, and only for reads the reach rule names for this reply. An arm without that member never gets
a link — the fail-closed default. An arm draws both natively where its platform can (Slack: a
`context` line and `feedback_buttons`; Teams: citations and the feedback loop) and ignores them where
it cannot. The front route that receives a native thumbs click writes it through core's
`recordReplyFeedback` (`channels/reply-feedback.ts`), which files one `reply.feedback` row. The
friendly-names guard (§4.12.1) renders each link's name, as it renders the text.

**An answer can also hand the arm suggested follow-ups (OPE-2516).** `PostIntent.followUps` holds up
to three short next steps the model passed as `reply`'s or `edit_reply`'s `followUps` input. The choke
point decides them on the same rule as the links: only a model's terminal answer, only where
`isDirectConversation(locus)` proves a 1:1 conversation, and only after `normalizeFollowUps`
(`reply-follow-ups.ts`) kept at most three one-line items of at most 75 characters. An item that is too
long, or that holds a control or format character, is dropped, never cut, so a button never sends
words it does not show. The friendly-names guard
renders each item as plain text, so the label and the sent text stay one string. An arm draws them
where its platform has a press-to-send shape (Slack: an `actions` row whose press the front route
turns into the person's next DM message; Teams: `suggestedActions` with `imBack`) and ignores them
where it has none.

**While a dispatched worker still owes an answer, all four reply and edit doors append one shared
sentence** (`PENDING_WORK_INSTRUCTION`, `turn-delivery.ts`). It tells the seat that the worker has not
reported, that it must not write the answer itself, and that nothing is added to its message on the
way out — so its own words are the only thing that tells the room where the work stands. One sentence
on all four doors, so a seat cannot read a difference that is not there.

### 4.12.1 Friendly names — the outbound guard on every surface

🔴 **A person never reads a raw platform id, a scope key or an internal run id** (OPE-2482). A
member id (`U…`), a channel, server or Discord id, a Teams id, a scope or principal key
(`slack/T…/C…`), a session id (`wrun_…`), a meeting id (`mtg_…`) and an echoed `wake-id` are join
keys. In a reply, a card, a notice or a DM, a person reads a display name, a place reads as a
`#name`, the platform channel mention or plain words, and anything else reads as plain words. Audit
rows, store rows, logs and model-facing tool results keep the exact id.

**The guard is structural, in two layers, and rendering is idempotent:**

1. **The core registries.** `registerPostArm` (`channels/post-arms.ts`), `registerSurfaceMessageOps`
   (`channels/surface-message-ops.ts`) and `registerEmailTransport` (`email/transport.ts`) store every
   arm wrapped (`channels/friendly-outbound.ts`). Every reply, edit, DM, notice, file caption and mail
   from any provider, a future one included, is rendered before the arm sees it.
2. **Each provider's one write seam.** Slack `callSlackWebApi` (the `chat.*` message methods: `text`,
   every Block Kit text object, legacy attachments), Discord `discordFetch` (message create and edit,
   webhook and interaction follow-ups, JSON and multipart) and the interaction answer
   (`discord-front.ts`), Teams `teamsConnectorWrite` (activity text and Adaptive Card text), GitHub
   `githubWrite` (a comment body), Linear's GraphQL transport (`commentCreate`, `commentUpdate`,
   `agentActivityCreate` bodies), Notion's `notionFetch` (comment rich text) and Google Chat's
   `createGoogleChatMessage` (message text) run the payload guard.
   That layer catches the cards and notices that post outside the registries.

**What the guard leaves alone:** a platform mention, a URL, a fenced code block and an inline code
span (a literal a rewrite would corrupt) — except an inline span that holds ONE id and nothing else,
which is a quoted id and renders — a key-shaped run inside a path (`packages/providers/github/…`,
`/api/oauth/callback`), and every routing field: a Slack button `value` or `action_id`, a Discord
`custom_id`, an Adaptive Card action's `data`, a request's channel or issue address. Two shapes are
ambiguous with everyday text, so they render only when they are certainly ids: a bare 17-to-20-digit
number renders only on Discord or when a resolver named it, and a bare GUID only when a resolver named
it. Slack app (`B…`) and org (`E…`) ids are not matched: they collide with product codes.

**No new pings.** A person the guard finds as a bare id renders as their resolved name, else as plain
words ("someone on Slack"). It never becomes a live `<@…>` mention: a raw id pinged nobody, and its
rendering must not either. Host copy that means to tag a person writes the mention itself
(`personWords`). A channel renders as the platform's own channel mention on Slack and Discord, which
shows the name and pings nobody. A resolved name is escaped for the target, so a self-set name
cannot broadcast or ping (`<!here>`, `@everyone`); on Discord it cannot format either, while on Slack
and Teams it may still carry emphasis (`*bold*`). A mention passes as written only on its own
platform: a Slack `<@U…>` posted to Discord, Teams or a plain-text field renders as the person it names.

**No exceptions, and accounts are named the way a reader can check.** No escape hatch keeps an id in
the visible text. Where an id used to carry an anti-spoof job — the identity-link consent ask and the
"your identity grew" notice — each account renders as its display name LINKED to the account's own
profile page, with a platform-verified email or the handle the platform keeps unique beside it
(`accountLinkLabel`, `identity/account-display-name.ts`).
Every identity notice passes the READING surface, so the link uses that surface's syntax; a `slack://`
deep link renders only on Slack, and elsewhere the name shows without it. Where there is no profile
URL and no verifier, the self-set name stands alone, and the consent ask says so plainly instead of
claiming a check the reader cannot make. 🔴 **A Slack email appears only where the workspace granted
`users:read.email`, and the shipped Slack manifest does not request that scope**, so on Slack today the
reader gets the linked name and the self-set handle, not an address.
The id travels only inside the link: Discord `https://discord.com/users/<id>`; Slack's documented
user deep link `slack://user?team=<team>&id=<user>` (Slack documents no web profile URL); a GitHub
login's page; the Teams chat deep link keyed by the user principal name. Linear, Notion and email
have no profile URL this deployment can build, so the name stays plain there. The link renders in the
reading surface's own syntax (Slack `<url|name>`, Markdown elsewhere). With no name, the account reads
as plain words for its platform ("a Discord account"). `scripts/friendly-names-test.ts` pins that no
source keeps an id visible on purpose.

**Names, one table both ways.** Each provider registers a name resolver
(`registerFriendlyNameResolver`): Slack (a member, a channel as `#name`, the workspace), Discord (a
snowflake, by asking channel, then server, then person), Teams (a person through the team roster's
member read, a channel through the team's channel list). The guard resolves at most 12 ids per text
within 1.5 seconds; a resolver that fails, throws or hangs costs only the name, never the post. A
Discord interaction answer renders with no lookup at all, because Discord drops an answer that misses
its three-second window. Found names go into one process-local cache (30 minutes, at most 2000
entries) that both directions read.

**The model's lookup: `look_up`.** The model needs to know what an id means and which id a name means,
on demand, not from a list materialised into every prompt. `look_up` (`tools/look_up.ts`) is on the
seat and on every worker. Given `ids`, it names each one through the same resolvers and cache. Given a
`name`, it searches the platform's account directory for a person (sanitized, capped at 8, scoped to
the conversation's own workspace) and, for a place or a server, ONLY the rooms the conversation's
domain DECLARES plus its own room and workspace, which it pre-warms first. The shared cache holds names
resolved for every domain in the process, so a search over all of it would hand one domain another's
private room names; the scope is what keeps that out. Every name it returns is fenced as untrusted, and
a `mention` comes back only for an account on the conversation's own platform.

**Names beside ids for the model.** A channel or thread read whose author is a bare platform id shows
`Name (id)` (`channels/channel-read.ts`); a display name that holds an id-shaped string or the frame's
own punctuation is dropped. `list_routines` carries `createdByName`, `addedByName` and `roomName`
beside the ids, `confirm_link` names each linked account beside its key, and the spend and connector
proposal notes name the place beside its key. When the model echoes `Name (id)`, the guard drops the
parenthetical. The agent's instructions tell it to name people and places and never write an id.

**What is not covered, stated plainly.** A Slack post that rides eve's own session client
(`ctx.thread.postEphemeral`, eve's typing and upload machinery) does not reach `callSlackWebApi`. A
Discord thread's `name` (the thread title the agent opens) is not rendered. A Notion page or a Linear
issue the agent writes is content, not a message, and is not rendered. Google Chat has no name
resolver yet, so a Google Chat id renders as plain words.

Proof: `npm run test:friendly-names` drives a fixture with every id class through both layers on
every shipped platform and checks the bytes on the wire, with negative controls for paths, code,
numbers and product codes; `test:friendly-ids` sweeps host copy; `lint:friendly-ids` refuses a new
raw-key interpolation in prose.

### 4.13 Editing a post — locus, ownership and the six-hour window

`replyEditLocus` (`reply-post.ts`) maps a reply target onto the address an edit needs. It answers
`null` for a **Linear mention target** (one carrying an `agentSessionId`) and for a **Notion target
with no workspace id**, so posts made through those two routes are permanently uneditable. The switch
is closed while the post-arm registry is open, so a new surface takes two edits — an `editMessage`
member on its arm, and a case here — and registering only the arm leaves the verb refused rather than
broken.

`resolveUnifiedEditLocus` (`unified-reply.ts`) applies the post arm's own `retargetEditLocus` before
the ownership fence runs, and **degrades to the base locus on any failure**: a throwing arm and an arm
that answers nothing both leave the base locus in place.

`editPostedMessage` (`reply-edit.ts`) checks in a fixed order: the platform must register an
`editMessage` arm, then the message must pass the own-post ledger. Each refusal writes its own audit
row and throws a refusal marked not-applied. **Every outcome leaves exactly one audit row.**

**The own-post ledger keeps a message editable for six hours** (`OWN_POST_TTL_MS`,
`own-post-ledger.ts`); after that every edit is refused. `isOwnPost` **fails closed** on a missing org,
a blank message id, a missing channel id, or a store error — every unknown becomes a refusal.

`editOrReportAmbiguous` (`packages/core/agent/tools/edit_reply.ts`) **rethrows a definitive edit
failure** so the model sees it, and returns `edited: false` with an explanatory note on an
**ambiguous** one, ending the turn rather than claiming an edit it cannot confirm.

**When the agent's own last message is still the newest in the conversation**, the reply path refuses
and steers to an edit. `foldIntoEditRefusalMessage` (`reply-fold.ts`) names both the `wake` and the
`message_id` the model must pass, and warns that an edit **replaces the message outright** — so the
model must write the full message, not only the new part.

### 4.14 Staleness, the stand-down debt, and the terminal post

**A reply into a conversation that has moved on is refused once.** `replyFreshness`
(`reply-freshness.ts`) anchors on the later of the echoed wake's stamp and the turn's own wake stamp,
then counts pending inbound wakes registered after that anchor **in the same conversation**. A row is
counted only when it parses as a known origin and names this conversation; an unreadable origin never
counts. With no window token, or with no stamp on either wake, or on a store error, the gate is simply
off and the answer lands. The unified window has no question road (OPE-2389), so every inbound
wake there reaches the seat and is counted.

It loads at most **20** newer wakes (`MAX_NEWER_WAKES`); past that cap the refusal reports the count as
"at least". `markStaleRefusedThisTurn` records the refusal per turn per wake, capped at **32** wakes,
so the gate refuses a given wake at most once and the model can then re-send. Past the cap the gate
stops recording and keeps refusing, rather than going quiet.

**The durable stopped flag is re-read on every post.** `standDownState`
(`packages/core/agent/tools/reply.ts`) reads the flag per call rather than once at wake time, so a
stand-down stored mid-turn reaches the turn already running. It allows **exactly one** post after the
stop — the acknowledgement — by consulting both a per-turn mark and a durable per-(session, turn) row,
and it **fails open in every unknown direction**: a clear flag, a post that does not name the bound
conversation, and any thrown error all answer "not stopped".

**The acknowledgement is a debt the turn owes.** `standDownAckOwedThisTurn` (`reply-signal.ts`) holds
the debt until either the stopped valve is spent or a post lands **after** the stand-down snapshot —
it compares this turn's post count against the count taken when `stand_down` was called, so an earlier
post in the same turn cannot discharge it. A `no_reply` called while the debt stands is refused, and
that refusal writes an ungated `reply.no_reply_after_stand_down` row
(`NO_REPLY_AFTER_STAND_DOWN_ACTION`) every time, so a lost acknowledgement is countable apart from a
merely repeated silence.

**Once a post lands into a stopped conversation the turn latches silent.**
`markStandDownSilenceThisTurn` (`stand-down-silence.ts`) sets the latch so trailing model prose never
follows the acknowledgement into the room. It degrades to "not latched" with no session context. The
latch now guards one door only — Linear's native arm, whose non-silent verdict still hands the
closing text to the framework's default poster. Every other seat drops that text structurally, so
there is nothing there for the latch to stop.

**`stand_down` refuses in a 1:1 DM** (`DM_REFUSAL`, `packages/core/agent/tools/stand_down.ts`),
because no DM wake gate ever reads the stopped marker — the mark would be a write nobody reads — and a
DM has no `@mention` to bring the agent back. A group conversation gets its own refusal copy with its
own narrower reason, because a group chat **can** be mentioned. `standDownAckRoute` then renders the
acknowledgement route for this seat's own stamped delivery arm, and defaults to the dual-mode sentence
when the arm is unstamped or unrecognised.

**A Linear mention origin keeps a hard wall.** `terminalPostClosesConversation` (`unified-reply.ts`)
answers true for a non-ambient Linear origin, because a response activity there ends the agent session
— so a second post is impossible rather than merely unwanted, and the reply tool throws the
no-valve refusal.

`completeUnifiedSessionSilently` closes an open agent session on a silent turn using a **fixed
host acknowledgement, never model prose**. It answers `false` for an ambient origin and for a platform
whose arm registers no silent close.

`recordContainerAnswered` (`answered-container-ledger.ts`) **forgets the container stamp and then
re-marks it**, so the stamp always carries a current answer time. The silent-close gate reads that
time and asks whether an answer landed at or after this wake's own registration. Both writes are
best-effort.

### 4.15 How a turn ends

**A successful `reply` or `no_reply` ends the turn natively.** Both set eve's `endsTurn: true`
(OPE-2252). When every call in a model step is one of them and every call succeeded, eve ends the turn
with **no further model call** and no final message. A refused call throws, so eve reads it as a
failed call and the turn continues: a refusal never closes the obligation it names. eve ignores
`endsTurn` in a delegated session, so a worker always returns a result to its caller. If a worker the
seat started is still working, the turn waits for it (`turn.waiting`) and the model is called again
with its `task.result`.

`reply` takes `true`, not a function of its output, because it is a **dynamic** tool and eve 0.70
refuses an `endsTurn` function on a dynamic tool. So a hand-off note (`done: false`) ends the turn too.

**A turn that ends on `endsTurn` emits no final message.** eve emits `message.completed` only for
streamed text, so the unified seat decides such a turn at `turn.completed` instead
(`onUnifiedTurnCompleted`, `channels/unified.ts`). It runs the same decision with an empty `stop`
message, once per turn: it consumes the `no_reply` reason, writes the sentinel and bare-stop rows,
and closes an open agent session on a silent turn. A turn whose text completion already ran the
decision is skipped. The wake-accounting hook also clears the `no_reply` and `react` signals at
`turn.started`, so a signal that no handler consumed never reaches the next turn.

**Text written before a wait is not the turn's ending.** On a root session eve completes such text as
an ordinary `stop` message while the turn waits on a working task. When a worker this turn dispatched
still owes the wake, the unified seat posts nothing, drops nothing, re-drives nothing, and leaves the
turn undecided; the turn's real final message or `turn.completed` decides it. `turn.completed` always
decides, because the turn has ended. Every other chat channel gets the same `turn.completed` decision
from core's `withEndsTurnFinalChannel` (`channels/ends-turn-final.ts`), which each provider applies to
its exported channel.

`no_reply` still returns a **non-empty** terminal note (`NO_REPLY_NOTE`,
`packages/core/agent/tools/no_reply.ts`). The model reads it only when the same step also carried a
call that does not end the turn. eve reads an empty step as a failure and reissues it once with "Your
previous reply was empty and was not delivered. Continue the current user request" — a note that
would command a reply on a turn that correctly chose silence. Naming the terminal output makes that
step non-empty, so the recovery path is never reached. The `reply` result note names the same
sentinel for the same reason.

One silence row is logged per turn. A **second** `no_reply` in the same turn ends the turn under the
closeout reason `no-reply-redundant` (`NO_REPLY_REDUNDANT_CLOSEOUT_REASON`), which is countable apart
from a turn ended by a refused reply.

`finalMessageActionForTurn` (`turn-delivery.ts`) **consumes both silence signals first**, so neither
leaks into a later turn, and then ranks them: a silent routine wins, then a stand-down silence, then
the `no_reply` reason. Anything else falls through to the ordinary final-message action.

**`react` and `edit_reply` do not end the turn, and their result notes name the next step.** Neither
sets `endsTurn`. An addressed `react` only acknowledges, so the turn must stay open for the one short
`reply` still owed (OPE-964); `edit_reply` may be followed by a `reply` with anything new. Their notes
(`reactResultNote`, `tools/react.ts`; `editedNote`, `tools/edit_reply.ts`) ask for that `reply`, or name
the `NO_REPLY` sentinel when nothing is left, so the next step is not empty. `stand_down`,
`complete_thread` and `update_status` end nothing: each leaves the room still owed a line.

These notes replaced eve patch part 5 (the empty-step terminal guard, OPE-762), which suppressed eve's
reissue after a confirmed terminal verb by scanning the step's messages. The notes are instruction
compliance, not a mechanism: a model that ignores one and returns an empty step takes eve's one-shot
reissue, and an empty reissue fails the turn.

**`react` refuses where the wake's origin has no reaction primitive.** The per-turn origin fence is
skipped on a unified session, so such a wake can reach the tool; it then throws a refusal naming the
origin platform and steering to `reply` for an acknowledgement or `no_reply` otherwise. The same
refusal fires for a non-Slack binding whose post arm registers no react target resolver or no react
call.

## 5. The ancillary ops registry

Three verbs above — the ✋ glyph, the cancel note, and the file attachment of §6 — need a plain
transport rather than the reply spine. `SurfaceMessageOps` is that registry:

| Member | Required? | What its absence means |
|---|---|---|
| `postText` | yes | — |
| `editMessage` | yes | — |
| `postFiles` | no | this platform has no attach-a-file-to-a-message primitive |
| `permalink` | no | this platform mints no stable per-message URL; callers degrade to naming the channel |
| `setReaction` | no | this platform has no reaction primitive; the caller places no affordance |

"Optional" here is a statement **about the op**, not a softening of the contract. GitHub has no API
for attaching a file to a comment. Forcing it to register a required `postFiles` would mean either
faking the op or refusing the whole registration over one missing primitive — and refusing the
registration would also cost it `postText`, which is what makes its stop acknowledgement audible.

A caller checks the **op's** presence, never the registry's.

---

## 6. The extension tier

A verb belongs in the extension tier when a provider can ship it, another provider cannot express
it at all, and its absence costs the model nothing it could not do another way.

**Canvases and other platform-rich objects are extension tier**. They are not
part of this contract and never become a condition of joining it.

**File-attach-to-message is a decision, and the audit's answer is "extension tier".** It was proposed
as a candidate core verb, with the semantics fixed correctly: attaching a file to a chat message,
never uploading to a vendor's object store (a file on a Linear issue or a Notion page is work-plane,
reached through that vendor's own tools). The condition he set was that all six current providers
can honour it. Measured against the code, they cannot — see §7.4 — and two of the three misses are
permanent vendor limits rather than unwired work. A core verb that three of six surfaces refuse
would fail its own contract on day one.

**Anything vendor-shaped stays out.** The test is not "is this useful", it is "can a provider that
has never heard of this vendor implement it". `reply` passes. A Slack Block Kit card does not.

---

## 7. The six-provider audit

Read from the code: adapter registrations in each `packages/providers/<id>/agent/register.ts`, the
post-arm members each bundle actually defines, and the tool mount conditions in
`packages/core/agent/tools/`. Measured 2026-08-22 against `main`.

One distinction runs through the tables. **Whether a registration exists is measured.** *Why* it is
absent — "vendor limit" against "not wired yet" — is quoted from the module that declined to
register it, so treat a vendor-limit label as that module's stated reason rather than a fresh
probe of the vendor's API.

### 7.1 Registration seams

🔴 **THE THREE TABLES BELOW ARE GENERATED. Do not hand-edit them.** Each provider declares every
capability in `packages/providers/<id>/agent/surface-parity.ts`, and
`npx tsx scripts/surface-parity.ts` renders these tables from those declarations.
`npm run lint:surface-parity` reds on a capability a provider leaves unanswered and on an
`unsupported` with no reason. For the fifteen rows a machine can measure it also compares the
declaration against the code, in two arms that do NOT cover the same cells:

- a **bare `supported`** the code cannot confirm reds. A `{ supported: "<note>" }` cell does not —
  the note is the author saying the capability is wired somewhere the probe does not look, which is
  how Slack's inline ancillary ops pass.
- **any `unsupported` cell the code contradicts** reds. Nothing is exempt here. This is the arm that
  catches a gap closing without the ledger being updated.

Eleven of those fifteen rows read a live registry alone. Four have no registry to read — the ambient
engagement seam, the owned-thread ingress divert, the engaged wake row promotion and the seat
context-line admission — so each of those probes scans the bundle's sources instead, for an import
of the core function that IS the seam, or, for the promotion, for the mapping's own body and the
audit field it feeds. The
other twenty-three rows are declaration-only — the §4 verbs mount on session grants and per-surface tool logic, not on a
platform-keyed registry, so there is nothing for a probe to read and their truth rests on the
provider author.

Edit the declaration; the table follows. The prose around each table is hand-written and explains
the rows.

<!-- BEGIN GENERATED: surface-parity-seams (scripts/surface-parity.ts) -->

| Capability | slack | discord | teams | github | linear | notion | email | google-chat |
|---|---|---|---|---|---|---|---|---|
| Identity mapper §2.1 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Capability manifest §2.4 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Post arm §4.1 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Wake-origin codec §2.3 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| **Wake-origin placement carry** (`placementRef`/`carryPlacement`) §2.3 | ✅ | ✅ | ❌ the placement is INSIDE the conversation identity: `threadRef` keys on `replyToActivityId`, the very activity a reply hangs under, so two origins that pass the conversation test already agree on placement and there is no gap to carry | ❌ the placement is INSIDE the conversation identity: a reply is a comment appended to the issue timeline and the issue IS `threadRef`'s thread key, so there is no 'where inside it' left to name | ❌ the placement is INSIDE the conversation identity: `parentId` is the thread-root comment a reply nests under and it is exactly what `threadRef` keys on. `agentSessionId` is not a second axis — it selects the reply ROUTE, so carrying it would deliver an answer into a session that asked nothing | ❌ the placement is INSIDE the conversation identity: a reply targets `discussionId`, which is exactly what `threadRef` keys on, so two origins that pass the conversation test name the same discussion and cannot disagree about placement | ❌ the placement is INSIDE the conversation identity: a reply threads under the origin's `messageId`, and `threadRef` keys on the thread itself, so two origins of one thread agree on placement | ❌ the placement is INSIDE the conversation identity: `threadRef` keys on the thread name, the very thread a reply posts into, so two origins of one conversation already agree on placement |
| Read adapter §4.5 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ `read_thread` only — the thread of the mail that woke the turn; an inbox has no shared channel history to read | ❌ not built yet — listing a space's messages needs user authentication or the admin-approved `chat.app.messages.readonly` app scope, which the app does not request |
| Reaction **feedback** ingest §4.9 | ✅ | ✅ | ✅ the vendor fence is the guarantee — Teams delivers the event only for the agent's own messages, and carries no author to compare | ✅ polled on the next delivery for that conversation — GitHub pushes no reaction webhook, so a removal is never observed | ✅ the author of the reacted comment costs one GraphQL read — the webhook does not carry it | ❌ vendor limit — Notion pushes no reaction event and its comment object exposes no reaction resource, so there is nothing to receive and nothing to poll | ❌ mail has no reactions | ❌ not built yet — the HTTP endpoint carries no reaction event; a Workspace Events subscription would |
| Ancillary ops (`SurfaceMessageOps`) §5 | ✅ inline — rides Eve's own Slack client path, not the ops registry | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ text only — a host notice is one more reply in the thread, to its allowed participants; an email cannot be edited, carry a file or take a reaction | ✅ text only — a host notice is one more message in the space; no edit, file or reaction |
| **Ambient engagement seam** §2.5 | ✅ | ✅ enrols and honours `stopped`; gates delivery in its own gateway rule | ✅ the seam is wired; plain follow-ups reach it only where the tenant consented to `ChannelMessage.Read.Group` / `ChatMessage.Read.Chat`, which no API can probe | ✅ | ✅ | ✅ | ❌ every mail to an inbox is addressed to the agent, so there is no ambient chatter to engage with | ❌ not built yet — the HTTP endpoint delivers a space message only on an @mention; a Workspace Events subscription would deliver the rest |
| **Engaged wake row promotion** (`thread-follow`) §2.5 | ❌ no dispatch row — Slack writes no `slack.dispatched` action, so there is no `addressing` value to promote | ❌ the seated path reports the classifier's word — an auto-thread's follow-up diverts as that channel's own wake, and the journey reads `channel-watch` on a `singleWindow: true` row in that room instead | ❌ not built yet — the single-window divert writes the plan's own `addressing`, which calls an engaged follow-up and room chatter alike | ✅ | ✅ | ✅ | ❌ no ambient leg — every email wake is addressed (`direct-mention`) | ❌ no ambient leg — every Google Chat wake is addressed (`direct-mention`) |
| **Owned-thread ingress divert** §2.6 | ✅ | ✅ the guild leg only — a Discord DM carries no threads, so its divert never consults ownership | ✅ the channel leg only — a reply chain is the thread; the DM leg mints no `replyToActivityId`, so it can own none | ✅ | ✅ | ✅ | ✅ the room leg takes the inbound divert, but an email thread has no inner threads, so no email wake is thread-scoped and ownership never re-routes one | ✅ the space leg takes the inbound divert; only a reply inside an existing thread (`threadReply`) is thread-scoped |
| **Thread done reaction** (`threadRootMessage`) §2.6 | ✅ | ❌ a Discord thread is its own channel, and the message that started it lives in the PARENT channel, whose id the origin does not carry. Marking the thread's first message instead would put the mark on the wrong message | ❌ Teams has no integration reaction primitive (no `setReaction` in the ancillary ops) | ❌ the thread is the issue itself, so no root message stands apart from it, and the ancillary ops carry no `setReaction` | ✅ on a reply thread only — the root is the thread-root comment; a thread that IS the issue has no root comment to mark | ❌ Notion's public API has no reaction primitive | ❌ mail has no reactions | ❌ not built yet — the app sets no reactions (no `setReaction` in the ancillary ops) |
| **Seat catch-up read** (since last wake) §2.5 | ✅ | ✅ | ✅ over Microsoft Graph (channel activities only — a personal/group chat carries no team id) | ✅ | ✅ | ✅ | ❌ every mail to the inbox is itself a wake, so nothing arrives between wakes for a catch-up to read | ❌ not built yet — the app does not list a space's messages (see the read adapter row) |
| **Seat context-line admission** (`admitContextLines`) §2.5 | ✅ | ✅ | ❌ the hydration fills no context-line slot — the seat's room context is the catch-up read, which core already admits | ✅ | ✅ | ❌ the hydration fills no context-line slot — the seat's room context is the catch-up read, which core already admits | ❌ the context slot carries the mail's own quoted or forwarded remainder, fenced and tainting, never other authors' room history | ❌ the wake fills no context-line slot — the seat reads only the addressed message and its carried tail |
| **Approval card** (tappable Approve/Reject) §4.1 | ✅ | ✅ | ✅ built, not yet proven on a live tenant — a channel, a personal chat and a group chat each host their own Adaptive Card, and the tap is answered after the Bot Framework JWT verify | ❌ an issue/PR comment carries no component plane, so there is no button to render and no route for a tap. A governed act that takes the venue walk is redirected to a card-capable room in the SAME domain, or refused when the domain holds none. The paths OUTSIDE that walk do not: the spend checkpoint (spend/checkpoint.ts `requireSessionContinuation`) fails OPEN here and records the crossing in an audit row instead | ❌ an issue comment carries no component plane, so there is no button to render and no route for a tap. A governed act that takes the venue walk is redirected to a card-capable room in the SAME domain, or refused when the domain holds none. The paths OUTSIDE that walk do not: the spend checkpoint (spend/checkpoint.ts `requireSessionContinuation`) fails OPEN here and records the crossing in an audit row instead | ❌ a page comment carries no component plane, so there is no button to render and no route for a tap. A governed act that takes the venue walk is redirected to a card-capable room in the SAME domain, or refused when the domain holds none. The paths OUTSIDE that walk do not: the spend checkpoint (spend/checkpoint.ts `requireSessionContinuation`) fails OPEN here and records the crossing in an audit row instead | ❌ mail cannot carry a tappable card — a governed act asked from an inbox takes the venue walk to a card-capable room in the same domain | ❌ not built yet — a Chat card with a button needs the CARD_CLICKED tap answered; a governed act asked from Google Chat takes the venue walk to a card-capable room in the same domain |
| **Judge-lift notice** (a lifted act leaves a trace) §4.1 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ the shared text render, sent as a reply in the thread to its allowed participants — mail carries no button, so the overrule is spelled out in words | ✅ the shared text render, posted into the space — no button yet, so the overrule is spelled out in words |

<!-- END GENERATED: surface-parity-seams -->

Slack's ancillary ops are inline rather than registered: they ride Eve's own Slack client path, not
a bot-token REST call. The effect is identical; only the transport differs.

The **judge-lift notice** row reads ✅ on all six, and it is about the TRACE rather than the button —
read it with the **approval card** row above it, which is about the button and says ❌ on four. The
approver chain can LOWER a gated verb: the frozen arguments then execute with no card at all, and
this notice is the room's only record of an act nobody was asked about. One road posts it —
`postJudgeLiftNotice` in `packages/core/agent/approvals/flow.ts` — with three renders. Discord's
bundle registers a `JudgeLiftNoticePoster` and renders its own card with the "This should not have
run" button; Slack takes core's built-in Block Kit render, which carries the same button; Teams,
GitHub, Linear and Notion take the shared plain-text render on their own `SurfaceMessageOps`
transport. **On those four the notice carries no button**, because no tap route exists to receive
one — it carries the overrule as an instruction in words, with the action id the act is recorded
under in the audit trail. A surface reaches ❌ here only by registering neither a notice poster nor a
text transport, which is a room nothing can be posted into at all. Until OPE-1854 the road admitted
the first two renders and nothing else, so those four rooms stayed silent while the same act in a
Slack channel posted a notice with an overrule button.

Reaction **feedback** ingest is a separate seam from the **stop** arm, and the two rows disagree on
purpose. Feedback ingest turns a 👍/👎 on the agent's own reply into a durable signal; Teams, Linear,
GitHub and Notion do not register it. Their stop arms parse their own reaction or comment events
directly and never pass through it.

The **ambient engagement seam** is the §2.5 wiring, and it is measured by which providers call the
core engagement plane at all. Slack calls the full trio — `markThreadEngaged`, `shouldDeliverReply`
and the `stopped` flag (`slack-events.ts`, `slack.ts`; `slack-front.ts` reads the row through
`isThreadEngaged`). Discord enrols and reads the flag but runs its own gate rather than
`shouldDeliverReply` (`discord-gateway.ts`, `discord-post-arm.ts`). Teams calls the full trio
too, through one translation module — `teams-engagement.ts`, which `teams-front.ts` and `teams.ts`
both call. GitHub, Linear and Notion follow that one-module shape — `github-engagement.ts`,
`linear-engagement.ts` and `notion-engagement.ts` — each called from its own surface's legs. Read
this row with §7.6: it is the row `stand_down` needs, and the row whose absence it refuses on.

The **engaged wake row promotion** is about the AUDIT ROW, not the wake. An ambient classifier
answers one narrow question — did this comment address the agent — so it calls an engaged follow-up
and unowned room chatter alike `channel-watch`. A surface that writes that word into its
`<platform>.dispatched` row cannot tell the two apart afterwards, and `gateEngagedWake` reds on it:
the gate skips an EMPTY dispatch read, never a non-empty one carrying the wrong value. GitHub, Linear
and Notion each carry the mapping in their own `*-engagement.ts` — `githubWakeAddressing`,
`linearWakeAddressing` and `notionWakeAddressing`, one spelling for one concept. The promotion
changes the ROW alone: every one of the three builds its wake envelope's `addressing` from a
different value, so the turn is judged, and the silence bar set, exactly as before. Slack writes no
dispatch row at all. Discord's cell is a second honest spelling rather than a gap — under standing
seats an auto-thread is a seated channel, so its follow-up diverts as that channel's own wake and the
journey reads `channel-watch` on a `singleWindow: true` row in that room. Teams is the one real gap
left, and no journey reds on it today. Each of the three surfaces that carry the mapping found it in
production, on a red journey against a healthy deployment: OPE-1510, OPE-1578 and OPE-1752. What this
row adds is a DECLARED position per surface, checked against the code: a bare `supported` the probe
cannot confirm reds, and a seventh surface cannot leave the question unanswered at all. It does NOT
convert the next collision into a lint failure — a surface that starts writing an unpromoted row
while its cell honestly says `unsupported` passes both arms, and reds its journey live. That gap is
stated in `packages/core/scripts/e2e/engaged-rows.ts`, which is where a journey author reads it.

The **owned-thread ingress divert** is the §2.6 wiring, and it is measured by which bundles call
`divertInboundToUnifiedWindow` at all. All six do. Two cells carry a caveat rather than a bare ✅,
and both name a leg that is NOT wired: Discord's and Teams' DM legs stay on the raw divert, because
their DM origins carry no thread signal (§2.6). Slack was the only surface with this row for weeks,
and the cost split two ways: on Teams, GitHub, Linear and Notion a thread seat could be spawned and
was then silently orphaned, because nothing read its ownership row; on Discord no seat could be
spawned at all, because no Discord wake was thread-scoped and `spawn_thread_session` refused the
platform outright (OPE-1719).

The **seat catch-up read** is the since-last-wake read a standing seat makes on every ONGOING wake —
a FRESH generation renders its carried tail instead, because it has no previous wake to read from —
and it is measured by which providers register a fetch with the shared path
(`packages/core/agent/channels/seat-catch-up.ts`). All six do. The bounds, the domain's admission
policy and the token cap live in core, so a surface contributes exactly one thing: a fetch that turns
its own container history into normalized messages.

Notion keeps two thread identities distinct. The `threadRoot` is the discussion id used for reply
targeting and filtering. An inline comment's fetched, authenticated parent block rides separately as
`threadAnchor`, because the comments API addresses reads by block. Initial sibling hydration and an
ongoing seat's catch-up both use that exact block, so an inline discussion remains reachable after
the page grows beyond the bounded page sweep. Page-level comments carry no block anchor and retain
the page sweep.

🔴 **The admission policy is the ROAD's, and a surface never passes one** (OPE-1857). `seatCatchUp`
resolves the domain's policy itself, from the `channelKey` the request already carries — the same key
the audit row's scope, the fetch's credential and the wake's trust are resolved from. Six wake paths
each passing `seatAdmissionFor(<its own key>)` was the same policy six times right up until one of
them derived the key differently, and a caller that passed none got NO admission at all: a silent
widening that looks, from outside, exactly like a policy that admitted.

🔴 **An author the vendor does not call a machine is a PERSON** (OPE-1857). A fetch hands core the
signals it read and `catchUpSender` decides what they mean: our own post is `self`, an author the
vendor POSITIVELY calls a machine is `bot`, and everything else — an absent signal included — is
`human`. Reading an absent signal as `bot` is fail-open in the one direction that matters: the
default `wide` policy refuses every bot, so a surface whose vendor omits the field refuses EVERY
author on EVERY wake and its seat reads a room it is being spoken in as silent. Notion serves a
comment's `created_by` as a partial user — an id and an object, no `type` — and its catch-up read the
absent type as "not a person". A live run: `seat.catch_up outcome=empty raw=4 kept=0
reason=admission-dropped-all` on a read whose bounds had kept all four comments. A real page member's
comment was refused by exactly that arithmetic.

The rule is safe because each fetch still owes core its VISIBILITY GATE first: an author the surface
cannot attribute is dropped before the sender is decided, so "absent signal" only ever describes an
author the surface CAN name. It is the same rule the rendered context-line road already applies — a
line the surface could not attribute is a person it could not vouch, floored at `unauth`.

🔴 **A surface DECLARES the unit its own timestamps are stamped in, and core widens both bounds to
it** (OPE-1847). A catch-up window is two bounds compared against the times a vendor puts on its own
messages, and vendors stamp in different units: Slack, Discord, Teams and Linear to the millisecond,
GitHub to the second, Notion to the minute. A bound computed finer than the stamp it is compared
against excludes messages that are genuinely inside the window. A live run read a Notion seat's page,
got two comments, and kept neither: the upper bound was the trigger's own minute-floored
`created_time`, so every comment sharing that minute — the one the seat woke to read included —
carried the same instant and fell outside a strict bound.

So the unit is a surface property. A provider passes it when it registers its fetch:

```ts
registerSeatCatchUp("notion", notionSeatCatchUpFetch, { timestampPrecisionMs: NOTION_TIMESTAMP_PRECISION_MS });
```

Core then floors the lower bound to the start of that unit, raises the upper bound to its end, and
hands the WIDENED window to the fetch as well as applying it to what comes back — so a fetch that
re-states the bound to its vendor states the same bound core applies. Two consequences follow, and
both are deliberate:

- **The wake's own message leaves by ID, never by time.** A surface must normalize its messages to
  ids that `SeatCatchUpRequest.excludeId` can match. The widened upper bound admits the trigger's
  whole unit, so on EVERY surface — millisecond-grain ones included — that id match is the only
  thing that keeps the wake's own message out of its own context.
- **Inside one unit the window does not order two messages, and cannot.** The vendor's own stamps do
  not, so a message posted after the trigger but inside its unit enters that wake's context and then
  arrives again as its own wake's trigger. A message in the last wake's unit can likewise be re-shown
  across two wakes. That is one minute on Notion, one second on GitHub, one millisecond elsewhere.
  Both costs are the right way round: a seat that sees a message twice recovers, a seat that never
  sees it does not — which is what one live run showed.

Declare the VENDOR'S unit and nothing else. It is not a tolerance and not a clock-skew budget: too
large hands the seat messages from outside its own window, and too small is the defect above. A
surface that declares nothing gets one millisecond — the finest unit this declaration can express,
which is **not** the same as no widening, and not the finest grain every vendor has (a Slack `ts`
carries a microsecond fraction the unit cannot state). `npm run test:seat-catch-up-parity` is what
holds every shipped surface to a declaration.

🔴 **Every catch-up read writes one `seat.catch_up` audit row, on every surface** (OPE-1831). The row
is what makes the read's own fail-soft posture readable from outside. A catch-up is context, so no
fault in it may ever fail a wake — an unreadable page, a refused author and a genuinely quiet room
therefore all reach the seat as the same empty list. That is correct for the SEAT and useless for an
operator. The row states which one happened:

| Field | What it says |
|---|---|
| `outcome` | `read`, `empty`, `unavailable` or `failed` — one greppable enum, the same four words on every surface. |
| `reason` | Why, when the outcome is not `read`: `no-registered-fetch`, `fetch-threw`, `fetch-returned-none`, `bounds-dropped-all` or `admission-dropped-all`. |
| `raw` / `kept` | What the SURFACE returned, beside what survived core's bounds, admission and cap. `raw` 0 is the surface's own answer; `raw` above 0 with `kept` 0 is core's. |
| `container` / `threadRoot` | The container and conversation ids the surface's own dispatch row already records. A provider-only authenticated read anchor is not copied into the audit row. |
| `since` / `precisionMs` | The lower bound AS APPLIED, and the stamp unit it was widened to — so a red ship names the window without reading a provider module. |
| `errorName` / `httpStatus` | The error CLASS and the HTTP status, on a `failed` row. |

🔴 **Fail-soft has one owner** (OPE-1842). A provider fetch propagates an attempted credential,
transport or read failure to `seatCatchUp`; the shared boundary keeps the wake alive with an empty
window and writes `outcome=failed`. A fetch returns `[]` only for a genuine empty, unconfigured or
unaddressable answer, which writes `outcome=empty`. Teams preserves a finer partial-read contract:
one Graph endpoint may fail while the other still contributes messages, and its per-resource
`teams.catch_up` rows record that split; only failure of every requested endpoint reaches the shared
`failed` outcome.

`empty` is still not proof the room was quiet. Bounds, admission, visibility gates and bounded
coverage can all empty a successful fetch. The `reason`, `raw` and `kept` fields separate the shared
stages; provider-specific coverage limits remain documented by the provider and its finer rows.

🔴 **No message body and no author display name ever enters the row.** The row is addressing and
counts. `seat.catch_up` is written once per catch-up CALL in core rather than per surface, so a new
surface cannot ship a catch-up without one. A row therefore counts catch-up reads, not wakes: a fresh
generation makes no read and writes no row.

`npm run test:seat-catch-up-parity` guards the road from both ends, because registering a fetch and
calling the seam are different facts: it asks the process registry that each surface registers a
fetch, and it reads each provider's own source for the `seatCatchUp("<platform>", …)` call — every
wake path wires the seam optionally (`&& deps.catchUp`), so a surface could keep its registration,
stop calling the seam, and write no row with the registry none the wiser. Teams keeps its own `teams.catch_up` row beside it at a finer grain: Graph serves
chain roots and replies from two endpoints, so that row is written per GRAPH CALL and names the
resource and path, which the one-row-per-call shared action cannot express.

### 7.1.1 Wake legs and conversation shapes

Which legs wake the agent on each surface, and which container shapes the surface actually has.
These rows never had a table; they were prose in §2.5 and §4.6.1, which is why "Notion has no
@mention of an integration" and "a repo is not a room" had to be rediscovered by reading.

<!-- BEGIN GENERATED: surface-parity-shapes (scripts/surface-parity.ts) -->

| Capability | slack | discord | teams | github | linear | notion | email | google-chat |
|---|---|---|---|---|---|---|---|---|
| Addressed (@mention) leg §2.2 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ the `direct` wake — a name-drop or structured mention, not a platform @mention | ✅ | ✅ |
| Ambient (non-mention) leg §2.5 | ✅ | ✅ | ✅ the single-window front's Leg A, not the §2.5 engagement registry | ✅ the ambient supervisor, not the §2.5 engagement registry | ✅ the ambient supervisor, not the §2.5 engagement registry | ✅ the ambient supervisor, not the §2.5 engagement registry | ❌ every mail to an inbox is addressed to the agent | ❌ not built yet — the HTTP endpoint delivers a space message only on an @mention; a Workspace Events subscription would deliver the rest |
| Name-drop / structured mention §2.5 | ✅ | ✅ | ✅ channels only; a non-@mention message reaches the bot only where the tenant consented to `ChannelMessage.Read.Group`, which no API can probe | ❌ not built yet — the ambient supervisor already reads every comment, so a name-drop match adds no wake | ❌ not built yet — the ambient supervisor already reads every comment, so a name-drop match adds no wake | ✅ | ❌ every mail to an inbox is addressed to the agent | ❌ not built yet — a message that names the app without an @mention never reaches the HTTP endpoint; a Workspace Events subscription would deliver it |
| Message-EDIT wake §2.5 | ✅ | ❌ the gateway relay subscribes to MessageCreate only — an edit raises MessageUpdate, which nothing forwards | ❌ an edit arrives as a `messageUpdate` activity, and the inbound parser admits `message`, `invoke` and `conversationUpdate` only | ❌ every wake leg admits `action: "created"` only — eve's route, the ambient extractor and the stop leg each refuse an edited comment | ❌ the ambient leg admits `Comment` with `action: "create"` only — an edit returns null before the classifier | ❌ the webhook admits `comment.created` only — `comment.updated` answers `ignored` at step 4 | ❌ a sent email cannot be edited | ❌ not built yet — the HTTP endpoint sends no event for an edited message; a Workspace Events subscription would |
| Threads §4.6 | ✅ | ✅ a thread is itself a channel | ✅ | ✅ | ✅ | ✅ thread-first — every wake arrives scoped to one discussion | ✅ the mail thread — a reply threads under the message that woke the seat | ✅ a reply posts into the trigger's own thread (`REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD`) |
| Standing rooms *(not §4.5's `read_channel` container)* §4.7.1 | ✅ | ✅ | ✅ | ❌ no standing container — every GitHub container is one issue or pull request | ❌ no standing container — every Linear container is one issue | ❌ no standing container — a discussion is minted by its first comment and anchored to one block | ✅ a room inbox is a surface a domain's `reach` lists (`email/<domain>/<local>`) | ✅ a space is a surface a domain's `reach` lists (`google-chat/<workspace>/<space id>`) |
| DM (`dm`) §4.7.2 | ✅ | ✅ | ✅ | ❌ no DM plane — GitHub carries no person-to-person message channel | ❌ no DM plane — Linear carries no person-to-person message channel | ❌ no DM plane — Notion carries no person-to-person message channel | ✅ a personal inbox wakes the DM seat of the declared person who wrote | ✅ the person's own direct message with the app wakes their DM seat — internal people only |
| Group DM (`mpim`) §4.7.2 | ✅ | ✅ | ✅ | ❌ no DM plane — GitHub carries no person-to-person message channel | ❌ no DM plane — Linear carries no person-to-person message channel | ❌ no DM plane — Notion carries no person-to-person message channel | ❌ a mail with several people on it is a thread in a room or personal inbox, not a group DM | ❌ policy: a group chat is refused (`group-chat`) — it has no domain to own it and is not one person's DM |

<!-- END GENERATED: surface-parity-shapes -->

🔴 **"Standing room" in this table is NOT §4.5's "room".** §4.5 is titled "`read_channel` — read
this room" and §4.6.1 names a room for all six surfaces, GitHub's issue conversation included — and
`read_channel` is ✅ on all six in §7.2 below. This row asks the narrower question: does the surface
carry a container that exists BEFORE any work item and holds chat that is not about one? That is
what §4.7.1's `post_message` targets, and it is the only container that can carry ambient chatter.

Every surface has threads; only three have a standing room. That asymmetry is the whole argument of
§2.5's engagement seam: an engaged mark needs a thread, so every surface can hold one, while ambient
room chatter needs a standing room, so only three can carry that leg.

The **Message-EDIT wake** row is Slack alone, and the shared code reads wider than the behaviour.
`shouldDeliverReply` carves `message_changed` out of its blanket subtype refusal, so an edit in an
engaged Slack thread wakes the seat with `reason="message-edited"` and the pre-edit text in
`<previous-body>`. The other five surfaces raise no wake from an edit, and each is stopped by a
different filter. Three sit outside this repository: the Discord relay subscribes to
`MessageCreate` only, so the event never reaches the deployment at all; Teams sends an edit as a
`messageUpdate` activity that eve's inbound parser does not admit; and eve's GitHub route dispatches
`action: "created"` comments only. Two are our own bundles: Linear's ambient extractor admits
`Comment` with `action: "create"` only, and the Notion webhook answers `ignored` for anything that
is not `comment.created`. So "the agent noticed my correction" is a Slack-only promise today, and
asking for it elsewhere is a change to a subscription or an event filter rather than to the
engagement seam.

The ambient leg is a DIFFERENT mechanism from the engagement seam on four surfaces — the ambient
supervisor on GitHub, Linear and Notion, and the single-window front's Leg A on Teams — and what
decides whether it runs is the domain flag, never the registry. Since OPE-1500 and OPE-1501 the
registry does reach it, though: a stood-down conversation is dropped above every one of those legs,
and on **Linear and Notion** an ENGAGED container wakes its ambient leg even where the domain turned
ambient off. **GitHub is the exception**: its ambient leg returns on the domain flag before the registry is
read, so an engaged follow-up there is answered by the native leg, on a private repo and outside a
review thread (§2.5, §7.6).

### 7.2 Core verbs

<!-- BEGIN GENERATED: surface-parity-verbs (scripts/surface-parity.ts) -->

| Capability | slack | discord | teams | github | linear | notion | email | google-chat |
|---|---|---|---|---|---|---|---|---|
| `reply` §4.1 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ recipients are frozen at the inbound gate from the mail's own headers and re-checked at send time — the model never names one | ✅ |
| `edit_reply` §4.2 | ✅ | ✅ | ✅ | ✅ | ✅ the ambient route only — Linear's schema has no mutation that updates an Agent Activity | ✅ | ❌ a sent email cannot be edited | ❌ not built yet — the arm registers no edit; Chat's `messages.patch` would carry one |
| `react` §4.3 | ✅ | ✅ | ❌ vendor limit — Graph's outbound reaction route refuses an application-only identity | ✅ | ✅ | ❌ vendor limit — the Notion comment API exposes no reaction write | ❌ mail has no reactions | ❌ not built yet — no outbound reaction transport is wired |
| `no_reply` §4.4 | ✅ | ✅ | ✅ | ✅ | ✅ posts the host line | ✅ | ✅ | ✅ |
| `read_channel` §4.5 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ an inbox holds many unrelated correspondents' threads, so there is no channel history to read into a turn | ❌ not built yet — listing a space's messages needs user authentication or the admin-approved `chat.app.messages.readonly` app scope, which the app does not request |
| `read_thread` §4.6 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ not built yet — the same message-list scope as `read_channel` |
| `search` §4.7 | ❌ no work-search adapter — Slack is a chat surface, not a work corpus (§4.7) | ❌ no work-search adapter — Discord is a chat surface, not a work corpus (§4.7) | ❌ no work-search adapter — Teams is a chat surface, not a work corpus (§4.7) | ✅ the core-resident adapter (`scm/github-search.ts`), registered ungated | ✅ | ✅ | ❌ no work-search adapter — an inbox is a conversation surface, not a work corpus | ❌ no work-search adapter — Google Chat is a chat surface, not a work corpus |
| `post_message` (P1) §4.7.1 | ✅ | ✅ | ✅ | ❌ not built yet — no `channel` row in `access/resource-grant.ts` — OPE-1507 | ❌ not built yet — no `channel` row in `access/resource-grant.ts` — OPE-1507 | ❌ not built yet — no `channel` row in `access/resource-grant.ts` — OPE-1507 | ❌ policy: no cold mail — the agent mails only as a reply on a thread somebody started | ❌ not built yet — no routine dispatch is registered, so the agent answers only in a conversation somebody started |
| `dm_person` (P2) §4.7.2 | ✅ | ✅ | ✅ | ❌ no DM plane — GitHub carries no person-to-person message channel (§4.7.2) | ❌ no DM plane — Linear carries no person-to-person message channel (§4.7.2) | ❌ no DM plane — Notion carries no person-to-person message channel (§4.7.2) | ❌ policy: no cold mail — the agent never starts a mail to a person | ❌ not built yet — the app cannot open a DM a person did not start |
| `set_dm_delivery` (P2, recipient) §4.7.2 | ✅ | ✅ | ✅ | ❌ no DM plane — the verb mounts only inside a 1:1 DM (§4.7.2) | ❌ no DM plane — the verb mounts only inside a 1:1 DM (§4.7.2) | ❌ no DM plane — the verb mounts only inside a 1:1 DM (§4.7.2) | ❌ policy: no cold mail — an inbox is never a proactive delivery channel | ❌ not built yet — a Google Chat DM is never a proactive delivery channel |
| `stop` (human) §4.8 | ✅ ✋ reaction, plus the `/oe stop` command | ✅ ✋ reaction, plus the `/oe stop` command | ✅ the `angry` reaction — Teams' six fixed values carry no ✋ | ✅ a comment whose entire body is `stop` — GitHub sends no reaction webhook | ✅ the ✋ reaction | ✅ a comment whose entire body is `stop` — Notion pushes no reaction webhook | ❌ mail has no reaction to carry a stop | ❌ not built yet — the app reads no reactions, so there is no stop trigger |
| `ack`: ✋ glyph §4.9 | ✅ | ✅ | ❌ vendor limit — Teams' fixed six-value reaction vocabulary has no raised hand | ❌ vendor limit — GitHub's fixed eight reactions carry no raised hand, so there is no ✋ to place | ✅ | ❌ vendor limit — the Notion comment API exposes no reaction write, so there is no glyph to place | ❌ mail has no reactions | ❌ not built yet — the app sets no reactions |
| `ack`: cancel note §4.9 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ a reply in the thread, through the host-notice transport | ✅ a message in the space, through the host-notice transport |
| `stand_down` §4.10 | ✅ marks the engagement row; refuses out loud when the registry holds none | ✅ marks the engagement row; refuses out loud when the registry holds none | ✅ marks the conversation row; refuses on a 1:1 and when no row exists | ✅ marks the issue/pull-request row; refuses when no row exists | ✅ marks the issue row; drops a top-level comment and suppresses a `prompted` agent-session follow-up on the native leg, while a `prompted` comment that @mentions the app lifts the stop; an unreadable comment body suppresses, an unclassified future action is ungated and the divert leg's copy is unpinned; refuses when no row exists | ✅ marks the page row; refuses when no row exists | ❌ not built yet — a sender is removed from an inbox by a pull request to agent/email/senders.ts or agent/email/policy.ts | ❌ not built yet — remove the app from the space instead |
| `post_file` §7.4 | ✅ | ✅ | ❌ not built yet — no Teams attachment transport is wired (§7.3) | ❌ vendor limit — a GitHub comment carries no file-attachment API | ❌ vendor limit — a Linear comment carries no file-attachment API OE can drive | ✅ at most 3 files per post — a Notion comment's own vendor cap | ❌ not built yet — the reply carries text only | ❌ not built yet — the reply carries text only |

<!-- END GENERATED: surface-parity-verbs -->

`search` reads a work CORPUS, and it mounts on the session's grants rather than on the bound
surface. Slack, Discord and Teams register no work-search adapter, so they contribute nothing to
search — but a chat-bound session in a domain that holds a ticketing grant still mounts the verb.

`stand_down`'s row carries two different answers, so read it carefully. The **❌** cells are §3's
second honest shape: the verb mounts, finds no conversation anchor, and refuses out loud. The **✅**
cells mark a real row when the registry holds one — and refuse out loud when it does not, rather than
reporting a stop that marked nothing. §7.6 states how that second refusal came to exist.

### 7.3 What each gap costs

**Slack** — complete. It is the reference surface, and it is the only one with a per-message
display-name override, so a delegated worker's reply can be labelled natively rather than with a
text bracket.

**Discord — complete.** `react` reached message-level granularity (the same `(channelId, messageId)`
pair `setReaction` already took for the host-placed ✋ glyph) over `discord-post-arm.ts`'s
`resolveReactTarget`/`react`, and the manifest now says `reactions: true` (**OPE-987**). The
seat-prompt doctrine that tells a model to *prefer* a react over a low-content reply is a separate
surface (`instructions/access.ts` `renderNoiseDoctrine`) — it now reads the same manifest
`reactions` flag the `react` tool gates on, so it renders on Discord too (**OPE-997**).

**Teams — the cancel note landed 2026-08-22; the ✋ glyph and `react` are both permanent vendor
limits.** `postText`/`editMessage` now register (**OPE-899**), so the "stood down" note posts after
the `angry` stop reaction fires — resolving its own `serviceUrl` off a `conversation`-grain address
store stamped on every inbound activity, since the note's caller hands the transport only a bare
conversation id. No ✋ glyph: Teams' fixed six-value reaction vocabulary has no raised hand, so
there is nothing to advertise the control with beyond the doc line above. `react` has no primitive
an application identity can drive. Teams delivers `messageReaction` activities **inbound** — that is
what its stop arm reads. Microsoft Graph does carry an outbound reaction route, but it refuses the
application-only context OE runs in. The probe receipts below carry the evidence. Its DM plane also
has zero live coverage (**OPE-972**).

**The Teams reaction probe (OPE-1390, run live 2026-09-02).** The probe posted one plain message
into the e2e fixture channel. It then attempted the reaction writes listed below against that
message, from the bot's own application token and from a delegated user token. Each row is a live
request and its real response:

| # | Plane | Request | Token | Result |
|---|---|---|---|---|
| 1 | Bot Framework Connector | `POST /v3/conversations/{id}/activities`, body `{"type":"messageReaction","reactionsAdded":[{"type":"like"}],"replyToId":"…"}` | bot app, `api.botframework.com/.default` | `400` — `{"error":{"code":"BadArgument","message":"Unknown activity type"}}` |
| 2 | Bot Framework Connector | the same body on the reply route `POST /v3/conversations/{id}/activities/{activityId}` | bot app | `400` — same `BadArgument` / `"Unknown activity type"` |
| 3 | Graph `v1.0` | `POST /teams/{team}/channels/{channel}/messages/{id}/setReaction`, body `{"reactionType":"👍"}` | bot app, `graph.microsoft.com/.default` | `412` — `{"error":{"code":"PreconditionFailed","message":"Requested API is not supported in application-only context"}}` |
| 4 | Graph `beta` | the same channel call | bot app | `412` — same `PreconditionFailed` message |
| 5 | Graph `v1.0` | `POST /chats/{chat}/messages/{id}/setReaction`, body `{"reactionType":"👍"}` | bot app | `412` — same `PreconditionFailed` message |
| 6 | Graph `v1.0` | the channel `setReaction` | delegated user | `204` |
| 7 | Graph `v1.0` | the channel `unsetReaction` | delegated user | `204` |
| 8 | Graph `beta` | the channel `setReaction` | delegated user | `204` |

Reading the probe target back after row 8 returned one reaction: `👍`, under a **user** identity,
never an application one. This list is not a proof that no other route exists — it is what the
probe tried. Microsoft can add an application-only route later, so re-probe rather than quote this
table forward. The two refusals below close the question from different directions, so read them
apart.

The **Connector** rejects `messageReaction` as an activity type at all. The Bot Framework activity
schema describes the type but states no direction for it ([`botframework-activity.md`](https://github.com/Microsoft/botframework-sdk/blob/main/specs/botframework-activity/botframework-activity.md),
read 2026-09-02), so the schema alone does not settle the question. The Teams Connector settles it.
It answers `"Unknown activity type"` on the send route and on the reply route alike. There is no
outbound reaction route to wire.

**Graph** does carry the route, and rows 6 to 8 prove it works. What it refuses is the
**application-only context**, not a missing permission. The bot's token carried no chat or
channel-message permission at probe time and still got `412 PreconditionFailed`, never `403` — on
`v1.0` and on `beta` alike. Microsoft documents the same limit: `chatMessage: setReaction` lists
`Application` as **"Not supported."** for the channel route and for the chat route (Microsoft Learn,
[`chatmessage-setreaction`](https://learn.microsoft.com/en-us/graph/api/chatmessage-setreaction),
read 2026-09-02). So no consent an administrator can grant this app registration unlocks it. This is
a vendor limit, not unwired work.

One route stays open in principle, and OE does not take it. OE could hold a **delegated** user token
and place the reaction as that person. Rows 6 to 8 are exactly that call. §4.3 defines the verb as
placing *the agent's own* reaction, so that route reports a person's reaction as the agent's. It is
a different act, not a cheaper spelling of the same one. On that basis `react` is
`❌ vendor limit (app-only)` for Teams in §7.2, and no work is open against it.

**GitHub — the read adapter and the stop acknowledgement both landed 2026-08-22.** `read_channel`
and `read_thread` now resolve the issue-or-PR conversation the turn arrived in, on the brokered
read-scoped token (**OPE-958**). `postText`/`editMessage` now register too, so the "stood down"
note the ✋ affordance's prose relies on elsewhere has a transport here (**OPE-899**). Two gaps
remain, both permanent vendor limits rather than unwired work: no ✋ glyph (GitHub's reaction set is
the fixed eight — `+1, -1, laugh, confused, heart, hooray, rocket, eyes` — with no raised hand; the
bare `stop` comment is the affordance instead), and no file-attach (no API for attaching a file to
a comment, web upload only).

**Linear — the deepest chat surface after Slack, with one permanent split.** It has reply, react,
ancillary ops, the ✋ glyph, the cancel note, and the only `closeUnifiedSilently` arm in the tree
(its API has no invisible close, so a silence leaves one fixed host line). Its **read adapter landed
2026-08-22** (**OPE-988**): `read_channel` is the issue's topic plus its top-level comments, and
`read_thread` is one root comment and its replies — the container model in §4.6.1. The topic line now
carries the issue's state and is marked `live` (**OPE-1038**/**OPE-1039**, 2026-08-23) — the same
dated-read provenance §4.5 describes. One split is permanent: `edit_reply` covers the ambient comment
route only, because the native @mention route posts an Agent Activity and Linear's live GraphQL
schema has no mutation that updates one.

**Notion — the stop gap closed 2026-08-23 (OPE-989); the cancel note and `edit_reply` closed the
same day (OPE-1043, OPE-1046); the ✋ glyph is the one open piece, and it is a permanent vendor
limit.** `reply` works, and its **read adapter landed 2026-08-22** (**OPE-988**) in its
thread-first shape (§4.6.1). Every line it returns is now dated (**OPE-1039**, 2026-08-23), though
none is ever `live` — see §4.6.1. `react` has no primitive to wire to: Notion's public API exposes
no reaction resource for comments at all. `edit_reply` is a DIFFERENT story from `react`'s: the
public API has an update-comment endpoint (`PATCH /v1/comments/{id}`, confirmed live 2026-08-23) —
this tree's earlier claim that Notion had no update verb at all was stale — and `edit_reply`'s own
route is now wired to it (**OPE-1046**, `notion-post-arm.ts`'s `liveNotionEditComment`), the same
way `notion-message-ops.ts`'s ancillary `editMessage` already was (OPE-1043). **`stop` works**:
Notion pushes no reaction webhook either, and unlike GitHub its comment webhook carries no text at
all — a signal only — so the affordance reads a bare `stop`
comment off the same two-step fetch the ambient reader already runs, resolving the newest turn on
the page (the doc-session's grain). **The cancel note now works too** (`SurfaceMessageOps`
registered, OPE-1043): it posts as a fresh top-level comment on the page, since the acknowledgement
carries no discussion to reply into. What remains is the ✋ glyph: Notion has no reaction primitive
to place one with, the same permanent limit `react` has — there is nothing to advertise the
control with beyond the doc line above, mirroring Teams and GitHub. **`post_file` now works too**
(**OPE-1047**): each file goes through Notion's own two-step upload flow (`POST /v1/file_uploads`
to reserve a slot, then a `multipart/form-data` POST of the bytes to the returned `upload_url`),
and the resulting `file_upload` ids land on ONE fresh top-level page comment via the create-comment
`attachments` field — capped at 3 per post, Notion's own per-comment limit, refused up front before
any upload runs on a larger batch. See §7.4.

### 7.4 The file-attach finding, stated plainly

The verb exists (`post_file`) and dispatches for Slack, Discord and Notion. Every other surface
refuses out loud, naming the three that work. The three misses are not one class:

| Surface | Status | Why |
|---|---|---|
| Teams | unwired | no transport written; the vendor supports it |
| GitHub | **permanent** | no API for attaching a file to a comment; web upload only |
| Linear | **permanent** | no attach-a-file-to-a-comment mutation for an app actor |

There is a second finding underneath it. `post_file` is **not on the lean seat roster**, so a
conversational seat cannot attach a file at all on any surface — it must delegate to a worker
first. If file-attach were promoted to a core chat verb, that roster line would have to move too,
and the two questions should be ruled together.

### 7.5 Audit receipts (file:line) — re-verified 2026-08-31

Point 3 of this audit's brief: read CODE, not the existing tables, because a table can drift from
the tree that produced it. This pass re-derived §7.1's registration row and §7.2's `reply` /
`edit_reply` / `react` / `read_channel` / `read_thread` rows straight from each provider's
`register.ts` and post-arm/read-adapter files.

**Every COVERAGE cell held; the line numbers did not.** No provider has gained or lost a verb since
the 2026-08-24 pass, so §7.1 and §7.2 need no cell changed on that account. The receipts below
carried line numbers through two passes and half of them drifted each time — post arms moved with
the eve migration and the 429/`Retry-After` backoff work, `register.ts` calls moved whenever a seam
was added. So the numbers are gone: the table names the file and the symbol, which survive a
refactor that renumbers a file.

🔴 **This table names SYMBOLS, never line numbers.** It used to carry them, and half had drifted
within one release — so the numbers are gone on purpose. Grep the symbol in the named file.

| Provider | `register.ts` seams | `reply` (`dispatchReply`) | `edit_reply` (`editMessage`) | `react` | `read_channel` / `read_thread` |
|---|---|---|---|---|---|
| slack | `registerIdentityMapper`, `registerCapabilityManifest`, `registerPostArm`, `registerWakeOriginCodec`, `registerReadAdapter`, `registerReactionSurface`, `registerSeatCatchUp`, `registerWebhookVerifier` (verifier only — see [webhook ingress](./webhook-ingress.md#work-surfaces-not-communication-surfaces)) | `channels/slack-post-arm.ts` | `channels/slack-post-arm.ts` | inline in CORE, not a post-arm member — `packages/core/agent/tools/react.ts`, whose surface branch reaches slack alone | `channels/slack-read.ts` (`wakeAddress`) |
| discord | `registerIdentityMapper`, `registerCapabilityManifest` (`reactions: true`), `registerPostArm`, `registerWakeOriginCodec`, `registerReadAdapter`, `registerReactionSurface`, `registerSurfaceMessageOps`, `registerSeatCatchUp`, `registerRoutineDispatch` | `channels/discord-post-arm.ts` | `channels/discord-post-arm.ts` | `channels/discord-post-arm.ts` | `channels/discord-read.ts` |
| teams | `registerIdentityMapper`, `registerCapabilityManifest` (`reactions: false`), `registerPostArm`, `registerWakeOriginCodec`, `registerReadAdapter`, `registerSurfaceMessageOps`, `registerSeatCatchUp`, `registerRoutineDispatch`, `registerReactionSurface` (INBOUND ingest) | `channels/teams-post-arm.ts` | `channels/teams-post-arm.ts` | **absent** — no `react` member in `teams-post-arm.ts`; the vendor exposes no outbound reaction write an application identity can drive (§7.3's probe). INBOUND is a different story: `register.ts` does call `registerReactionSurface("teams")`, and `channels/teams-reaction-feedback.ts` records a reaction on the agent's own message | `channels/teams-read.ts` |
| github | `registerIdentityMapper`, `registerCapabilityManifest` (`reactions: true`), `registerPostArm`, `registerWakeOriginCodec`, `registerReadAdapter`, `registerSurfaceMessageOps`, `registerSeatCatchUp`, `registerReactionSurface` (a POLL, see §7.1), `registerWebhookVerifier` (its normalizer and scope grant register from core) | `channels/github-post-arm.ts` | `channels/github-post-arm.ts` | `channels/github-post-arm.ts` | `channels/github-read.ts` |
| linear | `registerIdentityMapper`, `registerCapabilityManifest` (`reactions: true`), `registerPostArm`, `registerWakeOriginCodec`, `registerReadAdapter`, `registerReactionSurface`, `registerSurfaceMessageOps`, `registerSeatCatchUp`, `registerEventNormalizer`, `registerEventScopeGrant` (no registered verifier — it verifies inline) | `channels/linear-post-arm.ts` | `channels/linear-post-arm.ts` (ambient route only — the native @mention Agent Activity has no update mutation) | `channels/linear-post-arm.ts` | `channels/linear-read.ts` |
| notion | `registerIdentityMapper`, `registerCapabilityManifest` (`reactions: false`), `registerPostArm`, `registerWakeOriginCodec`, `registerReadAdapter`, `registerSurfaceMessageOps`, `registerSeatCatchUp`, `registerEventNormalizer`, `registerEventScopeGrant`, `registerWebhookVerifier`, `registerNotionMemory` | `channels/notion-post-arm.ts` | `channels/notion-post-arm.ts` | **absent** — no `react` member in `notion-post-arm.ts`; Notion's public API has no comment-reaction resource | `channels/notion-read.ts` |

All six file paths are rooted at `packages/providers/<id>/agent/`, and each seam column lists the
calls that surface's `register.ts` actually makes (not its whole seam set — read the file for that).
`deliverDirectMessage` — the P2 DM transport §4.7.2 names — is a member of `slack-post-arm.ts`,
`discord-post-arm.ts` and `teams-post-arm.ts`; github, linear and notion have no such member,
matching their "n/a" cells in §7.2.

The §2.5 engagement seam's own receipts, for the §7.1 row: the core plane is
`packages/core/agent/channels/engagement.ts` — `markThreadEngaged`, `markThreadStopped` and
`shouldDeliverReply` (the `stopped` flag is its last disqualifier). Slack calls it from
`slack-events.ts` and `slack.ts`; Discord from `discord-gateway.ts` and
`discord-post-arm.ts`; Teams from
`teams-engagement.ts`, which `teams-front.ts` and `teams.ts` both call (OPE-1500). GitHub, Linear
and Notion each reach it through one translation module of the same shape —
`github-engagement.ts`, `linear-engagement.ts` and `notion-engagement.ts` (OPE-1501).

🔴 **Grep for `stopped` in a provider and you will find hits that are NOT this marker.** Every
provider's stop arm uses the same word for the §4.8 cancel outcome — in `linear.ts`,
`notion.ts` and `github.ts`, and more inside each `*-stop.ts`. The name collision is what
makes the seam look wired on a surface that never wires it, so match on the engagement functions
above, never on the word.

The tier-P1/P2 mount predicates and their core-side receipts, by symbol: `chatWriteMount` gates
`post_message`'s tool mount (`packages/core/agent/tools/post_message.ts`), resolving through
`packages/core/agent/access/chat-write-grant.ts` (§4.7.1's OPE-1106 domain-grain fix lives there, in
`callerDomainKey`). `chatDmMount` gates `dm_person` the same way
(`packages/core/agent/tools/dm_person.ts`), over the sibling `chat-dm-grant.ts`. `react`'s
per-platform capability gate reads `capabilitiesForPlatform(...).reactions`
(`packages/core/agent/tools/react.ts`). GitHub's `search` half registers ungated through
`registerCoreWorkSearchAdapter` (`packages/core/agent/scm/github-search.ts`), confirming §4.7's
claim that GitHub's SCM plane bypasses provider selection.

### 7.6 `stand_down` — the two refusals, and why the second one exists

The verb mounts on every surface and can only work where the engagement registry holds a row for the
conversation. It therefore has two honest refusals, plus the DM-family guard, and between them they cover every
surface. All are §3's second shape: copy that tells the model to report that it could NOT stop
following.

**Refusal one — no anchor.** `stand_down`'s anchor is `binding.engagementKey ?? binding.threadTs`
(`tools/stand_down.ts`). Only Slack's mapper sets `threadTs` (`slack-identity.ts:121`); every other
mapper sets `engagementKey` — Discord the channel id (`discord-identity.ts:124`), Teams the
conversation id (`teams-identity.ts`, OPE-1500), GitHub `owner/repo#N`, Linear the issue id and
Notion `<workspace>/<page>` (OPE-1501). A turn that carries neither — a Teams 1:1, or a delivery too
under-identified to name its container — makes the verb throw before it marks anything.

**The DM-family guard, and why it is no longer decided on mode alone.** A 1:1 chat refuses on
`binding.mode === "dm"`, before any anchor is considered: every provider's DM wake dispatches
unconditionally, so no gate would ever read the marker, and a 1:1 has no @mention to come back
through. A GROUP conversation (`mpim`) asks the surface instead of assuming: it refuses **unless the
mapper published an `engagementKey`**, because a mapper publishes that field only where its own gate
reads the row. A Teams group chat therefore stands down; a Slack mpim and a Discord group DM still
refuse. `threadTs` deliberately does not count here — a Slack mpim reply carries one, and honouring it
would mark a row Slack's unconditional mpim wake never reads.

**The two refusals say different things, and they have to.** The 1:1 copy names its own platform
truth: a DM has no @mention to bring the agent back. That is false about a group DM, which can be
@mentioned — so the group branch carries its own sentence naming the real cause, that this surface
answers every group message without consulting the registry. Reusing the 1:1 wording would have sent
a person in a Slack group DM after a remedy that does not exist.

**Refusal two — an anchor, but no row.** On every surface an anchor normally exists (a Teams 1:1
excepted, which refuses above), so the mark runs. `markThreadStopped` reaches `OperationalStore.markStopped`, which sets the flag on an
**existing** row and returns **false when the thread has no row**; it never inserts one, and only
`markThreadEngaged` — a mention or an earned reply — ever does. A conversation the registry never
enrolled therefore takes the mark and keeps nothing. The verb reads that return and throws, naming
the remedy: addressing the agent enrols the conversation, so a second ask lands on a row it can
mark. The audit row is written first and stamped `marked: false`, so the trail records the attempt.

**This was the audit's one behavioural finding (OPE-1333), and the fix is the second refusal.** The
tool used to ignore `markStopped`'s answer and return `standingDown: true` regardless, so the model
told the room "you won't be woken by messages in this conversation" while nothing had been marked.
§3 forbids a success answer for something that did not happen, and the same file already applied that
rule to refusal one. `scripts/stand-down-anchor-test.ts` now drives both refusals and, in the same
run, the enrolled conversation that still succeeds — so a guard that simply refused every Slack turn
would fail the suite.

**The ambient supervisor on the three ticketing surfaces, and how the registry now reaches it
(OPE-1501).** GitHub (`github.ts`), Linear (`linear.ts`) and Notion (`notion-webhook.ts`) each run an
ambient leg behind the per-domain `ambientSupervisor` flag, which is on by default since OPE-2409 and
off where a domain sets `ambientSupervisor: false` (`memory/domain.ts`). That flag still decides whether the leg runs on an unenrolled container. What
changed is both edges of it:

- a container `stand_down` marked is DROPPED on that leg, so the verb is a stop the loud path
  honours rather than one it ignores; and
- an ENGAGED container's plain follow-up is admitted even where the flag is off, because somebody
  addressed the agent there — that is the §2.5 posture, and it needs no domain opt-in. On Linear and
  Notion that admission happens on the ambient leg itself. On GitHub it happens on the NATIVE leg
  (the ambient leg returns on the flag first), and only on a private repo and outside an inline
  review thread — see §2.5.

Notion adds one more, and it is what makes the seam reachable there at all: its ADDRESSED leg used
to sit behind the same flag, so a page that had not opted into ambient could not be addressed —
deaf, not merely un-followable. A name-drop now answers on a page one of the operator's own domains
DECLARES, ambient flag or not. The declaration is the floor: a page in no domain still does nothing,
because the ingress's scope fence admits an unclaimed page by design and would otherwise open every
page the integration can see.

On GitHub the two legs also partition, exactly as they already did for an @mention: where the native
leg owns mentions it owns engaged follow-ups too, and the ambient leg drops them rather than
answering the same comment twice.

🔴 **What that does NOT cover, on these three as on Teams.** The `stopped` flag lives on an
engagement row, and only an address writes one. An ambient wake in a container nobody ever addressed
the agent in still runs, and `stand_down` refuses there for want of a row. Turning off undirected
watching is an operator action — un-vouch the surface, or take the domain off the ambient flag — not
a verb.

**Teams was the fourth, and is now the PARTIAL case — the partial half is the point (OPE-1500).** The
single-window front's Leg A (`teams-front.ts`) wakes on non-mention channel messages. It does NOT
read `ambientSupervisor`: no file under `packages/providers/teams` calls `ambientSupervisorEnabled`,
and `windowedSupervisorEnabled` (`memory/domain.ts`) reads only the seat domain. It has three
requirements instead: the `window.topology` gate, which the schema ships on
(`packages/core/agent/settings/settings.ts`, `SETTING_SPECS.window.topology`); an explicit `reach` domain, because a pseudo-domain never
windows; and an operator vouch of the channel. Teams also needs the tenant to grant the
`ChannelMessage.Read.Group` RSC permission, or no non-mention message reaches the front at all.

The seam's stood-down check now sits ABOVE both legs in the front, so a suppressed activity is
neither diverted into the window nor forwarded to the native path — `stand_down` silences Leg A and
Leg E together. `teams.ts`'s mention gate asks the same seam, which is what lets an engaged
conversation's plain follow-up run a turn on the native path at all.

🔴 **Leg A's undirected wake has its own stop now, at its own grain (OPE-1511).** That check reads a
CONVERSATION row, and only an @mention writes one — so on its own it covered the case where somebody
invited the agent into a conversation and then asked it to leave, and left the undirected wake with
no verb a person in the room could reach. Leg A therefore stores a ROOM-grain row on every ambient
wake and reads that row's flag before it diverts; `stand_down` marks the room row when the
conversation grain holds nothing, and an @mention clears it. Un-vouching the surface, or taking the
domain off the unified-window grain, is still the operator's switch — it is no longer the only one.

**The room-row WRITE is best-effort, so a stop can miss its row.** The front runs the write inside
`waitUntil` and swallows a store error, because a failed watch row must never fail the turn. A lost
write therefore costs the STOP, not the wake: `stand_down` finds no room row and refuses, and the
next ambient wake re-creates the row. A person asks again and the second ask lands.

**The two grains overlap in one direction, and only one.** A CONVERSATION stop leaves the room row
alone, so the rest of the room keeps waking — that is the point of keeping two grains. A ROOM stop
also silences an **engaged** conversation's ambient follow-up: that activity resolves `deliver` at
the conversation gate, falls through it, and is dropped by the room gate below. So a stop asked for
in one reply chain quiets a chain whose people did invite the agent. That is the honest reading of a
room-grain ask, it is what `stand_down`'s room copy says out loud ("anywhere in this room"), and it
errs toward silence, which is the safe direction for a wake gate. An @mention in either chain lifts
it.

🔴 **The residual, stated so nobody reads more into it.** Somebody standing down INSIDE a conversation
they invited the agent into stops that conversation, not the room: the primary mark succeeds, so the
fallback never runs, and Leg A keeps waking on other chains. That is the right default — a stop said
in one thread is not an instruction about the whole channel — but there is no way to say "the whole
room" from inside an engaged thread. Nothing on the other three ambient surfaces changed: they store
no room row, so the paragraph above them still describes them exactly.

---

## 8. What is ratified and not yet built

Nothing in §4 is ratified-and-absent today. Every verb described above is live, `search`,
`post_message` and `dm_person` included.

What remains ruled but unbuilt sits OUTSIDE §4, and is named here so nobody reads the ladder as
finished:

| Piece | Ruling | Ticket |
|---|---|---|
| tier P3 — posting outside the caller's own domain | deliberately **no config spelling**; revisit only with evidence from a real deployment | OPE-1064 |
| person-targeted PROACTIVE delivery (a routine firing into a DM) | ruled to land AFTER the tier-P2 stop exists, which it now does | OPE-893 |

---

## 9. Checklist for a new chat provider

In build order. Steps 1–4 are the floor: a provider that stops after them can hold a conversation.

1. **Identity mapper** — resolve partition, mode and visibility from the raw event, fail-closed.
2. **Wake-origin codec** — validate and derive your stored origin shape.
3. **Post arm** with `resolveTarget` and `dispatchReply`, plus `dispatchUnified` if your surface can
   join a unified window. Add `splitText` if your platform has a message cap.
4. **Capability manifest** — declare `midTurnPost: true` only once step 3 actually posts.
5. **Read adapter** with `readChannel`, `readThread` and the **required** `wakeAddress`. Add the
   optional `refutedAuthorIds` by handing your per-author evidence to the shared join; never write a
   second join.
6. **Ancillary ops** — `postText` and `editMessage` are required by the interface. Add `setReaction`
   and `postFiles` only if the primitive is real.
7. **Post-arm `editMessage`** — or leave it absent, and `edit_reply` will refuse out loud with copy
   naming your surface.
8. **Post-arm `react`** plus `reactions: true` in the manifest — or leave both, and the verb stays
   absent.
9. **A stop arm** — parse your own event, check the actor fail-closed, hand the keys to the one
   shared cancel path. If your vendor pushes no reaction event, find the honest equivalent; do not
   poll.
10. **`deliverDirectMessage`** if the agent should be able to reach a person privately — the
    governance DM-delivery arm and the identity-linking flow both need it, and both refuse
    fail-closed without it.
11. **The ambient engagement seam** (§2.5), which §10 item 5 rules onto every surface: engage on the
    mention, ask `shouldDeliverReply` on a non-mention message, and honour the `stopped` flag. This
    is no longer optional. A platform that cannot carry it gets an **unsupported** declaration with a
    named platform reason, and a lint reds a silent gap (OPE-1499). 🔴 Know the trade before you wire
    it: the seam is what makes `stand_down` work, and half a seam makes it refuse for want of a row
    instead (§7.6). Set an anchor only if you also enrol the conversation.
12. **Friendly names** (§4.12.1). Post only through your registered arms and your one write seam,
    run the matching payload guard in that seam for any card or notice that bypasses the arms, and
    register a name resolver (`registerFriendlyNameResolver`). Add your surface to
    `scripts/friendly-names-test.ts` so a raw id on your wire reds the suite.

Nothing on this list mentions your vendor by name inside core. If a step cannot be taken without a
core change, the seam is wrong and the seam is what should move.

---

## 10. Open decisions

Everything above is either ratified or built. This section is different: it is the audit's own
list of calls this doc cannot settle by itself. An item marked **RULED** carries the decision
and the reasoning behind it. Every other item is a **proposal** with a recommendation, and it
changes no behaviour until it is ruled on.

1. **Teams file-attach — worth the transport?** §7.4 marks it "unwired; the vendor supports it" —
   the one file-attach gap that is not a permanent limit. *Recommendation:* low priority unless a
   real deployment asks for it; Slack, Discord and Notion already cover the common case.

2. **`post_file` and the lean-seat roster, ruled together.** §7.4's second finding: `post_file` is
   worker-only today, so a conversational seat cannot attach a file without delegating first. If
   file-attach is ever promoted into the core verb family (§6 currently keeps it extension-tier),
   the roster question has to be decided in the same ruling, not as a follow-on. *Recommendation:*
   leave both as-is until a concrete use case argues for promotion — promoting the verb without
   moving the roster line would ship a verb the seat can declare but never call.

3. **Person-targeted proactive delivery is now unblocked.** §8 records this as "ruled to land AFTER
   the tier-P2 stop exists, which it now does" (`set_dm_delivery`, §4.7.2, built). Nothing currently
   in the tree schedules a routine into a DM. *Recommendation:* this is ready to build whenever it is
   prioritized — flagging it here because §8's "unbuilt" framing undersells that its one precondition
   already shipped. One correction from the 2026-08-31 pass, because it cuts the other way from what
   §4.11's table alone suggests: `dm_person` is absent from the durable-job kit, but a plain routine
   fire is **unrestricted** (§4.11), so nothing blocks it there today. The reason no routine DMs a
   person is that none is written, not that a gate refuses one. Building this means ruling on what an
   unattended fire may send, not only on how to schedule it.

4. **Tier P3 (posting outside the caller's own domain) — still deliberately no config spelling.**
   §8 restates the ruling: revisit only with evidence from a real deployment. *Recommendation:* no
   action; listed here only so the decision list is a complete inventory of everything §8 defers,
   not a partial one.

5. **RULED — the engaged seam ships on every surface.** *The rule:* surface
   parity is machine-checked. The engaged seam — a mention or name-drop marks the thread engaged, a
   plain follow-up in that thread wakes the seat with no new mention, and `stand_down` stores the
   stop — is a capability every surface offers.

   *The work owner:* the parity arc, tracked in Linear (parent OPE-1498). Teams took the seam first
   (OPE-1500), then GitHub, Linear and Notion (OPE-1501), which completes the six. Each provider
   declares every capability supported or unsupported with a named platform reason; a lint reds a
   silent gap; §7.1 is a generated table; a `supported` declaration must pass a contract test
   (OPE-1499).

   *Why the ambient leg does not settle it.* The ambient leg and the engaged seam are different
   mechanisms. GitHub, Linear and Notion gate the ambient supervisor on the per-domain
   `ambientSupervisor` flag, which is ON by default since OPE-2409 and off where a domain sets
   `ambientSupervisor: false` (`memory/domain.ts`). Teams does not read that flag: its Leg A needs
   the `window.topology` gate, an explicit domain, and an operator vouch. So on a default install
   GitHub, Linear and Notion wake on a non-mention message THROUGH THEIR AMBIENT LEG (behind each
   surface's own floor), and Teams does not. The engaged seam is the exception on all four: an engaged
   conversation wakes on a plain follow-up with no domain opt-in and no vouch, which is the ruled
   capability of item 5. GitHub carries the one floor on that exception — its follow-up arm runs on
   the native leg and refuses a public or unknown-privacy repo, and an inline review comment (§2.5). The ambient leg also stores no engagement row, so it gives `stand_down`
   nothing to mark. Slack proves the two are not alternatives: it runs both.

   *The posture picture both legs sit in.* Every surface carries an **addressed leg** that is always
   on — an @mention, a Notion structured mention or name-drop, a Slack name-drop. Every surface may
   carry an **ambient leg**, on by default and off per domain through `ambientSupervisor: false`
   (`agent/memory/config/domains/<name>.ts`); Teams runs its ambient leg through the single-window front's
   Leg A once the tenant grants `ChannelMessage.Read.Group`. **Unified posture** (`mode: "unified"` —
   every message in a domain reaches one session and inference decides) is the primary posture being
   built. Mention-only is the eve-native fallback.

6. **RULED — a person needs no per-conversation off switch on a surface with
   no engagement registry.** *The rule:* add no stored stop to GitHub, Linear or Notion.
   *The reasoning:* a stored stop exists exactly where a stored wake exists. Slack, Discord and
   Teams keep the stored wake in the engagement registry, so `stand_down` (§4.10) writes the stored
   stop into that same row. That arc is now complete: GitHub, Linear and Notion enrol through
   `markThreadEngaged` too (each via its own `<surface>-engagement.ts`), so the stored stop arrives
   on all six through the same registry, and `stand_down` refuses where the registry never enrolled
   the conversation — on top of its two standing refusals, a 1:1 DM and a group conversation whose
   mapper publishes no `engagementKey` (§4.10). So no separate off switch is built.

   🔴 **Known limit 1 — a stop is durable only where the conversation holds a registry row.** A
   stored stop survives a new session; a context-held instruction does not.
   `channels/runtime-rotation.ts` retires a standing seat's durable session on the first wake
   whose running code — or whose domain declaration — differs from the one the seat was last served
   with, and the fresh generation reads none of the earlier conversation. Every surface now writes
   that row when the agent is addressed (OPE-1500, OPE-1501), so a stop in a conversation somebody
   invited the agent into survives a rotation. A conversation nobody ever addressed it in holds no
   row, so `stand_down` refuses there rather than storing a stop that would not survive.

   **Known limit 2 — no verb mutes a whole domain.** `stand_down` marks the engagement-registry key,
   which is a thread on Slack, a channel on Discord, an issue or pull request on GitHub, an issue on
   Linear and a page on Notion (§4.10). Nothing in this contract reaches
   wider than that key. No verb and no declaration mutes a whole domain in one act. The nearest thing
   is a per-room declaration, which the room-config plane owns rather than this contract, and a
   deployer applies it one room at a time. That plane silences a room on
   `externalPolicy.roomGrain: "silent"`, and only for a room the external class already covers
   (`access/external-policy.ts`). The shipped pair is `withhold`/`silent`, so a room the external
   class covers is silenced unless the deployer opts out to `engage`. A room outside that class is
   never silenced.

No provider code was touched to write this section — §7.5's receipts are read-only observations of
the code as it already stands. Two of the six items since changed code or will. §7.6's finding named
a defect rather than a decision, and `stand_down` now refuses when its mark lands on no row. Item 5
ruled the engaged seam onto four more surfaces, and all four are built: Teams took the seam first
(OPE-1500), then GitHub, Linear and Notion (OPE-1501). Nothing in §8 tracks it any more.

---

## See also

- [Provider bundles](./provider-bundles.md) — the registration seams and the package layout.
- [Surfaces](./surfaces.md) — the channel wrap and the identity binding.
- [Webhook ingress](./webhook-ingress.md) — the event-ingress plane a work surface adds on top.
- [Identity](../how-it-works/identity.md) — how a binding becomes a partition.
- [Glossary](../glossary.md) — **container fence**, **channel key**, **seat**, **worker**.
