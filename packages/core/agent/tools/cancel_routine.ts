import { defineTool } from "eve/tools";
import { never } from "eve/tools/approval";
import { z } from "zod";
import { bindFrom } from "../identity/binding.js";
import { actingPrincipalIdOf } from "../access/request.js";
import { resolvePartition } from "../memory/partition.js";
import { getRoutine } from "../routines/store.js";
import { describeTrigger } from "../routines/routine.js";
import { untrustedIngestedThisTurn } from "../access/taint-signal.js";
import { requestApproval, autoApprovedNote } from "../approvals/flow.js";
import { approvalPostDeps } from "./set_spend_limit.js";
import { checkApprovalVenue, describeVenueRefusal, cardPostedPrefix, describeVenueRedirect } from "../approvals/card-venue.js";
import { getConfig } from "../access/config.js";
import { requireSessionContinuation } from "../spend/checkpoint.js";

export default defineTool({
  description:
    "PROPOSE cancelling (deleting) a routine on this surface by its id. Get the id from list_routines. Use when asked to stop a scheduled job, watch, or subscription. This does NOT cancel on the spot: an approval card posts naming the exact routine, and it's removed only when a human confirms (cancelling removes a guardrail, so it's gated). The posted card IS the reply — do not add narration after this call. EXCEPT when this surface can't host a card: it then goes to a card-capable channel in the same domain, the `message` field names it, and you MUST relay that.",
  inputSchema: z.object({
    id: z.string().min(1).describe("The routine id, e.g. 'r-1a2b3c4d' (from list_routines)."),
  }),
  outputSchema: z.object({
    pending: z.boolean(),
    pendingId: z.string().optional(),
    id: z.string(),
    message: z.string(),
    autoApproved: z.boolean().optional().describe("The approver chain lowered this verb: no card was posted and it has ALREADY run."),
  }),
  approval: never(),
  async execute(input, ctx) {
    await requireSessionContinuation(ctx, "cancel_routine");
    const p = resolvePartition(ctx);
    const id = input.id.trim();

    const routine = await getRoutine(p.org, p.surfaceKey, id);
    if (!routine) {
      throw new Error(`No routine '${id}' on this surface — check the id with list_routines.`);
    }
    const description = describeTrigger(routine.trigger, routine.report);

    const binding = bindFrom(ctx);
    const requestedBy = actingPrincipalIdOf(ctx);
    if (!requestedBy) {
      throw new Error("cancel_routine needs a verified sender to gate the removal — a triggered routine fire has no acting sender (only the creator it is attributed to), and a fire may not propose removing a standing behaviour. Ask a person in this conversation to cancel it.");
    }

    const venueResult = await checkApprovalVenue(binding, p, () => getConfig().loadDomains());
    if ("refusal" in venueResult) {
      throw new Error(describeVenueRefusal(venueResult.refusal, binding.platform, "cancel that routine"));
    }
    const venue = venueResult.venue;

    const tainted = untrustedIngestedThisTurn();
    const posted = await requestApproval(
      {
        org: p.org,
        kind: "routine.cancel",
        args: { org: p.org, partition: p, surfaceKey: p.surfaceKey, id, description, requestedBy, tainted },
        scopeKey: p.surfaceKey,
        domain: null,
        requestedBy,
        channelId: venue.channelId,
        threadTs: venue.sameRoom ? binding.threadTs ?? null : null,
        postedTo: venue.surfaceKey,
      },
      approvalPostDeps(venue.platform),
    );

    const subject = `cancel of routine ${id} (${description})${tainted ? " ⚠ tainted" : ""}`;
    if (posted.autoApproved) {
      return {
        pending: false,
        autoApproved: true,
        pendingId: posted.id,
        id,
        message: autoApprovedNote(subject, posted.autoApproved),
      };
    }
    return {
      pending: true,
      pendingId: posted.id,
      id,
      message: `${cardPostedPrefix(venue)} — ${subject} awaiting a human to confirm (pending ${posted.id}).${describeVenueRedirect(venue, "confirm the cancellation")}`,
    };
  },
});
