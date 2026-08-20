import { defineDynamic, defineTool } from "eve/tools";
import { z } from "zod";
import { bindFrom, resolveWindowSources } from "../identity/binding.js";
import type { BindableContext } from "../identity/binding.js";
import { principalIdOf, unattendedOf } from "../access/request.js";
import { resolvePartition } from "../memory/partition.js";
import { untrustedIngestedThisTurn } from "../access/taint-signal.js";
import { getConfig } from "../access/config.js";
import { resolveTicketCreate, supportedTicketCreatePlatforms } from "../channels/ticket-create.js";
import { requestApproval, autoApprovedNote } from "../approvals/flow.js";
import { approvalPostDeps } from "./set_spend_limit.js";
import { checkApprovalVenue, describeVenueRefusal, cardPostedPrefix, describeVenueRedirect } from "../approvals/card-venue.js";
import { requireSessionContinuation } from "../spend/checkpoint.js";
import type { TicketCreateArgs } from "../approvals/ticket-create.js";
import { preRegisterDynamicEntry } from "../access/window-gated.js";
import type { Domain } from "../memory/domain.js";

function safeDomains(): readonly Domain[] {
  try {
    return getConfig().loadDomains();
  } catch {
    return [];
  }
}

export const createTicketEntry = defineTool({
  description:
    "PROPOSE filing a NEW work item — a GitHub issue or a Linear issue — on a work surface this " +
    "conversation is bound to. Use it to turn a reported defect or a follow-up into tracked work. " +
    "Consequential: posts an approval card showing the exact title and body — nothing is filed until " +
    "a human confirms. " +
    "Write the body like a ticket: what happens, what should happen, and how to reproduce or verify. " +
    "The posted card IS the reply — do not add narration after this call. EXCEPT when this surface can't " +
    "host a card: it then goes to a card-capable channel in the same domain, the `message` field names it, " +
    "and you MUST relay that.",
  inputSchema: z.object({
    platform: z
      .string()
      .min(1)
      .optional()
      .describe('Which work surface to file on — "github" or "linear". Optional: defaults to this window\'s only work surface.'),
    target: z
      .string()
      .min(1)
      .optional()
      .describe('Where on that surface — a GitHub repo as "owner/repo", or a Linear team key such as "ENG". Optional: defaults to this turn\'s own repo/team when there is one.'),
    title: z.string().min(1).describe("One-line summary of the work item."),
    body: z.string().describe("The full description (markdown): what happens, what should happen, how to reproduce or verify."),
  }),
  outputSchema: z.object({
    pending: z.boolean(),
    pendingId: z.string().optional(),
    platform: z.string(),
    target: z.string(),
    message: z.string(),
    autoApproved: z.boolean().optional().describe("The approver chain lowered this verb: no card was posted and it has ALREADY run."),
  }),
  async execute(input, ctx) {
    const bctx = ctx as BindableContext;
    await requireSessionContinuation(bctx, "create_ticket");
    const domains = safeDomains();
    const { platform, target, organizationId } = await resolveTicketCreate(
      bctx,
      input.platform || input.target ? { ...(input.platform ? { platform: input.platform } : {}), ...(input.target ? { target: input.target } : {}) } : undefined,
      domains,
    );

    const binding = bindFrom(ctx);
    const p = resolvePartition(ctx);
    const venueResult = await checkApprovalVenue(binding, p, () => domains);
    if ("refusal" in venueResult) {
      throw new Error(describeVenueRefusal(venueResult.refusal, binding.platform, "file that ticket"));
    }
    const venue = venueResult.venue;
    const requestedBy = principalIdOf(ctx);
    if (!requestedBy) {
      throw new Error("create_ticket needs a verified sender to gate the filing — no principal id resolved, so there's no requester to show on the approval card.");
    }

    const args: TicketCreateArgs = {
      org: p.org,
      scopeKey: p.surfaceKey,
      platform,
      target,
      ...(organizationId ? { organizationId } : {}),
      title: input.title,
      body: input.body,
      requestedBy,
      tainted: untrustedIngestedThisTurn(),
    };

    const posted = await requestApproval(
      {
        org: p.org,
        kind: "ticket.create",
        args,
        scopeKey: p.surfaceKey,
        domain: null,
        requestedBy,
        channelId: venue.channelId,
        threadTs: venue.sameRoom ? binding.threadTs ?? null : null,
        postedTo: venue.surfaceKey,
        chain: { unattended: unattendedOf(ctx) },
      },
      approvalPostDeps(venue.platform),
    );

    const subject = `file "${input.title}" on ${platform} (${target})`;
    if (posted.autoApproved) {
      return {
        pending: false,
        autoApproved: true,
        pendingId: posted.id,
        platform,
        target,
        message: autoApprovedNote(subject, posted.autoApproved),
      };
    }
    return {
      pending: true,
      pendingId: posted.id,
      platform,
      target,
      message: `${cardPostedPrefix(venue)} — ${subject} awaiting a human to confirm (pending ${posted.id}).${describeVenueRedirect(venue, "confirm the filing")}`,
    };
  },
});
preRegisterDynamicEntry("create_ticket", "_single", createTicketEntry);

export default defineDynamic({
  events: {
    "session.started": (_event, ctx) => {
      const bctx = ctx as BindableContext;
      const sources = resolveWindowSources(bctx, safeDomains());
      const adapterPlatforms = supportedTicketCreatePlatforms();
      if (!sources.some((s) => adapterPlatforms.includes(s))) return null;
      return createTicketEntry;
    },
  },
});
