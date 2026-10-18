# Proactivity & routines

The shift from a *reactive* bot — acts only when you @-tag it — to a *proactive* agent
that acts on a schedule, on a state change, or on an external event. Three triggers,
together: a **manual mention** (reactive — the baseline), a **routine** (a durable,
surface-owned standing instruction, below), and a **webhook trigger** (a config-declared
external event, at the bottom of this page). A routine is the durable unit that carries
a proactive standing instruction.

A routine is a **surface-owned** instruction that fires *without* a fresh @-mention. It
belongs to the channel it posts back into, survives the person who created it, and
self-disables if it keeps failing rather than spamming the channel.

## What a routine is

A routine stores the surface it belongs to and posts into, the natural-language prompt to
run, audit fields (who created it, when), and its run state. There are two shapes:

| Type | Trigger | Behaviour |
| --- | --- | --- |
| **Scheduled** | a cron expression (5-field UTC) *or* a cadence (every N minutes), **plus a required post policy** | Run the prompt on the clock. Policy `every-run`: post the result of every run (daily summary, digest — the post *is* the product). Policy `only-on-change`: post **only when the observed state changed** — the routine carries a durable hash of what it last saw, and the diff verdict is the host's, not the model's. Policy `never`: post **nothing at all** — the work *is* the product (a ticket updated, memory written), so a message would be noise. See [Silent routines](#silent-routines-postpolicy-never). |
| **One-shot** (`once`) | an ISO 8601 UTC instant (`at`) | Fire **exactly once**, then the routine **disables itself** — kept for audit/list visibility, never deleted. The Tag-style "send_later" move: *"check back on the PR in an hour"* → a `once` routine for now+1h; if nothing's changed when it fires, just create another one-shot rather than re-arming anything. No post policy (a single fire has nothing to diff against). |
| **Event subscription** | `event` (`source` + a `jq` filter) | Fire when a matching external event arrives — a PR opened, CI failed. No polling at all: the model only wakes on a hit. See [Event filters are jq](#event-filters-are-jq). |

Orthogonal to the trigger, a scheduled routine can be marked a **durable job** (`job: true`) — see
[Durable jobs](#durable-jobs-persistent-multi-step-work) below.

The post policy is a **required choice at creation** for cron/everyMinutes routines —
there is no default, so every scheduled routine explicitly decides "do I post every run,
only when something's new, or never at all?". The litmus test: if a run finds nothing new, do you
still want to hear from it? A one-shot has no such choice: it posts once, by definition.

A human sets one up in-thread from a plain request (`create_routine`, `list_routines` and
`cancel_routine` are worker tools; the standing conversational seat routes the ask to a worker
rather than holding them itself — see [The agent & the
loop](../how-it-works/agent-and-loop.md#the-toolset-it-works-with)), so routines are created at
runtime, per-surface — not declared at build time. Because a routine fires unattended (and
cancelling one removes a standing guardrail), `create_routine` and `cancel_routine` both
**propose via an approval card**: the routine is armed — or cancelled — only when a human on
the surface clicks confirm (a member-tier gate; the dispatcher's own self-disabling of
broken routines is unchanged and stays unattended). Every create/cancel is audited.

### A first conversation ends in a routine

A person's first DM conversation, and a room's first conversation, steer toward ONE routine that
fits what they said they do (OPE-2514). It is on by default.

**What the person sees.** The agent answers what they asked first. When they have said what they
do, it offers one routine in one plain sentence, with the day and the time: *"Want me to send you a
digest of your open issues every Monday at 9:00?"* In the same turn it hands off the job that
creates the routine, so the routine card posts beside the sentence. Pressing the card's approve
button is the one confirmation. The card's decline button ends the offer.

**It never forces it.** The seat is told to offer at most one routine, and only once. When nothing
the person said fits a routine, it offers nothing. It never makes a routine a condition of helping.

**The host ends the offer when the card posts.** `create_routine` records the offer as made for the
DM or room the card posted from, so the block drops out on the next turn whether or not anybody
presses the card. A press of the decline button then records the answer, and the decided card says
*"rejected; I won't suggest a routine again"*. A routine the person sets up records that instead.
A no said in words before any card posts is different: the host cannot read it. The seat reads
that it must never offer again, and the window below is the host's backstop.

**How the seat knows.** The seat prompt carries a fixed block, "Your first conversation with this
person" in a DM or "This room's first conversation with you" in a room, on every live human turn
while the offer is open (`agent/onboarding/first-routine.ts`). The block names no person, no room
and no id. A worker, a routine fire, a webhook fire and a group DM never read it.

**Who gets it.** A person whose first DM turn after this shipped creates their watch row, and a
room the agent first introduces itself in after this shipped:

| Conversation | The offer opens when | It is stored on |
| --- | --- | --- |
| A person's DM | the person's first DM turn enrols their [watch](#the-chief-of-staff-watch) row | the person's watch row (`firstConversation`) |
| A room | the agent first introduces itself in the room | the `_first_routine` marker, beside the `_onboarded` marker in the room's surface tier |

A person whose watch row existed before, for example from an earlier DM or the Home tab, gets no
offer. A long-time member who never had a watch row does get it, on their first DM turn after this
shipped. A room introduced before this shipped gets no offer. A DM's own surface tier is the person's
personal memory, so the host keeps the DM fact on the watch row instead.

**What ends it.** The first of these:

- the window closes: `routines.firstConversationDays` days after the offer opened (**3**);
- a routine card posts from that DM or room;
- a routine card in that DM or room is declined;
- the person sets up any routine, or any routine is set up in that room.

A card's decision reads the room's marker only when the card was raised in a room. A DM's own
surface tier is the person's personal memory, so the host never reads it for a marker.

`routines.firstConversationDays: 0` turns the offer off for the deployment.

**What it does not do.** It does not create anything without the card. When an approver-chain
rule lowers `create_routine`, no card posts and the routine arms on the person's own earlier
pre-approval. It cannot record a decline said in words. The eval probe
`packages/core/scripts/eval/first-routine-offline.ts` measures the seat's words against four
cases; it is never a gate on the product.

### "Tell me when …": a watch you ask for

A person can ask, in a DM or in a room, to be told when something happens in a connected app (OPE-2510).
For example: *"tell me when a new issue is opened in acme/web"*, or *"let me know when the Acme contract
comes back signed"*. The agent sets up a watch for it. It is on by default, with no setting.

**What the person sees.** The agent says the watch back in one plain sentence: the app, what it watches
for, and where it will tell them. For example: *"I'll watch GitHub and tell you here when a new issue is
opened in acme/web."* In the same turn it hands off the job that creates the routine, so the routine card
posts beside the sentence. The card's approve button is the one confirmation. The card headline names the
app and the condition: *"Start a watch in a direct message that watches GitHub for when a new issue is
opened in acme/web"*. The condition is the agent's words, and nothing checks it against the filter. So the
card's visible consequence line shows the whole condition, then the jq filter an event watch wakes on, then
the instruction it follows. The filter keeps its operators: `<`, `>`, `|`, `[` and `]` read as their fullwidth
twins, so no card surface parses them as a link or a mention. A filter over 600 characters is cut with a marker
that says how much is not shown. The filter and the instruction decide each post, and the person reads all three
before the click.

**Two roads, both on the existing machinery.**

| The app | The watch | What decides a post |
| --- | --- | --- |
| Sends its events here: a registered [event normalizer](#event-filters-are-jq) AND a webhook route that admits its deliveries (see [Does the app's event reach here?](#does-the-apps-event-reach-here)) | An **event subscription**, `event` with a jq filter for the condition | The filter. No polling: the model wakes only on a match |
| Any other connected app | A **polling watch**: an `only-on-change` routine, **hourly** unless the person asks for another cadence | The host's change check. The prompt checks the condition and records only whether it is met and what met it. The watch posts once on its first check, with what it sees now (the [baseline](#the-job-ledger-and-watch-state)), and after that only when the answer changes |

An event source with no matching normalizer is refused at creation, and the refusal names the polling
road. The generic signed-webhook contract (`oe-standard-webhook`) is not a connected app, so the seat
does not list it.

**The condition in plain words.** `create_routine` takes an optional `watchFor`: the condition in the
person's words, one line of at most 120 characters. It rides only an event trigger or an `only-on-change`
trigger, and a clock routine that carries one is refused. The card freezes it, and the arm click writes it
onto the routine row (`Routine.watchFor`). The card headline, the outcome and the person's
[list](#everything-i-do-for-you-one-list-per-person) read it. **It decides nothing.** The filter or the
prompt still decides each post, and the card's visible line shows them beside it. An `edit_routine` of a polling watch clears
`watchFor`, because the new prompt can change what it watches for. An event watch keeps it, because an
edit cannot change the filter.

**Only an ask arms a watch.** Connecting an app creates no routine and no subscription. The seat block says
so, and `test:ask-watch` pins the modules that may call `addRoutine`: the routine card's click, the explicit
`subscribe_pr` ask, and the store.

**How the seat knows.** Every live human turn on a conversational seat, in a DM or a room, carries a
fixed block, *"Tell me when …"* (`agent/routines/ask-watch.ts`). Its words are fixed apart from the list
of apps whose events reach this deployment. That list changes only when an operator sets up or removes an
app's webhook. A worker, a routine fire and a webhook fire never read it.

#### Does the app's event reach here?

A registered event normalizer proves only that this deployment can read an app's payload. GitHub's
normalizer ships in core, so it is registered on every deployment, with or without a GitHub webhook. Since
OPE-2547 the bundle that mounts an app's webhook route also registers a **reach probe**
(`agent/routines/event-reach.ts`, `registerEventReach` on the adapter barrel). The probe asks the same
question the route's gate asks: can a delivery get through to the routine plane?

| App | Its events reach here when |
| --- | --- |
| GitHub | `GITHUB_WEBHOOK_SECRET` is set, or the dev-only `webhooks.allowUnverifiedGithub` setting is on |
| Linear | `LINEAR_WEBHOOK_SECRET` is set, or a registered app (`LINEAR_APP_<SLOT>_*`) has its own webhook secret |
| Notion | an integration's inbound secret (`NOTION_WEBHOOK_SECRET`, or a domain's own) resolves. The unverified hatch does not count: it never fires a routine |
| A declared hook, by its name | always: the generic ingress admits a declared hook's deliveries |

The answer has three values. `reaches` and `deaf` come from the probe. `unknown` means no probe is
registered, or the probe threw. A probe throws when it cannot tell: the Notion probe answers no only when the
secret is set nowhere, and throws on any other failure. One case still reads as `deaf`: the credential store
falls back to the env var when it is unreachable, so a Notion secret kept only in the store reads as not set
during a store outage. Three places read it:

- **The seat** offers an event watch only on an app that `reaches`. Any other connected app takes the
  polling road.
- **`create_routine`** refuses an event routine on a `deaf` app, and the refusal names the polling road.
  It refuses on `deaf` only, so an `unknown` source arms as before.
- **The dispatcher** sweeps every active event routine on each tick (`schedules/event-reach-sweep.ts`).
  When the routine's app turns `deaf`, it posts one line into the routine's room: *"⚠️ GitHub's events no
  longer reach me, so this watch can't fire"*, with the watch in words and the way out. It marks the row
  (`Routine.unreachableSince`), so the room hears it once. When the app `reaches` again, it posts one more
  line and clears the mark. The routine stays active the whole time. An `unknown` answer posts nothing. A
  stopped routine loses its mark with no post, so a re-enable while the app is still deaf is told again.
  One tick posts at most 10 lines, and the rest carry over to the next tick.
- **The inbound-webhook tools** name an app that `reaches` (OPE-2609). An app's own event stream has
  no row in the declared-hook config, and `list_webhooks`, `capture_events`, `list_recent_events` and
  `read_webhook_history` read only that config. In a live run a worker that looked GitHub up there read
  "no inbound webhooks are declared". It told the room that no GitHub issue-event source exists, and it
  never called `create_routine`. Now `list_webhooks` lists each app that `reaches` in `appSources`, and
  its message says how to subscribe. A lookup of that app's key in the other three tools answers that it
  is not a declared webhook, and names `create_routine` with trigger kind `event` and the app's key. An
  app that is `deaf` or `unknown` is not named.

The probe reads configuration, not traffic. A count of recent deliveries was the other choice, and it is
wrong for a watch: a quiet repository sends nothing for weeks, so a silence threshold would call a working
watch broken. The cost is that a webhook the vendor side stopped sending (an App uninstalled on GitHub's
side, a webhook deleted in Linear) is not seen.

**What it does not do yet.** It cannot see a vendor-side outage, as above. A polling watch runs a model
turn on each check, so it costs a turn an hour. The live leg `S-ASK-WATCH` proves the ask-to-card road on a
board.

### Living with a routine after you've armed it

Setting one up is the easy half. Four more verbs cover the rest of its life, and all of them keep
the routine's **id, history and accumulated state** — which is what makes them different from the
cancel-and-recreate they replace:

| Ask | Verb | What happens |
| --- | --- | --- |
| "show me what it'll actually say" | *(no verb needed)* | `create_routine` returns a **preview**: the exact message the first fire will receive, protocol block and all, rendered by the same code the dispatcher uses. |
| "test it first — what would it post?" | `test_routine` | Runs the routine **once as a test**, on a new opening post in this room (a new thread on Slack). The real reads and the real model run, but every write is blocked and nothing is posted but the test's own answer. The test ends with a list of the writes it would have made. An event routine's test replays the last event it matched. See [Test it before it runs](#test-it-before-it-runs). |
| "run the digest now, don't wait for 9am" | `run_routine_now` | Brings the next run forward without touching the schedule. It isn't instant — the routine becomes *due* and the scheduler picks it up **within about 10 minutes** — and it's limited to one manual run per routine per few minutes. |
| "change what it says" | `edit_routine` | Proposes a card showing the **old and new text side by side**. Confirming rewrites the instruction and keeps the schedule, the id, the run history, a watch's baseline and a job's progress. ⚠️ It also **revokes any standing approvals** the routine had built up, so it goes back to asking. |
| "start it again, I've fixed the problem" | `enable_routine` | Proposes a card naming **why it stopped**. Confirming re-arms it in place, clears the strike counter, and keeps everything it had learned. |
| "stop letting it open PRs on its own" | `revoke_routine_permissions` | Withdraws every standing permission the routine holds, leaving the routine itself running. It goes back to posting an approval card for each of those actions. |

To change a routine's **schedule** or **post policy**, cancel it and create a new one — those are the
shape a human approved on the original card, so they get a fresh card that shows the whole shape
rather than a prompt diff.

Two deliberate refusals worth knowing: a **finished job** (one that called `complete_job`) can't be
re-armed or edited — completion is terminal, not a pause — and a **spent one-shot** can't be
re-armed either, because there is no future instant left for it to fire at. In both cases the answer
is a fresh routine.

### Test it before it runs

A routine runs with nobody watching, and it was written before anybody saw it run. So when a routine
is created or edited, the confirmation ends with *say “test it” to run it once with every write
blocked*. Ask for it, and `test_routine` runs the routine **once as a test**:

- It starts within one dispatcher tick (about 10 minutes), like `run_routine_now`. It starts whether
  or not the routine is due, and it also works on a routine that is turned off.
- It posts an opening post in the routine's own room — *🧪 Test run of the routine …, asked by you* — and
  runs the routine in a session of its own, anchored on that post. The routine's real
  [pre-run reads](#pre-run-data-collection) and the real model run, with the fire message a real run
  gets. If its [condition gate](#condition-gates) says the real run would skip now, the opening post
  says so, and the test runs anyway.
- **Where the answer lands depends on the platform.**
  - **Slack:** the opening post is a thread root, and the answer and the list land in that thread.
  - **Teams:** the opening post starts a reply chain of its own (in a channel, a new post in the
    channel; in a chat, a new message). The run's answer and the list both reply to it.
  - **Discord:** Discord has no thread for this, so the answer lands in the routine's own channel
    after the opening post, and the list is a Discord reply to the opening post.

  On every platform the test runs in a session of its own, so it never continues the room's
  conversation or a person's own chat.
- **An event routine replays its last event.** An [event routine](#event-ingress--de-duplication-fan-out-and-matching) runs when an event
  arrives, so its test replays the **last event its trigger matched**. The opening post names the event
  by its kind and time, never by its contents. The routine keeps that event when it arrives, but only
  when the routine's room may read it (the event's read grant), and it keeps at most one event a minute.
  The test checks the read grant and the room's audience again before it starts, because either can
  change after the event arrived. For an event from a configured webhook, it reads the hook's
  declaration as it is now: when the hook is gone, or now shares less of each event (for example it
  became trigger-only), the test is refused. It reads the thing the event is about again, as a real
  run does. If the routine's filter would not match that event now (the filter was edited), the opening
  post says so, and the test runs anyway. An event routine that has matched no event yet cannot be
  tested, and the reply says so.
- **It blocks every write.** Only reads run: reads of rooms, threads, files, tickets and pages,
  connector operations whose tier is `read`, and the answer in the test thread itself. Every other tool
  call is stopped before it runs, and the run is told to carry on as if it had worked. That includes a
  write the routine has a [declared permission](#what-a-routine-may-do-on-its-own) for, `bash`, a file
  edit, a file post, a reaction, a status update, and the routine's own bookkeeping
  (`record_watch_state`, `report_run_failed` and the rest). A blocked connector write posts no
  permission card. A tool that eve runs as a workflow, such as `ask_question`, cannot be stopped at
  the call, so the test takes it away instead, and the list does not name it.
- **It ends with a host-written list** beside the opening post: *It would have made these writes. I blocked all
  of them, so nothing was changed*, with one line for each write and a short quote of what it would
  have written. When the run tried no writes, it says that instead. When the list cannot be read back,
  it says that, and never "it tried no writes".
- **A test that cannot start says so in the room**, in one top-level line that names why: the routine
  cannot be tested, its creator is no longer in the room, the deployment is halted, its spending
  limit is reached, or (for an event routine) the room can no longer read the event or its people may
  not see it. The creator check is the one a real run meets, on Teams as well; a Teams room check
  that cannot answer lets the test start and writes a `routine.eligibility_unresolved` row, as a real
  run does.
- **No fence, no test.** The `routine-test-run` hook is the only part that marks a test's session, and
  the write fence works only on a marked session. When an app excludes `hook/routine-test-run` in
  `roster.config.ts`, a test cannot block its writes. Then `test_routine` queues no test, the create
  and edit replies offer none, and the dispatcher starts no test that was already requested. The room
  is told that *this deployment has no way to block a test's writes, so the test would change things for real*.
- **It changes nothing on the routine.** The schedule, the last run, the run count, the
  [check-in](#when-nobody-checks-in-keep-going-or-it-pauses) count and the failure count stay as they
  were. A failed test is not a strike.

Some limits are deliberate:

- **Slack, Teams and Discord.** A test needs a session of its own, and each platform's bundle says how
  to anchor one. A platform whose bundle does not is refused in words: *a test run is not available on
  this platform*.
- **An event routine replays a kept event, not a live one.** It is the latest event the routine kept,
  and it can be up to a minute older than the latest delivery.
- **A finished job cannot be tested.** Completion is terminal.
- **One test per routine per dispatcher tick.** A second request inside that window is refused.
- **A person asks for a test.** A routine fire has no acting sender, so it cannot start a test of
  itself or of another routine.
- **What it reads is real.** A test reads the same rooms, pages and tickets a real run reads, and it
  spends model tokens under the same [spend cap](#spend-caps). It does not change them.

### When nobody checks in: Keep going, or it pauses

A recurring routine has no end. That is the point of a daily digest, but it also means a digest
whose channel went quiet keeps running and keeps spending. So a recurring routine counts its runs
since a person last checked in on it.

- After **100 runs** with no check-in (`routines.attentionWarnRuns`), it posts **one card** where its
  reports land: *Keep going?* with **Keep going** and **Let it pause**. The run still happens.
- A **Keep going** press starts the count again from zero.
- With no press, it **pauses** after **24 more runs** (`routines.attentionPauseRuns`). It says so once,
  with a **Resume** card. A Resume press starts it again with a fresh count.

A check-in is a press of either card, or a carded `edit_routine`, `add_routine_rule`,
`remove_routine_rule` or `enable_routine` on that routine. `enable_routine` also lifts the pause. A
member's **reply in the routine's report thread** is a check-in too: it starts the count again, as a
Keep going press does. The
count covers `cron`, `interval` and only-on-change routines, durable jobs included, and silent routines
too: the card is the only sign a silent routine still runs. A one-time routine runs once, and an
event routine fires because something happened, so neither is counted.

Some limits are deliberate:

- **A reply counts only where the agent can hear it.** The reply must come from a person whom the host's
  trust gate rated `principal` or `peer` on that wake. A bot, an author with no id, and an author in a
  room the gate did not confirm as internal render `unauth` or `relay` and do not count. In an internal
  room the gate rates by refutation: on Slack a guest or an outside account is refuted and does not
  count, but a member lookup that cannot answer leaves the room's verdict in place, so that author
  counts; on Discord and Notion only the operator's author-trust register refutes an identified person.
  This is close to the Keep going press's `member` bar, and not the same check. The reply
  must land in the report's own thread, for 30 days after the report:
  - **Slack:** the thread under the report, or the thread that holds it.
  - **Teams:** in a channel, the reply chain under the report, or the chain that holds it. A personal
    or group chat has no reply chains, so a reply there does not count.
  - **Linear:** a reply nested under a top-level report comment. A top-level report keys on the issue
    too, so a member's top-level comment on that issue also counts.
  - **Discord:** a thread opened off the report, or the thread that holds it. A plain Discord reply (a
    message reference in the channel) is not a thread and does not count.
  - **GitHub and Notion:** the issue or the discussion the report is in.

  A top-level message in a Slack room does not count. In a room that hears only @mentions, only a reply
  that mentions the agent counts. Slack is proven end to end on both roads below. Teams, Linear and
  Discord are proven at the record: the thread a report records is the thread the front mints for a
  reply there (`npm run test:routine-report-thread-surfaces`). No live tenant has confirmed the Teams
  `replyToId` of a channel reply.
- **A reply never resumes a paused routine.** Only Resume or `enable_routine` turns it back on.
- **A native fire counts too** (OPE-2558). A fire with `delegation.oneshotAgent` off, or in a room with
  no seat, runs as its own session on the surface, and its `reply` posts through the per-surface door.
  That door records the report's thread on Slack, Teams (a channel) and Linear (an issue comment). On a
  room with no window, the `hook/routine-report-reply` hook counts a member's message in that thread.
  A Slack guest whom `users.info` identifies does not count on either road. The native Slack @mention
  door looks the author up with the same probe the windowed door uses, and stamps a guest or outside
  account as a non-member (OPE-2572). When the probe cannot answer, nothing is stamped. One difference
  from the windowed road:
  - **On Linear only a nested reply counts.** A native top-level comment names itself as its thread, so a
    member's top-level comment on the issue does not count on the native road.

  A native report on Discord, Notion, GitHub, Google Chat or email records no thread. A test run
  records nothing.
- **A routine never pauses without a posted warning.** A room that cannot take a card (a Teams
  routine today, or a surface with no approval-card path) gets no warning and so never pauses.
- **A press decides from the routine as it is now.** A stale Resume card never revives a routine that
  stopped for another reason, such as three failures or its ceiling. The tidy sweep expires a card
  once it stops being the routine's live card.
- **A check-in and a pause in the same instant leave a routine a card can resume** (OPE-2557). Each
  check-in (a press, a reply, an edit or a rule change) and each pause decides on the routine's row as
  the write replaces it, never on an earlier read. A press that meets a pause resumes the routine. A
  reply that meets a pause leaves the routine paused, with its Resume card working. A pause that meets
  a check-in does not land, and the routine runs as usual.
- **A durable job keeps its 200-run / 7-day ceiling** as a hard backstop. A Keep going press does not
  extend it.

Set `routines.attentionWarnRuns` to `0` to turn the check-in off for a deployment.

### Standing rules: correcting a routine without rewriting it

A routine's instruction is written before anyone has watched it run. The first time it does something
wrong at 03:00, "don't do that again" needs somewhere to live — and for an ordinary routine there was
nowhere: every fire starts a fresh session that remembers nothing, so the only correction channel was
rewriting the whole prompt.

So a routine can carry **standing rules** — short, dated imperatives that every one of its future
runs is handed as trusted instructions, above the task:

```
[rules] Standing rules for this routine. A human in this channel confirmed each one on an approval
card, so they are instructions, not suggestions: they OVERRIDE your default judgement and you follow
them exactly. If one conflicts with the task below, the rule wins — say so in your answer rather than
working around it.
- (p-1a2b3c4d, 2026-07-20) Never post before 09:00 UTC.
    why: the 2026-07-19 run woke the channel at 03:12.
(1 of 20 rules. Anyone in this channel can change them — ask me to list, add or remove a rule, and
I'll post a card for someone to confirm.)
```

| Ask | Verb | What happens |
| --- | --- | --- |
| "don't ever post before 9am" | `add_routine_rule` | Proposes a card showing the rule **and the reason for it**. Confirming adds it to the routine; every fire from then on carries it. |
| "drop that 9am rule, we've moved the digest" | `remove_routine_rule` | Proposes a card naming the rule, **who armed it, when, and why**. Confirming removes it. |
| "what is it actually following?" | `list_routines` | Lists each routine's rules with their ids — which is also where you get the id to remove one. |

Four things about the shape are deliberate:

- **`why` is required.** A rule is re-read on every run for as long as it exists, and nobody can
  retire one safely without knowing what it was for. A bare imperative with no cause outlives the
  problem it was written for and nobody dares delete it.
- **Every rule takes a card**, whether a person dictated it or the agent proposed it after a bad run.
  The card is not friction on the second case — it's how a rule becomes *visible in the room at the
  moment it is created*, which is the whole point.
- **There is no edit verb.** Changing a rule is remove + add: two cards, so each wording gets read on
  its own, and no rule's provenance is quietly rewritten under new words.
- **Twenty rules is the cap, and the twenty-first is refused** rather than silently evicting the
  oldest. Auto-eviction would delete a guardrail with nobody deciding to. The block is also re-sent
  on *every* run forever, so its cost is permanent — being made to prune is the feature.

Rules are available to every kind of routine, not just durable jobs. A durable job already has two
ways to be corrected (a live session you can talk to, and its own progress ledger); an ordinary
scheduled routine has none, so this is where it matters most.

#### Why a rule can't come from a run, or from something the agent read

A rule is the only text in Open Everywhere that becomes a **trusted instruction inside unattended
runs, indefinitely**. So the approval card is the last of four gates, not the only one:

1. **A routine's own run can't add or remove a rule** — refused outright. No routine amends its own
   doctrine, however clean the run looks.
2. **A turn that has read external content is floored at a human decision.** Both verbs declare
   `taint: "gate"`, so a tainted turn's verdict cannot fall below a card. No lowering rule
   auto-approves it, and a tainted run with nobody in the room is denied. `create_routine` and
   `edit_routine` carry the identical floor.
3. **An unattended durable job doesn't hold either verb.** They're withheld from a job run that no
   human has spoken to, alongside the other self-modification verbs.
4. **The card** freezes the exact wording and needs a verified person to click it.

Removal carries the same four gates as adding, and not out of symmetry: stripping the rule that
was written to stop an attack is an easier move than authoring a malicious one.

What that leaves — stated plainly, because it's the honest floor of any human-in-the-loop design — is
that someone can still be talked into typing a bad rule themselves and confirming it. That's the same
residue `create_skill` carries.

### What a routine may do on its own

A routine still meets every approval gate its work touches. An approval card needs somebody to click
it, and a fire has nobody acting on it. So at two of those gates a fire **refuses** rather than
waits: the approvals plane turns a gate into a refusal (`ask-unattended`), and a connector write or
delete now does the same. The fire ends and says what would have lifted the gate, instead of hanging
on a card.

`post_file` has no gate. It attaches every file to the room, an HTML page included, so a fire posts
files the same way an attended turn does. Read the rest of this section as being about **connector
ops**, the gate this page describes in detail.

**This includes a fire you asked for yourself.** (To see what a run would do without letting it do
it, use a [test run](#test-it-before-it-runs) instead.) `run_routine_now` does not run the routine in your
conversation — it moves the schedule forward, and the dispatcher fires it exactly as the clock would.
That fire carries the same unattended marker, so it refuses on the same terms even though you are
sitting right there. Declare the permission on the creation card, or do the work in the conversation.

So a routine can carry **declared permissions**. You give them on the creation card, and they are
what lifts the gate on every later fire:

- **One row names one tool.** A declared permission is spelled `tool:<the tool's own name>` — for
  example `tool:notion__share_page` — and it lifts exactly that tool. A routine that writes with
  three tools declares three rows. `tool:notion` is refused: a connector slug names no tool, and one
  click must not buy every write verb a provider happens to expose.
- The agent proposes a *conservative* set, so you approve the routine and what it may do in one
  read: *"🔑 may, without asking: open pull requests · use the "notion__share_page" tool —
  anything else will ask you first"*. The proposal is frozen when the card is posted, and nothing is
  declared until you click.
- **A standing write is armed by a person's click only.** A standing write is a declared `pr.open`
  or a declared connector tool that is not a read. When the declared set names one, the approval
  judge is never consulted for the creation card, whatever your pre-approval rules say. The `approval.judge.verdict` row records `source:
  "human-only"`. A set of reads only keeps the ordinary judge path.
- A covered call then runs with **no card**. A nightly job that shares a Notion page under a
  `tool:notion__share_page` row simply shares it.
- Anything the set does not cover is **refused** — including another tool on the same connection. A
  refused connector write names the exact declaration that would have covered it; the approvals
  plane's own refusal names the creation card without naming a permission. Both also post a
  **permission card** into the routine's room (see below), so the usual answer is one click. You can
  still re-create the routine with that row on its card instead. Some refusals get **no card**, and
  the list is short: a **delete-tier verb**, which `create_routine` refuses to declare in the first
  place; a **poisoned turn**, which no declared row lifts; a tool **this deployment's own connector
  configuration raises to the delete tier** (see below); a fire the host cannot attribute to a
  named person, because a card has to say who it was raised for; and a routine whose room is on a
  **platform with no approval-card path**, where the card could be posted but never clicked. In each
  of those the refusal stands alone — ask a person to do that work in a conversation.
- A fire that has **read untrusted external content** is refused even when a row covers it. No
  declared permission lifts a poisoned turn, on either gate. A connector's reads are untrusted while
  its grant declares `contentOrigin: "external"` **or declares nothing** — the shipped Notion grants
  declare `external` — so a read-then-write routine over it **refuses every night**. On an MCP
  connection, the `connection_search` that lists the operation is such a read too: it answers with
  the declaration of each connection it finds. The e2e fixture's org Notion connection declares
  `internal`, because only org members write in that test workspace. A grant may
  also declare the origin **per tool**, as `{ default, except: { <bareToolName>: "internal" } }`, so
  one connection can rate one of its reads differently from the rest.
- **The refusal names the one remedy, and what that remedy costs.** A person told to "raise it again
  in a turn that has not read anything external" can start a clean turn; a fire cannot — it reads,
  then it writes, on every fire. So a poisoned connector refusal also says that only
  `contentOrigin: "internal"` lifts the taint, and that declaring it asserts that org members author
  everything the connection returns. **Do not declare it to unblock a routine.** For a Notion
  workspace the honest answer is usually `external`: a page is written by whoever can write in that
  workspace. A nightly refusal is the correct outcome there — ask a person to do that write.

**A declared write can run twice.** Eve delivers a turn step *at least once*, and a lifted write
executes inside that step. A crash in the window before the step commits re-runs it, so the vendor
can see the same write twice. Nothing deduplicates it for you. This is a real cost of declaring the
permission rather than a pre-existing one: before a declaration lifts the gate, the write never
executes at all — it parks on a card nobody clicks. So declare a tool whose effect is idempotent,
and treat a nightly write as something that may repeat.

Only two things are declarable this way: **opening pull requests**, and **one named connector tool**.
Deletes are never declarable — a delete-tier tool is refused when you try to declare it, and refused
again on every fire whatever rows exist. Nor is anything a routine authored in a turn that had read
untrusted external content asked for: that routine starts from zero standing authority even if you
arm it.

**A tool your own configuration declares destructive grants nothing, and the card says so.** A
deployment can list a connector op under `connectorOps.destructive` in its bundle configuration. That
declaration reaches the fence, so the op refuses on every unattended fire — even for an ordinary
write verb the agent may name on a creation card, because the model-facing check reads the built-in
classification and must give the same answer on every deployment. So the arming card names the
declaration instead: the line reads
*"the "acme__share_report" tool, which this deployment's bundle configuration raises to the delete
tier — the fence refuses it on every unattended fire (grants nothing here)"*, the click writes no
row, and the arming outcome lists that declaration as **not armed**. No permission card is offered
for one either. Before this the declaration armed cleanly, showed on the card as a real permission,
and then lifted nothing on every fire with nobody told. If you want the routine to do that work,
either take the op out of the destructive list or have the routine ask a person.

This card line reads your **configuration** only. A deployment can also register a connector-op *arm*
that raises a verdict per call, and the card deliberately says nothing about one: an arm's answer can
differ between calls and between processes, so putting it on a frozen card would tell a human
something that is not stably true. The fence still refuses an arm-raised op at fire time, and the
routine's refusal names it there.

**A tool name is compared exactly as it is spelled.** Segments may carry uppercase, so a vendor tool
mounted as `acme__API_post` is declarable as `tool:acme__API_post`. The comparison is
case-sensitive throughout, so that row lifts that name and no other — `tool:acme__api_post` is a
different row for a different tool.

**Nothing parks on a card any more** (OPE-2340). Every approval is an OE card that posts and
returns; no turn waits on a click. A connector **read** on a deployment that turns
`connectors.opTiering` off needs one approval per call, and on a fire there is nobody to name on
the card, so the read is refused like a write. A turn whose surface the host cannot resolve is
refused the same way. A `run_routine_now` fire is unattended too, so it refuses on the same terms.

Because a declared permission is standing and fires with nobody watching, three things hold:

- `list_routines` shows each routine's **full declared set**, in plain language;
- `revoke_routine_permissions` withdraws the lot **without cancelling the routine**;
- `edit_routine` **invalidates every permission**. Rewriting what a routine does resets what it may
  do, so "get it approved, then change the instruction" can't launder standing authority onto text
  nobody read.

And because that makes an edit an *authority event*, **what the authority covered is kept**. An edit
patches the new text over the live row, so without a record the previous instruction — the one a
human actually read on a card and armed — would be gone, and the audit row for the edit deliberately
stores only its *length*. Every prompt-replacing edit therefore appends the superseded text (and, on
a routine's first edit, the text it was created with) to an **append-only** `routine_prompt_revisions`
log, together with the `promptGeneration` it ran under — the same generation a declared permission's
key embeds, so a permission in the audit trail leads back to the exact instruction it covered. Read it *with*
the live row: the log is what the routine used to say, the row is what it says now. On Postgres the
log is insert-and-select-only under `FORCE ROW LEVEL SECURITY`, so the credential the app holds — the
one that *can* rewrite the live routine — cannot rewrite the record of what was armed (see
[Database & operational store](../extending/database.md)). Nothing prunes it: a row exists only
because someone approved an edit, so it grows with approvals, never with fires. Two honest limits —
a routine nobody has ever edited has no rows (nothing was destroyed), and cancelling such a routine
leaves its text only in its `routine.create` card's frozen args.

### Asking after the fact — the permission card

A creation card is not the only moment. When a fire is refused an action a creation card *could*
have declared, the refusal posts one **permission card** into the routine's own room. By default
the refusing call then holds for up to 120 s (the [timed wait](#the-timed-wait) below), and an
approval inside that window lets the run that asked do the work. With the wait's `0` opt-out, that
run is refused at once. Either way, the card decides every **later** run.

- **Approve** writes exactly the row the creation card would have written, so every later fire of
  that instruction does the work without asking.
- **Decline** is remembered. The routine stops asking for that permission, so a refused request
  never turns into a nightly nag. Later fires still refuse, and the model is told the permission was
  declined rather than left to conclude the tool is broken.
- **Ignore** leaves the card where it is. It stays clickable, and no second card is posted for the
  same permission.

**The refusal points at the card.** It names the card's state, and where the surface mints a
per-message URL it quotes a link straight to it. A surface that has no such URL names the room
instead, which is true everywhere. The reference is read back off the card's own row, never composed,
so a refusal cannot quote a link to a card that is not there.

**A card is only "waiting" if its row is.** The marker that records the ask is written when the card
posts and nothing removes it when a card is answered, so it outlives the card. The refusal therefore
reads the card's own pending row before it says one is waiting. Where the marker is there and the row
is gone — an approve whose grant write failed, a decline whose memo write failed, both best-effort by
design — the next fire posts a **fresh** card rather than pointing at the one that has gone. Where
the card store cannot be read at all, the fire says so and posts nothing: a second card beside a
first that is still clickable is worse than a sentence that admits what it could not check.

**The card has no clock.** Its life is the routine's instruction, not a timer: an `edit_routine`
resets the ask, the decline and the grant together, because all three are keyed on the same
`promptGeneration` as a declared permission. A 24-hour expiry would have been actively wrong here —
a weekly 03:00 job's card would die unseen and the next one would not post for another week. A click
after an edit arms nothing and says so, which is what makes a late click exactly as safe as an early
one.

**The card itself is closed by the daily sweep.** Its pending row carries no clock either, so nothing
would otherwise take the buttons away once its generation moved on — the room would keep a card whose
every click answers "nothing was armed". The sweep reads each open card's frozen routine and
generation, and expires exactly the cards a click would now refuse: the routine was edited, or it was
deleted. A card on the routine's current instruction is never touched, and neither is one whose
routine the sweep could not read.

**It is one card per permission per instruction**, posted where the routine reports.

**Two refusal sites raise it.** The approvals plane raises it for `pr.open`. The connector plane —
the gate that refuses an unattended connector op — raises it for `tool:<the op>`, naming the exact
qualified tool its own refusal already tells you to declare. Both post the same card, into the same
room, and both feed the run's [outcome summary](#what-one-run-could-not-do) the same way, so one refused
fire reads as one story however many gates it hit.

**The connector plane's card never covers a delete.** A destructive verb is refused on every
unattended fire whatever row exists, and `create_routine` refuses to declare one at all, so offering
a click that would arm nothing would be a promise the runtime does not keep. Such a refusal stays a
plain refusal. So do four more: a turn that has read untrusted external content; an unattended run
that is not a routine fire, such as a webhook fire, which holds no routine and so has no instruction
to arm; a fire whose attested creator the host cannot read, because a card frozen with nobody names
nobody to whoever opens it; and a routine whose room is on a platform that renders no approval card,
where a post would land somewhere nobody can click.

**One card per tool, so a broad fire can post several.** A routine that is refused four different
connector tools in one fire gets four cards, because one declared row arms one tool. That is once per
instruction, not once a night: the next fire re-points at the cards already waiting. A fire refused
more than sixteen permissions still posts every card, and its run summary lists the first sixteen.

**A connector refusal does not wait.** The timed wait below is the approvals plane's: it holds the
model's turn, which is where that refused call lives. A connector refusal is decided inside the
connection's own approval gate, so it posts its card and refuses at once. The click still arms every
later fire, which is the card's own question.

### The timed wait

By default the refusing call **holds** for a bounded window, so somebody who is around can answer the
card while the run is still up. `approvals.routineCardWaitSeconds` sets that window and **ships 120**
seconds. Set it to **0** to opt out: the refusal is then immediate, the run gets nothing, and the card
decides only later runs.

The wait applies to every fire that posts a card **or points at a live one** — the clock never proves
that nobody is there, so a 03:00 cron fire gets the same window a hand-pressed fire gets.

Only one way out lets the run act:

- **Approved in the window.** The click writes the standing permission, the run reads that row back,
  and it does the work. Every later run is armed too, exactly as if the card had been answered after
  the fact.

Every other way out refuses the run, and each says which one it was, because the routine's owner needs
them told apart:

- **Declined in the window.** The model is told a person declined it — and nothing more. Whether that
  decline is *remembered* is the card's business, settled by the same click-time re-check every
  decision goes through, so the run does not report it either way.
- **Nobody answers.** At the deadline the model is told plainly *why*: nobody was present to action
  it. 🔴 **The card is untouched.** It is still pending, still clickable, and approving it still arms
  every future fire. The deadline answers the run's question ("may I do this right now?"), never the
  card's ("may this routine do this at all?").
- **Approved, but nothing was armed.** A click on a card posted before an `edit_routine` records
  nothing. The run says the permission was not written and points at the instruction to check — it
  does not claim to know why.
- **The card stopped being answerable.** Its row is expired or gone, so the run refuses and the next
  fire posts a fresh card rather than pointing at a dead one.
- **The card could not be read.** If the store is unreachable for the end of the window, the run gives
  up without knowing whether anyone answered, and says exactly that. It never reports this as "nobody
  was there" — the owner may well have clicked.

An approval whose standing permission has not landed yet is **not** treated as a failure. The click
writes the grant a few store round trips after it marks the card approved, so the run keeps polling
and takes the approval the moment the row appears. Only a card still approved-with-nothing-armed when
the budget runs out is reported as the fourth case above.

**Why the window is short.** The deployed function has a 300-second wall ceiling. The turn's own
elapsed time is read off its start stamp and subtracted, and the model still has to be told and the
run's report posted, so 60 s is reserved. The wait is clamped to what is left. A turn that reached
its refusal 250 s in therefore waits **not at all** and refuses immediately, rather than spending a
window it cannot afford and dying mid-report. **120 s** is the shipped value: it is what a turn that
reached its refusal at the assumed 120 s can still afford. A ten-minute card is not
possible here; answering after the run has ended is what the card itself is for.

The reading comes from the **turn's own start stamp**, taken when the turn starts and kept for as
long as that turn runs. It is deliberately conservative in both unusual directions. Outside a turn —
a schedule, an eval, a CLI — there is no stamp to read at all, and the bound falls back to assuming
120 s spent. And where a turn outlives the invocation that stamped it, the elapsed time reads long
rather than short, so the wait shortens or disarms and the run refuses immediately. Both directions
cost a run its window, never its report.

Four cases raise **no card at all**, and each refuses exactly as it did before:

- a fire that has read **untrusted external content** — no declared permission lifts a poisoned turn, so
  asking for one would be a card that promises nothing;
- a **silent** routine (`report: {kind:"silent"}`) — it posts nothing into its room by declaration,
  and a card is a post. Declare the permission with `edit_routine` instead;
- a routine on a surface with **no approval-card path** — a room that cannot render Approve/Reject
  gets no card rather than an undeliverable one;
- a refused action that is **not declarable** — deletes, and everything outside the two-row
  vocabulary. Those were never grantable up front and are not grantable here either.

### Finding the ask afterwards

A card is a post, and a post is buried by traffic. A card a 03:00 fire raised can be 400 messages up
the thread by the time anyone reads the room: it is still live and still clickable, and nobody can
find it. So the ask is also readable from the rows. `list_routines` reports **`permissionAsks`** for
each routine — what it asked for while running unattended and did not get — beside `permissions`,
which is what it already holds. That answers "what asked for approval while I was away?" however long
after the fire, and it is per routine, so a room's whole set of routines reads in one answer.

Each entry names the permission, the room its card went to, when it was asked, and one of five
states:

- **waiting** — the card is pending in that room. Approving it arms every future run.
- **superseded** — the card was posted under an earlier instruction and is still in the room.
  Answering it now records nothing; the next run that needs the permission posts a fresh card.
- **lapsed** — the card was answered and nothing stuck: no permission was written, no decline was
  remembered. The next run that needs the permission posts a fresh card, because a fire reads the
  card's own row before believing the ask marker that outlives it.
- **declined** — a person refused it. The routine stops asking until its instruction is edited.
- **unreadable** — the routine asked, and the card store could not be read, so what became of the
  card is unknown. It is reported apart from **lapsed** because that state asserts an absence: a
  read that failed saw nothing, the card is probably still in the room, and an `edit_routine` on
  that advice would bump the generation and kill it.

An entry reports what the ROWS say. Where the permission store could not be read for a routine,
`list_routines` sets **`permissionsUnreadable`** on it: its empty permission set then means *unknown*
rather than *none*, which is the same split **unreadable** makes on the card leg and for the same
reason — an empty set is an assertion, and a read that failed earned none.

### What one run could not do

The record above answers "what is outstanding", any time later, for every routine in the room. It
does not answer "what did **this** run lose". A permission is refused inside a tool body mid-turn,
the model is told, and the model is not obliged to pass it on — so a run whose whole point was
blocked can still report a tidy success.

So the host says it. A run's report carries a block naming the permissions that run asked for and did
not get, each with a pointer to its still-open card where there is one. The block is host-authored
and host-derived: the permission comes from the grant kind the card plane allowed, the pointer from
the card's own row.

**Both refusal sites feed one block.** A run refused `pr.open` by the approvals plane and a connector
op by the connector gate lists two lines under one heading, in the same plain language, with the same
pointers. There is no second shape for a second gate.

Two limits, stated rather than implied. It covers the permissions the **card plane had a question
about** — so a tainted fire, a silent routine, a routine whose room does not resolve, and a surface
with no approval-card path are all refused as they always were and appear in no block, because none
of them raises a card. And it rides the **first message the run posts after the refusal**, which is
that run's report in the ordinary case and can be a progress update in a run that posts twice. A
permission the run was granted mid-run — a human answered its card while the run was still going —
is not listed at all: the run got it and used it.

🔴 **The record decides nothing.** It reads the rows the card path already writes, and every entry
points at a door that is already open — the card in the room, or an `edit_routine` that declares the
permission. There is no way to arm a routine from this view, because there is exactly one way to arm
one: a human's click on a code-rendered card.

## How firing works

Routines are created at runtime, but Eve's scheduling primitive is static (a build-time
file with a fixed cron). Open Everywhere bridges that with **one** schedule that acts as a
**dispatcher**:

```
dispatch   cron "*/10 * * * *" (every 10 minutes)
  └─ read the durable routine store
  └─ filter: active ∧ clock-scheduled ∧ due
  └─ for each due routine:
       decline it as `skipped` if its scope is over its spend cap
       advance its schedule (recompute the next run instant)
       to(channel, target).send(prompt, { auth: appAuth })
```

An `only-on-change` fire differs from an `every-run` one in what the turn receives: its
prompt is wrapped with the **observation protocol** (observe, record the observation, stay
silent when nothing changed — see the lifecycle section below). A `never` fire is wrapped
with the **silent block** instead ("do the work, then end your turn with exactly
`NO_REPLY`"). `every-run` fires get the prompt with just a temporal preamble (the routine's
creation time and its previous run time, so "since my last run" tasks have a baseline).

#### What a fire is told about its own reach

Every fire — scheduled, only-on-change, durable job and event alike — also carries a **reach
block**. It exists because a fire that mis-reads its own reach reports a refusal nothing issued, and
nobody is there to ask "did you look?".

For an ordinary fire the block says: *a tool you cannot see is not a tool you do not have.* A
connector operation is not a static tool. The agent mounts two fixed connector tools:
`connection_search` lists a connection's operations, and `connection_execute` runs one by its
`connection` and `tool` names. So no operation appears by name in the session's opening tool list.
The block therefore tells the fire to search for the operation, then call it, and to do both
**before** reporting that a connector is unavailable.

**A DECLARED operation needs no search.** Where the routine's
[declared permission](#what-a-routine-may-do-on-its-own) names one — `tool:notion__notion-create-pages`
— the fire resolves that operation when each turn starts. The resolution reads the connection's
catalogue and confirms that exactly one connection advertises the operation. The turn's instructions
then carry a second reach block. It names the operation as the `connection` and `tool` that
`connection_execute` takes (connection `notion`, tool `notion-create-pages`), and it tells the fire to
call `connection_execute` directly, with no `connection_search` first. The reason is measured: in
a live run a fire searched, was handed the operation it had declared, and then reported that it had
not made the call. Every extra hop is a place a model stops.

This is not a widening. The declaration **is** the permission: a human read it on the arming card
and clicked it, on the creation card or on a later permission card. The block names only declared operations, and only while their permission rows are
live, so a revoked permission drops out of the next turn's block. Every gate a call meets — the
connector hard gate, the unattended connector fence, the effective tier, the egress firewall —
decides exactly as it did before. The framework re-keys a `connection_execute` call to its
`<connection>__<op>` name. On an unattended fire, the unattended fence refuses a write or
destructive operation that the routine did not declare. A read-tier operation stays open, as it
is on every turn: the block does not confine a fire to its declared reads. The block carries names
only: no description or schema that a connector wrote is copied
into it.

A declaration that no connection advertises, one that two connections can both compose, or one whose
catalogue does not answer within three seconds resolves to nothing. That fire searches, as an
ordinary fire does. A fire with a surface is forwarded into the conversation's work session, and
the work session only relays the job to a child. So there the CHILD that runs the routine resolves
the declared operations and carries the block, because it is the turn that calls
`connection_execute`. The work session itself resolves nothing. Any other delegated worker and a
durable job's fire resolve nothing either. The
`routine.declared_ops_resolved` audit row names, per fire, which declared operations resolved and
which resolved to nothing. It replaces `routine.declared_ops_mounted`, which claimed a mounted tool
that the current framework (eve 0.69 and later) never mounts.

**A durable job's fire is told the opposite, and that is deliberate.** A job fires on a
[restricted wake](#durable-jobs-persistent-multi-step-work): it holds no `connection_search` and no
connector operation above a read, because the job runs for weeks with nobody attending it. There,
absence *is* the control. So the job arm of the block states the narrowing plainly, tells the fire
not to go looking, and points at `report_run_failed` — name the tool you needed and the fact that
this wake does not carry it.

The health block adds the half both arms share: a declared failure names what the run **tried** and
what the system **answered**. A bare "not authorized" is a guess unless a call returned it.

This is an instruction, not a gate. It changes what a fire attempts, never what a fire may do. Every
gate an attempt meets — the [connector hard-gate](./connectors-and-providers.md), the unattended
connector fence, the DM-only context wall, the egress firewall — decides exactly as it did before.
What the fire then reports is whatever came back, which can be a refusal, an error, or an approval
that nobody is present to give. Getting that on the record is the point: a refusal the connector
plane issued is a fact a human can act on, and a refusal the model inferred is not.

Each routine stores the **next instant it's due**, and the dispatcher fires when that
instant has passed, then recomputes it **from the instant it was due, not the instant it
ran**. This is **tick-cadence-independent**: a routine can't be missed or double-fired just
because the dispatcher ticks every ten minutes rather than every one — a slower tick only
costs lateness, never correctness, and the lateness never compounds into the period (an
`every 15 minutes` routine keeps a 15-minute period, it doesn't drift out to 20). If the
dispatcher is down long enough to miss several occurrences, the routine resumes on its own
grid at the next future slot — a missed window is never replayed as a burst. The one thing
the tick genuinely bounds is the **finest achievable cadence**: a routine is dispatched at
most once per tick, so asking for `every 5 minutes` gets you roughly every ten (and the cost
projections in [Spend & cost controls](../security/spend-and-cost.md) say ten, not five). The 10-minute
cadence is deliberate: on a scale-to-zero Postgres (Neon), a store read every minute
defeats autosuspend and the database compute stays awake 24/7; ticking less often than the
suspend timeout is what lets it sleep. Tighten the cron only if you need finer routine
resolution *and* accept an always-on database. Event-triggered routines fire from a
separate path — an inbound webhook
verifies the event, matches it against active `event` routines, and fires each into its
surface.

### Surface coverage

Routines fire into **Slack, Discord, and Microsoft Teams**. A routine created
in-thread on any of those surfaces captures its post-back target from the live surface
binding at creation, so proactive posts land in the exact channel / chat / Topic /
conversation the routine belongs to:

| Surface | Post-back mechanics | Target captured at creation |
| --- | --- | --- |
| **Slack** | fresh channel message | `{ channelId }` |
| **Discord** | channel message via the REST create-message endpoint (bot token; no Gateway websocket involved) | `{ channelId }` (+ guild/type facts for attribution) |
| **Teams** | proactive Bot Framework activity to the stored **conversation reference** | `{ serviceUrl, conversationId, … }` — see below |

**Teams needs a conversation reference.** Bot Framework does not allow cold-sending to a
Teams user or channel the bot has never heard from: proactive messages require a
*conversation reference* (`serviceUrl` + conversation id) captured on a prior **inbound**
turn. Open Everywhere captures that reference off every inbound Teams activity and stores
it on the routine at creation — so any Teams routine created in-thread just works. A Teams
routine *without* one (both fields are required) fails closed to dry-run rather than
guessing.

Every fire, on every surface, re-derives the routine's real partition (the same
workspace/surface identity an inbound message binds), so spend attribution, memory
scoping, and bundle/skill grants land on the right surface — and the `only-on-change`
silence sentinel is swallowed on all three surfaces, so a quiet watch check posts nothing
anywhere.

#### Where you can *create* one, and where it reports

Firing and creating are different questions, and they used to have different answers for
the wrong reason. Arming a routine needs a human to click an **approval card**, and only
Slack and Discord can host one — so asking for a cron in a Teams channel was refused
outright, even though Teams fires perfectly well.

It isn't refused any more. If the room you ask in can't host a card, the card is **posted
into a card-capable channel in the same domain**, and the agent tells you where it went
("I've put the card in #ops for someone to arm"). The domain is the boundary: a card never
leaves it, because a domain is already the set of rooms sharing one memory silo
and one audience.

A redirect destination is checked the same way the asking room would be: a channel the
platform positively reports as **externally shared** is skipped and the next one in the
domain's exact `reach` entries is tried, because a card spells out exactly what would execute and
you never got to see which room the config picked. If every card-capable channel in the
domain is shared outside your org, the request is refused naming that domain — adding
another card channel is not the fix there, and the refusal says so.

This venue is no longer routines-only. Every card-posting verb routes the same way — the memory,
access, connector, spend, skill, webhook, ticket and agent verbs included — so those verbs all work
from a card-less room too. See
[The control plane: asking from a surface that can't host a card](../security/control-plane.md#in-slack-approvals).

That leaves surfaces that can't post proactively at all — a GitHub issue, a Linear issue, a
Notion page. A routine there would come due forever and never report, so **it is refused at
creation** rather than armed and silently dead, unless its domain names somewhere for it to
report:

```ts
defineDomain({
  name: "eng",
  reach: ["linear/W_ACME/ISSUE-1", "slack/T_ACME/C_OPS"],
  reportChannel: "slack/T_ACME/C_OPS", // must be one of this domain's OWN channels
})
```

With that set, "every weekday at 9am, summarise this" asked on a Linear issue is armed
against the issue — it belongs to that domain, spends that budget, reads that memory — and
**posts into `#ops`**. The card and `list_routines` both say so.

The destination is **config, never the model's choice**. There is deliberately no way to
ask the agent to post somewhere else: that would be a cross-surface posting primitive
aimed by whoever is talking to it, and the agent may not post into a channel other than the
one it is answering. A human choosing one destination, in code, behind a pull request, is a
different act.

#### Two refusals

- **Externally-shared / guest-bearing channels are refused.** A routine fires unattended with
  standing authority, and the approval gate has no roster check on who clicks — so in a
  channel with guests in it, a guest could arm one. Same refusal `create_skill` already makes.
- **Group chats (`mpim`) are refused.** They're execution-only: the agent does work in one, but
  nothing durable is authored there. Ask in a channel or a DM.

**A 1:1 DM can carry every routine shape** — a one-shot reminder, a recurring schedule, an event
subscription, a durable job. A personal daily brief in your own DM is a first-class thing to set
up. This is not a gap in the guest-bearing refusal above: that one is about a *shared* room, and
a DM has no roster for a guest to be in. What bounds an unattended DM routine is mechanism rather
than a refusal — a DM turn is subject to [spend caps](../security/spend-and-cost.md) like any
other, every fire — scheduled *or* event-triggered — is budget-gated at dispatch and attributed
to the person who created it (a declined fire is an audited `over_budget` skip, and the creator's
own `perUser` / `perDomain["dm"]` budget is what the gate compares), and a durable job retires
itself at its own ceiling.

**The standing declared set isn't rendered anywhere yet.** Each *fire* is audited (`routine.fire` /
`routine.skip`), but there is no admin-facing view that answers "what is armed, in whose DM, and
what may it do". That's a missing read, and it's the shape of a scan over what's armed rather
than another gate at creation time.

`subscribe_pr` ("let me know when PR #123 changes") applies the same post-back check before
it arms anything, and is deliberately **never** redirected — its whole safety argument is
that it posts only into the channel that asked. It also **mounts** on the channel's repo
grant, so a channel that is granted no repo never sees it. Each fire of the chain resolves
the same grant from the routine's own surface, so an armed subscription keeps its tools.

The scheduler itself is a swappable seam — the cron source that drives the dispatcher.
See [Scheduler & control-plane identity](../extending/scheduler-and-identity.md).

## Durable jobs: persistent, multi-step work

An ordinary routine fires **stateless**: each fire is a fresh session with no memory of the last one
(a design that suits a daily summary — the post *is* the product, and there's nothing to carry
forward). But some proactive work isn't one request repeated — it's **one job that unfolds over
many fires**: *"chase this PR until it merges", "drive this migration to done", "keep at this until
it's actually resolved"*. That needs the fires to **accumulate context**, not start cold each time.

A **durable job** (create a routine with `job: true`) gives the routine its own **persistent
session** across fires. The fires all land in **one thread**, and — crucially — successive fires
**resume the same session**, so the agent builds on what it did last time instead of re-deriving it.
The job keeps firing on its schedule until its own session decides the *whole job* is done and calls
`complete_job` — not until any single request is answered — or until it hits its **ceiling**, below.

**Job or routine? The test is whether `complete_job` would ever mean anything.** A **job** is work
with a terminal condition. A **routine** is work that recurs forever. So the question is not "is this
multi-step?" or "is this open-ended?" — it is whether there is a condition that *ends* the work and
that the job itself could recognise when it arrives:

- *"Watch this PR until it's merged and deployed"* — that condition arrives, and the job can see it
  arrive. It completes. **Job.**
- *"Check the payments dashboard every morning"* — there is no morning on which this is finished.
  It never completes. **Routine** — leave `job` off.

Nobody types `job: true`. A person says *"keep checking until X"* or *"just check it daily"*, and the
choice is made when that request is read — so it is worth stating the test plainly on both sides: the
tool description carries it, and the arming card says in plain words that a job *keeps going until it
decides the work is done* where an ordinary routine *starts fresh each time and repeats forever*.

**Getting it wrong doesn't fail loudly — it degrades.** A forever-task armed as a job runs into both
of the job machinery's assumptions, and neither surfaces as an error:

- **Its ceiling trips.** A daily digest armed as a job stops itself after a week and posts a retirement
  notice (below), where a plain routine would simply have carried on — a ceiling is right for work
  that was supposed to finish and wrong for work that was supposed to recur.
- **Its ledger stops being trusted.** The first time any fire records progress on a turn that read
  external content, the job is marked tainted *permanently* — the flag is monotonic and never cleared,
  because every later ledger builds on the one before it. From then on every fire is handed its own
  notes re-framed as an untrusted **report to read** rather than trusted notes to act on. Context
  growth is already handled (the session rotates and restarts from the ledger); this is not, so a job
  that was always going to run forever gets quietly and permanently worse at trusting its own memory,
  with nothing reporting a fault.

The reverse mistake is milder but real: terminal work armed as a plain routine has no `complete_job`
to call (that's a clear error on a non-job routine), so it keeps firing after the work is done until
somebody notices and cancels it.

**Every job has a ceiling, and it is not a cost threshold.** A job that never calls `complete_job`
would otherwise run forever, and nothing else would stop it: the 3-strike self-disable counts
*failures*, and a monitor that polls, finds nothing, replies and repeats is a *correct* run every
single time. So a job is armed with a bound in **runs and wall-clock, whichever trips first** —
because neither alone is honest: a run count is meaningless for a daily cadence (200 runs is 200
days) and a deadline is meaningless for a fast one (the ~10-minute tick
floor is ~1,000 runs a week). The defaults are **200 runs or 7 days** (`routines.jobMaxFires`,
`routines.jobMaxDays`), which cross over at an hourly cadence; a cadence slower than about every other
day stretches the deadline so the job still gets at least three runs. The ceiling is stated on the
arming card, and `list_routines` shows how far through it each job is. The ceiling stays as a hard backstop beside the
[check-in](#when-nobody-checks-in-keep-going-or-it-pauses): a Keep going press does not extend it. A third condition — **being
blocked**, below — stops a job before either of those.

When a job hits its ceiling it **stops and posts a notice** — deliberately a notice and not an
approval card. A ceiling trips at whatever hour the cadence lands on, with nobody present; a card
posted to an empty room at 03:00 gates nothing, it just sits, and the job sits with it. The notice
leads with *nothing failed* (the job may have been working perfectly and simply never finished) and
says how to start it again, which is one `enable_routine` away — and re-arming gives it a **fresh
full ceiling**, not the remainder of the old one. No token or dollar threshold could substitute for
this ceiling: the [session cost checkpoint](../security/spend-and-cost.md) pauses only
*consequential* actions and never reads or replies, which is a polling monitor's entire surface area,
so a cheap poll never crosses it at any threshold.

**…but a job that gets BLOCKED stops sooner, and says so differently.** A configured
[session cost checkpoint](../security/spend-and-cost.md) pauses a session's consequential actions
until a member confirms. On a job fire there is nobody in the room to confirm, and a durable job's
fires share one session — so its cost only ever accumulates, and once it crosses the threshold every
later fire is paused again. Left alone that job is in a third state nothing counted: it isn't
*failing* (a paused tool is a recoverable error the run works around, so it still finishes cleanly),
it can't reach `complete_job`, and it was burning its ceiling waking up unable to act. So a job that
is blocked on **three fires in a row** stops itself, and its notice says it was *blocked* rather than
*finished* — because the recovery is different: answer the checkpoint card (or raise the checkpoint
for that scope) **first**, then re-arm, or it will stall again. The re-arm card repeats that warning.
Before it gets that far, each blocked fire is visible: `list_routines` reports
`blocked on a cost checkpoint: 2/3 runs`, and every blocked fire writes a `routine.stalled` audit row
naming the tool it was refused.

**How the join works (the session is pinned, the token grammar is untouched).** Eve keys a routine
send by its continuation token; a fire with no thread gets a fresh random token, which is exactly
why ordinary fires are stateless. A durable job instead **pins a stable thread anchor**: on the
first fire the dispatcher posts a kickoff message to open the job's thread and stores its
timestamp; every later fire reuses that anchor, so the continuation token
(`slackContinuationToken(channel, anchor)`) is **identical across fires** and Eve resumes the *same*
durable session. This introduces **no new token shape** — a job session is a plain surface-native
token with a stable anchor, the same principle the per-user DM seat uses to give a long-lived DM one
durable session.

**Off Slack the anchor is a post (OPE-2568).** On Teams and Discord the first fire posts the kickoff
through the bundle's anchor arm, the same arm a [test run](#test-it-before-it-runs) anchors on, and
stores the id the platform returned. Every fire then goes to that post. On **Teams** the session keys on
`(tenant, conversation, reply id)`, and the job's answers reply to the kickoff post. In a channel the kickoff is a new post in the channel,
so the job has a reply chain of its own. On **Discord** the session keys on `(channel, kickoff message
id)`, and the answers go to the routine's channel: Discord has no thread for this. A Teams or
Discord job fire that has its anchor never takes the window, as a test run never does: it goes native,
where the anchor keys its session. The window's guard would also refuse it, because the fire's binding
names the routine's own conversation and the anchored post sits in a different one. A fire whose
kickoff post failed has no anchor: it is an ordinary fresh fire and takes the routine's usual delivery.

**A working-state ledger (belt-and-braces continuity).** The job's fired session records its
progress with `record_job_state` — a short note (goal, what's done, what's next; capped at 16 KB).
The dispatcher renders that ledger into every fire's preamble as a *"where you were"* block — as
**trusted** notes while the job is clean, and as an untrusted **report** once it is tainted (above).
This is what makes continuity **survive session death**: if the durable session is ever replaced
(rotation past the model's context ceiling, expiry), the next fire re-attaches to the same anchor
and — even if the transcript is gone — **restarts with the ledger note rather than cold**. A failed
run never persists the ledger, so a crashed turn can't corrupt it.

**Completion is a first-class state.** A routine is `active`, `disabled`, or — for a job that
finished — the terminal **`done`**. The job's own session calls `complete_job` when the whole
objective is met; the routine flips to `done`, its next run is nulled (it never fires again), and the
completion is audited (`routine.complete`). `complete_job` is **idempotent** (completing an
already-done job is a no-op success), and calling it on an ordinary routine is a clear error — use
`cancel_routine` to stop a non-job routine.

**Governance is unchanged — a job is *more* autonomous, so it rides the same gate.** A durable job is
created through the identical member-tier **approval card** as any routine (the card says it's a job,
that it keeps a persistent session until it completes, and what its ceiling is — the same read covers
how it starts and how it ends), it's surface-owned, and it respects every
existing guard: the per-fire spend cap, the live fail-closed trust recheck, and the 3-strike
self-disable (which counts rejected deliveries too). It simply adds the completion terminal on
top.

**A job cannot poll an arbitrary URL, and that is a decision.** A job fire reads what it is entitled
to read — a pull request, a ticket, a page through a connector, its own thread. It holds no general
web fetch. Two things withhold it, and they are independent: a fire runs on a seat that never carries
the sandbox and egress tools at all, and the [restricted kit](#durable-jobs-persistent-multi-step-work)
a fire is narrowed to does not name one either. So *"watch this PR until it merges"* is a job, and
*"poll this status page every hour"* is not.

The supported shape for the second one is an [inbound webhook trigger](#inbound-webhook-triggers).
The difference is who chooses the destination. A poller lets an unattended session — one that keeps
its transcript for weeks — pick a URL and pull whatever answers, which is both an ingestion surface
and an outward signal. A webhook inverts that: the sender pushes to an address you armed, and the
agent chooses nothing. If a source you need has no webhook, say so on the issue tracker rather than
working around it — the capability would need its own narrow tool, with the reachable hosts declared
on the routine when you arm it and shown on the arming card.

**Scope.** Durable jobs work on **Slack, Teams and Discord**: the platforms that can host-post an
anchor (on Teams and Discord, through the same arm a test run uses). They require a **scheduled
trigger** (not an `event` subscription, which fires through a different path). A job on any other
surface, Linear included, is refused at creation. (A job whose anchor post fails degrades cleanly: it
still fires and still carries the ledger note — it just doesn't resume one session.)

## Silent routines (`postPolicy: never`)

Not all proactive work has an answer to give. A routine that updates a ticket, reconciles a
board, or writes something to memory has already delivered its product by the time the turn
ends — a message saying so is pure noise, and on a busy channel it is the reason the whole
feature gets muted. `postPolicy: "never"` is that shape: the routine keeps an ordinary
`cron`/`interval` schedule and stores `report: {kind: "silent"}`.

**Silence is the default; failure is loud.** The fired turn is told plainly that it reports
nothing, that it should end with the silence sentinel, and that the one exception is a problem
it cannot resolve — which it raises with the `reply` tool, and which *does* post. Everything
else it might write as a final answer is dropped before it reaches anyone.

That last part is **structural, not prompt-reliant**. The fire carries a host-set attribute the
model cannot write; the host reads it at the start of the turn and drops the terminal completion
at delivery, on every surface — including Linear, and GitHub's fallback path, which hand a
non-supervisor turn straight to the framework's default reply-poster, where an obedient model
would have posted the literal string `NO_REPLY`. The escape hatch is a **positive act**: a
mid-turn `reply` posts as it always did, because the gate only ever touches the *final*
completion.

`never` and `only-on-change` are mutually exclusive and the combination is refused — a silent
watch is just a silent cron, and the diff it would compute has no consumer.

**How you know it's alive.** A silent routine can't be monitored by watching the channel, so
three things carry the visibility instead:

1. `list_routines` says so in plain words — `cron "0 9 * * 1-5" (UTC; posts nothing)`.
2. A fire that ENDS writes a `routine.fire` audit row carrying the routine id, the session
   id, the outcome and `silent: true` — so "did the nightly job run this week?" is answerable,
   and the session transcript is reachable from the routine id. ⚠️ See
   [When the outcome fold runs](#when-the-outcome-fold-runs) for exactly when it is written.
   The dispatcher's own `routine.fire_attrs_sent` row records every fire regardless, so "did it
   fire?" is answerable even if the fold never ran.
3. A self-disable **announces itself** in the routine's own surface (see the lifecycle section).

**Partly solved: silent drift** — a routine running "successfully" for weeks while doing nothing
useful. The half that *is* solved is the half the fire can see: a run whose work did not happen
says so with `report_run_failed`, and three of those disable the routine (see the lifecycle
section, and [When the outcome fold runs](#when-the-outcome-fold-runs) for when a declaration
counts). What remains is the run that genuinely believes it succeeded, or that
doesn't say otherwise. Detecting *that* automatically would need a runtime classifier judging whether work was
worthwhile, which the [security model](../security/security-model.md) rejects on principle
(authorization is by code, never by a model judging intent).
Visibility (leg 2, plus `query_analytics`) is the answer instead: the fires are on the record,
and a human reads them.

## It acts as the agent, attributes to the human

A fired routine runs **unattended, attributed to its creator** — audit rows, the spend
ledger and any approval card's "asked by" line name the routine's stored creator (or the
service identity, for a row with no creator), but the fire has **no acting principal**:
its auth carries an unattended-origin marker, so every verb that requires a person present
and acting (authoring or mutating routines and domain skills, moving spend caps, cutting
or restoring connectors, declaring or rotating webhooks, opening access-request PRs)
refuses it. It runs in the surface the
routine owns and carries the same access bundle that surface resolves — so proactive work
is scoped exactly like reactive work, and the trust gates apply identically: each fire
re-verifies the channel is internal (the same live, fail-closed check a name-drop wake
uses), so runtime domain skills and shared memory arm only for a confirmed-internal
channel — a channel that later becomes externally shared loses them on the next fire,
and a fire that can't verify (Slack API error, missing bot token) runs without them
rather than guessing. Positive verification exists only on Slack today;
Discord / Teams fires stamp no trust verdict and fail closed to external — exactly what a
live inbound turn on those surfaces gets, so a fire is never *more* trusted than a
message. A routine on a surface with no wired post-back, or whose stored target is
missing/incomplete (e.g. a Teams routine without its conversation reference), runs
**dry-run** (logged, schedule not advanced) so the
first real fire isn't skipped once that target exists. See
[Identity](../how-it-works/identity.md) and
[Access & scoping](../how-it-works/access-and-scoping.md).

## Workflows: a routine that runs a skill

There's no separate "workflow" primitive. A workflow **is** a
[skill](./skills-and-plugins.md) — a markdown procedure that names the skills and tools it
composes, fanning out to sub-personas via the `agent` tool where the plan needs one — **cron'd**
with `create_routine`. Because a fired routine resolves the SAME surface, memory domain, and
granted/domain/repo skills a normal turn does (see "It acts as the agent, attributes to the
human" above), its prompt can just say:

> "Run the `deploy-runbook` skill, then post a one-line summary of what shipped."

`create_routine`'s own tool description reminds the model of this, so it doesn't need
teaching per-deployment. The whole "workflow" — the procedure, the schedule, and its cost —
lives in exactly three places, each already documented on its own page: the skill's markdown
is the *how* ([Runtime domain skills](./skills-and-plugins.md#runtime-domain-skills), if it's
authored in-thread, or a repo/plugin skill if it's built-time), the routine's trigger is the
*when* (above), and `spend_report`'s per-routine prediction is the *how much* — see
[Per-routine cost prediction](../security/spend-and-cost.md#per-routine-cost-prediction).

## Pre-run data collection

A fire used to start with the routine's prompt and nothing else. A fire has no `bash` and no
wide read kit, so a 03:00 routine that needed to know what changed had two options: guess, or
ask a human who is asleep. **Pre-run collection** is the third option. The host runs the
routine's declared reads *before* the session starts, and hands the output to the run as data.

A **collector** is one declared read. The deployment declares it in
`agent/routines/collectors.ts`, in Git:

```ts
{
  name: "notion.open-incidents",
  tool: "notion__search",                        // named exactly as the tool is called
  args: { query: "status:open label:incident" }, // a frozen literal
  describe: "the open incidents in the incident database",
}
```

A routine names collectors from that menu, and nothing more. It cannot invent one, and it
cannot change the tool or the arguments — those change by pull request, under review. A name
the deployment does not declare is refused at `create_routine`, with the menu named.

Five rules hold, and each one is checked rather than promised:

- **A collector runs under the routine's declared permission and nothing wider.** The
  permission it needs is the ordinary per-tool declaration `tool:<the tool>`, so a collector
  reaches exactly what a human declared on the arming card or approved on a permission card.
  The check runs twice: at creation, against the permissions the same proposal declares, so
  the card cannot promise a read the routine was never given; and on every fire, against the
  **live** rows, so a revoked permission stops its collector on the very next run.
- **A collector may only READ.** The tool must classify as `read`
  (`access/consequence.ts`). That classifier fails closed, so an unrecognised verb is
  refused too. A write-tier tool never registers as a collector on any deployment.
- **Every read has a deadline.** `timeoutMs` on the collector entry, defaulting to ten seconds. The
  boot **refuses** a collector that declares more than sixty seconds; it does not clamp it. A
  collector runs *inline* on the dispatcher tick and inside the event fan-out's
  match loop, so a host reader whose socket never closes would stall that tick for every tenant —
  a count cap bounds fan-out, not duration. The read is raced against the deadline and the reader is
  handed an `AbortSignal` that fires with it: waiting stops either way, but only the reader can drop
  the socket. A read that loses the race is a named `timeout` failure.
- **A failure is named, never a silent empty.** A read that is refused, that is unknown, or
  that throws produces a failure. So does a collection step that breaks *around* the reads,
  and then every collector the routine declared carries the failure — an empty list would be
  indistinguishable from a routine that declares no collectors at all. A routine that declares
  no gate still FIRES, and the failure is written into that fire's own message. A routine that
  declares a **gate** fails it closed when the collection breaks as a whole, whatever its
  predicate says, so that one does not fire — and its `routine.collect_failed` audit row is
  then the only record. Either way the row is written. "The world is quiet" and "the read
  broke" must never be the same sentence — that is how a routine reports "no new incidents"
  off a read that returned a 500.
- **The output is untrusted.** Collected bytes sit inside an untrusted fence, below the
  routine's own prompt, and the fire is stamped tainted. The failure lines sit *outside*
  the fence: they are ours, and the run must be able to read them as fact. A failure line
  therefore names the collector and a **closed-set reason**, and never any upstream text —
  what a failing read threw goes to the audit row, capped, and reaches no model. An error
  body is an outside party's bytes, and this region has neither a fence nor a taint stamp
  behind it.

**The reader is a seam, and core ships none.** The dispatcher tick is not a session, so it
holds no mounted connector tools. A deployment wires the read itself, through
`registerRoutineCollectorReader`. Until it does, every collector reports the named failure
"this deployment has no collector reader wired", on every fire, and the fire still happens.

## Condition gates

A **condition gate** is a declared predicate over the collected data. It decides whether the
run happens at all. A `no` costs one audit row: no session, no delivery, **no model spend**.

It is not free of *every* cost, and the doc says which: the collectors run **before** the gate, so a
gated tick can still cost the outbound vendor calls they make, and a tick whose collector also failed
writes its own `routine.collect_failed` row beside the skip row. What a gate saves is the session —
the tokens, the slot, and the post.

The gate is the `record_watch_state` seam moved ahead of the session. That tool already
computes its verdict host-side, so the model cannot fake a diff from memory — but it runs
*after* the session has started and spent its tokens. A gate runs first.

The predicate lives in `agent/routines/collectors.ts` beside the collectors, in Git. A
routine carries only its name. The motivating case is "merged is not live": do not tell a
customer their bug is fixed until the fix is actually serving.

```ts
{
  name: "release.is-serving",
  describe: "the release containing the merged commit is actually serving, not merely merged",
  decide: (collected) => {
    if (!collectionComplete(collected)) return { fire: false, why: "the deploy read failed — cannot tell merged from live" };
    const body = collectedBody(collected, "deploy.current-release") ?? "";
    return body.includes('"state":"READY"')
      ? { fire: true, why: "the release is serving" }
      : { fire: false, why: "merged, but the release is not serving yet" };
  },
}
```

**A gate fails closed.** An unknown name, a predicate that throws, and a verdict of the wrong
shape all skip the run. A gate that fell open on its own breakage would say "fixed" at
exactly the moment the deployment's state could not be read. The skip is loud: one
`routine.skip` row, reason `condition_gate`, carrying the gate's name and the line the
predicate gave. A permanently broken gate reports itself hourly rather than stopping a
routine in silence.

**A predicate must not read a failed collector's absence as an observation.** `collectedBody`
answers `undefined` both for a read that returned nothing and for one that never ran. Ask
`collectionComplete` first, as the example does.

A skipped run records `skipped`, never `failed`. A gate used correctly can therefore never
three-strike-disable the routine that uses it. For a recurring routine the schedule still
advances, so it re-checks its condition on its own cadence rather than on every tick.

**A one-shot is the exception, and it is the case that matters most.** "Tell the customer their
bug is fixed" is a `once` routine, and `once` has no next run to advance to — every *other*
pre-fire skip retires such a row. A gate skip does not: the routine stays active and stays due,
so the gate is asked again on the next tick and the one-shot fires the moment its condition
holds. "Not yet" is the answer a gate exists to give.

**That wait is bounded at 24 hours, counted from the one-shot's own scheduled instant.** Staying
due means being re-collected on every tick, and a collector is a real outbound read — so a
one-shot whose condition never holds (the release was cancelled, the ticket was closed another
way) would read the world every ten minutes for as long as the deployment lives. Past the window
the dispatcher retires the one-shot, with a `routine.disabled` row naming the gate and the
condition it never met. That row is unthrottled, unlike the hourly `routine.skip` rows the wait
itself writes.

The clock runs from the scheduled instant rather than from the first refusal, because nothing on
the routine row records a first refusal. **So a dispatcher outage longer than the window costs a
one-shot scheduled inside it**: the gate is asked once when the deployment comes back, a "not yet"
retires the routine there, and the row says the condition never held within 24 hours — true of
the window, not of the routine's chances. After a long outage, read the gap before the row. A
condition that genuinely needs longer than a day belongs on a recurring routine with the same
gate: that shape advances on its own cadence and reaches no ceiling.

**A gate needs at least one collector.** It decides from the pre-run collection, and an empty
collection satisfies "did every read work?" vacuously — a gate with nothing to read would treat
absence as an observation and the routine would never fire again. `create_routine` refuses the
pair.

Both mechanisms run on both ingresses — the clock dispatcher and the event fan-out — through
one shared step (`routines/pre-fire.ts`). A gate that covered one trigger kind and not the
other would read as a gate while a whole class of fires ran regardless.

## The chief-of-staff watch

Every routine above starts because a person armed it. The **chief-of-staff watch** is the one
exception. It is a standing watch per person, **on by default**, that reads the person's own
calendar and messages them in their own DM when it finds something that needs them: "your 15:00
overlaps the launch review, do you want me to move one?". Nobody asks for the message.

The watch runs on the routine machinery above. Its reads are [collectors](#pre-run-data-collection),
and its detector plays the part of a [condition gate](#condition-gates). So a quiet check costs the
reads and nothing else: no session, no model call, no post and no audit row.

### Turning it on for a deployment

Core declares no source, so the watch reads no calendar and sends no nudge until the deployment
declares one in `agent/routines/collectors.ts`. [Workflow discovery](#workflow-discovery-a-routine-for-work-you-repeat)
needs no source, so it runs on every deployment from the start:

```ts
export const ROUTINE_COLLECTORS: readonly RoutineCollectorDef[] = [
  {
    name: "calendar.next-3-days",
    tool: "gcal__list_events",
    args: { timeMin: "now", timeMax: "+3d", singleEvents: true },
    describe: "the person's own calendar for the next three days",
    personal: true,
  },
];

export const PERSONAL_WATCH: PersonalWatchDecl = {
  sources: [{ collector: "calendar.next-3-days", detect: "calendar-conflicts" }],
};
```

The boot refuses a source that names an undeclared collector, a collector that is not
`personal: true`, or an unknown detector. Core ships one
detector, `calendar-conflicts`. It reads the Google Calendar `events.list` shape, the Microsoft Graph
`calendarView` shape (UTC times only) and a neutral `{ events: [{ id, title, start, end }] }` list.

🔴 **The read runs as the person.** The reader receives `forPrincipal`, the person's qualified
principal key, and must read that person's calendar with that person's own sign-in, or throw. A
throw becomes a named failure and a silence row. Core holds the reader to it in two places: the
collector must be declared `personal: true`, and the reader must be registered with
`registerRoutineCollectorReader(reader, { personal: true })`. Otherwise every personal read fails as
`not_personal` before it runs, so a reader written for shared routine reads never answers for a
person with a shared credential.

### Who is watched

Every member of the organisation who talks to the agent in their own 1:1 DM gets a watch at the
default dial, with no click. With no source declared, the watch runs only workflow discovery. Opening the Home tab or running `/oe watch` also
enrols the member. A channel turn, a group DM, a routine fire and an outsider (trust `external`: an
email sender, a Slack Connect stranger, an unverified person) enrol nobody. `/oe watch` and the
Home tab refuse to turn an outsider's watch up, but `none` and `/oe watch` alone work for anybody:
a member whose lookup fails reads as `external`, and must keep the off switch.

In a direct message, Slack's `/oe watch` asks `users.info` who typed it, as a DM turn does. So a
guest or a Slack Connect stranger is refused even where the operator declared the whole workspace
`internal`. A member the lookup confirms needs no declaration. When the lookup gives no answer, the
command falls back to the declaration. In a channel, the command reads the room's
`conversations.info` verdict, as a message in that room does, and asks `users.info` who typed it.
So `/oe watch more` and `/oe watch less` work in an internal channel for a person the lookup confirms
a member. In a Slack Connect room, in a room Slack gives no verdict for, or for a person the lookup
does not confirm, they are refused, and the answer points to the DM. Each refusal writes nothing and files one `personal_watch.dial.refused` row with the reason.

### The dial: more, less, none

Each person sets their own dial with `/oe watch more`, `/oe watch less` or `/oe watch none`, or with
the three buttons under **Your watch** in the Home tab. `/oe watch` alone shows the setting. The
command keys on the acting person only, so nobody can turn another person's dial.

| Dial | What may interrupt | Most nudges a day | Smallest gap | How often it looks |
| --- | --- | --- | --- | --- |
| `more` | a conflict up to 72 hours ahead | 6 | 1 hour | every 30 minutes |
| `less` (**the default**) | a conflict within 24 hours | 2 | 4 hours | every 2 hours |
| `none` | nothing | 0 | — | never |

Everyone starts at `less`, not at the middle setting. A conflict that starts within 4 hours is
`urgent`, within 24 hours `soon`, and later inside the 72-hour window `later`.

**Quiet hours.** The watch never interrupts between 20:00 and 07:00 UTC. A finding held by the quiet
hours is not dropped: the first check after them considers it again. The window is a tracked
literal in `personal-watch/dial.ts`, because the store holds no time zone per person.

**The learned dose.** Each nudge the person received is listed under **Your watch** with a
**Useful** and a **Not useful** button. Not useful raises the person's dampening by one step; Useful
lowers it by one. Each step raises the urgency the dial lets through by one level. So on `less`, one
dismissal holds everything but `urgent` conflicts, and two hold everything until the person marks a
nudge useful or changes the dial. The dose never raises the rate above the dial.

**The calibration ask.** The first nudge a person ever gets ends with one question: do I message
you about the right amount? It names the three `/oe watch` settings and the Home-tab buttons. The
watch asks again after ten more nudges, or after 14 days with at least one nudge in between.

### What one check does

The `personal-watch` schedule ticks every 30 minutes. For each watched person whose check is due:

1. It claims the check: it moves the person's next check forward in a compare-and-set, so an
   overlapping tick skips the person.
2. It runs the declared reads as that person.
3. It runs each detector over its read.
4. It drops what the person was already told, and judges the rest, most urgent first, against the
   dial, the dose, the quiet hours, the day's count and the gap (`personal-watch/judge.ts`).
5. It delivers at most **one** nudge per check. Just before the send it judges the finding again
   against the person's CURRENT row, and in the same write marks it told and records the nudge in
   the log the gap rule and the daily limit read. So a person who chose `none` a moment ago is not
   messaged, and a write that fails after the send cannot cause a second nudge. A refused delivery
   takes the whole reservation back.
6. It writes the silences back.

The judgement is host code over the dial table and the person's row, so the decision to interrupt
is never a model's. The DM seat receives a finding the host already let through, and writes the
words: what overlaps, and an offer to move or decline one of the two events. The fire tells the seat
to change no calendar before the person answers; that is an instruction to the seat, not a control
the watch enforces.

**The delivery** takes the path a webhook takes to a person's DM ([Inbound webhook
triggers](#inbound-webhook-triggers)): the platform's registered DM resolver, the spend gate, then
the DM's window or a native send. A target that does not resolve to a 1:1 DM is refused, so a
calendar never reaches a room. The fire is unattended, names the person as its attested principal
(never an acting one, so it does not borrow their personal connectors), carries the DM standing
grain, and is **tainted**: an event title is text that anybody who sends an invite can write, so the
facts sit inside the untrusted fence. The spend gate applies the person's own DM allowance. A person who stopped proactive DMs
([DM seats and the DM audience](../how-it-works/agent-and-loop.md#dm-seats-and-the-dm-audience)) is not messaged.

### Every silence has an audit row

A finding the watch holds back writes one `personal_watch.silence` row with a closed reason:

| Reason | Meaning |
| --- | --- |
| `dial-none` | The person turned the watch to `none` while the check ran. |
| `below-dial` | The finding is less urgent than the dial lets through. |
| `dose-lowered` | The dial would let it through, but the person's dismissals hold it. |
| `quiet-hours` | It is between 20:00 and 07:00 UTC. The finding waits for the morning. |
| `daily-budget` | The person already got the most nudges their dial allows today. |
| `min-gap` | The last nudge was too recent, or another finding took this check's one nudge. |
| `read-failed` | A declared read failed, so the watch could not look. Never reported as a quiet calendar. |
| `unreadable` | A read answered in a shape the detector does not read. |
| `dm-stopped` | The person stopped proactive DMs from this deployment. |
| `delivery-refused` | The DM did not resolve, the spend gate refused, or the send failed. The finding is tried again, unless the write that takes the reservation back fails; the row then carries `release: "failed"`. |
| `proposal-gap` | A routine proposal waits: the last one was too recent for the dial (14 days on `less`, 7 on `more`). |

One finding and one reason make one row: the same finding held for the same reason on the next
check writes nothing new, and a change of reason writes the new one. A row that does not land is
not marked as filed: the person's row forgets the finding's last filed reason, so the next check
that holds the same finding back writes a row, for that check's reason. That needs this check's own
state write to land; when it fails too, the row keeps the older reason and the lost row stays only
in the drop count and the log. A finding or an outage that
is gone by then leaves no row. When the store fails both the release write and the
`release: "failed"` row, the finding stays told, so that row is lost too. The deployment's audit
drop count and its log record each lost row. A source that reads cleanly forgets its `read-failed` or
`unreadable` row, so its next outage writes a new one. A nudge writes
`personal_watch.nudge`. Neither row carries an event title. A check that finds nothing writes no
row. See [Audit and provenance](../security/audit-and-provenance.md) for the fields.

### Workflow discovery: a routine for work you repeat

The watch also looks for work a person repeats on the same day every week, and offers **once** to
make it a routine. The offer is the whole action. It is a card in the person's own DM:

> **Set up a routine to list issues on linear every Monday at 09:00 UTC?**
> You asked me for this in 3 of the last 5 weeks. Nothing runs until you press Set it up, and I won't
> suggest it again.
> [Set it up] [No thanks]

**The evidence is the person's own tool ledger** (the `tool_usage` rows of
[Analytics](analytics.md)). It holds which connector op ran, when and for whom, and never an
argument or a result. So the detector reads no message and no external text, and the card and the
routine instruction are host-written. A pattern is one connector op that the person ran, in their own
turns, on the same UTC weekday:

- in at least `routines.discoveryMinWeeks` (**3**) different weeks of the last five;
- with the latest of those days inside the last 14 days, so a habit the person dropped is not offered;
- on a weekday that holds at least 60% of the op's active days, so an op the person runs every day
  is not offered as five weekly routines.

🔴 **A routine's own runs do not count.** A routine fire binds as its creator, so the read leaves out
every call made in a session that `usage_events` marks as a routine. Otherwise a routine would read as
the person repeating the work.

**The dial governs it.** A proposal is a message nobody asked for, so it passes the nudge judgement at
`soon`: `none` never reads the ledger, a lowered dose holds it, and the quiet hours hold it. A person
who stopped proactive DMs gets no proposal. The dial's
daily limit and gap count the day's nudges and proposals together, so a proposal waits behind a
nudge. A nudge never waits for a proposal. On top of that, the watch makes at most one proposal per 14
days on `less` and per 7 days on `more`. Each hold writes a `personal_watch.silence` row with kind
`repeated-work`. A check makes a proposal only when it sent no nudge, so one check sends at most one
message. The watch reads a person's ledger at most once a day.

**Set it up runs the normal routine path.** The card freezes a complete `routine.create` argument set:
the person's own DM, a weekly cron on the usual weekday and hour (the median hour of their calls), and
a host-written instruction that does the op and asks before any change. The press hands those
arguments to `routine.create`'s own execute, so the routine row, its first run and its
`routine.create` audit row are the same as for a routine the person asked for in words. The routine
declares no standing permission, so a write it attempts asks first. Only the person the idea is for
can press either button: the card sits in their 1:1 DM, and the click refuses any other clicker.

**No thanks is remembered.** The answer goes on the person's watch row, and
`personal_watch.proposal.declined` records it. An idea is kept on the row from the moment its card
posts, so the watch never offers it again, whatever the person pressed, and whether or not they
pressed anything. A card that did not post takes the idea back, so a later scan offers it.

`routines.discoveryMinWeeks: 0` turns workflow discovery off for the deployment. It is a
`routine.suggest` card, member tier, and raised by the schedule rather than by a tool.

#### Repeated questions

Some repeated work makes no connector call: "who is on call this week?" or "what is our refund
policy?". Discovery also finds a **question** that a person asks the agent again and again on the same
weekday (OPE-2539), and offers the same card in their DM:

> **Set up a routine to answer "who is on call this week?" every Friday at 16:00 UTC?**

**The evidence is the question ledger** (`question_ledger`). The `question-ledger` hook writes one row
when all of these hold:

- a member of the organisation (trust `internal`, a live person, never a routine fire) asked the
  agent in their own 1:1 DM, or @mentioned the agent in a shared room. A thread reply that does not
  @mention the agent is not recorded;
- the message is one line that ends in `?`, with 3 to 24 words and no link or code;
- the turn ended with an answer and made **no** connector call. A turn that made one is already in
  the tool ledger, so the same work is never offered twice;
- the person did not opt out of the agent remembering their content
  ([Memory](memory.md)). An unreadable opt-out reads as opted out. Discovery also drops the rows of a
  person who opted out after they were written.

The row keeps the question's **normalized words** (lower case, with mentions and punctuation removed)
and their hash, never the answer. Each append deletes the organisation's rows older than 42 days.
Two questions match only when their normalized words are equal: a question asked again in other words
is another question. The weekly rule is the one above. The person's discovery reads only the questions
from their own DM. The dial, the DM stop, the gap and the once-per-idea rule hold a question card
exactly as they hold an op card. The routine instruction quotes the question as the thing to answer
and asks before any change. The audit rows name the question by its hash, never by its words.

#### Shared rooms

A room can repeat work that no one person repeats: Alice lists the open incidents one Monday, and Bob
the next. Discovery also reads the two ledgers **per room** (OPE-2539): the connector ops that people
ran in a shared room, and the questions they asked the agent there. A room pattern follows the same
weekly rule, and it must come from **at least two different people**. A connector op that one person
in the room repeats on their own is left to that person's DM, because their own discovery reads their
room calls too, so a habit one person carries alone inside the room gets one card, in their DM. A question that only one person repeats in a room
is offered nowhere: the person's discovery reads only their DM questions.

**The agent asks the room, in the room.** One `routine.suggest` card posts into the room:

> **Set up a routine to list incidents on pagerduty every Monday at 09:00 UTC?**
> 2 people here asked me for this in 3 of the last 5 weeks. Nothing runs until someone sets it up.
> `/oe suggest off` stops these.

A member of the organisation in the room may answer it (member tier). A room whose roster holds a
guest or an outside account gets no card, because no member-tier click is accepted there, and the
idea stays reserved. **Set it up** arms the routine
in the room through `routine.create`'s own execute, created by the person who pressed, so a fire binds
as that person. **No thanks** goes on the room's row (`room_watch`), and the room is never offered that
idea again. A room has no dial, so the rules are fixed: at most one card per room per 14 days, each
idea once, and the organisation's rooms are scanned at most once a day. The same
`routines.discoveryMinWeeks` setting governs it, and `0` turns it off. A posted card writes
`room_watch.proposal`, and the answers write `room_watch.proposal.accepted` and
`room_watch.proposal.declined`.

**The room's stop (OPE-2550).** A person in the room types `/oe suggest off`, and the room's row
records the stop. The room is the conversation the command is typed in, with the same key as the
room's card: a Slack channel, a Discord channel or thread, or one Teams reply chain. On Teams, type it
as a reply under the card. The room then gets no card, and the scan reads none of its calls or
questions. The ledgers still record the room, and the scan's room list still names it. Anybody the
surface names may stop it. Only a member of the organisation may lift it, with `/oe suggest on`,
because only a member may answer the room's card. `/oe suggest` shows the setting. In a DM the command
changes nothing and points to `/oe watch none`. A stop writes `room_watch.stopped` and a lift writes
`room_watch.resumed`, each naming who typed it. The room's row holds no person id.

**Every room hold the scan decides is filed (OPE-2550).** The scan writes one `room_watch.silence` row
when it holds a room back, with a closed reason: `room-stopped` (the room's stop), `proposal-gap` (a card less than 14
days ago) or `delivery-refused` (the card did not post, or the room's audience refused it). The row
names the idea by its fingerprint and host-written summary, never by question words. The room's row
remembers the last hold, so the same hold on the next scan writes nothing new. One stop writes one
row. A posted card or a lift forgets it. A read that fails holds the room with a log line only.

**The scan reads per room (OPE-2550).** The scan lists the rooms with evidence in the 35-day window,
then reads each room's own ledgers. Each read takes at most 10,000 rows for that one room, newest
first, and a full read writes a log line. There is no cap for the organisation, so a busy room never
cuts the weeks of a quiet room. Each read uses an index on the room key. One tick starts no new room
after two minutes, and a room already started finishes. It then records the last room it reached, and
the next tick (30 minutes later) resumes at the next room.

### What it does not do yet

- **A question matches only word for word.** "Who is on call this week?" and "who's on call?" are two
  questions. A question asked to a delegated job, whose connector call ran in the job's own session,
  can be found both as a question and as an op; the once-per-idea rule and the proposal gap still
  hold each one.
- **A habit can still get two cards, or none.** A person whose habit spans the room and their DM (or
  another room) can get both a room card and a DM card. A habit one person carries alone in a room is
  offered only when that person's own watch runs: they have a watch row, and their dial is not `none`.
- **One room's read has a cap.** A room with more than 10,000 rows in one ledger in 35 days loses its
  oldest rows, and a pattern there can be missed. Another room is never cut. A full read writes a log
  line.
- **The room's stop covers cards only.** `/oe suggest off` stops new routine suggestions in the room.
  It does not take back a card that already posted, and it does not pause a routine that already
  runs there.
- **Workflow discovery needs a card path.** A platform with no approval card path gets no proposal.
  The first refused attempt for an idea files one `delivery-refused` row.
- **One detector.** It finds calendar conflicts only. Email and other sources need their own
  detectors.
- **No time zone per person.** The quiet hours are one UTC window for the deployment.
- **The Home tab is Slack only.** `/oe watch` works wherever `/oe` works; the Useful and Not useful
  answers are Home-tab buttons, so on another surface the dose does not move.
- **The DM seat does not veto.** The host decides whether to interrupt. The seat writes the message
  it is handed.

## Everything I do for you: one list per person

A person sees, in one place, everything the agent does on their behalf (OPE-2522). The list is built
by one function, `packages/core/agent/status/doing-for-me.ts`, and two surfaces show it:

- **The Slack Home tab.** "What I do for you" is the first section of the page
  (`home/doing-home.ts`, order 5). It is on by default and needs no configuration.
- **The DM.** A person asks their DM "what are you doing for me?" and the DM-only read `doing_for_me`
  answers with the same list, one numbered line per item. Teams has no Home page yet (see
  [Memory § Other surfaces](./memory.md#other-surfaces)), so on Teams the DM answer is the list.

**What is on the list.** Each item is one plain line with friendly names: no routine id, no person
id and no scope key.

| Item | What it is | What the person can do from the Home tab |
| --- | --- | --- |
| A routine, watch or job they set up **in their own DM** | `Routine.createdBy` is them and the routine lives in their DM. The line shows its prompt. A [watch they asked for](#tell-me-when--a-watch-you-ask-for) shows its app and its condition instead | **Pause** or **Remove**. A one-shot gets **Remove** only |
| A routine, watch or job they set up **in a shared room** | `Routine.createdBy` is them. The line shows the trigger and the room, never the prompt. A watch they asked for shows its app and its condition | Nothing here. They ask in the room to stop it |
| The [chief-of-staff watch](#the-chief-of-staff-watch) | Their own watch row and its sources | **Pause** (sets the dial to None) |
| A credential grant they lend | A live grant their own account pays for | **Remove** (ends the grant, and tells the borrowing room when it can) |
| A DM rule they confirmed | A rule in their own DM room | Listed in the DM answer; the Home tab keeps the rules in **Your rules** |
| A card or a job waiting on them | The [`waiting_on_me`](../security/control-plane.md#in-slack-approvals) queue | **Open**, a link to the card or the work |

**Only the person's own things.** Every read takes the verified person as its only key: the Home tab's
viewer comes from Slack's signed envelope, and the DM read uses the acting person of the turn. The list
never shows another person's routines, grants or rules. A Pause or Remove names its item by a digest,
and the handler builds the person's list again and acts only on the item whose digest matches. A
forged digest can at most name an item the person already owns.

**Why a shared-room routine has no button.** A routine belongs to its room, not to the person who
set it up (see [Lifecycle](#lifecycle-self-disabling-surface-owned)). Stopping it from a private page
would change what the room relies on with nobody in the room told. So the room's own
`cancel_routine` card decides it. The line also leaves out the prompt: another member can rewrite a
shared-room routine's prompt with `edit_routine`, and the person may have left the room since.

**Why there is no Resume button.** Pause and Remove make the agent do less, so they run on the
person's click. Turning a paused routine back on arms standing autonomy again, and
`enable_routine` gates that with a card. A paused routine's line says "ask me in our DM to turn it
back on". A one-shot has no Pause, because `enable_routine` refuses a one-shot and a paused one could
never run. A one-shot that stopped stays on the list until the person removes it. Its line says it already
ran only when its fire ran. A one-shot that was skipped, declined over budget, held by a gate that
expired, or failed says it did not run, and asks the person to ask why. A Pause writes the `routine.paused` audit row; a Remove writes `routine.cancel` with
`via: slack-app-home`. Ending a grant writes `grant.revoked` with `route: home`.

**A part that cannot be read says so.** When one part of the list fails to load, the list names it
("I could not read your routines just now") and shows the rest. An empty part never stands in for a
failed read. The same holds when a part cannot be keyed: with no DM room the routines and rules are
unread, and with no nameable workspace the grants and the watch are unread. The waiting queue keeps
its own cap of 25 items, and the list counts the rest ("…and 2 more waiting on you").

## A routine can name its model role

By default a routine names no role and **inherits**, which is what every routine did before this
field existed and what almost every routine should keep doing. Absence is the default, never a
fallback the code stumbles into.

🔴 **Inherit is not the same answer on both delivery paths.** A fire on the **native** path resolves
`primary`. A fire delivered through the **unified window** carries a window token, which the
supervisor detector answers true for, so it resolves `supervisor` — the cheap ambient tier. That
split predates this field. Naming a role is what makes the two paths agree, which is the main reason
to name one at all.

A routine that wants a different one names a **role**, optionally, at creation:

```
create_routine({ …, modelRole: "utility" })
```

The roles a routine may name are `primary`, `utility` and `supervisor` — the roles a domain can
route (`ModelRoutes`, core's `memory/domain.ts`). `utility` is the cheap summarising role and
`supervisor` the cheap ambient one.

🔴 **It names a ROLE and never a model id.** A role follows the stack wherever the stack goes, so a
deployment that switches stacks moves its routines with it. A pinned id would rot on the day of that
switch, silently, on a routine nobody re-reads. `npm run lint:model-ids` keeps a bare model id out
of `agent/**` in the first place, and its RULE 6 pins the list of nameable roles to the roles
`agent/model/models.ts` actually resolves — so a role added to the stack and forgotten here, or
listed here and absent from the stack, reds rather than drifting.

🔴 **A role this deployment routes nowhere is INERT, not an error and not a downgrade.** Route
resolution falls back to `primary` when the merged route for a role is unset — the same contract the
`supervisor` role has always had. So naming `utility` on a deployment whose domains route no
`utility` changes nothing at all. If you expect a cheaper run, route the role first
(`models: { utility: { id: … } }` on the domain) and check the `model` column of your usage rows,
which already attributes per routine.

🔴 **It reaches the fire's delegated workers too, and that is the intent.** The stamp rides the
whole auth bag, so a routine's declared role covers the work it delegates as well as its own turn —
the delegated work *is* the routine's work. Two consequences worth stating: a routine that names no
role leaves its workers where they were (a worker token is supervisor-shaped, so they resolve
`supervisor`), and a routine that names `primary` moves its workers **onto** `primary`. Both cards
say "this routine — and the work it delegates" for that reason.

**The risk is real, which is why both cards show it.** A routine moved onto a cheaper role can
degrade its judgement, and nothing will report that it did. The creation card names the role in its
own line; the routine **permission** card names it in *both* states — the role, or "inherits this
deployment's model stack" — because a human granting standing authority should never have to infer
the model from a missing line.

The value is host-set off the stored row and is stamped onto the fire's auth bag by
`routines/fire-auth.ts`, so a fire cannot talk itself onto a different model. A row naming an
unknown role is refused when the routine is written (`routines/store.ts` `addRoutine`, beside the
two checks already there), and an unreadable or unknown stamp at fire time degrades to inherit
rather than failing the run.

## The follow-ups ledger

An ordinary routine is stateless: every fire starts a fresh session, so anything the model noted in
its own context dies with the turn. The `jobState` ledger is job-only — `record_job_state` refuses a
routine that is not a durable job. So the commonest routine shape had nowhere to leave a note for its
next run.

`record_follow_up` is that place. A run leaves a named note; the next run of the **same**
routine reads it in its opening message:

> "shard-3 (2026-07-04T13:00:00Z): shard 3 still flaky — check whether #4127 landed."

The entries are **addressed**, not a blob. Writing the same name updates that entry; writing a
different name leaves the others alone. `resolved: true` removes one. Past ten follow-ups the
oldest is evicted, and the run is told which one went. A note is a pointer, capped at 500
characters — the report belongs in the run's own output.

**It is scoped to the routine by construction.** The tool locates the row from the
dispatcher-stamped routine marker, exactly as `record_watch_state` does. There is no routine
id parameter, so no fire can read or write any ledger but its own.

**Taint rides the entry, not the row.** `jobTainted` is monotonic, which is right for one
continuous ledger and wrong for a list of independent notes: one tainted fire would
permanently downgrade every clean note beside it. So a note written on a turn that had read
external content is fenced on the next fire, and the clean notes beside it are not.

## Lifecycle: self-disabling, surface-owned

### When the outcome fold runs

The fold that settles a run — the one that writes the `routine.fire` audit row, advances the
consecutive-failure counter and can flip a routine to `disabled` — runs at the **end of the fire's
own turn**. All four ingresses count:

| Ingress | Counts? |
| --- | --- |
| The fired session CRASHED | Yes |
| The DELIVERY was rejected (archived channel, revoked token, agent removed) | Yes — the dispatcher folds it itself, with no session involved. |
| The fire ran and called `report_run_failed` | Yes |
| The fire ran cleanly | Yes — the run settles `ok` and the failure streak resets. |
| A human CANCELLED the turn | No outcome is recorded, on purpose — see below. |

**One fire folds exactly once**, even though a fire can run for more than one turn. A fire that
delegates gets a second turn when the delegated work comes back, and its delegated worker runs turns
of its own; neither re-settles the run, and neither can reset a failure streak that was about to
disable the routine. A durable **job**, whose fires all share one long-lived session, still folds
every fire separately: the dispatcher stamps a per-fire id onto every fire it sends, on both
delivery paths, and the fold latches that id. A fire that carries no id at all — one sent by a
deployment older than that stamp — falls back to folding at most once for its whole session. That
fallback loses a fold rather than inventing one, which is the safe direction: a wrong fold would
reset a failure streak that was about to disable a broken routine.

**A cancelled fire records no outcome.** If a human cancels the turn, the run is neither a success
nor a routine failure, so nothing is settled and the failure streak is untouched. The routine is not
stuck — the schedule advances when a routine fires, not when it folds — so the next run is already
due.

**A failure declared after the run settled still counts, once.** The fold happens at the end of the
fire's FIRST turn, and for a fire that delegates that is before the delegated work comes back. The
parent learns the work failed on a *later* turn. A `report_run_failed` there reopens that fire for
**one** more fold, which lands the strike and writes a second `routine.fire` row marked `late`. Three
things it deliberately does not do: it never fires for a run a human **cancelled**, it never adds a
second strike to a fire that already settled as failed, and nothing but a declaration reopens a fire
— a later turn that says nothing settles nothing. When a declaration cannot be counted for one of
those reasons, `report_run_failed` answers `recorded: false` and says so, rather than promising a
strike that never lands.

⚠️ **A delegated failure that nobody declares is still invisible.** No edge reports "the worker
failed"; the declaration is the only witness, exactly as it is for a run that fails semantically in
its own turn.

Proactivity that misbehaves is worse than no proactivity, so routines are governed:

- **Self-disable after repeated failures, spanning at least an hour.** Each failure
  increments a consecutive-failure counter; once it reaches three **and** the streak has
  also run for at least an hour, the routine flips to `disabled` with a reason, so a broken
  routine can't spam a channel. Both conditions are required: three failures in the first
  couple of minutes of a fast cadence do **not** yet disable — the routine keeps retrying,
  and only disables once the streak has genuinely run for an hour with the count still past
  three. When the dispatcher fires a routine it no longer claims success — it only advances
  the schedule; the *real* outcome is folded back when the session completes or fails. **A
  fire that never reached a session counts too:** if the delivery itself is rejected —
  archived channel, revoked token, the agent removed from the surface — that is recorded as
  a failed run against the same counter, so a routine that can no longer post anywhere stops
  trying instead of retrying on every tick forever.
- **A denied action is not a failure.** A tool refused by the [approval
  plane](../security/security-model.md) is the system working as designed, not an
  infrastructure fault — the turn sees the refusal like any other recoverable tool error and
  can finish normally (reply that it couldn't do the thing, try something else). That normal
  completion settles `ok`, so it never touches the failure counter on its own. The one way a
  denial COULD read as a failure is the turn choosing to call `report_run_failed` about it —
  the same judgement call as any other declared failure, below.
- **A run can declare its own failure.** The two cases above are both *mechanical* — the
  session crashed, or the message never landed. Neither can see the most ordinary way a
  routine dies: it runs perfectly, the thing it was checking is broken, and it posts "I
  couldn't reach the API" every morning for a month. That turn **completes cleanly**, so
  without help the counter reads it as a success and the routine fires forever. So every fire
  is told, in its own message, to call `report_run_failed` with one line when the work it was
  sent to do did not happen. That line must name what the run **tried** and what the system
  **answered** — the operation it called, the search it ran, and the words that came back. A bare
  "not authorized" is a guess unless a call returned it, and a guessed cause reads exactly like a
  measured one once it is in the audit row. That is what the counter folds — a declared failure and a session
  crash are the same kind of event to it, and three of either, spanning an hour, disable the
  routine. The declared line rides the `routine.fire` audit row (`declaredFailure`) and the
  `routine.disabled` row, so "why did this stop?" has an answer in the routine's own words
  rather than only a count. Deliberately **not** a judge deciding whether the output *looks*
  like a failure: a routine whose job is to report problems would disable itself for doing it
  correctly, and [authorization is by code, never by a model judging intent](../security/security-model.md).
  The turn is told the distinction explicitly — did the *work* happen, not was the *news* good.
  The trade this accepts: a run that declares success it didn't earn is not detectable here,
  which is the same trust boundary every other model-declared fact sits on.
- **A skip is not a failure.** A declined run, or an only-on-change run that saw nothing
  new, records `skipped` and **resets** the counter. Proactivity shouldn't punish a correct
  "nothing to do". A completed *silent* fire is `ok`, not `skipped` — a silent routine doing
  its job is a success, not an absence of work.
- **A self-disable announces itself.** When a routine flips to `disabled`, one line is posted
  into its own surface saying it stopped, why, and that it can be set up again — on top of the
  durable `routine.disabled` audit row. For a silent routine this is the one message it is
  always allowed to make: its healthy state is also "you hear nothing", so dying quietly would
  be indistinguishable from working. Recovering from it is `enable_routine`, which re-arms the
  **same** routine — clearing the strike counter but keeping its id, its history, a watch's
  baseline and a job's progress ledger — rather than creating a fresh one that starts blind.
- **How only-on-change works.** The fired turn is instructed to observe the watched thing,
  then call the `record_watch_state` tool with a canonical representation of what it saw.
  The hashing, the comparison against the last observation, and the `skipped` bookkeeping
  happen **host-side in the tool** — the diff verdict is authoritative, never the model
  diffing from memory (a fired session is stateless, so a model-judged "nothing changed"
  drifts across runs). When nothing changed, the turn is told to end with the silence
  sentinel so nothing posts (the *staying silent* is instruction-followed, the same
  contract as judged thread-follow replies). The first observation always posts (the
  baseline), then only when the observed state's hash changes.
- **Surface-owned, not creator-owned — but the ROOM is asked, live, on every clock fire.**
  A routine survives its creator leaving the org: it runs on the room's own authority, not
  the creator's continued presence, and a human can always cancel it explicitly. Two
  *different* things stop it instead. If the **agent** is removed from the surface, the
  routine ends by the same three-strike-spanning-an-hour counter above, not instantly: each
  fire's delivery is rejected, each rejection counts as a failure, and the third (once the
  streak has also run an hour) disables the routine with a reason — expect that to take at
  least an hour and at least three of its own cadences. If the **creator** is removed from
  the room specifically — a narrower, different fact from leaving the org — the routine
  instead **skips** that one fire (Slack and Teams, v1): it checks the creator's live room
  membership and account status (not deleted/deactivated, or on Teams not disabled in Entra)
  before firing, and a confirmed
  "no" on either skips with a `routine.skip` reason row (`creator_removed_from_room` /
  `creator_account_inactive`) rather than a failure — it never touches the three-strike
  counter, and retries at the routine's own next scheduled fire with no early retry and no
  backoff. An unresolved check (no token, an API hiccup) is never read as a "no". On Teams
  an unresolved **room** check writes its own `routine.eligibility_unresolved` row naming
  the cause, so a fire that passed through unchecked is legible rather than silent; a fire
  that was really checked writes no such row. There is
  deliberately **no membership sweep** for either check — Open Everywhere never enumerates
  the channels it belongs to, so the agent's own removal is learned by trying to post, and
  the creator's is checked live at fire time rather than cached at creation.
- **A one-shot disables itself on its outcome, whatever that is.** A `once` routine has no
  "next occurrence" to compute — the dispatcher fires it when due (respecting the
  ~10-minute tick resolution, same as any other trigger). If it never reaches delivery (a
  budget decline, a creator-eligibility skip) it flips to `disabled` immediately, with a
  reason naming why it never even tried. If it DOES fire, it goes terminal once the outcome
  is known: a success is recorded as an ordinary completion (no announcement — a healthy
  one-shot finishing on schedule is not a self-disable), and a failure disables it on its
  FIRST and only try — there is no second chance to wait for. Its notice says that its one
  scheduled fire failed, not that it reached a failure count. The reason on the row is
  host-composed; the fire's own declared reason stays on the `routine.fire` and
  `routine.disabled` audit rows (`declaredFailure`). The row stays for `list_routines`/audit visibility either way; recreate a fresh
  one-shot rather than expecting this one to fire again.
- **A durable job retires on its own completion.** A [durable job](#durable-jobs-persistent-multi-step-work)
  fires until its own session calls `complete_job`, which flips it to the terminal `done` status
  (distinct from `disabled` — the job *finished*, it didn't break), nulls its next run, and audits
  the completion. The row is kept for visibility, like a fired one-shot. It's idempotent, and a
  completed job is never fired again.
- **…or at its ceiling, if it never completes.** A job that keeps succeeding without ever calling
  `complete_job` stops at its bound — 200 runs or 7 days by default, whichever comes first — and
  posts a notice saying so. That stop is `disabled`, *not* `done`: `done` means the objective was
  met, and a job at its ceiling is precisely one where it wasn't, which is why `enable_routine` will
  re-arm it (with a fresh ceiling) while it refuses a completed job. The `routine.disabled` audit row
  names which dimension tripped and carries the routine's own `consecutiveFailures` count, which is
  usually 0 — a ceiling stop and a three-strike stop are different incidents and read differently in
  the log.
- **…or when nobody checks in.** Any recurring routine, a job included, pauses itself after its
  check-in grace with no press (see
  [When nobody checks in](#when-nobody-checks-in-keep-going-or-it-pauses)). The `routine.disabled`
  row carries `checkIn: true`, and a Resume press or `enable_routine` starts it again.
- **…or sooner, if it keeps getting blocked.** A job paused by a
  [session cost checkpoint](../security/spend-and-cost.md) on three fires running stops itself too,
  with `boundDimension: "stalled"` on the same `routine.disabled` row plus the count that produced it.
  That is a third incident again: it neither broke nor ran out of runs, it was never allowed to work,
  so the notice and the re-arm card both say to clear the checkpoint before starting it again.

Operators can inspect exactly what will fire — a CLI lists every routine across surfaces
with its next run and status, or only what a tick would fire right now, reading the same
store the dispatcher does.

## "Did my 03:00 routine actually run?"

A routine runs with nobody in the room, so there is no conversation to reconstruct it from.
Every fire therefore leaves durable rows in the [audit log](../security/audit-and-provenance.md),
and asking the agent `list_routines` reads them back:

| Row | Written when | What it answers |
| --- | --- | --- |
| `routine.fire` | the fire's own turn ends | It ran. Carries the routine id **and** the session id — the handle for the session transcript, including for a fire that decided to stay silent. |
| `routine.skip` | it was due/matched but not dispatched | It didn't run, and why: `over_budget`, `unresolved_target` (no wired channel), `fanout_cap` (an event matched more routines than the per-delivery cap, `routines.eventMaxFanout`, shipped 3), `filter_invalid`, `grant_refused`, `grant_drift`, `audience_floor`, `creator_removed_from_room` (the clock leg, Slack and Teams — the creator is no longer a member of the room this fire posts into), `creator_account_inactive` (the clock leg, Slack and Teams — the creator's account is deactivated/deleted, or on Teams disabled in Entra), `halted` (a break-glass halt covers this routine's address — the deployment's posture, not the routine's mistake, so the routine stays armed and fires again once an admin runs `resume`), or `condition_gate` (its declared condition gate said no — the row names the gate and the one line the predicate gave, and it is the only place a human learns why a healthy-looking routine has not run). |
| `routine.eligibility_unresolved` | a creator-eligibility check could not answer, so it did not block the fire | This fire was **not** really checked, which check it was, and why. Today the Teams room-membership check writes it, with a closed-set cause: `read_error` (a Graph call that failed — network, 5xx, or a permission the install lacks), `team_id_unresolved` (the Bot Connector could not give the team's Microsoft 365 group id), `roster_incomplete` (the roster is past the probe's page bound, so the creator was neither found nor ruled out), `malformed_response`, `no_provider`, or `missing_ids`. A fire that WAS checked writes nothing, so the row's presence is the signal — without it a fail-open and a pass leave the same trace, which is none. The row says the fire was not CHECKED, never that it ran: a later gate on the same tick (the spend cap) can still decline it, and that decline writes its own `routine.skip`. Throttled like `routine.skip`. A row that a [test run](#test-it-before-it-runs) wrote carries `test` (the test id), names no fire, and throttles apart from the real fires' rows. |
| `routine.run_now` | somebody asks for a fire with `run_routine_now` | Who asked, and when. It records the REQUEST. The fire that follows writes its own `routine.fire` row carrying `manual: true`, so a request that never becomes a run is visibly a request with no fire. |
| `routine.test_requested` / `routine.test_fired` / `routine.test_blocked` | somebody asks for a [test run](#test-it-before-it-runs), the dispatcher starts it, and the test blocks a write | Who asked; whether the test started, or why not (`fence-unmounted`, `not-testable`, `unresolved-target`, `halted`, `grant-refused`, `posture-changed`, `audience-floor`, `creator_removed_from_room`, `creator_account_inactive`, `over-budget`, `grant-drift`, `hydration-failed`, `root-post-failed`), and `replayed` for an event routine's replay; and one row per blocked write, with the tool and a short description. A test writes no `routine.fire` row, because it is not a run. |
| `routine.collect_failed` | a fire's declared [pre-run collectors](#pre-run-data-collection) did not all collect | The run could not look. Names each collector and a closed-set reason — refused for a permission the routine does not hold, unknown to this deployment's config, broken at the read, or broken AROUND the reads before this collector ran (the collection step itself failed) — plus the recorded cause of a read that threw. The fire still happened, unless the routine also declares a condition gate: a collection that broke as a whole fails that gate closed, and this row is then the only record. Throttled like `routine.skip`. |
| `routine.fire_lost` | the delivery itself was rejected | It was dispatched but never started — an archived channel, a kicked bot, an API failure. The row says explicitly that there is no session id. |
| `routine.stalled` | a fire was refused a consequential tool by a [cost checkpoint](../security/spend-and-cost.md) | It ran but couldn't act, and which tool it was refused. One row per blocked fire, not per refused tool. Without it a job's second and later blocked fires wrote nothing at all — `checkpoint.trip` is once per session, and a durable job's fires share one session. |
| `routine.disabled` | the failure threshold trips, a ceiling / stall bound does, or a gated one-shot's 24-hour wait expires | It stopped itself: after how many strikes, on which fire, or `boundDimension` naming which bound (`fires`, `deadline`, `stalled`). The gate-wait case is the one row with no strikes and no session id: it carries `gate` and `gateReason` instead, and its reason names the condition that never held. |

Two deliberate silences: a routine that is **over the per-tick concurrency cap**
(`routines.maxConcurrency`, shipped 3) writes
nothing (it keeps its slot and fires on a later tick — that's "not yet", not a skip), and a
routine that simply **isn't due** writes nothing at all, so an empty result is itself the
answer to "did it run?".

`list_routines` folds all of that into the room alongside the schedule: the last fire's
session id, when the routine last actually *posted*, how many times it fired and how many
tokens it burned over the last 7 days, its consecutive-failure count, who created it, and
whether it was authored in a turn that had ingested external content. Usage rows are
stamped with the routine id too, so per-routine cost is a normal analytics query.

An **event subscription** has no clock, so none of the "did it run on time?" signals apply to it;
its equivalent question is answered by `firstMatchAt`/`lastMatchAt` — see ["Is my filter wrong, or
has nothing happened yet?"](#is-my-filter-wrong-or-has-nothing-happened-yet).

Skip rows are rate-limited to roughly one per routine per reason per hour, and each emitted
row carries the count it stands in for — a standing misconfiguration reports itself hourly
instead of once per tick or once per inbound webhook delivery.

### "…and what did it actually do?"

`list_routines` tells you a run happened. `read_routine_transcript` tells you what it *did*: ask
the agent in the channel and it replays that run — what it was woken with, what it reasoned, which
tools it called with which arguments, what those tools returned, and what it finally said (or that
it deliberately said nothing). Give it a routine id from `list_routines`; `fireDepth` picks how far
back to look (`1` is the latest run, the default). Any run inside the same 7-day run-history window
is readable.

**It is scoped to the channel you ask from, and that boundary is structural.** A routine is
resolved against the asking channel's own run history, so a routine belonging to another channel
resolves to nothing — there is no input that widens it, and no session id is ever named by the
model. Within one channel the read discloses nothing new: everyone there could already scroll up.

**What a transcript adds — and why it arrives as quoted data.** A transcript is a *superset* of
what the channel saw: it carries what the run **ingested** — a fetched issue body, a page it read
through a connector — none of which was ever posted into the room. Scrolling up shows you the
agent's reply; the transcript shows the raw source behind it. So the replayed content arrives
wrapped in the same untrusted-content envelope every external read gets: the agent treats it as
information, never as instructions, and text inside a transcript that says "ignore your
instructions" reads as a quote of an attacker, not as an order. Without that, a payload planted in
an issue body could ride a triggered run into a later conversation as trusted recap.

Two limits worth knowing. An **unattended durable job** does not get this tool — replaying another
run's ingested content into a long-lived session with nobody watching is exactly the lever the
[job-wake restriction](#durable-jobs-persistent-multi-step-work) exists to withhold; a human in the
room is the intended reader. And the read needs **two** things on the deployment: the credential
vault armed (`OE_CREDENTIAL_ENCRYPTION_KEY` — its own HMAC secret, `OE_TRANSCRIPT_RELAY_SECRET`,
mints itself on first use and needs no operator step; see the
[configuration reference](../deploy/configuration-reference.md)), and a resolvable public base URL
for the relay. Without either, the tool simply isn't there, rather than being present and
refusing. Every read is itself audited
(`routine.transcript_read`, ids only, no content), so *who replayed whose run* is answerable the
same way everything else is.

## The declared-permission and config-PR audit rows

Two more families of row sit on this plane. The first records a routine's **standing permissions** —
what it may do without drawing a card each time. The second records an approved request that turns
into a **config pull request**.

| Action | When the code writes it | What the row carries |
| --- | --- | --- |
| `routine.grant` | A creation-card click arms a routine's declared permission set. | The routine id, who armed it, the permission **kinds** that were armed, the permission generation, and `declared: true`. Nothing is re-rendered into the row. The row is written only when at least one kind actually armed. |
| `routine.grants_revoked` | `revoke_routine_permissions` withdraws a routine's standing permissions. | The routine id, who revoked them, the revoked count, the row count, and the permissions that were held. Written only when at least one row was removed. |
| `routine.permission_granted` | A person grants one permission ask from the routine's card. | The routine id, the grant kind, the declaration string and the grant key. |
| `routine.permission_declined` | A person declines that ask. | The same four fields. A decline that wrote nothing would draw a card again on the very next fire, so it is recorded under the same generation key. |
| `routine.permission_declined_stale` | The ask was **already stale** when the click landed, so nothing was remembered. | The same four fields. The separate action name is what keeps "declined" and "arrived too late" countable apart. |
| `routine.permission_never_lifts` | A routine declares a permission this deployment's config raises out of reach, so the ask can never lift. | The routine id, the declaration string, the generation, and the reason. It makes a standing widening countable. It is **not** written on a tainted arm, where nothing armed and the cause is taint rather than the raise. |
| `routine.expire` | A pull-request subscription stops watching — the pull request settled, or the chain spent its check budget. | The `repo#number` it watched and the stop reason. 🔴 It is written only when a chain **was already running**, cap-exhausted stops included. A first `subscribe_pr` against an already-settled pull request answers a question rather than expiring a subscription, so it writes nothing. |
| `routine.fire_attrs_seen` | A fire's own turn records the carriage attribute **key names** that arrived on it. Two turns count: a session that eve's own schedule auth woke (a fire with no surface, which keeps the native send), and a work-session turn whose delivery carries a forwarded fire's routine marker (every fire with a surface). | The sorted key names, and never a value, with the session id. It pairs with the `routine.fire_attrs_sent` row the fire itself wrote, so the two ends of one carriage are comparable. A delegated child writes no row. For a forwarded fire, the work session's row names the session that each worker's `parentSession` names. A forwarded fire that lost its routine marker writes no row. |

🔴 **`routine.grant` and `routine.grants_revoked` are named for a vocabulary this plane has since
renamed.** The plane calls the thing a *declared permission*, and the code's own constants say so.
The two strings stay as they are because they sit in deployed, hash-linked, append-only chains:
renaming an action rewrites no existing row, and only stops a reader from finding the old ones.

**The config-PR rows: `webhook.declare.pr_opened`, `access.request.pr_opened` and
`agent.create.pr_opened`.** An approved webhook declaration, access request or agent creation
commits to the config repository and opens a pull request, and each writes its own row naming the
request id, the sentence the approval was granted against, the repository, the branch, the pull
request number and URL, and whether the pull request was updated rather than created.

🔴 **A dry run writes the same action, with `dryRun: true` and no pull request.** All three actions
have two write sites: the real one above, and a validation-only arm that opens nothing. So a count
of `*.pr_opened` rows is **not** a count of pull requests. Read `detail.dryRun` before you count,
and read `detail.pr` — a real row names the pull request number, and a dry-run row cannot.
The dream cycle's `memory.skill_proposal_pr` row follows the same rule: a dry-run install writes
it with `dryRun: true` and no `pr` (OPE-2416).

## Spend caps

Proactive work runs without a human in the loop, so it's bounded by spend caps. A durable
per-surface token ledger records usage, config-as-code caps set the budget (uncapped until
you set one), and an over-budget scope is **declined cleanly** — never truncated mid-task.
The dispatcher enforces this at fire time: an over-budget routine fire is declined before
any session starts, recorded as `skipped` (a correct "nothing to do", not a failure), and
its schedule advances so it retries at its own cadence. A workspace cap is the sum of its
surfaces, DMs included — and a fire never gets the attended admin bypass. Caps and the ledger live in the operational store,
org-partitioned. See [Spend & cost controls](../security/spend-and-cost.md).

## Event filters are jq

An event routine's filter is a **jq expression** that must evaluate to exactly `true` or `false`.
It runs against a stable, vendor-neutral projection of the event:

| Path | What it is |
| --- | --- |
| `.source` / `.scheme` | which hook this arrived on / which contract it speaks |
| `.event` / `.action` | the vendor's own event name and verb, verbatim |
| `.fields.<name>` | the matchable scalars the source's normalizer flattened out (GitHub: `repo`, `action`, `sender`, …) |
| `.scope.<tenant\|group\|container\|entity\|sub>` | the container path the delivery **proved**, keyed by level. An absent level is `null` |
| `.scopePath` | the same path, ordered outermost-first, for anything structural |
| `.deliveryId` / `.occurredAt` / `.redacted` | delivery metadata |

```
.scope.container == "acme/web" and (.fields.action | IN("opened","reopened"))
```

Three things follow from it being jq, and they are the reasons for the choice:

- **OR is expressible.** `a or b` is one routine. The previous filter language could only AND, so
  every disjunction meant two routines.
- **An absent field is `null`**, so `(.fields.x | IN("a"))` is false when `x` is missing and
  `(.fields.x | IN("a") | not)` is true — which is what makes the negative form usable for excluding
  an actor.
- **A typo is refused when you write it, not silently at every fire.** The expression is compiled and
  run once at creation against a synthetic event, so an expression that will not parse, yields a
  string instead of a boolean, or is too expensive to run per delivery is rejected on the spot. An
  event routine has no clock, so nothing would ever revisit a broken one.

**And so is a subscription that could never read the source.** Arming an event routine on a hook
your channel is not permitted to read used to *succeed* — the routine sat `active` forever and
simply never fired. It is now refused when you ask for it, naming the source and what to do about
it (arm it somewhere that can read the hook, or have an operator widen the hook's `readableBy` in a
PR). This is a **better error message, not a stronger boundary**: the permission check at fire time
is unchanged and remains the only one that decides anything — a grant revoked *after* arming still
stops the fire. Where the answer cannot be known in advance — a vendor ingress whose authorization
depends on which repository a delivery names — nothing is claimed and nothing is refused. See
[declarations are checked for reachability](../extending/webhook-ingress.md#declarations-are-checked-for-reachability-not-just-for-shape).

The evaluator is in-process — a pure-JavaScript jq over an in-memory document, with no host
filesystem, no process environment and no subprocess — and costs well under a millisecond per
routine per delivery.

**What is deliberately not in the document:** the rendered `summary`, the resolved `actor` and the
re-fetch `pointer`. Filters match on ids, never on prose: jq has regex, and admitting a
sender-authored PR title into the match surface would put a regex engine on a per-delivery path
against a string an outside party controls.

**A filter that cannot be evaluated never fires.** It is recorded as a skip carrying jq's own message
*and the expression that produced it* (`routine.skip`, reason `filter_invalid`, visible in the audit
read model — see ["Did my 03:00 routine actually run?"](#did-my-0300-routine-actually-run)), and it
is explicitly not counted against the routine's failure budget: a broken filter is a config problem,
and striking for it would let one bad deploy disable a whole fleet.

**jq is the only filter language.** Two retired shapes — the declared-key `{all, under}` filter and
the older exact-equality `match` record — used to be readable beside it, compiled to jq when the row
was loaded. They were deleted after a store census counted no rows carrying either.

A row that still carries one is now **unreadable, and says so**. It never fires, it records itself as
a `filter_invalid` skip naming the offending key, and `list_routines` renders it as unreadable rather
than as a filter. The durable store also refuses to write one. The alternative — reading an
unrecognized shape as "no filter" — would turn a narrow subscription into every event from that
source, which is why the deletion is loud at all three surfaces.

### "Is my filter wrong, or has nothing happened yet?"

An event routine has no clock, so it has no next run and no last run — which used to mean a
subscription that **matches nothing** and one that simply **hasn't been triggered yet** looked
exactly alike: total silence, in the room and in the audit log.

`list_routines` now reports two instants for each event subscription: **`firstMatchAt`** (the first
time its expression ever matched a real delivery) and **`lastMatchAt`** (the most recent). Read them
together and the two cases come apart:

| What you see | What it means |
| --- | --- |
| no `firstMatchAt` | the expression has never matched anything. Either nothing has arrived on that hook, or the filter is wrong — check the hook is delivering before rewriting the jq. |
| a `lastMatchAt`, but no fires | the filter is **fine** and something downstream is stopping it. The reason is already in the audit log as a `routine.skip`: `grant_refused` (this channel may not read that scope), `unresolved_target` (the surface lost its wiring), `fanout_cap`, or `audience_floor`. |
| a stale `lastMatchAt` | it used to match and the traffic stopped. |

They are stamped **when the filter matches**, before the grant, target and cap checks — that
ordering is what makes the middle row of that table possible at all. A filter that could not be
*evaluated* never stamps: a broken expression reports itself as `filter_invalid` (above) and must
never be made to look live.

The pair is a liveness reading, not a counter. Writes are coalesced to at most one per routine per
minute, so `lastMatchAt` is accurate to within a minute and carries no information about volume —
for that, the per-fire rows and usage ledger already answer.

### "…and is the sender even reaching us?"

The question above assumes deliveries are arriving. `read_webhook_history` is how you check: ask the
agent about a hook by its source handle and it reads back that hook's **delivery history** — hits
*and* misses — over the same 7-day window the run history uses.

| What it shows | What it means |
| --- | --- |
| no deliveries at all | the sender has never reached the endpoint. Nothing downstream can be wrong yet — check the URL and the secret at the sending system. |
| deliveries **rejected** (`HTTP 401/404/409/413`) | they arrived and were refused at the door: a wrong or rotated signing secret, a stale URL, an oversized body, or a replay inside the skew window. The sender believes it is delivering. |
| deliveries **accepted**, `matched 0` | the hook works and no filter matched. Now the filter is the suspect. |
| deliveries accepted, a routine **matched** then missed | the reason is named per routine — `grant_refused`, `unresolved_target`, `fanout_cap`, `audience_floor`, `grant_drift`, `filter_invalid` (with jq's own message), or `fire_lost`. |

Each delivery carries its timestamp, its byte **count**, how it was authenticated (`signed`,
`previous-key` — the sender has not moved to a rotated secret yet — or `unverified`), the sender's
own delivery id where the source supplies one, and the fan-out counts.

**It is metadata only — the delivery history stores no payload body, so it can show none.** That is a
deliberate property of the audit trail, not a gap in this view: the ingress never copies
sender-supplied bytes into the append-only log, so there is nothing for a read to reach. The one way
to see what a sender actually sent is the **capture window** below, which is off until somebody turns
it on, keeps a bounded sample somewhere else entirely, and forgets it again on its own.

**Who may read it is the hook's own `readableBy`** — the same grant that decides whether a routine on
this surface could have been *fired* by that hook, checked with the same code. If a routine here
could fire on it, this room can read its history; if not, the refusal *names the grant* rather than
saying nothing. That is how a hook readable by nobody announces itself instead of failing silently
forever. Every read is itself audited (`webhook.history_read`, ids and counts only), so *who asked
about whose ingress* is answerable like everything else.

One honest limit worth knowing: miss rows are **rate-limited** — roughly one per routine per reason
per hour, one per rejection identity per minute — and every emitted row carries the count it stands
in for. So the absence of a miss row for a particular delivery is not proof that delivery was fine;
the view says so when any row it returns was standing in for others.

### "I don't know what this sender's payload even looks like"

For a hook where **we** define the envelope and somebody else fills it in, there is no vendor
documentation to look up — what the fields are called is whatever the sending system happens to put
there. Writing a filter against that blind is guesswork, and a filter that matches nothing looks
exactly like a hook nobody has poked yet.

The **capture window** answers it from the deployment's own traffic. Ask the agent to start recording
a webhook (`capture_events`) and, for a bounded period, each delivery that arrives is kept. Then ask
to see them (`list_recent_events`) and they come back **numbered**:

```
  1 ✓ build.finished  [acme/web]  status=success branch=main
  2 ·  build.finished  [acme/web]  status=failed  branch=topic/x
  3 ✓ build.finished  [acme/lib]  status=success branch=main
```

Point at the ones that matter — *"1 and 3"* — and the agent writes the jq filter. Pass that filter
back and it is **scored against the same deliveries**, marking which it selected and which it did
not, so you can see it picked the right rows *and* rejected the wrong ones before it is ever stored
on a routine. That check is the point: a filter is only correct if the misses are correct too, and
the misses are on the page.

**Recording is off until you ask for it.** Creating a webhook does not start it. When it does run it
is bounded three ways at once — a maximum number of deliveries, a maximum length of time (whatever
you ask for, capped), and an absolute expiry that discards rows regardless. Nothing has to be turned
off and no one has to remember to clean up; re-recording clears whatever was there before, which also
makes it the way to discard a sample early.

**What is kept is not the raw request.** It is the same normalised view a filter is evaluated
against — the event name, the scope, and the matchable fields. Request headers are never part of it,
so a signature or a misdirected API token cannot be retained; neither is the human-readable summary
line. This is also why the dry run is trustworthy: you are scoring the filter against *exactly* the
document it will be given in production, not against a richer copy.

**Trigger-only webhooks cannot be recorded at all**, and asking will say so. That posture exists
precisely so a payload is never retained or shown to anyone; a capture window would be a way around
it, so it is refused by name rather than quietly recording nothing.

Reading a capture window is gated by the hook's **`readableBy`**, exactly as its delivery history is,
and so is *starting* one — a room that could not read a hook's events cannot begin storing them
either. Both acts are audited (`webhook.capture_arm` and `webhook.capture_read`, identifiers and
verdicts only, never a captured value).

## Inbound webhook triggers

Event routines (above) fan a single GitHub ingress out to however many dynamically-created
routines subscribed to it — the right shape when subscriptions are created at runtime,
in-thread, and need to be matched by event type / action / repo. A **webhook trigger** is
the simpler, generic sibling: one config-declared hook id, for *any* external provider that can
POST a signed payload — not just GitHub. Declare it once in code:

**A hook comes in two shapes, and `target` + `instruction` are what pick one.** Declare them
together and the hook is **fused**: every accepted delivery runs that one instruction in that one
place. Omit them both and it is **emit-only** — a door and nothing else, whose consequences
are decided afterwards by `event` routines someone creates separately. One without the other is
**refused at config load**, in both directions: a target with no instruction fires a channel with
nothing to say, and an instruction with no target has nowhere to run.

Reach for emit-only when the consequences are not settled yet, are likely to change, or are
several different reactions to one system — the ingress can go live now and the routines can be
added, changed and removed later without touching it. Reach for fused when the consequence is one
fixed thing in one fixed room.

*(You do not have to write this file by hand. Ask the agent for a hook of either shape and
`declare_webhook` opens a **pull request** adding the declaration: a human reviews and merges it, and
the signing secret is set separately — either by an operator under `broker: "env"`, or through a
one-time link under `broker: "db"`. Nothing is live until both have happened. Chat's job is
authoring the diff, not bypassing it — see [webhook
ingress](../extending/webhook-ingress.md#4b-two-shapes-of-hook-and-they-are-not-two-ways-to-do-one-thing).)*

```ts
defineWebhook({
  id: "deploy-status",                        // POST /webhooks/deploy-status
  source: "oe-standard-webhook",               // WHICH signature scheme its sender signs with
  secretRef: "DEPLOY_STATUS_WEBHOOK_SECRET",   // where the shared secret LIVES — a ref, never the value
  broker: "env",                               // the home that ref resolves through: "env" | "db" | ...
  target: "slack/T0123ABCD/C0456EFGH",         // a room on any surface, or "dm:<principal key>" for a person
  readableBy: [{ level: "domain", domain: "engineering" }],  // WHO may read its events — required, no default
  posture: "projection",                       // HOW MUCH of the payload reaches the prompt
  project: ["status", "branch"],               // …under "projection": exactly these fields
  instruction: "A CI deploy-status webhook just fired. Summarise the result for the channel.",
});
```

**A webhook reaches the agent, not Slack (OPE-2419).** `target` names any place the agent lives,
in one of two forms:

| Form | Example | Where the turn runs |
|---|---|---|
| A room: `<platform>/<workspace>/<surface>` | `slack/T0123/C0456`, `discord/<guild>/<channel>`, `teams/<tenant>/<conversation>` | That channel or group. A Teams conversation id is written in its surface-key spelling, as the domain roster writes it. A Teams group chat runs as a group DM; a Teams 1:1 chat is refused as a room — name the person instead. |
| A person: `dm:<principal key>` | `dm:slack/T0123/U0789`, `dm:discord/<user>`, `dm:teams/<29: id>` | That person's 1:1 DM, as a DM: the DM's standing grain, and no internal-trust verdict. |

The fire **resolves the target when a delivery arrives**, through the same per-surface resolver a
routine fire uses, so a hook needs no live binding to be declared. Config load checks only the
shape: a malformed target, or one on a platform with no resolver, fails loud at boot. Whether the
target RESOLVES is a fire-time question, and an unresolvable target **declines** with a reason that
names the fix. The reason lands on the `webhook.declined` audit row; nothing is dropped in silence.
The cases that can decline:

- **Teams** cannot cold-address anybody. A room needs the conversation reference captured when the
  bot last heard a message there, and a person needs one direct message to the bot first. Until
  then the fire declines and says so. A target that names another tenant than the conversation's
  own is refused.
- **Discord** checks that the channel is in the guild the target names, and refuses a mismatch. A
  person's DM opens at fire time; Discord refuses it when the person shares no server with the bot
  or does not accept DMs from server members.
- **Slack** checks a person with `users.info` before it opens the DM with `conversations.open` (the
  `users:read` and `im:write` scopes). The person must be a full member of the workspace the target
  names: a Slack Connect user, a guest, a deactivated account or a bot is refused. When config names
  exactly one Slack workspace, a target in another workspace is refused before any call. With no
  Slack workspace named, with several, or with an Enterprise Grid entry, the workspace segment is
  not verified, which is the same limit a Slack routine has.

The spend gate applies on every surface. The audience floor (below) refuses an observed-guest room
on Slack, where the platform reports the room's roster. **Discord and Teams report no roster, so a
webhook there fails closed instead** (the *stranger-room floor*):

- a group chat or group DM is always refused, because its members are an ad-hoc set;
- a channel fires only when the operator has declared it internal with
  `defineSurface({ key: "<surface key>", trust: "internal" })` in `agent/identity/surfaces.ts`. A
  Teams shared channel cannot be told apart from a standard one at fire time, so the declaration is
  the only evidence there is. A tenant-wide declaration vouches every room in that tenant, a shared
  channel included, so prefer room-level lines;
- a 1:1 DM fires, because the hook names that one person.

Only a Slack **channel** can be confirmed internal at fire time; every other target, and every DM,
binds `external`, so shared memory and domain skills stay off there.

**`readableBy` is required and has no default**, because a hook readable by nobody accepts
deliveries and then refuses every routine, forever, in silence. It lists the scopes whose surfaces
may read this hook's events, in the same `Scope` vocabulary your access bindings use:
`{ level: "domain", domain: "payments" }` names one domain, several entries are a **union** (many
domains may legitimately read one hook), and `{ level: "org" }` means **every domain in the org**.
It is the whole confidentiality decision for the ingress — what a subscribing routine then *acts*
on is that routine's own filter, and anything finer-grained than `readableBy` is a second webhook.
Full treatment in [webhook ingress](../extending/webhook-ingress.md#4-the-read-grant).

**`posture` decides how much of the sender's payload ever reaches the prompt** —
`trigger-only` (none of it), `projection` (only the fields listed in `project`), or
`content-bearing` (the whole body, as untrusted data). **Omitting it means `content-bearing`**,
which is exactly what every config hook did before the field existed, so adding the field
changed no existing deployment's behaviour. Declare it explicitly on new hooks — `declare_webhook`
makes it a required choice and puts the consequence on the approval card. The full axis is under
[two kinds of sender](#two-kinds-of-sender-and-the-second-one-needs-no-adapter).

**A fused config hook does two things when it fires**, and both are intended: it fires its own
declared `target` + `instruction`, *and* it emits into the event plane, so members can subscribe
`event` routines to it from chat by naming its **id** as the source (`create_routine`, trigger kind
`"event"`, source `"deploy-status"`). Subscribing is the runtime act; declaring the ingress stays a
diff. **The posture governs both** — a hook cannot be `trigger-only` on its own target and
content-bearing everywhere a routine subscribed. An **emit-only** hook has only the second of those
consequences, which is the entire difference between the two shapes.

**Where the secret lives decides whether going live costs a redeploy.** `broker: "env"` names an
environment variable, so an operator sets it and the deployment restarts before the hook can
authenticate anything. `broker: "db"` instead stores the value here: the declaration carries only
the ref, and after the PR merges someone asks the agent to rotate that webhook and gets a **private
one-time link** with a freshly generated secret to paste into the sender. No redeploy, no secret in
the diff, and nothing is ever shown twice — a lost secret is recovered by issuing another one.
Prefer `db` when the sender is something your org configures itself (CI, a script, an internal
service); prefer `env` when a vendor has already handed you a value.

**A third-party vendor signs in its own scheme, and never in ours.** `source` names which
registered *verifier* authenticates this hook's deliveries. `"oe-standard-webhook"` is our own
contract — the public [standard-webhooks](https://www.standardwebhooks.com/) spec, so most
languages have a drop-in sender library — right for a sender you configure (your CI, a script,
a shim). For a hook fed by a vendor,
name the vendor instead — the delivery is then verified exactly the way that vendor signs,
with no adapter in between:

```ts
defineWebhook({
  id: "gh-deploys",
  source: "github",                            // verified as GitHub signs (X-Hub-Signature-256)
  secretRef: "GH_DEPLOYS_WEBHOOK_SECRET",       // the secret you pasted into GitHub's webhook form
  broker: "env",
  // …target + instruction as above
});
```

The scheme is **declared, never sniffed off the request**. Letting the request pick its own
verifier (by "whichever signature header is present") would hand the *sender* the choice of
which scheme authenticates them — and where two registered schemes differ in strength, that
is a downgrade the attacker gets to make. A source with no registered verifier is a
fail-closed 401 naming the schemes that *are* registered; it never falls back to another.
Verifiers ship with the provider bundle that owns the vendor, so de-selecting a bundle also
removes its scheme — its hooks stop authenticating rather than quietly using someone else's.

**Where the secret lives is your choice, and it's the same choice every other credential
gets.** `secretRef` is a *pointer* and `broker` names the one home it resolves through — the
identical pair a [connection](../security/credentials-and-planes.md) uses. `broker: "env"` +
a ref that is an env var name is the zero-wiring floor. `broker: "db"` instead resolves the
ref out of the deployment's own AES-encrypted credential store, so the secret never has to
exist in an env var (or a config diff) at all. A broker that isn't registered fails **closed**
— the hook resolves no key and its deliveries 401; it never falls back to another home.

**Rotating a hook's secret is an overlap, not a cutover.** `secretRef` also accepts an
ordered list, **current key first** — a second entry is the outgoing key, still accepted
until every sender has moved:

```ts
secretRef: ["DEPLOY_STATUS_WEBHOOK_SECRET_V2", "DEPLOY_STATUS_WEBHOOK_SECRET"],
```

Deliveries verify against each key in order, so both are live during the overlap; delete the
second entry (and its var/row) once the rotation is done. A missing *previous* ref is normal
and simply dropped. A missing *current* ref is fatal — the hook resolves no keys and 401s,
rather than quietly running on a key you believe you retired. Both refs resolve through the
hook's single `broker`: a rotation never moves custody homes mid-flight.

Point the provider at `POST /webhooks/<id>`. For `source: "oe-standard-webhook"` — our own
contract — sign each delivery with three headers:

```
webhook-id:        <a unique id for this delivery>
webhook-timestamp: <unix seconds>
webhook-signature: v1,<base64 HMAC-SHA256 over "<webhook-id>.<webhook-timestamp>.<rawBody>">
```

🔴 **The HMAC key is not always the secret's characters.** A secret that starts `whsec_` (what
we mint) is signed with the **base64-decoded** remainder; anything else is signed with its own
UTF-8 bytes. That is one total rule, not a fallback chain — get it wrong and you produce a
well-formed signature that simply never matches, i.e. a 401 that explains nothing. Off-the-shelf
`standard-webhooks` libraries handle it for you; in shell it is one extra line:

```sh
KEY=$(printf '%s' "${SECRET#whsec_}" | base64 -d | od -An -tx1 | tr -d ' \n')
SIG=$(printf '%s.%s.%s' "$ID" "$TS" "$BODY" | openssl dgst -sha256 -mac HMAC -macopt hexkey:"$KEY" -binary | base64)
curl -X POST "$URL" -H "webhook-id: $ID" -H "webhook-timestamp: $TS" \
     -H "webhook-signature: v1,$SIG" -H 'content-type: application/json' -d "$BODY"
```

Both the id and the timestamp are part of what's signed. A delivery whose timestamp is more
than **300 seconds** from ours is rejected before any HMAC is computed (five minutes is what
Slack, Stripe and Discord all use, and it is a code constant), and a `webhook-id` already accepted inside that window is refused
**409** — which is why the id must be **unique per delivery** rather than per payload. For a
vendor `source`, sign nothing yourself — the vendor already signs, and its
own scheme is what gets verified. Whatever the scheme, verification runs on the **exact bytes
received**: a reserialised JSON body produces different bytes and fails.

The security posture mirrors the GitHub path exactly, generalized from one hardcoded secret
to a per-hook one:

- **Fail-closed on every axis, never dispatch on ambiguity.** An unknown hook id 404s. A
  source with no registered verifier, a secret that doesn't resolve (unset ref, unregistered
  broker), a missing signature header, a stale or missing timestamp, or a signature that
  doesn't match all reject 401. An oversized payload rejects 413 before the body is even
  hashed. A verifier that *throws* is treated as a rejection, not a 500. There is no
  accept-by-default path.
- **The payload is untrusted, always.** Whoever can reach the URL and forge (or replay) a
  valid signature controls the bytes inside it — so the fired turn never sees the payload as
  instructions. It's wrapped in the same untrusted-content envelope the Slack surface uses
  for backscroll and thread context, with a judged reply: the turn may answer, or output the
  silence sentinel and post nothing, exactly like a name-drop wake.
- **The instruction's provenance is structural.** The fired turn opens with a host `<wake>`
  envelope (`reason="spawn"`) that holds no `<message>`, because a fire has no triggering
  message. The hook's declared `instruction` and the judged-reply rule ride that envelope as a
  trusted `<system-note>`. The payload follows after `</wake>`, inside its own untrusted fence.
  The note is XML-escaped, so a payload cannot forge a second note or close the envelope. A
  plain-text sentence that only *claimed* the instruction was reviewed config did not hold: a
  stronger model read the claim as unverified and refused the instruction.
- **The same fire gates a routine fire rides.** A webhook fire is proactive, no-human-in-the-
  loop work, so it clears the identical bars: the spend gate (an over-budget target declines
  before any session starts), surface-attribute stamping (so partition/domain resolution
  lands on the hook's real channel), and a live trust recheck (fail-closed — a target that
  later goes externally-shared loses shared memory / domain skills on its next fire).
- **A hook will not fire into an externally-shared room at all.** Before any of that, the fire
  asks the target channel's live *audience floor* the same question an unattended event fire
  asks: may this room hear org-external, trigger-sourced content? If the platform positively
  reports the channel externally shared — Slack Connect, org-shared, or carrying an observed
  guest — the delivery is **declined**, with the reason in its `webhook.declined` audit row.
  A hook can fire arbitrary payload content chosen by whoever holds its secret, so pointing one
  at a room outside the org is not something a valid signature should be able to buy. The floor
  is asked on **every** delivery, whatever the hook's `posture` — it is a question about the
  *room*, not about the payload, and a `trigger-only` hook still wakes an unattended turn with
  that channel's full access. The
  check reads the **target**, never the payload — so it needs no understanding of the sender's
  format. It is deliberately *inert* when the platform cannot answer (a failed membership
  lookup, a non-shared channel with more than one page of members, or a deployment with no Slack
  provider): a delivery is acknowledged and fired in the background, so refusing on "we could
  not ask" would silently drop a notification the sender believes it delivered. Move the hook
  to an internal channel — or remove the external members — and it resumes by itself. Discord
  and Teams cannot report a roster at all, so there the stranger-room floor above refuses instead.
- **A dev escape hatch exists, scoped to unset-secret only.** The `webhooks.allowUnverified`
  setting accepts a delivery with no configured secret (local dev); it never bypasses signature
  verification once a secret **is** set, and it never waives *verifier resolution* — "I have
  no secret on my laptop" is a dev inconvenience, "this deployment cannot verify that scheme
  at all" is a misconfiguration that must not be dispatchable. It applies to **`env`-homed hooks
  only**: a `broker: "db"` hook's secret is minted by this deployment, so "the secret isn't set
  here" cannot describe one — an unresolvable key there means nobody issued it or the vault read
  failed, and the delivery is a plain 401 whatever the variable says. When the hatch *does* accept a
  delivery, the fire's audit row carries `unverified: true` — nothing authenticated that
  sender but the URL, and the log says so rather than looking like any other accepted fire.
- **Accepted deliveries are always audited; rejections are audited but throttled.** Every
  fire — and every declined fire, whether for budget, for the audience floor or for a target that
  did not resolve — writes a row. Rejections would otherwise be an
  audit-write amplifier on a public endpoint, so they collapse to roughly one row per
  identity per minute: per hook *and* status for a configured hook, and onto a single
  constant key for unknown ids, so a scanner varying the path can't mint a row per request.
  The next row that *is* emitted carries a `suppressed` count, and the probed id still rides
  in the row's detail (length-capped). Probing for valid hook ids stays visible after the
  fact without letting the prober choose how much gets written.

### Two keys arm a hook, and neither one alone

**Merging a hook does not turn it on.** A declaration with no provisioned secret is inert —
every delivery to it 401s — and an id with no declaration 404s. Arming a webhook therefore
takes two humans with different powers: whoever reviews and merges the diff, and whoever can
write to the hook's `broker` (the env store, or the deployment's encrypted credential
vault). This is the general [config-as-code](../how-it-works/config-as-code.md#two-keys-and-two-different-humans)
property, and this surface is its sharpest case because the URL is public and
unauthenticated by construction. It is also why `webhooks.allowUnverified` belongs
nowhere but a laptop: it collapses the second key.

A `broker: "db"` hook reaches the same place by a slightly different route: the two keys become
*the merged diff that declared the hook* and *the human who approved the card and received the
secret* — still two decisions, still two different powers, and the secret is still in neither a diff
nor a chat message.

### What this surface does *not* defend

- **Replay — for every source whose vendor does not sign a timestamp.** Replay defence is a
  property of the *scheme*, and the schemes differ:
  - Our own **`oe-standard-webhook`** signs a timestamp, so a delivery more than 300 seconds old is
    rejected before its HMAC is even computed — and inside that window the exact delivery
    that was accepted is remembered, so presenting it a second time is refused **409**. That
    is genuine **single-use**: the nonce is stored durably (it survives a restart and holds
    across instances), keyed per hook, and retained long enough to outlive the whole span in
    which the signature stays valid.
  - A **vendor** source is only as good as the vendor's own scheme, and vendors differ from each
    other — so this is a per-source fact, not a blanket one. `github` and `notion` both sign the
    body and **nothing else**. With no signed timestamp there is no freshness claim to bound a
    nonce against, so a captured, validly-signed delivery on those sources **replays
    indefinitely** — the verifier declares this (`signedTimestamp: false`) rather than leaving it
    unwritten, and the 409 above never applies. `slack`, by contrast, signs its timestamp
    (`v0:<timestamp>:<body>`), so a hook on it *does* get the single-use 409. Which side of the
    line a source falls on is its verifier's declared `signedTimestamp`, and the honest answer for
    any given deployment is whatever its registered verifiers say — not a list written here.

  **A second, weaker guard exists, and the distinction between it and single-use is the whole
  point.** Deliveries carrying the vendor's own delivery id (GitHub's `X-GitHub-Delivery`) are
  de-duplicated for 10 minutes on that id — on the GitHub event ingress *and* on declared hooks,
  which normalise through the same routing plane. It is TTL-bounded, it
  engages only when the sender supplied an id, and it deliberately fails **open** if its store
  is unreachable, because its job is to prevent a double notification rather than to stop an
  attacker. That is also exactly why the vendor's delivery id was **rejected as a substitute
  for single-use**: the id rides inside the same captured request as the signature, so whoever
  holds one holds the other. Counting this guard as a replay defence would be counting a
  control that fails open in precisely the conditions an attacker would choose.

  Treat a hook's payload as at-least-once, prefer instructions whose effect is idempotent,
  and rotate the secret (an overlap, above) if a delivery could have been captured in
  transit.

  **Which class a hook falls into depends on the contract you connect, and that is a decision
  rather than an accident.** `github` — the vendor source you are most likely to reach for on a
  stock deployment — signs the body and nothing else, so a hook on it gets the best-effort bound
  and not the signed one.

  **`oe-standard-webhook` is the one to reach for when the sender is yours.** It is a contract
  *we* define and your sender implements — the [Standard Webhooks](https://github.com/standard-webhooks/standard-webhooks)
  spec: `webhook-id`, `webhook-timestamp` and `webhook-signature` headers over a
  `<id>.<timestamp>.<body>` basestring. Because it signs a timestamp *and* a message id, a hook
  on it gets **both** guards — the durable single-use **409** described above, keyed on the
  signed message id, and the TTL-bounded delivery dedupe. It is the only source that is
  *chat-creatable* **and** genuinely replay-defended rather than merely deduped.
  Reach for it whenever the sender is something you control or can script; you only need a
  vendor source when the vendor is the one doing the sending.

  The weaker posture is acceptable *where it still applies* because those deliveries are
  notifications: an emit-only hook carries no target and no instruction of its own, so under a
  `trigger-only` posture a replayed delivery buys nothing but a second run of a prompt a human
  already approved. It stops being acceptable the moment a *vendor* source is
  admitted whose fires do something consequential — spend, write, or grant — and that is the
  trigger to revisit it, not the passage of time.
- **Any reduction of the target channel's capability.** Each fire posts into the target
  without a thread anchor, so the runtime mints a fresh session per delivery: the turn has no
  memory of the previous fire and does not join the channel's mention session. The stamped
  principal is `principalType: "service"` with `principalId: "webhook:<id>"` — which is what
  the audit log attributes the fire to, and nothing more. **Nothing in access resolution
  reads `principalType`**, so "service" buys no narrowing: the fired turn resolves exactly
  the grants the target channel already has, less whatever the live trust recheck declines to
  stamp. What a hook fire *cannot* do is act as a person: its auth carries the
  unattended-origin marker, so it has no acting principal, and every presence-gated verb
  refuses it — it cannot author, edit, cancel or re-arm routines, create or delete domain
  skills, move spend caps, cut or restore connectors, declare or rotate webhooks, or open
  access-request PRs, and no approval card is ever minted in anyone's name from a hook fire.
  A hook is a standing, unattended, human-authored prompt running with its channel's
  full read/reply capability — so point one at the channel that actually wants the
  notification, and hold its secret with the weight of that channel's access.

See [Configuration reference](../deploy/configuration-reference.md#webhook-trigger) for the
full field list and env vars.

### Getting a webhook's signing secret without a redeploy

Everything above describes a hook **declared in config** — which is now the only way a hook
exists. Declaring one no longer means hand-editing a file: ask the agent and `declare_webhook`
opens the pull request. What *is* still a runtime act, and needs to be, is putting a value
behind the hook's `secretRef`.

**Under `broker: "env"` the value is an environment variable**, so an operator sets it and the
deployment restarts before the hook can authenticate anything. That is fine when a vendor already
handed you a secret. It is poor when the sender is yours to configure, because the team that asked
for the hook usually does not own the redeploy.

**Under `broker: "db"` the value lives here instead.** The declaration carries only the ref, and
after the PR merges someone asks the agent to rotate that webhook. That posts an approval card; a
member reads it and approves; and only then does the deployment mint a fresh signing secret, store
it encrypted, and hand **the person who asked** — not the approver — a **private, one-time link** to
read it. Paste it into the
sender and the endpoint starts authenticating. No redeploy, and no secret in the diff, in chat or
in any log.

Use `list_webhooks` to see what is declared and `rotate_webhook` to issue or re-issue a secret.
There is no `revoke_webhook`: a hook is removed the way it was created, by a pull request.

**The secret is never shown in chat, and never shown twice.** It exists on one page, behind one
single-use link that expires in fifteen minutes. Nothing — no admin, no tool, no support request —
can display it again, because a mechanism that could would be indistinguishable in the audit log
from an attacker extracting a live production secret. Lost it? Issue another one. That costs the
same work (paste a new value into the sender) and invalidates the old one.

**Whether the old key keeps working is the declaration's choice, not a timer.** A hook whose
`secretRef` lists a second entry has a rotation overlap: the outgoing value moves there and both are
accepted until a PR removes the entry. A hook with one ref has no overlap, and the outcome line says
so plainly rather than promising a grace period it does not have.

**Two surface requirements, both fail-closed.** The agent will only issue a secret where it can post
an approval card *and* send one person a private message — Slack today. On any other surface it
refuses up front rather than minting a value it has no safe way to hand over. A deployment also
needs a public base URL and a page signing key configured, or the one-time link cannot be served and
nothing is minted.

Issuing a secret is never available to an unattended job: there would be nobody present to read the
card or receive the value.

### Two kinds of sender, and the second one needs no adapter

A *vendor* system — GitHub, Notion — signs in its own scheme and interprets its own payload, so
connecting it needs an adapter someone merged; you name the vendor as the `source` and that is both
the handle and the contract. Anything **you** control or can script — a CI job, a build box, an
internal service — needs nothing merged at all: name `oe-standard-webhook` as the `source` and the
sender implements *our* contract instead. That is the
[Standard Webhooks](https://github.com/standard-webhooks/standard-webhooks) signing scheme plus a
four-field JSON envelope (`event`, optional `action`, an optional flat `fields` bag of whatever your
routines need to match on, and an optional `occurredAt`); unknown fields are ignored, so a sender can
grow its payload without breaking anything. A shell script can produce it:

```sh
BODY='{"event":"build","action":"failed","fields":{"status":"failed","branch":"main"}}'
ID=$(uuidgen); TS=$(date +%s)
KEY=$(printf '%s' "${SECRET#whsec_}" | base64 -d | od -An -tx1 | tr -d ' \n')
SIG=$(printf '%s.%s.%s' "$ID" "$TS" "$BODY" | openssl dgst -sha256 -mac HMAC -macopt hexkey:"$KEY" -binary | base64)
curl -X POST "$URL" -H "webhook-id: $ID" -H "webhook-timestamp: $TS" \
     -H "webhook-signature: v1,$SIG" -H 'content-type: application/json' -d "$BODY"
```

Several such senders can coexist — one contract, many hooks, each with its own id, its own secret
and its own routines. Your routines subscribe to the hook's **id**, never to the contract, so two
senders never fire each other's work.

**Choose the posture deliberately.** Posture is one axis — *how much of an outside party's bytes
reach the model* — with three points on it:

- **`trigger-only`** — the payload is discarded. A delivery can only cause a routine you
  already approved to run. If the secret ever leaked, that is all it buys.
- **`projection`** — only the fields you name reach the prompt. Everything else the sender
  wrote is dropped, along with the entity pointer, so nothing is refetched either. This is
  the right answer whenever the instruction needs *two fields*, not the whole body.
- **`content-bearing`** — the entire payload enters the prompt as untrusted data, on every
  delivery, indefinitely. Worth the extra exposure only when the agent genuinely has to read
  everything that was sent.

Posture is the honest answer to *"why is a cron fine without a webhook's ceremony?"* It is not the
ingress: a cron's prompt and a webhook's prompt are both member-authored, in-channel and fixed. The
difference is that a content-bearing hook's **payload** is written by someone outside your org,
every time it fires, forever. Any fire that puts payload bytes in a prompt — **`content-bearing`
*and* `projection`** — is therefore treated as **tainted**: the turn is marked, the mark reaches
approval disclosure and every `taint: "gate"` sink, and native delegation withdraws for that
turn. A fire is also **unattended**, so at those sinks the taint floor's `ask` becomes a deny — a
hostile payload can never arm a routine, a skill, a resident agent, a standing rule or a webhook,
whoever wrote it. A projection bounds how *much* of an outside party's text arrives, never how much
it is trusted. A `trigger-only` fire carries no such bytes and is not tainted.

**Taint does not gate memory.** A memory write is an ordinary file edit with no write verb to
mark. It is the routine and skill verbs that carry the floor, and they carry it because of what they
produce: text a later unwitnessed run reads as instruction. A tainted fire is therefore not "exactly as if a person had pasted that
text into the channel" — a human-authored chat message is trusted content and marks nothing;
taint only exists because this payload did not come from a person in the room.

**Which systems you can connect is a config decision, not a per-webhook one.** A source is
available once this deployment can both authenticate it (a signature verifier) and route it
(an event normalizer) — usually just a matter of the provider bundle being selected. Within
that set, declaring the tenth hook is as friction-free as the first. Outside it, no review can
help: there would be nothing to verify deliveries with, so the agent refuses and names what it
*would* need. That is where an admin's judgement actually belongs — approving the class of system,
once, in a diff.

### The event inventory — what each vendor can send, and how far we carry it

The table below is not a wish list and it is not hand-written. Every provider bundle **declares**
the vendor events it has reviewed, and `npm run lint:provider-events` checks each declaration
against the code that would route it. A bundle that declares nothing fails the gate; a row that
promises a field a routine could filter on fails until the normalizer really carries that field.

**The rows are reviewed, not exhaustive.** Every vendor here publishes a longer index than the table
shows — GitHub alone has dozens. A row lands when somebody read that event and decided what a
routine could do with it, so an **absent** event means "nobody has reviewed it here", never "the
vendor does not send it". Each block links the vendor's own index; ask for an event you need and it
becomes a row.

Read the **Routing** column as three answers, not two:

- **✅ mapped** — a normalizer reads this event's own subject. You can address the thing that
  happened, not only the container it happened in.
- **➖ envelope only** — the delivery fires routines, but nothing of its own subject is readable.
  You can match the source, the event name and the container; you cannot match what changed.
- **❌ not routed** — nothing wakes on it today. Either the bundle registers no normalizer, or the
  one it registers hands this event to a different leg (a comment is the ambient supervisor's, not a
  routine's).

The **Addressable** column names exactly what a `jq` filter can reach beyond the envelope every
delivery from that source already carries. `scope \`entity\`` is a step in the
[scope path](#event-filters-are-jq); a bare `` `key` `` is a `.fields` key.

<!-- BEGIN GENERATED: provider-event-inventory (scripts/provider-events.ts) -->

**github** — source `github` · [vendor event index](https://docs.github.com/en/webhooks/webhook-events-and-payloads)

| Vendor event | Routing | Addressable | What it is |
|---|---|---|---|
| `issues` | ✅ mapped | scope `entity` | an issue was opened, closed, labelled, assigned…; the entity step is the issue number, so the fire re-fetches the issue itself |
| `issue_comment` | ✅ mapped | scope `entity`, scope `sub` | a comment on an issue or on a pull request's timeline; the sub step is the comment id |
| `pull_request` | ✅ mapped | scope `entity` | a pull request was opened, synchronised, merged…; the entity step is the pull-request number |
| `pull_request_review` | ✅ mapped | scope `entity` | a review was submitted, edited or dismissed; the review itself is not addressable — the payload names it `review`, not `comment` |
| `pull_request_review_comment` | ✅ mapped | scope `entity`, scope `sub` | an inline comment on a line of a pull request's diff; the sub step is the comment id |
| `push` | ➖ envelope only | — | commits were pushed to a ref; a push has no entity to fetch, and the ref is not mapped — a routine can match the repo and the sender only |
| `check_run` | ✅ mapped | scope `entity` | one check's state changed; the entity step is GitHub's opaque run id, so it narrows a subscription but is not re-fetchable |
| `check_suite` | ➖ envelope only | — | a whole suite of checks completed; unmapped — the payload's subject sits under `check_suite`, which the normalizer's subject chain does not name |
| `workflow_run` | ✅ mapped | scope `entity`, `branch`, `status`, `conclusion`, `workflow` | an Actions run started or finished; the four keys are what makes `a red build on our main` expressible — `.scope.container == "acme/web" and .fields.conclusion == "failure" and .fields.branch == "main"`. The container clause is REQUIRED, not decoration: a github subscription that narrows by nothing is refused at create time |
| `workflow_job` | ➖ envelope only | — | one job inside an Actions run changed state; unmapped — `workflow_run` is the run-level event and carries the same conclusion for the whole run |
| `release` | ✅ mapped | scope `entity` | a release was published or edited; the entity step is GitHub's opaque release id, so it narrows a subscription but is not re-fetchable |
| `installation` | ❌ not routed | — | the App was installed, suspended or removed; the normalizer accepts it, but the payload names `repositories` and never `repository`, so it proves NO container step and the read-grant check refuses every delivery fail-closed — nothing can ever fire. The self-registering install leg reads it instead |

**linear** — source `linear` · [vendor event index](https://linear.app/developers/webhooks)

| Vendor event | Routing | Addressable | What it is |
|---|---|---|---|
| `Issue` | ✅ mapped | scope `group`, scope `container`, scope `entity`, `team`, `project`, `issue` | an issue was created, updated or removed — the one routable Linear type; the container step is the issue's project and appears only when it has one |
| `Comment` | ❌ not routed | — | a comment on an issue; declined by the normalizer on purpose — a comment is CONVERSATION and the ambient supervisor answers it, so routing it would wake a seat twice for one event |
| `Reaction` | ❌ not routed | — | an emoji reaction on a comment; unrecognised by the normalizer — the reaction-feedback plane reads reactions, not a routine |
| `IssueLabel` | ❌ not routed | — | a label was created, renamed or deleted in the workspace; unrecognised — a label CHANGE on an issue arrives as an `Issue` update, which is routable |
| `Project` | ❌ not routed | — | a project was created, updated or removed; unrecognised — a routine that wants project movement watches the `Issue` events inside it today |
| `Cycle` | ❌ not routed | — | a cycle was created, updated or removed; unrecognised — no normalizer arm reads it |
| `AgentSessionEvent` | ❌ not routed | — | Linear's own agent-session protocol; classified `agent-session` and handled by the session leg, never by the routine plane |

**notion** — source `notion` · [vendor event index](https://developers.notion.com/reference/webhooks-events-delivery)

| Vendor event | Routing | Addressable | What it is |
|---|---|---|---|
| `page.created` | ✅ mapped | scope `group`, scope `container`, scope `entity`, `parent`, `entity` | a page was added; the container step is its parent database, data source or page |
| `page.properties_updated` | ✅ mapped | scope `group`, scope `container`, scope `entity`, `parent`, `entity` | a page's property values changed — a status field moving is this event, not a content edit |
| `page.content_updated` | ✅ mapped | scope `group`, scope `container`, scope `entity`, scope `sub`, `parent`, `entity` | a page's blocks changed; the sub step is the block, and only when the delivery names exactly one |
| `page.moved` | ✅ mapped | scope `group`, scope `container`, scope `entity`, `parent`, `entity` | a page was moved to a different parent; the container step is the NEW parent |
| `page.deleted` | ✅ mapped | scope `group`, scope `container`, scope `entity`, `parent`, `entity` | a page was sent to trash — the terminal event a scope path can carry and a fetch cannot |
| `page.undeleted` | ✅ mapped | scope `group`, scope `container`, scope `entity`, `parent`, `entity` | a page was restored from trash |
| `page.locked` | ✅ mapped | scope `group`, scope `container`, scope `entity`, `parent`, `entity` | a page was locked against edits |
| `page.unlocked` | ✅ mapped | scope `group`, scope `container`, scope `entity`, `parent`, `entity` | a page was unlocked |
| `database.created` | ✅ mapped | scope `group`, scope `container`, scope `entity`, `parent`, `entity` | a database was added; the group step is the teamspace, when the parent is one |
| `database.content_updated` | ✅ mapped | scope `group`, scope `container`, scope `entity`, `parent`, `entity` | rows were added to or removed from a database |
| `database.schema_updated` | ✅ mapped | scope `group`, scope `container`, scope `entity`, `parent`, `entity` | a database's property schema changed — the event that breaks a routine reading a column by name |
| `database.moved` | ✅ mapped | scope `group`, scope `container`, scope `entity`, `parent`, `entity` | a database was moved to a different parent |
| `database.deleted` | ✅ mapped | scope `group`, scope `container`, scope `entity`, `parent`, `entity` | a database was sent to trash |
| `database.undeleted` | ✅ mapped | scope `group`, scope `container`, scope `entity`, `parent`, `entity` | a database was restored from trash |
| `data_source.created` | ✅ mapped | scope `group`, scope `container`, scope `entity`, `parent`, `entity` | the 2025-09-03 spelling of a database creation, delivered beside the older `database.` family |
| `data_source.content_updated` | ✅ mapped | scope `group`, scope `container`, scope `entity`, `parent`, `entity` | rows were added to or removed from a data source |
| `data_source.schema_updated` | ✅ mapped | scope `group`, scope `container`, scope `entity`, `parent`, `entity` | a data source's property schema changed |
| `data_source.moved` | ✅ mapped | scope `group`, scope `container`, scope `entity`, `parent`, `entity` | a data source was moved to a different parent |
| `data_source.deleted` | ✅ mapped | scope `group`, scope `container`, scope `entity`, `parent`, `entity` | a data source was sent to trash |
| `data_source.undeleted` | ✅ mapped | scope `group`, scope `container`, scope `entity`, `parent`, `entity` | a data source was restored from trash |
| `comment.created` | ❌ not routed | — | a comment was added; declined by the normalizer on purpose — a comment is CONVERSATION and the ambient supervisor answers it, so routing it would wake a seat twice for one event |
| `comment.updated` | ❌ not routed | — | a comment was edited; declined with the whole `comment.` family |
| `comment.deleted` | ❌ not routed | — | a comment was removed; declined with the whole `comment.` family |

**slack** — no event normalizer · [vendor event index](https://docs.slack.dev/reference/events)

| Vendor event | Routing | Addressable | What it is |
|---|---|---|---|
| `message` | ❌ not routed | — | a message was posted in a channel; the ambient supervisor already judges these, so a routine on it would wake a seat twice |
| `app_mention` | ❌ not routed | — | the app was @mentioned; the mention leg owns it and wakes a full turn already |
| `reaction_added` | ❌ not routed | — | somebody reacted to a message; the reaction-feedback plane reads it, and a routine could not tell its own ack glyphs from a person's |
| `reaction_removed` | ❌ not routed | — | a reaction was taken off a message; unwired for the same reason as `reaction_added` |
| `channel_created` | ❌ not routed | — | a channel was created — the clearest candidate for a routine trigger here, and nothing routes it today |
| `member_joined_channel` | ❌ not routed | — | somebody joined a channel; unwired — an onboarding routine would want this one |
| `team_join` | ❌ not routed | — | a new member joined the workspace; unwired |
| `file_shared` | ❌ not routed | — | a file was shared; unwired — the attachment plane reads files on a turn it was already woken for |
| `app_home_opened` | ❌ not routed | — | a person opened the app's Home tab; the front route publishes their memory page (OPE-2451), and it is no routine trigger — it fires on a view, not on work |

**discord** — no event normalizer · [vendor event index](https://discord.com/developers/docs/events/gateway-events)

| Vendor event | Routing | Addressable | What it is |
|---|---|---|---|
| `MESSAGE_CREATE` | ❌ not routed | — | a message was sent in a channel; the bundle's own gateway transport reads it for the mention and ambient legs, never the routine plane |
| `MESSAGE_UPDATE` | ❌ not routed | — | a message was edited; unwired |
| `MESSAGE_DELETE` | ❌ not routed | — | a message was deleted; unwired |
| `MESSAGE_REACTION_ADD` | ❌ not routed | — | somebody reacted to a message; the reaction-feedback plane reads it, and a routine could not tell its own ack glyphs from a person's |
| `MESSAGE_REACTION_REMOVE` | ❌ not routed | — | a reaction was taken off a message; unwired for the same reason as `MESSAGE_REACTION_ADD` |
| `THREAD_CREATE` | ❌ not routed | — | a thread was started; unwired — a candidate trigger, since a new thread is work appearing rather than chatter |
| `GUILD_MEMBER_ADD` | ❌ not routed | — | somebody joined the guild; unwired — an onboarding routine would want this one |
| `INTERACTION_CREATE` | ❌ not routed | — | a slash command or component interaction; unwired, and a poor routine trigger — an interaction owes Discord a reply within three seconds, which a fired seat cannot promise |

**teams** — no event normalizer · [vendor event index](https://learn.microsoft.com/en-us/graph/teams-changenotifications-chatmessage)

| Vendor event | Routing | Addressable | What it is |
|---|---|---|---|
| `/teams/{team-id}/channels/{channel-id}/messages` | ❌ not routed | — | messages and replies in ONE channel; changeType `created,updated`. The narrowest Teams subscription there is, and the one a per-channel routine would want |
| `/chats/{chat-id}/messages` | ❌ not routed | — | messages in ONE chat; changeType `created,updated` |
| `/teams/getAllMessages` | ❌ not routed | — | every channel message in the TENANT; changeType `created,updated`. Tenant-wide, so it needs the `ChannelMessage.Read.All` application permission |
| `/chats/getAllMessages` | ❌ not routed | — | every chat message in the TENANT; changeType `created,updated,deleted`. Needs `Chat.Read.All` |
| `/users/{user-id}/chats/getAllMessages` | ❌ not routed | — | every chat message one user takes part in; changeType `created,updated,deleted` |
| `/appCatalogs/teamsApps/{teams-app-id}/installedToChats/getAllMessages` | ❌ not routed | — | every chat message where a named Teams app is installed; changeType `created,updated`. The narrowest tenant-wide shape — it follows the app rather than the tenant |

**email** — no event normalizer · [vendor event index](https://docs.agentmail.to/api-reference/webhooks/events/message-received)

| Vendor event | Routing | Addressable | What it is |
|---|---|---|---|
| `message.received` | ❌ not routed | — | an inbound mail the vendor accepted — the email front's conversation leg, through the gate, never a routine |
| `message.received.unauthenticated` | ❌ not routed | — | an inbound mail that arrived without authentication headers, so the vendor could not check it — refused by the gate (`unauthenticated`) |
| `message.received.spam` | ❌ not routed | — | an inbound mail the vendor flagged as spam — refused by the gate (`flagged`) |
| `message.received.blocked` | ❌ not routed | — | an inbound mail the vendor blocked — refused by the gate (`flagged`) |

**google-chat** — no event normalizer · [vendor event index](https://developers.google.com/workspace/chat/receive-respond-interactions)

| Vendor event | Routing | Addressable | What it is |
|---|---|---|---|
| `MESSAGE` | ❌ not routed | — | an @mention in a space or a direct message — the front's conversation leg, through the gate, never a routine |
| `ADDED_TO_SPACE` | ❌ not routed | — | the app was added to a space — acknowledged and dropped; a space wakes nothing until a domain's `reach` lists it |
| `REMOVED_FROM_SPACE` | ❌ not routed | — | the app was removed from a space — acknowledged and dropped |
| `CARD_CLICKED` | ❌ not routed | — | a card button tap — acknowledged and dropped; the surface posts no card yet |

<!-- END GENERATED: provider-event-inventory -->

**A ❌ row is a proposal, not a defect.** Wiring one means writing a normalizer for that source and
answering how its deliveries are verified — which for a gateway socket or an encrypted Graph
notification is a question about the door, not about the payload. The inventory exists so that
choice is made from a list rather than from memory.

## The schedule arithmetic

`computeNextRun` (`packages/core/agent/routines/schedule.ts`) answers the next run instant for a
trigger, and **an `event` or `once` trigger always answers `null`** — neither has a next run. A `cron`
trigger steps from the later of "now" and the due anchor. An `interval` trigger steps the same way from
its own anchor. A `watch` trigger takes whichever of the two it declares.

**Cron search is a scan, not algebra.** `nextCronAfter` walks forward minute by minute from the next
whole minute, for **367 days**, and returns `null` when nothing matched. A `null` there means "this
expression never fires", so a routine with an impossible expression stops rather than looping.

**Day-of-month and day-of-week follow Vixie semantics.** `cronMatches` requires the minute, hour and
month to match. It then checks the two day fields: when **both** are restricted, **either** matching
fires; when one is `*`, both must match. Every field is evaluated in **UTC**.

`isDue` answers `false` for a routine whose `nextRunAt` is `null`, absent, or unparseable. An
unparseable stamp therefore never fires, rather than firing on every tick.

## One dispatcher tick

`dispatchTick` (`packages/core/agent/schedules/dispatch.ts`) reads every routine once. A store read
that fails **skips the whole tick** rather than firing a partial set. It then keeps the active,
clock-scheduled, due routines and **sorts them most-overdue-first**, so a newer routine can never
starve an older one.

**At most three routine root sessions start per tick** (`routines.maxConcurrency`, shipped `3`). The
overflow stays due — its `nextRunAt` is untouched — so it fires on a later tick, and it is not audited
as a skip, because nothing decided against it.

### The creator must still be there

`checkFireEligibility` (`routines/fire-eligibility.ts`) re-checks the routine's creator before the
fire. A creator **removed from the room** answers `creator_removed_from_room`, and a **deactivated
account** answers `creator_account_inactive`. Either one **skips** the fire. A skip is not a failure,
so it never counts toward the consecutive-failure strike that would auto-disable the routine.

Every check is fail-soft in the same direction: a routine with no recorded creator, a fire with no
room id, and a check that throws all answer **eligible**. On Teams, missing team or creator ids answer
eligible with the reason `missing_ids` recorded, so an unresolved membership is visible rather than
silently treated as a removal.

`recheckFireCreator` (`routines/fire-creator.ts`) is the **DM** leg. Every DM fire re-verifies the
creator's internal standing live. It answers `undefined` for a routine with no creator, for a
non-DM fire and for a non-Slack platform — no other surface carries a membership-verification gate —
and an unverifiable answer binds the fire as **external**.

### Where a fire posts back

`resolveRoutineTarget` (`packages/core/agent/schedules/routine-dispatch.ts`) resolves the post-back
target from the routine's own report destination. **An unwired platform resolves `null`**, and the
fire then dry-runs: nothing is posted and the schedule does not advance.

`canDispatchRoutinesOn` is the create-time half. Creation **refuses** a routine on a platform with no
registered post-back resolver, so a routine that could only ever dry-run is never armed.

### The test fire

`dispatchTestRuns` (`packages/core/agent/schedules/routine-test-run.ts`) runs first in every tick. It
takes each routine whose row carries a `testRun` request, claims it with a compare-and-set on the
test id (so two overlapping ticks cannot both start it), clears the request on the live row, and
meets the same halt, creator check, live trust recheck and spend gate a real fire meets. Before all of
them, it refuses the test when the test-run hook is not mounted (`fence-unmounted`, OPE-2546). The
hook module calls `noteTestRunFenceMounted` (`routines/test-run.ts`) when it loads. eve's compiled
module map loads every mounted module before any handler runs, so the mark is set in every process of a
deployment that mounts the hook, and in none of a deployment that excludes it. `testRunRefusal` reads
the same mark, so `test_routine` and the create and edit offer refuse too. It then runs `runPreFire`,
posts the opening post, and sends the fire NATIVE, anchored on that post. It never takes the window
divert, because a test needs a session that is a test from its first turn to its last.

**The anchor, per surface (OPE-2540).** A `RoutineTestRunArm` (`schedules/routine-dispatch.ts`) has two
edges: `post` (a host post in the routine's room, at the top level or beside the anchor) and `target`
(the receive target for a fire anchored on a post). An optional third member follows (OPE-2568):
`attributes`, the host-set bag stamp that tells the turn's `reply` where the anchor is. A
[durable job](#durable-jobs-persistent-multi-step-work) anchors through the same arm. Core's Slack arm is inline in
`schedules/routine-test-run.ts`: the target is the thread. A bundle registers its arm on its routine
dispatcher (`registerRoutineDispatch(…, { testRun })`), and `registerRoutineDispatch` notes the
platform for `testRunRefusal`.

- **Discord** (`provider-discord/agent/channels/discord-dispatch-target.ts`): the target is
  `{ channelId, conversationId: <opening post id> }`. eve keys a Discord session on
  `(channel, conversation)`, so the test has its own session in the routine's channel.
- **Teams** (`provider-teams/agent/channels/teams-test-run.ts`): the arm posts the opening activity
  itself, to the conversation id without its `;messageid=` suffix, and the target is the routine's
  reference with `replyToActivityId: <opening activity id>`. eve keys a Teams session on
  `(tenant, conversation, reply id)`. eve's own `initialMessage` root keeps no reply id in a 1:1 chat,
  so a 1:1 test fired through it would continue the person's own chat session.

Only the delivery changes, plus one stamp. The bag stays the routine's own bag, so the test binds to
the routine's surface, memory and spend grain. A fired turn's closing prose is dropped, so the run's
answer is the `reply` it makes, and `reply` posts where the turn's binding says. The binding is built
from the bag, not from the receive target, so the arm's `attributes` add the anchor to the bag. On
Slack the stamp is `thread_ts`. On Teams it is `reply_to_activity_id`
(`provider-teams/agent/channels/teams-identity.ts` `TEAMS_REPLY_TO_ATTR`): `bindTeams` carries it to the
binding's target as `replyToActivityId`, and the Teams post arm's `resolveTarget` replies to that
activity in the conversation the opening post went to (OPE-2568). Only the host sets it, and an inbound
activity never carries it. Discord declares no stamp: its `reply` goes to the routine's own channel,
after the opening post, and the host summary is a Discord reply to the opening post.

**An event routine's replay (OPE-2540).** The event fan-out (`routines/ingress.ts`) keeps the matched
event on the row as `lastEvent` (`captureReplayEvent`, `routines/match-stamp.ts`), after the read grant
passes and before every other reason not to fire. It is coalesced to one write a minute per routine,
and an event larger than `REPLAY_EVENT_MAX_CHARS` is not kept. The kept event carries the `readableBy`
and the posture its config hook had when it arrived. So the test first re-resolves that hook from
config (`findWebhook`): a hook that is gone refuses (`grant-refused`), a posture that now redacts or
projects more than the kept event refuses (`posture-changed`), and the grant check runs on the hook's
LIVE `readableBy`. A vendor event (no declared grant) is checked by its source's grant adapter, which
reads live config already. The test then checks `checkEventReadGrant` and `checkFireDisclosure`, after
the halt and before the creator check, and re-reads the event's
entity with `hydratePointer` (a refused read stops the test). It renders the message with
`eventPrompt`, the event plane's one prompt builder, and stamps the taint signal as the event fan-out
does. A filter that no longer matches the kept event is told in the opening post, not obeyed.

The bag is the real fire bag from `routineFireAttributes`, plus `thread_ts` on Slack and three host-set
stamps: `open_everywhere_routine_test` (the test id), `open_everywhere_routine_test_by` (the asker) and
`open_everywhere_routine_test_anchor` (the opening post's id). The stamps drive four things:

- `hooks/routine-test-run.ts` marks the session at `turn.started`. The mark is sticky, so a later reply
  in the test thread stays fenced. A mark that cannot be written cancels the turn.
- `access/test-run-fence.ts` runs at the toolset projection before every model call. It replaces
  `execute` on every tool outside `TEST_RUN_OPEN_TOOLS` (`routines/test-run.ts`) with a stub that
  writes a `routine.test_blocked` row and throws. The list is default-deny: a tool it does not name is
  blocked. `connection_execute` is decided per call, by the tier of the operation it names, and a
  reserved `grant__…` name is always blocked. A blocked tool with no `execute` (a workflow tool) is
  removed from the toolset.
- The connector fence (`connections/connector-auth.ts`) refuses a connector write or delete from a
  test fire before a declared permission can lift it or a permission card can post.
- `hooks/routine-outcome.ts` folds no outcome for a test fire, and `spend/checkpoint.ts` records no
  stall for one.

At the end of the root turn, the hook reads the test's `routine.test_blocked` rows and posts the
summary beside the opening post: into the thread on Slack, and through the bundle's arm, anchored on
`open_everywhere_routine_test_anchor`, on every other surface. A compare-and-set on the test id makes it once per test, across a redelivered
turn end too. The root session also counts the calls it blocked. When that count is larger than the
rows read back, the summary says how many could not be listed.

## Pre-fire collection and the gate, in order

`runPreFire` (`routines/pre-fire.ts`) runs the declared collectors and **then** asks the gate, both
**before any session starts and before any budget is spent**. A routine that declares neither returns
at once.

**A failed collection fails the gate closed.** When the collection throws and the routine declares a
gate, the verdict is a refusal naming the collection error. Each declared collector is reported
`NOT COLLECTED` with a host-composed reason, so the run can never read an absent read as an
observation.

`evaluateRoutineGate` (`routines/gate.ts`) **fails closed three ways**: an unknown gate name, a
predicate that throws, and a verdict that is not a usable `{ fire, why }` pair all answer "do not
fire", each with its own reason. Only a well-formed verdict decides.

`validateRoutineGate` refuses **at creation** a gate that names no collector. A gate decides from the
run's pre-run collection, and an empty collection would satisfy it vacuously. It also refuses a gate
name this deployment does not declare, and lists the ones it does.

### Collector limits

| Limit | Value | Behaviour at the limit |
| --- | --- | --- |
| Collectors per routine | **4** (`MAX_ROUTINE_COLLECTORS`) | Creation refuses more. |
| Undeclared deadline | **10 seconds** (`COLLECTOR_DEFAULT_TIMEOUT_MS`) | The collector is reported as failed. |
| Declared deadline ceiling | **60 seconds** (`COLLECTOR_MAX_TIMEOUT_MS`) | A longer declaration caps here. |
| Collected body | **4000 characters** (`COLLECTOR_BODY_MAX_CHARS`) | Truncated, never dropped silently. |

**The truncation is visible.** `renderCollectedBlock` writes `(truncated at 4000 characters)` on that
collector's own line, so the run knows it is reading a prefix.

**The render puts the fence in the right place.** The host-composed lines — the block header, and the
`NOT COLLECTED` failure line for each collector that did not return — render **outside** the untrusted
fence, because the host wrote them. Every collected **body** renders **inside** it, wrapped and
labelled `routine collector`, because a collector returns outside data.

## Fire audit rows

`routine.skip` rows are throttled to **one per routine and reason per hour**
(`SKIP_WINDOW_MS`, `routines/fire-audit.ts`), so a routine skipping on every tick cannot flood the log.

**Clock-leg rows are stamped with the synthetic principal `routine:dispatcher`**
(`ROUTINE_DISPATCHER_PRINCIPAL`), never the creator. The clock fired the routine; no person did, and
a row that named the creator would read as a person acting.

Routine forensics read a **seven-day** audit window (`FORENSIC_WINDOW_MS`) and scan at most **5000**
rows (`FORENSIC_SCAN_LIMIT`).

## Outcomes, stalls and bounds

`applyOutcome` (`routines/lifecycle.ts`) records the run. **A `skipped` outcome never counts as a
failure** — only `failed` increments the consecutive-failure count, and any other outcome resets it to
zero. A **`once`** trigger is terminal: the routine is disabled with `nextRunAt: null` after its single
fire, whether that fire succeeded or failed. Otherwise a routine self-disables after three consecutive
failures (`MAX_CONSECUTIVE_FAILURES`), and only when the streak also spans over an hour.

`checkBound` (`routines/bound.ts`) checks a bounded routine's three dimensions **in this order**:
**stall**, then the **fire cap**, then the **deadline**. Three consecutive checkpoint-blocked fires
retire the routine on the stall dimension (`MAX_STALLED_FIRES`, which is the same three).
**An unparseable deadline is ignored** rather than treated as expired, so a hand-edited or migrated
row cannot retire a live job; the fire cap still binds.

A fresh durable-job bound is minted at **200 fires** (`routines.jobMaxFires`) and **7 days**
(`routines.jobMaxDays`), whichever comes first. Plain `cron` and `interval` routines carry no
ceiling. The check-in (`routines/attention.ts`) is what pauses one that nobody looks at.

### The check-in

`attentionStep` (`routines/attention.ts`) runs before each clock fire of a recurring routine. It warns
once `routines.attentionWarnRuns` runs passed with no check-in (default 100), and it pauses once
`routines.attentionPauseRuns` more runs passed since the warning **actually posted** (default 24). The
count is written in the same optimistic advance as `fireCount`, so a gated, halted, ineligible or
over-budget tick is not counted. A pause writes `status: "disabled"` with a host-composed
`disabledReason` and a `routine.disabled` row that carries `checkIn: true`. A press writes a
`routine.checkin` row. Both cards are the `routine.attention` approval kind, member tier, with no
clock expiry.

A reply check-in (OPE-2532, `routines/report-thread.ts`) has two halves. The settlement of a fire's
work request stamps the routine on the seat's result wake (`oe_work_fire_routine`). When the seat's
`reply` under that same wake lands, the unified reply door writes one `routine_report_thread` row for
each thread a reply to the post would carry, keyed like `unifiedThreadRef` and live for 30 days. A
reply under any other wake records nothing. On the inbound side, `divertToUnifiedWindow` reads the row
for each thread-scoped wake whose requester is one person with no non-member stamp and whose trigger
messages carry the `principal` or `peer` trust tier, and clears the record of an active routine. It writes a `routine.checkin` row with `detail.via: "reply"`.
The rows hold ids only, never a message's words.

The native road (OPE-2558) has the same two halves on the per-surface doors. A native fire's own turn
carries the routine marker that `routines/fire-auth.ts` stamps (`identity/binding.ts`
`fireOwnRoutine`), so `replyAuditFor` names the routine and `postReply` records the post's threads. The
surface's post arm turns its reply target into a wake origin (`PostArm.originOfTarget`), and the threads
come from that origin and the codec's `replyThreadUnder`, as on the unified door. A test run names no
routine. On the inbound side, `hooks/routine-report-reply.ts` reads each `message.received` of a session
that is not a window: requester capture's fence (no fire, no delegation child, no work session, no
non-member stamp), an acting principal whose auth type is a person's (`<surface>-user`), and the wake
trust tier `principal` or `peer`. The same post-arm member places the turn, so the record and the count
key on one thread, except for a Linear top-level comment, which names itself as its thread. The native
Slack @mention door stamps a guest as a non-member (`channels/slack.ts` `stampNativeAuthorLeg`, the same
`users.info` probe and stamp the windowed door uses, OPE-2572), so a Slack guest does not count there.
The probe fails open: when `users.info` cannot answer, nothing is stamped. The hook counts each delivery once: a
dedupe row keyed on the session, the turn, the thread and the person turns a replay within 24 hours into
a no-op.

Every write of a routine's check-in record that depends on the row is a compare-and-set (OPE-2557).
The store method `updateRoutineIf` reads the row, asks a precondition, builds the patch from that row,
and writes only if the row text is still the text it read. If another write landed in between, it
reads again and asks again. After 8 attempts it throws. These writes go through it: the reply clear,
the Keep going and Resume press, the dispatcher's run count, warn and pause writes, and the edit and
rule-change clears. `enable_routine` writes a plain patch, because it clears the record whatever the
row holds. Before this, a reply
that read an active row could clear `attention` after a pause wrote it. That left a disabled routine
with no pause record, which `isPausedForCheckIn` refused, so its Resume card answered "stopped for
another reason". Both adapters put the compare in the `UPDATE` statement itself (`AND data = <read
text>`), so it holds across instances that share one database.

### The self-check-in doctrine is advice, not a bound

`CHECK_IN_START_MS` (60,000 ms) and `CHECK_IN_CAP_MS` (300,000 ms) are folded into the
`create_routine` tool's own description: it **tells** the model to start a self-check-in about one
minute out and to back off each time, up to about five minutes.

🔴 **Nothing enforces either bound.** They are instruction text the model reads, not a gate the host
applies, so a routine can be created with any interval at all. Read them as the doctrine the tool
teaches, never as a guarantee about what a routine's schedule can be.

## The job ledger and watch state

**A job-ledger write over 16 KiB of UTF-8 is rejected outright, never truncated**
(`jobStateWithinCap`, `routines/job.ts`). `applyJobStateObservation` answers `accepted: false` with an
empty patch, so the row keeps its previous state rather than half of a new one.

**A tainted writing turn raises `jobTainted`, and nothing lowers it.** The flag is monotonic: once a
turn that carried untrusted data wrote the ledger, every later reader knows the state has been
touched by outside content.

`applyWatchObservation` (`routines/watch.ts`) hashes the observed state. **An unchanged hash records
outcome `skipped` and posts nothing**; the hash is still written either way, so the next run compares
against what this one saw.

**A silent routine ends its turn with the sentinel `NO_REPLY`** (`WATCH_SILENCE_SENTINEL`) and posts
nothing. Its terminal prose is dropped under its **own** reason,
`silent routine — terminal prose dropped` (`SILENT_ROUTINE_DROP_REASON`), which is countable apart
from a turn that simply produced an empty message.

## Follow-ups and standing rules

A routine carries at most **10** follow-ups (`MAX_ROUTINE_FOLLOW_UPS`). At the cap the **oldest** entry
is evicted, so a routine that never resolves anything keeps its most recent thinking rather than
refusing every new note. **The eviction is reported**: the call answers the evicted entry's name, and
the tool says so — a silently dropped hand-off is the failure a ledger exists to prevent. A note
re-filed under an existing name updates it in place rather than filing a second one.

A routine carries at most **20** standing rules (`POLICY_MAX_RULES`), each at most **300** characters
(`POLICY_RULE_MAX_CHARS`). At the cap the add is **refused**, and nothing is evicted: a rule is a
guardrail, and silently dropping one to make room is exactly the removal the tool is gated against.

🔴 **A routine's own fire may never add or remove its own standing rules** (`policyAuthorRefusal`).
Rules are trusted instructions injected into unattended future runs, so only a person in the channel
arms them. A run that disagrees with a rule says so in its answer, and someone in the channel can ask
for the change.

## Event ingress — de-duplication, fan-out and matching

`admitTrigger` (`routines/ingress.ts`) runs in a fixed order: **normalize, then de-duplicate, then
capture, then fan out**. The order matters: an event the source does not model is rejected at
normalization, so it **burns no de-duplication slot** and a later, modelled delivery under the same id
is still admitted.

**A redelivery with the same source-scoped delivery id inside 10 minutes is dropped as a replay**
(`DELIVERY_DEDUPE_TTL_MS`). The key is scoped by source, so two sources cannot collide on one id.

**One inbound event fans out to at most three routines** (`routines.eventMaxFanout`, shipped `3`).
Matches over the cap are dropped and audited as a `routine.skip` row with reason `fanout_cap`, so the
loss is visible rather than silent.

`evaluateSubscription` (`routines/event-match.ts`) **returns a verdict for every failure and never
throws**, so one unreadable row cannot abort the fan-out for the rest. A source mismatch, a missing
normalizer, an unreadable stored filter shape and a filter evaluation error each answer "no match",
and the last three also carry an `invalid` reason.

`validateSubscription` refuses at creation. A source with no registered normalizer is refused outright,
because such a subscription could never match. **A source whose scope kinds include `container`, and
whose hook does not pin that container itself, must narrow its scope in the filter** — otherwise the
subscription is refused rather than armed wide.

`checkEventReadGrant` (`routines/event-authz.ts`) decides whether the routine's rooms may read the
event. A **declared `readableBy` short-circuits the scope adapter**: when the event carries one, the
adapter is not consulted at all. Everything else fails closed — no adapter and no declaration answers
`no-grant-adapter`, an event with no innermost scope answers `no-scope`, and no resolvable partition,
a resolver that throws, or a grant check that throws all answer `unresolvable`.

### The jq filter

A stored filter expression is capped at **1000 characters** (`FILTER_MAX_LENGTH`).

**Create-time probes take the fastest of three timed runs** against a **250 ms** budget
(`probeFilter`, `routines/jq-filter.ts`). The fastest run is used because it is the least noisy
estimate; a filter over the budget is refused with the advice to compare over `.fields` and `.scope`
rather than search the whole document. A filter that is not a usable predicate on that source is
refused first, with the document shape spelled out.

**The subscription-liveness stamp coalesces to one write per routine per minute**
(`MATCH_STAMP_WINDOW_MS`), so a high-volume source cannot turn a liveness marker into a write storm.

## How a triggered fire is seated and scoped

**A triggered fire on a windowed domain is a work request** (`routines/fire-work.ts`). The host
forwards the fire straight into the domain's work session, and no seat turn runs for it. The work
session starts a worker, and the worker runs the routine (see
[The three tiers](../how-it-works/agent-and-loop.md#the-three-tiers-seat-work-session-worker)). The
fire's own auth rides to the worker whole: the routine marker, the unattended stamp and the routine's
declared-permission key. The job is attributed to nobody (`oe/unverified`), so a fire's reach is the
routine's declared permission and never a person's. When the job settles, the result wakes the
domain's seat only when the routine owes the room output, and the seat posts it under the fire's own
wake id. A **silent** routine wakes no seat. Either way the run folds onto the routine at the job's
settlement, because the work session never ends and no session end would fold it. A domain with no
seat yet still takes the fire: the work session keys on the seat's registry key, which config alone
derives. A fire that the work session cannot start under its own stamp, after the host's one re-send,
is lost: its run folds as failed, and no seat is told to forward it again. A fire lost to a work
session rotation folds as failed too.

**A fire whose auth names no surface keeps the native cross-channel send** (`divertTriggeredFire`,
`routines/fire-window.ts`). It has no binding to key a work request on. The thread-seat fire that once
carried it (one session per fire, which delegated with `agent`) is retired (OPE-2350). A fire on a
surface that no domain windows, or on a deployment with delegation disarmed, takes the same native send.

**A routine's partition is derived from its stored `surfaceKey` alone** (`routinePartition`), by
splitting it into platform, workspace and surface. There is no live session binding to read: a routine
fires unattended, so the row is the only statement of where it belongs.

**An unparseable `oe-routine` permission key arms nothing.** `routinePermissionKeyParts` requires the
exact shape `oe-routine:<routineId>:g<generation>`, with a generation of one or more and no leading
zero. Anything else — a session token, a window token, a malformed key — answers `undefined`, which is
fail-closed.

**A fire waits at most 120 seconds on a permission card.** `ROUTINE_CARD_WAIT_CEILING_SECONDS` is
derived, not chosen: the 300-second function wall, less 120 seconds assumed already spent in the turn,
less a 60-second tail reserve. The wait can therefore never run the function out of time.

The tidy sweep reads its orgs from the setting `schedules.sweepOrgs`, a string array, and **ships
the single org `default`**. An empty list fails the boot. (The orgs were the `OE_TIDY_ORGS` variable
until OPE-2411.)

## What's available, and what's seam

Scheduled routines fire into all three chat surfaces under every post policy — Slack,
Discord, and Teams (see [Surface coverage](#surface-coverage)); event
subscriptions (with a built GitHub
webhook path) and generic webhook triggers are live; status reactions and a pinned
cross-thread status message are live; spend caps are live. **Untagged channel ingestion is
live, and it is on by default.** The ambient supervisor wakes a channel's standing seat on
messages that do not mention the agent. The seat replies only where it adds something, and
it audits every silence. A domain turns this off with `ambientSupervisor: false`. The room
then becomes addressed-only, and its ambient talk reaches the seat as context on the next
wake. On a default install the supervisor reads Slack channels confirmed internal, private or
vouched GitHub repositories, Linear teams and Notion pages. The flag lifts no fence: the
per-surface trust checks and the spend caps still apply. Discord and Teams do not read this
flag. On Discord an untagged message arrives only over the Gateway relay. On Teams it arrives
only where a team owner granted the resource-specific consent. Each surface page says which
untagged messages wake the agent there. The flag decides only what wakes a seat. It does not
decide how many channels share a seat, or which memory a seat reads: see
[Wake, seat, memory: three independent axes](../deploy/configuration-reference.md#wake-seat-memory-three-independent-axes). See
[`ambientSupervisor`](../deploy/configuration-reference.md) and the
[surface support matrix](../deploy/surfaces/support-matrix.md).

## At-rest isolation

Routines live in the operational store (SQLite for local dev, Neon Postgres for deploy),
with `org` as the outermost partition (an `org_id` column; Postgres adds row-level security
on the same column). One tenant's schedules are isolated from another's at rest, and each
surface reads only its own routines at runtime. See
[Database & operational store](../extending/database.md).
