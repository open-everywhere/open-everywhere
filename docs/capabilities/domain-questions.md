# Your DM can ask your domains

A person's DM with the agent is their chief of staff. A person also belongs to several domains: a
launch, a project, a department. Each domain has its own seat, its own memory and its own rules. This
page describes how the DM asks one of those domains a question and brings the answer back (OPE-2452).

> **You:** what's the latest on the launch?
>
> **Agent:** I asked the Launch domain. I will tell you when it answers.
>
> **Agent:** The Launch domain says: the launch moved to Friday, and the checklist is green.

## How it works

1. You ask your DM something that one of your domains knows. The DM seat calls `ask_domain` with the
   domain's name and the question. With no domain name, `ask_domain` lists the domains you belong to,
   so the seat can pick the right one.
2. The host checks the gate below. Then it records the question and delivers it to the **standing
   seat** of the domain room you sit in. The call returns at once, so your DM does not wait.
3. The domain's seat answers in the turn the question woke, with `answer_domain_question`. It answers
   with the same context and the same rules it uses when you ask in that room. A later turn of that
   seat cannot answer, so a turn that someone else's message started cannot put an answer in your DM.
4. The host delivers the answer to your DM seat, and your DM seat tells you. If your DM seat cannot be
   woken, the host posts the answer into your DM itself.

**A turn runs as its room.** Your DM never reads the domain's memory or its rooms. Only the domain's own
seat reads them, in its own turn. In a domain with one window for all its rooms (`mode: "unified"`),
that is the whole window, as it is for a question you ask in the room itself.

## Who may ask

The host refuses a question unless every condition holds. Each refusal writes one
`domain_question.refused` row with its reason.

| Condition | Refusal reason |
| --- | --- |
| The question comes from a 1:1 DM. A channel and a group DM cannot ask: the answer goes to one person. | `not-dm` |
| The DM is internal. A DM with a guest or an external account binds external, and gets the strictest default. | `room-not-internal` |
| No guest or external account took part in the request. | `non-member-in-wake` |
| A verified person asks. A scheduled fire has nobody to answer to. | `no-asker` |
| The name is a declared team domain, not a pseudo-domain (`org`, `public`, `dm`). | `unknown-domain` |
| The domain does not set `dmQuestions: false`. | `domain-closed` |
| The platform can prove membership. Today only Slack registers a membership probe. | `membership-unverifiable` |
| The platform confirms you a full member of the workspace. A guest is not. | `not-full-member` |
| You sit in one of the domain's rooms, **and** the platform confirms that room internal. A shared room is no route into a domain. | `not-a-member` |
| The room's standing seat is running. A seat starts the first time someone talks to the agent in one of the domain's rooms. | `no-seat` |

Membership is a room. On Slack the probe uses the same trust gate as the
[App Home tab](./memory.md#memory-you-can-see): `users.info` for full membership, and
`conversations.info` for each channel. Both checks fail closed.

## What the domain's seat may say

The host fences **who** may ask, **which** seat answers and **where** the answer goes. **What** the
answer says is the domain seat's judgement. The delivery tells the seat who asks, which room they
belong through, and to answer as it would answer that person in that room. The seat can decline with
`declined: true` and one sentence on why; you are told it declined.

The host does not filter the answer. A question to a domain exposes what that domain's seat would say
to you in its room, and no more than that. It is the same exposure as a question you ask in the room.

The question reaches the domain's seat with no identity and no requester, at the standing grain. So
the seat answers from what it knows and can read; it does not act for you. The seat's turn resumes
under its own session binding, and that binding can name the member the seat last served in any room of its window.

## Where the answer goes

The answer goes to **your DM only**. The host freezes your DM in the question row when you ask, so the
domain's seat cannot choose a room for the answer. One question takes one answer: a second answer
finds the claim taken and sends nothing. A question stays answerable for six hours.

The delivery tells the domain's seat not to post in its own room about the question. The host does
not block such a post: the delivery wake carries the domain's room as its reply target, as every seat
wake does.

## Untrusted words

Each side quotes the other side's words as data inside the untrusted fence, never as instructions.
No mark of what either turn read crosses to the other seat.

## Turn it off

Set `dmQuestions: false` on a domain to refuse every DM question to it, and every answer to a question
asked before the change. See the [configuration reference](../deploy/configuration-reference.md#memory-domain--silo).

## The audit trail

Both sides write a row, so the DM's audit and the domain's audit each show the exchange. The rows
carry ids, names and counts, never the question or the answer.

| Action | Side | What it says |
| --- | --- | --- |
| `domain_question.asked` | DM | A member's DM asked a domain, through which room, and whether the domain's seat was woken. |
| `domain_question.received` | domain | Which member's DM asked this domain. |
| `domain_question.answered` | domain | The seat answered or declined, and how the answer reached the DM: `dm-seat`, `posted` or `failed`. |
| `domain_question.answer_delivered` | DM | Which domain answered the member, and how it reached their DM. |
| `domain_question.refused` | the side that refused | The reason, the domain and the tool. An answer is refused from the wrong seat, from a turn the delivery did not wake (`wrong-turn`), or from a turn a non-member took part in. |

## Limits

- **The person opt-out does not cover a domain question yet.** Both deliveries carry no identity of
  the asker. The domain seat's turn resumes under that seat's own binding, which can name another
  member. A memory write from that turn is attributed to that person, not to you, so it can save your
  question into the domain's silo whatever your [opt-out](./memory.md#opting-out-of-agent-actions-on-your-content)
  says. The answer turn in the DM resumes under the DM seat's own binding. No test proves that the
  binding names you, so do not rely on the opt-out on that turn either.
- **Slack only today.** A platform with no membership probe refuses with `membership-unverifiable`.
  A provider bundle adds one with `registerDomainMembershipProbe`.
- **The answer is the seat's judgement.** See [What the domain's seat may say](#what-the-domains-seat-may-say).
- **The domain's seat is told, not forced, to stay quiet in its room.** See [Where the answer goes](#where-the-answer-goes).
- **The answering turn reads the domain seat's own session.** Under the shipped external policy
  (`externalPolicy.authorGrain: "withhold"`), the body of a message from an author the platform refuted
  as a member (a guest, a stranger) never reaches the seat. A domain that sets `authorGrain: "envelope"`
  (or its deprecated alias) lets those words into the seat's session. `admission: "members-only"` keeps them out of the catch-up
  read only, not out of a turn that their own mention starts. A person the platform neither confirmed
  nor refuted can still add text through a mention. The host does not filter what that context steers.
- **No answer, no message.** If the domain's seat does not answer in the turn the question woke, the
  person hears nothing, and the question lapses after six hours. The DM seat said it asked, so the
  person can ask again.
- **The room's seat must be running.** A domain whose rooms have never woken the agent has no seat to ask.

Code: `packages/core/agent/channels/domain-question.ts` (the gate, the row and the deliveries),
`packages/core/agent/tools/ask_domain.ts`, `packages/core/agent/tools/answer_domain_question.ts`,
`packages/core/agent/access/domain-membership.ts` (the probe seam), and
`packages/providers/slack/agent/channels/slack-home.ts` (`slackDomainMembershipProbe`).
