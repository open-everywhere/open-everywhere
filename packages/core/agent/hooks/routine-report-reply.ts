import { defineHook, type HookContext } from "eve/hooks";
import {
  actingPrincipalId,
  authPrincipalType,
  bindFrom,
  currentSessionId,
  deploymentOrg,
  isUnifiedWindowContext,
  type BindableContext,
} from "../identity/binding.js";
import { resolveWakeTrustFromContext } from "../identity/wake-trust.js";
import { resolveReplyTarget } from "../channels/reply-post.js";
import { isThreadScopedWakeOrigin, unifiedThreadRef } from "../channels/unified-window.js";
import { outboundKey, postOnce } from "../operational/post-once.js";
import { checkInFromReportReply, MEMBER_TIERS, originOfReplyTarget, type ReportReplyOutcome } from "../routines/report-thread.js";
import { captureEligible } from "./requester-messages.js";
import { optional } from "./control-refusal.js";

const REPORT_REPLY_DEDUPE_TTL_MS = 24 * 60 * 60_000;

export function nativeReportReplier(ctx: BindableContext): string | undefined {
  if (isUnifiedWindowContext(ctx)) return undefined;
  if (!captureEligible(ctx as unknown as HookContext)) return undefined;
  const binding = bindFrom(ctx);
  const principalId = actingPrincipalId(binding);
  if (principalId === undefined || principalId.length === 0) return undefined;
  if (!(authPrincipalType(ctx)?.endsWith("-user") ?? false)) return undefined;
  const tier = resolveWakeTrustFromContext(ctx, { id: principalId, isBot: false });
  return MEMBER_TIERS.has(tier) ? principalId : undefined;
}

export async function checkInFromNativeTurn(ctx: BindableContext, turnId?: string, now?: () => number): Promise<ReportReplyOutcome | "not-a-member" | "no-origin" | "duplicate"> {
  try {
    const principalId = nativeReportReplier(ctx);
    if (principalId === undefined) return "not-a-member";
    const target = resolveReplyTarget(ctx);
    const origin = target !== null ? originOfReplyTarget(target) : undefined;
    if (origin === undefined) return "no-origin";
    if (!isThreadScopedWakeOrigin(origin)) return "not-a-thread";
    const org = deploymentOrg();
    const ref = unifiedThreadRef(origin);
    const run = (): Promise<ReportReplyOutcome> => checkInFromReportReply({ org, origin, principalId });
    if (turnId === undefined || turnId.length === 0) return await run();
    const stableId = `${currentSessionId(ctx) ?? ""}:${turnId}`;
    const key = outboundKey({ surface: origin.platform, channel: ref.channelKey, threadTs: ref.threadKey, action: "routine.checkin.reply", stableId, payload: principalId });
    return (
      (await postOnce<ReportReplyOutcome | "duplicate">({ org, key, run, skipped: () => "duplicate", ttlMs: REPORT_REPLY_DEDUPE_TTL_MS, ...(now !== undefined ? { now } : {}) })) ?? "duplicate"
    );
  } catch (err) {
    console.warn(`[open-everywhere:routine-report-reply] could not read a native reply: ${err instanceof Error ? err.message : String(err)}`);
    return "error";
  }
}

export default defineHook({
  events: {
    "delivery.consumed": optional("routine-report-reply", async (event, ctx) => {
      await checkInFromNativeTurn(ctx as unknown as BindableContext, event.data.turnId);
    }),
  },
});
