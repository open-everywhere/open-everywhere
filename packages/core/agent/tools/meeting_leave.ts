import { defineTool } from "eve/tools";
import { z } from "zod";
import { actingPrincipalIdOf } from "../access/request.js";
import { bindFrom, deploymentOrg } from "../identity/binding.js";
import { requireSessionContinuation } from "../spend/checkpoint.js";
import { nonMemberWake } from "./propose_mcp_server.js";
import { meetingLeaveRefusal } from "../meetings/policy.js";
import { finishMeeting, openMeetingsFrom } from "../meetings/lifecycle.js";
import { platformLabel } from "../meetings/link.js";
import { discordRoomWords } from "../meetings/discord-voice.js";
import type { MeetingRecord } from "../meetings/store.js";

export function meetingLeaveMessage(names: readonly string[], recapsPosted: number): string {
  const stopped = `Stopped the meeting bot in ${names.join(", ")}.`;
  if (recapsPosted === names.length) return `${stopped} The recap of what it heard is in this thread.`;
  if (recapsPosted === 0) return `${stopped} No recap was posted: a halt covers this conversation, or the post failed — the transcript is not summarised.`;
  return `${stopped} ${recapsPosted} of ${names.length} recaps were posted; the others were not (a halt, or a failed post).`;
}

export const MEETING_LEAVE_DESCRIPTION =
  "Stop the meeting bot this conversation sent: it leaves the meeting now, and I post the recap of what it heard so far into this thread. " +
  "It takes no arguments, because this conversation IS the selector: it finds only the bots this conversation sent, so it cannot stop the wrong meeting or another room's bot. " +
  "Call it as soon as someone here asks to stop the recording. Never ask anyone for a meeting id or a join receipt first.";

function meetingWords(rec: MeetingRecord): string {
  return rec.platform === "discord" ? discordRoomWords(rec) : `${platformLabel(rec.platform)} ${rec.roomId}`;
}

export default defineTool({
  description: MEETING_LEAVE_DESCRIPTION,
  inputSchema: z.object({}),
  outputSchema: z.object({
    stopped: z.number(),
    message: z.string(),
  }),
  async execute(_input, ctx) {
    await requireSessionContinuation(ctx, "meeting_leave");
    const binding = bindFrom(ctx);
    const refusal = meetingLeaveRefusal({ trust: binding.trust, nonMember: nonMemberWake(ctx), actingPrincipal: actingPrincipalIdOf(ctx) });
    if (refusal !== undefined) throw new Error(refusal);
    const channelId = typeof binding.target?.channelId === "string" ? binding.target.channelId : undefined;
    if (!channelId) throw new Error("meeting_leave couldn't resolve this conversation's id — ask again from the channel or DM that sent the bot.");
    const targets = await openMeetingsFrom(deploymentOrg(), { platform: binding.platform, channelId });
    if (targets.length === 0) return { stopped: 0, message: "No meeting bot this conversation sent is running." };
    const stopper = actingPrincipalIdOf(ctx)!;
    let posted = 0;
    for (const rec of targets) if ((await finishMeeting(rec, "stopped", {}, { stoppedBy: stopper })).posted) posted++;
    return { stopped: targets.length, message: meetingLeaveMessage(targets.map(meetingWords), posted) };
  },
});
