# Slack

Tag or DM Open Everywhere in your Slack workspace and it acts as an autonomous teammate — it reads the thread, does the work, posts back, and remembers what it learned, scoped correctly per channel.

This page is the Slack-specific setup runbook. For the concept of a *surface* and how surfaces plug in, see [Surfaces](../../extending/surfaces.md). For how memory is scoped per workspace and channel, see [Memory](../../capabilities/memory.md). For how Slack's feature set compares to the other surfaces, see the [surface support matrix](./support-matrix.md) — Slack is the reference surface, where everything lands first.

## How the silo model maps

Open Everywhere's memory is [opt-in domains and silos](../../capabilities/memory.md), not an
automatic per-workspace tier stack. Slack is a clean fit for that model — a channel or DM is a
**surface**, and a Slack team is the natural `workspace` identity key many channels' surface
keys share, but nothing pools their memory automatically: a channel gets shared memory only
via an explicit `domain` listing it, or the `org` pseudo-domain fallback.

| Open Everywhere concept | Slack thing |
| --- | --- |
| `org` (tenant) | your deployment (`deploymentIdentity.org` in `agent/identity/surfaces.ts`, one org per deploy today) |
| `workspace` (identity key) | the Slack workspace / team (`team_id`) |
| `surface` (partition key) | the individual channel or DM (`channel_id`) |
| `mode` | `channel` (public/private channel), `dm` (1:1 IM), `mpim` (group DM) |
| `visibility` | `public` only for a confirmed public channel; everything else `private` |
| `trust` | `internal` for a verified in-workspace channel/DM partner; `external` for Slack Connect / shared channels or anything unverifiable — **unless the workspace is vouched**, which raises the unverifiable cases (see below) |

**Visibility isn't the memory gate — trust is.** `visibility` (public vs. private) is tracked
per channel but plays no role in whether memory shares: a **private** channel with verified
internal membership shares its domain's (or the org's) memory exactly like a public one does.
What actually gates it is **trust** (`slackTrust`): `is_ext_shared` / `is_org_shared` /
`is_shared` (a Slack Connect channel spanning orgs) binds `external` — read-only `public`
memory at most, never a domain's or the org's memory — and so does any channel Slack's
`conversations.info` couldn't positively check. A confirmed in-workspace channel, private or
public, binds `internal`. An `app_mention` envelope carries neither bit, so the channel
enriches both from `conversations.info`; if that call fails, the channel binds `external`
(fail-closed) and its own visibility falls back to `private`.

### The workspace vouch, and what it vouches

This deployment declares its own Slack **workspace** `internal` in
[`agent/identity/surfaces.ts`](../../how-it-works/config-as-code.md) — one tenant-grain line, not a
list of rooms. A declaration counts at any rung, so the line vouches every room under the workspace:
each channel, and each **group DM**, whose conversation id no config can name. Declare your own
workspace the same way, or name single channels instead if you want a narrower claim.

The vouch is a **promotion**, so it sits below Slack's own verdict and can only raise a room that
would otherwise be unproven:

- A **Slack Connect** room (`is_ext_shared`) stays `external` — a channel and a group DM alike. The
  vouch never re-promotes a room the platform positively reports as shared.
- A channel `conversations.info` never confirmed stays `external` too. The vouch is not a substitute
  for the check.
- A channel you want out of the claim is declared `public` at **room grain**. The narrower entry
  wins, and on a channel `public` is a demotion that sits *above* the platform verdict. (`external`
  is not a declarable value — it is the fail-closed default of an unlisted surface.)

🔴 **A group DM is demoted by evidence, never by its absence.** That is the one asymmetry with a
channel. An `is_ext_shared` group DM binds `external`, but a group DM Slack never confirmed binds
`internal` where an unconfirmed channel would fail closed. So on a group DM your declaration decides
whenever Slack gave no positive refutation — and the room-grain carve-out cannot narrow it back,
because that demotion applies to channels and no config can name an mpim's conversation id.

🔴 **The vouch reaches this workspace's DMs.** A DM reads `trust` as "is the partner internal?", and
a workspace line matches a DM key too. A partner Slack reports as external still binds `external`.
What changes is the partner with **no verdict** — nobody looked, or the `users.info` call failed (a
missing `users:read` scope, a rate limit, a network error) on someone who is in fact a guest or a
Connect stranger. That case used to bind `external` and now binds `internal`. Vouch a workspace only
if you mean every DM partner in it; name single channels instead if you do not.

A DM partner that is an **app** follows the same rule as a person: your own workspace's app binds
`internal`, an app from another workspace binds `external` unless you declared that workspace.

### Enterprise Grid: declare the organisation once

An Enterprise Grid holds several workspaces, and a Slack surface key names only the workspace. So a
Grid gets its own rung, written as one line at the enterprise id:

```ts
defineSurface({ key: "slack/E0GRIDID", trust: "internal" }),
```

That line vouches the workspaces under the Grid, so you do not list them one by one. A workspace you
did not declare and that no Grid line covers stays undeclared, and Open Everywhere reads an
undeclared workspace as an outside one.

**Every door carries the rung.** The Grid line reaches every path that decides who is a MEMBER (see
below), and every path that vouches a ROOM: a channel mention, a DM, a group DM, a thread reply, a
channel join and a **shortcut** all resolve the same enterprise line. So you declare the Grid once
and list no workspace under it.

Open Everywhere reads the enterprise id wherever Slack puts it on that route:

- the **event envelope** (`enterprise_id` beside `team_id`) on every Events API path;
- on the **interactivity** route, which has no envelope: the payload's top-level `enterprise`
  object, or `team.enterprise_id`. Slack sends the first for an org-wide install and the second for
  a per-workspace install on a Grid, so both are read;
- an `enterprise_id` **form field** on the `/oe` slash-command route.

The `/oe` command is narrower than the wake doors, and only here: it carries the rung into your
declaration, but it cannot make a **channel** command's room internal, because a slash-command
payload carries no `conversations.info` verdict and that check fails closed. Nothing about a
mention, a DM or a shortcut in the same room changes.

`preflight` may still report a Grid line as a **dead declaration**. That is the check's own data,
not a gap in the rung: it folds traffic from audit rows, and a row names a workspace and a room with
no rung above them, so a working Grid line matches none of them. Do not delete the line on that
advice — the check says so itself.

The enterprise is the **lowest** rung, so anything narrower wins. `slack/E0GRIDID` internal plus
`slack/T0SALES` public keeps that one workspace's **rooms** out; a room-grain `public` entry keeps
one room out. A `public` enterprise line does not demote a workspace you declared internal beneath
it.

🔴 **The carve-out does not reach a workspace's own members.** The member half answers "is this the
workspace the message arrived in?" before it reads your declarations, so a Sales person writing in a
Sales room is a member however you declared `slack/T0SALES`. The `public` line demotes that person
only where they write in **another** workspace, and it demotes every Sales room on both halves. To
keep a workspace's people out of the member set, do not declare the Grid above them.

🔴 **It fixes who counts as a member, and that is the point of the rung.** On a Grid a person's home
`team_id` is their own workspace, not the workspace the message sits in. Without the enterprise line
every Grid colleague reads as an outside author: their message marks the turn a non-member turn, their
words render inside the untrusted fence, and the member plane refuses their personal credential. With
the line they read as members. A workspace under a **different** Grid, or under no declaration, is
still an outside author.

The member half needs no extra scope and no configuration beyond the line above: Open Everywhere
reads the author's own workspace and Grid from the `users.info` lookup it already pays for, so it
holds on every ingress, the channel-mention path included. A single-workspace install has no
enterprise id, declares nothing at that rung, and behaves exactly as before.

**What this arms, and what stays off.** The [member plane](../configuration-reference.md)
(`connectors.memberPlane`) refuses any room the operator never declared internal. It is consulted at
one place — the mint of a member's own connector credential on a non-DM surface — so without this
line that mint would refuse in every Slack room, while ordinary Slack wakes carried on unaffected.
The plane itself **ships dark on this deployment**: the setting keeps its shipped default of `false`,
and the gate refuses on that first. Declaring the workspace removes the config blocker; it does not
arm the plane.

### Admin keys on a Grid

An admin key on Slack names the workspace and the person: `slack/T…/U…`. On a Grid, you can write
the Grid id in the workspace slot instead (OPE-2400):

```ts
defineDomain({ name: "org", match: "org", memory: "org-brain", admins: ["slack/E0GRIDID/U0EXUSER002"] }),
```

That one key gives the person admin standing in every workspace under the Grid. Slack issues one
member id for the whole Grid, so the key names one person. Slack's own admin pages show the `E…` id,
so you do not need to find the person's `T…` workspace id.

The rung works as it does for trust. Open Everywhere reads the Grid id from the delivery itself, in
the same places listed above. It checks the workspace key first and the Grid key last. A Grid key
matches only where the delivery named that Grid. A delivery from a workspace under another Grid, or
under no Grid, does not match it. A workspace key still never reaches a sibling workspace. An admin
roster only grants standing, so no narrower line can take standing away: a workspace key and a Grid
key for one person both grant, and either one is enough.

The Grid key reaches the admin tools, the approval-card click (an admin-tier card), the admin
bypass of a spend cap, the wake trust tier on the Slack event doors, and the admin memory reads.
🔴 **Three readers do not use the Grid key.** There, a Grid key grants nothing, which is the safe
direction:

- the governance-channel floor, which needs every member of the room to be an admin. It holds only
  a channel key, and a channel key names no Grid, so it counts a Grid admin as a plain member and
  the floor stays unarmed;
- the ✋ stop reaction on work that another person started. The reaction door reads the Grid id for
  its tenant fence, but this change does not pass it on to the stop;
- the trust grade of quoted messages in backscroll (the bootstrap read, the catch-up read and the
  name-drop read). Each one grades a Grid-only admin as a member, so all three agree.

For a person who needs one of these, add the workspace key `slack/T…/U…` as well.

## Prerequisites

- **Admin** (or app-install rights) on the target Slack workspace.
- A reachable Open Everywhere instance — deployed (public HTTPS URL) or local with a tunnel. See the [docs index](../../README.md) to get the project and the [setup runbook](../setup-runbook.md) for the deployment steps (env, access config, safety rules).
- Your instance's public base URL. The Slack webhook route is **`/eve/v1/slack`**, so Slack calls `https://<your-deploy-url>/eve/v1/slack`.

## The short way: `/setup` on the deployment

**If your deployment is already up, open `https://<your-deploy-url>/setup` and skip Steps 1 and 2.**
That page does the whole install for you (OPE-2231):

1. It asks for a **one-time setup code**. The deployment logs the code on every start while Slack is
   not installed — read it with `vercel logs` or `docker logs`. The log line names the absolute page
   URL, `https://<host>/setup`, on the host the page will write into the Slack app. This is the
   page's only authentication, so whoever can read the deployment's logs can run setup.
2. You paste **one Slack app configuration token** (<https://api.slack.com/apps> → *Your App
   Configuration Tokens*; it needs `app_configurations:write` and lasts about 12 hours). The page
   calls `apps.manifest.create` with the manifest below and your deployment's own host, so no URL is
   typed by hand. The screen names that host. It also asks the host for its own `/setup` with no
   login. On a 401, a 403 or a redirect, the screen warns that Slack cannot reach the host and
   names `OE_PUBLIC_BASE_URL`, because Slack sends its requests with no login. The configuration
   token is used once and never stored.
3. You click **Install to Slack**. The OAuth callback stores the bot token. Slack's manifest has no icon field, so set the app icon by hand: **Basic Information** → **Display Information** → **App icon**, and upload [`brand/png/mark-square-1024.png`](../../../brand/png/mark-square-1024.png). Skip this when you set [`identity.name`](../configuration-reference.md) and chose your own icon: with no name configured the agent presents as the project, so the project mark is its default avatar.
4. The last screen gives you the **two config edits**, already filled in with your workspace and user
   ids — the vouch in `agent/identity/surfaces.ts` and `admins` in
   `agent/memory/config/domains/org.ts`. Make them by hand and push. The bot does not change its own
   admins from chat. Ask it "what can I change from chat?" to see what is ready and what is missing.

Every credential Slack *issues* goes **browser → Slack → your deployment's encrypted credential
store**: the client secret, the signing secret and the bot token are never seen by a human and never
reach a clipboard or a hosting dashboard. The one value you do paste is the short-lived app
configuration token, which `/setup` uses once and never stores. `SLACK_BOT_TOKEN` and
`SLACK_SIGNING_SECRET` do not need to be set at all — Step 2 below becomes unnecessary.

🔴 **The page locks for good at the first successful install**, and answers `404` from then on. An org
admin reopens it with the `reopen_slack_setup` control call (see
[the control plane](../../security/control-plane.md)); a reopen keeps every stored credential, so the
agent stays on Slack while you walk the page again.

🔴 **If `SLACK_BOT_TOKEN` or `SLACK_SIGNING_SECRET` is set in the environment, `/setup` answers 404.**
The resolver is env-first — deliberately, so that landing this page cannot change which Slack app a
working deployment speaks as — which means a run on such a deployment would store credentials nothing
would ever read. Rather than let you complete a run that changes nothing, the page refuses. To move an
existing deployment onto the credential store, unset both variables and redeploy; `/setup` then opens
and the deployment logs a setup code on that start.

This is also why an existing deployment does **not** get an open setup page when it upgrades: it is
configured by environment variable, so the page is closed from the start.

The rest of this page is the **manual path** — still fully supported, and the one to use before the
first deploy (the page needs a running deployment to create an app that points at it).

## Public exposure on a custom domain

A deployment on a public host exposes two things to any caller that knows the host. Know both, and
close what you do not need.

**Vercel Standard Protection leaves a production custom domain public.** It puts a Vercel login in
front of every other domain of the project. Check the protection your project's dashboard shows.
With Standard Protection, the status route and `/setup` answer anyone on a production custom domain.
The reverse case breaks setup: when the host that `/setup` writes into the Slack app sits behind the
login, Slack's requests never reach the deployment. `/setup` warns about that on screen 2. The host
comes from `OE_PUBLIC_BASE_URL`, else `VERCEL_PROJECT_PRODUCTION_URL`, else `VERCEL_URL`. Set
`OE_PUBLIC_BASE_URL` to the public custom domain to choose it.

**1. The status route, `GET /eve/v1/oe/status`.** It is public with no setting to turn it off. It
names the exact core and eve versions and the contract verdicts, and its Slack `installed` field
reads `no` while `/setup` can be open. It carries no secret, id or content. To hide it, exclude
`channel/oe-status` in `roster.config.ts`, or deny every path that starts with it in the Vercel
Firewall. The [deployment contract](../contract.md#hiding-the-status-route) gives both recipes.

**2. The `/setup` window.** The page is open from the first start with a valid
`OE_CREDENTIAL_ENCRYPTION_KEY` until the first Slack install, unless `SLACK_BOT_TOKEN` or
`SLACK_SIGNING_SECRET` is set in the environment. It answers 404 while the key is unset. In that
window, anyone who can read the deployment's logs can claim the page: every member of the Vercel
team, and every reader of a log drain. The code is 128 bits, so a guess does not work. A claim lets
the holder create a Slack app in their own workspace that points at this deployment, and lock
`/setup`. That workspace is not declared in `agent/identity/surfaces.ts`, so the agent treats it as
an outside workspace. Recover with the `reopen_slack_setup` control call. To keep the window short:

- Set `OE_CREDENTIAL_ENCRYPTION_KEY` on the day you install Slack, if the deployment needs no stored
  credential before then. Then run `/setup` in the same sitting.
- If the deployment will never use Slack, exclude `channel/slack-setup-page` under `providers.slack`
  in `roster.config.ts` (then `npx oe build --accept`), or deny every path that starts with `/setup`
  at the edge. That prefix covers `/setup/` and `/setup/callback` too.
- After the install, `/setup` answers 404 for good, until a `reopen_slack_setup`.

## Step 1 — Create the Slack app

1. Go to <https://api.slack.com/apps> → **Create New App** → **From scratch**. Name it (e.g. `Open Everywhere`) and pick the target workspace. Under **Basic Information** → **Display Information** → **App icon**, upload [`brand/png/mark-square-1024.png`](../../../brand/png/mark-square-1024.png), the project mark. Skip this when you set [`identity.name`](../configuration-reference.md) and chose your own icon: with no name configured the agent presents as the project, so the project mark is its default avatar.
2. **OAuth & Permissions** → **Bot Token Scopes**, add:
   - `app_mentions:read` — receive `@mention` events.
   - `chat:write` — post replies, and edit the agent's own posts (`edit_reply` uses `chat.update`,
     which needs no scope beyond this one).
   - `chat:write.customize` (optional) — vary the bot's display NAME per message (`chat.postMessage`'s
     `username` param). Powers the worker-reply TIER signal: a worker that posts into the room
     itself shows as "\<agent name\> [task]" instead of the bare agent name, so its reply is
     visually distinct from the ambient supervisor's (see
     [Agent & loop](../../how-it-works/agent-and-loop.md)). **Nothing renders it today** — the
     bracket is keyed on the `task` grain, and no shipped route mints that grain: a worker reports
     back through the seat and posts nothing of its own. Grant this scope only if you run a
     deployment whose workers post directly. **Scope optional, graceful fallback:**
     omit it and every reply still posts, under the bot's default name — the agent detects a
     rejected `username` and retries the SAME post without it, so a missing scope costs only the
     tier signal, never the reply itself.
   - `files:write` — upload file attachments (the `post_file` tool — charts, CSVs, documents a
     delegated worker posts into the thread). Omit this and every file post fails with Slack's
     `missing_scope`; the agent reports the blocker instead of delivering the file.
   - `files:read` — download user-uploaded attachments (the `describe_image` tool fetches an
     image's `url_private`, which Slack only serves to an app with this scope, and a voice clip
     sent to the agent is downloaded the same way — see
     [Voice clips](../../capabilities/voice-clips.md)). Omit it and image reads and voice clips
     fail; text replies are unaffected.
   - `channels:history` — read public-channel messages in the thread it's working.
   - `channels:read` — **positively confirm a public channel's identity** (`conversations.info`:
     shared-ness, member count, name/topic; also backs `conversations.members`). This is the
     channel half of the trust gate: every non-DM message enriches its trust/visibility from
     `conversations.info`, and a failed call binds the channel `external` (fail-closed) —
     silently, with no error naming the missing scope. Also needed for channel-join intros and
     the governance-channel roster.
   - `groups:read` — the same as `channels:read`, for **private** channels — needed for
     `conversations.info`/`conversations.members` on a private channel exactly the way
     `channels:read` covers a public one.
   - `im:history` — read DM messages (required for DM support).
   - `im:read` — **the DM half of `channels:read`.** `conversations.info` / `conversations.members`
     on a `D…` (DM) conversation need this scope; `channels:read` and `groups:read` do **not** cover
     an `im`. Two paths ask that question about a DM: the **approval clicker floor** (a member-tier
     approve/reject click resolves the room's roster before it executes) and **card disclosure**
     (the same roster question at propose time, before a card is posted). Omit it and both Slack
     calls fail with `missing_scope`, the roster comes back unresolved, and the clicker floor's
     beneficiary leg — the one guarding actions whose result is handed to the clicker, e.g. minting
     a webhook signing secret — **refuses the click**, blaming an unreadable roster. Ordinary DM
     chat still works; it is approvals *in DMs* that break.
   - `mpim:read` — the same, for **group DMs**, and it carries one more job than its 1:1 twin.
     `conversations.info`/`conversations.members` on an `mpim` need their own scope, and an approval
     card or a click can land in a group DM exactly as it can in a 1:1. Beyond that, an `app_mention`
     event carries no channel type, so this is the **only** way the agent can tell that an
     `@mention` landed in a group DM rather than a channel — and that is what routes the mention into
     the group DM's own standing session. Without the scope, `@mention`s in group DMs still get
     answered, but from a separate per-thread session that cannot be woken when delegated work
     finishes; plain messages in the group DM are unaffected.
   - `im:write` — **open a DM the agent starts.** Two features need it. The governance DM-delivery
     arm: on a workspace with no governance channel, an org-scope admin read asked in an ordinary
     room is delivered to the requesting admin's DM instead of rendering there (see
     [Access & scoping](../../how-it-works/access-and-scoping.md)). Omit it and that delivery fails
     closed — the agent refuses and posts nothing; it never falls back to answering in the room.
     And **global shortcuts** (Step 9 below): a global shortcut names no conversation, so the agent
     opens the invoker's own DM to wake in. Omit the scope and a global shortcut acks and wakes
     nothing, with the reason in the deploy log. Message shortcuts do not need it.
   - `commands` — **register the `/oe` slash command and the shortcuts.** Slack's own description
     is *"Add shortcuts and slash commands that people can use"*. It grants no read access; it is
     what lets the app declare those entry points at all. Omit it and both the shortcuts (Step 9
     below) and the `/oe` command ([Slash commands](#slash-commands-oe-zero-inference-control-plane),
     set up in its own section further down) are unavailable to install.
   - `groups:history` — read private-channel messages (if you'll use it in private channels).
   - `reactions:write` — set the 👀 (working) / 🛑 (blocked) status reaction on the thread root, and the `react` tool's model-chosen reactions.
   - `reactions:read` — **ingest inbound reactions.** Lets the agent receive `reaction_added` / `reaction_removed` events (Step 1.7) so a 👍 / 👎 on one of *its own* replies is recorded as lightweight human feedback. Omit this and reaction ingestion is silently off.
   - `pins:read`, `pins:write` — read pinned standing instructions on first onboard and maintain the pinned in-flight status message.
   - `mpim:history` — read group-DM messages (only if you'll use group DMs).
   - `users:read` — resolve a Slack user id to their profile (`users.info`). Backs the bot's own
     display name and the name-drop wake's bot-name check, and — the security-relevant one — the
     **DM-partner trust check**: every DM enriches its trust from `users.info` (is the partner a
     full member, a guest, a Connect stranger?), and a failed call leaves it unverified, which the
     binding treats as `external` (fail-closed). Omit this and **every DM binds `external`**
     (read-only `public` memory at most) on a fresh install, with no error pointing at the cause —
     `users.info` just fails quietly and the binding falls back to its safe default. 🔴 **A vouched
     workspace inverts that fallback**: the deploy's own declaration then supplies `internal` for the
     partner nobody could check, so the missing scope opens the shared read layer instead of closing
     it (see [the workspace vouch](#the-workspace-vouch-and-what-it-vouches)). The same scope
     also backs the workspace roster (`users.list`) that [identity
     linking](../../how-it-works/identity.md) searches to name a person's other account; without it
     that search finds nothing and linking falls back to its code flow, which still works.
   - `canvases:write` — **the domain memory canvas.** The agent shows each domain's memory as the
     channel canvas of the domain's internal channels, and rewrites it when that memory changes (see
     [Memory you can see](../../capabilities/memory.md#memory-you-can-see)). Omit it and each refresh
     fails with `missing_scope`, which the deploy log and a `memory.canvas_refresh` audit row record
     per channel. Memory itself is unaffected. A workspace on Slack's free plan has no channel
     canvases, and the refresh fails there in the same way.
   - `assistant:write` — **the side panel.** Slack requires it for the `app_context_changed` event
     (Step 7). That subscription is what makes Slack tell the agent which room a person is viewing
     when they write from the side panel (see [The side panel](#the-side-panel)). Omit it and the
     panel still works as a DM, without the viewed room.
   > **Already installed?** Adding a scope to the app does **not** retrofit an existing
   > installation — an app installed before this list grew still holds only the scopes it was
   > granted at install time, and its `xoxb-` token keeps working, so nothing looks broken. After
   > adding a scope you must **reinstall the app to the workspace** (OAuth & Permissions →
   > *Reinstall to Workspace*) and re-approve, then re-copy the Bot User OAuth Token if it changed.
   > Until you do, approvals in DMs keep failing on the unreadable roster described above.

3. **Install to Workspace** (top of OAuth & Permissions). Approve the scopes.
4. Copy the **Bot User OAuth Token** (`xoxb-…`) — this is `SLACK_BOT_TOKEN`.
5. **Basic Information** → **App Credentials** → copy the **Signing Secret** — this is `SLACK_SIGNING_SECRET` (used to verify every inbound webhook).
6. **Event Subscriptions** → toggle **On**. Set the **Request URL** to:

   ```
   https://<your-deploy-url>/eve/v1/slack
   ```

   Slack sends a one-time `url_verification` challenge; your instance must be running and reachable so it can echo the challenge back (see [Gotchas](#gotchas)).
7. Under **Subscribe to bot events**, add:
   - `app_mention` — wake on `@Open Everywhere …` in a channel.
   - `message.im` — wake on a direct message.
   - `message.channels` — **reply-without-re-tagging in public channels.** After you `@mention`
     the agent in a thread it stays *engaged* and picks up your follow-up replies without a new
     mention (until you ask it to stop — see *Stopping it*, below). Omit this and the agent only ever responds
     to explicit mentions — the passive engagement feature is silently off. Engaged replies are
     **judged, not automatic**: the agent reads every reply in the thread but stays silent when
     people are talking among themselves — it responds only when a message is addressed to it or
     moves its task forward. An `@mention` always guarantees a response. The model has two ways to
     go quiet on a judged turn: the legacy `NO_REPLY` text convention, or the `no_reply` tool (a
     closed reason, audited — prefer it; both still work). In a busy thread it can also choose a
     single emoji `react` instead of a text reply — on a message that did **not** address it, a
     react can be the whole response. A message that **did** address it (an `@mention` or a DM) is
     always owed one short reply; there the react only acknowledges.
   - `message.groups` — the same for **private** channels (needs `groups:history`).
   - `message.mpim` — **group DMs** (needs `mpim:history`). Not the same as the two above: a group
     DM is treated as DM-family, so **every** message in it wakes the agent, with no engagement or
     name-drop gate in front — the same rule as a 1:1 DM. It still *judges* whether to answer (a
     group DM holds other people, who talk to each other), and it stays silent when nothing was
     asked of it. Omit this event and the agent only hears `@mention`s in group DMs.
   - `member_joined_channel` — **intro on invite.** When someone `/invite`s the agent into a
     channel it introduces itself once, fitted to the channel (see
     [Channel-join intros](#channel-join-intros-default-on-fail-closed)). Omit this and the
     agent stays silent until its first mention, which then carries the intro instead.
     The same event, for a PERSON joining, re-runs the domain memory canvas gate: when the newcomer
     is a guest, the agent replaces its own canvas in that channel with a notice that holds no memory.
   - `reaction_added`, `reaction_removed` — **reaction ingestion (feedback signal).** A 👍 / 👎
     on one of the agent's own replies is recorded as lightweight human feedback (and every
     reaction emits anonymous volume telemetry); reactions on *other* messages are counted but
     not stored. Needs the `reactions:read` scope from Step 2. Omit these and the feature is
     silently off — nothing else changes.
     The thumbs under an answer are a separate road and need no event: see
     [Sources and thumbs on an answer](#sources-and-thumbs-on-an-answer).
   - `app_home_opened` — **the Home tab page.** When a person opens the agent's Home tab, the agent
     publishes their private page: everything it does for them on its own, with Pause and Remove (see
     [Everything I do for you](../../capabilities/proactivity-and-routines.md#everything-i-do-for-you-one-list-per-person)),
     what it remembers about them, with Edit, Forget and Export, the
     rules they kept with "Approve, and allow things like this", with Remove (see
     [Pre-approval rules § 7](../../how-it-works/pre-approval-rules.md#7-approve-and-allow-things-like-this)),
     and what their domains know (see [Memory you can see](../../capabilities/memory.md#memory-you-can-see)).
     The event needs no scope. Omit it and the Home tab shows Slack's empty placeholder.
   - `channel_shared` — **take a memory canvas down when its channel is shared.** When a channel
     becomes Slack Connect shared, the agent re-runs the memory canvas gate there at once and replaces
     its own canvas with a notice that holds no memory. Needs `channels:read` and `groups:read` from
     Step 2. Omit it and the canvas comes down at the next memory write to the domain instead.
   - `user_change` — **automatic offboarding.** When a workspace admin deactivates a member or a
     guest, OE confirms it with `users.info` and revokes that person's link-set and stored OAuth
     credentials (see [Identity](../../how-it-works/identity.md), *Automatic offboarding*). Needs
     the `users:read` scope from Step 2. Omit it and offboarding stays the admin's manual
     `revoke_link_set`.
   - `app_context_changed` — **the side panel's viewed room.** Slack fires it when a person moves
     the side panel to another room, and, once the app subscribes to it, attaches the viewed room to
     each `message.im` sent from the panel. The agent acts on the room in the message and on nothing
     else: the event itself wakes nothing. Needs `assistant:write` from Step 2 and Slack's agent
     view (`features.agent_view` in the manifest). See [The side panel](#the-side-panel).

     > 🔴 **Turn on the agent view first, then subscribe this event.** Slack refuses to save the
     > `app_context_changed` subscription while the app has no agent view. The page shows only a
     > generic error, *"Hmm, something's gone wrong"*, and does not name the cause. The app console
     > has no switch for the agent view (seen 2026-10-12). Turn it on in the manifest: **App
     > Manifest** → add `features.agent_view` (copy the block from the generated manifest) → **Save
     > Changes**. Then come back here and add `app_context_changed`. The generated manifest carries
     > both in one document. No run has yet measured that Slack saves both in one paste. If that save
     > fails with the same error, save the manifest once without `app_context_changed`, then add it.
   - `agent_session_stopped` — **Slack's native Stop button.** Slack shows a Stop button on an
     agent session that is working, and only to an app that subscribes to this event. A press stops
     the running turn, exactly as the ✋ reaction and `/oe stop` do. Needs `chat:write` from Step 2.
     Omit it and the session shows a spinner with no button. See
     [Agent sessions](#agent-sessions-stop-titles-and-the-waiting-state).

   The generated manifest (`/setup`, `surface_manifest`, `npx @open-everywhere/create`) subscribes
   every event in this list and requests each event's scope.
   Then **App Home** → **Show Tabs** → turn the **Messages Tab** on, and tick *Allow users to send
   Slash commands and messages from the messages tab*. Without it, a person who opens a DM with the
   agent sees *"Sending messages to this app has been turned off"*, and `message.im` never fires.
   Turn the **Home Tab** on too, for the page above. The generated manifest sets all three
   (`features.app_home`).
8. **Interactivity & Shortcuts** → toggle **On**. Set the **Request URL** to the same
   `https://<your-deploy-url>/eve/v1/slack` — the same route Event Subscriptions uses. This is
   what makes the agent's **clickable buttons work**: Eve's own tool-approval prompts and
   clarifying-question options render as interactive Block Kit messages, **and** the
   admin-mutation approval cards (spend caps, connector revokes, forgetting a memory bullet —
   see [In-Slack approvals](../../security/control-plane.md#in-slack-approvals)) post their
   approve/reject buttons the same way. Both ride this one Request URL; Slack delivers every
   button click to it, and the front classifies which handler a click belongs to. Without it,
   clicks fail with *"the app is not configured to handle interactive responses"* while
   everything else appears to work.
9. **Shortcuts** (same **Interactivity & Shortcuts** page, below the Request URL) → **Create New
   Shortcut**. A shortcut is a **wake**: it starts a turn the same way an `@mention` does. Add
   either or both — they answer different needs.
   - **On messages** (a *message shortcut*) — appears in a message's `…` menu. The agent wakes on
     **that message**: its text is the wake's content, and any files on it come too. Use it to hand
     the agent something somebody else wrote without re-typing or re-tagging it. In a **channel**
     the reply threads under the message; in a **DM** it lands flat in the conversation, which is
     where every DM answer lands.

     The message is somebody else's, and the agent is told so: the wake is attributed to **you**,
     the person who invoked the shortcut, and the message's body is wrapped as untrusted content.
     Handing a message over does not vouch for it — but it does run the turn with **your** access,
     not the message author's.

     Slack delivers a `message_action` even for a conversation the app is not a member of, so the
     shortcut has to answer for itself what the room is. It asks `conversations.info`, and three
     outcomes follow.

     - **A room the app cannot see at all** — a private channel, DM or group DM it is not in —
       answers `channel_not_found`. The shortcut then wakes nothing, because the agent must not
       route a message whose room it could not identify. For a private channel this is measured. For
       a DM or a group DM it is an INFERENCE from Slack's documentation, and the code says so
       (`appCanReadConversation` in `slack-identity.ts`): no offline tier can drive a live
       `conversations.info` against a DM the app is not in, so the answer there is unmeasured. If the
       inference is wrong, such a DM reaches the turn with its files.
     - **A public channel the app has not joined** answers, and says `is_member: false`. The
       message's **text** crosses into the turn, and that is the ruled trade: you are the
       principal, and the body is fenced as untrusted. Its **files do not** — the references are
       dropped from the wake and never registered, so the bot token downloads nothing from a room
       the agent has not joined, and the agent is told the text rather than that there is a file it
       cannot open.
     - **A room the app is in** carries the message and its files both. A shortcut on a screenshot
       surfaces the screenshot here, and only here.
   - **Global** — appears in the composer's ⚡ menu and in search. It names no conversation, so the
     agent wakes in **your own DM** with it, with the shortcut's name as the whole content. This
     one needs the `im:write` scope from Step 2 (the agent opens the DM with
     `conversations.open`); without it the shortcut acks and wakes nothing, and the deploy log says
     so.

   Slack asks for a **Name**, a **Short Description** and a **Callback ID** for each. The callback
   ID is yours to choose — the agent owns every shortcut this app receives, so the name you give it
   is simply the trigger name the agent is told about. Shortcuts ride the **`commands`** scope from
   Step 2, which Slack documents as *"Add shortcuts and slash commands that people can use"* — the
   same scope the `/oe` command uses.

   > **A message shortcut in a channel needs the single window.** A shortcut is *addressed*, so it
   > never goes through the engagement or name-drop judge — it takes the same road a
   > single-window `@mention` takes. On a domain that does **not** run the ambient supervisor
   > (`ambientSupervisor` off) a channel has no such road, so a message shortcut used there wakes
   > nothing and logs a warning. Message shortcuts in DMs and group DMs, and global shortcuts, work
   > on every deployment.
   >
   > A message shortcut also needs the agent to know **which kind of room** it was invoked in. If
   > `conversations.info` fails — a missing scope, or a transient Slack error — the shortcut wakes
   > nothing and logs a warning, rather than routing a DM's content into a channel session. Retry
   > the shortcut; if it keeps failing, check the `channels:read`, `groups:read`, `im:read` and
   > `mpim:read` scopes from Step 2.
10. **Save Changes.** If Slack prompts to reinstall the app (scopes changed), do it.

> **Verify the wake path after deploy.** `@mention` the agent in a public channel, let it reply,
> then post a follow-up in that thread **without** tagging it. If it responds, engagement is live.
> If only the mention worked, re-check that `message.channels` is subscribed and `channels:history`
> is granted. (The engagement events all land on the same `/eve/v1/slack` Request URL.)

### Optional: respond to name-drops (per domain, off by default)

By default the agent **never** joins a conversation uninvited: it responds to `@mentions`, DMs,
and threads it's already engaged in — a top-level message that merely *says* its name is ignored.
If you want it to (judged, carefully) answer messages like *"could Ada look at this?"*, opt a
**memory domain** in:

```ts
// agent/memory/config/domains/org.ts — one file per domain; list each in domains/index.ts
export const domain = defineDomain({ name: "org", match: "org", memory: "org-brain", nameDropWake: true })      // workspace-wide

// agent/memory/config/domains/support.ts
export const domain = defineDomain({ name: "support", reach: ["slack/T…/C…"], nameDropWake: true, /* … */ })  // just these channels
```

An explicit domain's setting always wins for its channels (no fall-through to `org`). The gate is
deliberately conservative even when enabled: **top-level** human messages in channels/private
groups only (a group DM never needs it — it's DM-family, so every message there wakes the agent
anyway), the message must say one of the agent's names — the wake trigger's token set (same rule
on Discord) is:

- the bot's **Slack display name** — the agent's public face on Slack, from one cached
  `users.info` lookup; rename the app and the trigger follows, nothing to configure;
- the deployment's canonical `identity.name` setting, when set — the same name the agent
  introduces itself by on every surface;
- any token in `wake.nameDrop.include` (configuration-reference.md), added by the operator;

minus any token in `wake.nameDrop.exclude`, which wins over the other three. Matching is
case-insensitive and word-boundary, same as an `@mention`'s name check. The
channel must be positively confirmed as **not externally shared** (Slack Connect and
unverifiable channels never trigger it), and the agent then *judges* whether a reply is actually
warranted. The agent treats a question or request that names it as meant for it, and normally
answers, even when the question is put to the room about it (*"has anyone asked Ada about the
release checklist?"*). A question put to someone else by name, or a message that only mentions
the name in passing, normally gets no reply. When in doubt the agent stays silent. If it does reply, it starts a thread on the message and
follows that thread from then on, exactly as if it had been mentioned.

Uninvited turns also **fail quietly**: until the agent has actually posted a reply, an error
(model outage, tool failure) on a name-drop turn is logged and audited (`surface.quiet_fail`)
instead of posted — a turn that would have judged "stay silent" never spams the conversation
with a stack trace instead. Once it has replied it's a participant, and failures go loud like
any engaged thread's. Every wake decision is one log line in your host's runtime logs, and the
name-drop road writes **two audit rows of its own**:

- `surface.name_drop_woke` — the road admitted the message and handed on a wake. It names the
  room (`container`), the message (`ts`), which session took the wake (`road`: the room's standing
  seat, or a fresh per-thread session) and who decided (`via`: the built-in policy, or a drop-in
  [wake arm](../../extending/drop-in-arms.md)).
- `surface.name_drop_silent` — somebody named the agent and the road refused. `reason` is the
  refusing gate's own words: the domain never enabled `nameDropWake`, or the channel is not
  confirmed internal.

A message that names nobody writes neither row — unless a drop-in wake arm adds the wake, and that
row carries `via: "arm"`. The pair is what tells a **judged** silence from a **dead** road: no row
at all means the road never ran. Read a `surface.name_drop_woke` row with no reply as "the road
admitted the wake", not yet as "the seat judged silence": gates below the road can still refuse the
turn — the tenant fence, the spend cap, and on a seated channel the seat's own stood-down marker —
and each of those writes its own refusal row. Slack itself writes no per-turn silence row — the
deployment's posture is actions-only — so the silent turn's own record is the always-on
`reply.no_reply_observed` row plus the [session
transcript](../../security/audit-and-provenance.md). A reply is audited as `reply.post`, the one
canonical row every reply route writes, whether the model called the `reply` tool or the turn's
ending text was the answer.

### Channel-join intros (default on, fail-closed)

Being `/invite`d into a channel **is** an invitation — so, unlike name-drops, this needs no
opt-in. When the bot is added to a channel it **reads up before it introduces itself**: it
immediately acks ("👋 Just joined — reading up on this channel; back in a moment."), fetches the
channel's recent history (up to 50 messages) and the inviter's name, then posts an introduction
**in a thread under the "joined" notice** grounded in what it read: a teammate's personal channel
gets a person-focused hello fitted to what they've actually been working on, a team channel gets
an "I've read the room" line plus 2–3 concrete offers drawn from things really discussed there,
and a large announce-style channel (~500+ members) skips the ack and the read entirely and gets
one low-key line ("I'll stay in the background — @mention me if I can help") and then silence.
An empty or unreadable channel degrades to an intro from the name and topic alone. The fetched
history is framed as untrusted channel data — something *in* the backscroll asking the bot to act
is chatter, never a task. The intro is still a *judged* turn — the agent can choose to say
nothing at all if even that would be noise.

> **What it deliberately does *not* read:** other channels. Claude Tag's join intro searches the
> whole workspace via per-user tokens; Open Everywhere's access model is bot-principal only, so
> cross-channel context comes from the channel's [domain memory](../../capabilities/memory.md) —
> if the channel is in a domain, the intro turn may take one look at that shared memory too.

Two hard limits:

- **Never on externally-shared channels.** The same fail-closed gate as name-drops: the channel
  must be positively confirmed as not externally shared (Slack Connect, org-shared, and
  unverifiable channels never get an intro).
- **Once per channel.** The join intro shares its once-only marker with the first-mention
  onboarding (Step 3 below) — whichever happens first claims the channel, so you never get both,
  and a remove/re-invite doesn't re-intro.

Requires the `member_joined_channel` bot event from Step 1.7. Without it the feature is silently
off and the intro rides the first `@mention` instead.

## Step 2 — Configure the environment

Set these on your instance:

```bash
SLACK_BOT_TOKEN=xoxb-…          # Bot User OAuth Token from Step 1.4
SLACK_SIGNING_SECRET=…          # Signing Secret from Step 1.5
```

Optional, but relevant to the silo model:

```bash
OE_MEMORY_PROVIDER=git          # memory backend — git | sqlite
OE_MEMORY_DIR=/abs/path/to/store
```

**Identity binds automatically.** You do **not** set workspace, surface, mode, or visibility by hand. The Slack channel reads `team_id`, `channel_id`, `channel_type`, and `is_private` straight off each inbound event into the session auth context, and `bindSlack` derives workspace = the Slack workspace, surface = the channel, plus mode and visibility. The `deploymentIdentity.workspace` / `.surface` declaration in `agent/identity/surfaces.ts` is only the `eve dev` (no-surface HTTP) gap-filler — once Slack is wired it is ignored.

## Step 3 — Invoke it

Open Everywhere wakes on an `@mention` in a channel, or on any message in a DM.

**Untagged channel messages.** In a channel that Slack confirms internal, an unaddressed message
also wakes the channel's standing seat, because `ambientSupervisor` is on by default. The seat
replies only where it adds something, and it audits every silence. `ambientSupervisor: false` on the
channel's domain makes the channel addressed-only. The same line on `org` does it for every domain
that does not set `true` itself. The flag decides what wakes the
channel's standing seat, nothing else. It does not decide how many channels share one seat
(`mode`, `windows`) or which memory the seat reads (`memory`). A channel in no explicit domain has
its own solo seat, even with `ambientSupervisor` on at `org`. See
[Wake, seat, memory: three independent axes](../configuration-reference.md#wake-seat-memory-three-independent-axes).

1. In any channel, invite the bot: `/invite @Open Everywhere`.
2. Mention it: `@Open Everywhere summarise the last 20 messages and post the action items`.
3. Expected behaviour:
   - It reacts to the thread root with 👀 (seen it, working on it) and shows a rotating status verb as its typing indicator (`Tinkering…`). eve's own `Thinking...` status comes first, while the mention is admitted.
   - **Live step labels.** While a tool runs, the status line says what the agent does, in plain
     words: `Searching Notion…`, `Reading the PR…`, `Reading the channel…`. Between tool steps it
     shows the status verb again. The label is code, not model text: it comes from the tool's name
     and, for a connector, from a fixed list of vendor names. It never shows what the agent searches
     for, a page title, a URL, or anything a tool returned, so a label in a shared channel cannot
     carry another conversation's words. Only a step that needs no approval by default gets a label
     (a read, a search, running code in the sandbox, a hand-off to a declared subagent): a write
     (a pull request, a ticket, a Notion change) shows the status verb, because the label shows
     before an approval or a check decides the write. A connector op counts as a read only when
     its name says so (`list_…`, `search_…`). An operator can still require approval for such an op,
     and its label then shows while the card waits. A tool with no label shows the status verb.
     The status line is Slack's native assistant status, so it posts nothing in the thread. The reply still
     posts once, after every check. A label does tell the room which kind of tool runs, and for a
     connector, which vendor.
   - A turn that starts a task also posts eve's **task card**: one message per turn, one row per
     task, updated in place. Outside a 1:1 DM a row shows the task's name only (`Researcher`), never
     the brief the agent wrote for it, because a brief can carry content from another conversation.
     Outside a 1:1 DM, a row that waits on a person says only what it waits for (`Waiting for approval`).
     In a 1:1 DM with you, a row shows the brief. In no room does a row show the task's result: the
     answer arrives as the agent's reply.
   - On the **first** mention in a channel it posts a short intro and adopts any pinned messages as standing instructions for that surface.
   - It does the work, replies in-thread, and **removes** the 👀 — absence is the done signal; the posted reply is the result. On a failure it flips to 🛑 (blocked) instead. (✅ is deliberately left to humans — react ✅ yourself to mark something done.)
   - **Every channel reply lands in a thread.** A message that is already in a thread is answered
     in that thread. A **top-level** channel message — an `@mention` or an ambient answer alike —
     is answered in a new thread opened on that message, so a busy channel keeps one root per
     topic and the answer sits under the question. Only a post that answers no message at all (a
     [routine](../../capabilities/proactivity-and-routines.md) fire, a webhook post-back) goes to
     the channel root. A **DM** is deliberately different: its replies stay flat, because
     threading a 1:1 shatters the conversation.
   - That status reaction is code-driven and narrow by design; the model can ALSO choose its own
     reaction via the `react` tool — a bare emoji ack (e.g. 👍) instead of a low-content reply in a
     busy thread. It's a genuine alternative response, not a status indicator, and is audited like
     any other tool call.
4. Test a DM: open a direct message with the bot and send a plain message (no `@mention` needed in a DM). It responds the same way. The DM surface's memory is isolated and `private`.

### What it can read on Slack

**The message that woke it carries more than the typed text.** Three parts reach the agent — four
when the wake is an edit, which also carries the text as it read before the edit:

- The author's own text.
- Any file the message carries. The agent sees the reference — the id, the name, the mimetype
  and the file's Slack `url_private` — not the bytes. It reads an image with `describe_image`
  and a text file with `read_file_upload`.
- **A quoted Slack message: a forward, a share, or a message permalink unfurl.** Slack puts
  this content beside the text, not in it. The agent sees it appended under the author's text,
  so a person can forward a message to the agent and ask about it. A quoted field the author's
  own text already carries is dropped. The unit is one whole field, so a two-line quote of which
  the author typed one line is kept intact — the repeated line stays.

  A plain **link unfurl** — the title and blurb Slack scrapes from a web page — is **not**
  merged on any path Open Everywhere's own parser handles. Those paths read quoted Slack
  messages only, and they are: an ambient channel message, an engaged thread, a name-drop, a
  **DM**, a **group DM**, and a mention that the unified window or a group DM owns.

> ⚠️ **One `@mention` route still merges a link unfurl, and in practice it almost always does.**
> A mention that Open Everywhere's own parser does not own is forwarded to the `eve` framework's
> native inbound path, and that path reads every attachment — including the text Slack scrapes
> from a linked page. Measured against our pinned eve: the scraped text is merged whenever the
> message carries Block Kit `blocks` whose flattened text contains what the person typed — the
> normal case for a message composed in a Slack client. Otherwise eve falls back to a length
> comparison, which can discard the scraped text. Since you cannot tell from the outside which
> case a given message hits, treat a linked page's title and blurb on that route as reaching the
> model inside the member's unfenced body.
> Open Everywhere does not control that leg today (tracked as OPE-1380).

> ⚠️ **Quoted content carries the forwarder's standing, not its own.** Open Everywhere merges the
> quoted text into the forwarder's message body. The fence keys on the **author** of that body, so
> a forward from a vouched member arrives with the member's trust tier and is delivered unfenced —
> the same as anything that member types. The agent is not told which words the member wrote and
> which came from the quoted message.
>
> A member can therefore put another Slack author's words in front of the model under their own
> standing. Treat the ability to forward into a channel the agent watches as equal to the ability
> to talk to the agent. This is the same handling a direct `@mention` has always had.

Two **wake** decisions read only what the person typed: the check that drops a message as the
duplicate of an `@mention`, and the name-drop trigger. So forwarding a message that says the
agent's name does not wake it by name. The agent does *act on* forwarded content once it is
awake — that is the point of the feature.

One caveat on the first of those, and it is unmeasured. We do not know whether Slack raises an
`app_mention` for an `@mention` that sits inside a forwarded message rather than in the text the
person typed. We assume it does not, and Open Everywhere is built for that case: the forward
still reaches the agent **on any route that was already going to wake it** — a DM, a group DM,
an engaged thread, or an ambient channel. In a plain channel with no ambient mode and no
name-drop, a forward whose only mention sits inside the quote wakes nothing, the same as any
other message nobody addressed to the agent. If Slack *does* raise an `app_mention`, the forward
reaches the agent twice instead — once by the mention route and once by the wake route. A
duplicate answer is the deliberate trade; the alternative was a forward the agent never saw at
all on the routes that do wake.

Beyond the message that woke it, the agent has three reads on Slack, all open to any member of
the room (membership *is* the read tier here — there is no separate grant to hand out):

- `read_channel` — recent history of **the channel this turn arrived in**, pulled into the
  conversation that asked. It takes no target: the channel comes from the turn's own binding, so a
  channel the bot has not been invited to is not addressable, not merely refused.
- `read_thread` — the same, scoped to the thread this turn arrived in.

  Both are fenced to the session's [memory domain](../../capabilities/memory.md) and to the
  window's own sources, and nothing else. A refused read writes a `read.refused` audit row naming
  the channel, the caller's domain and the verdict (ids only, never message content) —
  `GET /control/v1/audit?since=<iso>&actions=read.refused`.
- `read_file_upload` — decodes a **text** attachment already posted in the room (an image
  goes to `describe_image` instead). The fetch uses the bot token and is host-pinned to
  Slack, allowlisted by file type and capped by size, and the decoded content is ingested as
  untrusted external data like any other surface text.

### Personal credentials in a Slack room (the member plane)

The [member plane](../../security/credentials-and-planes.md) is the one way a person's own connector
credential resolves outside a 1:1 DM. Two Slack facts decide whether a room admits it.

**Your declaration vouches the room, at any rung you wrote it on.** One
`defineSurface({ key: "slack/<team>", trust: "internal" })` line covers every room in that workspace.
A room you did not declare vouches for nobody, and the plane refuses there.

**A group DM is a channel here.** It is a shared room with several people in it, so it reaches the
same gate a channel reaches. Nobody declares a group DM's own key, so its vouch always comes from a
rung above it — the workspace line does the job.

**Slack Connect demotes the room, whatever you declared.** A channel or a group DM that Slack reports
as externally shared (`is_ext_shared`) stays out of the plane. A workspace-wide declaration cannot
re-promote a room that spans another organisation.

> ⚠️ **The group-DM half of that needs `mpim:read`.** Open Everywhere reads the sharing flag from
> `conversations.info`, and on a group DM that call needs the `mpim:read` scope. Without the scope the
> call answers nothing, Open Everywhere demotes nothing, and a Slack Connect **group DM** stays vouched
> under your workspace declaration. Absence of an answer never demotes a room — only Slack saying so
> does. Grant `mpim:read` (Step 1) if you use group DMs and rely on this demotion. A **channel** does
> not have this gap: an unconfirmed channel fails closed on its own.

**A guest or an outside person who WRITES marks that turn.** Open Everywhere probes the author of the
message that woke it (`users.info`). A positively refused author makes the turn a non-member turn, and
the plane refuses a personal credential on it. **Sitting in the room marks nothing** — the mark keys
on whose words entered the conversation, not on who is present. Open Everywhere reads no roster for
this, and an unreadable probe refuses nobody.

**The author probe walks your declaration rungs.** An author from the workspace the message sits in
is a member. An author from a **different** workspace is a member only if you declared that
workspace, or the [Grid](#enterprise-grid-declare-the-organisation-once) it belongs to. This is what
admits an Enterprise Grid colleague, whose home workspace is a sibling of the one they are writing
in. A guest grade still refuses on either path: `is_restricted`, `is_ultra_restricted`, `is_stranger`
and a deleted account all mark the turn, whatever workspace the person sits in.

**An app is judged by its workspace, like a person.** A bot that writes in a room is a member when it
is your own workspace's app, and an outside author when it belongs to another workspace you have not
declared. There is no separate rule for bots.

## Search Slack as you

The bot sees the channels it is in, and nothing else. **"Search Slack as you"** lets a person let the
agent see what THEY see: the channels and conversations the bot is not in. It can also post in their
name. It runs on Slack's own MCP server (`https://mcp.slack.com/mcp`) with the person's own Slack
sign-in. It is off until an admin turns it on, and the bot stays the normal route.

### What a person sees

- **Only in their own Slack DM with the agent.** A channel, a group DM and a DM on another platform
  never get it. Two walls hold this: the derived grant resolves in a Slack 1:1 DM only, and the
  connection itself refuses every call from anywhere else before any card or sign-in. A refusal
  writes a `connector.refused` audit row with reason `personal_surface`.
- **Bot first, offered in the moment.** The agent answers from the bot's own Slack access first.
  When the bot cannot see what was asked, it says so and offers: "I can only see channels I am in.
  Want me to see what you see?" Nothing offers the connection at onboarding.
- **The person signs in once.** Their first call posts the "Connect my account" card. They consent
  at Slack to the user scopes below, and their token reaches only what their own Slack account sees.
- **Every write as them takes a card.** A post or a reply in their name posts an approval card first,
  and nothing is sent until they approve it. Reads run without a card. On a routine's fire, nobody
  is there to approve a card, so a write as them is refused: a routine permission does not lift it.
- **It is labelled as theirs.** The connection is `slack-as-you`, described as "search Slack as you",
  and the agent says which answers came from their account.
- **It can ask another bot for them.** A post in their name can @mention another bot in a shared
  channel. After that carded post, the DM seat's `expect_bot_reply` lets only that bot's replies in
  that thread wake the agent, for at most six hours, and relays them to the person's DM. See
  [Your DM can ask other bots](../../capabilities/bot-delegation.md) (OPE-2426).

It rides the host-side connector plane, never the sandbox egress plane: the DM's sandbox already holds
the bot's Slack key, and the firewall stamps one credential per host per session. The person's token
lives in the OAuth vault and goes to `mcp.slack.com` alone.

### Turn it on

1. **Declare it** in `agent/access/mcp-servers.ts`, with your Slack app's public Client ID (Basic
   Information → App Credentials). It reuses the app the bot already runs on. Slack opens its MCP
   server to an internal app (your own Open Everywhere app is one) through that app's own OAuth
   client, with no dynamic client registration.

   ```ts
   import { defineMcpServers } from "@open-everywhere/core/agent/connections/mcp-servers.js";
   import { slackAsYou } from "@open-everywhere/provider-slack/agent/slack-as-you.js";

   export const MCP_SERVERS = defineMcpServers([slackAsYou({ clientId: "<your Slack app's Client ID>" })]);
   ```

   `tools: ["search", "read"]` makes it read-only (no `chat:write`). `people: { groups: [...] }`
   narrows who gets it, as in any declared server. Run `npx oe build` and commit the diff.
2. **Store the Client Secret** (Basic Information → App Credentials) in the credential store:
   `npx oe secret set db:slack:oauth-client-secret`. The declaration names that ref, never the value.
   A `/setup` install already holds the secret under its own reserved `slack-app:` ref, which no
   outbound path may read, so store this copy once by hand.
3. **Change the Slack app.** Fetch the manifest again (`surface_manifest { surface: "slack" }`, or the
   `/setup` page). Once the app declares the entry, it carries the `mcp:connect` bot scope, the user
   scopes below and the redirect URL `https://<host>/oauth/v1/callback`. Paste it (App Manifest → Save
   Changes) and reinstall the app if Slack asks. Then turn on **the MCP toggle in the app config's
   Agents section** — the manifest has no field for it, so it stays a click.

The user scopes, by tool group:

| Tool group | User scopes |
|---|---|
| `search` | `search:read.public`, `search:read.private`, `search:read.mpim`, `search:read.im`, `search:read.files`, `search:read.users`, `files:read` |
| `read` | `channels:history`, `groups:history`, `mpim:history`, `im:history`, `canvases:read`, `users:read` |
| `write` | `chat:write` |

Rate limits are the Web API's own tiers.

> ⚠️ **Not confirmed yet:** whether a Slack plan restricts the MCP server, whether an org admin
> must approve the internal app before a person can consent, the exact shape of the
> `oauth.v2.user.access` answer (a top-level `access_token` is assumed), and whether Slack accepts
> the `scope` parameter on a token refresh. The offline tests prove the Open
> Everywhere side with a stubbed MCP server. The live e2e scenario `S-SLACK-AS-YOU` proves the rest
> once your test app has the toggle and the scopes.

## The side panel

Slack's agent experience lets a person open the agent in a **side panel** beside any channel, and
keep one conversation with it while they read. The manifest turns it on with `features.agent_view`
(Slack's current name; a new app cannot use the older `assistant_view`). The panel shows the app's
Messages tab, so a message sent there is an ordinary `message.im` to the person's **own DM seat**.
It is the same seat, the same session and the same grants as a DM. The panel adds no seat type.

**What the panel adds is one fact: the room the person is looking at.** With the `app_context_changed`
subscription and `assistant:write` (Step 1), Slack attaches the viewed room to each panel message.
The agent passes the room's id to the seat in a trusted host note, as context only. The seat gains
none of that room's reads: a read of that room follows the rules that already apply to the DM.

**The order matters on an app you configure by hand.** Turn on the agent view first, through the
manifest (`features.agent_view`), because the app console has no switch for it. Then subscribe
`app_context_changed` (Step 1.7). Slack refuses that subscription while the agent view is off, and
says only *"Hmm, something's gone wrong"*. If you see that error while you add
`app_context_changed`, make sure the agent view is on first. The error does not name its cause.

**Guests and external rooms get the strictest default.** The room id rides the note only when all
three hold:

- the person is a full member of the workspace (the DM-partner check answers `internal`);
- the room belongs to the same workspace as the DM;
- Slack confirms the room internal (`conversations.info`). A Slack Connect channel, or a private
  channel the app is not in, fails this check.

Otherwise the person still gets an answer, but the seat does not learn the room.

**What the live test proves.** The e2e scenario `S-SIDE-PANEL` posts a signed panel message that
names the e2e channel as the viewed room. It proves three facts on a real deployment: the person's
DM seat answers in the panel thread, the seat's wake carries the note that names the room, and no
tool call of the turn reads the room. A call counts as a read when its input names the room by id
or name, apart from the answer tools and the name lookup, or when a read of the conversation itself
returns the room. It forges the message, because no API can type into the panel. So it does not
prove that Slack attaches the room to a real panel message.

**Suggested prompts** come from the `slack.suggestedPrompts` setting (at most four). They are part of
the manifest, so a change reaches people only after the operator pastes the manifest again (App
Manifest → Save Changes). The shipped three name no product.

**Requirements and limits, from Slack's documentation (re-read 2026-10-12):**

- Slack says some AI features need a **paid plan**, though the settings appear on every plan. Its
  developer sandbox has them for free.
- 🔴 **The switch is one-way for an app that already has `assistant_view`.** Slack cannot move such
  an app back, and its people need a hard refresh. An app made from this manifest before the side
  panel shipped had no `assistant_view`, so for it the paste only adds the panel.
- Each conversation in the panel is a Slack **agent session**. OE sets its state, gives it a title
  and answers its Stop button. See [Agent sessions](#agent-sessions-stop-titles-and-the-waiting-state).
- **Microsoft Teams** has no equivalent of a panel beside any channel for a bot. The nearest is the
  bot's personal chat, which is the person's DM seat already.

## Agent sessions: Stop, titles and the waiting state

Slack shows each conversation with the app as an **agent session**, keyed by the conversation's
thread. A session has a status and a title (Slack's reference: `agents.sessions.setStatus`,
`agents.sessions.rename`, re-read 2026-10-14). OE uses them in the person's DM with the app, which
is the Messages tab and the side panel:

| What the person sees | What OE does |
| --- | --- |
| **A title.** A conversation that opens with a top-level message shows a short title from the words the person typed. | The DM door creates the session with that title before the turn starts. The title is the first typed line, cut to 60 characters at a word. A member mention is dropped, a channel shows as `#name` and a link shows as its label, so the title holds no raw id. The lines of a forwarded or quoted message are another conversation's words, so they never make the title: a forward with no typed text gets no title. A voice clip's transcript is not typed text either, so a clip with no typed words gets no title. The host writes the title in code; no model writes it. |
| **Their own title.** The person can rename a session at any time. | Slack applies a title only when a call creates the session, so OE never overwrites a rename. |
| **Working, with a Stop button.** | A turn's start sets the session `processing`. Slack then shows its Stop button, because the app subscribes to `agent_session_stopped`. |
| **Stop.** | A press takes the same road as the ✋ reaction and `/oe stop`: it is decided at ingress, before any model call, so it is free and works over a spend cap. It stops the turn of the session's thread. In the DM it falls back to the DM's newest turn, because a top-level DM message keys its turn by the channel alone. The audit row is `turn.cancel_requested` with `via: "stop-button"`. Slack does not move the status itself, so OE sets the session `active`. |
| **"Needs you".** | When the seat's turn reported through `update_status` that it waits on the person (`needs_input` or `blocked`), the agent session parks `suspended`. Otherwise it parks `active`. Any new turn clears it: the person's answer, and also a job's settlement turn. That turn sets `processing`, then parks `active` unless it reports again that it waits on the person. |

**Limits.**

- A channel thread gets no session title from OE, and no session state except the `active` a Stop
  press sets. A shortcut, even on a threaded DM message, sets no session state. A channel turn's status line still rides
  `assistant.threads.setStatus`, and a Stop press that arrives from a channel thread stops that
  thread's turn only: it never falls back to the channel's newest turn.
- When a second message is steered into a running turn, the turn's park settles both agent sessions:
  the one the turn started on and the one of the last message.
- A message that arrives inside a thread gets no title, because it does not open the agent
  session. Slack's side panel may send its first message inside a thread. No test sends a real
  panel message, so whether a panel conversation gets a title is unproven.
- The DM seat serves every agent session of the DM. A Stop pressed in one agent session while the
  seat works on a message from another agent session of the same DM stops that work. Both are the
  same person's.
- A forwarded job's `needs_input` or `blocked` does not set the agent session `suspended`. Only the
  seat holds `update_status`: a job runs in the work session, whose worker has no such tool, and the
  work session sets no agent-session state. The job's own ✋ stops it.
- The title and the state are best-effort calls. A workspace without Slack's agent features answers
  an error, which OE logs and ignores.
- Slack shows the Stop button only after the operator pastes the manifest again (App Manifest →
  Save Changes), because the subscription is part of it.

**What the tests prove.** The unit packs `test:slack-agent-session` (packages/providers/slack) and
`test:surface-session-state` (packages/core) pin the title, the setter and the hook. The integration
test `tests/integration/channels/slack-agent-session.test.ts` drives a booted agent through the
signed DM door: the title before `processing`, `suspended` after `update_status(needs_input)`,
`active` after the answer, no title for a forward with no typed text, and a signed Stop press that
stops a held turn and sets the session `active`. The live e2e scenario
`S-SESSION-STOP` forges a signed press on a real deployment. No API can press the real button, so no
test proves that Slack itself shows it.

## Sources and thumbs on an answer

Every answer the agent posts on Slack carries Slack's own **thumbs up / down** under it. An answer
that a first-party read fed also lists its **sources**: compact numbered links, one line under the
answer. Both are on by default, and neither needs a setting, an env var or a new scope.

| What the person sees | What OE does |
| --- | --- |
| **Sources.** `Sources: [1] Launch checklist · [2] Fix login`, each title a link. | Only in the person's 1:1 DM with the app. Only records that a first-party read tool fetched for this conversation: a Notion page (`read_notion_page`, `read_notion_comments`), a Linear issue (`read_linear_issue`), or a GitHub issue or pull request (`read_github_issue`, `check_pr_status`, `get_pr_feedback`, `walk_pr`), whether the seat read it or a worker read it for the seat. At most five, in the order the turn read them. A title is the record's own title on one line, never an id. A link is the record's own `https:` url, which the person opens with their own access. |
| **No sources in a shared room.** | A channel, a thread or a group DM gets no links. A turn can read a record and leave it out of the answer, and in a shared room its title would reach people the answer did not address. The `reply.provenance` row still records what the turn read, and `detail.links` counts the links a reply showed. |
| **Thumbs up / down.** | Slack's native `feedback_buttons` element, in a `context_actions` block. A click comes to the interactivity URL, takes the tenant fence, and writes one `reply.feedback` audit row: the rating, the rater, the conversation and the rated message's ts. A click changes nothing else and wakes nothing. A 👍 / 👎 *reaction* still writes `reaction.feedback`, as before. |

**How the answer is posted.** When `blocks` is present, Slack shows the blocks and not `text`, so the
answer itself also rides the blocks, as `section` blocks of at most 3000 characters each. A long
answer is cut at line ends, and a cut never leaves a code block open. `text` stays the notification
fallback. An edit sends the blocks again. If Slack refuses a post for its blocks (`invalid_blocks`),
OE posts the answer once more as text alone, so a refused block never costs the answer.

**Limits.**

- A read through a connector (MCP) names no record, so it gives no link. The hosted Notion MCP is
  one such connector: a turn that read Notion only through it shows no sources.
- A host post (a notice, the connect card, a thread's completion line) and a part of an answer that is still being written (`done: false`) get no thumbs
  and no links. The links go under the whole answer, once.
- A link's title and url live in process memory for the turn. A worker's read also carries them on
  the short-lived delegated-reads row, from the read to the settle; the settle that spends the row
  drops them. A reply that a different process posts, or a replayed step, shows no links. It never
  shows a wrong one.

**What the tests prove.** The unit packs `test:reply-source-links` (packages/core) and
`test:slack-reply-feedback` (packages/providers/slack) pin the 1:1 rule, the reach rule, the url and
title fence, the blocks and the click. `test:delegated-provenance` proves a worker's read reaches the
seat's 1:1 reply as a link and a shared-room reply as none. The integration test
`tests/integration/channels/reply-feedback.test.ts` boots the agent: a DM answer reaches
`chat.postMessage` with the thumbs, and a signed click writes one `reply.feedback` row. The live e2e
scenario `S-REPLY-FEEDBACK` reads a real answer back and forges a signed click on it. No API presses a
real feedback button, and no live leg drives a source link, because the board's only live Notion road
is the hosted MCP.

## Slash commands: `/oe` (zero-inference control-plane)

`/oe` is the control-plane escape hatch (backlog item 23): pure logic, code-rendered responses,
**no model turn** — so it answers even while a channel is over its spend cap or the model/gateway
itself is down. Unlike `@mention`/DM, it rides its **own dedicated Request URL**
(`/eve/v1/slack/commands`) — a brand-new route, separate from the Event Subscriptions /
Interactivity URL (`/eve/v1/slack`) Steps 1.6–1.8 configure — so setting it up never touches the
mention/DM/approval-card wiring above.

Commands (typed as free text after `/oe`):

| Command | What it does | Visibility |
| --- | --- | --- |
| `/oe status` | Says the agent is running, then lists, under "Details for your admin", the build (deployment sha) and eve pin that identify this build, the app version when the deploy carries one, primary/utility model config, the context window and the token count it is summarised at, memory provider. | Ephemeral (only you see it) |
| `/oe budget` (or `/oe budget status`) | This channel's and workspace's effective spend caps (tokens + USD) and current-month spend — the SAME figures the spend gate enforces. | Ephemeral |
| `/oe budget raise <usd>` | Proposes a new monthly USD cap for this channel: posts the SAME public approval card `set_spend_limit` posts (Approve/Reject buttons); an admin decides. The card is the answer, so the only ephemeral line is **your own domain's recent spend** from the ledger — see [Spend & cost](../../security/spend-and-cost.md#the-domain-spend-scan-behind-oe-budget-raise). | Card: public in-channel. Ack: ephemeral |
| `/oe budget clear` | Proposes clearing this channel's spend-limit override back to its configured limit: posts the SAME public approval card `clear_spend_limit` posts, which names both figures ("From $1/mo to $50/mo (the default)"). | Card: public in-channel. Ack: none beside the card (OPE-2490) |
| `/oe stop` | Stands down the turn currently running in this channel: resolves it from the durable turn-anchor registry and cancels it. **No model turn, nothing spent** — so it works while the channel is over its cap, which is when you are most likely to want it. | Ephemeral |
| `/oe rate <1-5>` | Records one human mark on the [model A/B test](../../extending/models-and-gateway.md#ab-testing-a-challenger-model): rates this channel's most recent champion/challenger turn, on the arm that turn actually ran. Answers "nothing to rate" — the normal reply — while the test is off. | Ephemeral |
| `/oe optout on` / `/oe optout off` / `/oe optout` | Turns on (or off, or shows) **your own** opt-out of agent actions on your content: no memory is saved from your own turns (in a shared conversation, a later turn by somebody else can still save what you said, and a [domain question](../../capabilities/domain-questions.md) you ask is not covered yet), and the agent refuses when somebody else hands it one of your messages with a shortcut. Keyed to you alone — there is no argument that names another person. The Home tab has the same switch. See [Opting out](../../capabilities/memory.md#opting-out-of-agent-actions-on-your-content). | Ephemeral |
| `/oe watch more` / `/oe watch less` / `/oe watch none` / `/oe watch` | Sets (or shows) **your own** dial for the [chief-of-staff watch](../../capabilities/proactivity-and-routines.md#the-chief-of-staff-watch): how often the agent may message you on its own about something that needs you, such as two meetings that overlap. Everyone starts at `less`. `none` turns it off. Keyed to you alone. The Home tab has the same three buttons. | Ephemeral |
| `/oe cover on` / `/oe cover on until <date>` / `/oe cover off` / `/oe cover` | Turns **your own** [out-of-office cover](../../capabilities/out-of-office-cover.md) on (from your DM with the agent, members only) or off (anywhere), or shows it. While cover is on, a question that mentions you in a channel the agent is in gets an answer from what that channel already knows, labelled as cover; when cover ends you get one recap in your DM. | Ephemeral |
| `/oe help` | Lists the commands. | Ephemeral |

Bare `/oe` (no text) defaults to help — the friendliest landing. `/oe budget` alone (no `raise`/
`clear`) defaults to `budget status`; Discord's equivalent (`/oe`) requires picking a concrete
subcommand instead — see the [Discord guide](./discord.md#slash-commands-oe-zero-inference-control-plane)
for why that's a genuine, documented platform grammar difference, not an inconsistency.

### Register the Slack app feature

1. In your Slack app config, go to **Slash Commands** → **Create New Command**.
2. **Command**: `/oe`.
3. **Request URL**:

   ```
   https://<your-deploy-url>/eve/v1/slack/commands
   ```

4. **Short Description**: `Open Everywhere control-plane commands (stop, status, budget) — no model turn.`
5. **Usage Hint**: `stop | status | budget [raise <usd> | clear] | rate <n> | optout [on | off] | watch [more | less | none] | cover [on | off] | help`.
6. **Save**, then reinstall the app if Slack prompts you to (a new command is a scope-adjacent change).

No extra env var is needed — the route reuses `SLACK_SIGNING_SECRET` from [Step 2](#step-2--configure-the-environment) to verify every request (the SAME `v0=` HMAC scheme Event Subscriptions uses), and `SLACK_BOT_TOKEN` to post the `raise`/`clear` approval card.

## Stopping it

Two different things, two different mechanisms — and the split is not stylistic.

**Stop the turn it is running now.** Either react **✋** on the thread, run **`/oe stop`**, or, in
the agent's DM or side panel, press Slack's own **Stop** button. All three
are decided at ingress, before any model call, so all three are free and all three keep working when the
channel is over its spend cap. The agent's host places the ✋ only where work is running, for example on the
message that asked for a job, from the job's start to its settlement. So it is present and
clickable exactly while a stop is meaningful, and never appears on a message the agent merely read. Inference cannot
do this job at all: the agent is the thing that is busy, so a message saying "stop!" queues behind
the very turn it would stop.

Be clear-eyed about what a stop is: the turn's history rolls back to its last completed model call,
but **anything already done is done** — tool calls inside the interrupted step had real effects and
are not undone, and a running sandbox command can't be killed. The acknowledgement says so, and
names what had already run.

**Stop it following the thread.** Just tell it — "you can stop following this", "we're good here,
thanks", whatever you'd say to a colleague. This is **judged, not pattern-matched**: the agent reads
the intent between turns and calls `stand_down`, which sets a durable marker on the thread. It stays
in the channel and loses nothing; `@mention` it to pull it back in. There is deliberately no magic
word — the regex that used to look for one disengaged on "don't stop the deploy" as readily as on
"stop", which is the failure mode a pattern over unbounded phrasing always has.

This is a **channel-only** verb. A DM has no `@mention` to pull it back in, so `stand_down` refuses
there and the agent replies that it could not stop following — a marker nobody could ever clear
would trap the DM silent for good.

### Spend caps deliberately do NOT gate `/oe`

There is no model turn to decline, so `/oe` isn't a "new spend" origin — it works in a ⛔'d channel
exactly as well as in one with headroom. `/oe budget raise`/`clear` still go through the real
approval-card machinery; a human's click, not the command, is what actually changes anything.

## Gotchas

- **Signing-secret verification.** Every inbound webhook is HMAC-verified against `SLACK_SIGNING_SECRET`. If it's wrong or unset, Slack requests are rejected and the bot stays silent — check this first if mentions do nothing.
- **Request URL challenge handshake.** When you set or change the Event Subscriptions URL, Slack POSTs a `url_verification` challenge. Your instance must be live and reachable at that moment to echo it back, or Slack marks the URL unverified and won't deliver events. Running locally? Expose it with a tunnel (e.g. `ngrok`) and use that HTTPS URL.
- **DMs need both pieces.** A DM only works if you subscribed to the `message.im` bot event **and** granted the `im:history` scope. Missing either means DMs are silently dropped.
- **An approve/reject click in a DM needs `im:read` (group DM: `mpim:read`).** Both are separate
  from `im:history`, and neither is covered by `channels:read`/`groups:read`. Before a member-tier
  click executes, the approval **clicker floor** resolves the room's roster
  (`conversations.info` + `conversations.members`) to check who could see the card; in a DM that
  call is on a `D…` id. Without the scope both calls fail `missing_scope`, the roster is
  unresolved, and clicks on the kinds whose result is handed to the clicker (minting a webhook
  signing secret, say) are refused with a roster complaint — while chat in that same DM keeps
  working normally, which is what makes it confusing. If you added the scope to an app that was
  already installed, **reinstall it** — see the note in Step 1.
- **A private channel is NOT memory-isolated by that alone — trust decides, not visibility.** A verified in-workspace private channel shares its domain's (or the org's) memory exactly like a public one; visibility (public/private) is tracked but doesn't gate sharing. What DOES gate it is `conversations.info` failing to positively confirm the channel — missing the relevant read scope means the channel binds `external` (fail-closed): read-only `public` memory at most, no domain or org memory, regardless of whether it's public or private. Grant `channels:read` (or `groups:read` for a private channel) so `conversations.info` succeeds and the channel resolves `internal` — `channels:history` is a different scope (it gates `conversations.history`, the message-read path) and granting it alone will not fix this.
- **`/oe` has its own Request URL.** It's a separate Slack app feature (Slash Commands) from Event Subscriptions/Interactivity — pointing it at the wrong URL (or forgetting to set it at all) means `/oe` times out with Slack's generic "dispatch_failed" error while mentions/DMs keep working fine, since they're on a different route entirely.
- **Slack Connect (shared) channels: it answers, with public-only memory.** A channel shared across workspaces/orgs (`is_shared` / `is_ext_shared` / `is_org_shared` on `conversations.info`) binds **external** trust: the bot still replies, but with read-only `public` memory at most — no domain memory, no org memory, no shared-memory writes (this differs from Claude's Slack agent, which refuses shared channels outright). One consequence to know: if *another* org in that shared channel runs its own agent on this codebase (or any bot), each install answers its own org's mentions independently — the bot-author drop prevents loops between them, but nothing deduplicates two humans mentioning two different bots. If you don't want the bot in shared channels at all, just don't invite it to them.
