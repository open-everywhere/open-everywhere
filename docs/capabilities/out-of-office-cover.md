# Out-of-office cover

While a person is away, the agent can answer questions that people ask them in the agent's channels. Each
answer is marked as cover. When the person comes back, they get one recap in their DM of what people asked
and what the agent answered. Cover is off for everybody until a person turns it on for themselves (OPE-2513).
It works on Slack, Microsoft Teams and Discord (OPE-2534).

## Turning it on and off

A person turns cover on from their own direct message with the agent:

| Command | What it does |
| --- | --- |
| `/oe cover on` | Turns cover on until the person turns it off. |
| `/oe cover on until 2026-10-21` | Turns cover on until the start of that day (UTC). The date must be within 90 days. |
| `/oe cover off` | Turns cover off at once. The recap follows within a few minutes. |
| `/oe cover` | Says whether cover is on, until when, and how many questions it covered so far. |

On Discord the command is a group: `/oe cover on` (with an optional `until` field), `/oe cover off` and
`/oe cover status`, because Discord needs a concrete subcommand. On Teams it is the message `/oe cover on`,
or `oe cover on` in the DM. A Discord DM binds `external` by default, so on Discord `on` works only where the
operator's own trust declaration makes the DM `internal` (for example `identity.blanketTrust: "internal"`).
The deployment registers `/oe` only in the guilds it declares, and a guild command does not reach a DM. So
a DM shows no `/oe` until the operator registers it **globally** once: `npm run register:discord-commands`
with `DISCORD_GUILD_ID` unset. A global command takes up to an hour to appear.

- **`on` works only in the person's 1:1 DM with the agent, and only for a member of the organisation**
  (the binding's trust is `internal`). A guest, a stranger and a routine fire cannot turn it on. Nobody can
  turn it on for somebody else: the command keys on the person who ran it.
- **`off` and the status read work anywhere**, so a person always keeps the off switch.
- **"Away" is the person's own setting.** The agent does not read the person's Slack or Teams status. See
  [What it does not do](#what-it-does-not-do).

The command answers at once, with no model turn. On Slack and Discord the answer is private (ephemeral). A
Teams bot cannot post a message only one person sees, so on Teams the answer posts where the person asked:
`on` works only in the DM, and an `off` or a status read in a channel shows that person's setting to the
room ([Teams commands](../deploy/surfaces/teams.md)).

## What happens in a channel

Cover rides the room's own standing seat. When a person posts a message in a channel that mentions somebody
with cover on, the room's seat already receives that message (the ambient seat road, on by default since
OPE-2409). The host then adds one trusted note to that wake. The note says that the mentioned person is
away, and it tells the seat to:

- answer a question meant for the person from what the room and its domain already know;
- never promise, agree, decide or commit to anything on the person's behalf, and never act as them;
- say so when it does not know, and promise nothing about what the person will see or do.

The seat still judges whether to reply at all. **Every** reply it posts on that wake starts with the cover
label, for example `Cover for Ana, who is away:`. On Teams the reply also carries Teams' own "AI generated"
label, because a cover answer is model text (OPE-2542). The host writes the label at the reply choke point
(`postUnifiedReply`, the door a windowed seat's `reply` takes), not the model. One exception: a reply
whose pointer cannot be read (a store outage, or a reply more than 6 hours after its wake) posts without
the label. The label uses the person's display name, with
markup removed. It never uses a raw id.

🔴 **A cover answer never widens access.** The wake keeps the room's binding, the room's auth bag and the
room's memory. The absent person is not the principal. The agent does not read their DM or their personal
memory, and it does not use their connectors. So a cover answer can use only what the room and its domain
already hold, which is what the asker could already read there. `test:slack-cover` pins this: the wake's
auth bag is byte-identical to the same wake with cover off.

Where cover applies, and where it does not:

- **Slack channels and private channels** where the room's seat is windowed (`routeSupervisorEvent`).
- **Teams channels** on the single-window path (`handleTeamsSingleWindowDispatch`, OPE-2534). Every Teams
  channel wake there is windowed. The message names a person with a Teams @mention.
- **Discord guild channels and threads** on the unified-window path (`divertDiscordWakeToUnifiedWindow`,
  OPE-2534). That path needs the operator's vouch for the guild or channel. A wake on Discord's native
  per-channel path has no wake id, so it gets no cover note.
- Cover needs the host-minted wake id, because the label and the recap key on it. A room with no window
  gets no cover note.
- **Not** in a DM, a group DM or group chat, or a GitHub, Linear, Notion, email or Google Chat room. Those
  surfaces do not call the cover seam (`docs/extending/chat-surface-contract.md`, the "Out-of-office cover"
  row).
- **Not** in a room where the seat does not see unaddressed talk (`ambientSupervisor` off), unless the
  message also mentions the agent.
- A person's mention of themselves is no cover question. One message looks up at most 5 mentioned people.

## The recap

Cover ends in two ways: the person's `/oe cover off`, or the end date passing. The `cover-recap` schedule
runs every 5 minutes. It ends each cover whose end date passed, then sends each due recap to the person's
own 1:1 DM. The DM seat writes the message. Each line says who asked, in which channel, the question, and
what the agent answered (or that it did not answer).

🔴 **The recap carries only what the person could already read.** A question from a public Slack channel is
shown. A question from any other room is shown only when the platform confirms that the person can read
that room:

| Surface | The check | When |
| --- | --- | --- |
| Slack private channel | The membership probe (`access/domain-membership.ts`) confirms the person a full member who sits in the channel. | At the recap. |
| Teams standard channel | The Bot Connector roster of the channel's TEAM holds the person (`teamsRosterHasMember`, addressed by `channelData.team.id`). Every team member can read a standard channel. Built, not yet proven on a live tenant: if the connector refuses the read, the question is left out. | At the question. |
| Teams private or shared channel | None. These channels have their own roster, so no question from them is shown. | — |
| Discord channel or public thread | Discord's own permission rule gives the person `VIEW_CHANNEL` (`discordMemberCanViewChannel`: the channel's overwrites, the guild's roles and the member's roles). A public thread reads as its parent channel. | At the question. |
| Discord private thread | None. No question from one is shown. | — |

A check at the question records its result on the question (`inRoom`). A check that fails, throws or
cannot run confirms nothing. Every question that is not confirmed is left out, and the recap says how many
it left out. A recap with no question to show sends nothing.

A Teams channel has no mention syntax that renders in a DM, so the recap names it by the name the Teams
name resolver finds (for example `#Launch`), or as "a Microsoft Teams conversation". It never shows the id.

- The recap goes to a 1:1 DM only. A target that resolves to any other room is refused.
- It passes the spend gate under the person's own DM allowance.
- The questions are text other people wrote, so they sit inside the untrusted fence and the fire is tainted.
- The tick claims the recap before it sends, so two ticks never send it twice. A refused send is tried
  again on the next tick. After 3 refused tries the tick drops the log and files `cover.recap_refused`.

## What is stored

One `personal_cover` row per person who turned cover on (sqlite and Postgres, row-level security on
Postgres, runtime grant `SELECT, INSERT, UPDATE`). The row holds whether cover is on, the end date, the
person's display name for the label, and the covered questions not yet in a recap. Each question and answer
is clipped to 280 characters, and the row keeps at most 25 questions. The recap empties the log when it
lands. A cover wake also writes one 6-hour pointer from the wake id to the covered people, so the reply
choke point can find the label.

🔴 **A store failure covers nobody.** A row that does not parse reads as cover off, and a store that does not
answer adds no note. A reply whose pointer cannot be read is posted without the label.

## Audit rows

`principalId` names the covered person by qualified key. No row holds the question or the answer.

| Action | When |
| --- | --- |
| `cover.set` | The person turned cover on (`until`) or off (`questions`), via `command` or `end-date`. |
| `cover.wake` | A room wake mentioned the person while cover was on, so the wake carried the cover note. On Slack, Teams or Discord. |
| `cover.answered` | A reply on a cover wake was posted with the label (`postUnifiedReply` or `postReply`), and became the answer in the recap. |
| `cover.recap` | The recap went to the person's DM (`questions`, `leftOut`, `sent`). |
| `cover.recap_refused` | The recap could not be delivered, and whether the tick gave up. |

## What it does not do

- **It does not read the person's Slack or Teams status.** No status or presence read exists in this
  repository. Slack exposes the status only with the `users.profile:read` scope, and Teams exposes
  presence only with the Graph `Presence.Read.All` permission. "Away" is the person's own `/oe cover`
  setting, with an optional end date.
- It does not answer in DMs, and it does not answer on GitHub, Linear, Notion, email or Google Chat.
- It does not hand a question to the person when they come back. The recap is a record, not a queue.
- The cover note is prompt text. The host enforces the label, the room's access and the recap's reach.
  It does not check whether an answer stays clear of commitments.

## Proof

- `npm run test:cover` (packages/core) — the command, the wake decision, the label at the real
  `postReply`, the recap tick and the delivery.
- `npm run test:slack-cover` — the real Slack room route carries the note, and the auth bag is unchanged.
- `npm run test:teams-cover` — the real Teams dispatch carries the note with the room's own auth, the roster
  confirms a standard channel only, a reply carries the cover label and Teams' AI label, and the recap names
  the channel.
- `npm run test:discord-cover` — the real Discord divert carries the note with an unchanged auth bag, the
  view rule as a truth table and over its REST reads, the reply label, and `/oe cover` on Discord.
- The live e2e scenario `S-COVER` drives `/oe cover on`, a mention in a domain channel, `/oe cover off` and
  the recap row. It is `NON_LAUNCH` until a board runs it.
