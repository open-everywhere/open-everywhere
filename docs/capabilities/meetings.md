# Meetings: OE's own meeting bot

A person in Slack or Teams says "join this meeting" with a Google Meet or Microsoft Teams link. OE posts an
approval card. When a member approves, OE's own meeting bot joins the meeting as a visible participant,
records the audio, and leaves when the meeting ends. OE then posts a recap with the decisions and the
actions into the thread the ask came from.

A second road needs no bot: when the meeting platform already made a transcript (Microsoft Teams, Google Meet
or Zoom cloud recording), OE can write the recap from that transcript, with the speakers' real names. See
[Recaps from the platform's own transcript](#recaps-from-the-platforms-own-transcript).

No third-party meeting vendor is involved in the bot. The bot runs in a **long-lived box** on this deployment's own
sandbox backend (see [Sandbox → Long-lived boxes](../extending/sandbox.md#long-lived-boxes)): a Vercel
Sandbox on the hosted stack, a docker container on the self-host stack.

Meetings are **off** as shipped.

Two properties had to hold before a deployment could turn meetings on. Both hold now:

- **Meeting data expires per row (OPE-2461).** OE keeps meeting state (the record with its callback key, the
  transcript chunks, the open-meeting index, the single-use claims, the native-recap watches) in its own
  operational-store table, `meeting_data`. Each row carries its own expiry time. A read never returns a row
  after that time, a write deletes only rows already past their own expiry, and the 15-minute meeting sweep
  deletes the expired rows from the disk. No other feature's write can delete a live meeting row.
- **The recap carries untrusted provenance (OPE-2464).** The recap is the bot's own post, written by a model
  from an untrusted transcript. When OE posts it, OE records the post, the thread it went into and, for
  seven days, its channel. A later turn that reads that post or that thread, or that wakes in that thread
  or (within the seven days) anywhere in that channel, is marked as having read untrusted content, so the
  taint floor applies to its actions. The limits are listed under [What does not work](#what-does-not-work). See [The recap, and why the transcript is
  untrusted](#the-recap-and-why-the-transcript-is-untrusted).

## The flow

1. **The ask.** A person sends a meeting link and asks OE to join. The conversation seat forwards the job,
   and the worker calls `meeting_join`.
2. **The checks, before any card.** `meeting_join` refuses:
   - when meetings are off in `agent/meetings/policy.ts`;
   - from a room or DM that is not confirmed internal (a shared channel, a Slack Connect room, a guest);
   - on a turn that a non-member's message woke, and on a turn with no acting person (a routine fire);
   - for a host the policy does not list, and for a Teams meeting whose organiser's tenant the policy
     does not list (external meetings are refused);
   - for Zoom (see [Zoom](#zoom));
   - when the sandbox backend cannot run a box (just-bash), when the policy's transcription route is not
     registered, or when the deployment has no public URL for the bot to call back on.
3. **The card.** A `meeting.join` card is a headline and one consequence line (OPE-2481): "Send the
   notetaker to the Google Meet meeting and post a recap here." and "It records everyone for up to 90 min.
   The host admits it. OE keeps the transcript 30 days." The rest of this page is the full disclosure: the
   host, where the audio goes, the sandbox and the spend ride the card's detail (its metadata and the
   pending row). A member's tap approves it. Nothing joins before the tap, with one exception: when the approver chain lowers
   `meeting.join` (an approve-all or bypass domain, or an enforced judge allow that cites a pre-approval
   rule), the bot is sent with no tap. On a tainted turn the chain cannot lower it below a person's
   decision.
4. **The box.** The tap opens the bot's box through the long-lived box seam and writes a `meeting.join`
   audit row. The box carries the meeting link, the bot's name, the cap and a per-meeting callback key.
   It carries no deployment credential.
5. **The meeting.** The bot asks to join and waits in the lobby. The host admits it. The bot records the
   audio in the page and sends it to OE in chunks, on a signed callback (`POST /meetings/v1/<id>`). A
   chunk ends at a pause, between 45 and 75 seconds long (see [Chunks](#chunks)). OE transcribes each chunk
   and keeps the text. Each chunk also carries who the meeting page showed as the speaker (see
   [Speaker names](#speaker-names)).
6. **The end.** The bot leaves when the meeting ends, when it is removed, when it has been alone for
   `leaveWhenAloneMinutes`, or three minutes before the cap. It sends `ended`, and OE stops the box,
   writes the meeting hours to the spend ledger, writes the recap, and posts it into the thread that
   asked. The box itself stops at the cap whatever the bot does.
7. **The backstop.** A sweep every 15 minutes finishes any open meeting more than 10 minutes past its cap
   that never sent `ended` (the bot crashed, the backend killed it, the callback was lost): it stops the
   box if it is still running, bills the hours, and posts the recap of the minutes that arrived. It works
   from OE's own record of open meetings, so it also finds a meeting whose box is already gone. One org may
   have at most 64 meetings open at once; a further join is refused. The sweep runs whether or not meetings
   are enabled, so turning meetings off does not abandon the meetings already open.
8. **Recall.** `meeting_leave` stops a bot this conversation sent: the bot leaves now, and the recap of what
   it heard so far comes to the thread. It finds only meetings this conversation sent, so one room cannot
   stop another room's bot. It has the same room and person rules as `meeting_join`, posts no card (it
   removes a recorder, never adds one), and works after meetings are turned off.
9. **Halt.** Under a HALT that covers the asking room, its workspace or domain, the asking person or the
   whole org, a meeting ends at the next chunk or sweep: the box stops, no more audio is transcribed, and no
   recap is posted. An unreadable halt store counts as halted.

## Turn it on

1. Build the bot image and make it available to your backend (`deploy/meeting-bot/README.md`).
2. Edit `agent/meetings/policy.ts`: set `box.image`, add your host rules, and set `enabled: true`.
3. Make sure the deployment has a public URL: the Vercel production URL on the hosted stack, or
   `OE_PUBLIC_BASE_URL` on the self-host stack. The bot calls back on it.

The policy is typed config in Git, so each change is a reviewed pull request:

```ts
const meetingPolicy: MeetingPolicy = {
  ...DEFAULT_MEETING_POLICY,
  enabled: true,
  hosts: [
    { platform: "meet", host: "meet.google.com", owner: "unverifiable", why: "Our team meets on Google Meet." },
    { platform: "teams", host: "teams.microsoft.com", tenants: ["<your tenant id>"], why: "Our own Teams tenant only." },
  ],
  box: { image: "oe-meeting-bot:1", vcpus: 2, memoryMb: 4096 },
  retention: { audioMinutes: 0, transcriptDays: 30 },
  transcription: { route: "gateway", model: "openai/gpt-4o-transcribe" }, // the model is not read while a transcription role is registered
};
```

A bad policy fails the boot. Every field is validated in `packages/core/agent/meetings/policy.ts`.

| Field | Meaning |
|---|---|
| `enabled` | The master switch. Off refuses every join. |
| `hosts` | The meeting hosts OE may join. A Teams rule must list the organiser tenants OE may join. A Meet rule must say `owner: "unverifiable"` (see below). A Zoom rule must name the Zoom-reviewed app. |
| `botName` | The name the host sees in the lobby. |
| `maxMinutes` | The hard cap on one meeting, at most 24 hours. |
| `leaveWhenAloneMinutes` | The bot leaves after this many minutes alone. |
| `retention.audioMinutes` | Must be `0`: OE never stores audio. It transcribes each chunk in memory and drops it, so any other value would promise an audio window that nothing keeps. Any other value is refused. |
| `retention.transcriptDays` | How long OE keeps the transcript, 1 to 90 days. Each transcript row expires on its own: no read returns it after that, and the next meeting sweep (at most 15 minutes later) deletes it. The recap post in the thread is the chat platform's message and follows that platform's retention, not this one. |
| `box` | The bot image, its vCPUs and its memory. |
| `transcription` | The speech-to-text route. See below. |

### External rooms and external meetings

OE refuses an external room in two places:

- **The ask.** A request from a room or DM whose trust is not `internal` is refused before any card.
- **The meeting.** A Teams link carries its organiser's tenant id, and OE refuses a link whose tenant id
  the rule does not list. OE reads that id from the link itself and cannot verify it with Microsoft, so
  the check refuses an outside meeting's link pasted as it is, not a person who edits the link to carry
  your tenant id. The card still needs a member's approval, and the host must still admit the bot.

A Google Meet link names no organiser, so OE **cannot** tell your own Meet room from an outside one. A Meet
rule is therefore valid only with `owner: "unverifiable"`, which records that decision in Git. If you
cannot accept that, do not add a Meet rule.

## Speech to text

The transcription route is pluggable. Two routes ship:

| Route | Where the audio goes | Status |
|---|---|---|
| `gateway` (default) | Chunk by chunk along the model stack's **transcription role**: a primary route and, where the stack names one, a fallback route on a different provider, so one provider outage falls through to the other. Each route's retention basis is in the models page. See [Models → the transcription role](../extending/models-and-gateway.md#the-transcription-role-speech-to-text-with-a-fallback). | Ships. The defaults are pending a bake-off (`npm run bakeoff:stt`). |
| `box` | Nowhere: the bot transcribes inside its own box and sends text only. | Ships as a route; it needs a bot image that carries a speech model (`OE_MEETING_STT_CMD`, see the bot README). The shipped image has none. |

On the `gateway` route the stack decides the model, not the policy: with a transcription role
registered, `transcription.model` is not read. The routes keep word or segment timestamps where the
model returns them, for placing speaker names.

| Stack | primary | fallback |
|---|---|---|
| `american-closed` | MAI-Transcribe-2, AI Gateway | Grok STT, AI Gateway |
| `chinese-open-weights` | Qwen3-ASR-1.7B, DeepInfra (states zero retention) | Qwen3-ASR-1.7B, your own server |
| fully local | Qwen3-ASR-1.7B, your own server | none |

### Chunks

The bot cuts the audio between sentences, not on a clock (`deploy/meeting-bot/cut-rule.js`):

- A chunk never ends before 45 seconds.
- From 45 seconds, it ends at the first pause: the meeting audio stays quiet for half a second.
- At 75 seconds it ends whatever is said, so one long talk still arrives in bounded chunks.

The handover has no gap. The next recorder starts before the previous one stops, so two chunks overlap by
a few milliseconds and no audio is dropped between them. Each chunk is a complete audio file that OE
transcribes on its own.

### Context for each call

Each transcription call carries a context prompt: the names on the meeting page, then the last 400
characters of the previous chunk's text. The names help the model spell them. The tail lets a sentence cut
at the seam read on. A lost previous chunk gives no tail, never a wrong one. The context is at most 800
characters, because Whisper-family prompts stop at 224 tokens.

A route passes the context to its model only where the model accepts a prompt. The `box` route cannot: its
speech command takes a file path only. On the `gateway` route, the stack's routes accept a prompt in their
timed call (`transcribeTimed`): a DeepInfra or self-hosted route sends it, and an AI Gateway route does not,
because the Gateway takes no common prompt field. **As shipped, OE does not pass the context to the
`gateway` route yet.** Core calls the route's `transcribe`, and the stack route answers that call without the
prompt and with text only. The fix is in the adapter's `stackTranscriptionRoute` (see
[Speaker names](#speaker-names)).

## Speaker names

Meet and Teams web both mix every voice into one audio stream for a guest, so the bot cannot tell voices
apart. OE takes the names from the meeting page instead, not from the voices:

1. Every 250 ms the bot reads each participant tile on the page: the display name, and whether the page
   shows that tile as the active speaker (`deploy/meeting-bot/speakers.js`).
2. Each chunk carries the spans of who was highlighted, in milliseconds from the chunk's start, and the
   names on the page.
3. OE aligns the spans to the transcript's segment times (`packages/core/agent/meetings/speakers.ts`). A
   segment gets a name only when ONE name covers at least half of it and no other name covers a quarter
   of it. Neighbour segments with the same name become one line, written `[Ana] …`.
4. The recap model reads the named lines, and uses the names for the action owners.

OE does not guess from the timing. A segment stays unlabelled when no name covers it, when two names are lit
together, or when the timing is split. A chunk stays plain text, as before, when the route returns no segment
times, when its segments do not carry all of its text (so no word is dropped), or when the chunk carries no
spans. Square brackets are removed from all transcribed text, so a spoken `[Ana]` or a route marker such as
`[Music]` cannot pass for a label.

**The bot checks the indicator against the audio.** A chunk carries spans only when the page lit nobody (or
almost nobody) during the long silences, and lit somebody during most of the speech. The check runs over the
last three minutes AND over the chunk itself. It catches an indicator that is always on, inverted or never
on: then the chunk carries no spans, and only the names are lost, never the audio. It does **not** catch an
indicator that lights the wrong person (a pinned or presenter tile, for example), and that gives a wrong
name.

**What is labelled on each platform:**

| Platform | What the bot reads | Status |
|---|---|---|
| Google Meet | Each `[data-participant-id]` tile: the name, and Meet's audio-level ring class on the speaking tile. | Built. **Not proven live**: Meet's ring is an obfuscated class name that changes without notice. Only tiles on screen are read, so a person outside the visible grid has no name. |
| Microsoft Teams | Each participant stream tile: the `display-name` element, and the voice-level outline on the speaking tile. | Built. **Not proven live**: the selectors follow the public Teams web client as of 2026-10. |

Either way, a name appears in the transcript only when ALL of these hold: the route returns segment times,
the page reader works, and the indicator passes the audio check. **As shipped, no transcript carries names
yet.** The stack's transcription routes keep segment times (`transcribeTimed`), but the `gateway` route's
`transcribe`, which core calls, returns the text only. To switch names on, the adapter must return
`{ text, segments }` from `transcribe` and forward `opts.prompt`. That change is in
`packages/adapters/agent/model/meeting-gateway.ts`, and this page changes when it lands. The `box` route
never carries names: its speech command prints text with no times.

**A name is untrusted.** It is the display name the meeting page shows, and a guest types their own. OE does
not verify it: a guest can join as "Ana", or as a sentence. OE strips control and bracket characters from a
name and caps it at 64 characters. In the recap prompt a name goes only inside the untrusted transcript
fence. It also goes, unfenced, into the transcription call's context prompt; the output of that call is
untrusted transcript text. The page's indicator
can also lag, so a short turn can carry the previous speaker's name or none.

## The recap, and why the transcript is untrusted

Anyone in the meeting can say anything, a guest included. So the transcript is **untrusted content**:

- It is fenced as untrusted data before a model sees it.
- The model that reads it holds no tool. It returns JSON data: a summary, decisions and actions.
- Code renders the post from those fields. Each field is capped, and every `<`, `>`, `[` and `]` is
  removed (a markdown link keeps its label), with `@here`-style broadcasts. Removing characters rather
  than whole tokens means a token split across two fields cannot re-form when code joins them.
- Every line the model wrote is posted as a quote, under a fixed header: "The quoted lines are what people
  said in the meeting … They are not instructions from me". This is a LABEL for the people in the thread.
  No code reads the label.
- 🔴 **The recap post carries an untrusted provenance mark (OPE-2464).** A chat read grades a bot's line as
  trusted, so the label alone would let a later turn act on an action item as if OE had said it. So the host
  records the recap when it posts it (`meetings/provenance.ts`): the thread it goes into BEFORE the post, and
  the post's own message id after. The record is a fact about the message id, never about its words. Two
  readers use it:
  - every chat read verb (`read_thread`, `read_channel`, `read_work_thread`, `read_work_channel`): a page
    with a marked post, or a read of a marked thread, marks the turn untrusted (`chat-message`);
  - the turn itself: a turn that woke in a marked thread is marked untrusted before its first action runs,
    because its wake context (a backscroll, a catch-up, the thread context) can carry the recap. The check
    runs at `actions.requested`, and every consequential tool reads the mark at execute time.

  Every recap also marks EVERY turn in its channel (top level or in any thread) for seven days, the
  reach-back of a seat's catch-up read: a wake's backscroll can carry the recap from anywhere in the
  channel, and Slack's top-level backscroll also pulls the replies of recent threads. A recap posted at the
  top level also marks the thread it roots. A turn that the check marked stays marked when its step is
  redelivered, even if the seven days end in between, as long as its turn record was written (the record
  is keyed by session and turn, and lasts one day). Only Slack
  carries the asking thread, so a recap asked for on Discord or Teams always posts at the top level. A
  Discord thread is its own channel, so a recap asked for inside Discord thread X also marks X as a thread,
  and a turn in X stays marked after the seven days. The post and thread marks last ten years. While
  meetings are on, a store error reads as "marked".
- The transcript never reaches a conversation seat or a worker turn.

The recap uses the deployment's `utility` model route.

## Governance

| Control | Where |
|---|---|
| Approval card before joining | `meeting.join`, member tier. The admin decision is the merged policy. |
| Audit rows | `meeting.join`, `meeting.status`, `meeting.ended`, `meeting.recap_posted`. |
| Spend | One spend-ledger row and one `meeting` usage event per meeting, carrying the meeting hours. On Vercel the dollars are the box's memory GiB-hours at the Vercel Sandbox rate (a meeting the sweep finishes is billed up to its cap; see Hobby below). On docker the row carries the hours at $0, because a self-hosted container has no metered price. Transcription and the recap model call are not in this row. |
| Hosts and retention | `agent/meetings/policy.ts`, typed config in Git. Every meeting row expires on its own (OPE-2461). |
| Recall and halt | `meeting_leave` (this room's bots), and any covering HALT ends a meeting with no recap. |
| Cap | Applied by the backend at box creation (the box stops at it) and by the bot (it leaves three minutes before). The 15-minute sweep finishes, bills and recaps any meeting that never sent `ended`. |

## The two stacks

### Vercel Sandbox (hosted)

- A box is a Vercel Sandbox session whose timeout is the cap. The plan ceiling is 24 hours on Pro and
  Enterprise. **Hobby caps a session at 45 minutes**, so a longer meeting is cut at 45 minutes there.
- The spike (OPE-2460) measured a cold start under one second and about $0.16–$0.28 compute per meeting
  hour on 2 vCPU / 4 GB.
- The box's network is open: meeting media flows over UDP to the platform's media servers, whose addresses
  are not enumerable, so the box cannot sit behind a host allow-list. The box holds no deployment secret.

### Docker (self-host)

- A box is a container started with `--cpus`, `--memory` and `--shm-size`, labelled `oe.box.oeBox=meeting`,
  capped by `timeout`, and removed when the bot exits.
- It needs the **docker** sandbox backend (`sandbox.selfHostBackend: "docker"`) and the daemon socket. The
  shipped Dockerfile runs the **just-bash** backend, which cannot run a box: on it, `meeting_join` refuses
  with that reason.
- The docker backend refuses to boot behind the egress proxy (`OE_EGRESS_PROXY_URL`), because its
  containers sit outside the proxy. A meeting box is the same: it reaches the meeting platform directly, on
  the daemon's default network.
- The bot must reach the deployment's public URL (`OE_PUBLIC_BASE_URL`) from that network.
- The spike measured about $0.04 per meeting hour on a dedicated 2 vCPU / 4 GB VM.

## What does not work

- **Zoom.** <a id="zoom"></a>Since 2 March 2026 a bot that joins a Zoom meeting outside its own account needs a
  Zoom-reviewed Meeting SDK app and an OBF token from a signed-in person who is **in** the meeting. OE has no
  per-person Zoom sign-in yet, so `meeting_join` refuses Zoom links. "Send the bot to a Zoom meeting I skip"
  can never work on Zoom, by Zoom's rule. A policy may already declare a Zoom rule with its reviewed app, so
  the decision is recorded for when the sign-in exists.
- **A meeting longer than the Hobby plan's 45-minute session.** The card states the policy's cap, but on
  Hobby Vercel stops the box at 45 minutes; the sweep then posts the recap of what arrived. OE cannot read
  that stop time, so the sweep bills the meeting up to its full cap (plus five minutes): the spend ledger
  then overstates the box's hours. Set `maxMinutes` to 40 or less on Hobby.
- **A meeting whose host does not admit the bot.** The bot waits 10 minutes in the lobby, then gives up and
  says so in the thread.
- **Teams organisations that block anonymous joins**, or that keep Microsoft's bot detection on "require
  organiser approval": the organiser must admit the bot by hand, or it cannot join.
- **Google Workspace domains that block outside guests.** The bot joins as an anonymous guest.
- **Speaker names from voices.** Meet and Teams web give a guest one mixed audio stream, so OE cannot tell
  voices apart. Names come from the meeting page's active-speaker indicator only, with the limits in
  [Speaker names](#speaker-names). A recap from the platform's own
  transcript has the platform's speaker names instead ([below](#recaps-from-the-platforms-own-transcript)).
- **A deployment on just-bash**, or with no public URL.
- **Not proven live:** a full one-hour meeting through the real Meet and Teams web clients, UDP media under a
  restricted Vercel network policy, join success against Teams bot detection, and the speaker reader's
  selectors on either client. The join, the speaker alignment and the recap are proved on the built host with
  a fake box backend and a fake transcription route (`tests/integration/meetings/meeting-recap.test.ts`). The
  cut rule, the handover and the page reader are proved against a fake page (`scripts/meeting-bot-test.ts`).
  The e2e leg `S-MEETING-RECAP` (NON_LAUNCH) checks the card on a live deployment, and it SKIPS while the
  deployment keeps meetings off.
- **Known limits of the provenance mark:** a recap marks the other turns in its channel for seven days
  only. After that, a wake whose bootstrap read reaches back to the recap is not marked by the turn leg
  (a `read_channel` of a page with the recap still is). A recap whose post returned no message id, or whose
  post mark failed to write twice, has no post mark: a recap in a thread keeps its thread mark, and a
  top-level recap is then marked for seven days only (on Discord, also as its own thread).

## Recaps from the platform's own transcript

When an organisation's own meeting already has the platform's transcript, OE can write the recap from it.
No bot joins, and the recap carries the speakers' names as the platform recorded them. Three platforms
ship: **Microsoft Teams**, **Google Meet** and **Zoom** (cloud recording). The bot stays the road for
everything else: a meeting with no platform transcript, or another organisation's meeting.

Native recaps are **off** as shipped. The recap post carries the same provenance mark as the bot's
(OPE-2464), and the watch rows and the single-use claims are meeting rows with their own expiry (OPE-2461).

### The flow

1. **The ask.** A person asks for a recap and gives the meeting link. The worker calls `meeting_recap`.
   For Google Meet, the person also names the organiser's email, because a Meet link names no organiser.
   The worker sets `when`: `past` for a meeting that is over, `next` for one that is upcoming or on now.
2. **The checks, before any card.** `meeting_recap` refuses:
   - when native recaps are off in `agent/meetings/policy.ts`;
   - from a room or DM that is not confirmed internal, on a turn a non-member's message woke, and on a
     turn with no acting person (a routine fire);
   - for a platform whose `native` block the policy does not declare;
   - for a Teams link that does not name its organiser (a short `/meet/` link), or whose organiser tenant
     the policy does not list;
   - for a Meet ask with no organiser email, or one outside the policy's Workspace domains;
   - when the platform's reader is not registered.
3. **The card.** A `meeting.recap` card is a headline and one consequence line (OPE-2481): "Read the
   transcript of one Google Meet meeting and post a recap here." and "Nobody in the meeting is told. OE
   keeps no transcript. It reads as <the Meet organiser>." The session (`past` or `next`), whose
   credential reads the transcript and the model route ride the card's detail. A member's tap approves it. As for `meeting.join`, the approver chain can lower the card (an
   approve-all or bypass domain, or an enforced judge allow that cites a pre-approval rule), and on a
   tainted turn it cannot lower it below a person's decision.
4. **The read.** The tap reads the transcript once, with the organisation's credential, and writes a
   `meeting.recap_requested` audit row. Then one of three things happens:
   - **ready:** OE writes the recap and posts it into the thread that asked (`meeting.recap_posted`, with
     `source: "native"`);
   - **refused:** OE says in the thread why there is no recap (`meeting.recap_refused`, see below);
   - **not ready yet:** OE keeps a **watch**. The 15-minute meeting sweep reads again until the transcript
     is ready, the platform refuses, or `native.watchHours` runs out. Then it posts the recap or says why
     there is none.
5. **Halt.** Under a HALT that covers the asking room, its domain, the person or the org, OE reads nothing
   and posts nothing, at the tap and in the sweep.

### How OE learns that a transcript is ready

A person asks, and OE polls. Each platform also has a push road, and OE uses none of them:

| Platform | Push road OE does not use | Why OE polls instead |
|---|---|---|
| Microsoft Teams | Graph change notifications on `communications/onlineMeetings/getAllTranscripts` | It needs a public notification URL, a subscription OE renews, and (for more than an hour) a lifecycle notification URL. |
| Google Meet | Workspace Events `google.workspace.meet.transcript.v2.fileGenerated` | It needs a Pub/Sub topic and a subscription per space or user that an admin creates and OE renews. |
| Zoom | The `recording.transcript_completed` webhook | It is reported unreliable, so a poll is needed beside it anyway. |

Each push names a meeting, never a thread: OE would still need the person's ask to know where the recap
goes and who wanted it. The poll adds at most 15 minutes after the platform finishes the transcript, and
it needs no vendor subscription, no public endpoint, and nothing an admin must renew. The platforms write
their transcripts after the meeting ends, so no road gives a recap during the meeting.

### Turn it on

The policy names one credential per platform. It is the **organisation's** credential, never a person's.
The policy holds only identifiers and the secret's NAME. The secret value goes into the db credential store
with `oe secret set <name>` (or the ops MCP server's `secret_set`), never into Git and never into an
environment file of this repository.

```ts
const meetingPolicy: MeetingPolicy = {
  ...DEFAULT_MEETING_POLICY,
  native: {
    enabled: true,
    watchHours: 24,
    teams: { tenants: ["<your tenant id>"], clientId: "<app registration client id>", clientSecretRef: "TEAMS_TRANSCRIPT_SECRET", why: "Our own Teams meetings." },
    meet: { domains: ["example.org"], serviceAccountKeyRef: "MEET_TRANSCRIPT_KEY", why: "Our own Workspace meetings." },
    zoom: { accountId: "<Zoom account id>", clientId: "<S2S app client id>", clientSecretRef: "ZOOM_TRANSCRIPT_SECRET", why: "Our own Zoom account." },
  },
};
```

| Field | Meaning |
|---|---|
| `native.enabled` | The master switch for every platform. Off refuses every `meeting_recap` ask, and ends every open watch with a notice. |
| `native.watchHours` | How long OE keeps checking for a transcript that is not ready, 1 to 72 hours. |
| `native.teams` | The org's tenant ids, the Entra app's client id, and the name of its stored client secret. |
| `native.meet` | The org's Workspace domains, and the name of the stored service-account key (the whole JSON key file as one value). |
| `native.zoom` | The Zoom account id, the Server-to-Server app's client id, and the name of its stored client secret. |

Leave out a platform's block to refuse that platform.

### What each admin grants and switches on

**Microsoft Teams** (a Microsoft Entra and Teams admin):

1. Register an app in Microsoft Entra. Add the **application** permissions `OnlineMeetings.Read.All` and
   `OnlineMeetingTranscript.Read.All` on Microsoft Graph, and grant admin consent.
2. Create a client secret for the app, and store it: `oe secret set TEAMS_TRANSCRIPT_SECRET`.
3. Create an application access policy for the app's client id and grant it to the organisers whose
   meetings OE may read (or globally), in Teams PowerShell: `New-CsApplicationAccessPolicy` and
   `Grant-CsApplicationAccessPolicy`. Graph refuses an app-only meeting read without one.
4. Leave transcription allowed in the Teams meeting policy. A meeting needs its transcript turned on.
5. Some tenants also restrict Graph access to transcripts and speaker attribution. When one of these is
   off, Graph answers 403 and OE says so in the thread.

People paste the full **"Join the meeting now"** link: its `context` carries the organiser's tenant
(`Tid`) and object id (`Oid`), and OE asks Graph for the meeting under that organiser. OE reads both from
the link and cannot verify them with Microsoft; the policy's tenant list refuses another organisation's
link pasted as it is, and Graph refuses an organiser the access policy does not cover.

**Google Meet** (a Google Cloud and Google Workspace admin):

1. In a Google Cloud project, enable the **Google Meet REST API**, create a service account, and create a
   JSON key for it. Store the whole key file, bytes preserved:
   `oe secret set MEET_TRANSCRIPT_KEY --value-file key.json`. Then delete the local file.
2. In the Google Workspace Admin console, under Security → API controls → Domain-wide delegation, add the
   service account's client id with exactly the scope `https://www.googleapis.com/auth/meetings.space.readonly`.
3. Leave Meet transcripts allowed for the organisers' organisational unit. A meeting needs its transcript
   turned on. Which Workspace editions include Meet transcripts is not confirmed here: check your edition.

OE acts as the organiser the person names, read-only, and only for an organiser on a listed domain. Google
keeps transcript entries for 30 days after the meeting ends; an older meeting is `expired`.

**Zoom** (a Zoom account admin, paid plan):

1. In the Zoom App Marketplace, create a **Server-to-Server OAuth** app on the account. Give it the scope
   `cloud_recording:read:list_recording_files:admin` (the classic scope is `recording:read:admin`), and
   activate it.
2. Store its client secret: `oe secret set ZOOM_TRANSCRIPT_SECRET`. The account id and the client id go in
   the policy.
3. In the account settings, turn on **Cloud recording** and **Create audio transcript**. A meeting needs
   its cloud recording on.

OE reads the recording's `TRANSCRIPT` file. Zoom's transcript lines start with the speaker's name, and OE
reads that name; whether every Zoom plan labels speakers is not confirmed here. The Server-to-Server app
reads only its own account's meetings: for any other, Zoom answers "not found" (OE says so) or "no
recording" (OE waits, and the thread hears the timeout sentence when `watchHours` runs out). OE sends the
app's token only to `zoom.us` hosts.

### When the platform refuses

The thread always hears why there is no recap. Never a silent gap.

| Reason | The thread hears |
|---|---|
| `access-off` | The platform refused the organisation's access, and what an admin must grant (the platform's step above). |
| `not-transcribed` | The meeting happened with transcription off, so there is nothing to recap. |
| `expired` | The platform no longer keeps the transcript. |
| `not-found` | The platform does not know the meeting under the organisation's account. |
| `credential` | The org's credential did not work, or its stored secret is missing (it names the secret to set). |
| `timeout` | No transcript appeared within `watchHours`: transcription was off, or the meeting had not ended. |
| `disabled` | Native recaps were turned off while OE was waiting. |
| `full` | This deployment already waits on 64 transcripts. |

A platform that does not answer (a network error, a 5xx) is not a refusal: OE checks again on the next sweep,
until `watchHours` runs out.

### Retention and governance

- **No transcript is stored.** OE reads the transcript, sends it once through this deployment's own AI
  Gateway to the `utility` model, which writes the recap, and drops it. The card says that OE keeps no
  transcript; this page names the route. The watch
  row holds the frozen ask (the link, the thread, the person) and no transcript. The recap is the only
  thing kept, as a post in the thread, under that surface's own retention.
- **The transcript is untrusted**, exactly as for the bot: fenced, read by a tool-less model, and rendered by
  code as quoted lines. Speaker names are display names anyone can set, so they are fenced and stripped of
  mention syntax too.
- **The recap post carries the provenance mark** (OPE-2464), exactly as for the bot: a later turn that reads
  it, or wakes in its thread, is marked untrusted.
- **Audit:** `meeting.recap_requested` (who approved reading which meeting), `meeting.recap_posted` with
  `source: "native"` and the speaker count, and `meeting.recap_refused` with the reason.
- **Tier:** the `meeting.recap` card is member tier. The admin decision is the merged `native` block: which
  platforms, which credential, which tenants and domains. The click picks one meeting.
- **Who can be read:** the org's credential can read meetings the asking person was not in, and OE cannot
  verify that the asker attended. The card is member tier, so **the asker can approve their own card**: no
  second person is required, and nobody in the meeting takes part in the decision. The merged `native` block
  (which platforms, which tenants and Workspace domains) is therefore the only control on whose meetings can
  be read. Declare a platform only if every member may read every meeting that platform's credential reaches.

### What does not work

- **Not proven live.** No run has read a real tenant's transcript yet. The readers are proved against
  responses shaped from each platform's reference documentation
  (`packages/adapters/scripts/native-transcripts-test.ts`), and the flow on the built host with a fake reader
  (`tests/integration/meetings/meeting-native-recap.test.ts`). The e2e leg `S-MEETING-NATIVE-RECAP`
  (NON_LAUNCH) checks the card on a live deployment, and it SKIPS while native recaps are off.
- **Slack huddles.** Slack has no transcript API for huddles, and no bot can join one.
- **Webex.** It has a meeting transcript API, and OE has no reader for it.
- **Teams meetings in a private chat, read with a resource-specific consent** grant instead of the
  application permission: not built.
- **A recap during the meeting.** Every platform writes its transcript after the meeting ends.
- **Push notifications.** See [How OE learns that a transcript is ready](#how-oe-learns-that-a-transcript-is-ready).
