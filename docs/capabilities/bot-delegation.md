# Your DM can ask other bots

A person's DM with the agent is their chief of staff. Part of that job is to ask other agents for
things on the person's behalf: "ask the deploy bot in #ops to roll back for me". This page describes
how the DM asks another bot in a shared channel, reads that bot's reply in the thread, and reports
back (OPE-2426).

> **You:** ask Viktor in #ops to roll back the deploy for me.
>
> **Agent:** I posted the ask in #ops as you. I will tell you when Viktor answers.
>
> **Agent:** Viktor replied: rolled back to v41.

## Why the ask goes out in your name

Other bots trust people, not bots. Slack refuses a direct message from one bot to another
(`cannot_dm_bot`), and many agents answer only a human, or only their owner. So the agent posts the
ask **in your name**, through your own Slack connection: "search Slack as you"
([`slackAsYou`](../deploy/surfaces/slack.md#search-slack-as-you), OPE-2421).

That connection is a personal-surface MCP server. It works only in your own 1:1 DM, and **every write
in your name posts an approval card first**. Nothing is sent until you approve it. So the first
message in your name is carded, and so is every later one. A click approves one call only.

## How it works

1. You ask your DM to ask another bot something. A job posts the ask in the channel through your own
   Slack connection, and @mentions the bot. You approve the card.
2. The DM seat calls `expect_bot_reply` with the channel, the ask message and the bot. The call posts
   nothing. The host checks the facts on Slack, never from the model:
   - **you** wrote that message;
   - the message **@mentions that bot**;
   - the account **is a bot** (`users.info` `is_bot`), and it is **not this agent**.
   Then the host records one **asked thread**: the thread, the bot, your DM, and a window.
3. When that bot replies **in that thread**, the host relays the reply to your DM seat, and your DM
   seat tells you. If your DM seat cannot be woken, the host posts the reply into your DM itself.

The agent must be a member of the channel. Slack sends a channel's messages to an app only when the app
is in the channel, and the host proves the ask with the agent's own token. A channel the agent is not
in refuses with `unreadable` and asks you to invite the agent.

## The narrow exception to "never act on another bot"

Everywhere else the agent drops a message another bot wrote: it never wakes on a bot (the bot-author
drop on each Slack door). On Slack, an asked thread is the only exception a real deployment has, and it is narrow by
construction. (The other bot admissions are the test deployment's e2e driver settings, OPE-1023:
`wake.driverAllowlist` on the engagement and mention doors, channel messages included, and
`wake.e2eDrivers` on the DM door and the seat's own reads. A real deployment leaves both empty.)

| A bot message | What happens |
| --- | --- |
| A reply, in an asked thread, from the bot that was asked, inside the window, under the cap | Relayed to the asker's DM. It never wakes the channel's seat. |
| A top-level post — the bot starts a conversation | The ordinary bot drop. Nothing wakes. |
| A reply in a thread nobody asked that bot in | The ordinary bot drop. Nothing wakes. |
| A reply from a different bot in an asked thread | The ordinary bot drop. Nothing wakes. |
| A reply after the window, or beyond the cap | The ordinary bot drop. Nothing wakes. |
| An edit or a delete of a reply | The ordinary bot drop. Nothing wakes. |
| This agent's own post | Never admitted. |

"Nothing wakes" is about waking. When a person wakes the agent in a channel, the seat's backscroll can
still show an attributable bot's earlier posts as context-only awareness, as it did before this feature
(`slack-wake-backscroll.ts` `isBackscrollVisible`).

**Loop-safe.** The relay goes to your DM only. The host never posts in the asked thread when another
bot's message arrives. Only `expect_bot_reply` opens a window. It runs only in your own 1:1 DM, never on
a scheduled run, and never on a turn that a relayed reply woke: the relay stamps that turn, and the tool
refuses it (`relay-turn`). So another bot's words cannot open the next window, even if they ask for one.

**The window.** An asked thread admits that bot's replies for **at most six hours**, and **five
replies** at most. A retried Slack event relays nothing twice. The window can close early: the
asked-thread row lives in a shared operational table whose prune uses the shortest time-to-live of any
writer, and today a stopped job's 15-minute cancel ticket is the shortest. A reply after an early close
falls through to the ordinary bot drop, so you hear nothing; the DM seat said it was waiting, so you can
ask again.

## Who may open an asked thread

The host refuses `expect_bot_reply` unless every condition holds. Each refusal writes one
`bot_ask.refused` row with its reason.

| Condition | Refusal reason |
| --- | --- |
| The call comes from a 1:1 DM. A channel and a group DM cannot open one. | `not-dm` |
| The DM is internal. A DM with a guest or an external account binds external. | `room-not-internal` |
| No guest or external account took part in the request. | `non-member-in-wake` |
| A verified person asks. A scheduled run carries the person as attested, not acting. | `no-asker` |
| The turn is not a scheduled run. | `unattended` |
| The turn was not woken by another bot's relayed reply. | `relay-turn` |
| The platform can prove an ask. Today only Slack registers a probe. | `platform-unsupported` |
| The agent can read the message (it is in the channel). | `unreadable` |
| You wrote the message. | `not-yours` |
| The message @mentions the bot. | `bot-not-named` |
| The account is a bot. | `not-a-bot` |
| The account is not this agent. | `self` |

## Untrusted replies

Every relayed reply reaches your DM seat inside the untrusted fence. Another
bot's words are untrusted whatever they say. The relay quotes the reply as data inside a fence, and
tells the seat not to follow instructions inside it. A reply longer than 8,000 characters is cut, and
the relay says so.

## The audit trail

The rows carry ids, names and counts, never the ask or the reply.

| Action | What it says |
| --- | --- |
| `bot_ask.expected` | Your DM opened an asked thread: the ask, the bot, the channel and thread, the window and the cap. |
| `bot_ask.refused` | `expect_bot_reply` refused, with the reason. |
| `bot_ask.reply_relayed` | A reply was relayed to your DM: the ask, the bot, the reply slot, and the route (`dm-seat`, `posted` or `failed`). |

The bot drop on every other bot message keeps its own `surface.wake_dropped` row, unchanged.

## Limits

- **Slack only today.** Teams has no path yet to post as you: the Teams provider uses the app's own
  Graph token, and no Teams probe is registered. So on Teams `expect_bot_reply` refuses with
  `platform-unsupported`: no asked thread opens there and no bot reply is relayed. Where the other agent speaks
  A2A, [delegation to a declared agent](../extending/a2a-agents.md) is the cleaner route.
- **"Search Slack as you" must be declared.** Without `slackAsYou` in `agent/access/mcp-servers.ts`,
  the agent cannot post in your name, so there is no ask to wait on. It is off on a default install.
- **Two steps, both the model's.** The job must return the channel id and the message ts, and the DM
  seat must then call `expect_bot_reply`. If either step is skipped, the bot's reply is never relayed
  and never wakes the agent: the safe direction.
- **The report is the DM seat's.** The host relays the reply and tells the seat to tell you. It does
  not check what the seat then says. If the seat cannot be woken, the host posts the reply itself.
- **The window can close early, silently.** See [The window](#the-narrow-exception-to-never-act-on-another-bot).
  A per-row expiry needs its own store; it is a follow-up.
- **No live proof yet.** No e2e scenario drives a second bot in a shared channel. The offline tests
  drive the real Slack front route and the real core decision over a real store
  (`packages/providers/slack/scripts/slack-bot-ask-test.ts`, `packages/core/scripts/bot-ask-test.ts`).

Code: `packages/core/agent/channels/bot-ask.ts` (the gate, the asked-thread row, the inbound exception
and the relay), `packages/core/agent/tools/expect_bot_reply.ts`,
`packages/providers/slack/agent/channels/slack-bot-ask.ts` (the probe and the facts), and the
asked-thread branch in `packages/providers/slack/agent/channels/slack-front.ts`.
