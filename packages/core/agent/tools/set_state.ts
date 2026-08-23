import { defineDynamic, defineTool } from "eve/tools";
import { z } from "zod";
import { bindFrom } from "../identity/binding.js";
import type { BindableContext } from "../identity/binding.js";
import { principalIdOf, unattendedOf } from "../access/request.js";
import { resolvePartition } from "../memory/partition.js";
import { untrustedIngestedThisTurn } from "../access/taint-signal.js";
import { getConfig } from "../access/config.js";
import { resolveEntityAction, currentTurnEntityRef, supportedEntityActionPlatforms } from "../channels/entity-actions.js";
import { workDestinationPlatforms } from "../channels/work-destinations.js";
import { requestApproval, autoApprovedNote } from "../approvals/flow.js";
import { approvalPostDeps } from "./set_spend_limit.js";
import { checkApprovalVenue, describeVenueRefusal, cardPostedPrefix, describeVenueRedirect } from "../approvals/card-venue.js";
import { requireSessionContinuation } from "../spend/checkpoint.js";
import type { TicketSetStateArgs } from "../approvals/ticket-actions.js";
import { preRegisterDynamicEntry } from "../access/window-gated.js";
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

export const setStateEntry = defineTool({
  description:
    "PROPOSE changing a ticket's status — a Linear issue's workflow state (e.g. \"Done\"), or a GitHub " +
    'issue/PR\'s state ("open"/"closed"). Entity-gated: only works on a ticketing surface; refuses ' +
    "cleanly on chat or Notion. Consequential: posts an approval card — nothing changes until a human " +
    "confirms. The posted card IS the reply — do not add narration after this call. EXCEPT when this " +
    "surface can't host a card: it then goes to a card-capable channel in the same domain, the `message` " +
    "field names it, and you MUST relay that.",
  inputSchema: z.object({
    ref: refSchema,
    state: z.string().min(1).describe('The target state — e.g. "Done"/"In Progress" (Linear), or "open"/"closed" (GitHub).'),
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
    await requireSessionContinuation(bctx, "set_state");
    const domains = safeDomains();
    const { ref, capabilities } = await resolveEntityAction(bctx, "setState", input.ref, domains);

    const binding = bindFrom(ctx);
    const p = resolvePartition(ctx);
    const venueResult = await checkApprovalVenue(binding, p, () => domains);
    if ("refusal" in venueResult) {
      throw new Error(describeVenueRefusal(venueResult.refusal, binding.platform, "change that ticket's status"));
    }
    const venue = venueResult.venue;
    const requestedBy = principalIdOf(ctx);
    if (!requestedBy) {
      throw new Error("set_state needs a verified sender to gate the change — no principal id resolved, so there's no requester to show on the approval card.");
    }

    const args: TicketSetStateArgs = {
      org: p.org,
      scopeKey: p.surfaceKey,
      platform: ref.platform,
      entityId: ref.id,
      ...(ref.organizationId ? { organizationId: ref.organizationId } : {}),
      state: input.state,
      requestedBy,
      tainted: untrustedIngestedThisTurn(),
      ...(capabilities.length ? { capabilities } : {}),
    };

    const posted = await requestApproval(
      {
        org: p.org,
        kind: "ticket.set_state",
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

    const subject = `set ${ref.platform} ${ref.id} state to "${input.state}"`;
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
      message: `${cardPostedPrefix(venue)} — ${subject} awaiting a human to confirm (pending ${posted.id}).${describeVenueRedirect(venue, "confirm the state change")}`,
    };
  },
});
preRegisterDynamicEntry("set_state", "_single", setStateEntry);

export default defineDynamic({
  events: {
    "session.started": (_event, ctx) => {
      const bctx = ctx as BindableContext;
      const destinations = workDestinationPlatforms(bctx, safeDomains());
      const adapterPlatforms = supportedEntityActionPlatforms();
      if (!destinations.some((s) => adapterPlatforms.includes(s)) && !currentTurnEntityRef(bctx)) return null;
      return setStateEntry;
    },
  },
});
