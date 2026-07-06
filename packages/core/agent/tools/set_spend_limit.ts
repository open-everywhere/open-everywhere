import { defineTool } from "eve/tools";
import { never } from "eve/tools/approval";
import { z } from "zod";
import { bindFrom, type SurfaceBinding } from "../identity/binding.js";
import { principalIdOf } from "../access/request.js";
import { domainForChannel } from "../memory/domain.js";
import { getConfig } from "../access/config.js";
import { effectiveCaps } from "../spend/caps.js";
import { requestApproval, type RequestApprovalDeps } from "../approvals/flow.js";
import { postDiscordApprovalCard } from "../approvals/discord-flow.js";

const LEVELS = ["surface", "workspace"] as const;
type Level = (typeof LEVELS)[number];

export function approvalPostDeps(platform: string): RequestApprovalDeps {
  return platform === "discord" ? { postCard: postDiscordApprovalCard } : {};
}

export function hasApprovalCardPath(platform: string): boolean {
  return platform === "slack" || platform === "discord";
}

export interface SetSpendLimitInput {
  readonly monthlyTokens?: number;
  readonly monthlyUsd?: number;
  readonly reason: string;
  readonly level?: Level;
  readonly scopeKey?: string;
}

export interface CurrentCaps {
  readonly tokens: number | null;
  readonly usd: number | null;
}

export interface SpendSetPlan {
  readonly kind: "spend.set";
  readonly args: {
    readonly org: string;
    readonly scopeKey: string;
    readonly level: Level;
    readonly monthlyTokens?: number;
    readonly monthlyUsd?: number;
    readonly reason: string;
    readonly currentCap: number | null;
    readonly currentUsd: number | null;
  };
  readonly scopeKey: string;
  readonly domain: string | null;
}

export function defaultScopeKey(binding: SurfaceBinding, level: Level): string {
  const workspaceKey = `${binding.platform}/${binding.workspace}`;
  return level === "workspace" ? workspaceKey : `${workspaceKey}/${binding.surface}`;
}

export function planSetSpendLimit(binding: SurfaceBinding, input: SetSpendLimitInput, current: CurrentCaps, domain: string | null): SpendSetPlan {
  if (!hasApprovalCardPath(binding.platform)) {
    throw new Error(`set_spend_limit needs a surface with an approval-card path — Slack or Discord for now (this surface is "${binding.platform}") — the approval card renders as a message with Approve/Reject buttons.`);
  }
  if (!binding.principalId) {
    throw new Error("set_spend_limit needs a verified sender on this turn — no principal id resolved, so there's no requester to show on the approval card.");
  }
  if (input.monthlyTokens == null && input.monthlyUsd == null) {
    throw new Error("set_spend_limit needs monthlyTokens and/or monthlyUsd — a proposal must set at least one cap component.");
  }
  const level = input.level ?? "surface";
  const scopeKey = input.scopeKey?.trim() || defaultScopeKey(binding, level);
  const reason = input.reason.trim();
  if (!reason) {
    throw new Error("set_spend_limit needs a non-empty reason — it's shown on the approval card.");
  }
  return {
    kind: "spend.set",
    args: {
      org: binding.org,
      scopeKey,
      level,
      ...(input.monthlyTokens != null ? { monthlyTokens: input.monthlyTokens } : {}),
      ...(input.monthlyUsd != null ? { monthlyUsd: input.monthlyUsd } : {}),
      reason,
      currentCap: current.tokens,
      currentUsd: current.usd,
    },
    scopeKey,
    domain,
  };
}

export default defineTool({
  description:
    'PROPOSE a monthly spend limit — token count and/or USD — for this surface (or, with level:"workspace", the whole workspace: the Slack workspace / Discord server) — this does NOT change the cap. It posts a confirmation card in this channel showing the current cap and the proposed one; an org admin, or a domain admin whose domain covers this scope, must click Approve before it takes effect. At least one of monthlyTokens/monthlyUsd is required. Config-as-code (the spend budgets registry, reviewed by PR) is still the permanent way to set budgets — this is the fast runtime bridge for a one-off change an admin can approve on the spot. The posted card IS the reply to the user — do not add any narration, summary, or confirmation text after this call; the channel already sees everything the card says.',
  inputSchema: z.object({
    monthlyTokens: z.number().int().positive().optional().describe("Proposed monthly token budget. At least one of monthlyTokens/monthlyUsd is required."),
    monthlyUsd: z.number().positive().optional().describe("Proposed monthly USD budget (estimated $, enforced against per-row priced usage). At least one of monthlyTokens/monthlyUsd is required."),
    reason: z.string().min(1).describe("Why you're proposing this — shown on the approval card."),
    level: z.enum(LEVELS).optional().describe('"surface" (default — this channel/DM only) or "workspace" (the whole Slack workspace / Discord server).'),
    scopeKey: z
      .string()
      .optional()
      .describe('Override the scope key, e.g. "slack/T123/C456" or "discord/G123/C456" for a surface, "slack/T123" for a workspace. Defaults to this surface\'s own scope.'),
  }),
  outputSchema: z.object({
    requested: z.boolean(),
    pendingId: z.string(),
    expiresAt: z.string(),
    note: z.string(),
  }),
  approval: never(),
  async execute(input, ctx) {
    const binding = bindFrom(ctx);
    const level = input.level ?? "surface";
    const scopeKey = input.scopeKey?.trim() || defaultScopeKey(binding, level);
    const domain = domainForChannel(scopeKey, getConfig().loadDomains())?.name ?? null;
    const workspaceKey = `${binding.platform}/${binding.workspace}`;
    const caps = await effectiveCaps(binding.org, workspaceKey, level === "surface" ? scopeKey : workspaceKey);
    const current: CurrentCaps = {
      tokens: (level === "workspace" ? caps.workspaceMonthlyTokens : caps.surfaceMonthlyTokens) ?? null,
      usd: (level === "workspace" ? caps.workspaceMonthlyUsd : caps.surfaceMonthlyUsd) ?? null,
    };

    const plan = planSetSpendLimit(binding, input, current, domain);

    const channelId = typeof binding.target?.channelId === "string" ? binding.target.channelId : undefined;
    if (!channelId) {
      throw new Error("set_spend_limit couldn't resolve this channel's id — try again from a real channel or DM, not a synthetic context.");
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
      },
      approvalPostDeps(binding.platform),
    );

    const proposed = [
      ...(plan.args.monthlyTokens != null ? [`${plan.args.monthlyTokens.toLocaleString()} tokens/month (current: ${plan.args.currentCap === null ? "uncapped" : plan.args.currentCap.toLocaleString()})`] : []),
      ...(plan.args.monthlyUsd != null ? [`$${plan.args.monthlyUsd.toFixed(2)}/month (current: ${plan.args.currentUsd === null ? "uncapped" : `$${plan.args.currentUsd.toFixed(2)}`})`] : []),
    ].join(" + ");
    return {
      requested: true,
      pendingId: posted.id,
      expiresAt: posted.expiresAt,
      note: `card posted — ${plan.args.level} limit ${proposed} on "${plan.args.scopeKey}" (pending ${posted.id}).`,
    };
  },
});
