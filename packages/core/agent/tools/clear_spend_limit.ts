import { defineDynamic, defineTool } from "eve/tools";
import { z } from "zod";
import { bindFrom, channelPlatform, type SurfaceBinding, type BindableContext } from "../identity/binding.js";
import { principalIdOf } from "../access/request.js";
import { domainForChannel } from "../memory/domain.js";
import { getConfig } from "../access/config.js";
import { effectiveCaps, domainNameForScope } from "../spend/caps.js";
import { defaultScopeKey, assertScopableFromHere, approvalPostDeps, hasApprovalCardPath, type CurrentCaps } from "./set_spend_limit.js";
import { requestApproval, postedToSurfaceKey } from "../approvals/flow.js";
import { friendlyScopeLabel } from "../approvals/scope-label.js";
import { preRegisterDynamicEntry } from "../access/window-gated.js";

const LEVELS = ["surface", "workspace", "domain"] as const;
type Level = (typeof LEVELS)[number];

export interface ClearSpendLimitInput {
  readonly level?: Level;
  readonly scopeKey?: string;
}

export interface SpendClearPlan {
  readonly kind: "spend.clear";
  readonly args: {
    readonly org: string;
    readonly scopeKey: string;
    readonly level: Level;
    readonly currentCap: number | null;
    readonly currentUsd: number | null;
  };
  readonly scopeKey: string;
  readonly domain: string | null;
}

export function planClearSpendLimit(binding: SurfaceBinding, input: ClearSpendLimitInput, current: CurrentCaps, domain: string | null): SpendClearPlan {
  if (!hasApprovalCardPath(binding.platform)) {
    throw new Error(`clear_spend_limit needs a surface with an approval-card path — Slack or Discord for now (this surface is "${binding.platform}") — the approval card renders as a message with Approve/Reject buttons.`);
  }
  if (!binding.principalId) {
    throw new Error("clear_spend_limit needs a verified sender on this turn — no principal id resolved, so there's no requester to show on the approval card.");
  }
  const level = input.level ?? "surface";
  assertScopableFromHere("clear_spend_limit", binding, level, input.scopeKey);
  const scopeKey = input.scopeKey?.trim() || defaultScopeKey(binding, level);
  return {
    kind: "spend.clear",
    args: { org: binding.org, scopeKey, level, currentCap: current.tokens, currentUsd: current.usd },
    scopeKey,
    domain,
  };
}

const clearSpendLimitEntry = defineTool({
  description:
    'PROPOSE clearing a spend-limit override so the scope reverts to the config-as-code cap — this does NOT clear anything itself. Posts a confirmation card (current override -> reverts to config). Approval standing: an org admin can always decide; a domain admin whose domain covers this scope can too for "surface"/"workspace" — but clearing a DOMAIN-LEVEL override needs an ORG ADMIN specifically (domain admins cannot approve changes to their own domain\'s budget). level defaults to "surface" (this channel/DM); pass level:"workspace" to clear a workspace-wide override, or level:"domain" to clear this channel\'s memory-domain override. From a DM you MUST pass scopeKey explicitly (DM usage is uncapped, a Discord DM belongs to no server, and a DM\'s default domain would span every DM like it — the defaults would target the wrong scope). The posted card IS the reply to the user — do not add any narration, summary, or confirmation text after this call; the channel already sees everything the card says.',
  inputSchema: z.object({
    level: z
      .enum(LEVELS)
      .optional()
      .describe('"surface" (default — this channel/DM only), "workspace" (the whole Slack workspace / Discord server), or "domain" (this channel\'s memory domain — ORG ADMIN approval only).'),
    scopeKey: z
      .string()
      .optional()
      .describe('Override the scope key, e.g. "slack/T123/C456" or "discord/G123/C456" for a surface, "slack/T123" for a workspace, or a domain\'s own name for level:"domain". Defaults to this surface\'s own scope.'),
  }),
  outputSchema: z.object({
    requested: z.boolean(),
    pendingId: z.string(),
    expiresAt: z.string(),
    note: z.string(),
  }),
  async execute(input, ctx) {
    const binding = bindFrom(ctx);
    const level = input.level ?? "surface";
    const scopeKey = input.scopeKey?.trim() || defaultScopeKey(binding, level);
    const domain = level === "domain" ? scopeKey : (domainForChannel(scopeKey, getConfig().loadDomains())?.name ?? null);
    const workspaceKey = `${binding.platform}/${binding.workspace}`;
    const capsSurfaceArg = level === "workspace" ? workspaceKey : scopeKey;
    const capsDomainArg = level === "domain" ? scopeKey : domainNameForScope(scopeKey, binding.mode, binding.trust);
    const caps = await effectiveCaps(binding.org, workspaceKey, capsSurfaceArg, capsDomainArg);
    const current: CurrentCaps = {
      tokens: (level === "workspace" ? caps.workspaceMonthlyTokens : caps.surfaceMonthlyTokens) ?? null,
      usd: (level === "workspace" ? caps.workspaceMonthlyUsd : caps.surfaceMonthlyUsd) ?? null,
    };

    const plan = planClearSpendLimit(binding, input, current, domain);

    const channelId = typeof binding.target?.channelId === "string" ? binding.target.channelId : undefined;
    if (!channelId) {
      throw new Error("clear_spend_limit couldn't resolve this channel's id — try again from a real channel or DM, not a synthetic context.");
    }

    const scopeLabel = await friendlyScopeLabel(plan.scopeKey);

    const posted = await requestApproval(
      {
        org: plan.args.org,
        kind: plan.kind,
        args: { ...plan.args, ...(scopeLabel ? { scopeLabel } : {}) },
        scopeKey: plan.scopeKey,
        domain: plan.domain,
        requestedBy: principalIdOf(ctx)!,
        channelId,
        threadTs: binding.threadTs ?? null,
        postedTo: postedToSurfaceKey(binding, channelId),
      },
      approvalPostDeps(binding.platform),
    );

    if (posted.deduped) {
      return {
        requested: false,
        pendingId: posted.id,
        expiresAt: posted.expiresAt,
        note: `Already pending — an identical clear of the ${plan.args.level} override on "${plan.args.scopeKey}" is awaiting an admin's Approve/Reject (pending ${posted.id}). No new card was posted; tell the user the existing card still needs an admin to tap Approve or Reject.`,
      };
    }
    return {
      requested: true,
      pendingId: posted.id,
      expiresAt: posted.expiresAt,
      note: `card posted — clear ${plan.args.level} override on "${plan.args.scopeKey}" (pending ${posted.id}).`,
    };
  },
});
preRegisterDynamicEntry("clear_spend_limit", "_single", clearSpendLimitEntry);

export default defineDynamic({
  events: {
    "session.started": (_event, ctx) => {
      if (!hasApprovalCardPath(channelPlatform(ctx as BindableContext) ?? "")) return null;
      return clearSpendLimitEntry;
    },
  },
});
