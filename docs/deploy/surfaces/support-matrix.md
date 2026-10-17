# Surface support matrix

What works where. Open Everywhere's governance spine is surface-agnostic, but each chat
platform exposes different hooks — so features land per surface, and some are structurally
impossible on a given platform. This page is the honest, evidence-based comparison across
**Slack, Microsoft Teams, and Discord**: use it to pick a surface, and to see at a
glance what's live, what's built-but-untested, and what the platform itself rules out.

For per-surface install and config, see the setup guides:
[Slack](./slack.md) · [Teams](./teams.md) · [Discord](./discord.md).
(Linear and Notion are also surfaces, but they're issue-/comment-based rather than chat-based, so
they're out of scope here — see [Linear](./linear.md), [Notion](./notion.md), and [GitHub](./github.md). Notion is
**ambient-judged**: a standing per-doc supervisor reads every comment and replies only when it
clearly adds value, staying audibly silent otherwise.)

## Legend

| Status | Meaning |
| --- | --- |
| ✅ | **Live-verified** — running against the real platform and exercised end-to-end. |
| 🔧 | **Built, not live-verified** — the code (and any manifest/config) exists, but it hasn't been proven against a live platform tenant. |
| 🚧 | **Partial** — works with a real caveat; the footnote names it. |
| ❌ | **Not built** — the platform could support it; we haven't done it (yet). |
| ⛔ | **Platform-impossible** — the platform structurally can't support it. A limitation of the platform, not of the project. |
| — | Not applicable on this surface. |
| ❔ | Unknown — not yet confirmed either way. |

Two surface-wide notes before the rows:

- **Teams is live on one path and built on most others.** The core spine — channel
  @mention wake, JWT-validated inbound, identity binding, channel wrap, model turn and reply
  post-back — runs end-to-end against a real Microsoft 365 tenant²⁰. Most other Teams cells
  read 🔧: the code exists and tests pin it, but no live leg has driven that path yet. The
  approval card is one of those 🔧 cells since OPE-2424²⁷, and it covers personal and group chats
  since OPE-2447. The `/oe` commands¹⁹, the name-drop wake²⁹ and the channel intro³⁰ are 🔧 since
  OPE-2443, OPE-2444 and OPE-2445. The one ❌ left in this group is pinned-instruction adoption,
  which Microsoft has no API for (³⁰). DM-partner verification is 🔧 since OPE-2446²⁸.
- **Discord has two ingestion paths.** The HTTP **interactions** endpoint (slash commands)
  works on a plain serverless deploy; **ambient messages** (@mentions, DMs, channel follow-ups)
  only exist on the **Gateway relay** path¹. Cells below assume the relay is running; without
  it, everything ambient is ⛔ by platform design.

## Conversation

| Feature | Slack | Teams | Discord |
| --- | :-: | :-: | :-: |
| Wake on @mention in a channel | ✅ | ✅ ²⁰ | ✅ ¹ |
| Wake in a DM, no mention needed | ✅ | 🔧 | ✅ ¹ |
| Slash-command invocation | ❔ ² | 🔧 ¹⁹ | 🔧 |
| Reply without re-tagging (engaged threads) | ✅ | 🔧 ²³ | ✅ ¹ |
| Judged silence (may decline to reply on a follow) | ✅ | 🔧 | ✅ |
| Name-drop wake (opt-in, per domain) | ✅ | 🔧 ²⁹ | ✅ |
| One task = one thread | ✅ | 🔧 ³ | ✅ ⁴ |
| Working indicators | ✅ ⁵ | 🔧 ⁶ | ✅ ⁷ |
| Durable multi-turn sessions (resume across messages) | ✅ | 🔧 | ✅ ⁸ |
| Reads channel backscroll for context | ✅ | 🔧 ²⁵ | 🔧 ¹ |
| Intro when invited into a channel | ✅ | 🔧 ³⁰ | ❌ |
| First-contact onboarding + pinned-instruction adoption | ✅ | 🚧 ³⁰ | ❌ |
| Stop following on request (judged, no magic word) | ✅ | 🔧 ²³ | ✅ ⁹ |
| Stop an in-flight turn (a reaction / `/oe stop`) | ✅ | 🔧 ²² | ✅ |

## Memory

| Feature | Slack | Teams | Discord |
| --- | :-: | :-: | :-: |
| Identity binding (workspace / surface / mode, fail-closed) | ✅ | ✅ ²⁰ | ✅ |
| Per-surface memory silo | ✅ | 🔧 | ✅ |
| Domain/org-brain sharing (gated by trust, not public/private) | ✅ | 🚧 ¹⁰ | 🚧 ¹¹ |
| External/guest trust gate, positively verified | ✅ | 🚧 ¹² | 🚧 ¹² |
| DM-partner verification (unlocks the shared `dm` layer) | ✅ | 🔧 ²⁸ | ❌ |
| Memory admin tools from any channel/DM | ✅ | 🔧 ¹³ | 🔧 ¹³ |

## Governance

| Feature | Slack | Teams | Discord |
| --- | :-: | :-: | :-: |
| Admin approval cards (approve/reject button clicks) | ✅ | 🔧 ²⁷ | ✅ ¹⁴ |
| Propose spend-cap changes (`set_spend_limit` / `clear_spend_limit`) | ✅ | 🔧 ²¹ | ✅ ¹⁴ |
| Approval-carded memory erasure (`purge_memory`) | ✅ | 🔧 ²¹ | ❌ |
| Spend caps enforced on inbound turns | ✅ | 🔧 ²⁶ | ✅ |
| Spend caps enforced on proactive fires (routines, webhooks) | ✅ | 🔧 | 🔧 |
| Spend & usage reporting tools | ✅ | 🔧 | 🔧 |
| Channel-history read tools (`read_channel` / `read_thread`) | ✅ | 🔧 | 🔧 |
| Offer to pick a request back up after the person consents (OAuth return hop) | 🚧 ²⁴ | 🚧 ²⁴ | 🚧 ²⁴ |
| Zero-inference `/oe` slash commands (status/budget, no model turn) | 🔧 ¹⁸ | 🔧 ¹⁹ | ✅ ¹⁸ |

## Proactivity

| Feature | Slack | Teams | Discord |
| --- | :-: | :-: | :-: |
| Scheduled routines post back to the surface | ✅ | 🔧 ¹⁵ | 🔧 ¹⁶ |
| Inbound webhooks trigger a turn on a surface | ✅ | 🔧 ¹⁷ | 🔧 ¹⁷ |

## Footnotes

1. **Discord ambient messages need the always-on Gateway relay** ([`deploy/discord-relay/`](../../../deploy/discord-relay/README.md)).
   Discord delivers `MESSAGE_CREATE` **only** over a persistent Gateway WebSocket, never to an
   HTTP endpoint — a serverless deploy cannot receive mentions, DMs, or channel follow-ups
   directly. That's a platform constraint (⛔ without the relay), not a missing feature; the
   relay is the workaround, and it carries its own small always-on bill.
2. Slack slash commands are forwarded to the underlying Eve Slack channel untouched; whether
   they dispatch a turn hasn't been confirmed either way. Mentions and DMs are the supported
   Slack entry points.
3. Teams replies land in the native reply-chain under the triggering message — the platform's
   own threading — with the conversation as the surface. No separate auto-thread step exists
   or is needed.
4. A mention in a base guild channel opens a thread (its own silo and session) and the
   conversation moves there; toggle with `discord.autoThread`. Fails open to an inline
   reply if thread permissions are missing. **Discord has no threads in DMs** (⛔ there —
   replies land in place), and forum posts are already threads.
5. Live step labels while a tool runs (`Searching Notion…`, code-owned, never model text) and
   rotating status verbs between steps on the typing indicator, a 👀 working / 🛑 blocked reaction on the
   thread root (removed when the reply lands — absence is the done signal), and a pinned
   in-flight status message per channel.
6. The Eve channel's built-in typing indicator only.
7. A 👀 "seen/working" reaction on direct addresses (mentions and DMs) plus Discord's native
   typing indicator while the turn runs; on auto-threaded mentions the 👀 is removed when the
   answer lands (absence = done — ✅ stays reserved for humans, the same convention as Slack).
   Toggle with `discord.statusUx`. See
   [Working indicators](./discord.md#working-indicators-status-ux).
8. On the Gateway path a conversation resumes per channel/thread id. The slash-command
   interactions path keys each invocation separately — `/ask` turns don't resume a session.
9. Asking it to stop following is **judged, not pattern-matched** (OPE-418): however you
   phrase it, the agent reads the intent and calls `stand_down`, which sets a durable
   marker; an @mention clears it. There is no magic word, and the regex that used to look
   for one is deleted — it disengaged on "don't stop the deploy" as readily as on "stop".
   Because it is a judged turn it costs inference; the ✋ / `/oe stop` row above is the free
   path, and it stops the *current turn* rather than the following. See
   [Stopping it following](./discord.md#stopping-it-following).
10. Inbound Teams activities rarely carry `membershipType`, so `teamsTrust` can't positively
    confirm in-tenant membership and channels fail closed to `external` — no domain/org brain
    — until a Graph-API enrichment supplies it, or the deploy vouches the tenant/channel.
11. Discord has no guild-membership/guest check yet, so every guild starts `external` (no
    domain/org brain) until the operator vouches the guild via `identity.blanketTrust: "internal"` or a
    `surfaces.ts` entry — see [the Discord guide](./discord.md#how-the-silo-model-maps).
12. No positive membership verification exists yet on this platform, so unverifiable surfaces
    bind `external` (shared/org memory gated off) unless the deploy vouches for them
    (`identity.blanketTrust: "internal"` or a per-surface vouch). Teams does honour positive facts when
    present. A Shared Channel always binds `external`, with no override. The Bot Connector roster
    also identifies a guest positively, and a guest binds `external` ahead of any vouch. In a
    channel or a group chat the roster can only narrow trust, never widen it. In a 1:1 chat a
    roster member of the home tenant verifies the DM partner (²⁸).
13. The memory-admin tools aren't platform-gated; they gate on the **caller** being an org or
    domain admin, so your `Domain.admins` lists must carry that platform's user ids — written
    platform-qualified (`teams/<user-id>`, `discord/<user-id>`), since the roster is matched
    as `platform/<id>` against the caller's own surface.
14. Live-verified 2026-07-06/07 on a real guild (channel-posted and DM-posted cards, both
    clicked): approval cards post with Approve/Reject buttons, clicks arrive on the
    interactions endpoint (route-fronted), and the decide core is shared with Slack.
    Approvers = the config-as-code admin roster, OR a guild **ADMINISTRATOR** for that
    guild's own scopes — DM clicks verify guild-admin standing via a REST lookup against
    the card's own guild (fail-closed on every leg).
15. Teams proactive messages require the **conversation reference** captured on a prior
    inbound turn (Bot Framework has no cold-send); it's stored automatically at routine
    creation, and a routine missing one fails closed to a dry run.
16. Discord routine post-back is a plain REST create-message with the bot token — it works
    **without** the Gateway relay.
17. Since OPE-2419 a webhook target can name a room on any of the three surfaces
    (`slack/T…/C…`, `discord/<guild>/<channel>`, `teams/<tenant>/<conversation>`) or a person's DM
    (`dm:slack/T…/U…`, `dm:discord/<user>`, `dm:teams/<29: id>`). The fire resolves the target
    through the same per-surface resolver a routine uses, and an unresolvable target declines with a
    reason on the `webhook.declined` audit row. Discord and Teams are 🔧: unit suites pin both
    resolvers, and no live leg has fired one yet. Two limits apply. A Teams target needs a captured
    conversation reference: the bot must hear one message in that conversation (or one 1:1 message
    from that person) first. A Discord room target must name the guild the channel is in; the
    resolver checks it and refuses a mismatch. A Teams room target names a channel or a group
    chat; a 1:1 chat is named as a person. Neither surface reports a room roster, so a webhook there
    fails closed: a group chat or group DM is refused, and a channel fires only once it is declared
    internal in `agent/identity/surfaces.ts`.
18. Built 2026-07-06 (backlog item 23). **Discord: live-verified 2026-07-07** — `/oe`
    registered on a real guild and exercised end-to-end (`/oe status`, `/oe budget`,
    `/oe help`). **Slack: built, awaiting the one portal step** (adding the Slash Command
    with the dedicated `/eve/v1/slack/commands` Request URL to the app config); the route
    itself is exercised with fabricated signed requests. See
    [Discord](./discord.md#slash-commands-oe-zero-inference-control-plane) /
    [Slack](./slack.md#slash-commands-oe-zero-inference-control-plane).
19. **Teams `/oe` commands, built 2026-10-12 (OPE-2443), not yet live-verified.** A Teams bot
    command is message text, not a slash-command event, so the inbound route reads the text. A
    message that starts with `/oe` is a command in any conversation. A message that starts with
    `oe <verb>` (no slash) is a command only when it @mentions the bot or is in a personal chat, and
    only for a known verb — that is the text a pick from the app's command list inserts, because the
    manifest's `commandLists` suggests `oe help`, `oe status`, `oe budget` and `oe stop`. Every verb
    runs through core's `runOeCommand`, the same dispatcher as Slack and Discord, with no model turn
    and no spend gate. **The answer is not ephemeral:** a Teams bot cannot post a message that only
    one channel member sees, so the answer posts into the conversation that asked (the reply chain
    in a channel). `/oe budget raise` and `/oe budget clear` post their card in place — a channel
    card in the channel, a chat card in the chat. `/oe stop` stops the turn anchored on the asking
    conversation. A messaging extension was the other design; it was not chosen, because none of
    the `/oe` verbs is a search or an action card. See
    [Teams § `/oe` commands](./teams.md#oe-commands-zero-inference-control-plane).
20. **Live-verified 2026-07-08** on a real Microsoft 365 tenant against the production deploy
    (single-tenant Azure Bot, app id registered in `teams-app/manifest.filled.json`): an
    @mention of the bot in a team channel ("hello") woke a turn and posted a reply back — the
    full inbound path (Bot Framework JWT validation → identity binding → channel wrap → model
    turn → post-back) end-to-end. Now **automated** by the `J-TEAMS` e2e scenario (the Graph-API
    driver, [Teams § End-to-end testing](./teams.md#end-to-end-testing-graph-api-driver)): it
    posts a genuine Graph @mention as a real user, the bot wakes, and the reply is read back
    off the message's reply chain and judged. Only the channel-@mention path is exercised so
    far; DM wake, threading, and proactive fires remain 🔧.
21. **The PROPOSE works on Teams, and every Teams conversation hosts its own card** — a channel
    since OPE-2424 (²⁷), and a personal or group chat since OPE-2447. A chat carries no channel id,
    so the Teams bundle names the chat's own conversation as its card room. The redirect below is
    now for a room with no card path at all (GitHub, Linear, Notion): its card is
    **routed to a card-capable channel in the same domain** — a Slack or Discord channel, or a
    Teams channel — and the agent tells you which one and that someone there has to act on it. Before
    OPE-2447 a Teams chat took that redirect too, so `purge_memory`, `request_access`, `revoke_connector`,
    `clear_connector_override`, `set_spend_limit`, `clear_spend_limit`, the five routine-authoring
    verbs (`cancel_routine`, `edit_routine`, `enable_routine`, `add_routine_rule`,
    `remove_routine_rule`), `open_pull_request`, `create_skill`, `delete_skill`, the
    three ticket verbs (`set_state`, `assign`, `create_ticket`), `create_agent` and
    `declare_webhook` worked from a Teams personal or group chat only *provided the domain had
    somewhere to put a card*. Now they card in the chat. A card-less room that is in no explicit
    domain, or whose domain holds no card-capable channel, gets a refusal naming the config to
    change. (`create_agent` also refuses a room that's already IN a domain — its
    whole job is turning a domain-less channel into one, which is exactly the precondition a
    redirect needs, so in practice it either finds no domain to route through or hits that other
    refusal a step later; either way nothing is provisioned from a card-less room that's already
    spoken for.) The one exception left is `rotate_webhook` (the reply carries a minted secret, so
    moving its card would move the secret with it), which still refuses outright. 🔧 rather than ✅
    because the redirect is pinned by tests, not yet exercised against a live tenant. See
    [Control plane § Asking from a surface that can't host a card](../../security/control-plane.md#in-slack-approvals).
    The `/oe budget` slash commands are excluded — they refuse rather than redirect. On Teams they
    card in place, because every Teams conversation now hosts its own card (¹⁹).
22. **Every surface has a stop control; three of them wear a different shape.** Teams delivers
    `messageReaction` activities, so the control there is a reaction, and since OPE-2443 the
    `/oe stop` command (¹⁹) as well. Its vocabulary is six fixed values with no ✋ in it, so Teams uses 😠,
    and Teams sends the event only for messages the agent itself sent. Linear delivers
    comment-reaction events and uses ✋ like Slack and Discord, and the host places the glyph on
    the issue's comment (OPE-899/900) the same way it does there. GitHub and Notion send **no**
    reaction webhook at all, so their control is a comment whose whole body is `stop` — read in
    the ingress, never by the model, and never matched inside a sentence. Notion's comment
    webhook also carries no text, so it reads the trigger off the same fetch its ambient reader
    already runs (OPE-989). Every one of these routes into the same cancel path; see
    [Stopping a turn](../../how-it-works/agent-and-loop.md#stopping-a-turn).
    Asking the agent to stop *following* still works everywhere, because it is judged rather
    than clicked. The Teams cell is 🔧: tests pin the 😠 stop, but no live leg drives it yet.
23. **Teams engaged threads, built 2026-09-07 (OPE-1500), not yet live-verified.** An @mention
    engages the reply chain (or the group chat), a later plain message in it wakes the agent,
    and `stand_down` stores the stop — the same core registry Slack and Discord use. It is 🔧
    rather than ✅ for two reasons, and the second is not ours: the `J-ENGAGED-teams` e2e leg
    has not run against the tenant yet, and Microsoft delivers a non-mention message only where
    a team owner consented to the `ChannelMessage.Read.Group` RSC grant (`ChatMessage.Read.Chat`
    for a chat). Without that grant the follow-up never arrives and the seam can wake nothing —
    the leg self-skips naming it. See
    [the Teams runbook](teams.md) and the chat-surface contract §2.5.
24. **Consent resume, built 2026-09-09 (OPE-1619), not yet live-verified.** When a request detours
    to ask a person for connector consent, the agent records where that request came from — surface,
    room, thread, paused session, and the person the link was minted for — and hands that record to
    the authorization. On the OAuth return hop it posts ONE line into that same conversation saying
    the connection is live and offering to pick the request up; past the authorization window it
    asks for a fresh request instead. It is 🚧 rather than ✅ on all three surfaces because the leg
    has not been driven against a live tenant, and 🚧 rather than a full automatic resume on
    purpose: a turn woken from the browser's return carries no acting person, and minting a personal
    token needs one, so the agent cannot re-run the interrupted call on its own — the person's next
    message is what carries the identity. See
    [connectors and providers](../../capabilities/connectors-and-providers.md).
25. **Teams reads backscroll over Microsoft Graph, in channels only.** The seat catch-up and the
    `read_channel` / `read_thread` verbs read `/teams/{team}/channels/{channel}/messages` and
    its `replies`. A
    personal or group chat carries no team id, so it takes no catch-up. The read needs the
    per-team `ChannelMessage.Read.Group` grant that a team owner consents to at install, or a
    tenant-wide Graph permission on the app registration.
26. **The Teams inbound handler runs the shared ingress spend gate** (`ingressSpendGate`) before the
    model turn, the same function every other surface calls. An over-budget scope declines the
    turn with a visible refusal and a `spend.gate` audit row. A message that the single-window
    front diverts takes the window's own spend gate instead. The Teams provider integration test
    drives the real handler against an over-budget scope. No live leg has driven it yet.
27. **The Teams approval card, built 2026-10-10 (OPE-2424), not yet live-verified.** A governed
    act asked in a Teams **channel** posts an Adaptive Card into that channel, as a new post, with
    `Action.Execute` Approve and Reject buttons. A tap reaches the deployment as an
    `adaptiveCard/action` invoke on the same public route as a message. The route verifies the Bot
    Framework JWT first and answers 401 to an unsigned or forged invoke, before it reads the body,
    and it counts a tap only from the `msteams` channel of the bot registration.
    A verified tap goes through the same decide core as Slack and Discord: the same approver tiers
    (the `Domain.admins` roster, written `teams/<user-id>`), the same clicker gate, the same halt
    check and the same `approval.*` audit rows. The decided card replaces the pending one. A tap posts no
    separate decision notice when the card update landed, a seat took the decision wake and no thread
    seat or worker owns the reply chain (OPE-2473). Otherwise one post states the outcome and names nobody, because a Teams post
    cannot spell a mention as `<@id>` (OPE-2490). A TTL expiry or a released card is not redrawn, so it
    always gets that post. The judge-lift notice carries its
    "This should not have run" button on Teams too. A personal or group chat hosts its own card
    since OPE-2447: the card posts into the chat, and the decision wakes the chat's own DM seat and
    no other. A chat card's decision never wakes a domain window, even under a tenant-wide domain
    claim. Teams has no platform-native admin leg — a team owner is not an OE approver. The
    audience-floor legs that need a room roster stay inert, because no Teams roster supplier is
    registered; so a kind that hands the clicker a live secret is refused on a Teams tap. 🔧 rather
    than ✅ until the `S-CARD-teams` e2e leg passes on a live tenant — its tap leg needs a person in
    the Teams client, because Graph cannot press a card button.
28. **Teams DM-partner verification, built 2026-10-12 (OPE-2446), not yet live-verified.** A 1:1
    partner is verified when the Bot Connector roster reports a recognised member role (`user`,
    `member`, `owner`, `admin` or `organizer`; any other role gives no verdict) and the chat's tenant
    is the bot app's own home tenant (`MICROSOFT_TENANT_ID`, or `TEAMS_TENANT_ID`). A member of
    another tenant, or a deployment with neither setting, stays unverified and fails closed — unless
    the deployment sets `identity.blanketTrust: "internal"`, which skips the DM-partner gate for
    every DM, the foreign-tenant member included. The verdict reads the tenant id off the
    activity, so it rests on the inbound route's `channelId` check (OPE-2455): the route accepts
    only `msteams`, which the Bot Framework service stamps per channel. No live probe has confirmed
    that a Direct Line client cannot override `channelId`. The roster lookup goes only to an
    allowlisted Bot Connector host. 🔧 rather than ✅ until a live 1:1 chat shows a member reaching
    the `dm` layer.
29. **Teams name-drop wake, built 2026-10-12 (OPE-2444), not yet live-verified.** A team-channel
    message that names the agent without an @mention wakes it for a judged turn on a domain with
    `nameDropWake: true` — the same token set, domain flag and audit rows as Slack and Discord
    (`surface.name_drop_woke` / `surface.name_drop_silent`). The name is the one Teams relays for the
    bot on the activity, else the app's Graph display name. Channels only: a personal chat is always
    answered, and a group chat is gated by the engagement seam (²³). A name-drop engages no reply
    chain, so a later plain message in that chain does not wake the agent. **The tenant decides
    whether this ever runs:** Microsoft delivers a non-@mention channel message to the bot only where
    a team owner consented to `ChannelMessage.Read.Group` at install, and no API reports that
    consent. Without it, a name-drop never reaches the deployment. The `J-NAMEDROP-teams` e2e leg
    states the same condition.
30. **Teams channel intro, built 2026-10-12 (OPE-2445), not yet live-verified.** The agent posts
    core's fixed intro once per team channel, on the same once-only marker Slack uses. Two doors
    reach it: the join (the `conversationUpdate` that adds the app to a team, which Teams sends in
    the General channel only) and the first @mention in any other channel. Unlike Slack's join
    intro, it is fixed copy and not a judged model turn: the Bot Connector has no backscroll to read
    first. A personal or group chat, a shared channel, and a room the external-participant policy
    silences get no intro, and a marker that cannot be written posts nothing. **Pinned-instruction
    adoption is ⛔ on Teams:** Microsoft Graph has no pinned messages for a team channel, and the
    Bot Connector has no pin API, so the 🚧 cell is the intro half alone.

## How to read this — and how it's updated

- **Every cell is evidence-based.** A status reflects what the code and setup guides actually
  do, not intent: ✅ means it has run against the live platform, 🔧 means the code exists but
  hasn't, ❔ means we genuinely don't know yet. The matrix is updated when a feature lands or
  a live verification happens — not before.
- **⛔ is the most important signal.** It marks things the *platform* rules out (Discord won't
  deliver ambient messages to an HTTP endpoint; Discord DMs have no threads) — no amount of
  project work changes those, only workarounds like the Gateway relay. ❌, by contrast, is
  honest backlog: possible, not built.
- **Fail-closed partials are deliberate.** Several 🚧 cells (shared-brain and trust rows) are
  the security model working as designed: when a platform can't positively prove a surface is
  public or internal, memory stays narrow. See [Memory](../../capabilities/memory.md) and the
  [security model](../../security/security-model.md).
