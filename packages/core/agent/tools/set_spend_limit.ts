import { defineTool } from "eve/tools";
import { never } from "eve/tools/approval";
import { z } from "zod";
import { actingPrincipalId, bindFrom, type SurfaceBinding } from "../identity/binding.js";
import { principalIdOf } from "../access/request.js";
import { untrustedIngestedThisTurn } from "../access/taint-signal.js";
import { domainForChannel } from "../memory/domain.js";
import { getConfig } from "../access/config.js";
import { effectiveCaps, domainNameForScope } from "../spend/caps.js";
import { requestApproval, postedToSurfaceKey, autoApprovedNote, cardPosterFor, type RequestApprovalDeps } from "../approvals/flow.js";
import { friendlyScopeLabel } from "../approvals/scope-label.js";

const LEVELS = ["surface", "workspace", "domain"] as const;
type Level = (typeof LEVELS)[number];

export function approvalPostDeps(platform: string): RequestApprovalDeps {
  const poster = cardPosterFor(platform);
  return poster ? { postCard: poster } : {};
}

export function hasApprovalCardPath(platform: string): boolean {
  return platform === "slack" || cardPosterFor(platform) !== undefined;
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
  if (level === "workspace") return workspaceKey;
  const surfaceKey = `${workspaceKey}/${binding.domainSurface ?? binding.surface}`;
  if (level === "surface") return surfaceKey;
  const domainName = domainNameForScope(surfaceKey, binding.mode, binding.trust);
  if (!domainName) {
    throw new Error(
      `defaultScopeKey: level:"domain" has no default here — this channel isn't an explicit member of any domain, and doesn't classify into a dm/public criteria domain either. Pass scopeKey explicitly (the domain's name).`,
    );
  }
  return domainName;
}

export function assertScopableFromHere(tool: string, binding: SurfaceBinding, level: Level, explicitScopeKey: string | undefined): void {
  if (explicitScopeKey?.trim() || binding.mode === "channel") return;
  if (level === "domain") {
    throw new Error(
      `${tool}: this is a DM, so a domain-level cap defaulted from here would land on the dm/public CRITERIA domain — which spans every DM in the deployment, not just this conversation. That caps everyone. Say scopeKey explicitly (the domain's name) if you mean it, or use level:"surface" to cap just this DM.`,
    );
  }
  if (level === "workspace" && binding.platform === "discord") {
    throw new Error(
      `${tool}: a Discord DM belongs to no server, so level:"workspace" here would target your personal DM bucket ("discord/${binding.workspace}"), not a server. Pass scopeKey "discord/<serverId>" for the server you mean — the ⛔ decline message in an over-budget channel shows it, or ask again from a channel in that server.`,
    );
  }
}

export function planSetSpendLimit(binding: SurfaceBinding, input: SetSpendLimitInput, current: CurrentCaps, domain: string | null): SpendSetPlan {
  if (!hasApprovalCardPath(binding.platform)) {
    throw new Error(`set_spend_limit needs a surface with an approval-card path — Slack or Discord for now (this surface is "${binding.platform}") — the approval card renders as a message with Approve/Reject buttons.`);
  }
  if (!actingPrincipalId(binding)) {
    throw new Error("set_spend_limit needs a verified sender on this turn — a triggered routine fire has no acting sender (only the creator it is attributed to), and a fire may not propose a spend-limit change in that person's name. Ask a person in this conversation to propose it.");
  }
  if (input.monthlyTokens == null && input.monthlyUsd == null) {
    throw new Error("set_spend_limit needs monthlyTokens and/or monthlyUsd — a proposal must set at least one cap component.");
  }
  const level = input.level ?? "surface";
  assertScopableFromHere("set_spend_limit", binding, level, input.scopeKey);
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
    'PROPOSE a monthly spend limit — token count and/or USD — for this surface (or, with level:"workspace", the whole workspace: the Slack workspace / Discord server; or, with level:"domain", every surface in this channel\'s memory domain) — this does NOT change the cap. It posts a confirmation card in this channel showing the current cap and the proposed one. Approval standing: an org admin can always decide; a domain admin whose domain covers this scope can too for "surface"/"workspace" — but a DOMAIN-LEVEL cap needs an ORG ADMIN specifically (domain admins cannot approve or raise their own domain\'s budget). At least one of monthlyTokens/monthlyUsd is required. DM turns are spend-capped like any other surface, so from a DM the default level:"surface" caps THIS DM and is accepted; level:"domain" needs an explicit scopeKey there (a DM\'s default domain spans every DM), and so does level:"workspace" on Discord (a Discord DM belongs to no server). An over-budget channel\'s decline message shows the exact keys. Config-as-code (the spend budgets registry, reviewed by PR) is still the permanent way to set budgets — this is the fast runtime bridge for a one-off change an admin can approve on the spot. The posted card IS the reply to the user — do not add any narration, summary, or confirmation text after this call; the channel already sees everything the card says.',
  inputSchema: z.object({
    monthlyTokens: z.number().int().positive().optional().describe("Proposed monthly token budget. At least one of monthlyTokens/monthlyUsd is required."),
    monthlyUsd: z.number().positive().optional().describe("Proposed monthly USD budget (estimated $, enforced against per-row priced usage). At least one of monthlyTokens/monthlyUsd is required."),
    reason: z.string().min(1).describe("Why you're proposing this — shown on the approval card."),
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
    expiresAt: z.string().optional().describe("Absent when the chain auto-approved: the row is already decided, so nothing expires."),
    note: z.string(),
    autoApproved: z.boolean().optional().describe("The approver chain lowered this verb: no card was posted and it has ALREADY run."),
  }),
  approval: never(),
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

    const plan = planSetSpendLimit(binding, input, current, domain);

    const channelId = typeof binding.target?.channelId === "string" ? binding.target.channelId : undefined;
    if (!channelId) {
      throw new Error("set_spend_limit couldn't resolve this channel's id — try again from a real channel or DM, not a synthetic context.");
    }

    const scopeLabel = await friendlyScopeLabel(plan.scopeKey);

    const tainted = untrustedIngestedThisTurn();

    const posted = await requestApproval(
      {
        org: plan.args.org,
        kind: plan.kind,
        args: { ...plan.args, ...(scopeLabel ? { scopeLabel } : {}), tainted },
        scopeKey: plan.scopeKey,
        domain: plan.domain,
        requestedBy: principalIdOf(ctx)!,
        channelId,
        threadTs: binding.threadTs ?? null,
        postedTo: postedToSurfaceKey(binding, channelId),
      },
      approvalPostDeps(binding.platform),
    );

    const proposed = [
      ...(plan.args.monthlyTokens != null ? [`${plan.args.monthlyTokens.toLocaleString()} tokens/month (current: ${plan.args.currentCap === null ? "uncapped" : plan.args.currentCap.toLocaleString()})`] : []),
      ...(plan.args.monthlyUsd != null ? [`$${plan.args.monthlyUsd.toFixed(2)}/month (current: ${plan.args.currentUsd === null ? "uncapped" : `$${plan.args.currentUsd.toFixed(2)}`})`] : []),
    ].join(" + ");
    if (posted.deduped) {
      return {
        requested: false,
        pendingId: posted.id,
        expiresAt: posted.expiresAt,
        note: `Already pending — an identical ${plan.args.level} limit ${proposed} on "${plan.args.scopeKey}" is awaiting an admin's Approve/Reject (pending ${posted.id}). No new card was posted; tell the user the existing card still needs an admin to tap Approve or Reject.`,
      };
    }
    const subject = `${plan.args.level} limit ${proposed} on "${plan.args.scopeKey}"${tainted ? " ⚠ tainted" : ""}`;
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
