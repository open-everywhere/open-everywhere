# Google Chat

Put the agent in Google Chat as a Chat app. People @mention it in a space or send it a direct message, and it
answers in the same thread. Google Chat reaches the same two chiefs of staff as every other chat surface:

- A **space** belongs to a domain. An @mention of the app in a space wakes that domain's standing seat, exactly as a
  message in one of the domain's Slack or Teams channels would.
- A **direct message** with the app wakes the person's own DM seat.

Google Chat is the surface for an organisation that runs Google Workspace. It ships **off**: until a policy enables
it, the endpoint answers every delivery with `503`.

## What it does and does not do

- **Every event is verified before it is read.** Google Chat sends each event with a bearer token. The route checks
  the token's signature against Google's published keys, its issuer, its expiry, and its audience against the
  policy's `audience`. A token for any other audience, or (in endpoint-URL mode) from any Google account other than
  `chat@system.gserviceaccount.com`, is refused `401` and writes no audit row.
- **Addressed only.** The HTTP endpoint gets a space message only when it @-mentions the app, or invokes one of its
  slash commands. The surface has no ambient leg: room chatter never reaches it. (A Workspace Events subscription
  would deliver the rest; this surface does not use one yet.)
- **Trust comes from the policy, never from a name.** A sender binds `internal` only when Google's event names a
  Workspace domain id (`sender.domainId`) that the policy lists in `internalDomainIds`. Everyone else binds
  `external`: shared memory routes to the read-only `public` layer, and the wake carries the non-member
  stamp. ⚠ The mapping from your Workspace to its domain id is not documented as stable by Google.
  Read the id from a real event: every `google-chat.admitted` and `google-chat.refused` audit row records the
  sender's `domainId`. A DM-only deployment can start with an empty list: the first internal person's DM is refused
  `external-dm`, and its refused row carries their domain id.
- **Direct messages are for internal people only.** A DM seat reads its person's private layer, so a DM from an
  `external` sender is refused (`external-dm`). Set `directMessages: false` to refuse every DM (`dm-off`).
- **Group chats are refused** (`group-chat`). A group chat has no domain to own it and is not one person's DM.
- **A space with no seat is refused**, not dropped in silence (`no-domain`): put its surface key in a domain's
  `reach`, or run a standing-seat window that gives an undeclared space its own solo seat.
- **Bots never wake a seat.** A message from any bot, the app's own included, is dropped. That is the loop guard.
- **Replies only, into the conversation that woke the seat.** The reply posts into the trigger's space and thread,
  as the app. The space and thread are frozen at the gate from the verified event; the model never names one. The
  app can post only into a space it is a member of. A reply longer than one Chat message goes out as consecutive
  messages in the same thread.

## How it fits the planes

| Plane | What Google Chat uses |
|---|---|
| Surface | The `google-chat` provider bundle (`packages/providers/google-chat`): identity mapper, capability manifest, post arm, wake-origin codec, host-notice transport. A space's surface key is `google-chat/<workspace>/<space id>` and goes in a domain's `reach` like any channel. |
| Seat | A space mention diverts into the domain's standing seat through the same `divertInboundToUnifiedWindow` every chat surface uses; a DM diverts into the person's DM seat (`channels/dm-seat.ts`). Spend caps, the wake ingress row, provider selection and rate-limit retry ride the shared divert. |
| Identity | The principal is the sender's Chat user resource name (`users/<id>`). The workspace is the policy's `workspace` segment. Visibility is always `private`. |
| Audit | `google-chat.admitted` (space, seat kind, trust, the sender's domain id, whether it was a thread reply), `google-chat.refused` (the reason and the sender's domain id), and `google-chat.wake_failed`. The reply itself writes the shared `reply.post` row. |
| Egress | The reply and a host notice (an approval outcome note, the judge-lift notice) are the only outbound calls, to `chat.googleapis.com`, with a `chat.bot` token minted from the app's service-account key at `oauth2.googleapis.com`. The token endpoint is pinned: the key file's own `token_uri` is ignored. |

## What an operator must provision

Nothing below is created by Open Everywhere.

1. **A Google Cloud project** with the Google Chat API enabled.
2. **A service account** in that project, and a JSON key for it. The app posts its replies as this account.
3. **The Chat app configuration** (Google Chat API → Configuration): give the app a name and avatar, turn on
   "Receive 1:1 messages" and "Join spaces and group conversations", choose **HTTP endpoint URL** as the connection
   setting, and set it to `https://<your deployment host>/eve/v1/google-chat`. Choose the **Authentication audience**:
   "HTTP endpoint URL" (recommended) or "Project number". Make the app visible to the people or groups who should
   use it.
4. **The secret**, in the secret store, never in a file or the environment of a commit:
   ```sh
   npx oe secret set GOOGLE_CHAT_SERVICE_ACCOUNT_KEY   # the service account's JSON key, whole
   ```
   (The resolver falls back to an environment variable of the same name, and warns when it does.)
5. **The policy**, in `agent/google-chat/policy.ts`, by pull request: set `enabled: true`, the `audience` that
   matches step 3 (`{ kind: "endpoint-url", url: "https://<host>/eve/v1/google-chat" }` or
   `{ kind: "project-number", projectNumber: "<number>" }`), your `workspace` segment, and your
   `internalDomainIds`.
6. **The seats.** For each space, add its surface key (`google-chat/<workspace>/<space id>`, the id after
   `spaces/` in the space's URL) to the owning domain's `reach` in `agent/memory/config/domains/`. A multi-source
   window requires every source vouched, so also declare the space in `agent/identity/surfaces.ts`. 🔴 The vouch
   does **not** make an outside sender internal: the mapper states each message's trust itself, from the policy.
7. **Add the app** to each space (`@<app name>` → Add).

## Settings

| Field | Meaning |
|---|---|
| `enabled` | The master switch. Off answers `503` to every delivery and refuses every reply. |
| `audience` | The audience every event's token must carry. `null` refuses every delivery; an enabled policy without one fails the boot. |
| `workspace` | The workspace segment of every surface key (lowercase, `a-z`, `0-9`, `-`). |
| `internalDomainIds` | The Workspace domain ids whose people bind `internal`. Empty: everybody binds `external`. |
| `directMessages` | May an internal person wake their own DM seat? |

## What is not built yet

- **Cards**: an approval asked from Google Chat takes the venue walk to a card-capable room in the same domain. A
  Chat card with a button needs the `CARD_CLICKED` tap answered.
- **Reading a space** (`read_channel`, `read_thread`) and a seat catch-up: listing a space's messages needs user
  authentication or the admin-approved `chat.app.messages.readonly` app scope, which the app does not request.
- **Ambient messages, name-drops and edits**: they need a Workspace Events subscription.
- **Edit, reactions, stop, files, proactive posts and routines.** Each is declared, with its reason, in the
  [chat-surface contract](../../extending/chat-surface-contract.md)'s parity tables.
- **The Workspace add-on event format.** The route reads the classic Chat app event; an app built as a Google
  Workspace add-on wraps its events differently and is not supported.

## Verification

The unit packs (`test:google-chat-auth`, `test:google-chat-front`, `test:google-chat-post-arm`) and the app-level
`test:google-chat-integration` drive the token check, the gate, the reply and the binding offline. There is no
live e2e leg yet: one needs a Google Workspace test tenant with the app published to it, a fixture this repository
cannot create.
