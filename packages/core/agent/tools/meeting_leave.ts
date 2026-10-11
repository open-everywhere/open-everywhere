import { defineTool } from "eve/tools";
import { z } from "zod";
import { actingPrincipalIdOf } from "../access/request.js";
import { bindFrom, deploymentOrg } from "../identity/binding.js";
import { requireSessionContinuation } from "../spend/checkpoint.js";
import { nonMemberWake } from "./propose_mcp_server.js";
import { meetingLeaveRefusal } from "../meetings/policy.js";
import { finishMeeting, openMeetingsFrom } from "../meetings/lifecycle.js";
import { platformLabel } from "../meetings/link.js";

export function meetingLeaveMessage(names: readonly string[], recapsPosted: number): string {
  const stopped = `Stopped the meeting bot in ${names.join(", ")}.`;
  if (recapsPosted === names.length) return `${stopped} The recap of what it heard is in this thread.`;
  if (recapsPosted === 0) return `${stopped} No recap was posted: a halt covers this conversation, or the post failed — the transcript is not summarised.`;
  return `${stopped} ${recapsPosted} of ${names.length} recaps were posted; the others were not (a halt, or a failed post).`;
}

export default defineTool({
  description:
    "Stop OE's meeting bot that THIS conversation sent: the bot leaves the meeting now, and I post the recap of what it heard so far into this thread. " +
    "Pass `meetingId` to stop one meeting; omit it to stop every meeting bot this conversation sent. It cannot stop a bot another conversation sent.",
  inputSchema: z.object({
    meetingId: z.string().optional().describe("The meeting id (mtg_…) from the join reply, to stop just that one."),
  }),
  outputSchema: z.object({
    stopped: z.number(),
    message: z.string(),
  }),
  async execute(input, ctx) {
    await requireSessionContinuation(ctx, "meeting_leave");
    const binding = bindFrom(ctx);
    const refusal = meetingLeaveRefusal({ trust: binding.trust, nonMember: nonMemberWake(ctx), actingPrincipal: actingPrincipalIdOf(ctx) });
    if (refusal !== undefined) throw new Error(refusal);
    const channelId = typeof binding.target?.channelId === "string" ? binding.target.channelId : undefined;
    if (!channelId) throw new Error("meeting_leave couldn't resolve this conversation's id — ask again from the channel or DM that sent the bot.");
    const mine = await openMeetingsFrom(deploymentOrg(), { platform: binding.platform, channelId });
    const targets = input.meetingId === undefined ? mine : mine.filter((m) => m.id === input.meetingId);
    if (targets.length === 0) {
      return { stopped: 0, message: input.meetingId === undefined ? "No meeting bot this conversation sent is running." : `Meeting ${input.meetingId} is not a running meeting bot this conversation sent.` };
    }
    const stopper = actingPrincipalIdOf(ctx)!;
    let posted = 0;
    for (const rec of targets) if ((await finishMeeting(rec, "stopped", {}, { stoppedBy: stopper })).posted) posted++;
    return { stopped: targets.length, message: meetingLeaveMessage(targets.map((m) => `${platformLabel(m.platform)} ${m.roomId}`), posted) };
  },
});
