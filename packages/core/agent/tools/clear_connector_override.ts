import { defineDynamic, defineTool } from "eve/tools";
import { z } from "zod";
import { actingPrincipalId, bindFrom, type SurfaceBinding } from "../identity/binding.js";
import { principalIdOf } from "../access/request.js";
import { resolvePartition } from "../memory/partition.js";
import { domainForChannel } from "../memory/domain.js";
import { getConfig } from "../access/config.js";
import { requestApproval, autoApprovedNote } from "../approvals/flow.js";
import { checkApprovalVenue, describeVenueRefusal, cardPostedPrefix, describeVenueRedirect } from "../approvals/card-venue.js";
import { approvalPostDeps } from "./set_spend_limit.js";
import { preRegisterDynamicEntry } from "../access/window-gated.js";

export interface ClearConnectorOverrideInput {
  readonly connector: string;
  readonly scopeKey?: string;
}

export interface ConnectorClearPlan {
  readonly kind: "connector.clear";
  readonly args: {
    readonly org: string;
    readonly scopeKey: string;
    readonly connector: string;
  };
  readonly scopeKey: string;
  readonly domain: string | null;
}

export function planClearConnectorOverride(binding: SurfaceBinding, input: ClearConnectorOverrideInput, domain: string | null): ConnectorClearPlan {
  if (!actingPrincipalId(binding)) {
    throw new Error("clear_connector_override needs a verified sender on this turn — a triggered routine fire has no acting sender (only the creator it is attributed to), and restoring cut access is a person's decision. Ask someone in this conversation to propose it.");
  }
  const connector = input.connector.trim();
  if (!connector) {
    throw new Error("clear_connector_override needs a non-empty connector name.");
  }
  const scopeKey = input.scopeKey?.trim() || `${binding.platform}/${binding.workspace}/${binding.domainSurface ?? binding.surface}`;
  return {
    kind: "connector.clear",
    args: { org: binding.org, scopeKey, connector },
    scopeKey,
    domain,
  };
}

const clearConnectorOverrideEntry = defineTool({
  description:
    "PROPOSE reverting an earlier break-glass connector revoke, restoring this surface's config-as-code bundle grants for that connector — this does NOT clear anything itself. Posts a confirmation card; an org admin, or a domain admin whose domain covers this scope, must click Approve (this widens access back to config, so the admin click is the gate). Use to undo revoke_connector once the incident is resolved. The posted card IS the reply to the user — do not add any narration, summary, or confirmation text after this call; the channel already sees everything the card says. EXCEPT when this surface can't host a card: it then goes to a card-capable channel in the same domain, the `note` field names it, and you MUST relay that.",
  inputSchema: z.object({
    connector: z.string().min(1).describe('Connector name to restore, e.g. "notion".'),
    scopeKey: z
      .string()
      .optional()
      .describe('Override the scope key, e.g. "slack/T123/C456". Defaults to this surface\'s own scope.'),
  }),
  outputSchema: z.object({
    requested: z.boolean(),
    pendingId: z.string(),
    expiresAt: z.string().optional().describe("Absent when the chain auto-approved: the row is already decided, so nothing expires."),
    note: z.string(),
    autoApproved: z.boolean().optional().describe("The approver chain lowered this verb: no card was posted and it has ALREADY run."),
  }),
  async execute(input, ctx) {
    const binding = bindFrom(ctx);
    const scopeKey = input.scopeKey?.trim() || `${binding.platform}/${binding.workspace}/${binding.domainSurface ?? binding.surface}`;
    const domain = domainForChannel(scopeKey, getConfig().loadDomains())?.name ?? null;
    const plan = planClearConnectorOverride(binding, input, domain);

    const venueResult = await checkApprovalVenue(binding, resolvePartition(ctx), () => getConfig().loadDomains());
    if ("refusal" in venueResult) {
      throw new Error(describeVenueRefusal(venueResult.refusal, binding.platform, "clear that override"));
    }
    const venue = venueResult.venue;

    const posted = await requestApproval(
      {
        org: plan.args.org,
        kind: plan.kind,
        args: plan.args,
        scopeKey: plan.scopeKey,
        domain: plan.domain,
        requestedBy: principalIdOf(ctx)!,
        channelId: venue.channelId,
        threadTs: venue.sameRoom ? binding.threadTs ?? null : null,
        postedTo: venue.surfaceKey,
      },
      approvalPostDeps(venue.platform),
    );

    const subject = `clear override for "${plan.args.connector}" on "${plan.args.scopeKey}"`;
    if (posted.autoApproved) {
      return {
        requested: false,
        autoApproved: true,
        pendingId: posted.id,
        note: autoApprovedNote(subject, posted.autoApproved),
      };
    }
    return {
      requested: true,
      pendingId: posted.id,
      expiresAt: posted.expiresAt,
      note: `${cardPostedPrefix(venue)} — ${subject} (pending ${posted.id}).` + describeVenueRedirect(venue, "approve it"),
    };
  },
});
preRegisterDynamicEntry("clear_connector_override", "_single", clearConnectorOverrideEntry);

export default defineDynamic({
  events: {
    "session.started": () => clearConnectorOverrideEntry,
  },
});
