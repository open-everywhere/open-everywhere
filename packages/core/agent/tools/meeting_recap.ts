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
import { nonMemberWake } from "./propose_mcp_server.js";
import { parseMeetingLink, platformLabel } from "../meetings/link.js";
import { meetingPolicy, nativeRecapRefusal, normaliseOrganiserEmail } from "../meetings/policy.js";
import { nativeTranscriptSource } from "../meetings/native.js";
import { mintNativeRecapId, type NativeRecapArgs } from "../meetings/native-recap.js";

export default defineTool({
  description:
    "Recap a Microsoft Teams, Google Meet or Zoom meeting from the platform's OWN transcript, with the speakers' real names and no bot in the room. Pass the meeting link the person gave you. " +
    "Use it when the person asks for a recap of a meeting that had (or will have) the platform's transcription on; use meeting_join instead to send OE's own notetaker bot. " +
    "For Google Meet, also pass the organiser's email (a Meet link names no organiser) — ask the person if they did not say it. " +
    "Set `when` to `next` when the meeting has not happened yet or is on now, and `past` when it is over. " +
    "This posts an approval card; nothing is read until a member approves. Then I post the recap with decisions and actions into this thread, or say plainly why the platform gave no transcript. " +
    "Refused in an external or guest conversation, and for platforms the deployment's meeting policy declares no credential for. The posted card IS the reply — do not add narration after this call.",
  inputSchema: z.object({
    url: z.string().min(1).describe("The meeting link exactly as the person pasted it (https://teams.microsoft.com/l/meetup-join/…, https://meet.google.com/…, https://…zoom.us/j/…)."),
    when: z.enum(["past", "next"]).describe("`past`: the meeting is over — recap its most recent session. `next`: the meeting is upcoming or on now — wait for its transcript."),
    organiser: z.string().optional().describe("Google Meet only: the organiser's email address."),
    reason: z.string().optional().describe("What the meeting is, in a few words, for the card."),
  }),
  outputSchema: z.object({
    proposed: z.boolean(),
    pending: z.boolean(),
    pendingId: z.string().optional(),
    recapId: z.string(),
    message: z.string(),
    autoApproved: z.boolean().optional().describe("The approver chain lowered this verb: no card was posted and the transcript has ALREADY been read."),
  }),
  approval: never(),
  async execute(input, ctx) {
    await requireSessionContinuation(ctx, "meeting_recap");
    if (resolveMode(ctx) === "mpim") throw new Error("Group DMs are execution-only — ask me for the recap from a channel or a DM instead.");

    const parsed = parseMeetingLink(input.url);
    if (!parsed.ok) throw new Error(parsed.reason);
    const link = parsed.link;

    const binding = bindFrom(ctx);
    const requestedBy = actingPrincipalIdOf(ctx);
    const policy = meetingPolicy();
    const organiserEmail = link.platform === "meet" ? normaliseOrganiserEmail(input.organiser) : undefined;
    const refusal = nativeRecapRefusal(policy, link, {
      trust: binding.trust,
      nonMember: nonMemberWake(ctx),
      actingPrincipal: requestedBy,
      ...(input.organiser !== undefined ? { organiserEmail: input.organiser } : {}),
    });
    if (refusal !== undefined) throw new Error(refusal);
    const source = nativeTranscriptSource(link.platform);
    if (source === undefined) throw new Error(`this deployment has no ${platformLabel(link.platform)} transcript reader registered, so I can't promise a recap`);

    const p = resolvePartition(ctx);
    const scopeKey = await proposalScopeKey(ctx, p);
    const venueResult = await checkApprovalVenue(binding, p, () => getConfig().loadDomains());
    if ("refusal" in venueResult) throw new Error(describeVenueRefusal(venueResult.refusal, binding.platform, "read a meeting transcript"));
    const venue = venueResult.venue;

    const channelId = typeof binding.target?.channelId === "string" ? binding.target.channelId : undefined;
    if (!channelId) throw new Error("meeting_recap couldn't resolve this conversation's id — ask again from a real channel or DM.");

    const surfaceMode = turnSurfaceMode(ctx);
    const turnId = currentTurnId(ctx);
    const recapId = mintNativeRecapId(turnId !== undefined ? { sessionId: ctx.session.id, turnId, url: link.url } : undefined);
    const args: NativeRecapArgs = {
      org: p.org,
      scopeKey,
      recapId,
      url: link.url,
      platform: link.platform,
      host: link.host,
      roomId: link.roomId,
      ...(link.tenantId !== undefined ? { tenantId: link.tenantId } : {}),
      ...(link.organizerId !== undefined ? { organizerId: link.organizerId } : {}),
      ...(organiserEmail !== undefined ? { organiserEmail } : {}),
      when: input.when,
      askedAt: Date.now(),
      requestedBy: requestedBy!,
      origin: { platform: binding.platform, channelId, threadTs: binding.threadTs ?? null },
      partition: p,
      ...(surfaceMode !== undefined ? { surfaceMode } : {}),
      watchHours: policy.native.watchHours,
      disclosure: source.disclosure,
      ...(input.reason ? { reason: input.reason } : {}),
    };

    const posted = await requestApproval(
      {
        org: p.org,
        kind: "meeting.recap",
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
      return { proposed: true, pending: false, autoApproved: true, pendingId: posted.id, recapId, message: `${autoApprovedNote(`read the transcript of the ${what}`, posted.autoApproved)} The recap, or the reason there is none, comes to this thread.` };
    }
    return {
      proposed: true,
      pending: true,
      pendingId: posted.id,
      recapId,
      message: `${cardPostedPrefix(venue)} — approving it reads ${platformLabel(link.platform)}'s own transcript of the ${what} (pending ${posted.id}). The recap, or the reason there is none, comes to this thread.${cardPostedTail(venue, "approve it", posted)}`,
    };
  },
});
