import { defineDynamic, defineTool } from "eve/tools";
import { z } from "zod";
import { bindFrom, type BindableContext } from "../identity/binding.js";
import { principalIdOf, unattendedOf } from "../access/request.js";
import { resolvePartition } from "../memory/partition.js";
import { proposalScopeKey } from "../channels/propose-scope.js";
import { untrustedIngestedThisTurn } from "../access/taint-signal.js";
import { getConfig } from "../access/config.js";
import { assertChatDmAllowed, chatDmMount, PERSON_RESOURCE_TYPE } from "../access/chat-dm-grant.js";
import { deliverProactiveDm, dmDeliveryFooter } from "../channels/dm-audience.js";
import { personWords } from "../channels/friendly-ids.js";
import { accountProfileFor, composedAccountName } from "../identity/account-display-name.js";
import { friendlyScopeLabel } from "../approvals/scope-label.js";
import { requestApproval, autoApprovedNote } from "../approvals/flow.js";
import { approvalPostDeps } from "./set_spend_limit.js";
import { checkApprovalVenue, describeVenueRefusal, cardPostedPrefix, cardPostedTail } from "../approvals/card-venue.js";
import { requireSessionContinuation } from "../spend/checkpoint.js";
import { preRegisterDynamicEntry } from "../access/window-gated.js";
import type { ChatDmArgs } from "../approvals/chat-dm.js";
import type { Domain } from "../memory/domain.js";

function safeDomains(): readonly Domain[] {
  try {
    return getConfig().loadDomains();
  } catch {
    return [];
  }
}

const dmPersonEntry = defineTool({
  description:
    "Send a direct message to a person an operator granted. Name them by their granted address, e.g. " +
    `"slack:${PERSON_RESOURCE_TYPE}/U0123ABC". Only people an operator granted in config can be named. ` +
    "The FIRST message to someone posts an approval card showing them and your exact text; after that " +
    "your messages to them send straight away. Every message carries a host-written line saying who " +
    "asked and how they can stop it — and if they have stopped it, this refuses and says so. Do not " +
    "reach for it to answer the room you are in: use reply for that.",
  inputSchema: z.object({
    person: z
      .string()
      .min(1)
      .describe(`The recipient's granted address, in the form <connector>:${PERSON_RESOURCE_TYPE}/<id>.`),
    text: z.string().min(1).describe("The exact message to send. A human may read this in full on an approval card."),
  }),
  outputSchema: z.object({
    pending: z.boolean(),
    pendingId: z.string().optional(),
    platform: z.string(),
    person: z.string(),
    message: z.string(),
    delivered: z.boolean().optional().describe("The message is ALREADY sent — this person's first delivery was approved earlier."),
    autoApproved: z.boolean().optional().describe("The approver chain lowered this verb: no card was posted and it has ALREADY run."),
  }),
  async execute(input, ctx) {
    const bctx = ctx as BindableContext;
    await requireSessionContinuation(bctx, "dm_person");
    const domains = safeDomains();
    const admitted = await assertChatDmAllowed(bctx, domains, input.person);
    const target = admitted.target;

    const binding = bindFrom(ctx);
    const p = resolvePartition(ctx);
    const proposeScopeKey = await proposalScopeKey(ctx, p);
    const requestedBy = principalIdOf(ctx);
    if (!requestedBy) {
      throw new Error("dm_person needs a verified sender — no principal id resolved, so there is nobody to name as the person who asked for this message.");
    }
    const fromLabel = await friendlyScopeLabel(p.surfaceKey).catch(() => undefined);
    const footer = dmDeliveryFooter({
      platform: target.platform,
      recipientId: target.principalId,
      requestedBy,
      from: p.surfaceKey,
      ...(fromLabel !== undefined ? { fromLabel } : {}),
    });

    if (admitted.delivered) {
      await deliverProactiveDm({
        where: { org: p.org, platform: p.platform, workspace: p.workspace, surface: p.surfaceKey },
        plane: "chat.dm",
        platform: target.platform,
        recipientId: target.principalId,
        address: target.address,
        text: input.text,
        footer,
        requestedBy,
        attributedTo: requestedBy,
        first: false,
        tainted: untrustedIngestedThisTurn(),
      });
      return {
        pending: false,
        delivered: true,
        platform: target.platform,
        person: target.principalId,
        message: `Sent. ${personWords({ id: target.principalId, platform: target.platform })} has it, with the line telling them how to stop.`,
      };
    }

    const venueResult = await checkApprovalVenue(binding, p, () => domains);
    if ("refusal" in venueResult) {
      throw new Error(describeVenueRefusal(venueResult.refusal, binding.platform, "send that direct message"));
    }
    const venue = venueResult.venue;

    const recipientLabel = composedAccountName(await accountProfileFor(target.platform, target.principalId, p.workspace).catch(() => undefined));
    const args: ChatDmArgs = {
      org: p.org,
      scopeKey: proposeScopeKey,
      platform: target.platform,
      principalId: target.principalId,
      ...(recipientLabel !== undefined ? { recipientLabel } : {}),
      grant: target.address,
      text: input.text,
      footer,
      requestedBy,
      tainted: untrustedIngestedThisTurn(),
    };

    const posted = await requestApproval(
      {
        org: p.org,
        kind: "chat.dm",
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

    const subject = `start a direct message with ${personWords({ id: target.principalId, platform: target.platform })}`;
    if (posted.autoApproved) {
      return {
        pending: false,
        autoApproved: true,
        pendingId: posted.id,
        platform: target.platform,
        person: target.principalId,
        message: autoApprovedNote(subject, posted.autoApproved),
      };
    }
    return {
      pending: true,
      pendingId: posted.id,
      platform: target.platform,
      person: target.principalId,
      message: `${cardPostedPrefix(venue)} — ${subject} awaiting a human to confirm (pending ${posted.id}).${cardPostedTail(venue, "confirm the message", posted)}`,
    };
  },
});
preRegisterDynamicEntry("dm_person", "_single", dmPersonEntry);

export default defineDynamic({
  events: {
    "session.started": (_event, ctx) => {
      if (!chatDmMount(ctx as BindableContext, safeDomains)) return null;
      return dmPersonEntry;
    },
  },
});
