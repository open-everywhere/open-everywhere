import { defineTool } from "eve/tools";
import { never } from "eve/tools/approval";
import { z } from "zod";
import { actingPrincipalId, bindFrom, type SurfaceBinding } from "../identity/binding.js";
import { principalIdOf } from "../access/request.js";
import { domainForChannel } from "../memory/domain.js";
import { getConfig } from "../access/config.js";
import { requestApproval, postedToSurfaceKey, autoApprovedNote } from "../approvals/flow.js";
import { approvalPostDeps, hasApprovalCardPath } from "./set_spend_limit.js";

export interface RevokeConnectorInput {
  readonly connector: string;
  readonly reason: string;
  readonly scopeKey?: string;
}

export interface ConnectorRevokePlan {
  readonly kind: "connector.revoke";
  readonly args: {
    readonly org: string;
    readonly scopeKey: string;
    readonly connector: string;
    readonly reason: string;
  };
  readonly scopeKey: string;
  readonly domain: string | null;
}

export function planRevokeConnector(binding: SurfaceBinding, input: RevokeConnectorInput, domain: string | null): ConnectorRevokePlan {
  if (!hasApprovalCardPath(binding.platform)) {
    throw new Error(`revoke_connector needs a surface with an approval-card path — Slack or Discord for now (this surface is "${binding.platform}") — the approval card renders as a message with Approve/Reject buttons.`);
  }
  if (!actingPrincipalId(binding)) {
    throw new Error("revoke_connector needs a verified sender on this turn — a triggered routine fire has no acting sender (only the creator it is attributed to), and break-glass is a person's decision, not a schedule's. Ask someone in this conversation to propose the revoke.");
  }
  const connector = input.connector.trim();
  if (!connector) {
    throw new Error("revoke_connector needs a non-empty connector name.");
  }
  const reason = input.reason.trim();
  if (!reason) {
    throw new Error("revoke_connector needs a non-empty reason — it's shown on the approval card.");
  }
  const scopeKey = input.scopeKey?.trim() || `${binding.platform}/${binding.workspace}/${binding.domainSurface ?? binding.surface}`;
  return {
    kind: "connector.revoke",
    args: { org: binding.org, scopeKey, connector, reason },
    scopeKey,
    domain,
  };
}

export default defineTool({
  description:
    "Break-glass PROPOSE: cut an Eve connector (by name, e.g. \"notion\") from this surface at runtime — this does NOT revoke anything itself. Posts a confirmation card; an org admin, or a domain admin whose domain covers this scope, must click Approve before the hard gate blocks it (no redeploy needed once approved). Use for incidents (leaked token, abuse) where the change needs to happen NOW, not after a PR review. A revoke is STICKY once approved (no auto-expiry) — revert with clear_connector_override or a PR removing the grant. The posted card IS the reply to the user — do not add any narration, summary, or confirmation text after this call; the channel already sees everything the card says.",
  inputSchema: z.object({
    connector: z.string().min(1).describe('Connector name to revoke, e.g. "notion".'),
    reason: z.string().min(1).describe("Why — shown on the approval card (e.g. \"suspected leaked token\")."),
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
  approval: never(),
  async execute(input, ctx) {
    const binding = bindFrom(ctx);
    const scopeKey = input.scopeKey?.trim() || `${binding.platform}/${binding.workspace}/${binding.domainSurface ?? binding.surface}`;
    const domain = domainForChannel(scopeKey, getConfig().loadDomains())?.name ?? null;
    const plan = planRevokeConnector(binding, input, domain);

    const channelId = typeof binding.target?.channelId === "string" ? binding.target.channelId : undefined;
    if (!channelId) {
      throw new Error("revoke_connector couldn't resolve this channel's id — try again from a real channel or DM, not a synthetic context.");
    }

    const posted = await requestApproval(
      {
        org: plan.args.org,
        kind: plan.kind,
        args: plan.args,
        scopeKey: plan.scopeKey,
        domain: plan.domain,
        requestedBy: principalIdOf(ctx)!,
        channelId,
        threadTs: binding.threadTs ?? null,
        postedTo: postedToSurfaceKey(binding, channelId),
      },
      approvalPostDeps(binding.platform),
    );

    const subject = `revoke "${plan.args.connector}" from "${plan.args.scopeKey}"`;
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
      note: `card posted — ${subject} (pending ${posted.id}).`,
    };
  },
});
