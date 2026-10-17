# Voice clips

A person on the move records a voice clip instead of typing. The agent hears the clip and answers
it as if the person had typed the words. The reply is text. (OPE-2524.)

## What happens

1. A person sends a voice clip, or any audio file, in a conversation the agent already answers.
2. OE downloads the clip with the bot's own credential and sends it to speech to text through the
   stack's **transcription role**: the same primary and fallback routes a meeting uses. See
   [Models → the transcription role](../extending/models-and-gateway.md#the-transcription-role-speech-to-text-with-a-fallback).
   No vendor key is involved beyond the routes your stack already names.
3. OE appends the transcript to the message body as `[voice clip] <words>`, after any typed text.
   The agent then gets the message on the normal road, and answers it.

The clip is one call per clip, at most three clips per message, at most 20 MB per clip, and at
most 60 seconds for all the clips of one message together. A
recorded Slack clip is at most five minutes, which is a few MB.

## Where it works

| Surface | Status |
|---|---|
| Slack | **Ships, on by default.** A DM, a group DM, an @mention, and a reply in a thread the agent is in. |
| Microsoft Teams | **Not yet.** The Teams app declares `supportsFiles: false` (`packages/providers/teams/agent/app-manifest.ts`), so Teams delivers no file to the bot, and the Teams front door reads no attachment. Teams needs the manifest change and a file-download road first. |
| Discord, Google Chat, email, Notion, GitHub, Linear | Not wired. The core step (`packages/core/agent/channels/voice-clips.ts`) is platform-neutral, so a surface wires it with one byte loader. |

## What the agent hears, and what it does not

🔴 **A clip in a room that did not address the agent is never downloaded.** OE hears a clip only on
a message the agent was already going to answer:

- a DM or group DM;
- an @mention;
- a reply in a thread the agent is in (it was @mentioned, it replied, or a name-drop pulled it in)
  and was not asked to stand down. These are the threads where a typed reply reaches the agent.

A top-level channel message, a thread nobody pulled the agent into, a thread where it was asked to
stand down, and the unaddressed talk an ambient seat watches are **not** heard. The name-drop wake reads typed words only. To ask the agent
something by voice in a channel, @mention it or reply in its thread.

A clip from a bot is not heard, except the deployment's named e2e driver in a DM
(`wake.e2eDrivers`). An edit of a message that carries a clip is not heard again: the clip was heard
on first delivery, and the edit's text goes on as typed. A message shortcut on someone else's clip message does not
hear the clip: that clip is the other person's speech, and the shortcut keeps it inside its
untrusted fence. On a seated deployment, a thread clip is heard only in a room the agent confirms
as internal, the same check that decides whether the seat wakes at all. On an unseated deployment,
a reply in an engaged thread wakes the agent in any room, so its clip is heard there too, as the
same words typed.

## Trust

The transcript is the person's own words. It joins the message body, so the wake envelope renders
it inside the same author-trust fence as the text the person typed: no more trust, and no less. A
clip from a guest or other refuted author is fenced exactly as that author's typed text is.

The `[voice clip]` prefix tells the model the words were spoken. A transcript can mishear a name or
a number, so the agent can confirm one before it acts on it.

## The room sees nothing extra

OE posts nothing of its own about a clip. The reply is the agent's ordinary answer. The agent may
quote what it heard ("heard: …") where that helps, but no host line does it.

When a clip is not heard, the message carries one short line that says why, so the agent can tell
the person instead of going quiet:

| Line | Cause |
|---|---|
| `[voice clip — could not be transcribed]` | The download failed, both transcription routes failed, or the message's clips took longer than 60 seconds together. |
| `[voice clip — no speech heard]` | The route returned no words. |
| `[voice clip — not transcribed: the clip is too long]` | Over 20 MB. |
| `[voice clip — not transcribed: too many clips in one message]` | The fourth clip and later. |
| `[voice clip — not transcribed: this conversation is over its spend cap]` | The conversation is over a spend cap. |
| `[voice clip — not transcribed: no speech-to-text model is set up here]` | The app registered no transcription role. |
| `[voice clip — not transcribed: voice clips are turned off here]` | `voiceClips.enabled` is `false`. |

## Retention

The audio is held in memory for the one call and then dropped. OE writes it to no store, no log
and no audit row. The transcript is kept wherever the typed text of the message is kept, and no
longer. The clip itself stays in Slack, under Slack's own retention.

## Spend

Each heard clip bills to the conversation's spend row, attributed to the person who sent it, under
the model of the route that answered. A transcription bills per audio second, not per token, so OE
records the provider's measured cost as the row's price.

What records no row: an answer that carries no measured cost (your own speech server, or a gateway
or DeepInfra answer with no cost field), and an attempt that failed, even where the provider billed
it. Such a call is invisible to the caps.

A conversation that is over its spend cap does not pay for a clip: OE checks the cap BEFORE the
download. The check fails open, like the ingress spend gate: when the cap cannot be read, the clip
is heard, and OE logs a warning that says the cap was not read. The turn's own spend gate then refuses or admits the wake, as it would a typed message.

## Audit

Each message with a clip writes one `voice.transcribed` row: the clip count, how many were heard,
the models that answered and, for a clip not heard, the reason. The row carries no transcript and
no audio.

## Turn it off

`voiceClips.enabled` in `agent/settings/settings.ts` (shipped `true`). Off, a clip reaches the agent
as a file it cannot hear, with one line saying so. Where the audio may go is not a setting: it is the
transcription role in `agent/model/stacks.ts`.

## Proof

- `packages/core/scripts/voice-clips-test.ts` — clip detection, the body, the shipped default, the
  attributed spend row and the audit row on a real store, the cap, and every failure line.
- `packages/adapters/scripts/transcription-routes-test.ts` — a clip walks the role's primary and
  fallback, the spend row names the answering model, and the app's role registers the transcriber
  at boot.
- `packages/providers/slack/scripts/slack-dm-divert-test.ts` — a DM that is only a clip wakes the
  seat with the transcript, a failed clip still wakes it, an @mention hears its clip, and an
  unaddressed channel clip is never heard.
- Live: the e2e scenario `S-VOICE-CLIP` uploads a spoken clip with no typed text into the real DM,
  and gates on the word it spoke in the reply and on the `voice.transcribed` row.
