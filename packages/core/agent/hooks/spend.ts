import { defineHook, type HookContext } from "eve/hooks";
import { domainKeyOf, resolvePartition } from "../memory/partition.js";
import { recordUsage } from "../spend/store.js";
import { appendUsageEvent } from "../spend/usage-events.js";
import { periodOf, type Usage } from "../spend/spend.js";
import { bindFrom, type BindableContext } from "../identity/binding.js";
import { routineMarker } from "../routines/routine.js";
import { readModelStamp } from "../model/model-stamp.js";
import { getOperationalStore } from "../operational/provider.js";

function isSupervisorToken(token: unknown): token is string {
  return typeof token === "string" && token.includes(":oe-sup:g");
}

export function turnKind(ctx: BindableContext, continuationToken?: unknown): string {
  try {
    const auth = ctx.session?.auth;
    const attrs = auth?.current?.attributes ?? auth?.initiator?.attributes;
    if (routineMarker(attrs)) return "routine";
    if (isSupervisorToken(continuationToken)) return "supervisor";
    return bindFrom(ctx).mode === "dm" ? "dm" : "channel";
  } catch {
    return "channel";
  }
}

export default defineHook({
  events: {
    "step.completed": async (event, ctx: HookContext) => {
      const usage = event.data?.usage as Usage | undefined;
      if (!usage || (usage.inputTokens == null && usage.outputTokens == null)) return;
      const p = resolvePartition(ctx);

      try {
        await recordUsage(p, periodOf(new Date().toISOString()), usage);
      } catch (err) {
        console.log(`[open-everywhere:spend] record skipped: ${String(err)}`);
      }

      try {
        await appendUsageEvent({
          org: p.org,
          surfaceKey: domainKeyOf(p),
          sessionId: ctx.session.id,
          principalId: bindFrom(ctx).principalId,
          kind: turnKind(ctx, ctx.channel?.continuationToken),
          model: readModelStamp() ?? undefined,
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          cacheReadTokens: usage.cacheReadTokens,
          cacheWriteTokens: usage.cacheWriteTokens,
        });
      } catch (err) {
        console.warn(`[open-everywhere:usage] event append skipped: ${String(err)}`);
      }

      const token = ctx.channel?.continuationToken;
      if (isSupervisorToken(token)) {
        try {
          const delta = (usage.inputTokens ?? 0) + (usage.cacheReadTokens ?? 0);
          if (delta > 0) await getOperationalStore().bumpChannelSessionUsage(p.org, domainKeyOf(p), token, delta);
        } catch (err) {
          console.warn(`[open-everywhere:spend] supervisor token counter bump skipped: ${String(err)}`);
        }
      }
    },
  },
});
