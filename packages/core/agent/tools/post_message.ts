import { defineTool } from "eve/tools";
import { z } from "zod";
import { bindFrom, type BindableContext } from "../identity/binding.js";
import { principalIdOf, unattendedOf } from "../access/request.js";
import { resolvePartition } from "../memory/partition.js";
import { proposalScopeKey } from "../channels/propose-scope.js";
import { getConfig } from "../access/config.js";
import { assertChatWriteAllowed, chatWriteMount, CONTAINER_RESOURCE_TYPE } from "../access/chat-write-grant.js";
import { requestApproval, autoApprovedNote } from "../approvals/flow.js";
import { approvalPostDeps } from "./set_spend_limit.js";
import { checkApprovalVenue, describeVenueRefusal, cardPostedPrefix, cardPostedTail } from "../approvals/card-venue.js";
import { requireSessionContinuation } from "../spend/checkpoint.js";
import { sessionMountedTool } from "../access/window-gated.js";
import type { ChatPostArgs } from "../approvals/chat-post.js";
import type { Domain } from "../memory/domain.js";

function safeDomains(): readonly Domain[] {
  try {
    return getConfig().loadDomains();
  } catch {
    return [];
  }
}

export const POST_MESSAGE_DESCRIPTION =
  "Post a message into a container an operator granted to your domain. Name it by its granted " +
  `address, e.g. "slack:${CONTAINER_RESOURCE_TYPE}/C0123ABC" or "discord:${CONTAINER_RESOURCE_TYPE}/123456789". ` +
  "The channel you are in is allowed when it is granted. To answer the conversation, use reply instead. " +
  "A container that is not granted, or not in this session's own memory domain, refuses and says " +
  "which boundary stopped it. Consequential: it posts an approval card showing the destination " +
  "and the exact message — nothing is posted until a human confirms.";

const postMessageEntry = defineTool({
  description: POST_MESSAGE_DESCRIPTION,
  inputSchema: z.object({
    container: z
      .string()
      .min(1)
      .describe(`The destination's granted address, in the form <connector>:${CONTAINER_RESOURCE_TYPE}/<id>.`),
    text: z.string().min(1).describe("The exact message to post. A human reads this in full on the approval card."),
  }),
  outputSchema: z.object({
    pending: z.boolean(),
    pendingId: z.string().optional(),
    platform: z.string(),
    container: z.string(),
    message: z.string(),
    autoApproved: z.boolean().optional().describe("The approver chain lowered this verb: no card was posted and it has ALREADY run."),
  }),
  async execute(input, ctx) {
    const bctx = ctx as BindableContext;
    await requireSessionContinuation(bctx, "post_message");
    const domains = safeDomains();
    const target = await assertChatWriteAllowed(bctx, domains, input.container);

    const binding = bindFrom(ctx);
    const p = resolvePartition(ctx);
    const proposeScopeKey = await proposalScopeKey(ctx, p);
    const venueResult = await checkApprovalVenue(binding, p, () => domains);
    if ("refusal" in venueResult) {
      throw new Error(describeVenueRefusal(venueResult.refusal, binding.platform, "post that message"));
    }
    const venue = venueResult.venue;
    // principal-gate: accountability — somebody NAMEABLE must exist (a card needs an "asked by" line). A fire's attested creator satisfies this, correctly.
    const requestedBy = principalIdOf(ctx);
    if (!requestedBy) {
      throw new Error("post_message needs a verified sender to gate the post — no principal id resolved, so there's no requester to show on the approval card.");
    }

    const args: ChatPostArgs = {
      org: p.org,
      scopeKey: proposeScopeKey,
      platform: target.platform,
      container: target.container,
      grant: target.address,
      text: input.text,
      requestedBy,
    };

    const posted = await requestApproval(
      {
        org: p.org,
        kind: "chat.post",
        args,
        scopeKey: proposeScopeKey,
        domain: null,
        requestedBy,
        channelId: venue.channelId,
        threadTs: venue.sameRoom ? binding.threadTs ?? null : null,
        postedTo: venue.surfaceKey,
        chain: { unattended: unattendedOf(ctx) },
      },
      approvalPostDeps(venue.platform, ctx),
    );

    const subject = `post into ${target.platform} container ${target.container}`;
    if (posted.autoApproved) {
      return {
        pending: false,
        autoApproved: true,
        pendingId: posted.id,
        platform: target.platform,
        container: target.container,
        message: autoApprovedNote(subject, posted.autoApproved),
      };
    }
    return {
      pending: true,
      pendingId: posted.id,
      platform: target.platform,
      container: target.container,
      message: `${cardPostedPrefix(venue)} — ${subject} awaiting a human to confirm (pending ${posted.id}).${cardPostedTail(venue, "confirm the post", posted)}`,
    };
  },
});

export default sessionMountedTool("post_message", postMessageEntry, (ctx) => {
  if (!chatWriteMount(ctx, safeDomains)) return false;
  return true;
});
