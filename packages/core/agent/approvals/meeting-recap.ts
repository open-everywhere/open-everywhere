import { inlineForReview } from "./review-surface.js";
import { plainValue } from "./plain-text.js";
import { requesterWords } from "../channels/friendly-ids.js";
import { registerActionKind } from "./actions.js";
import { platformLabel } from "../meetings/link.js";
import { startNativeRecap, type NativeRecapArgs } from "../meetings/native-recap.js";
import type { ActionKind } from "./types.js";

export function meetingRecapSummary(args: NativeRecapArgs): string[] {
  const p = platformLabel(args.platform);
  return [
    `Read the ${p} transcript of one meeting (${inlineForReview(args.host)}, room ${inlineForReview(args.roomId)}) and post a recap with the decisions and actions into this thread`,
    ...(args.organiserEmail !== undefined ? [`Organiser: ${inlineForReview(args.organiserEmail)}. OE reads the transcript as this person, through the organisation's delegation.`] : []),
    args.when === "next"
      ? "Which session: the next one (or the one on now). OE waits for its transcript."
      : "Which session: the most recent one with a transcript.",
    `Source: ${args.disclosure}`,
    "The transcript holds everything everyone said in the meeting. No bot joins, and nobody in the meeting is told.",
    "The transcript goes through this deployment's own AI Gateway to its utility model, which writes the recap.",
    `OE stores no transcript: it reads it, writes the recap, and drops it. If the transcript is not ready, OE checks every 15 minutes for up to ${args.watchHours} hour(s).`,
    ...(args.reason ? [`Reason: ${inlineForReview(args.reason)}`] : []),
    `Requested by ${requesterWords(args.requestedBy, args.scopeKey)}`,
  ];
}

export function meetingRecapResult(args: NativeRecapArgs, outcome: Awaited<ReturnType<typeof startNativeRecap>>): string {
  const p = platformLabel(args.platform);
  switch (outcome.kind) {
    case "posted":
      return outcome.posted ? "recap posted in this thread" : "the recap was written, but the post into this thread failed";
    case "refused":
      return `${p} gave no transcript. The reason is in this thread`;
    case "waiting":
      return `no ${p} transcript yet. The recap comes here when it is ready (I check for ${args.watchHours} h)`;
    case "halted":
      return "a halt covers this conversation, so I did not read the transcript";
    case "duplicate":
      return "this recap was already asked for, so I did not read the transcript again";
  }
}

const meetingRecap: ActionKind<NativeRecapArgs> = {
  kind: "meeting.recap",
  policy: "member",
  proseArgs: ["reason"],
  volatileArgs: ["askedAt"],
  summarize: meetingRecapSummary,
  plainSummary(args) {
    return `Read the transcript of one ${plainValue(platformLabel(args.platform))} meeting and post a recap here`;
  },
  consequence(args) {
    const whose = args.organiserEmail !== undefined ? ` It reads as ${plainValue(args.organiserEmail)}.` : "";
    return `Nobody in the meeting is told. OE keeps no transcript.${whose}`;
  },
  async execute(args, decidedBy) {
    return meetingRecapResult(args, await startNativeRecap(args, decidedBy));
  },
};

registerActionKind(meetingRecap);
