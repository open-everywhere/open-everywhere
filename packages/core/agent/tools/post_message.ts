import { defineDynamic, defineTool } from "eve/tools";
import { z } from "zod";
import { bindFrom, type BindableContext } from "../identity/binding.js";
import { principalIdOf, unattendedOf } from "../access/request.js";
import { resolvePartition } from "../memory/partition.js";
import { proposalScopeKey } from "../channels/propose-scope.js";
import { untrustedIngestedThisTurn } from "../access/taint-signal.js";
import { getConfig } from "../access/config.js";
import { assertChatWriteAllowed, chatWriteMount, CONTAINER_RESOURCE_TYPE } from "../access/chat-write-grant.js";
import { requestApproval, autoApprovedNote } from "../approvals/flow.js";
import { approvalPostDeps } from "./set_spend_limit.js";
import { checkApprovalVenue, describeVenueRefusal, cardPostedPrefix, describeVenueRedirect } from "../approvals/card-venue.js";
import { requireSessionContinuation } from "../spend/checkpoint.js";
import { preRegisterDynamicEntry } from "../access/window-gated.js";
import type { ChatPostArgs } from "../approvals/chat-post.js";
import type { Domain } from "../memory/domain.js";

function safeDomains(): readonly Domain[] {
  try {
    return getConfig().loadDomains();
  } catch {
    return [];
  }
}

const postMessageEntry = defineTool({
  description:
    "Post a message into ANOTHER container your domain owns — not the one you are talking in (use " +
    "reply for that). Name the container by its granted address, e.g. " +
    `"slack:${CONTAINER_RESOURCE_TYPE}/C0123ABC". Only containers an operator granted in config and ` +
    "that belong to this session's own memory domain can be named; anything else refuses and says " +
    "which boundary stopped it. Consequential: it posts an approval card showing the destination " +
    "and the exact message — nothing is posted until a human confirms.",
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
      tainted: untrustedIngestedThisTurn(),
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
      approvalPostDeps(venue.platform),
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
      message: `${cardPostedPrefix(venue)} — ${subject} awaiting a human to confirm (pending ${posted.id}).${describeVenueRedirect(venue, "confirm the post")}`,
    };
  },
});
preRegisterDynamicEntry("post_message", "_single", postMessageEntry);

export default defineDynamic({
  events: {
    "session.started": (_event, ctx) => {
      if (!chatWriteMount(ctx as BindableContext, safeDomains)) return null;
      return postMessageEntry;
    },
  },
});
