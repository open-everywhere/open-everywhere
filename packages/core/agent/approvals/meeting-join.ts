import { selfDispatchBaseUrl } from "../channels/self-dispatch.js";
import { inlineForReview } from "./review-surface.js";
import { plainValue } from "./plain-text.js";
import { requesterWords } from "../channels/friendly-ids.js";
import { registerActionKind } from "./actions.js";
import { platformLabel } from "../meetings/link.js";
import { openMeeting, type MeetingJoinArgs } from "../meetings/lifecycle.js";
import type { ActionKind } from "./types.js";

export function meetingJoinSummary(args: MeetingJoinArgs): string[] {
  return [
    `Send OE's meeting bot to a ${platformLabel(args.platform)} meeting (${inlineForReview(args.host)}, room ${inlineForReview(args.roomId)})`,
    "The bot joins as a visible participant. The meeting host must admit it from the lobby.",
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
  summarize: meetingJoinSummary,
  plainSummary(args) {
    return `Send the notetaker to the ${plainValue(platformLabel(args.platform))} meeting and post a recap here`;
  },
  consequence(args) {
    return `It records everyone for up to ${args.maxMinutes} min. The host admits it. OE keeps the transcript ${args.transcriptDays} days.`;
  },
  async execute(args, decidedBy) {
    const callbackBase = selfDispatchBaseUrl();
    const rec = await openMeeting(args, decidedBy, callbackBase !== undefined ? { callbackBase } : {});
    return `notetaker sent (up to ${rec.box.maxMinutes} min) — the host must admit it, and the recap comes here after the meeting`;
  },
};

registerActionKind(meetingJoin);
