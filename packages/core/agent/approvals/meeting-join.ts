import { selfDispatchBaseUrl } from "../channels/self-dispatch.js";
import { inlineForReview } from "./review-surface.js";
import { plainValue } from "./plain-text.js";
import { requesterWords } from "../channels/friendly-ids.js";
import { registerActionKind } from "./actions.js";
import { platformLabel } from "../meetings/link.js";
import { discordRoomWords } from "../meetings/discord-voice.js";
import { openMeeting, type MeetingJoinArgs } from "../meetings/lifecycle.js";
import type { ActionKind } from "./types.js";

export function meetingJoinSummary(args: MeetingJoinArgs): string[] {
  const discord = args.platform === "discord";
  return [
    discord
      ? `Send OE's meeting bot into ${inlineForReview(discordRoomWords(args))} on Discord`
      : `Send OE's meeting bot to a ${platformLabel(args.platform)} meeting (${inlineForReview(args.host)}, room ${inlineForReview(args.roomId)})`,
    discord
      ? "The bot joins the voice channel at once and shows in its member list. Before it records, it posts a recording notice in the channel's chat, and it does not record if the notice cannot post. It posts again when it stops. Everyone in the channel is recorded, each speaker on their own stream, and the transcript names each line with the speaker's Discord display name."
      : "The bot joins as a visible participant. The meeting host must admit it from the lobby.",
    `It records the meeting audio for at most ${args.maxMinutes} minutes, then leaves. It also leaves when the meeting ends or the room empties.`,
    `Transcription: ${args.transcriptionDisclosure}`,
    `Audio is not stored. OE keeps the transcript for ${args.transcriptDays} days, then deletes it.`,
    "After the meeting I post a recap with the decisions and actions into this thread.",
    `Runs on this deployment's own sandbox (${inlineForReview(args.backend)}); its hours go to the spend ledger.`,
    ...(args.reason ? [`Reason: ${inlineForReview(args.reason)}`] : []),
    "Tell the people in the meeting that a notetaker bot is recording.",
    `Requested by ${requesterWords(args.requestedBy, args.scopeKey)}`,
  ];
}

const meetingJoin: ActionKind<MeetingJoinArgs> = {
  kind: "meeting.join",
  policy: "member",
  proseArgs: ["reason"],
  volatileArgs: ["channelLabel", "serverLabel"],
  summarize: meetingJoinSummary,
  plainSummary(args) {
    if (args.platform === "discord") return `Send the notetaker to ${plainValue(discordRoomWords(args))} and post a recap here`;
    return `Send the notetaker to the ${plainValue(platformLabel(args.platform))} meeting and post a recap here`;
  },
  consequence(args) {
    if (args.platform === "discord") {
      return `It records everyone in the channel for up to ${args.maxMinutes} min, after a notice in its chat. OE keeps the transcript ${args.transcriptDays} days.`;
    }
    return `It records everyone for up to ${args.maxMinutes} min. The host admits it. OE keeps the transcript ${args.transcriptDays} days.`;
  },
  async execute(args, decidedBy) {
    const callbackBase = selfDispatchBaseUrl();
    const rec = await openMeeting(args, decidedBy, callbackBase !== undefined ? { callbackBase } : {});
    if (args.platform === "discord") {
      return `notetaker sent to ${discordRoomWords(args)} (up to ${rec.box.maxMinutes} min) — it posts a recording notice there, and the recap comes here after the meeting`;
    }
    return `notetaker sent (up to ${rec.box.maxMinutes} min) — the host must admit it, and the recap comes here after the meeting`;
  },
};

registerActionKind(meetingJoin);
