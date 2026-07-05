import { defineTool } from "eve/tools";
import { never } from "eve/tools/approval";
import { z } from "zod";
import { bindFrom, type SurfaceBinding } from "../identity/binding.js";
import { principalIdOf } from "../access/request.js";
import { domainForChannel } from "../memory/domain.js";
import { getConfig } from "../access/config.js";
import { effectiveCaps } from "../spend/caps.js";
import { requestApproval } from "../approvals/flow.js";

const LEVELS = ["surface", "workspace"] as const;
type Level = (typeof LEVELS)[number];

export interface SetSpendLimitInput {
  readonly monthlyTokens: number;
  readonly reason: string;
  readonly level?: Level;
  readonly scopeKey?: string;
}

export interface SpendSetPlan {
  readonly kind: "spend.set";
  readonly args: {
    readonly org: string;
    readonly scopeKey: string;
    readonly level: Level;
    readonly monthlyTokens: number;
    readonly reason: string;
    readonly currentCap: number | null;
  };
  readonly scopeKey: string;
  readonly domain: string | null;
}

export function defaultScopeKey(binding: SurfaceBinding, level: Level): string {
  const workspaceKey = `${binding.platform}/${binding.workspace}`;
  return level === "workspace" ? workspaceKey : `${workspaceKey}/${binding.surface}`;
}

export function planSetSpendLimit(binding: SurfaceBinding, input: SetSpendLimitInput, currentCap: number | null, domain: string | null): SpendSetPlan {
  if (binding.platform !== "slack") {
    throw new Error(`set_spend_limit is Slack-only for now (this surface is "${binding.platform}") — the approval card renders as a Slack message with Approve/Reject buttons.`);
  }
  if (!binding.principalId) {
    throw new Error("set_spend_limit needs a verified sender on this turn — no principal id resolved, so there's no requester to show on the approval card.");
  }
  const level = input.level ?? "surface";
  const scopeKey = input.scopeKey?.trim() || defaultScopeKey(binding, level);
  const reason = input.reason.trim();
  if (!reason) {
    throw new Error("set_spend_limit needs a non-empty reason — it's shown on the approval card.");
  }
  return {
    kind: "spend.set",
    args: { org: binding.org, scopeKey, level, monthlyTokens: input.monthlyTokens, reason, currentCap },
    scopeKey,
    domain,
  };
}

export default defineTool({
  description:
    'PROPOSE a monthly token spend limit for this surface (or, with level:"workspace", the whole Slack workspace) — this does NOT change the cap. It posts a confirmation card in this channel showing the current cap and the proposed one; an org admin, or a domain admin whose domain covers this scope, must click Approve before it takes effect. Config-as-code (caps.ts, reviewed by PR) is still the permanent way to set budgets — this is the fast runtime bridge for a one-off change an admin can approve on the spot. Tell the user plainly that a card was posted and nothing has changed yet; don\'t say the limit is set.',
  inputSchema: z.object({
    monthlyTokens: z.number().int().positive().describe("Proposed monthly token budget."),
    reason: z.string().min(1).describe("Why you're proposing this — shown on the approval card."),
    level: z.enum(LEVELS).optional().describe('"surface" (default — this channel/DM only) or "workspace" (the whole Slack workspace).'),
    scopeKey: z
      .string()
      .optional()
      .describe('Override the scope key, e.g. "slack/T123/C456" for a surface or "slack/T123" for a workspace. Defaults to this surface\'s own scope.'),
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
    const currentCap = (level === "workspace" ? caps.workspaceMonthlyTokens : caps.surfaceMonthlyTokens) ?? null;

    const plan = planSetSpendLimit(binding, input, currentCap, domain);

    const channelId = typeof binding.target?.channelId === "string" ? binding.target.channelId : undefined;
    if (!channelId) {
      throw new Error("set_spend_limit couldn't resolve this Slack channel's id — try again from a real channel or DM, not a synthetic context.");
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
    });

    return {
      requested: true,
      pendingId: posted.id,
      expiresAt: posted.expiresAt,
      note: `Posted a confirmation card for a ${plan.args.level} spend limit of ${plan.args.monthlyTokens.toLocaleString()} tokens/month on "${plan.args.scopeKey}" (current cap: ${plan.args.currentCap === null ? "uncapped" : plan.args.currentCap.toLocaleString()}). Nothing has changed yet — an org or domain admin needs to click Approve on the card (expires ${posted.expiresAt}).`,
    };
  },
});
