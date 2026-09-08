import { defineTool } from "eve/tools";
import { never } from "eve/tools/approval";
import { z } from "zod";
import { requestApproval, autoApprovedNote } from "../approvals/flow.js";
import { checkApprovalVenue, describeVenueRefusal, cardPostedPrefix, describeVenueRedirect } from "../approvals/card-venue.js";
import { getConfig } from "../access/config.js";
import { domainForChannel } from "../memory/domain.js";
import { bindFrom } from "../identity/binding.js";
import { principalIdOf, unattendedOf } from "../access/request.js";
import { resolvePartition } from "../memory/partition.js";
import { approvalPostDeps } from "./set_spend_limit.js";
import { chatHaltAddress } from "./halt.js";

export default defineTool({
  description:
    "PROPOSE lifting the break-glass halt — this does NOT lift it. Posts a confirmation card; an org admin must click Approve, because resuming WIDENS what the deployment may do (halting narrows, so `halt` needs no card and takes effect at once). Use it once whatever caused the halt is resolved. The posted card IS the reply to the user — do not add narration after this call. EXCEPT when this surface can't host a card: it then goes to a card-capable channel in the same domain, the `note` field names it, and you MUST relay that.",
  inputSchema: z.object({
    scope: z
      .enum(["org", "surface"])
      .default("org")
      .describe(
        'Which halt to lift — the same two addresses `halt` sets. "org" (the default) lifts the deployment-wide halt; "surface" lifts only this conversation\'s own. Lifting one never lifts the other: if both are set, both must be resumed.',
      ),
  }),
  outputSchema: z.object({
    requested: z.boolean(),
    pendingId: z.string(),
    expiresAt: z.string().optional().describe("Absent when the chain auto-approved: the row is already decided, so nothing expires."),
    note: z.string(),
    autoApproved: z.boolean().optional().describe("The approver chain lowered this verb: no card was posted and it has ALREADY run."),
  }),
  approval: never(),
  async execute(input, ctx) {
    const binding = bindFrom(ctx);
    const p = resolvePartition(ctx);
    const scope = input.scope ?? "org";
    const address = chatHaltAddress(scope, p.surfaceKey);
    const requestedBy = principalIdOf(ctx);
    if (!requestedBy) {
      throw new Error(
        "resume needs a verified sender on this turn — the approval card has to name who asked. Ask someone in this conversation to propose it, or lift the halt from the control plane instead.",
      );
    }
    const domain = domainForChannel(p.surfaceKey, getConfig().loadDomains())?.name ?? null;
    const venueResult = await checkApprovalVenue(binding, p, () => getConfig().loadDomains());
    if ("refusal" in venueResult) {
      throw new Error(describeVenueRefusal(venueResult.refusal, binding.platform, "lift that halt"));
    }
    const venue = venueResult.venue;

    const posted = await requestApproval(
      {
        org: p.org,
        kind: "halt.resume",
        args: {
          org: p.org,
          ...(address.orgWide ? { orgWide: true as const } : { level: address.level, scopeKey: address.scopeKey }),
          scopeLabel: scope === "org" ? "the whole deployment" : "this conversation",
        },
        scopeKey: p.surfaceKey,
        domain,
        requestedBy,
        channelId: venue.channelId,
        threadTs: venue.sameRoom ? binding.threadTs ?? null : null,
        postedTo: venue.surfaceKey,
        chain: { unattended: unattendedOf(ctx) },
      },
      approvalPostDeps(venue.platform),
    );

    const subject = scope === "org" ? "lift the deployment-wide halt" : "lift this conversation's halt";
    if (posted.autoApproved) {
      return { requested: false, autoApproved: true, pendingId: posted.id, note: autoApprovedNote(subject, posted.autoApproved) };
    }
    return {
      requested: true,
      pendingId: posted.id,
      expiresAt: posted.expiresAt,
      note: `${cardPostedPrefix(venue)} — ${subject} (pending ${posted.id}).` + describeVenueRedirect(venue, "approve it"),
    };
  },
});
