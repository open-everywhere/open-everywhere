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

- **Teams is now live on one path, 🔧 elsewhere.** As of 2026-07-08 the core spine —
  channel @mention wake, JWT-validated inbound, identity binding, channel wrap, model turn,
  and reply post-back — is verified end-to-end against a real Microsoft 365 tenant on the
  production deploy²⁰. The remaining Teams cells (DM wake, threading, proactive fires, memory
  tiers) still read 🔧: the code exists but those specific paths haven't been exercised yet.
- **Discord has two ingestion paths.** The HTTP **interactions** endpoint (slash commands)
  works on a plain serverless deploy; **ambient messages** (@mentions, DMs, channel follow-ups)
  only exist on the **Gateway relay** path¹. Cells below assume the relay is running; without
  it, everything ambient is ⛔ by platform design.

## Conversation

| Feature | Slack | Teams | Discord |
| --- | :-: | :-: | :-: |
| Wake on @mention in a channel | ✅ | ✅ ²⁰ | ✅ ¹ |
| Wake in a DM, no mention needed | ✅ | 🔧 | ✅ ¹ |
| Slash-command invocation | ❔ ² | ❌ | 🔧 |
| Reply without re-tagging (engaged threads) | ✅ | 🔧 ²³ | ✅ ¹ |
| Judged silence (may decline to reply on a follow) | ✅ | 🔧 | ✅ |
| Name-drop wake (opt-in, per domain) | ✅ | ❌ | ✅ |
| One task = one thread | ✅ | 🔧 ³ | ✅ ⁴ |
| Working indicators | ✅ ⁵ | 🔧 ⁶ | ✅ ⁷ |
| Durable multi-turn sessions (resume across messages) | ✅ | 🔧 | ✅ ⁸ |
| Reads channel backscroll for context | ✅ | 🔧 | 🔧 ¹ |
| Intro when invited into a channel | ✅ | ❌ | ❌ |
| First-contact onboarding + pinned-instruction adoption | ✅ | ❌ | ❌ |
| Stop following on request (judged, no magic word) | ✅ | ✅ | ✅ ⁹ |
| Stop an in-flight turn (a reaction / `/oe stop`) | ✅ | ✅ ²² | ✅ |

## Memory

| Feature | Slack | Teams | Discord |
| --- | :-: | :-: | :-: |
| Identity binding (workspace / surface / mode, fail-closed) | ✅ | 🔧 | ✅ |
| Per-surface memory silo | ✅ | 🔧 | ✅ |
| Domain/org-brain sharing (gated by trust, not public/private) | ✅ | 🚧 ¹⁰ | 🚧 ¹¹ |
| External/guest trust gate, positively verified | ✅ | 🚧 ¹² | 🚧 ¹² |
| DM-partner verification (unlocks the shared `dm` layer) | ✅ | ❌ | ❌ |
| Memory admin tools from any channel/DM | ✅ | 🔧 ¹³ | 🔧 ¹³ |

## Governance

| Feature | Slack | Teams | Discord |
| --- | :-: | :-: | :-: |
| Admin approval cards (approve/reject button clicks) | ✅ | ❌ | ✅ ¹⁴ |
| Propose spend-cap changes (`set_spend_limit` / `clear_spend_limit`) | ✅ | 🔧 ²¹ | ✅ ¹⁴ |
| Approval-carded memory erasure (`purge_memory`) | ✅ | 🔧 ²¹ | ❌ |
| Spend caps enforced on inbound turns | ✅ | ❌ | ✅ |
| Spend caps enforced on proactive fires (routines, webhooks) | ✅ | 🔧 | 🔧 |
| Spend & usage reporting tools | ✅ | 🔧 | 🔧 |
| Channel-history read tools (`read_channel` / `read_thread`) | ✅ | 🔧 | 🔧 |
| Offer to pick a request back up after the person consents (OAuth return hop) | 🚧 ²⁴ | 🚧 ²⁴ | 🚧 ²⁴ |
| Zero-inference `/oe` slash commands (status/budget, no model turn) | 🔧 ¹⁸ | ❌ ¹⁹ | ✅ ¹⁸ |

## Proactivity

| Feature | Slack | Teams | Discord |
| --- | :-: | :-: | :-: |
| Scheduled routines post back to the surface | ✅ | 🔧 ¹⁵ | 🔧 ¹⁶ |
| Inbound webhooks trigger a turn on a surface | ✅ | ❌ ¹⁷ | ❌ ¹⁷ |

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
5. Rotating status verbs on the typing indicator, a 👀 working / 🛑 blocked reaction on the
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
    present — a Shared Channel always binds `external`, no override.
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
17. Webhook targets are currently validated as `slack/TEAM/CHANNEL` — a hook can't point at a
    Teams/Discord surface yet.
18. Built 2026-07-06 (backlog item 23). **Discord: live-verified 2026-07-07** — `/oe`
    registered on a real guild and exercised end-to-end (`/oe status`, `/oe budget`,
    `/oe help`). **Slack: built, awaiting the one portal step** (adding the Slash Command
    with the dedicated `/eve/v1/slack/commands` Request URL to the app config); the route
    itself is exercised with fabricated signed requests. See
    [Discord](./discord.md#slash-commands-oe-zero-inference-control-plane) /
    [Slack](./slack.md#slash-commands-oe-zero-inference-control-plane).
19. Teams has no slash-command surface wired at all yet — plain backlog, not a
    platform limitation (Bot Framework messaging extensions could carry this).
20. **Live-verified 2026-07-08** on a real Microsoft 365 tenant against the production deploy
    (single-tenant Azure Bot, app id registered in `teams-app/manifest.filled.json`): an
    @mention of the bot in a team channel ("hello") woke a turn and posted a reply back — the
    full inbound path (Bot Framework JWT validation → identity binding → channel wrap → model
    turn → post-back) end-to-end. Now **automated** by the `J-TEAMS` e2e scenario (the Graph-API
    driver, [Teams § End-to-end testing](./teams.md#end-to-end-testing-graph-api-driver)): it
    posts a genuine Graph @mention as a real user, the bot wakes, and the reply is read back
    off the message's reply chain and judged. Only the channel-@mention path is exercised so
    far; DM wake, threading, and proactive fires remain 🔧.
21. **The PROPOSE works on Teams; the card does not live there.** Teams still can't host an
    approval card (the row above stays ❌ — no renderer, no poster, no click route), but that
    stopped deciding whether these tools exist: the card is **routed to a card-capable Slack or
    Discord channel in the same domain**, and the agent tells you which one and that someone
    there has to act on it. So `purge_memory`, `request_access`, `revoke_connector`,
    `clear_connector_override`, `set_spend_limit`, `clear_spend_limit`, the five routine-authoring
    verbs (`cancel_routine`, `edit_routine`, `enable_routine`, `add_routine_rule`,
    `remove_routine_rule`), `open_pull_request`, `create_skill`, `delete_skill`, the
    three ticket verbs (`set_state`, `assign`, `create_ticket`), `create_agent` and
    `declare_webhook` all work from a Teams conversation *provided the domain has somewhere to
    put a card* — if it doesn't, or the room is in no explicit domain, you get a refusal naming
    the config to change. (`create_agent` also refuses a room that's already IN a domain — its
    whole job is turning a domain-less channel into one, which is exactly the precondition a
    redirect needs, so in practice it either finds no domain to route through or hits that other
    refusal a step later; either way nothing is provisioned from a card-less room that's already
    spoken for.) The one exception left is `rotate_webhook` (the reply carries a minted secret, so
    moving its card would move the secret with it), which still refuses outright. 🔧 rather than ✅
    because the redirect is pinned by tests, not yet exercised against a live tenant. See
    [Control plane § Asking from a surface that can't host a card](../../security/control-plane.md#in-slack-approvals).
    The `/oe budget` slash commands are excluded — they refuse rather than redirect, and Teams
    has no slash-command surface anyway (¹⁹).
22. **Every surface has a stop control; three of them wear a different shape.** Teams has no
    slash-command surface, but it does deliver `messageReaction` activities — so the control
    there is a reaction. Its vocabulary is six fixed values with no ✋ in it, so Teams uses 😠,
    and Teams sends the event only for messages the agent itself sent. Linear delivers
    comment-reaction events and uses ✋ like Slack and Discord, and the host places the glyph on
    the issue's comment (OPE-899/900) the same way it does there. GitHub and Notion send **no**
    reaction webhook at all, so their control is a comment whose whole body is `stop` — read in
    the ingress, never by the model, and never matched inside a sentence. Notion's comment
    webhook also carries no text, so it reads the trigger off the same fetch its ambient reader
    already runs (OPE-989). Every one of these routes into the same cancel path; see
    [Stopping a turn](../../how-it-works/agent-and-loop.md#stopping-a-turn).
    Asking the agent to stop *following* still works everywhere, because it is judged rather
    than clicked.
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
