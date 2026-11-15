# Email

Give the agent its own email address. People write to it, forward a thread to it, or add it to a thread on
Cc, and it answers by email in the same thread. Mail reaches the same two chiefs of staff as chat:

- A **room inbox** (for example `launch@agent.acme.com`) belongs to a domain. Mail to it wakes that domain's
  standing seat, exactly as a message in one of the domain's channels would.
- A **personal inbox** (for example `oe@agent.acme.com`) is each person's chief of staff by email. Mail from a
  person this deployment declares wakes that person's own DM seat. A forward from them is how they hand the
  agent a thread.

Email is a full surface on its own. An organisation that runs Microsoft Teams and no Slack gets the whole
capability: the inbound path, the reply, and the approval card to add a sender (the card posts in a Teams
channel of the same domain).

Email here is the agent's **own** channel. Reading a person's own mailbox stays the own-account connector route
(their Google or Microsoft sign-in), not this surface.

## What it does and does not do

- **Allowed senders only.** A room inbox lists who may write to it (exact addresses or `*@domain`). Mail from
  anyone else is refused before any model sees it, and the refusal is audited (`email.refused`). Nobody gets an
  automatic reply: an answer to a stranger is cold mail.
- **Authenticated senders only.** A `From` header is a claim anybody can type. Only mail whose sender passed
  DMARC can be admitted. A failed or unknown result is refused (`unauthenticated`). With AgentMail, `pass`
  needs a `message.received` event (the vendor saw authentication headers) AND `dmarc=pass` for the `From`
  domain in the first `Authentication-Results` value the vendor reports. So a sender's domain must publish a
  DMARC record: mail from a partner domain with none is refused. ⚠ The check does not pin the receiving
  server's id, because AgentMail does not document one. It trusts AgentMail's classification and its header
  order.
- **External senders are strict by default.** A sender on one of the org's own domains, authenticated, binds
  `internal`. Everyone else binds `external`: an allowed partner is admitted, and the turn runs with external
  trust (shared memory routes to the read-only `public` layer, and the wake carries the non-member stamp). 🔴 An internal sender also binds `external` when the frozen reply goes to anybody off the org's own
  domains (an allowed partner on `Cc`): the answer reaches an outsider, so the turn must not read what only the
  org may see.
- **Replies only, to people already on the thread.** The agent has no way to start a mail to anybody: the
  transport port has no "send to an address" call. A reply goes to the sender (or an allowed `Reply-To`) and,
  as a reply-all, to the other `To` and `Cc` addresses that may receive mail from this inbox — never a stranger,
  never the agent's own address, and never more than `maxRecipients`. The recipients are frozen at the inbound
  gate from the mail's own headers; the model never names one. They are checked again at send time, so a sender
  removed between the wake and the reply gets nothing. A host notice into a thread (the outcome of an approval
  asked from it) follows the same rule: the thread's own participants who may receive mail, nobody else. No
  cold mail, no bulk mail. 🔴 A **personal inbox answers the sender only**: no `Reply-To`, no reply-all. The
  mail wakes the sender's own DM seat, which reads their private DM layer, so a colleague on `Cc` gets nothing.
  `reply` may send more than one mail in a turn, always to the same frozen recipients.
- **Forwarded content is untrusted.** The sender's own new words render as the message. The quoted history and
  any forwarded thread that the transport splits off render inside the untrusted fence, and the delivery is
  stamped non-requester, because somebody outside the org may have written them. The vendor's split is a heuristic: it keeps an inline
  reply whole and can leave quoted text in. So the sender's own part also stamps the delivery non-requester when it still shows a
  quote or forward marker (a `>` line, `On … wrote:`, a forward banner, a pasted `From:`/`Subject:` block).
  That marker scan is a heuristic too. A forwarded "ignore your instructions" is data, never an instruction.
- **No automatic answer to a machine.** Auto-replies, bounces, mailing lists and bulk mail are refused
  (`automated`), so two auto-responders never answer each other in a loop. Mail from the agent's own address is
  refused (`self`).
- **Attachments are named, never opened.** The seat sees each attachment's file name and size. A reply carries
  text only.
- **White-label.** Every inbox lives on a domain the org controls. OE hands out no address on a domain it runs,
  and an inbox on a transport's own shared domain (AgentMail's `agentmail.to`) is refused even if listed.

## How it fits the planes

| Plane | What email uses |
|---|---|
| Surface | The `email` provider bundle (`packages/providers/email`): identity mapper, capability manifest, post arm, wake-origin codec, read adapter. A room inbox's surface key is `email/<domain>/<local part>` and goes in a domain's `reach` like any channel. |
| Seat | A room inbox diverts into the domain's standing seat through the same `divertInboundToUnifiedWindow` every chat surface uses; a personal inbox diverts into the sender's DM seat (`channels/dm-seat.ts`). Spend caps, the wake ingress row, provider selection and rate-limit retry ride the shared divert. |
| Identity | A person is known to email through the principal map: `ids: { email: "rowan@acme.com" }` in `agent/identity/principals.ts`. That is the only join — never a display name, never the principal's secondary `email` hint. |
| Approval | `propose_email_sender` posts a card; a member's tap opens a pull request adding one line to `agent/email/senders.ts`; the admin's merge is the gate. |
| Audit | `email.admitted` (inbox, seat kind, trust, which list admitted the sender, recipients frozen and dropped, nonRequester — `tainted` on a row written before OPE-2721), `email.refused` (the reason), `email.sender.pr_opened`, and `email.wake_failed`. The reply itself writes the shared `reply.post` row. |
| Untrusted content | A quoted or forwarded remainder rides inside the untrusted fence; an outside sender's wake carries the non-member stamp. A `read_thread` fences what it pulls; no read marks the turn since OPE-2721. On a personal inbox it reads only the bound person's own mail and the agent's replies to that person alone. ⚠ An unflagged message whose From is on the org's domains counts as internal on the vendor's label alone: a thread read does not re-check DMARC, so a spoofed org address that the vendor did not flag is not refuted. |
| Egress | The reply, and a host notice into a thread (an approval outcome note, the judge-lift notice), are the only outbound calls, to the policy's transport. A reply's recipients are frozen at the gate; a notice takes the thread's own participants, filtered by the same reply rule. The local eval egress spoof swallows both like every other room post. |

## What an operator must provision

The repository ships the surface **off**. Nothing below is created by Open Everywhere: an operator provisions the
mailbox service and the DNS records.

1. **A mailbox service account.** The first recipe is [AgentMail](https://agentmail.to) (inboxes by API, inbound
   webhooks, custom domains on its paid plans). Choose the region: `agentmail` (the US API host
   `api.agentmail.to`) or `agentmail-eu` (`api.agentmail.eu`).
2. **A domain the org controls**, for example the subdomain `agent.acme.com`. Add it to AgentMail as a custom
   domain and publish the DNS records AgentMail's zone file names for it — the inbound `MX` record, the `SPF`
   `TXT` record and the `DKIM` record(s) — and a `DMARC` `TXT` record at `_dmarc.agent.acme.com` (for example
   `v=DMARC1; p=quarantine`). Wait for AgentMail to report the domain verified. Without DKIM and DMARC on the
   sending domain, replies land in spam or are rejected.
3. **One inbox per address** you declare (`launch@agent.acme.com`, `oe@agent.acme.com`), created in AgentMail on
   that domain.
4. **A webhook** in AgentMail pointing at `https://<your deployment host>/eve/v1/email`, subscribed to the
   `message.received`, `message.received.unauthenticated`, `message.received.spam` and
   `message.received.blocked` events. Copy its signing secret (`whsec_…`).
5. **Two secrets in the secret store**, never in a file or the environment of a commit:
   ```sh
   npx oe secret set AGENTMAIL_API_KEY        # the AgentMail API key
   npx oe secret set AGENTMAIL_WEBHOOK_SECRET # the webhook's whsec_… signing secret
   ```
   (The resolver falls back to an environment variable of the same name, and warns when it does.)
6. **The policy**, in `agent/email/policy.ts`, by pull request: set `enabled: true`, the `transport`, your
   `orgDomains` (`["acme.com"]` — the inbox subdomain sits under it), and the inboxes with their
   `allowedSenders`.
7. **The seats.**
   - For a room inbox, add its surface key (`email/agent.acme.com/launch`) to the owning domain's `reach` in
     `agent/memory/config/domains/`. The domain must run a standing seat window. A multi-source window requires
     every source vouched, so also declare the inbox in `agent/identity/surfaces.ts`
     (`defineSurface({ key: "email/agent.acme.com/launch", trust: "internal" })`). 🔴 The vouch does **not**
     make an outside sender internal: the email mapper states each mail's trust itself, and that verdict sits
     above a vouch. A mail binds internal only when its sender is internal AND every frozen reply recipient is
     on the org's own domains, so a thread with a partner on it is never a members-only room, vouch or not. A room inbox no explicit domain lists gets its own standing seat (a solo window) like any
     undeclared room. With no standing-seat window at all (`window.topology` off), every mail is refused `no-domain`.
   - For a personal inbox, add each person's address to their principal: `ids: { email: "rowan@acme.com" }`.

## Adding a sender

Ask the agent in a channel or DM: "let partner@example.com email launch@agent.acme.com — they run our venue."
It calls `propose_email_sender`, which:

- refuses from an external conversation (every mail from outside the org binds external), from a turn a
  non-member's message woke, and from a routine fire with no person in it;
- refuses a personal inbox (its sender list is the principal map), the agent's own address, a rule over the
  agent's own inbox domain, and a sender the list already admits;
- posts an approval card in the room (or, from a surface that cannot carry a card — an email turn included — in
  a card-capable channel of the same domain, and refused when the domain holds none);
- on a member's tap, opens a pull request that adds one line to `agent/email/senders.ts`, naming who asked and
  who approved. Nothing is allowed until an admin merges it.

You can also add the line by hand. Remove a sender by deleting its line.

## Settings and limits

| Field | Meaning |
|---|---|
| `enabled` | The master switch. Off refuses every mail. |
| `transport` | `agentmail` or `agentmail-eu`. |
| `orgDomains` | Your mail domains. Inboxes must sit on (or under) one; authenticated senders on one bind internal. |
| `inboxes[].kind` | `room` (a domain's surface) or `personal` (each declared person's DM). |
| `inboxes[].allowedSenders` | A room inbox's list: exact addresses or `*@domain` (that exact domain only). A personal inbox lists none. |
| `maxRecipients` | The most addresses one reply may go to, To and Cc together (1 to 20, default 10). |
| `maxInboundChars` | The most characters of one mail that reach the model (default 20 000). The sender's own words get the budget first. |

## What is not built yet

- **A Google Workspace or Microsoft 365 mailbox** (the second recipe, OPE-2420): a transport over Gmail or
  Microsoft Graph for an org that wants the mail inside its own tenant.
- **Attachments**: the seat sees names and sizes only, and a reply carries no file.
- **A per-person address** for a personal inbox is optional and not built: one personal inbox serves every
  declared person, each in their own DM seat.
- **Stand-down by mail**: a sender is removed by a pull request, not by asking the agent in the thread.

## Live verification

The e2e suite declares three scenarios, all `NON_LAUNCH` until a fixture mailbox on a test domain exists (the sender fixture's domain must publish a DMARC
record, because the gate admits only a `dmarc=pass` sender):
`S-EMAIL-ROOM-REPLY` (an allowed sender writes to a room inbox and gets an answer in the same thread),
`S-EMAIL-DM-FORWARD` (a declared person forwards a mail to the personal inbox and their DM seat answers), and
`S-EMAIL-STRANGER-REFUSED` (a stranger's mail is refused with an `email.refused` row and no reply). The unit packs
(`test:email`, `test:email-front`, `test:email-agentmail`, `test:email-post-arm`) and the app-level
`test:email-integration` drive the gate, the front, the transport and the reply spine offline.
