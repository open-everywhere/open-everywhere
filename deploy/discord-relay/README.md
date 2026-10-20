# Discord Gateway relay

The one always-on component in Open Everywhere. Discord delivers ambient channel/DM messages
(`MESSAGE_CREATE`) **only** over a persistent Gateway WebSocket — never to an HTTP endpoint — so a
serverless deploy can't receive them directly. This ~120-line process holds that socket (via
`discord.js`, which owns reconnect/`RESUME`) and forwards messages to the deploy's ingestion route.

It runs **outside** the Vercel app (it's not serverless — see
[`docs/deploy/surfaces/discord.md`](../../docs/deploy/surfaces/discord.md)),
carries its own small bill (~$3–5/mo), and POSTs to Vercel, which serverless is good at.

## Two modes

- **PROOF** (no `OE_INGEST_URL`): logs every message. Run this **first** — it proves the host stays
  connected, the token works, and **Message Content Intent** is on (message content is non-empty).

  🔴 **PROOF plus log shipping would export conversations, so the content drops out.** The relay
  ships every console line to `OE_LOG_SHIP_URL` when that variable is set. This is the relay's own
  env var; the app ships its logs through the `observability.logShip` setting. A PROOF line carries the
  message text, so the two together would send raw Discord messages to your log sink, which keeps
  them long after the run. While `OE_LOG_SHIP_URL` is set, the PROOF line therefore reports
  `(content redacted — OE_LOG_SHIP_URL is set)` in place of the text. Everything else in the line
  stays: the guild, the channel, and the author. To read the content during a proof run, unset
  `OE_LOG_SHIP_URL` and watch the host's own logs.
- **FORWARD** (`OE_INGEST_URL` set): HMAC-signs each message with `OE_RELAY_SECRET` and POSTs it to
  the deploy's `/eve/v1/discord-gateway` ingestion channel. (That channel is the follow-on build —
  until it exists, stay in PROOF mode.)

## Voice meetings (OPE-2473)

In FORWARD mode the relay also serves OE's Discord voice meetings (`voice.js`). It syncs with the deploy on a
timer: a signed `VOICE_SYNC` POST to the same ingestion route. The deploy answers with the voice channels the
bot must be in, and the next interval (3 s while a meeting is open, 10 s while Discord meetings are on, 5 min
otherwise). The relay joins those channels (gateway opcode 4, muted), and reports for each one the call's voice
credentials and the channel's members. It leaves a channel when the deploy no longer lists it, and at the
meeting's cap even when the deploy stops answering.

🔴 The relay forwards ONLY the call's voice credentials (session id, voice token, endpoint), never the bot token.
OE hands them to the meeting's own box, which receives the audio.

It needs the **Guild Voice States** intent (not privileged, so no portal toggle; the relay asks for it) and the
**View Channel**, **Connect** and **Send Messages** permissions in the voice channel. OE posts a recording notice
in the channel's chat before the bot records, and does not record when it cannot. It does not need **Speak**. A
Stage channel, a text channel, or a channel without those permissions is reported as a failure, and the bot does
not join. A join that gets no credentials within 30 s fails; a later gap (Discord moving the call) does not. The
operator guide is [`docs/capabilities/meetings.md` § Discord voice](../../docs/capabilities/meetings.md#discord-voice).

## What only you can do (browser / account / payment)

An agent can't create accounts, add payment, or click OAuth — these two are yours, both one-time:

1. **Discord app + bot** — [Developer Portal](https://discord.com/developers/applications) → New
   Application → **Bot** tab → Reset Token (copy `DISCORD_BOT_TOKEN`). On the Bot tab, enable
   **Message Content Intent** (a toggle; self-serve for bots in <100 servers). The relay also
   requests the **Guild Message Reactions** and **Direct Message Reactions** gateway intents so it
   can ingest inbound reactions (a 👍 / 👎 on the bot's own reply is recorded as feedback) — these
   are **not** privileged, so no portal toggle is needed; they just need to be in the connect call
   (the relay already requests them). Then **OAuth2 → URL Generator** → scopes `bot`, permission
   **Read Messages/View Channels** (+ **Send Messages** for later) → open the URL → add the bot to
   your test server (needs **Manage Server**).
2. **Railway** — create an account, add payment (Hobby $5/mo for always-on), then either run
   `railway login` yourself or generate a **project token** (Project → Settings → Tokens) and hand
   it over.

Paste me those two tokens and I do the rest.

## What the agent does (everything else)

```bash
# 1. Install the Railway CLI
npm i -g @railway/cli

# 2. Auth (either `railway login` — you do this once — or export a project token)
read -rs -p 'RAILWAY_TOKEN: ' RAILWAY_TOKEN && export RAILWAY_TOKEN

# 3. From this directory, create + deploy the service
cd deploy/discord-relay
railway init            # names the project/service
read -rs -p 'DISCORD_BOT_TOKEN: ' BOT_TOKEN && \
  railway variables --set DISCORD_BOT_TOKEN="$BOT_TOKEN" && unset BOT_TOKEN
# (PROOF first; add these two later to switch to FORWARD)
# railway variables --set OE_INGEST_URL=https://<deploy>/eve/v1/discord-gateway
# read -rs -p 'OE_RELAY_SECRET: ' RELAY_SECRET && \
#   railway variables --set OE_RELAY_SECRET="$RELAY_SECRET" && unset RELAY_SECRET
# (the same generated value must also be set on the Vercel deploy)
railway up              # builds via Nixpacks + starts (restartPolicy ALWAYS — always-on)

# 4. Watch it connect
railway logs            # expect: "ready as <bot>#0000 | mode: PROOF"
```

Then post in the test server — PROOF mode logs the message. If content shows as
`(empty — is Message Content Intent enabled?)`, flip the intent toggle in the portal.

## Run locally (optional, for a quick check before deploying)

```bash
cd deploy/discord-relay
npm install
cp .env.example .env      # fill DISCORD_BOT_TOKEN; leave OE_INGEST_URL unset for PROOF
node --env-file=.env index.js
```

## Rotating the bot token

This relay reads `DISCORD_BOT_TOKEN` **once, at boot**. A reset token therefore needs a **redeploy**
here, not only a variable change — the running process keeps the dead token until it restarts:

```bash
cd deploy/discord-relay
read -rs -p 'new DISCORD_BOT_TOKEN: ' NEW_TOKEN && \
  railway variables --set DISCORD_BOT_TOKEN="$NEW_TOKEN" --skip-deploys && unset NEW_TOKEN
railway redeploy -y
railway logs   # expect: "[oe-discord-relay] ready as <bot>#0000 | mode: FORWARD"
```

`read -rs` keeps the token out of your **shell history** and off the **screen**; `unset` drops it
once Railway holds it. It does NOT hide the value from the **process table** — the shell expands
`"$NEW_TOKEN"` before running `railway`, so it is visible in that process's `ps` entry while the
call runs. Rotate on a machine you trust, not a shared box.

The relay is one of **two deployed** stores a reset must reach; the Vercel deployment is the other,
and it needs its own explicit redeploy. A local `.env` here is an operator copy, not a deployed
store — update it the next time you run the relay locally. The full runbook — both stores, why
`.env.e2e` is not one of them, and what a missed relay looks like in `deploy:census` — is
[`docs/deploy/surfaces/discord.md` § Rotating the bot token](../../docs/deploy/surfaces/discord.md#rotating-the-bot-token).

## Portability

`railway.json` + `package.json` cover Railway (Nixpacks, no Dockerfile needed). The `Dockerfile`
is for anywhere else — Fly.io (`fly launch`; set `min_machines_running=1` so it never sleeps), a
VPS, or `docker run`. Any host works as long as it stays **always-on** — a host that scales to
zero silently drops the gateway.

## Never commit

`.env`, tokens, `node_modules/` (all in `.gitignore`). `OE_RELAY_SECRET` must match the deploy but
lives only in each side's secret store, never in git. On the deployment side it is an operator secret
(OPE-2650): `npx oe secret set OE_RELAY_SECRET`, with an env var of the same name only as the on-ramp.
