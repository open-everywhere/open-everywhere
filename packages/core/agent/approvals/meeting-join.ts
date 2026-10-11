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
    `Audio is not stored. OE asks its store to keep the transcript for ${args.transcriptDays} days, but this build's store can delete it sooner or keep it longer (OPE-2461).`,
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
    return `Send OE's meeting bot to record a ${plainValue(platformLabel(args.platform))} meeting (room ${plainValue(args.roomId)}) and post a recap in this thread`;
  },
  async execute(args, decidedBy) {
    const callbackBase = selfDispatchBaseUrl();
    const rec = await openMeeting(args, decidedBy, callbackBase !== undefined ? { callbackBase } : {});
    return `meeting bot sent (box ${rec.box.name}, at most ${rec.box.maxMinutes} min) — the host must admit it; the recap comes to this thread after the meeting`;
  },
};

registerActionKind(meetingJoin);
