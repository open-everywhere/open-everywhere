import { defineTool } from "eve/tools";
import { z } from "zod";
import { actingPrincipalId, bindFrom, type SurfaceBinding } from "../identity/binding.js";
import { principalIdOf, unattendedOf } from "../access/request.js";
import { domainForChannel } from "../memory/domain.js";
import { resolvePartition } from "../memory/partition.js";
import { getConfig } from "../access/config.js";
import { defaultScopeKey, assertScopableFromHere, assertScopeKeyShapeForLevel, approvalPostDeps, capsAfterClearFor, currentCapsFor, pendingScopeWords, type CurrentCaps } from "./set_spend_limit.js";
import { CAP_LEVELS, type CapLevel } from "../operational/store.js";
import { requestApproval, autoApprovedNote } from "../approvals/flow.js";
import { checkApprovalVenue, describeVenueRefusal, cardPostedPrefix, cardPostedTail } from "../approvals/card-venue.js";
import { friendlyScopeLabel } from "../approvals/scope-label.js";
import { sessionMountedTool } from "../access/window-gated.js";
import { placeBesideKey } from "../channels/friendly-ids.js";
import { placeWords } from "../channels/friendly-ids.js";

const LEVELS = CAP_LEVELS;
type Level = CapLevel;

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

export function planClearSpendLimit(binding: SurfaceBinding, input: ClearSpendLimitInput, current: CurrentCaps, domain: string | null, after?: CurrentCaps): SpendClearPlan {
  // principal-gate: presence — the sharper half of the pair. A clear does not merely move a cap, it
  if (!actingPrincipalId(binding)) {
    throw new Error("clear_spend_limit needs a verified sender on this turn — a triggered routine fire has no acting sender (only the creator it is attributed to), and a fire may not propose removing a spend override in that person's name. Ask a person in this conversation to propose it.");
  }
  const level = input.level ?? "surface";
  assertScopableFromHere("clear_spend_limit", binding, level, input.scopeKey);
  const scopeKey = input.scopeKey?.trim() || defaultScopeKey(binding, level);
  assertScopeKeyShapeForLevel("clear_spend_limit", level, scopeKey);
  return {
    kind: "spend.clear",
    args: { org: binding.org, scopeKey, level, currentCap: current.tokens, currentUsd: current.usd, ...(after ? { afterCap: after.tokens, afterUsd: after.usd } : {}) },
    scopeKey,
    domain,
  };
}

const clearSpendLimitEntry = defineTool({
  description:
    'PROPOSE clearing a spend-limit override so the scope reverts to the config-as-code cap — this does NOT clear anything itself. Posts a confirmation card (current override -> reverts to config). Approval standing: an org admin can always decide; a domain admin whose domain covers this scope can too for "surface"/"workspace" — but clearing a DOMAIN-LEVEL or USER-LEVEL override needs an ORG ADMIN specifically (domain admins cannot approve changes to their own domain\'s budget, and a per-person allowance is a change about somebody who is not in the room the card lands in). level defaults to "surface" (this channel/DM); pass level:"workspace" to clear a workspace-wide override, level:"domain" to clear this channel\'s memory-domain override, or level:"user" to clear ONE PERSON\'s allowance override (defaults to the person who just spoke; pass "user:<platform>/<id>" for somebody else). DM turns are spend-capped like any other surface, so from a DM the default level:"surface" clears THIS DM\'s own override and is accepted; level:"domain" needs an explicit scopeKey there (a DM\'s default domain spans every DM), and so does level:"workspace" on Discord (a Discord DM belongs to no server). The posted card IS the reply to the user — do not add any narration, summary, or confirmation text after this call; the channel already sees everything the card says. EXCEPT when this surface can\'t host a card: it then goes to a card-capable channel in the same domain, the `note` field names it, and you MUST relay that.',
  inputSchema: z.object({
    level: z
      .enum(LEVELS)
      .optional()
      .describe(
        '"surface" (default — this channel/DM only), "workspace" (the whole Slack workspace / Discord server), "domain" (this channel\'s memory domain — ORG ADMIN approval only), or "user" (ONE PERSON\'s allowance override — ORG ADMIN approval only).',
      ),
    scopeKey: z
      .string()
      .optional()
      .describe(
        'Override the scope key, e.g. "slack/T123/C456" or "discord/G123/C456" for a surface, "slack/T123" for a workspace, a domain\'s own name for level:"domain", or "user:slack/U123" for level:"user". Defaults to this surface\'s own scope — or, for level:"user", to the person who just spoke.',
      ),
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
    const level = input.level ?? "surface";
    const scopeKey = input.scopeKey?.trim() || defaultScopeKey(binding, level);
    const domain = level === "user" ? null : level === "domain" ? scopeKey : (domainForChannel(scopeKey, getConfig().loadDomains())?.name ?? null);
    const workspaceKey = `${binding.platform}/${binding.workspace}`;
    const current: CurrentCaps = await currentCapsFor(binding.org, workspaceKey, level, scopeKey, binding.mode, binding.trust);
    const after: CurrentCaps = await capsAfterClearFor(binding.org, workspaceKey, level, scopeKey, binding.mode, binding.trust);

    const plan = planClearSpendLimit(binding, input, current, domain, after);

    const venueResult = await checkApprovalVenue(binding, resolvePartition(ctx), () => getConfig().loadDomains());
    if ("refusal" in venueResult) {
      throw new Error(describeVenueRefusal(venueResult.refusal, binding.platform, "clear that spend override"));
    }
    const venue = venueResult.venue;

    const scopeLabel = await friendlyScopeLabel(plan.scopeKey);

    const posted = await requestApproval(
      {
        org: plan.args.org,
        kind: plan.kind,
        args: { ...plan.args, ...(scopeLabel ? { scopeLabel } : {}) },
        scopeKey: plan.scopeKey,
        domain: plan.domain,
        requestedBy: principalIdOf(ctx)!,
        channelId: venue.channelId,
        threadTs: venue.sameRoom ? binding.threadTs ?? null : null,
        postedTo: venue.surfaceKey,
        chain: { unattended: unattendedOf(ctx) },
      },
      approvalPostDeps(venue.platform, ctx),
    );

    if (posted.deduped) {
      return {
        requested: false,
        pendingId: posted.id,
        expiresAt: posted.expiresAt,
        note:
          `Already pending — an identical clear of the ${plan.args.level} override on ${pendingScopeWords(scopeLabel)} is awaiting an admin's Approve/Reject. ` +
          `No new card was posted; tell the user in plain words that the existing card${venue.sameRoom ? "" : ` in ${placeWords({ key: venue.surfaceKey })}`} still needs an admin to tap Approve or Reject.` +
          (venue.sameRoom ? "" : " Name that channel — the card is not in this conversation, so the user cannot see it from here."),
      };
    }
    const subject = `clear ${plan.args.level} override on ${placeBesideKey(plan.args.scopeKey)}`;
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
      note: `${cardPostedPrefix(venue)} — ${subject} (pending ${posted.id}).` + cardPostedTail(venue, "approve it", posted),
    };
  },
});

export default sessionMountedTool("clear_spend_limit", clearSpendLimitEntry);
