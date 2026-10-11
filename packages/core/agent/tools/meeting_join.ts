import { defineTool } from "eve/tools";
import { never } from "eve/tools/approval";
import { z } from "zod";
import { resolvePartition } from "../memory/partition.js";
import { proposalScopeKey } from "../channels/propose-scope.js";
import { actingPrincipalIdOf, resolveMode, unattendedOf } from "../access/request.js";
import { bindFrom, currentTurnId } from "../identity/binding.js";
import { getConfig } from "../access/config.js";
import { requestApproval, autoApprovedNote } from "../approvals/flow.js";
import { approvalPostDeps } from "./set_spend_limit.js";
import { checkApprovalVenue, describeVenueRefusal, cardPostedPrefix, cardPostedTail } from "../approvals/card-venue.js";
import { requireSessionContinuation } from "../spend/checkpoint.js";
import { turnSurfaceMode } from "../hooks/spend.js";
import { selfDispatchBaseUrl } from "../channels/self-dispatch.js";
import { nonMemberWake } from "./propose_mcp_server.js";
import { parseMeetingLink, platformLabel } from "../meetings/link.js";
import { meetingJoinRefusal, meetingPolicy } from "../meetings/policy.js";
import { mintMeetingId, type MeetingJoinArgs } from "../meetings/lifecycle.js";
import { transcriptionRoute } from "../meetings/transcription.js";
import { BoxUnavailableError, resolveLongLivedBoxBackend } from "../sandbox/long-lived-box.js";

const ZOOM_NOT_YET =
  "Zoom requires a Zoom-reviewed app and an OBF token from a signed-in person who is in the meeting, and this deployment has no per-person Zoom sign-in yet — so I can't join Zoom meetings. Google Meet and Microsoft Teams work.";

export default defineTool({
  description:
    "Send OE's own meeting bot to a Google Meet or Microsoft Teams meeting, for a recap after the meeting. Pass the meeting link the person gave you. " +
    "This posts an approval card; nothing joins until a member approves. The bot joins as a visible participant that the meeting host admits from the lobby, records the audio, leaves when the meeting ends, and then I post a recap with decisions and actions into this thread. " +
    "Refused in an external or guest conversation, for hosts the deployment's meeting policy does not list, and for Zoom. The posted card IS the reply — do not add narration after this call.",
  inputSchema: z.object({
    url: z.string().min(1).describe("The meeting link exactly as the person pasted it (https://meet.google.com/…, https://teams.microsoft.com/l/meetup-join/…)."),
    reason: z.string().optional().describe("What the meeting is, in a few words, for the card."),
  }),
  outputSchema: z.object({
    proposed: z.boolean(),
    pending: z.boolean(),
    pendingId: z.string().optional(),
    meetingId: z.string(),
    message: z.string(),
    autoApproved: z.boolean().optional().describe("The approver chain lowered this verb: no card was posted and the bot has ALREADY been sent."),
  }),
  approval: never(),
  async execute(input, ctx) {
    await requireSessionContinuation(ctx, "meeting_join");
    if (resolveMode(ctx) === "mpim") throw new Error("Group DMs are execution-only — ask me to join the meeting from a channel or a DM instead.");

    const parsed = parseMeetingLink(input.url);
    if (!parsed.ok) throw new Error(parsed.reason);
    const link = parsed.link;
    if (link.platform === "zoom") throw new Error(ZOOM_NOT_YET);

    const binding = bindFrom(ctx);
    const requestedBy = actingPrincipalIdOf(ctx);
    const policy = meetingPolicy();
    const refusal = meetingJoinRefusal(policy, link, { trust: binding.trust, nonMember: nonMemberWake(ctx), actingPrincipal: requestedBy });
    if (refusal !== undefined) throw new Error(refusal);

    let backend;
    try {
      backend = resolveLongLivedBoxBackend();
    } catch (err) {
      if (err instanceof BoxUnavailableError) throw new Error(`I can't send a meeting bot from this deployment: ${err.message}`);
      throw err;
    }
    const route = transcriptionRoute(policy.transcription.route);
    if (route === undefined) throw new Error(`the meeting policy names the "${policy.transcription.route}" transcription route, and this deployment has none registered — so I can't promise a recap`);
    if (selfDispatchBaseUrl() === undefined) throw new Error("this deployment has no public URL for the meeting bot to call back on (OE_PUBLIC_BASE_URL, or a Vercel production URL)");

    const p = resolvePartition(ctx);
    const scopeKey = await proposalScopeKey(ctx, p);
    const venueResult = await checkApprovalVenue(binding, p, () => getConfig().loadDomains());
    if ("refusal" in venueResult) throw new Error(describeVenueRefusal(venueResult.refusal, binding.platform, "send a meeting bot"));
    const venue = venueResult.venue;

    const channelId = typeof binding.target?.channelId === "string" ? binding.target.channelId : undefined;
    if (!channelId) throw new Error("meeting_join couldn't resolve this conversation's id — ask again from a real channel or DM.");

    const surfaceMode = turnSurfaceMode(ctx);
    const turnId = currentTurnId(ctx);
    const meetingId = mintMeetingId(turnId !== undefined ? { sessionId: ctx.session.id, turnId, url: link.url } : undefined);
    const args: MeetingJoinArgs = {
      org: p.org,
      scopeKey,
      meetingId,
      url: link.url,
      platform: link.platform,
      host: link.host,
      roomId: link.roomId,
      requestedBy: requestedBy!,
      origin: { platform: binding.platform, channelId, threadTs: binding.threadTs ?? null },
      partition: p,
      ...(surfaceMode !== undefined ? { surfaceMode } : {}),
      maxMinutes: Math.min(policy.maxMinutes, backend.maxMinutesCeiling),
      transcriptDays: policy.retention.transcriptDays,
      transcriptionDisclosure: route.disclosure,
      backend: backend.backend,
      ...(input.reason ? { reason: input.reason } : {}),
    };

    const posted = await requestApproval(
      {
        org: p.org,
        kind: "meeting.join",
        args,
        scopeKey,
        domain: null,
        requestedBy: requestedBy!,
        channelId: venue.channelId,
        threadTs: venue.sameRoom ? binding.threadTs ?? null : null,
        postedTo: venue.surfaceKey,
        chain: { unattended: unattendedOf(ctx) },
      },
      approvalPostDeps(venue.platform, ctx),
    );

    const what = `${platformLabel(link.platform)} meeting ${link.roomId}`;
    if (posted.autoApproved) {
      return { proposed: true, pending: false, autoApproved: true, pendingId: posted.id, meetingId, message: `${autoApprovedNote(`meeting bot to the ${what}`, posted.autoApproved)} The host must admit the bot from the lobby.` };
    }
    return {
      proposed: true,
      pending: true,
      pendingId: posted.id,
      meetingId,
      message: `${cardPostedPrefix(venue)} — approving it sends OE's meeting bot to the ${what} (pending ${posted.id}). The host must admit the bot; the recap comes to this thread after the meeting.${cardPostedTail(venue, "approve it", posted)}`,
    };
  },
});
