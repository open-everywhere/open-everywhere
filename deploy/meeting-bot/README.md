# Open Everywhere meeting bot

OE's own meeting bot (OPE-2459). One box runs one bot for one meeting. The image carries two programs:
`bot.mjs` joins a Google Meet or Microsoft Teams meeting in a headless Chromium, and `discord.mjs` joins a
Discord voice channel with no browser (OPE-2473). OE picks the program per platform. OE starts the box through its own
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
| `OE_MEETING_PLATFORM` | `meet`, `teams` or `discord`. |
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
- `{"type":"ended","chunks":42,"reason":"meeting-ended"|"alone"|"cap"|"terminated"|"refused"|"failed"|"voice-lost"}`
- Discord only: `{"type":"voice"}`. OE answers with this call's voice credentials once the relay reported them
  (`{"ok":true,"credentials":{…},"others":2}`), with the relay's join failure (`{"failed":"stage-channel"}`), or
  with `{"ended":true}`. A Discord chunk is
  `{"type":"chunk","seq":0,"audio":{"mediaType":"audio/wav","base64":"…"},"speaker":"<Discord user id>","atMs":6000}`:
  one member's speech, and when its first frame arrived, in ms from the capture start.

## Discord voice (`discord.mjs`)

The relay (`deploy/discord-relay/`) holds the bot token and the gateway session, and asks Discord to join. The box
holds neither. It reads the call's voice credentials from OE's answer to its signed `voice` callback, and hands
them to `@discordjs/voice` through an adapter that sends nothing to the gateway. Then it receives each member's
audio on its own stream (`discord-voice.js`):

- it subscribes to a member at each speaking start, because a stream ends after a second of silence;
- it drops a frame that still ends in the DAVE marker `0xFAFA` (about two per member after a join);
- it cuts each member's speech at a turn change (also while the previous speaker's stream is still open), at the
  first pause after 45 s, or at 75 s, and sends a 16 kHz mono
  WAV file with the member's id and its arrival time;
- it reads who is in the call from the voice gateway (opcodes 5, 11 and 13), and leaves when it has been alone
  for `OE_MEETING_ALONE_MINUTES`; the relay's member list is the fallback (`@discordjs/voice` itself maps each
  SSRC to its member and routes the frames);
- it starts its capture only after OE answered `admitted` without `ended`: OE posts the recording notice in the
  channel's chat first, and ends the meeting when it cannot;
- when Discord moves the call to another voice server, the relay reports the new token and endpoint, and the bot
  hands them to the connection (not proven live);
- it leaves when OE answers that the meeting ended, at the deadline, or when the voice connection is lost for 60 s.

The versions are the spike's (OPE-2472): `@discordjs/voice` 0.19.2, `@snazzah/davey` 0.1.12 (the DAVE
end-to-end encryption, Linux prebuilds), `prism-media` 1.3.5 and `opusscript` 0.0.8.

**What the sandbox proved (2026-10-11).** The real `discord.mjs` ran against a fake OE callback and a local TLS
WebSocket in the place of Discord's voice server. Given credentials only, it opened the voice WebSocket and sent
the voice `Identify` with the forwarded server id, user id, session id and voice token
(`{"server_id":…,"user_id":…,"session_id":"s1","token":"t1","max_dave_protocol_version":1}`). It held no bot
token and sent nothing to a gateway. With a failure code instead, it sent `status: failed` with that code, then
`ended`. **Not proven:** the same against Discord's own voice servers, and the audio receive after it. The spike
received audio in a process that also held the gateway session.

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
