# Open Everywhere meeting bot

OE's own meeting bot (OPE-2459). One box runs one bot for one meeting. OE starts the box through its own
sandbox backend: a Vercel Sandbox on the hosted stack, a docker container on the self-host stack. No
third-party meeting vendor hears the meeting.

The operator guide is [`docs/capabilities/meetings.md`](../../docs/capabilities/meetings.md). This page is
the bot's own contract: the image, the environment OE gives the box, and the callbacks the bot sends.

## Build the image

```bash
docker build -t oe-meeting-bot:1 deploy/meeting-bot
```

- **Docker stack:** the docker daemon that runs OE's sandbox needs the image. Set `box.image` in
  `agent/meetings/policy.ts` to the tag.
- **Vercel stack:** push the same image to your project's Vercel Container Registry, and set `box.image` to
  the registry reference (for example `oe-meeting-bot:1`). A Vercel Sandbox boots from that image, so the
  box needs no install at start.

## The environment OE gives the box

OE writes these variables at box creation (`packages/core/agent/meetings/lifecycle.ts`,
`meetingBoxSpec`). The box holds no deployment credential. The only secret is this meeting's own callback
key.

| Variable | Meaning |
|---|---|
| `OE_MEETING_ID` | The meeting id (`mtg_…`). |
| `OE_MEETING_URL` | The meeting link, re-serialised by OE's parser. |
| `OE_MEETING_PLATFORM` | `meet` or `teams`. |
| `OE_MEETING_BOT_NAME` | The name the bot shows in the lobby. |
| `OE_MEETING_CALLBACK` | `https://<deployment>/meetings/v1/<id>`. |
| `OE_MEETING_SECRET` | This meeting's Standard Webhooks key (`whsec_…`). |
| `OE_MEETING_DEADLINE_MS` | When the bot must leave (epoch ms): three minutes before the box's cap, so it can send `ended` before the backend stops the box. |
| `OE_MEETING_ALONE_MINUTES` | The bot leaves after this many minutes alone. |
| `OE_MEETING_TRANSCRIBE` | `gateway` (send audio) or `box` (send text). |

An image that enables the `box` route also sets `OE_MEETING_STT_CMD`: a command that takes one audio file
path and prints the text (for example a whisper.cpp wrapper). This image does not carry one.

## The callbacks

Every callback is a `POST` to `OE_MEETING_CALLBACK`, signed with the
[Standard Webhooks](https://www.standardwebhooks.com/) scheme under `OE_MEETING_SECRET`. A message id is
single-use. The body is one JSON object:

- `{"type":"status","state":"lobby"|"admitted"|"refused"|"failed","detail":"…"}`
- `{"type":"chunk","seq":0,"audio":{"mediaType":"audio/webm","base64":"…"},"speakers":[{"name":"Ana","startMs":0,"endMs":4250}],"attendees":["Ana","Ben"]}`
  — one chunk of audio (`gateway` route), or `{"type":"chunk","seq":0,"text":"…","attendees":[…]}` (`box`
  route). A chunk is 45 to 75 seconds long and ends at a pause (`cut-rule.js`); the next chunk's recorder
  starts before this one stops, so no audio is lost at the handover. `speakers` is who the meeting page
  showed as the speaker, in ms from the chunk's start, and `attendees` is the names on the page
  (`speakers.js`). Both are optional: the bot leaves `speakers` out when the page's indicator disagrees with
  the audio (always on, inverted or never on, over the last three minutes or within the chunk). The check
  cannot catch an indicator that lights the wrong person. The `box` route sends no `speakers`, because its speech command gives no segment times.
- `{"type":"ended","chunks":42,"reason":"meeting-ended"|"alone"|"cap"|"terminated"|"refused"|"failed"}`

## What the bot does and does not do

- It joins as a visible guest. The host admits it from the lobby. It never bypasses a lobby.
- Its browser has no microphone or camera device and no media permission, so it has nothing to send.
- It runs as the image's non-root user (`pwuser`); OE starts the docker container with no capabilities, no
  new privileges and a pid limit.
- The callback key stays in the bot's own Node process: Chromium and the speech command get an environment
  without it.
- A `failed` status carries a fixed reason code (`page-error`, `lobby-refused`, `join-button-missing`), never
  an error message: a navigation error can carry the meeting URL and its passcode. OE drops any detail that is
  not such a code.
- It records only after it is admitted.
- It reads names off the meeting page (the participant tiles and the active-speaker indicator). The selectors
  follow the public Meet and Teams web clients and are not proven live; see
  [Speaker names](../../docs/capabilities/meetings.md#speaker-names).
- On SIGTERM (the backend stopping the box) it drains its last chunk and sends `ended` before it exits. If it is killed without a signal, OE's cap sweep still finishes the meeting from the minutes that arrived.
- The join flows follow the public Meet and Teams web clients. Those pages change without notice, so a
  join can break after a client update. The bot reports a failed join to OE; it does not retry silently.
- It does not join Zoom. See the guide for why.
