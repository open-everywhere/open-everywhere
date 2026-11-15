# Personal browser: your own browser, which keeps your logins

A person asks OE in their direct message to use **their own browser**: "check my order status on
shop.example.com", "open my browser". OE drives a real Chromium whose profile **persists**: the sites the
person signs in to stay signed in across turns and across days, until the site's own session ends or the
profile expires unused. The person can **watch** the browser live from a private link, **take the
controls** for a sign-in, a 2FA code, a CAPTCHA or a decision, and **hand them back**.

The browser runs in a **long-lived box** on this deployment's own sandbox backend (see
[Sandbox → Long-lived boxes](../extending/sandbox.md#long-lived-boxes)): one persistent Vercel Sandbox per
person on the hosted stack, one docker container on a named volume per person on the self-host stack. No
third-party browser vendor holds the profile.

The personal browser is **off** as shipped.

It is a different thing from the [browser QA kit](./browser-qa.md): that kit is a headless browser inside a
conversation's own sandbox, for testing the deployment's declared sites with org credentials, and it keeps
nothing between conversations. The personal browser is one person's own, holds only their own logins, and
never uses an org credential.

## How a person uses it

All of it happens in the person's **own direct message** with OE. The conversation seat forwards the job,
and the worker calls two tools.

| What the person asks | Tool and action | What happens |
| --- | --- | --- |
| "Open my browser" | `my_browser` `open` | OE starts the person's box (or reuses the live one). Earlier logins are still in it. |
| "What does my order page say?" | `my_browser` `go`, `look` | OE goes to the page and reads its text and its elements. Reading needs no card. |
| "Cancel that order" | `my_browser` `click`, `type`, `select`, `key` | The FIRST click or keystroke on a site posts a `browser.personal.act` card into the DM. When the person approves it, OE may click and type on that site for `actGrantMinutes`. |
| "Which sites am I signed in to?" | `my_browser` `sites` | The cookie DOMAINS in the profile. Never a cookie value. |
| "Show me my browser" | `my_browser` `watch` | OE host-posts a private, single-use link into the DM. |
| A sign-in, a code, a CAPTCHA | `my_browser_handoff` | OE gives the person the controls, posts the link, and posts a `browser.personal.handback` card. |
| "Close my browser" | `my_browser` `close` | Chromium closes cleanly, the box stops, its hours are billed. The logins stay. |
| "Forget my browser" | `my_browser` `forget` | OE deletes the box's saved profile on the backend (every login in it) and the person's record. |
| "Let me show you how I cancel an order" | `my_browser_handoff` with `teach` | OE gives the person the controls and records their demonstration. The hand-back saves a paused draft. See [Teach a task by demonstration](#teach-a-task-by-demonstration). |
| "Show me the draft", "Test it", "Propose it" | `my_browser` `drafts`, `rehearse`, `propose`, `discard` | OE shows the draft as a `SKILL.md`, rehearses it without a click, or posts a `browser.personal.propose` card whose owner-only click opens a skill pull request. |

**Secrets are the person's.** OE never types into a password, one-time-code or card field: the box refuses
it whatever a card says. When a page needs one, OE hands the person the controls, and the person types it on
the watch page. The value passes through the deployment on its way to the box, and OE writes it nowhere: no
audit row, no log, no transcript.

## Teach a task by demonstration

A person can teach OE a task by doing it once in their own browser (OPE-2454). OE writes a **draft skill**
from the demonstration. The person reads it, tests it, and proposes it by pull request.

1. **The person starts it.** They ask in their DM ("let me show you how I file an expense"). The worker calls
   `my_browser_handoff` with `teach: { name, goal }`. The name is the skill's name: letters, digits, dots,
   dashes and underscores, at most 64 characters. OE starts the recording on the box BEFORE it gives the person
   the controls. So a bad name, a name already in use or a sixth draft refuses before anything changes hands.
2. **The person does the task.** They use the watch page as for any hand-off. For up to **ten minutes** (or 200
   steps), the box records one step for each input: the page address, and the role and label of the link,
   button or field they used. A navigation between inputs becomes an "arrive" step (its address only, never
   the page title).
3. **The hand-back ends it.** The owner's click on the hand-back card, Hand back on the page, or an expired hold
   stops the recording. OE saves a **taught draft** on the person's row. The person's own `close` also saves
   what they recorded so far.
4. **The person reviews it.** `my_browser` `drafts` lists the drafts, and `drafts` with a `name` shows one as a
   `SKILL.md`. The file numbers the steps and quotes each label as data. It marks four kinds of gap with
   `GAP:`: what to type in each typed field, the inputs, the decision rules and the failure handling.
5. **The person test-runs it.** `my_browser` `rehearse` is the **test run**. It goes to each recorded page and
   looks for each recorded link, button and field, and it clicks, types and presses nothing. It reports what it
   found, what it did not find, and what it did not check. A page that the demonstration reached by a form post
   can show as not found, because the rehearsal opens each page by its address. Opening a page is a GET in the
   person's signed-in session: a site that acts when a page is opened (an unsubscribe or a confirm link) acts
   then.
6. **The person proposes it.** `my_browser` `propose` posts a `browser.personal.propose` card into the DM. Only
   the owner's own click opens the pull request: another member's click, or an approver-chain lowering (a config
   rule, the judge, a bypass), throws. The pull request goes on the config repo, on the same path as the dream
   cycle's [skill proposals](skills-and-plugins.md#the-agent-proposes-a-skill-the-learn-loops-pull-request).
   The file goes under `.agents/skills/<name>/SKILL.md`, and merging is what arms the skill. The same switches
   apply: `memory.skillProposalPr`, `accessRequests.configRepo` and `loadAccessRequests().dryRun`. A second proposal
   of the same draft updates its own pull request.

**What the demonstration never records.** It never records the text the person types into a field: a text input
records the FIELD, an editable element (a text field, a textarea, a rich-text editor) is named from its label or
placeholder and never from its contents, and a secret field (a password, a code, a card) is marked so. A page
address drops its query and its fragment, and no page title is kept. The `browser.personal.teach` audit rows
carry counts only, never a label, an address or the goal.

**What the draft does hold.** The labels of the links, buttons and fields the person used, and the page paths,
read from their signed-in sites. A link's label can name private data ("Message from Jane: salary"). A label can
also repeat text the person typed (an autocomplete option, a search suggestion). A path can carry an id, a name or
a token (`/orders/1042`, `/reset-password/<token>`). So the draft is fenced as untrusted content when the agent
reads it, and a proposal needs the owner's own click on its card. A proposal puts the labels and paths in the
config repo, where its readers see them: the person reads the draft before they approve.

**The draft is paused, and it stays paused.** Nothing runs a draft on its own, and OE does not make a routine
from it. The person's browser refuses a routine fire, because it needs the person in the conversation
([the room rule](#where-it-may-be-used--the-strictest-room-rule)), so a scheduled run of a taught task would
refuse every time. To run the task, the person asks in their DM. Each first click or keystroke on a site still
needs their `browser.personal.act` card. A person keeps at most five drafts. The sixth is refused, never evicted:
the person discards or proposes one first. `forget` deletes every draft with the row.

## The watch page

`my_browser` `watch` and `my_browser_handoff` host-post a link like `https://<deployment>/browser/v1/view?t=…`
into the person's DM. The link is never in a tool result, so the model never sees it.

1. Opening the link shows one button, **Open my browser**. The page consumes nothing, so a link unfurler or a
   mail scanner that fetches the URL cannot spend the link.
2. The button spends the link (it works **once**, within **10 minutes**) and starts one **watch session**: an
   `HttpOnly`, `SameSite=Strict` cookie on `/browser/v1/` that lasts **one hour**.
3. The live page shows the browser (a picture of the page about once a second) and who has the controls.
   **Take the controls** gives them to the person; **Hand back to the agent** returns them. While the person
   has the controls, a click on the picture, typed text, a special key, a scroll, the address bar and Back
   go to the box.

Whoever opens an unspent link, or holds the cookie, can watch the person's signed-in browser and take its
controls. That is why the link goes only to the person's own DM, works once, and expires; why the GET page
spends nothing; why every state-changing request needs the `x-oe-pb` header (a cross-site form cannot send
one); and why `forget` ends every session. Every failure on these routes renders the same 404.

The routes need the credential vault (`OE_CREDENTIAL_ENCRYPTION_KEY`), where the page signing key mints
itself on first use, and a public URL (`OE_PUBLIC_BASE_URL`, or the Vercel production URL). The
[credential intake page](../security/credentials-and-planes.md) uses the same key and the same URL.
Without them, `watch` and `my_browser_handoff` refuse and post nothing. Before 0.9.0 these routes read
the key only from an `OE_INTAKE_PAGE_SIGNING_KEY` env var, so they stayed dark on a deployment whose key
lived in the vault (OPE-2650).

## The take-over lock

One lock per person decides who may send input: `agent` or `person`.

- While the **person** holds it, every agent action is **refused, not queued** — a read included. The check
  runs twice: the app re-reads the lock right before each command, and the box itself refuses an agent command
  once it knows the person holds the controls (the app tells the box at each take-over and hand-back, best
  effort). The one gap: a command that passed the app's re-read just before the take-over, and reaches the
  box before the box hears of it, still runs.
- The person takes it on the page, or the agent hands it to them with `my_browser_handoff` (with a reason, for
  example "sign in to your mail").
- It returns to the agent when the person approves the hand-back card, presses **Hand back** on the page, or
  holds it longer than `takeoverMinutes` (the sweep returns it).
- The hand-back card's decision wakes the person's DM seat when it is live, so OE carries on. A hand-back on
  the page posts a note into the DM instead; the person tells OE to carry on.

## Turn it on

1. **Build and publish the image** from [`deploy/personal-browser/`](../../deploy/personal-browser/README.md):
   push it to your Vercel Container Registry on the hosted stack, or build it where the docker daemon runs.
2. **Declare the policy** in `agent/personal-browser/policy.ts`:

   | Field | Meaning | Shipped |
   | --- | --- | --- |
   | `enabled` | The master switch. | `false` |
   | `box.image`, `box.vcpus`, `box.memoryMb` | The image and its size. | `oe-personal-browser`, 2, 4096 |
   | `box.dockerNetwork` | docker only: the network the app and the box share. Absent, the box publishes its port on 127.0.0.1 only. | — |
   | `sessionMinutes` | The hard cap on one live session of the box (at most 24 h). | 120 |
   | `idleMinutes` | The box stops after this long with no agent action and nobody watching. | 15 |
   | `keepLoginsDays` | How long the profile survives with no use (1 to 90). | 30 |
   | `takeoverMinutes` | The longest the person holds the controls. | 30 |
   | `actGrantMinutes` | How long one act approval for one site lasts. | 60 |
   | `judge` | Whether the approval judge decides one browser step: `off`, `shadow` or `enforce` ([below](#the-approval-judge)). | `off` |
   | `neverHosts` | Extra hosts for the [never tier](#the-never-tier), ADD-only: `bank.example` covers its subdomains too. | — |

   A bad field fails the boot, and the browser stays off.
3. **Declare the sites** the browser may reach in the person's DM egress declaration (below).
4. Make sure the page signing key and the public URL are set (above).

## Where it may be used — the strictest room rule

`personalBrowserRefusal` (`packages/core/agent/personal-browser/policy.ts`) refuses before any box opens:

- any room that is not a **direct message** — a channel, a group DM, a thread seat. The browser holds one
  person's signed-in sessions, so no room can borrow it;
- a DM whose partner is **not confirmed internal** — a guest or an outside account;
- a turn a **non-member's** message woke;
- a turn with **no acting person** (a routine fire).

The browser is keyed by the acting person read from the binding. No tool input names a person, so a
conversation can only ever reach its own person's browser.

## Governance

| Plane | What holds it |
| --- | --- |
| **Egress** | The box reaches only the hosts the person's DM egress declaration admits: the SAME compiled policy the session firewall gets (`access/egress.ts` `compileNetworkPolicy`, with the break-glass narrowing and the network-access level), with every rule and credential transform dropped — so no org credential reaches the box. A site that is not declared is not reachable, on any hop: a redirect from a declared host to an undeclared one is refused too (below). On Vercel the sandbox firewall holds the list at the network. On docker see [the two stacks](#the-two-stacks). |
| **Approval** | Reading is open. A click, a keystroke, a select or a key press on a site needs the person's `browser.personal.act` card for that site, posted into their DM. Proposing a taught draft needs the person's `browser.personal.propose` card. All three personal-browser cards execute **only for the owner's own click**: another member's click, or an approver-chain lowering (a config rule, a bypass), throws and grants nothing. The one exception is [the approval judge](#the-approval-judge), off as shipped: at `enforce` it may run one frozen step under a pre-approval rule, and it grants no window. No approval of any kind reaches the [never tier](#the-never-tier). On a surface whose DM cannot show a card (Teams has no card renderer), OE cannot ask, so it reads only and hands the person the controls for anything else. |
| **Taint** | Every page the browser reads is untrusted external content (`web`): it is fenced, and it taints the turn. `my_browser` declares `taint: "disclose"`: taint does not hold the card on its own, and the card shows no taint line (OPE-2717). The approval judge does not read taint for a browser step (`judgeTaintBlind`), because every step follows a page read. The pre-approval rule, at site and op grain, bounds what a steered agent can do, and the never tier holds whatever a rule says. An unattended run never reaches the browser at all (the room rule refuses a turn with no person). |
| **Audit** | `browser.personal.open`, `.action` (the op and the host, never the text), `.act_granted`, `.takeover` (with the agent's short reason), `.handback`, `.view_opened`, `.closed` (reason, seconds, dollars), `.forget` and `.teach` (the phase of a taught draft, with counts only). A taught draft's proposal writes `memory.skill_proposal_pr` under the person. The person's keystrokes, the box key and every cookie value appear in no row. |
| **Halt** | A HALT over the DM, the person, their workspace or the org refuses every browser action, and the sweep closes the box. The halt read fails closed. |
| **Spend** | Each box session writes one spend-ledger row and one `browser` usage event under the person. On Vercel the dollars are the box's memory GiB-hours at `spend.sandboxGiBHourUsd`; on docker the row records the hours at $0. |
| **The model never holds the session** | No tool returns a cookie, a field value or the box's address. The agent can USE the signed-in session through the actions; it cannot READ or export it. |

## The never tier

Some sites and some steps the agent never acts on, whatever the person, a rule or the judge approves
(OPE-2672). Reading and going to the page stay open: the person can still ask the agent what a page says.

- **Payment, trading and banking sites.** A click, a keystroke, a select or a key press on one of them is
  refused before any approval is read, and the refusal writes a `browser.personal.action` row with
  `refused: "never_tier"`. An act card for such a site grants no window, even on the owner's own click. The
  shipped list (`packages/core/agent/personal-browser/never-tier.ts`, `BROWSER_NEVER_DOMAINS`) names
  payment services, brokers, crypto exchanges and banks. A host also matches when one of its labels is a
  payment or trading word (`pay`, `checkout`, `wallet`, `trading`, `broker`, `invest`, `crypto` and others) or
  contains `bank`. The policy's `neverHosts` adds hosts; nothing removes a shipped entry.
- **A payment form submit.** The box itself refuses a click, an Enter or a typed submit that would send a
  form holding a card or bank field, or an embedded payment provider's frame
  (`deploy/personal-browser/never.mjs`). With no form, it refuses a control whose label reads as paying on
  a page that holds such a field. This rule runs on every site. A box built before it does not refuse:
  rebuild and publish the image. A current box reports `payment-submit-refusal` in its `/health`
  `capabilities`. OE runs a step that only the approval judge allowed only on a box that reports it, and
  refuses the step otherwise (`refused: "box_capability"`). A step inside the person's own act window still
  runs on an old box, because the person approved acting on that site.

🔴 The never tier is a fence on known names and on what the page declares. A payment site with an unknown
name, or a card form that names its fields in a way the box does not read, is not covered. The person's own
card for that site, or the judge under a rule, is then the only check.

## The approval judge

The personal-browser policy's `judge` field holds the [approval judge](../security/security-model.md)'s
access to one browser step. It ships `off`.

| `judge` | What happens on a click, a keystroke, a select or a key press with no act window |
| --- | --- |
| `off` | The act card posts. The judge is not consulted. |
| `shadow` | The act card posts. The judge also runs with the scope's rules, and the `approval.judge.shadow` row records its verdict, the rule it cites and the switch. Use it to measure before `enforce`. |
| `enforce` | The judge decides the one step on the card: the op, the host, and a submit or a key. An allow runs that step only, with no act window, and the next step asks the judge again: no verdict is cached for the browser. A deny refuses the step, and no card posts. An ask, a timeout or a judge error posts the card. A box that does not report the payment-submit refusal on `/health` refuses a step the judge allowed ([the never tier](#the-never-tier)). |

The deployment's `approvals.judgeMode` still governs: `enforce` needs it at `enforce`, and `shadow` needs
it at any value except `off`. An allow must cite
a [pre-approval rule](../how-it-works/pre-approval-rules.md) the scope carries. Write that rule at site and
op grain: for example, "the agent may click to add an item to the basket on shop.example.com, and never
submit an order". A card with no frozen step grants a window, and only the owner's own click grants one.

## The two stacks

| | Vercel Sandbox (hosted) | docker (self-host) |
| --- | --- | --- |
| The box | One **persistent, named** sandbox per person, from the image. The port is a public HTTPS URL, and every request carries the per-open signature. | One container per open, with `--cap-drop ALL`, `--security-opt no-new-privileges`, a pid limit and the image's non-root user. The port is published on 127.0.0.1 only, or reached by name on `box.dockerNetwork`. |
| The logins | The sandbox's filesystem snapshot, taken at each stop, expiring `keepLoginsDays` after last use. Vercel encrypts it at rest. | A named volume per person. 🔴 It is as protected as the host's disk: use disk encryption on the host. |
| The firewall | The sandbox firewall holds the host list. | 🔴 **No host firewall for a box.** docker cannot enforce a host list on a box, and today's egress proxy cannot fence a docker box either (OPE-2407). So OE opens a docker box **only under the declared unenforced posture** (`egress.allowUnenforced`) — whatever the DM declares, a catch-all included — and then the only fence is **inside the box**: Chromium sends all its traffic (loopback included, QUIC off) through a forward proxy in the box program, which refuses every connection to an undeclared host or IP literal on every hop, redirects included, and every target that resolves to a loopback, unspecified or link-local address (the cloud metadata endpoint included) or to one of the box's own addresses (a catch-all `*` included), then connects to the address it checked; service workers are blocked. Other private addresses — RFC 1918 ranges, the docker host's gateway — stay reachable when the declaration admits them, and a catch-all `*` does. That is a check inside the box, not a firewall: a page that escaped Chromium's sandbox would reach the network, the host's network and a cloud metadata endpoint. Without `egress.allowUnenforced`, a docker deployment refuses to open the browser. |
| Per-open secret | Passed to the box's command only, never into the sandbox's stored configuration. | Passed in the docker CLI's environment, never on its argv. |

On both stacks, before a box starts on a person's profile, the backend stops any box still running on it:
two Chromium processes on one profile corrupt it. The app also claims the person's record first: a second
open while one is in flight waits for that open and reuses its box, or refuses if it does not land. An open
whose claim another open took over stops its own box rather than record it.

A just-bash deployment cannot run a box, and the browser refuses with a reason.

## What it does not do

- **No stealth mode.** It is headless Chromium. A site may treat it as a bot, ask for a CAPTCHA, or ask the
  person to sign in again from a new device. A CAPTCHA is a hand-off to the person.
- **No passkeys or device-bound sessions from the person's laptop.** A session cookie that a site binds to a
  device key (Chrome's device-bound session credentials) does not move into the box. The person signs in
  inside the box, with a password and a code, or with a passkey on their phone.
- **"Signed in days later"** holds only as long as the site's own session cookie lives, and only while the
  profile is used within `keepLoginsDays`.
- **No screen recording.** The watch page shows the live page only, and no frame is stored. A [taught
  demonstration](#teach-a-task-by-demonstration) records steps — page addresses and the labels of what the
  person used — never a frame and never typed text.
- **No auto-carry-on after a page hand-back.** The page posts a note into the DM; the person tells OE to carry
  on. The card hand-back wakes the DM seat.
- **No org credentials.** A credentialed org host is reachable as a bare host; the org's credential never
  rides.

## Where the code lives

| Part | File |
| --- | --- |
| Policy and the room refusal | `packages/core/agent/personal-browser/policy.ts`, `agent/personal-browser/policy.ts` |
| The never tier | `packages/core/agent/personal-browser/never-tier.ts`, `deploy/personal-browser/never.mjs` |
| The judge switch | `packages/core/agent/access/consequence.ts` (`judgeDeferSwitch`, `judgeTaintBlind`), `packages/core/agent/access/approval-judge.ts` |
| The person's record (its own table, compare-and-set) | `packages/core/agent/personal-browser/store.ts` |
| Open, act, the lock, close, forget, the sweep | `packages/core/agent/personal-browser/lifecycle.ts` |
| The signed box contract | `packages/core/agent/personal-browser/box-client.ts`, `deploy/personal-browser/box.mjs` |
| The watch page | `packages/core/agent/personal-browser/viewer.ts`, `packages/core/agent/channels/personal-browser.ts` |
| The tools and the cards | `packages/core/agent/tools/my_browser.ts`, `my_browser_handoff.ts`, `packages/core/agent/approvals/personal-browser.ts` |
| Teach by demonstration | `packages/core/agent/personal-browser/teach.ts`, `deploy/personal-browser/teach.mjs` |
| The sweep schedule | `packages/core/agent/schedules/personal-browser-sweep.ts` (every 5 minutes) |
| The box backends | `packages/adapters/agent/sandbox/long-lived-box.ts` |

Tests: `npm run test:personal-browser`, `test:personal-browser-teach` and `test:personal-browser-judge` (core),
`test:personal-browser-recorder` and `test:personal-browser-never` (the box's demonstration recorder and its
payment-submit rule), `test:long-lived-box` (adapters), the audience matrix in
`test:webhook-reveal`, and tier 2 `tests/integration/personal-browser/personal-browser.test.ts`. The live leg
is `S-PERSONAL-BROWSER` (NON_LAUNCH: the browser is off as shipped).
