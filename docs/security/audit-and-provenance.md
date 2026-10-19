# Audit & provenance

How you know what the agent did, and how the config that governed it got there. Two records, kept separately and on purpose: an **append-only audit trail** for the agent's runtime actions, and **git plus deploy history** for every change to its configuration.

## The two records

| Question | Answered by |
|---|---|
| *What did the agent do at runtime?* | the append-only audit trail (operational store) |
| *What was it allowed to do, and who decided?* | git history + deploy history |

Keeping them apart matters. Runtime actions are mutable, high-volume events that belong in a queryable database. Config is a deliberate, reviewed, low-volume change that belongs in version control where it gets a diff and a reviewer. Each is the right system-of-record for its own kind of fact, and they reconcile rather than overlap — the audit DB can mirror to git, never the reverse.

## The audit trail

Every consequential action is recorded with **who / what / where / when**:

- **who** — the acting principal (the human the action attributes to, resolved from the surface identity). A reply names that person on both of its routes: a per-surface chat seat reads the principal its channel captured when the turn started, and the cross-surface window reads the principal of the delivery its reply answers. Two honest bounds, both measured. A reply on a turn **the host itself woke** — a delegated task's own reply, a completion wake, a redrive — carries no principal, because that delivery authenticates no person. A reply on a **routine or webhook fire** names the service principal that delivered the fire, not the human who created the routine. In both cases the WHO stays reachable: the same turn's `egress.policy` row names the person, and the row's own `detail.sessionId` opens the transcript.
- **what** — the action and a structured detail object
- **where** — the org, platform, workspace, and surface
- **when** — an ISO timestamp

### What's logged

- **Memory writes** — every durable write to a memory silo.
- **Egress and connector grants** — when a session's network policy is compiled, and when a connector grant is resolved for a surface.
- **Consequential tool actions** — the per-action record a *tool* emits from its own execution: opening a PR, creating or cancelling a routine, and admin mutations. This is the `tool-action` audit, distinct from the session-level grants above — it captures an outward or consequential action at the moment the tool takes it, stamped with the same who/where, resolved from the tool's context.
- **A refused per-surface read** — audited on all three of the gates a read runs (see [Security model § A cross-surface window reads only the surface that woke the turn](./security-model.md#a-cross-surface-window-reads-only-the-surface-that-woke-the-turn)): the roster gate writes `read.refused` (`channels/read-scope-audit.ts`), the sources gate writes `<platform>.sources_refused`, and the per-turn origin fence writes `<platform>.origin_refused` (both the latter two from the same file's `auditSourcesGateRefusal` / `auditOriginFenceRefusal`, called from each read tool's `execute`). `<platform>` names the target the read was refused, never the turn's own surface. `workspace`/`surface` name that same subject: on today's single-platform reads the caller IS the refused platform, so they carry the caller's real ids; once a caller's real platform (Slack, say) differs from the row's `platform` (a cross-plane work grant reading Linear, say), `workspace`/`surface` are stamped `"unknown"` instead of a foreign platform's ids — an operator filtering `platform=linear` must never see a Slack team id in the workspace column. On a `read.refused` row no identity is lost: `detail.callerSurfaceKey` names the caller's real platform/workspace/surface. The two fence rows carry less — `detail.origin` names the caller's **platform only**, so a `sources_refused` or an `origin_refused` row does not say which of that platform's workspaces or surfaces asked. Join those two through `detail.sessionId` when you need the caller's room.
- **Actions are audited; silence is not (with three carve-outs).** The log records what the agent *did* — every reply, every PR, every memory write — not every turn it stayed quiet on. On an ambient chat surface an agent replies to a small fraction of messages, so auditing judged silence would make the table ~99% no-op rows; the actions-only posture keeps it a log of decisions taken. "Why did it stay quiet in #general on Tuesday?" is answered instead by the **session transcript** (`GET /control/v1/session/:id/transcript` — fail-closed, bearer, self-audited, read-only), joined from any nearby audit row's `detail.sessionId`, where every judgment, wake envelope, and trust verdict lives. The split is deliberate: **the audit log records what it did; the transcript records why.** A reply is **one action, one row**: it posts through a single choke point (`postReply` / `postUnifiedReply`, `channels/reply-post.ts`) that writes exactly one `reply.post` row at the moment the bytes leave, and `detail.route` says *how* it was posted. On the cross-surface door the row also carries `detail.done`, the `reply` tool's own `done` input: `false` on a hand-off note posted over work that has not reported, `true` on the answer. A row with no `done` key came from a post that carried no intent. A **worker** of the conversation's work session posts through the per-surface `reply`, which takes no wake argument. Its row still carries `detail.wakeId`: the wake of the seat conversation that forwarded the job, which the host stamped on the forward (`oe_work_seat_wake`). So a delegated fire's answer joins back to the fire on `wakeId`, as a seat's answer does. One case names another job's wake: when the work session starts two jobs in one step, one job's worker can inherit the other job's stamp (`hooks/work-task-key.ts`). The `work.task_keyed` row then carries the mismatch verdict, and that worker's rows name the other job's wake. The stamp is written to the `reply.post` and `reply.edit` rows only. It changes no dedupe, cover-label or should-be-edit decision. ONE value is live — `"tool"`, the model calling the `reply` tool mid-turn — because the agent always answers through that tool. Two values are RETIRED and still appear on rows written before they were: `"bridge"` (the single-window prose bridge) and `"terminal"` (a per-surface chat seat posting the model's ending turn text). Both planes are deleted, so a seat's closing prose is now dropped and recorded rather than posted. The row's **`platform` column names the surface the reply landed on** — `slack`, `linear`, `github` — on every route, never the door it took. So `GET /control/v1/audit?since=<iso>&platform=linear&actions=reply.post` counts every reply that landed; `detail.route` is the only field that names the door. The rows that ride beside it file under that same surface: `reply.post.failed`, `reply.provenance`, and `reply.edit`. The host-verdict rows are told no surface, because nothing landed — `reply.refused`, `reply.forced` and `reply.edit.refused` stay on the turn's **own partition** instead. On a **routine or webhook fire**, the reply is never attributed to the routine's creator: `principalId` names the poster, and `detail.creatorId` additionally names the fire's attested creator when the routine has one, so the audit trail names the human who owns the automation without a join to the routine row. It is absent on a webhook fire and on a creator-less routine, which genuinely have nobody to name. A fire is a work request, so the reply that posts its result is the domain seat's, on the fire's result wake: `principalId` is the seat's binding, and the result wake carries the creator for this field alone (`WORK_FIRE_CREATOR_ATTR`, `agent/identity/binding.ts`), so it changes nothing the seat's turn binds as. On the one fire that still runs as a thread seat (a fire whose auth names no surface), `principalId` is the schedule/service principal. **The tool route stamps it**, through `replyAuditFor`, which reads it off the tool ctx — and that is the only door that writes this row, so a fire that owes an answer names its creator exactly when it answers through the tool. A fire that ends in closing prose posts nothing to name it on. The mid-turn `reply` path is how **every seat** answers: a single-window seat's closing prose is dropped and re-driven once, and a per-surface seat's is dropped and recorded, so every reply is a `reply.post` with `route:"tool"`. **Every ticketing supervisor answers the same way**, and so does every chat seat: GitHub, Linear and Notion each carry a real mid-turn post arm, so their turn-final prose is dropped exactly as a chat seat's is. They still write their own `<platform>.replied` lifecycle row alongside it — that row closes a `<platform>.dispatched` row and carries `route:"tool"` and no `chars`, so the two families answer different questions and never double-count the bytes. **The one silence carve-out — a row closes a row.** The ticketing surfaces (GitHub, Linear, Notion) open an audited `<platform>.dispatched` lifecycle row when a webhook dispatches a woken session, so its terminal outcome — including a declined `<platform>.no_reply` — must close it, or a dispatched-then-declined issue is indistinguishable from a hang. A **third** terminal outcome closes it too: when the turn wrote an answer as its closing text and never called `reply`, nothing is posted and the surface writes `turn.supervisor_prose_dropped`, carrying the reply anchor and the lost answer's length as a count. That is the one outcome where an answer existed and no reader received it, so it is the one the log must state rather than leave as an open dispatch. **The chat surfaces write that same row**, from `dropClosingProse` (`channels/closing-prose-drop.ts`), and there it is the whole record rather than the close of a dispatch: chat and ambient wakes open no lifecycle row, so they owe no terminal silence row, but an answer that reached nobody is still countable. (For local eval targets that score abstention, the chat/unified silence rows are restored by a test-only hook in core. Core ships no setting and no environment variable that arms them, and no committed production module in this repository calls the hook — a test scans for one. So core never writes them on its own.) One row stays on even then: calling the `no_reply` tool always writes a small, ALWAYS-ON `reply.no_reply_observed` row (OPE-649) — the closed reason only, never the free-text explanation — so a specific silent turn (a Slack name-drop wake, say) stays observable and testable in prod's actions-only state without reopening the full silence plane. The SAME action name covers the other silent route too: a turn that ends on the bare NO_REPLY sentinel with no tool call writes the sentinel route's own always-on `reply.no_reply_observed` row, `detail.route: "sentinel"` instead of a closed reason (OPE-890, on Slack/Discord/Teams). OPE-895 extends this to the single-window unified path (`channels/unified.ts`), whose own richer `unified.no_reply` row stays gated behind that test-only switch — only this minimal twin is unconditional there, and it also carries `detail.wakeId`, because one unified session is a STANDING window spanning many turns and `sessionId` alone cannot tell them apart. **A silence nothing explains is not a silence.** A turn that woke, ended with an empty final message and took no terminal verb at all — no `reply`, no `react`, no `no_reply`, no sentinel — is a judgement that went missing, not one that was made. It writes an always-on **`turn.bare_stop`** row naming the session. The unified window's row also names the wake it left unanswered. The native Slack row names the thread instead, so a wake id is not what you join on there. The row was already written on the native Slack channel; OPE-1006 adds it to the unified window, which is the road every windowed surface actually travels, so on prod's actions-only posture such a turn now leaves a row instead of nothing at all. **The second carve-out — an autonomous fire.** A [routine](../capabilities/proactivity-and-routines.md#did-my-0300-routine-actually-run) runs with nobody in the room, so there is no conversation to reconstruct it from: a fire that stayed silent, was declined, or was lost in delivery would otherwise leave *zero* rows and be indistinguishable from a fire that never happened. So a fire writes a `routine.fire` row whatever its outcome (naming the routine **and** the session, which is what makes the transcript reachable from a routine id at all), and a non-dispatch writes a `routine.skip` or a `routine.fire_lost`. Only the first of those is rate-limited — one row per (routine, reason) per hour, and a suppressed row is counted onto the next one it emits. The collector-failure row uses the same hourly mechanism under its own per-routine key, so the two never suppress each other. Read a `routine.skip` count as one row per distinct reason, never one per routine. A `routine.fire_lost` writes every time, because a delivery the adapter rejected is not a repeating condition to throttle. This is not "audit every silence" reopened: nothing is written per *tick*, per *deferral*, or per *not-yet-due* routine — only per fire an operator asked for. **The third carve-out — a seat that can no longer answer.** When a long-lived session reaches the runtime’s configured per-session token bound it does not fail; it *parks* on an input request nobody is there to answer, and an unhandled park is a seat that silently stops replying forever — the one failure mode an actions-only log would never surface, because its symptom is the *absence* of rows. So a park writes a rate-limited `session.token_limit_park` row naming the session, the bound it hit, and what Open Everywhere did about it: `remedy: "rotate_on_next_wake"` when the seat’s generation was retired so the next message starts a fresh session, `"already_rotated"` when no live registry row matched the park or the retire itself threw, and `"none"` for a thread that cannot be rotated and needs a fresh thread instead. The same action also covers a **cost** bound as well as the token one, and `detail.kind` is what tells the two apart. **The fourth carve-out — a reply the host refused.** In a cross-surface window a `reply` must name the `wake-id` it is answering, and the host refuses any id this session does not hold. A refusal is an attempted action whose only observable result is that the room hears nothing, so on an actions-only log it is indistinguishable from judged silence — the same absence-of-rows problem as a park. So a refused `reply` writes a `reply.refused` row carrying `reason` (`mismatch` / `expired` / `answered` / `answered-this-turn` / `declined-this-turn` / `delegation-pending` / `stale-conversation` / `should-be-edit` / `stopped` / `task-wake-unread`), the `route`, and the rejected wake-id. That is what makes the failure legible: a hallucinated id, an expired conversation, or untrusted payload content steering a triggered fire at an id it does not hold all show up as rows to count rather than as a routine that merely went quiet. `answered-this-turn` is its own reason because it counts a different thing — the model answered a wake with `done: true` and then, in the same turn, tried to answer it again. That is the double-post habit, refused before the second post leaves. **The refusal is a valve, not a wall.** It fires once per turn per wake, the same `force: true` overrides it, and an override writes `reply.forced` with `answered-this-turn-forced`. A second answer is discouraged, never blocked. **One route keeps the wall**, and it is the route where a second answer cannot be delivered at all rather than merely being unwanted: a Linear mention reply is a `response` agent activity, which ends the agent session it answers, so the same reason refuses every repeat there and reads no `force`. `stopped` counts a post into a conversation the agent was asked to leave, and it is the one refusal with a partner row. A stand-down allows exactly one post — the acknowledgement the person is owed — and where that post goes through the **`reply` verb** it writes **`reply.stand_down_ack`** beside its ordinary `reply.post`, carrying the engagement anchor, the session, and which arm of the verb posted it. The anchor is what makes the row joinable: the partition names a surface, and on Slack that is a channel holding many threads, so the anchor is the only value that pairs this row with the `engagement.stood_down` and the `reply.post` for the same conversation. **The row separates two doors, not two intentions.** It is written only where the poster read the stored stop, so a `reply.post` without one was made by a door that did not — and that is not by itself a violation: on Linear's native arm, the one seat left whose closing prose posts, the acknowledgement *is* the turn's final text, emitted by the framework's own poster, which reads no stop and writes no ack row. That post is the acknowledgement the person asked for. Every post after the allowed one draws the `stopped` refusal and ends the turn. **`stopped` also withholds a dropped turn's prose**, which is what the drop row's `reason` names, so a refused acknowledgement on the unified window is legible as a host decision rather than as ordinary silence. A plain `answered` is an earlier turn's wake. That one is also refused outright, and the fence's own arm does resolve and validate the conversation first — it refuses on the answered mark itself, not for want of an address — so `force` is not read there either. `declined-this-turn` counts the opposite contradiction: the model called `no_reply` for a wake and then, in the same turn, replied to it anyway. That is not a habit the model chose. The runtime reads a step that produces nothing as a failed reply and reissues the call telling the model to answer now — but it no longer does so after a CONFIRMED terminal verb (`no_reply`, `reply`, `react`, `edit_reply`), where an empty step is the correct end of the turn. A terminal verb whose platform call FAILED does not count: the nudge is what gets the answer into the room after a failed post, so suppressing it there would lose the answer outright. The row stays as the belt: it makes any remaining pressure countable, and the refusal keeps the unwanted message out of the room. `delegation-pending` counts a third habit: the turn started a background worker for this conversation, has not received its report, and tried to close the wake anyway with an answer it does not hold. The refusal names the honest move (post with `done: false`), so the seat keeps talking and the worker's real result can still land. On a single-window seat there is no second door behind that refusal: the turn's closing prose reaches no room, and the one corrective redrive is what can still get the answer there. That is the one refusal the correction fires on, so its text names the move that succeeds — call `reply` again, with `done: false`. **That exception is `delegation-pending`'s alone.** Every other refusal that says *do not put this text in this room* — `stale-conversation`, `should-be-edit`, `declined-this-turn`, `answered-this-turn` and `stopped` — also WITHHOLDS the turn's dropped prose, on the wake it was owed to, and suppresses the one corrective redrive: a refusal is the host's decision, and nudging the model back towards the call the host just refused would be the host contradicting itself. The withheld prose writes `turn.supervisor_prose_dropped` with `reason: "refused:<the refusal>"`, so an owed answer the host withheld stays countable apart from an ambient drop, and the reader can see WHICH decision withheld it. The address refusals (`mismatch` / `expired` / `answered` / `task-wake-unread`) do not: they object to the wake-id the model named, and a dropped turn named none. `stale-conversation` counts a fourth thing, and it is the only one that is nobody's mistake: newer messages arrived in the target conversation while the turn was running, so the answer about to be posted no longer reflects the room. The host refuses the send once, the queued messages reach the seat as its next wake, and it answers them together. The model can override that with `force: true` when posting now matters more — a time-critical alert, a hand-off note — and an override writes its own **`reply.forced`** row beside the ordinary `reply.post`. The two rows are the pair an operator reads: refusals against overrides say whether the gate is catching real races or merely costing a step. The refusal itself is unchanged — the fence still admits only wakes the session genuinely holds, so the row records an attempt, never a widened reach. `should-be-edit` counts a fifth thing, and it is a matter of style rather than of safety: the agent's own last message in that room is still the newest one there, so a second post would stack where an edit would read as one message. The host refuses the send once and names the message to fold into with `edit_reply`. The same `force: true` overrides it, and an override writes `reply.forced` with `should-be-edit-forced`, so the three override reasons — `stale-conversation-forced`, `should-be-edit-forced` and `answered-this-turn-forced` — stay countable apart. **An override is one row per verdict, per wake (per room, for the should-be-edit rule), per turn.** Each of the three gates records its override the way it records its refusal, and on the same key: the `answered-this-turn` and `stale-conversation` rules key on the WAKE, the `should-be-edit` rule on the ROOM. So a turn that forces the same verdict about the same conversation again writes no further row — the trail already says the model overrode that verdict there, and repeating the row buries it — while a coalesced turn that answers three wakes and forces each writes three rows, one per wake. Read a count of these rows as a count of (turn, wake) pairs — (turn, room) for the should-be-edit rule — that overrode a verdict, never as a count of messages. Two messages in one thread answered by one coalesced turn are two wakes, so they are two rows — the `reply.post` rows are the messages. **The bound is best-effort, like every per-turn signal on this path.** Where the host cannot identify the turn — no turn id, an unwritable turn slot — the record answers "first override" every time, so the rows repeat and no turn is ended. That is the deliberate fail direction: a turn is never ended on a signal the host cannot prove. Past the second override of one verdict in one turn the host ends the TURN on the next model round-trip, under a `turn.step_boundary` row with `tier: "closed"` and `reason: "forced-override-repeat"`. Nothing is blocked by that: the message that was already written posts first, and so did every one before it. It is the loop that ends, not the second message. The policy is off wherever the host holds no record of what the room last heard, and off on a surface with no edit API — refusing there would leave nothing the agent could do instead. It is also off when the previous post answered a **different** message: when several messages arrive at once the agent answers them one at a time, and the answer to the second is a new reply rather than an addition to the first. It is off, too, on any message the host did not record an answered-message id for: a fold needs positive evidence that the two answer the same message, not merely the absence of a contradiction. That turns it off entirely on a reply route whose posts carry no such id. **A post that never landed is its own action.** A `reply` that reached the platform and failed writes **`reply.post.failed`**, never a `reply.post` — the delivered-message count the eval scorers join on must stay a count of messages that reached the room, and before this row a failed post wrote nothing at all. That is the same silent hole `platform-error` closed on the edit path. The row carries `reason: "platform-error"`, the target platform, the HTTP status the surface returned when it gave one, and `detail.failure` naming the class the host acted on: `definitive` when the platform proved nothing reached the room, `ambiguous` when the message may already be there. The class is not cosmetic. On a definitive failure the host releases the post's short-lived dedupe claim, so the model's identical retry really posts; on an ambiguous one the claim stands, so an identical retry cannot say the same thing twice. Neither class marks the turn as answered — a `reply` always leaves the turn free to try again. A failed reaction writes a matching platform-named row with the same class — **`slack.react.failed`**, **`github.react.failed`**, **`linear.react.failed`**. **An edit is its own action.** `edit_reply` rewrites the text of a message this deployment already posted, so it writes **`reply.edit`** — never a second `reply.post`, because an edit puts no new message in the room and must not inflate the post count. The row carries the same attribution a `reply.post` does (partition, principal, session, wake) plus the edited message's id, its platform and the new text's length, and never the text itself. A refused edit writes **`reply.edit.refused`** with a `reason`: `not-own-post` when the named message is not one this deployment's own reply path posted into this conversation inside the edit window, `no-edit-arm` on a surface with no edit primitive, or `platform-error` when both host fences passed and the platform itself rejected the update — that row carries `detail.status`, the HTTP status the surface returned, `detail.failure` naming the class the host acted on (`definitive` when the platform proved nothing changed, `ambiguous` when the edit may still have applied), and never a response body. Two more reasons reach the same row from the address fence the verb runs first — `mismatch` and `expired`, when the `wake-id` the model named is not one this session holds or has lapsed. So five reasons, and they split one way that matters: four are host verdicts decided before any byte leaves, and `platform-error` alone is the vendor's answer after the call. That row exists for the same reason `reply.refused` does — a refused edit's only observable result is that nothing changes, so without it an attempt to rewrite a message the agent does not own would be indistinguishable from no attempt at all. The `platform-error` reason closes the matching hole on the other side: an edit that threw at the transport once left **no** row at all, so a live Discord 404 was visible only in the session transcript. Every `edit_reply` call that reaches a resolved conversation leaves a `reply.edit` or a `reply.edit.refused`. Two cases sit outside that: a per-surface call whose conversation resolves to nothing throws without writing a row at all, and a successful edit that also carried connector reads writes a `reply.provenance` beside its `reply.edit`. It is the row an operator counts to see whether anything is steering the verb at ids it does not hold. The honest boundary: these rows cover turns a *woken session* took — a message the classifier dropped before any session woke is a runtime-log line, not an audit row.

- **A wake that never reached a session.** A wake-delivery failure — the run-key fetch or the channel `send()` rejects before any turn is queued — can surface on two paths: the windowed divert (`divertToUnifiedWindow`, `channels/unified.ts`, reached when a domain opted into cross-surface or per-channel windowing) and each surface's own NATIVE send (reached when it did not). This is not a silence: no session ran to choose one. Five surfaces write an explicit `surface.wake_failed` row naming the failure: Slack, Teams, Discord, GitHub and Linear. **Notion writes none** — a failed Notion wake still leaves only a console log line an operator would have had to be tailing already, so read an empty `surface.wake_failed` set for Notion as *not observed*, never as *nothing failed*. A wake that hits the **pruned-deployment strand** (a Vercel deployment prune — `channels/stranded-seat.ts`) also marks the seat for rotation: on Slack, GitHub, Linear and Notion this now runs on BOTH the windowed divert AND the native send (OPE-971 — a native surface's own registry key is the surfaceKey it already rotates, passed straight to the heal), and Slack's DM/supervisor routes re-deliver the same wake once into the fresh generation. When that retry ALSO fails, the row carries `detail.reason: "pruned-deployment-heal-retry-failed"` — the seat is healed for its next wake, but this member's message got no answer, and the row says so instead of reading identically to an ordinary transient blip. Discord's native guild dispatch is different: it runs on a plain per-channel/per-thread continuation token with no rotatable registry row at all, so its strand hits the heal too but resolves `remedy: "none"` — an honest audited row, not a rotation that cannot exist.

- **A stop that was accepted and never applied.** Stopping an in-flight turn writes a `turn.cancel_requested` row in the ingress, and the turn's own process closes it with a `turn.cancelled` row when the cancel really settles. The runtime answers the ingress "accepted" for a cancel it then drops, though, and a dropped cancel emits no cancellation event at all — so before OPE-1190 that pair simply had no second half, and a request nothing followed was indistinguishable from a row the store lost. It now has one: a turn that reaches an ordinary terminal event with an accepted request against it, and that no cancellation settles for within a grace window several times the observed settling delay, writes **`turn.stop_ignored`** — carrying the session and turn ids that join it back to the request, the requester, the affordance the stop came through, and `endedAs` naming which ordinary end the turn reached. The wait is load-bearing rather than defensive: a turn whose interrupted work returned rather than aborting reaches its ordinary end *before* the runtime settles the cancel, so at that instant "no cancel has settled" and "no cancel will settle" are the same observation. It is paid only by a turn somebody actually stopped. `turn.cancelled` gained the same two ids in the same change, since a pair that cannot be joined is not a pair. **Read the pair as strong evidence, not as an invariant.** In the ordinary case exactly one of the two rows follows an accepted request. Five states break that, and an operator has to know all five or the pair misleads. **Both rows** means the cancellation settled *later* than the grace window: the `turn.cancelled` one is true, the ignored-stop one is a false finding, and the room got two notes. **Neither row, yet** means the turn has not ended — both partner rows are written from a terminal arm and nothing caps a turn's duration, so a stop of a long-running turn is simply not owed a partner. **Neither row, ever** means the decision never resolved: it is drained from awaited hook arms as well as its timer — the next turn's start, and any session's park (`session.waiting`), which is the last awaited point a conversation session reaches. A drain takes only a check whose grace has passed, so the stopped turn's own park cannot resolve it, and an instance suspended before any later arm runs takes the answer with it — the platform reality `hooks/log-flush.ts` records. **Neither row, and no arm to write one**, is the request that lands *after* its turn already ended; the detection lives in the turn's terminal arm, so nothing is left to notice it. And **duplicate ignored-stop rows for one turn** are possible: the arm's own pre-check reads the audit and then appends with no transaction between the two, so two processes can each see no row and each write one. **Count distinct `(sessionId, turnId)` pairs, never rows.** The control plane reads the fourth state from the reader's side — **`unpaired_stops`** lists accepted requests holding no partner row after a grace, which surfaces the *candidates* for that class rather than measuring it, since the second state lands in the same list. At the default grace most rows are stops of turns still running; pass a grace longer than the deployment's longest turn to narrow it. Its list is per request row, so a person who pressed ✋ twice appears twice for one turn — the same distinct-pair discipline applies on that side. So an unpaired `turn.cancel_requested` is worth investigating and is not proof on its own. `turn.cancelled` is deliberately left strict — it still means the runtime really cancelled this turn — because widening it to cover the dropped case would have closed the visible gap by making a genuine cancel and an ignored stop read the same. The room copy is held to the same line: the ingress acknowledgement promises a request rather than an outcome, and the turn's own process posts which of the two actually happened.
- **A measurement row, not an action or a silence.** A cross-surface window registers a wake per
  arrival, and the reply tool's per-wake `done`/`declined` marks let a turn account for each one it
  was shown — but nothing forces it to. `turn.unaccounted_wakes` (OPE-816, stage 1 — an audit-only
  measurement pass, no enforcement) writes once, at turn end, when at least one wake this turn was
  plausibly shown
  (a pending, unanswered, in-TTL wake registered on this window at or before the turn's own wake)
  was neither replied to, declined, nor reacted to. `detail.unaccounted` names each such wake id
  with its `addressing` class — `"addressed"` for a `direct-mention` wake, `"ambient"` for every
  judged/watch tier — because an ambient wake going unanswered is expected (the room never singled
  the agent out), while an addressed one is the signal that matters. Never the wake's text, and
  never a refusal: the row only reports what the diff found.
  **A wake appears in at most one of these rows, ever** (OPE-836): each turn stamps a horizon on
  every wake it considered, so an unanswered wake is reported once instead of on every later turn,
  and a turn's own wake — which `no_reply` and `react` account for without writing a durable answered
  mark — never re-reports on the next turn. Count these rows as distinct unaccounted wakes; a
  reading taken before that horizon shipped counts turns instead. The horizon stamp lives in a column
  only the audit's own listing reads, so an already-reported wake stays pending and stays answerable —
  it changes neither the reply-freshness gate nor the answerable-reply fence.
  🔴 **Two call sites, one pass (OPE-1013).** `message.completed` (`channels/unified.ts`) runs the
  pass on every finish reason except a tool-calls one, which is not the turn's true end — another
  model step is coming. But eve does not guarantee a turn's LAST message carries any other finish
  reason: a step-ceiling trip mid-tool-call ends the turn right there, with no further generation, so
  `message.completed` never reaches the pass at all. Measured on prod: whole generations carried zero
  `audited_at` stamps. `hooks/wake-accounting-turn.ts` is the second call site — it runs the SAME pass
  off `turn.completed` / `turn.cancelled` / `turn.failed` / `session.failed`, eve's true turn-lifecycle
  epilogue, so a turn that never reaches `message.completed`'s own call is still accounted for. The
  `turn.failed` arm is the only one a RETRYABLE model failure reaches: eve 0.70 ends that turn with
  `turn.failed` and parks the session with `session.waiting`, and emits no `session.failed`. It skips while the
  turn is genuinely still paused on an outstanding approval or question (`input.requested` /
  `authorization.required`, minus eve's own session-limit park, which holds nothing open) — reporting
  a wake unaccounted while the very next turn is about to answer it would be a false positive. Calling
  the pass from both sites writes no duplicate `turn.unaccounted_wakes` row: the first call's horizon
  stamp covers every candidate it considered, so a second call on the same turn finds nothing left to
  diff. The skip row below is NOT deduped. A unified turn that cannot anchor the pass writes one
  `turn.wake_accounting_skipped` row from the channel's call site and one from the hook. The hook
  itself runs the pass once per turn, so a terminal failure (`turn.failed`, then `session.failed`)
  adds no third row. Count skip rows as calls that could not anchor, not as turns.
  **The pass's own bail is countable too.** When `windowToken` / `turnId` / `turnWake` cannot be
  resolved at all — a subagent child, an uningressed turn, a non-unified token (identity/binding.ts's
  `currentTurnId` / `currentWakeId` name the classes) — the pass cannot anchor a read and writes a
  low-volume `turn.wake_accounting_skipped` row instead, `detail.reason` naming which precondition was
  missing (`"no-window-token"` / `"no-turn-id"` / `"no-turn-wake"`). This is what makes "the pass did
  not run on this turn" distinguishable from "the pass ran and reported nothing" — the two would
  otherwise both read as the absence of a `turn.unaccounted_wakes` row.

- **A delegation, from dispatch to report.** A seat that hands work to a background worker leaves five
  rows, and together they answer "what did this seat commission, and what came of it". A dispatch
  writes **`delegation.task_started`** (the task id, the call id, eve's task kind and the tool); a
  task reaching a terminal state writes **`delegation.task_settled`** (the same ids, eve's own status
  word, and what the taint plane made of the child's marker). Those two are also the parked-worker
  census — one settled row per worker that parks until its parent generation is retired.
  **A settlement that moves the worker's SOURCES onto the seat writes `delegation.provenance_carried`.**
  Every conversational seat is worker-only for the connector ops, so the ordinary shape of a connector
  answer is a read the seat delegated — and the reply's `reply.provenance` row names the connectors a
  TURN read. Its `detail.sources` field (OPE-2487) is the reach-safe line the room used to read as a
  footer: connection names, the counts the reach rule kept back, and a record title where both
  disclosure proofs held. A record title is vendor-side text (a Linear issue's or Notion page's
  title), flattened onto one line and capped at 160 characters, and the log keeps it as long as it
  keeps the row. No room sees the line, and nothing reads it back into a turn. `detail.links`
  (OPE-2520) counts the numbered source links the reply showed, which only a 1:1 reply carries; the
  links' titles and urls are not on the row.
  The settlement carries the worker's reads into the seat's own turn, and this row counts what moved:
  the task id, the call id, how many sources, and which proof the seat could offer for the room it
  replies into. It names no connection — the reader learns that from the reply's own
  `reply.provenance` row, under the reach rule, and this row is not a second disclosure surface for
  it. `detail.outcome` says what happened: `carried`, `not-completed` when the worker died or was
  reaped before it answered, or `wake-unprovable` when the settling turn's address names another
  conversation — those sources are withheld rather than named in the wrong room, and the row is what
  makes the withholding countable. It is written whenever the worker recorded anything, so its absence
  on a settlement has THREE causes. The worker read no connector. Or the dispatch join row the
  carriage joins through was not written: a `taint.mode: "off"` deployment writes none, and on such a
  deployment a delegated answer's row still names no source. Or the settle could not read the operational
  store: the carriage is **fail-soft** and catches every store error, so an outage costs the
  sources line and leaves the same absence. The three look identical from the audit trail, so do not read an
  absent row as proof of the first cause. **The worker's TAINT verdict never travels
  this way**: taint says what a worker read and
  rides its own marker, provenance says which system a reply drew on, and the two planes settle on the
  same edge and share nothing.
  **A delegation that DIES writes `delegation.task_failed`.** It carries the task id where one exists,
  the call id, the tool, eve's error class in `errorClass` (`SUBAGENT_EXECUTION_FAILED` and its
  siblings), eve's own error TEXT in `error`, and the seat's turn id. It never carries the child's
  OUTPUT, which is worker prose and belongs to no audit row. Two edges write it, because a
  delegation dies in two shapes. A worker that dies BEFORE its task parks comes back as a plain error
  result carrying no task at all, so no `task_started` and no `task_settled` row was ever written and
  this row is the only record that the read happened; its `task` field is empty, which is the honest
  answer rather than a missing field. A task that parked and then died writes this row BESIDE its
  `delegation.task_settled` row, so one action name counts every death whichever shape it took.
  **A class classifies; only the text diagnoses.** Count deaths with `errorClass`, read `error` to
  find out why one happened. The text is upstream-authored, so it lands as untrusted text: the audit
  scrub strikes credential shapes and the row caps it at 300 characters.
  **Every row says which edge wrote it, in `detail.outcome`.** 🔴 **At eve 0.70 there are two, and
  the third is unreachable** (OPE-2250). `task-settled` — the deployment read eve's own
  `task.settled` event; `result` — eve handed the seat a parent-synthesized dispatch-failure
  envelope, where no child ever ran. `settlement` survives in the vocabulary for a batch with no
  failure half to read and nothing writes it in production. The 0.54 `notification` value is RETIRED:
  eve sends no task notifications, so no row can carry it — do not query for it.
  eve's own status word (`failed` or `cancelled`) sits beside it in `detail.status`.
  **How each edge sources them.** The `result` edge reads all four off eve's own envelope. The
  `task-settled` edge takes its `call` and `tool` from the dispatch row this deployment minted, and
  its `error` from eve's own `error.message` field on the event — or, on a cancelled call, from
  `cancel.reason`, which is a closed vocabulary (`task_cancel`, `turn_cancelled`, `turn_ended`) and
  is carried as the class as well. 🔴 **The 0.54 blank-line bound is gone with the text it bounded.**
  That reader stopped at the first blank line because eve joined a turn's coalesced deliveries with
  one and a member's own message could sit in the same string; a field on an event has no such
  neighbour, so that hazard is structurally absent rather than merely guarded.
  **An event OE's reader REFUSED writes `delegation.task_unreadable`**, not a settlement row. It
  reached no edge and adopted no taint, which is the fail-OPEN direction, so the row exists to make
  a too-strict reader countable instead of silent; it carries `edge`, `marker: "unreadable"`,
  `adopted: false` and eve's own unadmitted values as bounded diagnostics. It is NOT deduplicated
  across redeliveries, so a count of these rows is a count of DELIVERIES, not of events.
  🔴 **A dispatch that reached no exact authority writes `delegation.dispatch_unauthorized`**, which is
  neither a settlement nor a refused event. It replaced five throws that claimed to refuse a child
  launch and stopped nothing at eve 0.70 (OPE-2250 step 4): `task.started` is not cancellable in eve's
  own table, and an authored hook's throw at `actions.requested` is swallowed by eve's dispatch
  try/catch. What the state costs the dispatch is its ADDRESS — no task wake is minted, so the
  settlement installs no reply address and the reply fence refuses it under `task-wake-unread`. Taint
  is unaffected: the call-keyed marker still carries, because `oe-task-call:<taskId>` is written
  unconditionally at dispatch. The row carries `edge`, `reason`, `marker: "unauthorized"`,
  `adopted: false` and `call`. **Filter on `reason` and expect five values across two edges** —
  `settlement-turn-no-authority`, `settlement-turn-ambiguous-authority`, `dispatch-wake-not-durable`
  and `unified-turn-no-wake` at `actions.requested`, plus `authority-row-absent-at-task-started` at
  `task.started`. (A sixth, `authority-row-absent-before-advance`, was briefly declared and named here
  while its code arm sat on an unreachable condition; the arm is deleted and the value cannot occur.) Like the row above it is NOT deduplicated,
  so a count is a count of refused dispatches.
  **A class names the defect; only a stack places it — read `delegation.worker_turn_failed` for
  that.** Every field above comes from the PARENT, and the parent can only carry what eve's
  settlement payload holds, which is a code and a message. So a dead worker reporting
  `SUBAGENT_EXECUTION_FAILED` and `Cannot read properties of undefined (reading 'push')` names a
  defect class and locates nothing. The worker writes its own row beside it: same partition, with
  eve's code in `code`, eve's message in `error`, the STACK FRAMES in `frames`, and — when this turn
  re-sent a model step after a transient stream drop — `retried` with the number of re-sends. A
  delegated worker retries one dropped model stream (a stream that ended before the provider's
  terminal chunk) and fails on the second, so a row carrying `retried: 1` is that second drop; a row
  with no `retried` field is a death nothing re-ran. `frames` carries
  `at <name> (<file>:<line>:<col>)` entries joined by ` | `, at most eight of them, each scrubbed by
  the same audit scrub and the whole field capped at 1200 characters.
  **What the frame grammar enforces, exactly.** A line counts as a frame only when it opens `at `,
  ends in a path-shaped `<file>:<line>:<col>`, fits 300 characters, and has a name half of at most
  four words and 120 characters whose every word is identifier-shaped. So the error's own message, an
  inspect property dump and ordinary prose are dropped rather than truncated, and control characters
  are stripped from what survives. **The residual, not denied:** an author who controls an error
  message controls its newlines, and can write a line whose name half is identifier-shaped
  (`at NOTE:_approved_by_the_operator (/a.js:1:1)`), so up to 120 bounded, control-stripped, scrubbed
  characters of chosen text can ride each frame. That is why `frames` is a DIAGNOSTIC and nothing
  keys on it: read it to place a defect, never to learn a fact about the deployment.
  An EMPTY `frames` is a reading, not a gap — eve's payload carried no stack.
  **And the bound on the row itself.** eve's terminal failure site dispatches to no hook, so a throw
  that escapes the turn loop entirely writes no worker row at all. But a `delegation.task_failed` row
  with no worker row beside it is only CONSISTENT with that shape: an append that failed, or a child
  whose turn failure reached no hook, looks identical. The absence is not by itself a reading.
  **`detail.parse` says how `error` was obtained**, so an empty-looking row is never ambiguous.
  🔴 **The four live values at eve 0.70** (OPE-2250): `event` — eve's own `error.message`, or
  `cancel.reason` on a cancelled call, read off the `task.settled` event; this is the healthy shape
  for a delegation. `status` — a terminal settlement that carried NEITHER half, so its own status
  word is carried instead: eve stopped filling the field, or stopped the call with no reason.
  `result` — off eve's dispatch-failure envelope, which names every field itself. `none` — the
  settlement is not a failure, and the only value with an empty `error`.
  🔴 **`json`, `text` and `raw` are RETIRED and no row can carry them.** They were the three arms of
  the 0.54 notification payload reader. A query counting deaths by those values returns zero on a
  live failure plane.
  **And the report itself is countable.** When a seat posts a hand-off note over a running worker, it
  owes that conversation the worker's result once the work settles. The reply that delivers it writes
  **`delegation.settlement_report_posted`**, naming the task the settlement arrived for and the wake
  the report reached — the settle → reply link, in one row. The row is written only for a post that
  reached the conversation the report was owed to: a seat holding several conversations that answers a
  sibling one instead still owes the report, and no row claims otherwise. A settlement step that tries
  to go quiet is refused once and writes **`delegation.settlement_report_skipped`**, naming the same
  task. For a job the seat forwarded with `work`, the host also keeps the promise in its operational store,
  so the duty survives a seat rotation: the result wake reaches the seat's live session with a promise
  stamp, and that session is refused the same silence and writes the same rows. Both rows are always on: a promised report that never arrives is a silence with a broken
  promise behind it, and the actions-only posture would otherwise show nothing at all.
  **Read the count with two limits in hand, because neither writes a row.** The promise is recorded by
  the CROSS-SURFACE window's reply door alone, so the refusal and both rows are a cross-surface
  property: a per-surface deployment records no promise and writes neither row, however many reports
  it drops. And within the cross-surface window the skipped row counts only the silences the model
  chose out loud — a turn that ends with text and no tool call is refused nothing and writes none. So
  a zero count is not evidence that no promise was broken.

### Outbound calls: two planes, one row shape

An outbound call leaves Open Everywhere over one of **two egress planes**, and the audit trail
describes both in the **same six fields**. Join on these names and you get one vocabulary across the
whole outbound surface:

| Field | What it says |
|---|---|
| `plane` | `sandbox` or `host` — which plane the row describes. |
| `unit` | `call` or `policy` — what one row counts. Read this before you read `outcome`. (Not the session **grain**, which is a different term — see the [glossary](../glossary.md).) |
| `host` | The destination host, lower-cased. |
| `verb` | The HTTP verbs the row covers, upper-cased and sorted — or `any` when the rule narrows no method and so admits `DELETE` as readily as `GET`. |
| `credential` | **Whose credential rides, by identity** — a bundle `Connection.id`, or a credential ref name such as `SLACK_BOT_TOKEN`. `null` is a positive claim: the plane attached nothing. |
| `outcome` | What became of the subject — see the unit rule below. |

🔴 **`credential` is an identity, never a secret — held there by discipline, not by the type.** It is
a name you can look up in your own config. The field is a plain string, so nothing in the type stops
a writer spelling a value into it, and the audit scrub reaches only the `error` text a caught throw
produces — never the row a writer builds. What holds the property is where the secret lives and what
each writer passes: on the sandbox plane the credential lives inside a firewall rule's `transform`,
and the attribution is derived from the rule's `match` and the bundle's connection id, so no byte of
the `transform` reaches a row; on the host plane it lives in a request header this shape never sees,
and the one seam that sends one passes its ref name. Two canary tests check the output rather than
the intent — `packages/core/scripts/egress-write-attribution-test.ts` seeds a canary secret into a
policy, proves the compiled policy carries it, then proves no rendered row does; the Slack
attachment suite drives that seam over a canary token — a real call against a stubbed socket — and
asserts the row names `SLACK_BOT_TOKEN` and never the token.

**The sandbox plane** is the agent's own `bash`/`curl`, behind the Vercel firewall. Its rows ride
`egress.policy`, in the `writeHosts` list.

**The host plane** is a call Open Everywhere dispatches itself in the framework process —
`oeFetch` (`egress.hostside.allow` / `egress.hostside.deny`) and the credentialed provider seams,
such as the Slack attachment download (`slack.attachment.allow` / `slack.attachment.deny`). The **allow** rows of a call Open Everywhere dispatches itself also carry `route` (`direct` or
`proxy`) and `antiRebind`, which say how the
call was dispatched and which anti-rebind posture actually held. A deny row carries neither, and
cannot: it is written before any dispatch is built. Nor does a `web_fetch` row, for the same
reason — see the note on that tool below. `route` was called `via` until OPE-1547 —
the same name the sandbox plane used for the stamping connection, so one name meant two things in
one store.

🔴 **The two planes do not count the same thing, and the row says so rather than hiding it.** This is a
physical property of where each call is made, not a gap somebody has yet to fill:

- **`unit: "call"`** — one row per outbound call, on the **host** plane, wherever Open Everywhere
  makes that call: it holds the verb and it sees the response.
  🔴 **`web_fetch` counts its own way, because the dispatch is not ours.** It writes **one row per
  redirect hop**: hop `0` is the URL the model asked for, and every hop after it is a host the
  *response* chose. Every row of that chain carries `hop` and `dispatch: "framework"`, refusals
  included — the refusal *message* is the one a direct call gets, so the row is the only place that
  says a declared host bounced somewhere rather than the model asking for it. They are written at
  **admission** rather than at settlement — past the fence the request belongs to the framework, so
  Open Everywhere never sees the response. So on this tool `allowed` means "admitted, and handed to
  the framework's dispatcher", and the row carries no `status`, no `route` and no `antiRebind`.
  Read the rows as the chain the allow-list permitted, never as transport successes.
  `outcome` is `allowed` (dispatched, with the
  response `status` beside it on every other seam), `denied` (refused by policy before anything
  left) or `failed` (the dispatch itself errored).
- **`unit: "policy"`** — one row per firewall apply, per host that apply left open to a mutating
  verb, on the **sandbox** plane. This is the finest unit that plane admits. The sandbox runtime
  offers one call, `setNetworkPolicy` — no per-request event, no callback — so Open Everywhere
  never observes an individual sandbox call it allowed. (On the **self-host** tier the operator
  owns the forward proxy, and its access log does record requests; Open Everywhere lifts only the
  **denials** from it, reduced to hosts and counts, into `egress.denied` — never an allowed call,
  never a method, never a path. On Vercel the firewall is not ours and emits no log we can read.) `outcome` is therefore always
  `granted`: **the firewall was set to admit this host under this verb.** It does not say a call was
  made, and must never be read as one.

So "could this session have written to that vendor, and under whose credential?" is answered on both
planes. "Did it?" is answered by the host plane's own row for every call Open
Everywhere dispatches, and — with the admission caveat above — for every hop a `web_fetch` was
admitted to make; on the sandbox plane it is answered only by
the session transcript. The reviewed `Connection.methods` declaration is the control
on the sandbox plane; the row is evidence, not a gate.

**Where Open Everywhere owns the call, an allow row carries the outcome, so it is written after the
call settles** rather than before it starts. Both settlements write exactly one row. What this costs
is the case where the process dies mid-flight, which leaves no row for that call. The refusal paths
are unaffected — a reach deny and an SSRF refusal are both decided before a socket exists, so the
fence's own evidence never depended on the timing.

🔴 **`web_fetch` is the exception, and it is the higher-volume writer.** Its rows are written at
**admission**, per hop, because the framework owns that dispatch and Open Everywhere never sees the
response — see the note on that tool above. So `egress.hostside.allow{tool: "web_fetch"}` does not
say the fetch completed: the transport may still have failed, the 5 MB cap may have cut it, or a
later hop may have been refused. Read `tool` before you read `outcome`.

### Properties that make the log trustworthy

- **Append-only by design.** There is no delete in the audit path. On **Postgres** this is enforced at the **database layer**: `audit_entry` (and the `usage_events` cost ledger, the `domain_skill_revisions` log that keeps the exact skill body each approval armed, and the `routine_prompt_revisions` log that keeps the standing instructions a routine has run under) carry insert-and-select-only policies under **`FORCE ROW LEVEL SECURITY`** — so update and delete are denied even to the table *owner* the app connects as (`FORCE` is what makes the owner subject to policy; plain RLS lets the owner bypass it). `FORCE` binds DML, not DDL: the table owner could still `DROP POLICY` / disable RLS and then rewrite the log — which is why the supported hardening is the **two-role split** ([Database & operational store](../extending/database.md)): the app serves as a **non-owner runtime role** that Postgres refuses those DDL statements to outright, so the credential the deployed app actually holds cannot disable append-only. Boot is posture-aware either way: an owner-mode boot that finds the protection broken **repairs it surgically and records an `audit.integrity` row**; a runtime-role boot that finds it broken **refuses to serve** (fail-closed). Boot-time verification (`verifyAppendOnlyAudit`) covers, on all four tables: RLS enabled *and* forced; the exact expected policy set and nothing else — so a foreign or `RESTRICTIVE` policy (e.g. a `RESTRICTIVE FOR INSERT WITH CHECK (false)` that blocks appends yet permits reads) is rejected, not only `UPDATE`/`DELETE`/`ALL` ones; no non-internal `INSERT`/`UPDATE`/`DELETE` trigger (a `BEFORE INSERT … RETURN NULL` that swallows every audit row is caught); and no non-owner `UPDATE`/`DELETE`/`TRUNCATE` grant (an owner `GRANT` slip). The log can record a memory erasure without itself being erasable, and it sits deliberately *outside* the erasure path. On **SQLite** (local / single-tenant self-host) there is no row-level-security engine, so the same guarantee holds **by contract** — the store exposes no delete method — rather than by DB enforcement; that backing is single-tenant-trusted by design (a superuser job can already rewrite the file). Honestly scoped residuals: whoever holds the *owner/migration* credential — or a true superuser / `BYPASSRLS` role, or the database platform's own console — can still rewrite the log. Which is what the second property below is for.
- **Hash-chained for tamper *detection*.** Every appended row stores `prev_sha` = the SHA-256 of the org's immediately preceding row (a per-org chain; the first row of an org is the genesis, with a null `prev_sha`). The digest covers every caller-meaningful field — `org`, `ts`, `platform`, `workspace`, `surface`, `principalId`, `action`, and a key-sorted canonicalisation of `detail` — chained to the previous row's hash, so **mutating any field or deleting any row** breaks the link at (or after) the affected row and is detectable *regardless of catalog state* — it closes the break-**and-restore**-between-boots gap the append-only layer alone leaves. Verify on demand with the [verifier CLI](#the-verifier-cli), which walks each org oldest-first, reports **every** broken link with a per-action breakdown, and **exits non-zero on any break**; boot additionally re-verifies each org's last 32 links and logs one loud warn on a mismatch (**availability over integrity-halt** — a detected break never crashes the boot). One honest bound remains: the **tip is unanchored** (mutating the single most-recent row has no successor yet to commit to it). Making the chain *tamper-**evident*** to an outside party — anchoring the head to an independent witness so even a full owner-rewrite of the whole chain is provable — is the remaining layer (deferred); today's chain gives an operator with read access reliable **detection**, not a third-party-verifiable proof.
- **The append is serialised per org, across processes.** The chain link is a read-the-tail-then-insert, so two writers that read the same tail stamp the same `prev_sha` and **fork** the chain. Serialising that in-process is exactly as wide as one process, and the hosted runtime writes audit rows from more than one function — ingress and the control plane write outside a turn. The result was measured on a live store: **6,966 broken links across 53,218 rows**, led by `control.service_call` and `surface.wake_dropped`. Two layers now keep writers apart. In-process, a per-org lock lives in the **store adapter**, so every path is covered — including the store's own `audit.integrity` row, which never passed through the caller-side lock that used to hold this job. Across processes, the Postgres adapter runs the tail read and the insert inside **one transaction on one pinned connection**, behind `pg_advisory_xact_lock` keyed on the org; the transaction-scoped form releases at `COMMIT`/`ROLLBACK`, so no lock can outlive a pooled connection. The cross-process layer needs a client that can pin a connection (`PgClient.withConnection`). The embedded PGlite floor offers none and does not need one — it holds a single-writer file lock — and boot logs one warning if a Postgres client arrives without the seam. **The wait for that lock is bounded.** An advisory lock waits forever by default and an audit append is awaited on the hot path, so an instance that dies mid-transaction — or a long holder such as an epoch seal — would otherwise stall every other instance's appends for that org with no way out. The append sets a transaction-scoped `lock_timeout`, and a wait that passes it degrades into the log's own best-effort drop: one retry, then a counted, warned gap. A counted gap is recoverable; a wedged append is a hung turn. A fork and a tamper still look alike to a reader: both surface as a break. Tell them apart by inspection — a fork's two rows share a `prev_sha` and sit adjacent in time, while a tamper leaves a recomputed-sha mismatch with no sibling.
- **The pre-chain era is sealed, never skipped.** Rows written before the chain existed carry a null `prev_sha`, which a walk reports as a broken link for each one. A verifier that quietly skipped a null link would hand anyone who can write the log a one-row way to end a walk, so the era is closed by an **explicit marker** instead: one `audit.chain_epoch` row that says "the chain starts here". Its `detail.epoch` seals the era — the row count, the seq range, **how many links were already broken at the moment of sealing**, and an **era digest**: SHA-256 over each pre-epoch row's own recomputed hash, in seq order. What an operator should conclude about tamper evidence is therefore precise, and different on each side of the marker. Rows **after** the epoch carry link evidence: any mutation or deletion breaks a link. Rows **before** it carry era-digest evidence *dated to the seal*: changing or removing one makes a full walk recompute a different digest, and the walk reports it. Neither says anything about tampering that happened **before the seal was taken** — the seal fixes the era's content as of that instant, no earlier. A full walk re-verifies **all three** of the marker's claims — the row count, the era digest, and `breaks_before` — and a marker that disagrees with any of them suppresses nothing and adds a break of its own. A `--tail` window can verify none of them, so it suppresses nothing either. **A marker that has become the first row is still a marker.** Its `prev_sha` is null, exactly like a genesis row's, so deleting every row a seal covers would otherwise turn the marker into an ordinary genesis and retire all three claims unchecked; the walk reads row 0 as a possible epoch too, and a full walk there requires the seal to cover **zero** rows or reports the disagreement as a break. **The marker is not authenticated, and that bound is load-bearing.** Every input to a seal is computable by anyone who can `SELECT` the rows, and the append-only posture deliberately grants the runtime role `INSERT` — so one row could seal a broken era with a seal that verifies. An epoch is therefore an **operator act that the operator names**: the verifier exits `4`, and never says "chain intact", for any epoch no `--accept-epoch <seq>` vouches for. Seal with [`npm run audit:seal-epoch`](#sealing-the-pre-chain-era), and only after the write-side serialisation above is deployed — otherwise the era you seal keeps growing.
- **Best-effort by contract — recorded, never blocking.** Writing an audit line through `appendAudit` never throws to its caller. 🔴 **That contract belongs to `appendAudit`, not to the store.** A handful of writers call `getOperationalStore().appendAudit(...)` directly and get neither the retry nor the drop counter — several Slack front-door rows, and `agent/spend/ingress-gate.ts`, whose sink returns the store's promise bare. That gate's own call site awaits it inside a `catch`, so the wake is never blocked and the row is simply lost, uncounted and unretried. Treat a direct store append as an uncounted, unretried write. An audit failure must not fail the user's task, so a write that fails is **re-attempted once** (the realistic failure is a transient store blip — a Neon cold-start / reset — which a single retry clears), and only a *second* failure gives up: it **counts the drop** in telemetry (`oe.audit.dropped`, carrying just the action name + platform — never org, principal, or row detail) and logs the gap to the console (so a missing line is *visible*, not silently swallowed). The trade-off is explicit: the task always proceeds, and a genuinely dropped line surfaces as both a metric and a warning rather than vanishing.
- **It never stores what it was asked to erase.** Because the log sits outside the erasure path, anything written into it is kept forever — so the `purge_memory` flow **redacts by construction**: the frozen approval args, the audit rows, and the memory-provider commit message all carry only a **SHA-256 of the erased bullet plus its length**, never its text (`packages/core/agent/memory/purge-redaction.ts`). The same construction covers ordinary freehand deletion: when a session's end-of-session persist removes lines from a memory file, the `memory.write` row records their digests and lengths, so a deletion by edit is attributable without the log carrying what went. The verbatim line appears exactly once, transiently, where a human must read it — the pending approval card. The digest still lets an auditor prove *which* known fact was erased (re-hash and compare) without the log preserving it; the honest caveat is that a hash of a low-entropy fact (an ID number, a phone number) is brute-forceable by someone holding both the log and a candidate list.
- **It never stores a member's words, even derived ones.** A row carries ids, counts and reasons. Anything computed *from* a message is still the message, so it gets the same digest construction as an erased bullet. The case that makes the rule concrete: the [dream cycle](../capabilities/memory.md) counts how often a workflow recurs by writing one `memory.observation` row per request, keyed on a **workflow signature** — the sorted set of significant words in what the person asked for. That is a readable paraphrase of a member's message, so the row stores a **SHA-256 of the signature** (`detail.sigSha`) beside the OE-minted place it was seen (`detail.scope`) and the delivery id that dedupes replays. The counter only ever compares one fingerprint to another, so it loses nothing; the enrichment row the recurrence crossing writes (`memory.learn`) carries the same digest, which is what lets a reader join an enrichment to the observations that caused it. Same honest caveat as above: a hash proves-without-storing against a reader of the log, not against an offline dictionary attack on a guessed phrase. The dream cycle's **proposal** channel — a destructive Mode-2 memory edit or a Mode-1 SKILL suggestion held for human review — is the one place this content is meant to be read, not hidden: a human reviews the affected lines or the drafted SKILL.md before anything happens, so the content belongs in a store with an erasure path rather than the audit log. It lives in `memory_proposal` (an org-partitioned, mutable operational table, unlike the audit log it used to share), and the audit trail keeps a matching taint-clean row (`memory.proposal`: the proposal's store id, its kind, its OE-minted scope, the memory `file` it is about and a `count`, plus `detail.sigSha` when the proposal carries a workflow signature) so the log still shows *that* a proposal was recorded without holding *what it said*.

### The approvals plane's own rows

An approval card's life beyond the ordinary `approval.approved` row leaves these rows. Each carries
the pending id, the kind, and ids and enums beside them — never the card's prose.

| Action | When the code writes it | What the row carries |
| --- | --- | --- |
| `approval.session_granted` | A click chooses the middle button of a routine's card ("Approve for this routine (up to N h)"). A card in a conversation has no middle button, and a forged middle-button click on one writes no grant and no row. | The pending id, the kind, the **memo kind** the grant was written under, and its **reach** (`routine`). The memo is keyed on the org, the routine's grant key and the memo kind, so a grant is never read under a kind or for a routine it was not written for. |
| `approval.session_grant_released` | That one grant releases the cards it already covers. | The pending id it was granted on, the memo kind, how many cards were released, and — when the release hit its cap — how many candidates matched and what the cap is. It is the join between a human's single click and the several actions it decided. |
| `approval.rule.added` | A person confirms "Approve, and allow things like this" on a card in their own DM, and a DM rule is added or widened (OPE-2456). | The pending id, the kind, the rule id, `change` (`added` or `widened`) and the venue. Never the rule's text. |
| `approval.rule.proposed` | The same confirmed option in a domain room opens or updates the domain rule pull request. | The pending id, the kind, the rule id, the domain, `change`, the repository, branch, pull request number and URL, and the requester's id. `dryRun: true` when nothing was opened. |
| `approval.rule.refused` | The option was clicked, the act was approved, and no rule was written. | The pending id, the kind, the venue and a `reason`: `no-rule-offered`, `no-room`, `guest-clicker`, `not-owner`, `audience-floor`, `cap`, `already-covered` or `write-failed` (with the error message). |
| `approval.rule.removed` | A person removes one of their DM rules in the Home tab. | The rule id and the door (`slack-app-home`). |
| `approval.failed` | An approved action's own `execute()` throws, or a rejected kind's durable `declined()` throws (`phase: "decline"`, OPE-2549). | The pending id, the kind, the venue, and the error through `auditErrorDetail`: credential shapes struck, capped at 300 characters. |
| `approval.expired` | A pending reaches a terminal state with nobody deciding it. | The pending id, the kind, and a `cause` that separates the two ways it happens: `card_post_failed` when the card never reached the surface, and `ttl` when the sweep closed an unclicked card whose clock ran out. The two must never read alike. A `card_post_failed` row also carries `reason` — the surface's own refusal code, token-free — so the record says WHY the room got nothing. |
| `approval.decision_wake` | A decision wakes the session that asked for it. | The pending id, the kind, the outcome, the domain, whether the wake was delivered, and the wake id. Ids only — never the notice body. |
| `approval.judge.shadow` | The approval judge runs in shadow mode beside a real card. | The judge's verdict as evidence. 🔴 **It decides nothing.** The row is written only when `approvals.judgeMode` is `shadow`, and no verdict is applied. |
| `approval.judge.verdict` | The approval judge is consulted in `enforce` mode (the shipped mode), once per consult. | The verdict, the enforced verdict, and the `source`: `pass2`, `cache`, `no-rules`, `human-only`, `admin-disarm`, `error`, `timeout` or `unavailable`. An allow that ran with no card carries `ruleId`, the [pre-approval rule](../how-it-works/pre-approval-rules.md) it cited. `ruleCitation` is `matched`, `unmatched` (a citation that resolved to no rule) or `uncited` (an allow that cited none); the last two are asks. |
| `approval.eve_settled` | A runtime approval event settles. | The runtime's own responder id and the outcome. |
| `approval.eve_candidate` | A runtime approval-candidate event reaches a **terminal** outcome. | The same shape. Only `rejected`, `failed`, `timed-out` and `stale` land a row; a `pending` candidate is the attempt being opened rather than a decision, so recording it would write two rows per click. |

🔴 **The responder id on the two `approval.eve_*` rows is the runtime's own id for whoever pressed
the button, not a resolved Open Everywhere principal.** Both rows are stamped best-effort: an
unresolvable surface still lands a row, stamped `unknown`, because a decision that happened and was
not recorded is the worse failure.

### A reply may not say an act was ungated

Whether an act needed an approval card is a fact about the access plane. A seat only sees that
nothing interrupted it, so a seat that writes "no approval was required" is reporting an absence it
is not the right author of. A live run measured the cost: a seat created a Notion page and told the
room "No confirmation or approval requirement was presented", when what had really happened is that
the room's own standing grant — `notion-rest`, declared in the deployment's bundles with POST and
PATCH on `api.notion.com` — already covered the write. Both readings fit the sentence, and they lead
a reader to opposite decisions about the next write.

So the host answers this one. `packages/core/agent/channels/approval-claim-guard.ts` runs at every
reply door, beside the durability guard. When a reply claims no approval was needed AND the host can
name what stood behind the turn, the guard removes the claim's own words and puts one host-voiced
line there instead:

| What the host observed | What the reply says instead |
| --- | --- |
| An approval gate ran this turn | "(This needs an approval, or already has one.)" The signal is armed when a card POSTS and by the routine-grant publish path, not when a person approves, so the line never says the act was approved or that a card is in the room. |
| A `write`- or `destructive`-tier connector op completed with no card | "(There was no approval card this time: an approval for this notion change was already in place.)" |
| The compiled egress policy leaves a write-capable host open under a named credential | "(There was no approval card this time. This room has standing permission to make changes in api.notion.com, so this change may have used it.)" It names the host, never the credential or the HTTP verbs, and it never says this act used the permission. |

The lines are written for an ordinary reader (OPE-2487): they carry the host's observation in the
room's own words, with no "gate", "grant" or credential id. None says that no approval was needed:
that is the claim the guard strikes, and the host holds no evidence for it. The credential and verbs stay on the
`egress.policy` row, and the cause stays on the `approval.claim_withheld` row.

The guard removes the claim from its first word to the end of its sentence. It starts at the claim,
not at the sentence, because the measured reply carried the page link the room had asked for in the
same run-on sentence; it runs to the sentence end so that no half-clause is left hanging off the
host's line. Every byte before the claim goes out unchanged.

One `approval.claim_withheld` row records it, carrying the number of claims, their shapes, their
sentence positions and which of the three causes the host named — never the words, which are model
text that can quote ingested content.

🔴 **What it does NOT cover, stated.** The host sees the egress POLICY, not the individual request:
the firewall stamps credentials at the sandbox boundary, so no row anywhere proves that a particular
REST write happened. The standing-grant line therefore names a reach the deployment granted, never a
call anybody made. And where the host can name no cause at all, the reply posts unchanged — the
guard adds nothing it cannot stand behind.

### A reply may not say it submitted a request nobody made

Whether an access request exists is a fact about the propose plane. A seat sees only its own
intention to make one, so a seat that writes "I've submitted the request" is reporting an act it is
not the right author of. A live run measured the cost: asked in a DM for a channel-scope widening, the
seat answered "I've submitted the channel-scope request … It's pending the required approval; I'll
report the card/status when it returns." The turn held no pending row, no card in either room, no
delegation and no further reply for seven minutes. The room was told a request was in flight and
then left waiting on nothing.

So the host answers this one too. `packages/core/agent/channels/request-claim-guard.ts` runs at
every reply door, beside the durability guard and the approval guard. It strikes the claiming
sentence and puts one host-voiced line in its place — the same shape and the same fail direction as
the durability guard, and never a rewrite of the rest of the answer.

**What backs a claim.** One signal: an access-request propose really ran on this turn, stamped by
`request_access` at each of its three success returns.

| The return | The durable row it pairs with |
| --- | --- |
| A card reached a surface | `approval.requested`, written on this turn |
| The approver chain lowered the verb | `approval.autoapproved`, written on this turn. No card exists, so nothing else could see this request |
| The propose deduped onto a live earlier card | None on this turn. A pending row exists and somebody can look at it, but the `approval.requested` row that records it belongs to the earlier turn |

**Which claim it is about decides which evidence it takes.** The subject is read from the CLAIM
itself — its own matched words first, then its sentence — and it is what the guard strikes on:

| What the claim names | What backs it | What happens with no evidence |
| --- | --- | --- |
| Access vocabulary — access, scope, widen, permission, connector, grant | The turn ledger above, and nothing else | Struck |
| Another approval kind ON the claim's own noun — "a routine-approval card", "the purge request", "the spend-limit card" | Another plane holds it; this guard holds no evidence either way | Posts unchanged |
| No kind, and the claim's own noun is a card — "the approval card has been raised" | `approvals/card-signal.ts`: the host saw an approval gate run in this session | Struck |
| No kind and no card — "I've raised the request with the admins" | Nothing | Struck |

A claim that names no kind inherits `access` from another CLAIM sentence of the same reply, and from
nothing else. Both halves of that rule are measured. A live run's second sentence — "It's pending the
required approval" — carries no access word and is half of the same fabricated access claim as the
first, so reading each sentence in isolation would hand it to the card signal. Reading the whole
reply costs the other direction, which is what leg 054 of a live run measured: the approval guard's own
standing-grant note runs one door earlier and carries the word `grant`, so one host note made every
claim in the reply an access claim. The seat's truthful routine ack was struck, and the room was
told no access request was recorded for a sentence that never claimed one.

The "it is pending approval" shape may never name a kind. It has no propose noun of its own — it
anchors on a pronoun — so the thing said to be pending lives in another sentence, and a kind word
beside its `approval` may belong to that sentence or be a plain adjective.

🔴 **The card signal is a bounded second source, never one for an access claim.**
`approvals/card-signal.ts` is three things it does not look like. It is armed with no card at all by
the routine-grant publish path. It is a per-session boolean, reset only where a surface consumes
it, so on Teams, Linear, Notion and GitHub a card posted three turns ago still reads true now. And
it names no kind, so a spend-limit card would back a fabricated access request. Each of those is a
fail-open, so an access claim takes the ledger alone. What the signal backs is one sentence only: a
claim that names no kind and whose own noun is a card. What it really stands behind, stated, is
weaker than that sentence — an approval gate ran somewhere in this session, which is how the
approval guard words its own note from the same signal. It is the widest thing this guard does, and
closing it needs a kind-grained, turn-keyed card record that the approvals plane does not keep.

Three shapes are struck: a completed submit verb beside a request noun, the same pair in the mirror
order with a completed auxiliary, and a present-tense "it is pending approval". Plans, obligations,
questions, negations and standing descriptions are all out, by design — "a channel-scope access
request is raised in the channel it is for, not from a DM" is the honest answer the seat owes in a
DM, and a guard that struck it would leave the seat nothing true to say.

One `access_request.claim_withheld` row records the strike, carrying the number of claims, their
shapes, their subjects and their sentence positions — never the words.

🔴 **What it does NOT cover, stated.** The ledger is TURN-stamped, so an `edit_reply` made on a later
turn reads empty and strikes a claim the first post was entitled to — the same bound the durability
guard and the provenance record both carry. It is also SESSION-stamped, and a DELEGATED propose is
therefore not evidence: a worker mounts `request_access`, its propose arms the worker's own session,
and the delegating seat settles in its own and strikes a true report with the card visible in the
room beside the host's denial. (The durability guard does not share that bound — a delegated memory
write flushes into the seat's own turn at the settlement edge.) A status report about an OLDER
request ("your request is still pending approval") is deliberately left alone, because answering
that question is a real job and no turn evidence exists for a row proposed days ago; the cost is
that a fabricated pending claim worded as a status report posts. And the protection is only as wide
as the three shapes: a claim in some wording nobody has written yet posts unchanged.

Three more costs come from the subject rule above. A seat that names another kind FALSELY — "I've
raised the routine card", or "I've filed a ticket request to get POST on the fixture", with nothing
behind either — posts, because this guard holds no evidence about another plane and a false
host-voiced denial is the worse answer. The card signal is per SESSION, not per turn, so on a
surface whose delivery never consumes it a card minted on an earlier turn backs a card sentence
written now. And that signal is armed by the routine-grant publish path, which posts no card at
all, so a card sentence can ride evidence that only proves a gate ran.

The kind must QUALIFY the claim's own noun, and a kind elsewhere in the sentence is deliberately not
enough. "I submitted the request to widen the connector so it can file tickets" is an access claim
that mentions tickets. "I've submitted the channel-scope access request for this channel; it's
pending routine approval" is leg 016's fabrication with a kind phrase hung off a second clause —
sentences are split on `.!?` and a newline, never on a semicolon. Reading either as another plane's
card would post the fabrication. The cost of that tightness is that a loosely worded true claim —
"the card for the new routine has been raised" — reads as kind-less, and is struck unless the host
saw a gate run.

**In a DM, a channel-scope ask is raised in the channel.** A channel grant binds to that channel's
own scope, so `request_access` refuses a `target=channel` ask made from a direct message, and its
own description says so: the honest answer there is to name the road — repeat the ask in the channel
— never to claim a submission. Only that universe has to move. A personal ask belongs in the DM, and
an org admin may still ask for a person-group there.

### Tool and guard rows

| Action | When the code writes it | What the row carries |
| --- | --- | --- |
| `<platform>.post_file` | A file the agent posts has landed. | How many files, their filenames, whether a comment rode with them, and how many were attached. Never the bytes, never the token. It is written **after** a successful post. |
| `<platform>.react` | A reaction the model places lands. | The emoji and the reason the model gave, defaulting to `ack`. |
| `<platform>.react.failed` | The platform rejects that reaction. | The failure class, and the HTTP status when the surface returned one. |
| `slack.react` | A Slack reaction lands through Slack's own arm. | The emoji, the message timestamp and the same reason field. |
| `browser.<verb>` | A browser-toolkit verb runs. | Ids and the verb only — never the arguments, and never the output. 🔴 The action name is **dotted**: `browser_navigate` audits as `browser.navigate`, because the double underscore is the connector-op separator. The write is best-effort, so a failed audit never fails the tool. |
| `bash.timeout` | A shell command hits its timeout. | The tool name and the timeout in milliseconds. |
| `bash.background_unredirected` | A backgrounded shell command's output is redirected nowhere. | The tool name. |
| `stall.nudge` | The stall guard trips on repeated identical tool calls. | The tool name, the threshold it tripped at, and the strike count. The nudge then throws, so the model is told rather than looped. |

### Turn, reply and window rows

These rows sit on the turn and the cross-surface window. All of them carry ids, enums and counts.

| Action | When the code writes it | What the row carries |
| --- | --- | --- |
| `<platform>.ambient_skipped` | The ambient gate declines to run on a surface. | The reason, the config route it read, the domain when one resolves, and a suggested fix. 🔴 **Read its cadence before you read it as an event:** it is one row per surface **and reason** per **process**, and it names no delivery and no comment. So it can neither confirm nor deny that any particular message was skipped. Three separate diagnoses have gone the other way and cost real work. |
| `reply.no_reply_addressed_to_other_refused` | The silence verb is refused because the model claimed an engaged conversation's message was for somebody else. | The refusal. It is named for the **effect**, so it survives the verb or the reason being renamed. |
| `reply.no_reply_after_stand_down` | A `no_reply` is **refused** because this turn still owes a stand-down acknowledgement. The call then throws, and **no silence is recorded**. | The reason, and the explanation when the caller gave one. It is **ungated**, unlike the silence rows: this is a refusal rather than a record of a silence the model chose, and a lost acknowledgement has to stay countable in the actions-only posture production runs in. 🔴 It carries **no engagement anchor** — the anchor is on the sibling `reply.stand_down_ack` row. Count these rows as seats that tried to go quiet and were refused, never as silences. |
| `reply.no_reply_duplicate_refused` | The silence verb is refused because the model called an addressed message a `duplicate`, and this window holds no earlier copy of it that the seat answered (OPE-2623). | The refusal, with `window` set to `no-answered-copy` or `unread`. History a rotation carried into the first wake does not count as an answered copy. It is ungated, like its siblings. |
| `reply.no_reply_redundant` | A second `no_reply` arrives for a wake already declined. | The reason, what it was already marked as, and the explanation when one was given. 🔴 **This row is gated on the test-only silence-audit switch**, which no setting, env var or committed production module arms — so core never writes it on its own. |
| `turn.question_dropped` | The cross-surface window receives a non-park input request. That window has no question road (OPE-2389), so the request is never shown and the agent routes no answer to it. The framework can still take the session's next plain message as the answer by its own rule, without the agent's admission check. | The request id, the tool name, the framework's request kind, a `reason` (`work-session` for the work session, else `no-question-road`), and the owning task when the framework names one. Never the question text. |
| `turn.native_input_requested` | A turn asks its surface for native input. | The partition, and nothing else. It excludes the runtime's own session-limit park, which is a different mechanism. |
| `input_response.routed` | The Notion question return delivers a discussion comment to the session that asked, as its answer. | The ids and the approver floor the admission check read, which is what makes "the floor really ran" answerable. |
| `input_response.dropped` | The Notion question return cannot deliver an answer. | The ids. The message is then handled as an ordinary wake and the question stays open — never a silent fall-through. |
| `unified.self_dispatch` | The cross-surface window dispatches a wake to itself. | The wake, the surface, and the message **length**. |
| `unified.supervisor_turn_failed` | A supervisor turn throws on the cross-surface window. | The gateway name, the upstream and gateway types, and the error's code, name and message. |
| `unified.supervisor_session_failed` | A supervisor **session** fails there. | The same fields, plus the label that marks a session as unresumable. |
| `unified.turn.redrive` | A cross-surface turn is redriven. | The same wake id the redriven turn's own `reply.post` re-stamps, plus the session id — which is what makes the two joinable. |
| `window.routing_degraded` | Window routing falls back to a narrower path. | The grain the wake landed on, the domain-grain key, the wake id, and which recall route the degraded seat is left with. A test pins those four fields, and asserts that the session's own token material reaches none of them. One row per **wake**, so a surface that degrades every time cannot hide behind a dedupe. |
| `thread.ingress_routed` | A thread's ingress is routed to its seat. | The routing decision. |
| `reaction.feedback` | An inbound reaction lands on the agent's **own** reply. | The reaction, durably, because that is the human-feedback signal. A reaction on anything else emits telemetry and no row. |
| `reply.feedback` | A person clicks the surface's native thumbs up / down under an answer (Slack `feedback_buttons`, the Teams feedback loop — OPE-2520). | The rating (`up` / `down`), the surface, the conversation and the rated message's id (`detail.messageId`, which the reply's own `reply.post` row carries as `detail.id`), and `via: "native"`. A Teams thumbs-down can carry a typed comment: the row records `comment: true` and `commentChars`, **never the words**. |
| `governance.floor_breach` | A room's audience floor is breached. | The domain, the channel key, the breach reason, which members were missing, and the members it did find. One row per breach: an attestation memo sits in front of the roster memo, which is what keeps it to one. |
| `dm.delivery.skipped` | This deployment's arm cannot reach a member's own recorded workspace, so the send is skipped. | The reason, the link-set id, and **both** workspace ids — the target's and the arm's. |
| `dm.audience.stopped` | A recipient turns the agent's direct messages off, from their own DM. | The stop. A live grant does not override it. |
| `dm.audience.resumed` | That recipient turns them back on. | The resume. Both actions are named for **what happened** rather than for the verb, so they survive a rename of the verb. |
| `personal_watch.dial.set` | A person sets their [chief-of-staff watch](../capabilities/proactivity-and-routines.md#the-chief-of-staff-watch) to `more`, `less` or `none`, with `/oe watch` or the Home tab. | The person's qualified key in `principalId`, the new `dial`, the `previous` one, and the door (`via`: `command` or `app-home`). |
| `personal_watch.dial.refused` | `/oe watch` or the Home tab refuses to turn a person's watch to `more` or `less`, and writes nothing. | The person's qualified key in `principalId`, the asked `dial`, the door (`via`: `command` or `app-home`), and the closed `reason`: `not-member` (the person is not confirmed a member) or `room-unconfirmed` (the command came from a room not confirmed internal). |
| `personal_watch.nudge` | The watch started a direct message to the person on its own, with nobody asking. | The finding's `kind` and `urgency`, the `dial` and `dampening` in force, whether the message carried the calibration ask (`calibrationAsk`), and the finding's `fingerprint`. Never an event title. |
| `personal_watch.silence` | The watch held a finding back, or could not look. One row per finding and reason: the same finding held for the same reason on the next check writes nothing new. | The closed `reason` (`dial-none`, `below-dial`, `dose-lowered`, `quiet-hours`, `daily-budget`, `min-gap`, `read-failed`, `unreadable`, `dm-stopped`, `delivery-refused`, `proposal-gap`), the finding's `kind` and host-written `summary`, the `dial`, the `dampening` and the `fingerprint`. Never an event title. |
| `personal_watch.proposal` | [Workflow discovery](../capabilities/proactivity-and-routines.md#workflow-discovery-a-routine-for-work-you-repeat) posted a routine proposal card into the person's own DM. | The person's qualified key in `principalId`, the idea's `fingerprint`, its `kind` (`connector-op`, or `question` for a [repeated question](../capabilities/proactivity-and-routines.md#repeated-questions)), the `connector` and `tool` (both empty for a question), the UTC `weekday` and `hour`, the number of `weeks` seen, and the `dial`. Never a tool argument, and never a question's words: a question's `fingerprint` holds its hash. |
| `personal_watch.proposal.accepted` | The person pressed Set it up. The `routine.create` row beside it records the routine. | The idea's `fingerprint`. |
| `personal_watch.proposal.declined` | The person pressed No thanks. The watch never offers the idea again. | The idea's `fingerprint`. |
| `room_watch.proposal` | [Room discovery](../capabilities/proactivity-and-routines.md#shared-rooms) posted a routine proposal card into a shared room, for work that two or more people there repeat. | The room in `surface`, the idea's `fingerprint`, its `kind`, the `connector` and `tool`, the UTC `weekday` and `hour`, the number of `weeks` seen, and how many `people`. No person id, and never a question's words. |
| `room_watch.proposal.accepted` | A member pressed Set it up on a room's card. The `routine.create` row beside it records the routine, created by that member. | The member in `principalId` and the idea's `fingerprint`. |
| `room_watch.proposal.declined` | A member pressed No thanks on a room's card. The room is never offered the idea again. | The member in `principalId` and the idea's `fingerprint`. |
| `room_watch.silence` | [Room discovery](../capabilities/proactivity-and-routines.md#shared-rooms) held a room back (OPE-2550). One row per stop, or per idea and reason: the same hold on the next scan writes nothing new. | The room in `surface`, the closed `reason` (`room-stopped`, `proposal-gap`, `delivery-refused`), the idea's `fingerprint`, `kind` and host-written `summary` (empty for `room-stopped` when the scan saw the stop before it read the room; the held idea when the stop landed during the scan). No person id, and never a question's words. |
| `room_watch.stopped` | A person in a shared room typed `/oe suggest off`, so the room gets no more routine suggestions. | The person's qualified key in `principalId`, the room in `surface`, whether the state `changed`, and the door (`via`: `command`). |
| `room_watch.resumed` | A member in the room typed `/oe suggest on`, and the room's stop is lifted. | The same fields as `room_watch.stopped`. |
| `personal_watch.response` | The person marked one nudge Useful or Not useful in the Home tab. | The `response`, the `dampening` it left, the door (`via`) and the nudge's `fingerprint`. |
| `cover.set` | A person turns their [out-of-office cover](../capabilities/out-of-office-cover.md) on or off with `/oe cover`, or its end date passes. | `on`, the end date (`until`) or the number of `questions` the recap carries, and the door (`via`: `command` or `end-date`). |
| `cover.wake` | A room wake mentions a person whose cover is on, so the wake carries the cover note. | The `wakeId`, whether the question entered the person's recap log (`recorded`), and how many people the message mentioned. Never the question. |
| `cover.answered` | A reply on a cover wake is posted with the host's cover label. | The `wakeId` and the answer's length. Never the answer. |
| `cover.recap` | The recap of a person's cover goes to their own DM. | How many `questions` it shows, how many it `leftOut` because the person could not be shown to read the room, and whether anything was `sent`. |
| `cover.recap_refused` | The recap could not be delivered. | The `reason`, the try count, and whether the tick gave up and dropped the log (`gaveUp`). |
| `bot_ask.expected` | A person's DM opens an asked thread after the platform proves the person wrote the ask and that it names that bot ([Your DM can ask other bots](../capabilities/bot-delegation.md), OPE-2426). It is the only act that lets another bot's Slack message wake the agent outside the e2e driver settings (OPE-1023). | The ask id, the bot's user id, the channel and thread, the window in hours and the reply cap. Never the ask's text. |
| `bot_ask.refused` | The host refuses `expect_bot_reply` before anything is recorded, including on a turn a relayed bot reply woke (`relay-turn`). | The closed `reason` and the tool. |
| `bot_ask.reply_relayed` | Another bot's reply in an asked thread is relayed to the asker's DM. | The ask id, the bot, the channel, the reply slot under the cap, the `route` (`dm-seat`, `posted` or `failed`) and the reply's length. Never the reply's text. |
| `person.opt_out.set` | A person opts out of agent actions on their own content, with `/oe optout on` or the Home tab's button ([Opting out](../capabilities/memory.md#opting-out-of-agent-actions-on-your-content)). | The person in `principalId`, and the door (`via`: `command` or `app-home`). A repeat writes no row. |
| `person.opt_out.cleared` | That person lifts it. | The same two fields. |
| `person.opt_out.refused` | The host refuses an agent act on an opted-out person's content. | The person in `principalId`, the leg (`act`: `memory-write` with its `road` and `tier`, or `message-shortcut` with `requestedBy`), and `storeReadable: false` when the refusal was the fail-closed guess. Never the refused content. |

### The per-surface lifecycle rows

A ticketing surface opens a lifecycle row when a webhook dispatches a woken session, and a terminal
row closes it — the "a row closes a row" carve-out [above](#whats-logged). These are the rows that
open and close, plus the per-surface failures that leave no reply behind.

| Action | When the code writes it | What the row carries |
| --- | --- | --- |
| `github.dispatched` | A GitHub webhook dispatches a woken session. | The dispatch. A `github.replied`, a `github.no_reply` or a `turn.supervisor_prose_dropped` row closes it. |
| `github.supervisor_turn_failed` | A GitHub supervisor turn fails. | The failure — and **no error comment is posted**, so this row is the only notice. |
| `linear.dispatched` | A Linear webhook dispatches a woken session. | The addressing class, the issue, and whether the team is private. |
| `linear.supervisor_turn_failed` | A Linear supervisor turn fails. | The failure, and again it is the only notice. |
| `linear.mention_divert_failed` | A Linear mention divert fails. | The failed divert. |
| `teams.dispatched` | A Teams webhook dispatches a woken session. | The dispatch. |
| `notion.rejected` | Notion's own gate rejects an event. | The rejection. |
| `notion.replied` | A Notion supervisor turn replies. | The close of its `notion.dispatched` row. |
| `<platform>.external_policy_suppressed` | The surface's external policy suppresses a reply. Written on **Slack, Teams, Discord, GitHub and Linear**. | The verdict, the channel id, and whether the member got the one fixed acknowledgement line. Slack's row also carries the route it came in on. |

🔴 **The acknowledgement is owed only to an addressed wake.** An explicit mention or a DM that got
no private answer gets the one fixed host line in the room it was said in. An **ambient or name-drop
suppression stays fully dark** — the row is written, and the room hears nothing. On Discord the
`addressed` predicate is the only gate on that acknowledgement, and it is false for both.

### Action tags that are not audit actions

🔴 **Five dotted names in this codebase look like audit actions and are not.** They are the `action`
tag on an **outbound idempotency key** — the value that makes a replayed send post once — and
nothing appends them to the audit log. An operator who greps one and finds no rows has found the
truth, not a gap.

| Name | What it really is |
| --- | --- |
| `reply.dispatch` | The idempotency tag on the native reply post. |
| `reply.dispatch.unified` | The same tag on the cross-surface window's reply post. |
| `<platform>.post_file.attach` | The tag on the attachment post of a `post_file` send. |
| `thread_seat.dispatch` | The tag on a [thread seat's](../how-it-works/agent-and-loop.md#what-a-thread-seat-writes-to-the-audit-log) own dispatch, keyed on the call id and the seat token. |

The audited action for a reply is `reply.post`, and for a posted file it is `<platform>.post_file` —
one row for the whole batch, written after the post succeeds.

### Inside the append path

The properties above say what the log guarantees. This section says how the append path reaches
them, one part at a time. `appendAudit` (`packages/core/agent/audit/audit.ts`) is the door every
ordinary writer uses.

- **Boot hands the drop counter in, and the module never imports it.** `registerAuditDropCounter` takes
  the telemetry counter as a function and keeps it. `audit.ts` sits below `actions.ts` and
  `flow.ts`, and `telemetry.ts` pulls in commands, config and providers, so a static import there
  closes a module-init cycle. A dynamic `import()` is out too: eve bundles each authored module into
  one chunk, and an internal dynamic import splits a second chunk and fails the build. A process
  that registers no counter still warns on a drop, and that console warn is then the only witness.
- **A caught error becomes exactly one scrubbed field.** `auditErrorDetail`
  (`packages/core/agent/audit/tool-action.ts`) reduces a thrown value to a single `error` string. It
  runs the audit scrub first, on the untruncated text, then collapses every run of whitespace to one
  space, then truncates. The order matters: the scrub sees the whole message, so a redaction arm
  cannot be evaded by length. An upstream error string is attacker-influenceable and
  provider-echoed, so the row treats it as untrusted text — a diagnostic, never an instruction.
- **The writers OPE-2545 swept use that reducer, and a lint checks the writers it can see.**
  `npm run lint:audit-error-detail` (`scripts/audit-error-detail-lint.ts`, OPE-2545) reads every
  audit write in `packages/core/agent` and the provider bundles. It refuses an error-named field
  (`error`, `…Error`) whose value is not `auditErrorDetail(…).error`, a literal, or a name bound to
  one. Under any other key, it refuses a `.message`, `.stack` or `String(err)` read, also inside a
  template's `${…}`. A truncation is not a scrub, so `String(err).slice(0, 300)` is refused too.
  The log cannot be edited, so a token that lands there stays. 🔴 The lint is a text scan of
  shapes, not of data flow. Its test pins the shapes it cannot see: error text held in a variable
  or a parameter under a key that is not error-named, text a helper renders, a record built under
  a name with no `detail` in it, and a spread of an object built elsewhere. The lint parses each
  file (OPE-2554), so the grammar tells a comment, a string or a regex from code. Before OPE-2549 a
  quoted regex or a nested template hid the rest of its file from the text scan, in seven agent
  files. The OPE-2545 review found writers of those shapes by hand and scrubbed each one where
  its error text is built, so a green lint is not proof that every row is scrubbed. Two rows stay
  unscrubbed on purpose, both in `access/eve-patch-probe-boot.ts`: `eve.patch.refused` carries text
  the product writes itself, and `eve.patch.unverifiable` carries the `require.resolve` error for
  eve's own install path. That module evaluates first in the import graph, behind a top-level
  `await`, so it takes no new import that could close an init cycle.
- **An error-named field takes only scrubbed text, and `typecheck:all` checks it (OPE-2549).**
  `AuditInput.detail` and the store's own `appendAudit` take an `AuditDetail`
  (`packages/core/agent/audit/scrubbed-text.ts`). Under an error-named key (`err`, `error…`,
  `…Error…`) it accepts only a `ScrubbedAuditText`, a number, a boolean or `null`. Only
  `auditErrorDetail` and `scrubAuditText` (`audit/tool-action.ts`) make a `ScrubbedAuditText`, and
  the lint refuses a cast to it in any other file. So a plain string under such a key fails the
  typecheck, whether it comes through a variable, a parameter, a helper or a spread.
  🔴 What the type does not cover. A key that is not error-named (`reason`, `message`, `outcome`)
  stays open, because most such fields hold codes the product writes. Error text there is still
  the lint's job, with its limits. TypeScript does not check a spread of a plain record
  (`Record<string, …>`, `StoredAuditDetail`, an inline index type) next to another key, and
  `test:audit-detail-brand` pins that gap. In an audit write, the lint's `plain-record-spread` rule
  refuses a spread of a name the same file types as a plain record, a call to a function the scanned
  tree declares to return one, and `...Object.fromEntries(…)`. It cannot see a plain-record
  variable imported from another file, or one in a branch of a conditional spread. A cast bypasses the type: the lint refuses every cast whose target type names
  `ScrubbedAuditText`, `AuditDetail` or `AuditDetailBuilder`. That covers `as AuditDetail`, a cast
  through `unknown`, and a cast to a container such as `as AuditDetail[]` or
  `as Record<string, ScrubbedAuditText>` (OPE-2554). A renamed import of the brand
  (`AuditDetail as AD`) counts as the brand. The lint reads the type as written, so a cast to a
  local alias or interface of the brand (`type D = AuditDetail[]; x as D`) is not seen. It cannot
  tell an `as never` or `as any` from a legitimate one.
  The two approval rows that store an act's result text, `approval.approved` and
  `admin.approval.decide`, scrub their `outcome` with `scrubAuditText`.
- **The backing location is readable.** `auditRoot` reports where the log writes — the SQLite file
  path, or `postgres`. Logs and admin views print it, so a reader can tell which store answered
  before they read an empty result as an empty log.
- **No type constrains the action vocabulary at the store seam.** `AuditEntry.action`
  (`packages/core/agent/operational/store.ts`) is a bare `string`. The vocabulary therefore lives
  only at its write sites, and nothing rejects a misspelt action name at the seam. The swept list is
  [the behaviour inventory](../inventory/audit-and-spend.md), whose own § "How this list was made"
  states what a textual sweep cannot see.
- **One org's appends run one at a time inside this process.** `withOrgAuditLock`
  (`packages/core/agent/audit/chain.ts`) chains each append for an org behind the previous one. It
  always releases: the stored tail runs the next call whether the previous one resolved or threw, so
  one rejection cannot wedge that org's queue. The caller still receives the real result or the real
  throw.

### Inside the chain walk

`walkAuditChain` (`packages/core/agent/audit/chain.ts`) is the walk the
[verifier CLI](#the-verifier-cli) and the boot check both run. These are its rules.

- **The digest reads `detail` in a canonical form.** `stableStringify` serialises `detail` with
  every object key sorted, recursively. Arrays keep their order, and a member whose value is
  `undefined` is dropped exactly as `JSON.stringify` drops it. `JSON.parse` promises no key order,
  so without this a database round trip could reorder the keys and change the digest of a row that
  nobody touched.
- **A full walk requires a genuine genesis row.** When row 0 carries a non-null `prev_sha`, a full
  walk reports a break: rows before it were removed, or the chain was reset. A `--tail` window makes
  no such report, because the window's first predecessor is out of frame.
- **Row 0 is read as a possible epoch marker too, and that is a security property.** A marker
  carries a null `prev_sha`, exactly as a genesis row does. Judging row 0 by its `prev_sha` alone
  would let anyone who can delete every pre-epoch row pass the marker off as an ordinary genesis.
  The walk would then report no epoch and verify none of the seal's three claims. So the walk reads
  row 0's seal first. A full walk then requires the seal to cover zero rows, and reports the
  disagreement as a break otherwise. A window still reports the epoch, so an operator has to vouch
  for it.
- **A null link in the middle of a chain is its own break, with its own reason.** The walk separates
  two causes. A null `prev_sha` that no epoch marker seals reads as a cleared link — a truncation, a
  reset, or a pre-chain row. A `prev_sha` that is present but does not match the recomputed hash of
  the preceding row reads as a mutated predecessor, a deleted row between the two, or two writers
  that appended concurrently and forked the chain.
- **Breaks are counted by the action of the row that carries them.** `breaksByAction` returns that
  distribution, highest count first, and ties break on the action name. The distribution is what
  names a write-side cause: a fork concentrates on the paths that write concurrently, while a tamper
  does not.
- **Boot re-verifies a fixed window per org.** `bootVerifyAuditChainTail` walks the last 32 rows of
  every org — the `BOOT_TAIL_LIMIT` constant, a tracked literal rather than a setting. It logs one
  loud warning per epoch it crosses, and one per org that holds a break, naming the first break and
  the window's total break count. It never throws, and it never crashes startup: a store error on
  one org becomes that org's soft note and the walk continues. The posture is availability over
  integrity-halt, because refusing to serve would turn a detected break into an outage. A window
  verifies no seal, so an epoch inside it stays unverified until a full walk runs.

### How the store serialises an append

The in-process lock above is exactly as wide as one process. The hosted runtime writes audit rows
from more than one function, so the store adapters carry the cross-process half.

- **SQLite serialises in-process only, and that is the whole engine it needs.** The SQLite adapter's
  `appendAudit` stamps `prev_sha` under the per-org in-process lock. A SQLite deployment is one
  process by construction — a local or single-tenant self-host file — so no second layer exists to
  add.
- **Postgres runs the tail read and the insert on one pinned connection.** `withAuditChainLock`
  opens a transaction on a connection it pins, sets a transaction-scoped `lock_timeout`, takes
  `pg_advisory_xact_lock`, runs the body, and commits. A failure rolls back, which is what releases
  the advisory lock, and the adapter tells `withConnection` about the failure so the driver destroys
  the connection instead of returning a still-in-transaction one to the pool. The helper is
  reentrant: it carries the connection it already holds for an org, so a nested integrity write
  reuses that connection rather than deadlocking against itself.
- **The advisory locks carry a class of their own.** `AUDIT_CHAIN_LOCK_CLASS` is the first four
  bytes of the SHA-256 of `open-everywhere:audit-chain`, read as a signed 32-bit integer. The class
  keeps the per-org keys from colliding with any other advisory-lock user in the same database.
- **The per-org key is derived in Node.** `auditChainLockKey` takes the first four bytes of the
  SHA-256 of the org, as a signed 32-bit integer. Deriving it in Node rather than with Postgres's
  own `hashtext` keeps the value independent of an internal server function, and lets a test name
  the exact key an append must take.
- **The wait for that lock is bounded at ten seconds.** `AUDIT_CHAIN_LOCK_TIMEOUT_MS` is a tracked
  literal, never an environment variable. `pg_advisory_xact_lock` waits forever by default, and an
  append is awaited on the hot path, so an unbounded wait would let one wedged holder stall every
  other instance's appends for that org. Past the bound the append fails, and the log's own
  best-effort contract takes over: one retry, then a counted and warned drop.
- **A client that cannot pin a connection is warned about once.** `warnIfAuditChainCannotSerialise`
  logs one message per process when the Postgres client offers no `withConnection` seam. The
  embedded PGlite floor is the expected case, and the message says so: that floor holds a
  single-writer file lock, so one process is all there is. On a pooled hosted client the same
  message names the real risk — concurrent instances can fork the chain.
- **The chain read takes its client explicitly.** `readAuditChainRows` returns one org's rows oldest
  first, with each row's `seq` and `prev_sha`. It takes the client as an argument, so an epoch seal
  reads the chain on the same pinned connection its insert runs on rather than through the pool. A
  tail limit is served by an inner descending query that the outer query re-orders ascending.
- **Sealing an epoch runs in the same critical section as an append.** Both adapters read the org's
  whole chain and insert the marker under one lock — the advisory-locked transaction on Postgres,
  the per-org in-process lock on SQLite. A row that landed between the read and the insert would sit
  after the era the seal claims to cover, so the two statements must not be separated.
- **The seal returns the marker's sequence rather than re-reading it.** `AuditChainEpochWritten`
  carries the seal and the `seq` the marker landed on — the value `--accept-epoch` takes. Reading
  that sequence afterwards would mean walking the chain again outside the critical section, where a
  concurrent append can already be the last row and name the wrong one.
- **Two store reads serve the walk.** `listAuditOrgs` returns the distinct org ids that key a per-org
  walk. `readAuditChain` returns one org's rows oldest first with their sequence and previous sha,
  and its tail limit is what gives the boot check its window.

### How boot verifies the append-only posture

`verifyAppendOnlyAudit` (`packages/core/agent/operational/postgres.ts`) measures the live catalog
rather than the schema the code intended. It is read-only and safe under any role, so the non-owner
runtime boot calls it too. On every append-only table it checks four things: that row-level security
is enabled and forced; that the table's whole policy set matches the allowlist and carries both a
`SELECT` and an `INSERT` policy; that no non-internal `INSERT`, `UPDATE` or `DELETE` trigger exists;
and that no non-owner holds an `UPDATE`, `DELETE` or `TRUNCATE` grant. It returns the violations as
readable strings, and an empty list means the posture is sound.

`EXPECTED_POLICIES` is that allowlist. It names every policy each append-only table may carry, with
the command the policy covers and the expression it must carry. Checking against an allowlist rather
than against a deny-list is what catches a foreign policy: a `RESTRICTIVE FOR INSERT WITH CHECK
(false)` blocks appends while permitting reads, and no deny-list of `UPDATE`, `DELETE` and `ALL`
policies would see it.

`healUnexpectedArtifacts` is the owner-only repair. It drops every non-internal trigger and revokes
the stray mutation grants on the spot, before anything is recorded, because an insert-swallowing
trigger would otherwise eat the `audit.integrity` row that records the repair. It only PLANS the
drop of a policy outside the allowlist: that `DROP POLICY` runs inside the policy span's
transaction below, because a drop committed here would leave the table policy-less for the whole
schema apply that follows. It is strictly scoped to the append-only tables, and it is a no-op on a
sound posture.

`initOperationalSchema` is where the two roles part. Under the **non-owner runtime role** it
verifies the posture and, on any violation, records the `audit.integrity` row and then throws — the
deployment refuses to serve. That is the fail-closed direction: the runtime role cannot repair a
posture Postgres refuses it the DDL for, so serving on a broken log would be serving without one.
Under the **owner role** it heals, re-applies the schema, records what it repaired, and then
verifies again. A posture still failing after the apply throws as well.

**The policy re-apply is atomic, and it is the only part of the schema that is.** Postgres has no
`CREATE POLICY IF NOT EXISTS`, so re-applying a policy means dropping it first. `POLICY_STATEMENTS`
holds that whole drop-then-create span apart from the rest of the schema, and the heal's own policy
drops ride at the head of it, so every statement that can remove a policy sits in one place.
`applyPolicyStatements` runs that span as ONE transaction on a pinned connection, behind
`pg_advisory_xact_lock` in a class of its own (`SCHEMA_POLICY_LOCK_CLASS` — the first four bytes of
the SHA-256 of `open-everywhere:schema-policy`, as a signed 32-bit integer, beside the audit-chain
class above). Both halves carry their weight:

- **The transaction closes a deny-all window.** Applied statement by statement in autocommit, each
  `DROP POLICY` committed on its own, and every append-only table stood with row-level security
  enabled, `FORCE` on and NO policy until its own `CREATE POLICY` landed. Postgres denies `SELECT`
  and `INSERT` to every role in that state, the owner included. A pass that ABORTED inside the span
  — a killed process, a connection error, a concurrent pass's `duplicate_object` — left the store
  deny-all until the next owner-mode init, and the audit path dropped every row it could not append.
  Inside one transaction the drops and the creates are atomic: no other session sees the table
  policy-less, and an abort rolls the drops back.
- **The lock serialises two inits.** `CREATE POLICY` has no idempotent form, so two passes running
  the span at once could have one create a policy the other had just dropped, raising
  `duplicate_object` (SQLSTATE 42710) and stopping the second pass mid-span. Each pass now takes the
  span in turn, and every `CREATE POLICY` in the span has its own `DROP POLICY IF EXISTS` in the
  same transaction, so the second pass recreates from a clean slate.
- **The span, and never the whole schema.** One transaction over the whole apply would hold
  `ACCESS EXCLUSIVE` on every table for its full length — about 28 seconds measured for the
  owner-mode init pass (OPE-1993) — and block the serving app. Every statement above the span is
  `IF NOT EXISTS` or an idempotent `ALTER`, so autocommit is right for them. The span itself still
  holds `ACCESS EXCLUSIVE` on every policy-bearing table until it commits — about 5 seconds,
  derived from that 28 seconds and never measured on its own — so a boot does briefly queue the
  serving app's statements.
- **The lock waits are bounded.** `SCHEMA_POLICY_LOCK_TIMEOUT_MS` is a tracked literal, never an
  environment variable. It bounds both the wait for another pass's advisory lock and the
  `ACCESS EXCLUSIVE` wait each policy statement takes on its table. Past the bound the transaction
  aborts, which rolls the span back, so the cost of the bound is a failed boot and never a deny-all
  store.
- **A client that cannot pin a connection is warned about once**, the same way the chain append
  warns. The span then re-applies in autocommit, which is all this code can do without a pinning
  seam — a one-connection engine can run `BEGIN` and `COMMIT`, but nothing proves the statements
  land on one connection without the seam. That is correct for the embedded floor. On a pooled
  hosted client the message names the real risk.

**The `audit.integrity` row names the CAUSE.** `auditIntegrityCause` reads the violations and what
the heal removed, and records one of three answers beside them. Each answer names a **catalog
state**, not a history — the catalog carries no history, so read the answer as "what is true", then
look for who did it.

A table with row-level security forced, no policy, and an empty heal is `aborted-init`. An init that
aborted inside the policy span leaves exactly that state. 🔴 So does an owner-credential
`DROP POLICY` — the attack `FORCE` cannot stop — so this answer does **not** rule a tamper out:
check who held owner DDL in the window. Either way the audit rows denied from that moment until this
boot are lost, and the row is the only record that it happened.

An artifact outside the current allowlist — a foreign or `RESTRICTIVE` policy, a policy permitting
`UPDATE`/`DELETE`/`ALL`, a hostile trigger, a non-owner mutation grant — is `tampering`. It wins
when both hold, because an aborted span can only remove. An older release's own shape reads the same
way: the pre-OPE-1812 `USING (true)` audit policies are an allowlist miss on the first boot after
the upgrade, so check the release history before treating a `tampering` row as an intrusion.

Anything else is `unknown`, which is honest rather than empty: the violations still say what is
wrong. Without the cause every state reads identically, and the heal that repairs the posture hides
which one a responder is looking at.

### The verifier CLI

Run the chain verification by hand at any time:

```bash
npm run audit:verify-chain -- [--org X] [--tail N] [--require-rows] [--accept-epoch S] [--root-env FILE] [--max-detail N]
```

It opens **the deployment's own operational store** — the same resolution the runtime uses
(`OE_OPERATIONAL_PROVIDER` plus `DATABASE_URL`), so it reaches hosted Postgres standalone, and it
prints which store it opened. It opens that store **read-only**, so it **appends no row and changes
no posture** — on hosted Postgres and on the embedded floor alike: the ordinary operator connect
runs the schema init, which under an *owner* credential drops unexpected policies and triggers and
appends an `audit.integrity` row, and a verifier must not repair the posture it was asked to
inspect. Read-only is not a promise that no byte moves. On the embedded floor the command still
takes the single-writer lock and opens the PGlite data dir, which writes that dir's own storage
files; and because no schema init runs there, a data dir no writer has ever opened has no
`audit_entry` table, so the read fails with exit `5` rather than creating one. It walks each org's
rows oldest-first, recomputes every `prev_sha`
link, and reports **every** broken link, with a per-action count under the totals. That count is
the diagnostic that matters: a write-side fork concentrates on the actions written concurrently,
while a tamper does not. `--org X` narrows the walk to one org and declares the org this operator
process acts for. `--tail N` walks only the last N links per org — a window that starts mid-chain,
so the genesis assertion is skipped; if fewer than N rows exist the window *is* the whole chain,
and the genesis assertion applies again. `--max-detail N` caps how many broken links are printed
in full (default 20); it never caps the counts. `--accept-epoch S` vouches for the sealed epoch at
row seq `S` and is repeatable — one per epoch the walk crosses. `--root-env FILE` names where to
read the store env from (default `.env.local`).

**The exit contract.** This is the part a CI job or a cron guard depends on, so it is exact:

| Code | Meaning |
|---|---|
| `0` | every chain in scope verified intact — or a bare all-orgs scan of a genuinely empty log |
| `1` | at least one org's chain is **broken** |
| `2` | argument error |
| `3` | **nothing was verified** — the scope matched zero rows |
| `4` | an **unacknowledged sealed epoch** was crossed — pass `--accept-epoch <seq>` once you know who sealed it |
| `5` | the operational store **could not be opened or read** — no verdict was produced, and this says nothing about the chain |

Code `3` exists because "no break found" and "verified" are not the same answer. An empty set has
no broken link, so a mistyped `--org acme-corp` could otherwise report a clean bill of health for
an org that does not exist. The two cases are told apart by **who named the scope**: `--org X`
asserts that org exists, so zero rows there is a failed assertion (`3`); a bare all-orgs scan
enumerates orgs from the log itself and asserts nothing, so an empty log is the true state of a
fresh deployment (`0`). Either way the output says nothing was verified and never says "intact".
Pass `--require-rows` to make an empty scope exit `3` whatever the scope — the right setting for a
guard on a live deployment, where an audit log that has become empty is itself the alarm. A
detected break always outranks a zero-row result, and an unacknowledged epoch outranks a clean
walk. Code `5` is separate from `1` for the same reason code `3` is separate from `0`: an unset
`DATABASE_URL`, an absent driver, a store the read-only connect finds has no schema, or the running
agent holding the embedded floor's single-writer lock are not evidence of tampering, and a cron
guard that read them as `1` would page for a break that did not happen.

### Sealing the pre-chain era

```bash
npm run audit:seal-epoch -- --org X --sealed-by "name" [--go] [--root-env FILE]
```

Appends one `audit.chain_epoch` marker that seals every existing row of that org, as described
under [the properties above](#properties-that-make-the-log-trustworthy). **It repairs nothing** —
the log has no delete, and no existing row is touched. Broken links written *after* the marker
stay broken and stay reported.

Without `--go` it is a dry run: it prints the era it would seal, the break count it would record,
and the era digest, and writes nothing. That claim is carried by the same mechanism the verifier
uses — the dry run opens the store **read-only**, so it appends no row and changes no posture,
which is what lets an operator investigating a suspected tamper run it first. `--go` connects
normally, because it is there to write. Read the dry run first — an epoch row is permanent. Both
`--org` and `--sealed-by` are required, because an epoch row is permanent and an operator act
carries a name. Exit `0` sealed (or a clean dry run), `1` nothing to seal, `2` argument error, `5`
the store could not be opened or read — nothing was sealed and nothing was reported.

**Sealing blocks that org's audit appends while it runs.** The era read and the marker insert are
one critical section per org — they must be, or the seal is born describing rows that are no longer
the era — and the era read is the org's *whole* chain. On a 53,218-row log over a hosted endpoint
that hold is seconds, and every concurrent append for the org waits behind it; an append that waits
past the store's lock timeout is dropped best-effort, with its counter and its warn. Other orgs are
unaffected. Seal in a quiet window.

Order matters: seal only **after** the per-org write serialisation is deployed. Sealing first
records a break count that keeps growing behind the marker.

The command prints the `--accept-epoch <seq>` the verifier will need. That flag is not a
formality: the marker proves only that somebody with `INSERT` wrote it, so the verifier exits `4`
for an epoch nobody named.

### Org-partitioned

Every audit entry carries its org, and every read names one. 🔴 **The store REQUIRES it** (OPE-1812): `readAudit` refuses a filter whose org is missing or empty, in both adapters, and the type makes an org-less read a compile error. It refuses rather than widens, because the org PARTITIONS the log while every other field only narrows it — before this, an org-less read built an empty `WHERE` and returned every tenant's rows. A caller that wants the whole log names the orgs (`listAuditOrgs()`) and reads each, which is what `scripts/audit.ts --all-orgs` does; `audit_query` stays pinned to the deployment org (the hole OPE-1129 closed).

**A read can narrow by a `detail` value, in the store** (OPE-2565). `detailEquals` takes top-level `detail` keys and the string each must equal, and both adapters apply it in the store, before the `limit`: SQLite in the `WHERE`, Postgres by a text match in the `WHERE` and an exact check on the parsed rows, because a json cast would throw on a row that holds a NUL. A reader that needs every row about one object, such as the `oe erase` check of a link-set's `identity.link.confirmed` rows, reads exactly those rows at any log size. A `limit`-capped read of the whole action, filtered by the caller, misses the older rows once newer ones fill the page. The store refuses a key that is not a plain identifier and a value that is not a string, and it never drops a pair: a dropped pair would widen the read. A number, an array or an object in `detail` never matches a string.

`audit_entry`'s Row-Level Security is the second layer, not the first. Its `SELECT` and `INSERT` policies carry the same `app.current_org` predicate the mutable tables use — enforce when the GUC is set, permit when it is unset — on a table under `FORCE ROW LEVEL SECURITY`, so it binds the table owner the app connects as. 🔴 **Nothing in the shipped runtime sets that GUC**, so the policy permits today: it narrows for a deployment that wires `setOrgContext` per request, and until then the store boundary is the control. The table's other property, append-only (the section above), never depended on the GUC and does not now: it comes from having SELECT and INSERT policies only. See [Database](../extending/database.md) for the per-table posture and for what a GUC-wiring deployment must leave unset.

### Reading it

The control plane exposes an `audit_query` read tool for an authenticated admin, and `npm run audit` reads it from a checkout. The store is backed by SQLite for local development and Neon Postgres in production, through the same operational-store seam — see [Database & operational store](../extending/database.md).

`npm run audit` opens the deployment's own store first, and its header names the store it read (`store: hosted Postgres (DATABASE_URL)`, the embedded Postgres floor, or the sqlite file). Read that line before you trust an empty log: the views resolve the store lazily, so a process that never connects would answer from a local stand-in, and "no matching audit entries" would then mean "I looked in the wrong place" rather than "nothing happened". A store the command cannot open is a non-zero exit with the reason, never an empty report. 🔴 **An empty log has a second cause: the answer covers ONE org.** `--org` defaults to the shipped `default` org — an operator process never loads the deployment's config — so on a deployment that declares another org you name it, or pass `--all-orgs` to walk every org the store holds. When the answer is empty and other orgs do have rows, the command names them. `npm run spend` and `npm run routines` carry the same header and the same refusal. All three take `--root-env PATH` to name a different `.env` file; the default is `./.env.local`, relative to the working directory, which `npm run` puts in `packages/core`.

You can also read the audit log **conversationally**, in the chat itself, via the `query_analytics` tool — ask "how many memory writes did we log this week?" or (org admins) "list the last 20 connector writes and who ran them". The read is scope-restricted to what your access already lets you see, and it is itself audited (`analytics.query`), so *who queried audit data about whom* is answerable the same way. Audit records **actions only** — a silence is not a row — so an honest answer about "how often did it stay quiet" comes from the [session transcript](../capabilities/analytics.md#what-you-cant-ask-yet), not from the absence of audit rows. See [Analytics: natural-language querying](../capabilities/analytics.md) for the full scope model and grammar.

### The control-plane read routes

Three HTTP routes serve this plane to a service token
(`packages/core/agent/control/read-route.ts`). Each one is read-only, and each writes its own
`control.service_call` row, so a read of the audit log is itself audited.

**The audit window read is capped twice, and says when the cap bit.** A request may name its own
row cap. The route takes the smaller of that number and the hard ceiling of 1000
(`AUDIT_MAX_LIMIT`), and a request that names none gets 200 (`AUDIT_DEFAULT_LIMIT`). The ceiling
exists so a caller cannot ask for an unbounded scan. It is also the page size of a scan: the store
filters one action at a time, so a multi-action read runs **one scan per named action** and merges
the pages newest-first.

🔴 **An action's own page is the only thing that can hide its rows from the SCAN.** Rows of some
other action never compete for that page — including this route's own `control.service_call`
self-audit row, which a caller polling the route writes on every call. Before this, a long poll's
own rows competed for the same page and could push a wanted row off it. That is a **candidate**
cause of the OPE-1933 reds, not a reproduced one: six minutes of polling at 400 ms is only ~900
calls, below the 1000-row page, so reaching the ceiling needed those rows plus whatever else the
window held. An action holding more than 1000 rows of its own
in the window still has a tail behind its page. The response then carries `scanTruncated: true` and
`capped: true`, plus `scanned` naming how many rows the scans read in total. An action holding
exactly the ceiling reports a truncation it did not suffer. That direction is deliberate, because
over-warning costs one narrower re-read while under-warning costs a wrong conclusion drawn from an
evidence surface.

🔴 **The scan is not the answer, so `capped` carries a second meaning here.** The merged rows are
cut to the caller's one `limit` across every named action, so a common action's newer rows can push
a rare action's rows out of the response even when neither scan truncated. That case reports
`capped: true` and no `scanTruncated`. Read both fields before you conclude that the named actions
never happened: on `capped: true`, raise `limit`, narrow the window, or ask for the rare action on
its own.

🔴 **Every returned row carries its storage `seq`, and the time bounds are not a cursor.** `since`
and `until` compare a wall-clock column. The agent stamps a row's `ts` with the host clock at append
time, so on a host whose clock steps backward a row written later can carry an earlier `ts` than one
written before it — and a `ts >= since` window then drops that row silently and forever. `seq` is
the store's own insert order (sqlite `AUTOINCREMENT`, Postgres `IDENTITY`) and never moves
backwards. A caller that means "everything written after this point" reads the window once to learn
the newest `seq`, keeps the time bounds only as a coarse page bound, and selects the rows whose
`seq` is greater. The field is a locator, not a hash input: a row's chain position is still its
`prevSha`, which this route does not serve and which `--verify-chain` reads instead.

**The unified domain audit refuses a bad query rather than widening it.** `handleUnifiedAuditRead`
serves the cross-surface domain audit. It answers 400 when `domain` is missing or empty, 400 when
`sinceDays` is not a positive integer of 365 or less, and 400 when the domain name is unknown. The
org is always the deployment org, because a service token is a machine credential rather than a
scoped role. The MCP tool is the surface for a caller whose access is scoped.

**The runtime-signal read answers in booleans only.** `handleRuntimeSignalRead` reports whether this
process carries a non-empty deployment id, and whether this process's credential encryption key
decodes to a valid AES-256 key. Neither fact is a secret, but a boolean is the smallest answer that
proves the signal exists: printing the deployment id, a key fingerprint or even a key length would
buy its one caller nothing. Read both as statements about **this process at the moment of the
call**. A present deployment id does not prove that any standing session consumed the revision on
its next turn, and a key rotated a moment after the call is not observed until the next one.

## Streaming the trail to a SIEM

The audit trail can leave the deployment as a stream, not only through the control-plane read route.
`auditExport.targets` in `agent/settings/settings.ts` names one or more SIEMs; the `audit-export`
schedule sends every row to each of them at least once, in OTLP, JSON-array or Splunk HEC form, and
each row carries its `seq`, its `prevSha` link and its recomputed `sha`, so the SIEM can check the hash
chain on its own copy. The chain is unkeyed, so that check has limits; the SIEM export page states them. See [SIEM export](../deploy/siem-export.md) for the formats, the delivery
contract and a worked example.

## The provenance spine: git + deploy history

The audit trail tells you what the *agent* did. To know what the agent was *allowed* to do — and who decided — you read the configuration's own history.

Because config is **config-as-code**, every grant, binding, cap, and routine is a line in your git repo. Its provenance is the git record: the commit, the author, the PR, the reviewer, the merge time. Nothing widens the live **access** policy except a PR → CI → deploy, so the question "who widened this access, and when?" is answered by `git log` and `git blame` over the access config — not by trusting a dashboard's change feed. Runtime overrides move the *other* direction against that baseline: a connector revoke narrows access without waiting for a deploy, and only a **budget** may be bridged upward. Each one is audited with its acting principal, on the same best-effort contract as every other row above, and stays on the reconcile worklist until a config PR makes it the baseline or somebody clears it — see [the override doctrine](./control-plane.md#the-override-doctrine--overrides-are-bridges-never-destinations).

Deploy history closes the loop: a config change is only *live* once it's deployed, so git history (what changed, who, when) plus deploy history (when it went live) together form the full provenance of the agent's governing policy. A read-view that joins those two — *what config changed, who, when, and when it went live* — is the natural counterpart to the override doctrine's "PR widens, override narrows." That joined deploy-history read-view is **Roadmap**; it lands once there's a live deploy and platform token to read from. The underlying records (git history, the platform's deploy log) exist today and are readable directly.

## How the two records reconcile

Runtime **overrides** are where the two records meet. An override is a DB-overlay on the immutable git baseline (see [The control plane](./control-plane.md)); every override mutation is **audited** with its acting principal, and the override doctrine requires it to reconcile back to a config PR (which then shows up in git history) or be cleared. So an override is visible in *both* records while it's live — as an audited runtime action, and as a pending reconciliation against the git baseline — and that double visibility is exactly what stops runtime drift from quietly diverging from the source of truth.
