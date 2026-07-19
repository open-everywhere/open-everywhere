import { defineDynamic, defineTool } from "eve/tools";
import { z } from "zod";
import { bindFrom, channelPlatform, type SurfaceBinding, type BindableContext } from "../identity/binding.js";
import { principalIdOf } from "../access/request.js";
import { domainForChannel } from "../memory/domain.js";
import { getConfig } from "../access/config.js";
import { requestApproval, postedToSurfaceKey } from "../approvals/flow.js";
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
  if (binding.platform !== "slack") {
    throw new Error(`clear_connector_override is Slack-only for now (this surface is "${binding.platform}") — the approval card renders as a Slack message with Approve/Reject buttons.`);
  }
  if (!binding.principalId) {
    throw new Error("clear_connector_override needs a verified sender on this turn — no principal id resolved, so there's no requester to show on the approval card.");
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
    "PROPOSE reverting an earlier break-glass connector revoke, restoring this surface's config-as-code bundle grants for that connector — this does NOT clear anything itself. Posts a confirmation card; an org admin, or a domain admin whose domain covers this scope, must click Approve (this widens access back to config, so the admin click is the gate). Use to undo revoke_connector once the incident is resolved. The posted card IS the reply to the user — do not add any narration, summary, or confirmation text after this call; the channel already sees everything the card says.",
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
    expiresAt: z.string(),
    note: z.string(),
  }),
  async execute(input, ctx) {
    const binding = bindFrom(ctx);
    const scopeKey = input.scopeKey?.trim() || `${binding.platform}/${binding.workspace}/${binding.domainSurface ?? binding.surface}`;
    const domain = domainForChannel(scopeKey, getConfig().loadDomains())?.name ?? null;
    const plan = planClearConnectorOverride(binding, input, domain);

    const channelId = typeof binding.target?.channelId === "string" ? binding.target.channelId : undefined;
    if (!channelId) {
      throw new Error("clear_connector_override couldn't resolve this Slack channel's id — try again from a real channel or DM, not a synthetic context.");
    }

    const posted = await requestApproval({
      org: plan.args.org,
      kind: plan.kind,
      args: plan.args,
      scopeKey: plan.scopeKey,
      domain: plan.domain,
      requestedBy: principalIdOf(ctx)!,
      channelId,
      threadTs: binding.threadTs ?? null,
      postedTo: postedToSurfaceKey(binding, channelId),
    });

    return {
      requested: true,
      pendingId: posted.id,
      expiresAt: posted.expiresAt,
      note: `card posted — clear override for "${plan.args.connector}" on "${plan.args.scopeKey}" (pending ${posted.id}).`,
    };
  },
});
preRegisterDynamicEntry("clear_connector_override", "_single", clearConnectorOverrideEntry);

export default defineDynamic({
  events: {
    "session.started": (_event, ctx) => {
      if (channelPlatform(ctx as BindableContext) !== "slack") return null;
      return clearConnectorOverrideEntry;
    },
  },
});
