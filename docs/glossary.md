# Glossary — the ratified vocabulary

This page fixes one word to one meaning. Every entry names the code that is the source of truth.
When this page and any prose disagree, read the code — comments in this repo are not evidence.

Use these words exactly. Do not vary a term for elegance. Loose vocabulary is how a
confident-wrong claim survives review: a 2026-08-13 review passed a sentence that gave the
conversational session the wide toolset and the delegated child the narrow one, which is the exact
reverse of the code, because "agent", "parent", "child", "seat" and "worker" were all in play for
the same thing.

Citations name a SYMBOL — `<path>#<symbol>` — never a line number. A symbol moves with its own
declaration, so an edit above it changes nothing here; a line number does not, and a stale one is a
broken citation, not a licence to guess. `npm run lint:glossary-citations` resolves every symbol
against the tree and refuses a `path:line` citation outright. Where the target is not a declaration
at all — a doctrine comment the glossary cites on purpose — the anchor is `path#L<n>`, and that line
must carry a `glossary:` marker of its own.

---

## The word "agent" — five meanings, and none of them is the default

🔴 **Never write a bare "agent" for a running session.** Say **seat** or **worker**. The word
already carries four distinct meanings in this repo:

| Meaning | Say this | Source |
|---|---|---|
| eve's built-in delegation tool, injected on the root node — this deployment's only delegation verb | **the built-in `agent` tool** | `node_modules/eve/dist/src/tools/framework/agent-contract.d.ts` (`AGENT_TOOL_NAME`) |
| the whole Open Everywhere runtime | **the OE runtime** | — |
| a channel-resident agent an operator provisions (a domain + silo + bundle + binding) | **a channel agent** | `packages/core/agent/tools/create_agent.ts#default` |
| a Claude Code subagent in this repo's own tooling | **a Claude Code subagent** | `.claude/agents/` (repo tooling, not the product) |

A channel agent is not an object. `create_agent` composes it from four existing config records.

---

## 1. Seat, grain, posture

**seat** — the conversational session. It talks, it forwards jobs, and it may read a little to find
out what it was asked. It is the **NARROW** surface. A delegating standing or thread seat holds 18 tools at
most, the **lean roster** (a conversation seat holds `work` and `cancel_work` from it, never `agent`
and `task_cancel`), and nothing else — not even the credential grants this chat's own scopes carry, which mount on the
chat's workers instead (OPE-2023).
Source: `packages/core/agent/access/lean-seat.ts#LEAN_SEAT_TOOLS`.
Not to be confused with: **worker** (the wide surface — see the inversion note below); **grain**
(the seat's hands are set by grain plus this filter, not by grain alone).

**conversation seat** — a seat that owns one conversation and forwards that conversation's jobs to its
own **work session**: a domain seat (a `window` token), a thread seat (an `s/` token) or a DM seat (a
window on the `oe-dm/` pseudo-domain). Never the work session itself, and never a worker. A
per-container standing root is a seat but no conversation seat, because it cannot delegate at all.
Source: `packages/core/agent/access/work-session.ts#seatTokenForwardsWork`.
Not to be confused with: the **work session**, which runs the jobs and talks to nobody.

**the lean roster** — the 18 names a lean seat may hold, exactly:
`reply`, `edit_reply`, `no_reply`, `react`, `update_status`, `stand_down`, `halt`, `set_dm_delivery`,
`agent`, `work`, `cancel_work`, `spawn_thread_session`, `complete_thread`,
`task_cancel`, `read_channel`, `read_thread`, `look_up`, `answer_domain_question`.
Five speak verbs, one stop-following verb, one break-glass **halt** (OPE-1602 — the brake pedal is
on the seat because a brake reached through a dispatch is not a brake; its `resume` partner is not,
because resuming widens and is a carded admin decision the seat routes), one recipient-stop verb
(OPE-1064), two delegation
verbs, the work-session pair `work` and `cancel_work` (OPE-2338, OPE-2350: every conversation seat
forwards to its own work session, so it holds these two instead of `agent` and `task_cancel`), one thread-lifecycle verb, one `task_*` lifecycle
verb (OPE-583) for stopping the seat's own delegated work, the two **recovery reads**
(OPE-829) — and one answer verb, `answer_domain_question` (OPE-2452), with which a domain's standing
seat answers a **domain question** delivered to it. The filter is DEFAULT-DENY: an unknown name is withheld.

One further name survives the filter without being a roster row: `task_wait`. eve injects it beside
`task_cancel` on every session whose toolset can start a task, and eve's own task prompt instructs it
by name — so a filter that removed it would make eve's instruction false. It is exempted as
HARNESS-INTERNAL (`access/job-posture.ts`), the same class as `final_output`, because it starts
nothing, reaches nothing and only parks a turn that was already running. `task_cancel` is a roster row
rather than an exemption, so a restricted job wake — which starts no task — does not inherit it.

`ask_question` is NOT on the roster (OPE-2023 addendum: parking a turn is
bad for a standing seat). It is a WORKER's turn plumbing: it blocks a turn until
a person answers, and a standing seat that blocks stops answering everybody else in the room — it
replies and lets the room carry on instead. It stays mounted on workers, and the worker-capability
index names it, so a seat meeting a job that needs it routes it rather than refusing. (`todo`, the
in-context scratch pad, was named here beside it until eve 0.65 deleted the tool; no session mounts
the name now, so there is no roster decision left to record.) The cross-surface window
has no question road (OPE-2389): a session there that raised a native input request would have it
dropped and audited, never posted.

`request_credential_grant` is NOT on the roster (OPE-2023). The ask is a doing verb, so it lives
where the doing verbs live: a person who asks the agent to use their own Notion account gets the job
handed to a task, and the task raises the ask with a full kit and a fresh context. The rule is that
a conversational seat asks the worker for access to Notion.

What makes the worker arm sound is the scope key. An ask pins three facts off the calling context —
the scope key the grant binds to, the reply target the owner's answer returns to, and the verified
requester of the turn. The second and third already resolve to the seat inside a child, which
inherits the parent's whole auth bag; the first does not, so `grantScopeKey` reads the ROOT seat's
session id instead of the worker's. The grant therefore binds to the CONVERSATION, never to the task
that asked, and it outlives that task. `requestCredentialGrantMount` bounds the verb twice: it needs
a domain that declares a grant role, and it needs a DELEGATED WORKER. An unattended fire's own
session is nobody's child, so it holds nothing; a fire's delegated child holds the verb and is then
refused `unverified_requester`, because an unattended fire names no asker.

The roster has NO rule that is not a name. OPE-1085 once carved this chat's `grant__` tools in by
SHAPE, because no worker could hold one and subtracting it would have destroyed the tool rather than
routing it. OPE-2023 moved the mount, so the carve-in went with it: a lent tool now mounts on the
WORKERS spawned from the conversation it was lent to, and the seat sheds it exactly as it sheds
`post_message` and `dm_person`. The seat reaches a lent Notion page the same way it reaches the org
connector — it delegates.
The **job kit** withholds every `grant__` tool on the same reasoning, one layer out: a restricted job
wake holds none, whatever the verb reads as, because a scheduled fire has no requester to spend an
owner's credential for (`packages/core/agent/access/job-posture.ts`). A fire's delegated worker is
refused for the same reason, at the mount: `domainScopeKeyInReach` withholds the domain key on an
unattended delivery.
Source: `packages/core/agent/access/lean-seat.ts#LEAN_SEAT_TOOLS`, allow test at `packages/core/agent/access/lean-seat.ts#allowedOnLeanSeat`.
Not to be confused with: the **grain matrix**, which still decides which of the delegation names
resolve on a given seat. The roster is a union over the lean grains, not a mount table.

**harness-internal** — the one class of name a per-wake toolset filter never removes.
`HARNESS_INTERNAL_TOOLS` has exactly one member, `final_output`, and it is plumbing rather than a
capability: dropping it would leave a structured-output turn unable to return at all. The **lean**
filter and the **job-wake** filter read that same one-member set, so the two exemptions cannot drift
apart — which is why the set lives beside the job posture rather than inside either filter.
Source: `packages/core/agent/access/job-posture.ts#HARNESS_INTERNAL_TOOLS`, read by `packages/core/agent/access/job-posture.ts#allowedOnRestrictedJobWake` and `packages/core/agent/access/lean-seat.ts#allowedOnLeanSeat`.
Not to be confused with: the **lean roster**, which is a list of capabilities a lean seat may hold.
This is a list of one name no filter may take away.

**container fence** — the chat read verbs `read_channel` and `read_thread` read the container the
wake arrived in, and expose NO target argument. A cross-container read is therefore not
expressible, rather than refused: there is no parameter a model could put another channel in. Reach
beyond the wake container is the WORK plane's — the provider's native work tools under the domain's
work grant. The work-plane chat reads `read_work_channel` / `read_work_thread` share the same fence:
what the work grant buys a worker is the read, not a wider address. Source:
`packages/core/agent/channels/wake-container.ts`.

**recovery read** — `read_channel` / `read_thread` on a lean seat. A wake carries recent backscroll,
not all of it, so a person can refer to a message the seat cannot see. Without a read verb the seat
can only guess the content or deny it exists, and both are false statements — measured in the
OPE-826 campaign, where mounting a read tool was the only intervention that moved the fabrication
rate (7/21 → 2/21 on one model, 3/21 → 0/21 on another). It is **bounded**: a lean wake gets
**4 reads per turn** and the next one is refused with text that points at a worker. Digestion —
summarise this channel, mine this history — is still worker work.
Source: `packages/core/agent/access/seat-read-budget.ts` (`SEAT_RECOVERY_READ_BUDGET`,
`assertSeatReadBudget`); prompt half at `packages/core/agent/instructions/access.ts`
(`renderRecoveryReadDoctrine`).
Not to be confused with: a **worker read**, which is the same two verbs with no budget; or the
per-surface **vendor container reads** (`read_notion_page`, `read_linear_issue`, …), which stay
worker-side.

**read spool** — what a read verb does with a page too big to put in front of a conversational
model. Under the inline cap nothing happens and the body is unchanged. Over it, the page is trimmed
to its **oldest** messages — the newest end is what the wake already showed — the full page is
written to a file in the session's sandbox, and the result carries a note naming the file. A worker
the seat delegates shares that sandbox and can read the file. A spool that cannot be written does
not fail the read; the note says the rest is unreadable instead.
Source: `packages/core/agent/channels/read-spool.ts` (`SEAT_READ_INLINE_CAP`, `capReadForInline`).

**enforced by deletion** — the lean roster is applied by deleting keys from the assembled toolset
at the per-model-call projection seam. The model never sees a removed tool, so there is no refusal
text an injected instruction can argue with.
Source: `packages/core/agent/access/lean-seat.ts#restrictToolsetForLeanSeat`, called at
`packages/core/agent/access/untrusted-projection.ts#projectToolSet`.
Not to be confused with: a **refusal** at execute time. `packages/core/agent/access/window-gated.ts`
is the backstop behind the wall, not a second copy of it.

**DM-seat carve-in** — six verbs a narrowed DM or group-DM seat keeps on top of the roster:
`link_identity`, `confirm_link`, `unlink_identity`, `revoke_credential_grant`, `ask_domain`,
`expect_bot_reply`. Each one acts for the CALLER — who they are, what their own account pays for, a
question to a domain they belong to (`ask_domain`, OPE-2452), or a reply to their own ask to another
bot (`expect_bot_reply`, OPE-2426) — and each hard-refuses outside a DM. The first four need an answer
the person gives on the seat. `ask_domain` needs THIS person's proven membership and THIS DM as the
answer's only destination. `expect_bot_reply` needs THIS person's own ask and THIS DM as the only place
the other bot's reply goes. So the worker-capability index never offers one as a route. That roster rule
is routing. The containment is a second set with the same six names: `WORKER_SEAT_RESERVED_TOOLS`
withholds them from a delegated worker, which used to mount the first four.
Source: `packages/core/agent/access/lean-seat.ts#DM_SEAT_CARVE_IN`,
`packages/core/agent/access/worker-seat.ts#WORKER_SEAT_RESERVED_TOOLS`.
Not to be confused with: the roster itself. The carve-in is a property of the SEAT, not of the tool.

**worker** (also **delegated child**) — a `task`-grain child of a conversation's work session. It is
the **WIDE** surface: the seat's kit plus **96** further tools, with two exact exceptions. It holds
exactly one of `ask_question` or `ask_room` (`ask_room` on a work-session job), so 95 of the 96, and
it does not hold the whole seat kit (see the worker withheld set). The 96 include `bash`, `aws`, `write_file`,
`open_pull_request`, `checkout_repo`, `web_fetch`, `request_credential_grant`, `ask_question`
and every read tool the seat does not hold. It also holds this conversation's own lent `grant__…` tools, which are minted per
grant row and so appear in no static count. The count is identical for a standing parent and a thread
parent.
Source: `packages/core/agent/access/worker-capability-index.generated.ts#WORKER_ONLY_TOOLS_STANDING` (96 entries) and `packages/core/agent/access/worker-capability-index.generated.ts#WORKER_ONLY_TOOLS_THREAD` (96 entries).
Not to be confused with: the **seat**. 🔴 **A top-level session does its real work by DELEGATING.
The parent does NOT hold the wide toolset.** Any claim that the parent is wide and the child is
narrow is backwards. Also not to be confused with a **Claude Code subagent**, which is repo
tooling.

**work session** (also **W**) — the ONE eve session per conversation that runs the conversation's
jobs. Every conversation seat (a domain seat, a thread seat and a DM seat) forwards each job to its
own work session with `work`, and the work session starts the job's worker with eve's `agent`. A
spawned thread seat's work session is its own fresh one, never the channel seat's (ruling Q2). It holds `agent` and `task_cancel`, plus the harness-internal `final_output` and
`task_wait`, and nothing else. It owns the conversation's sandbox, and it
outlives the seat's generations. Its token is the seat's window id with a `w/` prefix.
Source: `packages/core/agent/channels/work.ts`, `packages/core/agent/access/work-session.ts`.
Not to be confused with: the **seat**, which talks and never waits; a **worker**, which is a child
of the work session.

**forward** (also **work request**) — one job a seat (`work`) or the host (a routine fire) hands to
the work session. It carries a **request id**; the seat's request row records who asked, from which
wake and room. Its result comes back as one **result wake** of the seat per settled task.
Source: `packages/core/agent/tools/work.ts`, `packages/core/agent/routines/fire-work.ts`,
`packages/core/agent/hooks/spawn-taint.ts`.
Not to be confused with: an `agent` call, which runs the child inside the calling session's own turn (since OPE-2350, only the work session makes one).

**worker withheld set** — names a worker may not hold that a seat may. It holds four: `no_reply`,
`stand_down`, `read_channel` and `read_thread`. A name belongs here only
when the verb is structurally wrong on a worker, by one of exactly three tests: the worker can raise
the verb but can never receive its answer; the verb acts on the delegating seat's conversational
state, which the worker inherited by binding; or the verb belongs to the CHAT surface while a worker
holds the WORK surface. `stand_down` marks the *seat's* engagement row. `no_reply` ends a reply
obligation a worker does not have, and on the native route the worker's last message is its report,
so a silent turn hands the seat nothing. `read_channel` and `read_thread` are the chat surface's read
verbs, and a worker reads its work surface natively instead. `ask_question` was the first test's one
member and left the set when the answer's return leg was built.
`request_credential_grant` left it the same way (OPE-1343): it pinned the calling session's own id
as the grant's scope, and a worker's session ends before the owner clicks, so the ask now reads the
ROOT seat's session id instead. OPE-2023 then took it off the SEAT as well, so it is a worker-only
verb rather than a shared one.
Source: `packages/core/agent/access/worker-seat.ts` (`WORKER_WITHHELD_TOOLS`).
Not to be confused with: the **lean seat roster** (what a conversational seat should route rather
than do) or the **consequence registry** (what is risky). Those are different questions.

**question bridge** — the two-way route for a parked eve input request on a surface the agent
watches on its own: today the Notion question return. Outbound, the surface posts the question into
the discussion the session runs in. Inbound, the discussion's next comment is delivered back as the
answer, addressed to the request id, after a room check and the same admission a button answer runs.
The **cross-surface window has no question bridge** since OPE-2389: its `input.requested` handler
drops every non-park request and writes a `turn.question_dropped` row, because no shipped production
session there can raise one (a work-session worker asks with `ask_room`, an OE card that posts and returns, unless its work-tier
verdict fails soft).
The drop is an alarm, not a fence: eve can still take that session's next plain message as the answer by
its own rule, without the admission check.
Source: `packages/core/agent/channels/question-bridge.ts`,
`packages/providers/notion/agent/channels/notion-question-return.ts`,
`packages/core/agent/channels/unified.ts` (`input.requested`).
Not to be confused with: the **session-limit park**, which is never posted to a room and is retired
by rotation instead (`packages/core/agent/channels/session-park.ts`).

**standing seat** — the long-lived seat a channel has once `window.topology` is armed. Three
independent domain fields decide its behaviour, and each one decides one thing only:
`ambientSupervisor` decides what WAKES the seat; `mode` and `windows` decide how many channels
SHARE one seat; `memory` and `includeOrg` decide which MEMORY the seat reads. An external channel
reads only the `public` domain's silos, read-only, whatever its domain (the
[trust gate](capabilities/memory.md#the-trust-gate-the-security-keystone)). A channel in no explicit
domain inherits the `org` pseudo-domain's `ambientSupervisor` and `memory`, but its seat is always
solo, because config load refuses `mode` and `windows` on a pseudo-domain. The canonical explanation is
[Wake, seat, memory: three independent axes](deploy/configuration-reference.md#wake-seat-memory-three-independent-axes).
🔴 **Say "seat" for the session and "memory" for what it reads.** Never say `brain` for either:
the word made a reader take shared memory for one shared seat. Never call the seat a
`supervisor session`; the **ambient supervisor** is the wake rule `ambientSupervisor` turns on, not a separate
session. `npm run lint:seat-vocabulary` refuses both words in `docs/`.
Source: `packages/core/agent/channels/unified-supervisor.ts#supervisorGrainFor`,
`packages/core/agent/memory/domain.ts#ambientSupervisorEnabled`,
`packages/core/agent/memory/domain.ts#windowModeFor`.
Not to be confused with: a **domain seat**, which names the seat's token kind (`window`), not a
count. A domain can hold many domain seats: one per channel under `solo`, one per window group, or
one for the whole domain under `unified`.

**window group** — a NAMED standing window inside a domain (`Domain.windows`). Its members share one
live context window; a domain member no group claims falls through to the domain's `mode`. So one
domain can host several windows — two Slack channels together, a third on its own — while memory,
trust and access all stay at the DOMAIN grain. A group slices context, never authority.
🔴 **The group's `name` IS its window id.** That id keys the `channel_session` row
(`oe-domain::<name>`) and the supervisor token (`oe-dom:<domain>:win:<name>:oe-sup:g<gen>`), and the
registry key carries no domain segment — so a name is unique across every domain and is never a
domain name. Config load refuses both collisions.
Election is the domain grain's own rule: MOST SPECIFIC WINS over one `reach` list, minus anything
the group's `exclude` carves out (exclude always wins). The group whose matching entry denotes the
narrowest set takes the key, so a hand-listed surface beats a broader glob whatever order the groups
are written in, and config load refuses only the pair specificity cannot order — two groups whose
entries reach exactly the same keys.
Source: `packages/core/agent/memory/domain.ts` (`WindowGroup`, `windowGroupFor`, `windowIdFor`,
`assertWindowGroupExclusivity`), elected in `packages/core/agent/channels/unified-supervisor.ts`
(`supervisorGrainFor`).
Not to be confused with: **`mode`**, which is the RESIDUE a group leaves behind, not a competitor —
a domain with no groups resolves exactly the grain, token and registry key it always did.

**grain** — what sets a session's hands. Four values: `standing`, `thread`, `task`, `native`.
The host stamps the grain in an auth attribute; the continuation token's shape is the backstop, and
a stamp wider than the token can prove loses.
Source: `packages/core/agent/identity/binding.ts#WindowGrain`, `packages/core/agent/identity/binding.ts#windowGrainOf`.
Not to be confused with: **posture** (a separate plane — see below). A grain answers "what may this
seat mount"; a posture answers "who caused this run" or "is this wake narrowed".

**fullKit()** — the grains that mount the wide-hands family. With `delegation.oneshotAgent` armed
(the shipped default) that is `["task"]` alone. Flag-off it is `["task", "native"]`.
A FUNCTION, and that is load-bearing: it reads the flag fresh on every call, so a deployment's own
`agent/settings/settings.ts` override reaches the mount table. A module-load `const` cannot — the
boot order evaluates it before the app registers its settings.
Source: `packages/core/agent/access/window-gate-manifest.ts#fullKit`.
Not to be confused with: the worker-capability index, which is GENERATED from the manifest and
lists the delta a seat gains by delegating.

**subagent grain override** — an eve-minted subagent child resolves to grain `task`, whatever grain
its parent stamped. Without this a child of a standing seat inherited `standing`, resolved lean, and
came back with no hands.
Source: `packages/core/agent/identity/binding.ts#windowGrainOf` (the `isSubagentChildContext` arm of `windowGrainOf`).

**posture** — 🔴 **three unrelated types share this word.** Always qualify it.

| Term | Values | Source |
|---|---|---|
| **invoker posture** | `untrusted-remote`, `unattended-fire`, `attended-fire`, `interactive` | `packages/core/agent/access/invoker-posture.ts#InvokerPosture` |
| **lean-seat posture** | `lean`, `full` | `packages/core/agent/access/lean-seat.ts#LeanSeatPosture` |
| **job-wake posture** | `restricted`, `unrestricted` | `packages/core/agent/access/job-posture.ts#JobWakePosture` |

**invoker posture** — WHO caused this run, and what the causal chain may hold because of it. The
four classes form a lattice, narrowest first; composition takes the MINIMUM, so a stamp carried
across a delegation edge can only ever narrow.
Source: `packages/core/agent/access/invoker-posture.ts#InvokerPosture`, rank at `packages/core/agent/access/invoker-posture.ts#INVOKER_POSTURE_RANK`, `resolveInvokerPosture`
at `packages/core/agent/access/invoker-posture.ts#resolveInvokerPosture`.
Not to be confused with: **grain**. A `task` worker is exempt from every invoker-posture
subtraction — delegation escalates hands, not authority.

**untrusted-remote withheld set** — the 11 wide-hands names an `untrusted-remote` PARENT WINDOW
loses: `bash`, `glob`, `grep`, `read_file`, `write_file`, `web_fetch`, `checkout_repo`,
`open_pull_request`, `post_file`, `create_skill`, `delete_skill`.
Source: `packages/core/agent/access/invoker-posture.ts#UNTRUSTED_REMOTE_WITHHELD_TOOLS`; the
worker exemption at `packages/core/agent/access/invoker-posture.ts#withheldForInvokerPosture`.

---

## 2. Delegation

**native delegation** — the ONLY delegation route. eve's built-in `agent` tool runs a subagent child
inside the parent's own sandbox. Since OPE-2350 the only session that calls it is a conversation's
**work session**: a seat forwards with `work` instead. There is ONE return shape: the call returns a
task receipt at once, the parent's turn stays open at `turn.waiting` while the task works, and the
child's result arrives in that same turn (see **background-task return leg** below). No setting changes it — eve 0.51.0 no
longer READS `experimental.tasks`, so no build returns the child's result inline. The flag name is
still in eve's TypeScript surface, but its compiler refuses the key, so a build that sets it fails
instead of taking the old shape. The `test:eve-tasks-flag` pin
(`packages/core/scripts/eve-tasks-flag-test.ts`) reds if `tasks` returns to eve's `experimental`
allow-list, and on a direct read of the field under eve's `dist/src`.
Source: `packages/core/agent/access/untrusted-projection.ts` (the gate — subtraction at the model-call seam),
`packages/core/agent/access/native-delegation-state.ts` (the per-wake verdict).
There is no second route: OE's own dynamic `agent` — the **roll-own** regime, with `return_result`
and `stop_task` — is DELETED (OPE-1145 item 2), and with it the `delegation.nativeSubagent` switch.

**`spawn_thread_session`** — mints a `thread`-grain conversational SEAT, not a worker. Standing
grain only. It is one side of the seat's **routing decision**: the hand-off of a task's whole
orchestration to a thread session, after which the task is off the seat's radar.
Source: `packages/core/agent/access/window-gate-manifest.ts#spawn_thread_session`,
`packages/core/agent/tools/spawn_thread_session.ts#default`.

**thread session** — the MODEL-FACING name of a **thread seat**, and the same thing: a `thread`-grain
conversational seat on an `s/` window token that owns one thread and one task, minted by
`spawn_thread_session`. The seat prompt and the tool descriptions say "thread session", the term of
OPE-2427; code and operator docs say "thread seat". Likewise "standing session" in
the seat prompt is the model-facing name of the **standing seat**.
Source: `packages/core/agent/instructions/seat-prompt.ts#ROUTING_DECISION`,
`packages/core/agent/tools/spawn_thread_session.ts#default`.

**routing decision** — the ONE decision a seat makes about a task (OPE-2429): orchestrate it
itself, through its own work session, or hand its orchestration to a thread session with
`spawn_thread_session`. Anything that needs meaningful orchestration or real work goes to a thread
session. It stays a judgement; the seat prompt states it in one place.
Source: `packages/core/agent/instructions/seat-prompt.ts#ROUTING_DECISION`.

**hand-back** — the host-written wake that tells a parent seat one of its thread seats closed: it
finished (`completed`), went quiet (`expired`) or could no longer be reached (`closed`). The host
writes it from recorded facts on every close, and the seat's own report rides inside it when the
seat gave one (OPE-2428).
Source: `packages/core/agent/channels/thread-seat-close.ts#closeThreadSeat`.

**domain question** — one question a person's DM seat asks a domain the person belongs to, with
`ask_domain` (OPE-2452). The host delivers it to the standing seat of the domain room the person sits
in. That seat answers with `answer_domain_question`, and the host delivers the answer to the asker's DM
and nowhere else. **Membership** here is a room: the platform confirms the person a full member of the
workspace and the room internal.
Source: `packages/core/agent/channels/domain-question.ts#domainQuestionRoomRefusal`.
Not to be confused with: a **forward** (a job for a worker), or a **hand-back** (a thread seat's report to
the seat that opened it).

**one-shot** — a delegated run started by a fresh `agent` call, with no `taskId`. Every delegation
opens this way; a seat may then continue it from the same room (see **task continuation** below).

**task continuation (`taskId`)** — eve 0.70 makes every agent tool a resumable task, so a correction
or a follow-up can reach an idle worker by its `taskId`. A conversation seat sends one with `work`
and the task id that the job's result named, and the work session continues the task. **OE
allows it** (OPE-2251, ruling C). The worker's taint is session-sticky, so a continuation of a
worker that read untrusted content stays tainted, and the worker re-resolves its requester and reply
address for each later turn from the admitted continuation. The one OE rule on top is the **provenance
fence**: a `taskId` call is admitted only from the same room (channel, issue or DM) that opened the
task, and only once the task has reported back; every other continuation is refused. The fence
does not wrap `task_cancel` (OPE-2290): a stop sends no input and returns no content, and the
approval decision wake depends on it.
It replaces the retired `agentId` refusal (OPE-593), whose field eve 0.70 no longer has.
Source: `packages/core/agent/access/worker-continuation.ts`, `packages/core/agent/channels/task-provenance.ts`.
Not to be confused with: **task_cancel**, which stops a task's current work by `taskId` and leaves an
idle resumable task available for its next call.

**parked worker** — a background worker whose task has settled. Its session does not end; it stays
durable and inert, one per background delegation, until its parent generation is retired. eve's own
reaper runs only when the PARENT session ends. No OE seam can end ONE named worker today.
🔴 **The reason for that changed at eve 0.70, and OPE-566 is re-opened by it.** Through 0.54 it was
that eve stripped the worker's session id out of every task view an authored hook could read. eve
0.70 PUBLISHES it, on `agent.started` (`protocol/message.d.ts`: "The opened session's id"), and OE
records it on the dispatch join row. Having an id is not having a mechanism, so no per-worker reaper
exists yet — but the premise that one is impossible is gone. Retiring the parent SEAT
GENERATION runs that reaper over the whole generation's children in one act, and OE does that at
every window and DM seat **rotation** (OPE-627), from the single-window channel, guarded against a
live turn. That guard reads a best-effort turn anchor with a 45-minute TTL, so a lost anchor write —
or a turn longer than the TTL — reads as no turn. The retirement then cancels that turn, and the
agent posts a "Stood down" note into the room. 🔴 The reaper does not spare an UNSETTLED delegation,
so a further guard holds the retirement back: a generation that still owes a `working` or
`input_required` task is skipped and audited rather than retired (OPE-1620). Such a generation is
never retired by this module at all — a skip is final — so its workers stay parked until its own
session expires, which is the price of never cancelling work somebody is waiting on. The population is countable from the
`delegation.task_started` / `delegation.task_settled` audit rows, and a confirmed reap writes a
`session.generation_retired` row (best-effort, like every audit write — `auditRetirement` swallows a
store failure).
Source: `packages/core/scripts/parked-child-lifecycle-test.ts` (the pinned eve facts),
`packages/core/agent/channels/generation-retirement.ts` (the retirement).
Not to be confused with: a **cancelled** task. At eve 0.70, cancelling a settled task answers that
there was no work to stop and sends nothing. Cancelling a task is not the act that ends a worker
session. The one exception is eve's own 30-second escalation: a cancelled worker that does not stop
its current call in time is ended by eve.

**leaf** — a session that holds no delegation verb, so the chain cannot recurse. `agent` mounts on
`standing` and `thread` only; `spawn_thread_session` on `standing` only. A `task`
worker therefore delegates to nothing.
Source: `packages/core/agent/access/window-gate-manifest.ts#agent`, `packages/core/agent/access/window-gate-manifest.ts#spawn_thread_session`,
`packages/core/agent/access/delegation-mount.ts#canDelegateFromSeat`.

**parent pointer** — `ctx.session.parent.sessionId`, eve's typed link from a subagent child to the
session that spawned it. Host-written and model-unreachable.
Source: `packages/core/agent/identity/binding.ts#subagentParentSessionId`, `packages/core/agent/identity/binding.ts#isSubagentChildContext`.
Not to be confused with: the **root session** (the top of the chain, which has no parent pointer),
or a **parent turn** (one turn of the parent session — a taint stamp rides the TURN, the pointer
names the SESSION).

**`canDelegateFromSeat`** — is there a window to mint a worker into? A seat that answers false keeps
its full kit rather than being stranded with no doing-verbs and no delegation verb.
Source: `packages/core/agent/access/delegation-mount.ts#canDelegateFromSeat`, consumed at
`packages/core/agent/access/lean-seat.ts#canDelegate`.

---

## 3. Taint

**taint** (a **tainted turn**) — this TURN ingested untrusted external content. On a root session the
flag is per-turn and monotonic within the turn. A worker's taint is session-sticky (OPE-2251): once a
worker turn is tainted, every later turn of that worker session starts tainted
(`hooks/spawn-taint.ts`, `reseedStickyChildTaint`). The turn boundary clears it, but only on positive proof of a
new eve turn id; an unreadable turn id KEEPS the old value.
Source: `packages/core/agent/access/taint-signal.ts#beginTaintTurn`, `packages/core/agent/access/taint-signal.ts#markUntrustedIngestedThisTurn`, `packages/core/agent/access/taint-signal.ts#untrustedIngestedThisTurn`.
Not to be confused with: a session-durable or generation-durable mark. 🔴 **OE never marks a seat
session or a generation as tainted**; the worker's sticky slot above is the one session-scoped mark. Storage is a durable eve slot, which is why the reset is explicit.

**envelope** (also **wrapping**) — the instruction-resistant fence around external content.
`wrapUntrusted` caps the body, defangs any delimiter inside it, closes it with a nonce-matched tag,
and appends one data-only notice after it. Wrapping keys on the SOURCE: every tool, connector and web result is wrapped, and so is
every wake-envelope `<message>` except one — a `principal` or `peer` author's, which reaches the
model escaped and capped but unfenced, because the `trust` attribute already states that a vouched
member typed it. An unresolved author's message is wrapped; that is the fail direction. A raw
`direct` DM/@mention body carries no envelope and no fence at any grade, as it always did.
Source: `packages/core/agent/access/untrusted.ts#wrapUntrusted`; delimiters at `packages/core/agent/access/untrusted.ts#UNTRUSTED_OPEN`; the chat exception
at `packages/core/agent/channels/wake-envelope.ts` (`authorTrustAdmitsUnfencedBody`).
Not to be confused with: **gates**. Wrapping never refuses anything. The verdict floor that a
tainted turn triggers at the `gate` sinks is the contested half.

**ingestion** — the one funnel that does both jobs: it wraps, and it marks the turn if the source
tier says untrusted.
Source: `packages/core/agent/access/untrusted.ts#ingestUntrusted`, decision at
`packages/core/agent/access/taint-enforcement.ts#decideIngestion`.
Not to be confused with: `wrapUntrusted`, which fences without marking.

**source tier** — `trusted` or `untrusted`, decided per ingestion KIND by one code table.
Source: `packages/core/agent/access/taint-tiers.ts#IngestionTier` (type), `packages/core/agent/access/taint-tiers.ts#IngestionKind` (the 14 kinds), `packages/core/agent/access/taint-tiers.ts#classifyIngestion`.
🔴 **The SOURCE decides, not read-tool-versus-backscroll.** `kind: "chat-message"` returns
**trusted**, so reading a channel or a thread does not taint a turn merely because it was a read.
Source: `packages/core/agent/access/taint-tiers.ts` (`classifyIngestion`, the `chat-message` case).

🔴 **The one exception is the AUTHOR, and it is a positive refutation.** `read_channel` and
`read_thread` grade the distinct authors of the page they fetched. If any of them is refuted as a
non-member — by the surface's own probe, or by the author-trust register — the read declares
`authoredByNonMember: true` and the row returns **untrusted**. An absent or `false` fact is trusted:
"the probe could not answer" is never "a stranger wrote it", and marking on silence would set the bit
on every read-heavy turn. EVERY chat reader — `read_channel` / `read_thread` and the delegated
worker's `read_work_channel` / `read_work_thread` (OPE-938) — routes through ONE grade-and-project
body (`readChannelResult` / `readThreadResult`), so the taint leg and the `withhold` grain below are
declared once and no reader can declare them differently.
Source: `packages/core/agent/channels/read-author-trust.ts` (`refutedReadAuthorIds`).

🔴 **The same join answers the AUTHOR GRAIN, and under `withhold` the read does not mark.** The join
returns the refuted author IDS, and `read_channel` / `read_thread` read that one answer twice: they
declare `authoredByNonMember` for the table, and — on `externalPolicy.authorGrain: "withhold"` — they
replace those authors' message text with the arrived-marker. A withheld body never reached the model,
so the read declares nothing and the turn stays clean. On the `taint` opt-out grain nothing is
withheld and the mark is unchanged.
Source: `packages/core/agent/channels/channel-read.ts` (`gradeAndProject`).

Fail-closed: a row whose deciding metadata is absent returns `untrusted` with `assumed: true` — with
`chat-message`'s author fact the deliberate exception, for the reason above.

**forward leg** (parent ⇒ child) — a worker dispatched from a tainted turn starts tainted, so taint
cannot be laundered by delegating. **The carrier is an auth attribute on the child's opening auth.**

A native subagent child is stamped by the PARENT writing `oe_parent_turn_tainted` into its own auth
attributes. eve reads a native child's `auth` from `AuthKey` in the PARENT's serialized context —
not from the tool call — so a hook can reach that bag even though a tool cannot. The child reads the
attribute synchronously at its own `turn.started`, with no store round trip.
Source: `packages/core/agent/channels/unified.ts#OE_SPAWN_TAINTED_ATTR`, stamped at `packages/core/agent/channels/unified.ts#dispatchTaskWindow`;
`packages/core/agent/hooks/spawn-taint.ts` (§THE FORWARD LEG — `OE_PARENT_TURN_TAINTED_ATTR`,
`recordTurnTaintForChildren`, `adoptParentTurnTaint`).
🔴 **The native stamp names a specific parent turn; it is never a bare `true`.** Its value is
`<parentSessionId>|<parentTurnId>`. The child adopts it only when the SESSION half equals the parent
its own context names, and — on its own `turn.sequence === 0` — when the TURN half equals the turn
that dispatched it. That discrimination is what scopes the fact to one turn: a stale stamp from an earlier
tainted parent turn is not adopted, with no clearing pass. At eve 0.70 every message to a child carries
the sending call's auth, so a continuation sent from a tainted parent turn adopts that turn's stamp
(the forward carriage). A child that was ever tainted stays tainted (see **taint**). It is therefore NOT in
`TAINT_SEED_ATTRS`, which means "the value is the string `true`".
🔴 **The dispatching turn is named by OE's own `oe_dispatch_turn`, never by eve's
`session.parent.turn`.** Every turn writes `<sessionId>|<turnId>` into the same auth bag it writes the
stamp into, so the two travel to the child together. eve 0.51.0 re-pointed `session.parent.turn` from
"the turn that dispatched this child" to that turn plus one, which made the old comparison refuse
every first-turn child and let a parent launder a worker's taint onto the worker it started next
(OPE-1467). A stamp that arrives with no `oe_dispatch_turn` beside it does not taint a first-turn
child. `oe_dispatch_turn` names a turn and says nothing about what that turn read, so it is not a
taint signal and is not in `TAINT_SEED_ATTRS` either.
🔴 **The carriage must never become a store read on the child side.** A read in the child's turn
preamble re-runs when eve recovers an **inline step** whose body crashed mid-delivery — eve's own log
line is *"Re-executing inline steps owned by this queue message — a previous delivery crashed mid-body
and this redelivery is recovering them"*. That re-execution re-runs every store read in the body. The
auth bag is recorded in eve's durable event log, so the attribute is replay-stable by construction.
🔴 **The mechanism is inline-step recovery, NOT ordinary replay.** A COMMITTED step is never
re-executed: `@workflow/core/runtime.js`'s step consumer meets the recorded `step_completed` event,
resolves the invocation from `eventData.result`, and never calls the step function.
`ReplayDivergenceError` compares the sequence of workflow OPERATIONS, never a value. So a corruption
is not by itself proof of divergent code — inline-step recovery produces one from code that replays
correctly.
🔴 **`WORKFLOW_DEFERRED_CHECK_DELAY_MS` is not a lever, and preamble latency does not lose a timing
bet.** eve's unconsumed-event check waits for `isDeliveryIdle` before it arms that delay, so a
delivery still in flight holds the check off rather than racing it. The delay is a post-idle settle;
raising it only slows the report of a GENUINE divergence. Nothing in OE sets it, and
`packages/core/scripts/eve-delivery-gate-test.ts` pins the upstream property so an eve bump that
drops the gate goes red instead of silently making the knob matter again (OPE-468).
🔴 **The return leg is NOT in the same position. Do not "fix" it by symmetry with the forward leg.**
`adoptSubagentTaint` reads at `action.result`, which is AFTER eve confirmed the child produced a
result, so both of the child's writes have settled and the value cannot change under it. The
constraint above — no store read in a turn preamble — does not apply to it. The reasoning lives at
`packages/core/agent/access/subagent-taint.ts`'s OPE-437 note.
🔴 **A child settles on a different edge, and the read is only safe on that one.** eve
returns the `agent` call's receipt at DISPATCH, with a real `callId` — so the
read above would run before the child exists, find no marker, and
fail closed on every clean delegation. Measured on the real host
(OPE-555 T1): one delegation that read nothing untrusted wrote a `taint.forward` `mark` row against
the seat's own session. See **background-task return leg** below.
🔴 **The stamp is a CARRIAGE, not a record of the adoption, and a later reader must not re-derive
from it.** The adopting child overwrites the arriving value with its own pair during `turn.started`,
and eve awaits `turn.started` before it emits `message.received` — so every later hook edge sees the
child's own pair and would answer "did not adopt". `adoptedParentTurnTaintThisTurn` reads a per-turn
slot the adoption records instead. `hooks/requester-messages.ts`'s capture fence is the one consumer,
and it was silently dead until it used the slot.
🔴 **The leg fails OPEN.** An absent or unwritable stamp reads as a clean parent. The common case is a
genuinely clean parent turn, so failing closed would taint every delegated worker in the deployment.
🔴 **The carriage mutates an eve-owned object, so it has a tripwire.** An eve bump that freezes the
attributes bag, gives `AuthKey` a codec, rebuilds the auth per step, or stops reading the child's auth
off the parent's serialized context turns the leg silently off. `packages/core/scripts/native-subagent-test.ts`
§D9.1 asserts those four facts against the installed eve bytes, and the `eve-upgrade-check` skill's
parity list names them.
⚠️ **The same-step race is open, by eve's step concurrency.** A model response that emits an untrusted
read and an `agent` call together has already been handed its toolset, so that one child's auth may be
copied before the stamp lands. Every LATER step of the turn is covered.

**native-delegation withdrawal** — **withdrawn as a concept (OPE-471). A tainted turn keeps eve's
built-in `agent`.** The projection seam removes the tool only when the SEAT was not positively
classified as a delegating conversational seat.
The withdrawal rested on one condition: no taint mark reached a native child, so a tainted seat would
dispatch a child that ran CLEAN. The **forward leg** now marks that child before its first model call,
measured end to end on the real host. The launder path is closed by propagation, not by absence.
🔴 **The tool plane was never the reason, and stating it as one was false.** Every gated tool a worker
can hold declares a taint tolerance. Every `gate` sink is worker-reachable, so a tainted worker's
standing-instruction, skill/agent and ingress acts DO hit the human ask-floor; every other worker-reachable
gated sink declares `disclose`, which is a judge signal rather than a card. `bash`, `write_file` and
`read_file` carry no tolerance because they are `open` rows by the ratified in-sandbox cut — their
durable effects leave only via the gated verbs above — and `aws` is bounded by its bundle grant, its
IAM role and the host-side argv screen at L2.
Source: `packages/core/agent/access/native-delegation-state.ts` (`nativeAgentAllowedNow`), applied
at `packages/core/agent/access/untrusted-projection.ts`; the tool-plane facts are pinned by
`packages/core/scripts/taint-worker-plane-test.ts`.

**return leg** (child ⇒ parent) — the child's own taint carried back onto the turn that reads its
result. ONE carrier: a durable marker row for the native subagent child, which sends no wake.
(A second carrier, an auth attribute on the roll-own worker's completion wake, went with that regime
in OPE-1145 item 2.)
Source: `packages/core/agent/access/subagent-taint.ts` (the session-keyed marker key, its write, and
the parent-side read).
Not to be confused with: the `delegation-result` row of the source-tier table. That row has no
declaring site left and defers to nothing; it answers `untrusted` on provenance alone. The marker
row above is what actually establishes a worker's taint, and it fails CLOSED.
🔴 **The parent-side identity join is CALL-KEYED, not event-keyed (OPE-437).** The join used to be
built from eve's `subagent.called` event alone, which eve swallows on a failed emission — a lost
emission meant the parent silently read as untainted regardless of what the child did. The child now
writes a second marker under a key the parent rebuilds from `ctx.session.parent` (the parent's own
session id plus the delegation `callId`), so the join needs no event from eve. The parent FAILS
CLOSED — it treats itself as tainted — when it cannot read that marker for a call eve has already
confirmed produced a result. The marker is monotonic: the child's eager clean claim is put-if-absent
and the tainted write is an upsert, so the row settles on tainted whichever write lands last.
Source: `packages/core/agent/access/subagent-taint.ts` (call-keyed marker key, clean claim, tainted
write, and the parent-side read that answers `undefined` on loss).

**background-task return leg** (child ⇒ parent, async) — the same fact as the **return leg** above,
carried across the two edges every delegation gets. eve runs the `agent` call as a durable task
inside the parent's open turn: the call returns a receipt at once, the turn waits at
`turn.waiting`, and the child's output reaches the parent as a `task.result` message in that same
turn. OE adopts on eve's SETTLEMENT `task.settled` EVENT, which eve emits once per settled call and
which no member can author.
🔴 **At eve 0.70 that is the ONLY settlement edge** (OPE-2250). The two the 0.54 plane used are both
gone: eve sends no task NOTIFICATIONS, and there is no task VIEW — `task_peek` is deleted and
`task_cancel` answers one rendered sentence (`execution/tasks/render.js` `renderTaskCancelResult`)
with no `tasks` array and no `lastOutput`, so the `task_cancel` output path that used to carry the
child's prose is CLOSED rather than merely unread.
Source: `packages/core/agent/access/background-tasks.ts` (the ONE module allowed to PARSE the task
shapes — the receipt discriminator and the view payload; the bare tool names also appear in the
access registries, which is membership, not shape-coupling); `packages/core/agent/hooks/spawn-taint.ts`
(§THE BACKGROUND-TASK BRANCHES).
🔴 **A dispatch is not a settlement, and reading the marker on the dispatch taints every clean
delegation.** The receipt carries a real `callId`, so the sync branch matched it and ran the
fail-closed read before any child had started. The fix RELOCATES that read; it never weakens it. The
receipt branch remembers the join and adopts nothing; a TERMINAL settlement adopts, fail-closed branch included. At eve 0.70 the only terminal settlement
is eve's `task.settled` event; the dispatch edge is the `task.started` event, which
`readTaskStarted` (`access/background-tasks.ts`) parses.
(History, OPE-943: through eve 0.54 OE parsed the dispatch receipt itself, in two envelope shapes, and
a reader that went blind on one minted no dispatch row, so every settlement resolved `no-row`. At eve
0.70 the dispatch edge is the `task.started` event, parsed by `readTaskStarted`.)
🔴 **Terminal is eve's own `isTerminalTaskStatus`: `completed`, `failed`, `cancelled`.** `working`
and `input_required` adopt nothing — such a child can still read untrusted content. `failed` and
`cancelled` DO adopt: a child that read a hostile page and then died has already written its marker.
🔴 **The join is remembered because neither edge carries the other's id.** The receipt names the
child by `callId` while the settlement names it by `taskId`, and the marker is keyed by `callId`.
ONE row in the task-result slice holds the join: `oe-task-call:<taskId>`.
🔴 **The second row is retired (OPE-2250).** `oe-task-agent:<parentSessionId>:<agentId>` existed
because a 0.54 continuation minted a NEW taskId against one child, so the join had to be pinned to a
life-stable handle. At eve 0.70 a resumable task IS its `taskId` — a continuation reaches it by that
same id — so the task-keyed row is already the life-stable one.
🔴 **And that id is NOT org-unique.** `createTaskId` mints `<toolName>-<6 random base32>` and checks
for a clash only against the CALLING SESSION's table, so two parents in one org can collide inside
the row's TTL. The dispatching session is RECORDED on the row and a settlement that reads another
session's row treats it as a LOST record and marks — fail-closed, by design.
🔴 **This plane is LIVE on every build.** Background delegation is unconditional since eve 0.51.0
stopped READING `experimental.tasks` (the flag name survives in eve's TypeScript surface, but its
compiler refuses the key; the `test:eve-tasks-flag` pin guards both halves), so the receipt-safe leg
above is the code every delegation takes on every deployment.

**background-task wake identity** — the host-minted wake id one background task settles under. eve
wakes a delegating parent through the session's own command hook, with no auth, and eve writes a
turn's auth only when a delivery brings one. (Through 0.54 the carrier was `wakeTaskParentStep`
calling `resumeHook(token, {kind:"send", …})`; that symbol does not exist in the eve 0.70 dist, and a
0.70 task settles inside the turn that started it.) So a task-woken turn inherits the PREVIOUS delivery's `oe_wake_id` — and
that stamp IS the reply address. The identity closes the gap: the dispatch edge mints a wake id for
the task and registers it against the origin of the conversation the DISPATCHING TURN is working
for, plus the seat's window token; the settlement edge (eve's `task.settled` event at 0.70, a
TERMINAL task view through 0.54) names the turn with it, and `currentWakeId` answers with it from
then on.
Source: `packages/core/agent/channels/task-wake.ts` (mint, register, re-point, install, audit);
`packages/core/agent/access/task-wake-signal.ts` (the per-turn settlement slot);
`packages/core/agent/access/dispatch-origin-signal.ts` (the per-turn dispatch slot);
`packages/core/agent/identity/binding.ts` (`currentWakeId`, where the identity wins).
🔴 **The answer goes to the conversation that ASKED, not to whichever wake ran last.** On a
multi-thread seat the inherited stamp names a different room. Registering the dispatching turn's own
conversation is what makes the reply land in the thread that ordered the work.
🔴 **`currentWakeId` names the turn's own DELIVERY, which is not always the conversation the turn is
working for.** A turn that merged queued deliveries carries only the LAST delivery's auth, so
a turn woken by N conversations runs under one of them, chosen by queue order; and a turn woken by an
internal wake (an approval decision, a completion) can answer an ordinary conversation whose envelope
is still in the seat's history. Measured in production on 2026-08-15: a turn running under an
approval decision wake from one thread dispatched a task for a different thread's ask, answered that
ask, and posted the worker's answer into the decision's thread. The address therefore comes from the
wake the turn ADDRESSES — the `wake` argument the `reply` tool's authority fence admitted — and falls
back to `currentWakeId` only while the turn has said nothing. A task dispatched before the turn's
first reply is re-pointed by that reply, which is safe in time because eve runs one turn at a time
per continuation token. Each move writes a `unified.task_wake_retarget` audit row.
🔴 **The AUTH-CARRYING merge is unreachable since eve 0.52.5 (no later changelog entry up to the 0.71.0
pin changes the rule), so the MERGE road into the defect is closed. The INTERNAL-WAKE road above is not, so the guards stay LOAD-BEARING.** eve 0.52.5
narrowed its batching rule to adjacent queued deliveries whose full auth contexts match, and OE
stamps `oe_wake_id` plus a fresh per-delivery `oe_delivery_id` into `auth.attributes` — so two
auth-carrying deliveries on one unified window never compare equal. Only eve's OTHER arm still
folds: a task COMPLETION COHORT of caller-less deliveries, which carry no `auth` at all, so no
conversation's auth can displace another's. That closes ONE of the two roads. The other is the
paragraph above: a turn woken by a single internal wake — an approval decision, a completion —
answers a conversation whose envelope is in the seat's shared context, through the reply fence's
same-conversation and pending arms, and needs no merge to do it. That is the 2026-08-15 production
measurement, and it is why the address comes from the wake the turn ADDRESSES rather than from
`currentWakeId`. Do not read "the merge is unreachable" as "the correction is dead code".
Source: `packages/core/scripts/coalesced-delivery-merge-assumption-test.ts`, which pins the merge
road's impossibility offline and reds the day it stops holding.
🔴 **The residual, stated: a turn that dispatches for its own wake and then answers a DIFFERENT
pending wake first moves that task's answer to the wrong conversation.** Both wakes sit on the same
window token, so this is never a cross-window leak, and the audit row makes it countable.
🔴 **The identity lands only on an UNINGRESSED turn.** A settlement is not proof that a task woke
the turn: a human can ask "is that job done?" in one thread while the task was dispatched from
another. The divert stamps a NONCE unique to every delivery (`oe_delivery_id`), so a turn whose stamp
is byte-identical to the previous turn's brought no delivery of its own. That comparison is recorded
once per turn at the turn boundary, off the context, with no store read. Every failure of the
comparison reads as INGRESSED and installs nothing.
🔴 **The discriminator is a per-delivery nonce, not the wake id.** The wake id nearly serves — every
ingress mints a fresh one, and an auth bag with no nonce still falls back to it — but the auto-redrive
re-stamps the ORIGINAL wake id on purpose so the model can answer the conversation whose prose was
dropped. On the wake id alone that corrective delivery reads as "no delivery" and would lose the
address it was sent to restore. The nonce carries the "a delivery arrived" fact on its own, so no path
needs an exemption.
🔴 **The identity is TURN-SCOPED.** The slot stamps the eve turn id into its value and refuses to
answer for any other turn, so eve's durable state cannot hand a stale address to a later turn. An
unreadable turn id installs nothing and reads as absent — the turn keeps the inherited stamp.
🔴 **A task-settlement wake does NOT re-run OE's ingress gates, and that is the ruling.** The
window-topology gate admits a SURFACE into a shared window, and a settlement enters no surface.
Wake-origin classification and attendedness describe a HUMAN's message, and a framework settlement
has no author. Ingestion taint seeding is the one gate with content behind it, and the taint plane's
own settlement branch already covers it. What was missing was IDENTITY, and identity is what this
adds.
🔴 **A settlement step installs its address from eve's EVENT, not from a tool call.** Through 0.54
eve gave authored code no STRUCTURED signal on the wake — `taskDeliveryId` never left the hook
payload, `payload.task` was stripped before the channel adapter ran, the delivery carried no
`deliveryMetadata`, and no `task.*` stream event existed — so the only thing that reached authored
code was the notification TEXT. 🔴 **eve 0.70 inverted that**: `task.started`, `task.settled` and
`agent.started` are all in eve's public `HookEventMap` (`public/definitions/hook.d.ts`), the
notification is gone, and OE no longer subscribes to the public `message.received` hook event at
all. OE reads the task id off eve's event and keys every consequence on rows it minted itself, so a
drifted shape finds no row rather than moving an answer — and because an event is eve-authored, the
forged-message case the text edge had to fence has no way in.
**A turn that still holds no address is one whose wake row is missing or expired.** `currentWakeId`
answers `undefined` for every uningressed turn that has adopted nothing: `reply` refuses under its
own `task-wake-unread` reason and names `no_reply`, and the turn's closing prose is dropped and
audited. No tool call can recover that address, and the copy no longer pretends one can. The `no-row`
outcome on the `unified.task_wake` row is where those turns are counted.

**binding stamp** — the platform identity one session carries for itself, so a turn that arrives
without one still binds its real surface. The bridge stamps it at `session.started` and
`turn.started`, and `bindFrom` reads it only when the live context resolves NO workspace and NO
surface. It is per-session `defineState`, so one session can never read another's.
Source: `packages/core/agent/identity/binding-bridge.ts` (the slot),
`packages/core/agent/identity/binding.ts` (`refreshBindingStamp`, `carriesPlatformIdentity`,
`bindFrom`'s bridged fallback), `packages/core/agent/hooks/binding-bridge.ts` (the hook).
🔴 **A stamp that names a surface may not be replaced by a context that names none.** A non-empty
attribute bag is not an identity. An INTERNAL WAKE — an approval decision, a redrive — carries the
`oe_*` window stamps and nothing of the platform's own (`team_id`, `channel_id`, `guild_id`, …), and
eve REPLACES a turn's whole bag from any delivery that brings one. Before this rule such a wake
overwrote the seat's stamp, and the turn bound the env stand-in partition instead of its surface:
the default egress policy, no connector grants, the wrong memory partition, spend filed off-surface,
and every `bindFrom(ctx).target.channelId` reader resolving nothing.
🔴 **The rule is a DOWNGRADE test, never "no identity, no write".** The stamp also carries the
attested fire creator and the unattended marker, which a fire's own identity-less tool contexts
recover through the bridge. A session with no surface established therefore still writes, exactly as
it did before the rule. Refusing every identity-less write would read a fire as ATTENDED — a
fail-open.
🔴 **The stamp names ONE platform, and the fence is what keeps it honest.** A standing window seat
can serve several platforms. An identity-less delivery is bridged only when it names the SAME
platform the stamp resolves, or when it names no registered platform at all (the classic case: a
`send()`-created session's tool contexts, which carry the synthetic `unified` kind). A mismatch
refuses the bridge and falls to the env stand-in — fail-closed to `external`, never a neighbouring
surface's grants.
🔴 **A session that never carried a surface binds nothing.** The stamp it holds names no surface,
so the bind falls to the env stand-in and the platform-aware default makes any real platform
`external`.

**delivery heal** — the stamp keeps ONE session right and reaches nothing else, because it is
per-session `defineState` and eve gives a native subagent child a NEW durable session. A child
inherits its parent's auth attribute bag verbatim and inherits nothing else, so on an identity-less
delivery it bound `<platform>/dev/default` — the env stand-in — while its parent bound the real
surface. The heal writes the established identity back onto THAT delivery's own bag at
`session.started` and `turn.started`, so the child's verbatim copy carries it.
Source: `packages/core/agent/identity/binding.ts` (`healDeliveryIdentity`, `subagentBindingLost`),
`packages/core/agent/hooks/binding-bridge.ts` (the hook), and
`tests/integration/tasks/child-binding-inheritance.test.ts` (the tier-2 proof).
🔴 **It restores, and it cannot escalate.** It runs only when the delivery names no surface at all,
it writes only keys the bag does not already carry, and the bytes it writes are that session's own
previously-established bag. It repeats the bridge's cross-platform fence, so a delivery naming
another registered platform is refused the write.
🔴 **It never copies a HOST STAMP** — no `oe_*`, no `open_everywhere_*`. Those describe THIS
delivery: its wake id, its per-delivery nonce, its grain, its addressing, its routine and fire
markers. A stale `oe_wake_id` is the cross-conversation address the wake-identity rules refuse, and
a stale routine marker would widen a live seat to the fire posture. Only the platform's own capture
(`team_id`, `channel_id`, `guild_id`, `user_id`, …) rides.
🔴 **A child that still has no surface is REFUSED, never run on the org default.** The heal depends
on a mutation of an eve-owned object surviving into the child — the same carriage the taint forward
leg uses, pinned by `scripts/native-subagent-test.ts` §D9. When it does not land, the hook fails the
child at `session.started` with a `binding.refused` audit row (`reason: subagent-binding-lost`).
That backstop is not the egress identical-binding invariant: the invariant asserts nothing when the
parent published no fingerprint, and a mis-bound child in that case used to run. The refusal fires
only when the child resolves a REGISTERED platform and still names no surface, so the local
stand-in stays reachable for `eve dev`, evals and unit contexts.

**gate tier** — a per-sink taint tolerance. A tool declaring `gate` is floored at a verdict of `ask`
on a tainted turn: no lowering may auto-approve it, so a human decides, and an unattended run denies
because the `unattended` transform runs last and reads that ask. `disclose` and an absent value are
indistinguishable in behaviour and only put a line on the card. The tools that declare `gate` are
exactly those that answer the **vector-1 predicate** with `arms` or `disarms` (below): the eleven
verbs that create, rewrite or remove instruction and execution surface a later run obeys.
Source: `packages/core/agent/access/approver-chain.ts` (`taintToleranceOf` / `taintToleranceOfRow`),
the `taint:ask` transform row in the same file.

**vector-1 predicate** — *does this tool arm, alter or remove surface that EXECUTES or INSTRUCTS
after the turn ends?* One level deeper than "consequential" (the effect escapes the *conversation*):
this asks whether the effect escapes the *turn*. Every tool answers it on its registry row, as
`postTurnSurface: "arms" | "disarms" | "templated" | "none"`, and `arms`/`disarms` require the
**gate tier** above. The answer is not optional and not a list somebody maintains: `lint:consequence`
reads the tree's real durable writes (adding a routine, writing a skill, applying an agent spec,
declaring a hook, minting an ingress secret) and fails the build on any tool that reaches one while
declaring nothing — the direction a hand-kept list of dangerous verbs rots in.
`templated` marks a tool that arms post-turn execution whose instruction text is a code literal the
model never authors (`subscribe_pr`); it carries no floor.
Source: `packages/core/agent/access/consequence.ts` (`postTurnSurface`, `POST_TURN_WRITE_PRIMITIVES`,
`checkPostTurnSurface`).
Not to be confused with: a **consequence tier** (`open`/`gate:member`/`gate:admin`), which is what a
tool costs on ANY turn. The taint tolerance is a separate column that only a tainted turn reads.

**ingestion kind** — the provenance label an ingestion site declares, and the only thing
`classifyIngestion` reads to decide a source tier. The vocabulary is closed in code, and a site passes
a kind rather than inlining a tier. Four kinds are worth naming here because their sources are easy to
misread:

- **`web`** — the fetch, search and browser verbs. Anything the open web returned.
- **`routine-event`** — a routine's event body: the hydrated entity a triggered fire is about, and the
  transcript read of an earlier fire.
- **`image-description`** — a model-authored description plus OCR of an image. It is the **model's**
  reading of a picture, not the picture, and it is untrusted for that reason.
- **`skill-declared`** — a sandbox skill script's self-declared external fetch: bytes the script says
  it pulled from outside.

Source: `packages/core/agent/access/taint-tiers.ts` (the kind union, and `classifyIngestion`).
Not to be confused with: a **source tier**, which is what a kind resolves to.

**ingestion route** — one site that binds inbound content to an ingestion kind, named
`<file>#<label>`. The routes are not a hand-kept list: `INGESTION_ROUTES`
(`packages/core/agent/access/ingestion-route-inventory.generated.ts`) is **generated**, regenerated by
the ingestion lint and pinned in the test chain, so a new site that declares no kind is a red build
rather than a silent gap. Each entry records the file, the declaration form, the kind, the label's
source text, and whether the kind is still a placeholder.
Not to be confused with: an ingestion **kind**, which several routes can share — the browser verbs and
the fetch verb both bind to `web`, and a routine's event body and its transcript read both bind to
`routine-event`.

**skill envelope** — the one sandbox-to-host taint delimiter contract. A skill script wraps bytes it
fetched, and the host extracts those segments out of the script's own standard output.
`extractSkillEnvelopes` (`packages/core/agent/access/skill-taint-envelope.ts`) splits the output into
trusted and untrusted segments, and it **can only ever add taint**: text outside an envelope stays
where it was, and an unterminated or malformed open marker is pushed through as ordinary text rather
than swallowing the rest. A forged close fails, because the nonce is minted after the content is
already in hand.
Not to be confused with: the **envelope** above, which is the host's own fence around external content.

**content origin** (declared) — what a connection declares about where its results come from, carried
from the access resolve to the model-call seam. `declaredContentOriginForConnection`
(`packages/core/agent/access/connector-content-origin-state.ts`) is keyed per connection, then per
tool, and answers `undefined` on any gap. Resolving a qualified tool name matches the **longest**
declared connection prefix rather than the first `__` separator, because a connection slug may itself
contain one; the federated search tool never matches, because one call can aggregate several
connections.

**taint disclosure** — the line an approval card carries when the turn that raised it ingested
external content. `withTaintDisclosure` (`packages/core/agent/approvals/taint-disclosure.ts`) is
applied at the three summarize call sites rather than inside any one action kind, so it survives a
re-render and **no new kind can forget it**. It reads both the frozen argument taint and, on a live
render, the turn's own taint, and it appends the ingestion kinds where a disclosure line is already
present rather than repeating one.

**result reduction** — the deployment-registered arm that shortens an oversized tool result.
`reduceResultBody` (`packages/core/agent/access/result-reduce.ts`) returns a body already inside the
limit untouched, and falls back to the **built-in truncation** on every abstention: no registered arm,
an arm that answers nothing, an arm that throws, and an arm that times out. Whatever the arm does
return is capped again, so the arm's output can never exceed the built-in cap.

---

## 4. Approvals

**consequence tier** — what a tool costs: `open`, `gate:member`, `gate:admin`. Declared per tool in
the registry, checked by CI against the tool's live gating.
Source: `packages/core/agent/access/consequence.ts#ConsequenceTier`.
Not to be confused with: a **verdict** (what the chain ANSWERS about one prospective call). The
ticket vocabulary "auto-approve / ask / deny" names neither of these exactly — say "tier" for the
registry's three values and "verdict" for the chain's four.

**verdict** — what one approver element may answer: `allow`, `deny`, `ask`, or `undefined`
(= defer down the chain). `deny` is absolute and order-independent; no transform may lift it.
Source: `packages/core/agent/access/approver-chain.ts#ApproverVerdict`.
Not to be confused with: a **tier verdict** (`ConnectorOpTierVerdict` — a tier plus its **tier
basis**), which is what the connector-op CLASSIFIER answers before the chain runs at all. Two planes,
two senses of one word: say "verdict" unqualified only for the chain's four answers, and always
write "tier verdict" for the classifier's.

**level order** — the code-pinned order that resolves a positional `allow`/`ask`:
`custom` → `surface` → `classifier` → `registry`. Config fills slots; config cannot reorder levels.
Source: `packages/core/agent/access/approver-chain.ts#APPROVER_LEVEL_ORDER`.

**element class / clamp** — an element's class bounds the verdicts it may express. Connector-supplied
and remote elements are raise-only unless config grants `mayAllow`; the registry is terminal and may
not defer.
Source: `packages/core/agent/access/approver-chain.ts#ElementClass`, `packages/core/agent/access/approver-chain.ts#ELEMENT_CLAMPS`.

**classifier** — 🔴 **CODE, not a model.** Two things carry the name, and both are deterministic
TypeScript: the connector-op verb classifier (read verbs open, everything else gated, fail-safe to
gated), and the `classifier` LEVEL/CLASS slot an operator fills with a reviewed function in bundle
config.
The verb classifier reads the **verb segment only**. A qualified tool name is
`<connection>__<verb>`, and a connection slug may itself contain `__` (the plugin extractor mints
`<plugin>__<server>`), so the verb is the LAST segment. Only that segment may put an op in the
`read` tier. The segments before it may RAISE the tier and never lower it. A name whose shape does
not parse has no verb, so it classifies `destructive`.
The one input besides the name is the org-admitted MCP server's own tool annotations
(`readOnlyHint`, `destructiveHint`). A hint decides only where the verb segment named no recognised
verb; where it named one, the stricter of the two wins
(`packages/core/agent/access/consequence.ts#classifyConnectorOpTierVerdict`).
The HEAD segment is read in ONE case only: when the verb starts with it, so the hosted-vendor prefix
strip fires (hosted MCP servers re-prefix their ops — `notion__notion-fetch`). The tokens that strip
removes are then fed back RAISE-ONLY, so a connection whose slug spells a verb cannot delete that
token from its own ops: `delete__delete_search` classifies `destructive`, and `notion__notion-fetch`
keeps its `read`. A head that spells a READ rescues nothing — `get__get_frobnicate` is still
`destructive`. 🔴 An UNSTRIPPED head stays inert, and raises nothing: `delete__query` classifies
`read`, because a `delete`-named connection does not gate an op whose verb it does not prefix.
Pinned by `scripts/connector-op-tier-test.ts`.
Source: `packages/core/agent/access/consequence.ts#classifyConnectorOp`, `packages/core/agent/access/consequence.ts#classifyConnectorOpTier`, `packages/core/agent/access/consequence.ts#classifyConnectorOpTierVerdict`, `packages/core/agent/access/consequence.ts#parseQualifiedToolName`;
`packages/core/agent/access/approver-chain.ts#ApproverLevel`, `packages/core/agent/access/approver-chain.ts#ElementClass`.
Not to be confused with: the **approval judge**. Reading "classifier" as "a model decides the tier"
produced a wrong objection on 2026-08-13.

**tier basis** — WHY the connector-op classifier reached a tier: `destructive-verb`, `write-verb`,
`read-verb`, or `unrecognised`. It reports what the VERB SEGMENT found, head-prefix tokens included.
The raise-only CONNECTION-PATH pass may lift the TIER above the basis and never rewrites it —
`acme__delete__query` is `destructive` on a `read-verb` basis. The distinction it exists for is
inside the gated half: a KNOWN irreversible verb and a verb the lists do not recognise both classify
`destructive`, and only the basis separates them, so a caller must not call the second one a delete.
Source: `packages/core/agent/access/consequence.ts#OpTierBasis`, `packages/core/agent/access/consequence.ts#ConnectorOpTierVerdict`.

**arm** — a decision function on a seam. The **built-in arm** is the one Open Everywhere ships; a
**consumer arm** is a function a deployment registers in a slot on `AppConfig`; a **model arm** is a
consumer arm that happens to call a model. Absence of a consumer arm is not a state — it IS the
built-in, byte for byte. An arm fails closed to the built-in: an abstention, an out-of-vocabulary
answer and a throw all leave the built-in's answer standing.
Most slots are empty until a consumer fills one. The connector-op tiering slot is the exception and
ships FULL: `registerConfig` puts `defaultConnectorOpTierArm` — the verb classifier wearing the
slot's signature — on it, so the built-in there is a REGISTERED DEFAULT rather than a fallback, and a
consumer arm REPLACES that value. This repository REGISTERS no model arm on any seam. It ships one as
a building block — `reduceResultFromCompletion` on the result-reducing seam
(`packages/core/agent/access/result-reduce-model-arm.ts`) — which a consumer wires itself; read that
module's own header before you do.
🔴 A seam's floor covers the specific thing its built-in recognises; it does not make an arm
harmless. On the audit-scrub seam the enforced property is that no built-in credential shape
survives an arm — an arm may still add, replace or delete other text. On the connector-op tiering
seam an arm may LOWER a verdict, floored at `write`, so no arm can put an op in the open tier — but
a lowered delete does become session-skippable. State a floor exactly.
Source: `packages/core/agent/access/config.ts#auditScrub` (the first slot);
`packages/core/agent/audit/tool-action.ts#builtInAuditScrub`, `packages/core/agent/audit/tool-action.ts#scrubForAudit`;
`packages/core/agent/access/connector-op-gating.ts` (`ARM_TIER_FLOOR`, `connectorOpTierParts`);
`packages/core/agent/access/consequence.ts` (`ConnectorOpTierArm`, `defaultConnectorOpTierArm`);
`docs/extending/drop-in-arms.md`.
Not to be confused with: a **classifier**, which is code and only code. An arm is the EXTENSION
POINT, so it may be a model consult — which is exactly why it must not be called a classifier.
Also not an **adapter**: an adapter swaps a backing, an arm extends a judgement.

**approval judge** — the ONE model in the approval plane. It runs only on rows an operator has
flipped `ask → defer`, only in `enforce` mode (the shipped `approvals.judgeMode`), and every judge
failure resolves to `ask`. An enforced allow must cite one of the scope's authored pre-approval
rules; an uncited allow resolves to `ask`. Admin acts and memory erasure never reach it. A cached allow
answers only for the same arguments, requester and attendance. Of the connector ops, only a
write on the domain's credential in an attended, clean turn reaches it, and an allow covers that one call.
Source: `packages/core/agent/access/approval-judge.ts#approvalJudgeMode`;
`packages/core/agent/access/consequence.ts#judgeDeferredTool`.

**DM rule** — a pre-approval rule a person confirmed from an approval card in their own Slack DM with
the agent, with "Approve, and allow things like this" (OPE-2456). Code writes its sentence from the
card's frozen act (the tool, the kind of action, the kind of object), and the person reads it in the
button's confirmation dialog first. It applies at once, only to acts its owner asks for in that DM,
and the person removes it under "Your rules" in the Home tab. The judge still decides each act
against it: it is a rule, never a grant.
Source: `packages/core/agent/approvals/allow-rule.ts#allowRuleProposalForRow`,
`packages/core/agent/approvals/allow-rule-apply.ts#dmRulesForProposal`.
Not to be confused with: a **session grant**, which skips the card with no judge at all, and which a
conversation never keeps (OPE-2363); or a **domain rule**.

**domain rule** — the same option in a Slack room of exactly one domain. The confirmed rule opens a
pull request that adds or widens one line of the app's `agent/access/domain-rules.ts`, naming who
asked and from which card. It applies only after an admin merges it, as a rule bound at that domain's
scope.
Source: `packages/core/agent/approvals/allow-rule-pr.ts#executeDomainRulePr`,
`packages/core/agent/access/domain-rules.ts#domainRuleBundles`.

**defer-model** — the arrangement above: a registry row declares `judgeDefer`, and only that residue
reaches the judge. The verdict is final, including a deny, and each consult is audited.
Source: `packages/core/agent/access/consequence.ts#deferToJudge`, `packages/core/agent/access/consequence.ts#judgeDefer`.
Not to be confused with: a **verdict** of `undefined`/`defer` from an element, which is silence, not
a judge consult.

**transform** — a POST-resolution arrow that may only move `allow` or `ask`. Four stages, in this
fixed order: `mode` → `taint` → `floor` → `unattended`. A `deny` skips the pipeline entirely.
`unattended` runs LAST on purpose: it turns any surviving `ask` into a `deny`, including one the
taint floor or the beneficiary-clicker floor has just produced, so no run without a human can be left
holding a card nobody can click.
Source: `packages/core/agent/access/approver-chain.ts#TransformStage`, `packages/core/agent/access/approver-chain.ts#TRANSFORM_STAGE_ORDER` (the order, and its doc comment says it in prose), `packages/core/agent/access/approver-chain.ts#TRANSFORM_TABLE`.
Not to be confused with: an **element**. An element holds an opinion at a level; a transform edits
the resolved answer.

**approval mode** — a domain's blanket policy: `DANGEROUSLY_BYPASS`, `APPROVE_ALL`, `DENY_ALL`.
Config-as-code only; there is no runtime toggle. Bypass disables CARDS and nothing else.
Source: `packages/core/agent/access/approver-chain.ts#ApprovalModeName`.

**attended / unattended** — 🔴 **defined by the ABSENCE of an acting principal, never by
`sessionMode`.** `actingPrincipalId(binding)` is undefined on an unattended fire. `principalId`
itself is NOT: a routine fire binds its routine's attested creator, so it stays the honest answer to
WHO for audit, the spend ledger and a card's "asked by" line. An ordinary fire runs at grain
`thread` and mounts the full ungated kit, so a `sessionMode` test would miss it entirely. Every
approval site derives the value from one function — `access/request.ts` `unattendedOf(ctx)`, or its
binding-taking twin `identity/binding.ts` `unattendedFrom(binding)` — and `lint:principal-gate`
rule 5 refuses any other spelling. `requestApproval` defaults it to `true` when a caller passes no
`chain` bag: absence of the signal means nobody is watching.

**The derivation FAILS CLOSED over three independent facts**, so no single lost attribute can make
an autonomous run read as attended (`identity/binding.ts` `unattendedDelivery`): the
`oe_fire_unattended` stamp, the routine marker `open_everywhere_routine_id`, or eve's own schedule
auth (`app` / `eve:app` / `runtime`). The last arm needs no OE attribute at all, so it holds even
when the whole fire bag is missing. A live human turn carries none of the three.
Source: `packages/core/agent/access/approver-chain.ts#principalId`, `packages/core/agent/access/approver-chain.ts#unattended`; the transform at `packages/core/agent/access/approver-chain.ts#TRANSFORM_TABLE` (the `"unattended"` row); the derivation at `packages/core/agent/access/request.ts`.
Not to be confused with: **invoker posture**, which splits the unattended world further into
`untrusted-remote`, `unattended-fire` and `attended-fire`. An `attended-fire` still has no acting
principal in the chain's sense.

**session grant** — the routine's standing grant: the memo that the middle button of a routine's
`pr.open` card writes, "Approve for this routine (up to N h)". A human gives it by clicking ONE card a
fire raised. It covers later fires of THAT ROUTINE for `pr.open`, and it ends when it expires
(`approvals.routineGrantTtlHours`, 24 h by default), when `revoke_session_grants` deletes it, or when
an `edit_routine` moves the routine's key. Only a routine's `pr.open` card has the middle button. A
card in a conversation (a thread, a DM, the top level of a channel) offers Approve and Reject only,
and its click approves one act and keeps nothing (OPE-2363). Repeated approvals in a conversation are
the approval judge's job. Every injection-gate kind stays strictly per-call.
Source: `packages/core/agent/approvals/session-grant.ts#sessionGrantKind`,
`packages/core/agent/approvals/session-grant.ts#grantableFrozenKey` (only a routine key grants).

**declared permission** — the same predicate keyed on a ROUTINE instead of a session. ONE declared
permission names ONE MCP tool, or the `pr.open` shape — `routinePermissionKind` admits that one bare
kind beside the `tool:` declarations. A human reads the set the model proposed, rendered on the routine's
creation card, and clicks; a later permission card can add one more the same way. The row is
standing and survives until the routine's text is edited or the permission is revoked. A creation
card may declare at most six.
Source: `packages/core/agent/approvals/session-grant.ts#routinePermissionKind`,
`packages/core/agent/routines/declared-permissions.ts` (the read/write/revoke seam),
`packages/core/agent/routines/routine.ts#routinePermissionKey` (the standing key).
🔴 **Never call it a grant.** The word belongs to the two planes below, and the overload produced
cross-plane confusion in review twice in one day (OPE-1303). Nothing is
lent to a routine: it holds what a human wrote on its card, not somebody else's authority.
Not to be confused with: a **session grant** — the routine's standing grant. That one is given by a
click on the middle button of one `pr.open` card a fire raised, and it expires on a clock. A declared
permission is written on the routine's creation card (or a later permission card), names one tool or
the `pr.open` shape, and has no clock. The middle-button label
(`packages/core/agent/approvals/session-grant.ts#grantButtonLabel`) belongs to the session grant
alone and labels only the `pr.open` middle button; or a **credential grant**
(section 6) — the difference is whose authority is spent.

---

## 5. Scope

**scope** — a binding's address. Four rungs of increasing specificity, plus two off-ladder personal
levels:

```
org  <  tenant  <  domain  <  surface        (+ group < principal, the DM universe)
```

Source: `packages/core/agent/access/bundle.ts#ScopeLevel`, `packages/core/agent/access/bundle.ts#L13` (the ladder, in prose),
`packages/core/agent/access/bundle.ts#Scope` (the `Scope` shape).

| Level | What it names | Form |
|---|---|---|
| `org` | the root; matches every request | — |
| `tenant` | one vendor tenant | `platform/<tenant-id>` |
| `domain` | every surface in a declared memory domain | bare name |
| `surface` | one container (channel, repo, team, page) | `platform/<tenant-id>/<container-id>` |
| `group` | a named set of humans; DM universe only | bare name |
| `principal` | one person's own scope; DM universe only | `platform/<principal-id>` or `linkSet:<id>` |

**off-ladder** — `group` and `principal` never co-resolve with the container ladder. A service
bundle grants nothing in a DM, and a `principal` or `group` binding grants nothing in a channel.
Source: `packages/core/agent/access/resolver.ts#scopeMatches` (`group` and `principal`
return `false` for every container request), `packages/core/agent/access/resolver.ts#resolveAccess` (the DM branch, the only place either
level is applied).
Not to be confused with: narrowest-wins ordering on the container ladder. The personal levels are a
separate universe, not a fifth and sixth rung of the same one.

**platform-qualified** — `tenant`, `surface` and `principal` ids all carry a platform prefix,
because six vendors' bare ids share no namespace and at least one is user-chosen. `domain` and
`group` stay bare, being cross-platform by construction.
Source: `packages/core/agent/access/bundle.ts#L14` (the rule, in prose), `packages/core/agent/access/bundle.ts#TENANT_KEY`.
The address lives on the BINDING, not the bundle: `packages/core/agent/access/bundle.ts#assertBindingsValid` refuses an
unqualified tenant and an unqualified principal, the second through
`packages/core/agent/identity/principal-key.ts#PRINCIPAL_KEY`.

**channel key** — the address the MODEL uses for a container, as against the `surface` scope above,
which is the address a HUMAN writes in config. It is one opaque string: `ch_` followed by base64url
of `<platform>:<container-id>`. The wake envelope's `<channel id>` carries it, and a read result
names the container by the same key, so the agent holds exactly one name for a place it wakes in,
replies to and reads from. It is not an ARGUMENT to anything: the chat read verbs take no target
(see **container fence** below).
Source: `packages/core/agent/channels/channel-key.ts`.

🔴 **A channel key is an address, not a secret and not a capability.** The encoding is reversible on
purpose — a reversible key needs no stored directory, so it resolves on a cold session and for a
container no config row ever named. Holding one grants nothing: a read still passes the
window-sources gate, the per-turn origin fence and the domain channel allowlist, exactly as it did
when the model passed a raw vendor id.

Not to be confused with: the vendor-artefact tools. `read_notion_page` and `read_linear_issue` keep
their vendor nouns, because a page and an issue are vendor objects rather than places the agent
lives. The key addresses the SURFACE plane only.

---

## 6. Connector, catalogue, grant — and the one meaning "provider" keeps

🔴 **"Provider" does not name anything on the access plane.** It means a **provider package**
(`packages/providers/*`) and nothing else. The access plane used to carry a second noun of that
name, sitting beside the connection slug it pointed at, and two nouns for one thing grew two grant
grammars on top of them — which is how `request_access grant-connector` came to refuse a connector
that was granted and mounted (OPE-580, measured). OPE-591 deleted the noun.

**connector** — one host-side MCP connection, addressed by its eve connection slug. The slug is the
filename of `agent/connections/<slug>.ts`, and it is the same string a grant's `name` carries, a
credential catalogue's `connector` field carries, and `EffectiveAccess.connectors` lists.
Source: `packages/core/agent/access/bundle.ts` (`ConnectorGrant`).
Not to be confused with: an **egress connection** (`Bundle.connections`), which is the firewall
plane — a host allowlist with a credential stamped at the sandbox boundary, not a tool surface.

**credential catalogue** — the identities an operator configures against ONE connector, plus the
allowlist of credential types that connection accepts. One catalogue per connector; the validator
refuses a second one for the same slug.
Source: `packages/core/agent/access/connector-credentials.ts` (`ConnectorCredentials`),
`agent/access/connector-credentials.ts` (this deployment's).

**connector grant** — `{ name, credential, contentOrigin }` on `Bundle.connectors`. The ONE grant
grammar. `credential` is **mandatory** and has no default: a connector with exactly one configured
credential still names it, and a grant whose credential does not resolve grants **nothing at all** —
not the connector without its identity.
Source: `packages/core/agent/access/bundle.ts` (`ConnectorGrant`, `assertBundlesValid`),
`packages/core/agent/access/resolver.ts` (the one expansion pass).
Not to be confused with: a **plugin's** connector list, which is bare slugs by its own vocabulary —
those connections carry no credential binding and no content-origin declaration, and fall back to
their own static `secretRef`. Also not a **credential grant**, below — that is a person-to-chat row,
not a bundle declaration.

**credential grant** — one person's approval that a named SCOPE may spend THEIR credential, for ONE
vendor MCP tool, fixed to named arguments, until a stated time. The owner approves it in their own
DM; the grantee is a conversation rather than a person, so owner == requester is the degenerate case
rather than a second plane. An approved grant mounts one tool named
`grant__<owner>_<connector>__<tool>_<target>` on the WORKERS that conversation delegates to (OPE-2023
— never on its seat), and that tool's `execute` is the BROKER.
The MODE the owner taps decides the scope: `once` and `session` bind to the asking CHAT and die with
it, and `standing` binds to the room's OWNER and DOMAIN, so it survives the seat rotations inside its
expiry (see [Credential grants](./capabilities/connectors-and-providers.md#credential-grants--lending-one-vendor-tool-fixed-to-named-arguments)).
It never widens past that one axis: one org, one owner, one connector, one vendor tool, one frozen
argument set, all on the row.
The arguments the grant fixed are PINNED AND VISIBLE in the mounted schema — the vendor's own schema
with each fixed argument narrowed to one allowed value by JSON Schema `const`, and required. The
model supplies them and an MCP-layer FENCE validates the outgoing call against the row, refusing
anything else before the call reaches the vendor. The transport injects nothing: a merge there would make
the fence compare the row against a copy of itself.
At most one live grant exists per (owner, connector, tool, fixed arguments, chat) — the same tool
fixed two ways is two decisions the owner made. The target label keeps the two mounted names apart,
and a row-id fragment is appended only when two grants would spell one name.
The row's `tier` is decided at MINT by `classifyConnectorOpTier` over the vendor's own tool name —
byte-identically to the owner's own DM — and is never re-derived from the mounted name. The mounted
name's own classification is a SEPARATE answer: its verb segment carries the requester's target
label, and the mint's read-only bound is what keeps that label from talking the name into a lower
tier than the tool deserves.
The vendor tool and its argument schema are read from the owner's LIVE connection when they press
Approve, under their own token: a tool their account does not publish closes the request.
A revoked, expired or spent grant bound to THIS CHAT keeps its tool MOUNTED and refuses, naming the
boundary — a tool that vanished between steps would be unexplainable to the model reading its own
transcript. A `standing` grant bound to the room's DOMAIN is read by conversations that never saw it,
so that one stops MOUNTING once it is revoked or expires.
🔴 **Not to be confused with a routine's declared permission** (section 4), and the difference is
WHOSE authority is spent. A credential grant LENDS one person's own credential to a chat, bounded by
their deadline. A declared permission lends nothing: it is what a human wrote on a routine's creation
card, and the routine spends the deployment's own access. Spending the word "grant" on the routine
plane produced cross-plane confusion in review twice in one day (OPE-1303).
The broker names the vendor tool the row lends; a REGISTERED BORROW TRANSPORT drives it, under the
owner's own credential. CORE registers that transport, one generic arm for every connector the
deployment admits grants for — a provider package registers nothing on this plane. Core also answers
WHOSE credential: the owner's OAuth vault subject, derived by the same composer their own
authorization wrote through.
Every successful call posts a host-authored `acting as <owner>` line into the room itself, and the
FIRST call on a grant DMs the owner — the model authors neither and can suppress neither.
The mount answers `session.started` AND `turn.started`, so an approved grant is CALLABLE by the next
worker that the chat that asked for it hands work to (OPE-2023). The seat itself never holds the
tool. No deploy, no rotation and no new session is needed (OPE-1089). The session
arm stays because eve's cold-heal check reads the session-scoped tool metadata alone.
Source: `packages/core/agent/operational/credential-grant-rows.ts`,
`packages/core/agent/access/credential-grant.ts`,
`packages/core/agent/access/credential-grant-broker.ts`,
`packages/core/agent/access/credential-grant-notice.ts`,
`packages/core/agent/access/credential-grant-owner.ts`,
`packages/core/agent/tools/grant_tools.ts`.
Not to be confused with: the **member plane**, which serves the ASKER'S OWN credential and carries
no row at all, because "another person cannot use my credential" is structural there. A credential
grant deliberately relaxes exactly that invariant, and the ask/grant lifecycle is the fence that
structure used to be.

**where "provider" still reads correctly** — a provider PACKAGE (`packages/providers/notion`), a
MEMORY provider (a silo's backing: `{ provider: "postgres" }`), a MODEL provider (a gateway route),
an OAuth provider (an identity provider's authorization server), an identity DIRECTORY provider (an
IdP's SCIM/OIDC role, `identity/directory-sync.ts`), and `ConfigPrProvider`
(`credentials/config-pr.ts`) — the swappable GitHub/GitLab/Gitea mechanism that opens a config-repo
PR. None of these names a connector. The credential-CUSTODY plane is NOT in this list: its persisted
field names — `credentials/ref.ts`'s `db:<connector>:<credentialId>` ref grammar, the
`credential_intake`/`stored_credential` rows, and `credential-bindings.generated.ts`'s override
grammar (`CredentialBindingOverride.connector`) — all say `connector`. The two DB columns carry
guarded rename migrations; the override grammar does NOT (the loader refuses the old `provider`
key outright — safe today because the tracked overlay is empty, so a self-hoster with a non-empty
overlay must rename the key by hand).

## 7. The person's browser

**personal browser** — ONE person's own Chromium with a PERSISTENT profile, so the sites they sign in to
stay signed in across turns and days. It runs in a long-lived box on the deployment's own sandbox backend
(a persistent Vercel Sandbox, or a docker container on a named volume), and only the person's own internal
DM reaches it. Its row key is the ACTING person, read from the binding.
Source: `packages/core/agent/personal-browser/policy.ts` (`personalBrowserRefusal`),
`packages/core/agent/personal-browser/lifecycle.ts` (`ensureBrowserOpen`).
Not to be confused with: the **browser QA kit** (`browser_*` tools), a headless browser inside one
conversation's sandbox that keeps nothing between conversations and may carry an org credential.

**take-over lock** — who may send input to a person's browser: `agent` or `person`. While the person holds
it, every agent action is REFUSED, not queued: the app re-reads it before each command, and the box refuses
an agent command too, once the app has told it. It returns to the agent by the person's hand-back card, by
Hand back on the watch page, or when the hold expires.
Source: `packages/core/agent/personal-browser/lifecycle.ts` (`personHolds`, `takeOver`, `handBack`).

**watch page** — the deployment's own page where a person watches their browser and takes its controls.
A single-use link (audience `browser-view`) starts ONE watch session (audience `browser-session`, a
cookie).
Source: `packages/core/agent/personal-browser/viewer.ts` (`handleViewPost`, `handleLiveInput`).
