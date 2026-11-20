import { defineTool } from "eve/tools";
import { z } from "zod";
import { bindFrom } from "../identity/binding.js";
import type { BindableContext } from "../identity/binding.js";
import { principalIdOf, unattendedOf } from "../access/request.js";
import { resolvePartition } from "../memory/partition.js";
import { proposalScopeKey } from "../channels/propose-scope.js";
import { getConfig } from "../access/config.js";
import { resolveEntityAction, currentTurnEntityRef, supportedEntityActionPlatforms } from "../channels/entity-actions.js";
import { workDestinationPlatforms } from "../channels/work-destinations.js";
import { requestApproval, autoApprovedNote } from "../approvals/flow.js";
import { requireSessionContinuation } from "../spend/checkpoint.js";
import { approvalPostDeps } from "./set_spend_limit.js";
import { checkApprovalVenue, describeVenueRefusal, cardPostedPrefix, cardPostedTail } from "../approvals/card-venue.js";
import type { TicketAssignArgs } from "../approvals/ticket-actions.js";
import { sessionMountedTool } from "../access/window-gated.js";
import type { Domain } from "../memory/domain.js";

function safeDomains(): readonly Domain[] {
  try {
    return getConfig().loadDomains();
  } catch {
    return [];
  }
}

const refSchema = z
  .object({
    platform: z.string().min(1).describe('Ticketing surface — "linear" or "github".'),
    id: z.string().min(1).describe('Entity id — a Linear issue UUID/identifier (e.g. "ENG-42"), or GitHub "owner/repo#123".'),
  })
  .optional()
  .describe("The ticket to act on. Defaults to the current turn's entity (the Linear issue or GitHub issue/PR this turn is on).");

export const assignEntry = defineTool({
  description:
    "PROPOSE assigning a ticket — a Linear issue or a GitHub issue/PR — to someone. Entity-gated: only " +
    "works on a ticketing surface; refuses cleanly on chat or Notion. Consequential: posts an approval " +
    "card — nothing changes until a human confirms. The posted card IS the reply — do not add narration " +
    "after this call. EXCEPT when this surface can't host a card: it then goes to a card-capable channel " +
    "in the same domain, the `message` field names it, and you MUST relay that.",
  inputSchema: z.object({
    ref: refSchema,
    assignee: z
      .string()
      .min(1)
      .describe(
        "Who to assign — Linear: an email, display name, or Linear user id. GitHub: a login (username). " +
          "Ambiguous or unmatched names are refused rather than guessed.",
      ),
  }),
  outputSchema: z.object({
    pending: z.boolean(),
    pendingId: z.string().optional(),
    platform: z.string(),
    id: z.string(),
    message: z.string(),
    autoApproved: z.boolean().optional().describe("The approver chain lowered this verb: no card was posted and it has ALREADY run."),
  }),
  async execute(input, ctx) {
    const bctx = ctx as BindableContext;
    await requireSessionContinuation(bctx, "assign");
    const domains = safeDomains();
    const { ref, capabilities } = await resolveEntityAction(bctx, "assign", input.ref, domains);

    const binding = bindFrom(ctx);
    const p = resolvePartition(ctx);
    const proposeScopeKey = await proposalScopeKey(ctx, p);
    const venueResult = await checkApprovalVenue(binding, p, () => domains);
    if ("refusal" in venueResult) {
      throw new Error(describeVenueRefusal(venueResult.refusal, binding.platform, "assign that ticket"));
    }
    const venue = venueResult.venue;
    // principal-gate: accountability — a routine that triages and re-assigns work is the PRODUCT, not an
    const requestedBy = principalIdOf(ctx);
    if (!requestedBy) {
      throw new Error("assign needs a verified sender to gate the change — no principal id resolved, so there's no requester to show on the approval card.");
    }

    const args: TicketAssignArgs = {
      org: p.org,
      scopeKey: proposeScopeKey,
      platform: ref.platform,
      entityId: ref.id,
      ...(ref.organizationId ? { organizationId: ref.organizationId } : {}),
      assignee: input.assignee,
      requestedBy,
      ...(capabilities.length ? { capabilities } : {}),
    };

    const posted = await requestApproval(
      {
        org: p.org,
        kind: "ticket.assign",
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

    const subject = `assign ${ref.platform} ${ref.id} to ${input.assignee}`;
    if (posted.autoApproved) {
      return {
        pending: false,
        autoApproved: true,
        pendingId: posted.id,
        platform: ref.platform,
        id: ref.id,
        message: autoApprovedNote(subject, posted.autoApproved),
      };
    }
    return {
      pending: true,
      pendingId: posted.id,
      platform: ref.platform,
      id: ref.id,
      message: `${cardPostedPrefix(venue)} — ${subject} awaiting a human to confirm (pending ${posted.id}).${cardPostedTail(venue, "confirm the assignment", posted)}`,
    };
  },
});

export default sessionMountedTool("assign", assignEntry, (ctx) => {
  const destinations = workDestinationPlatforms(ctx, safeDomains());
  const adapterPlatforms = supportedEntityActionPlatforms();
  if (!destinations.some((s) => adapterPlatforms.includes(s)) && !currentTurnEntityRef(ctx)) return false;
  return true;
});
