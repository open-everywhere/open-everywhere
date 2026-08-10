import { defineHook, type HookContext } from "eve/hooks";
import { domainKeyOf, resolvePartition } from "../memory/partition.js";
import { recordSpend } from "../spend/store.js";
import { appendUsageEvent, GENERATION_ID_DETAIL_KEY } from "../spend/usage-events.js";
import { periodOf, UNKNOWN_MODEL, type Usage } from "../spend/spend.js";
import { bindFrom, type BindableContext } from "../identity/binding.js";
import { routineMarker } from "../routines/routine.js";
import { readModelStamp } from "../model/model-stamp.js";
import { getOperationalStore } from "../operational/provider.js";
import { isSupervisorToken, standingSeatRegistryKey, unifiedWindowFromToken } from "../channels/unified-supervisor.js";
import { parseDmSeatToken, dmSeatRegistryKey, bareTokenFromEveContext, parseSubagentToken } from "../channels/window-key.js";
import { delegationDepthOf, stampSubagentRun } from "../spend/subagent-runs.js";
import { isRunFireSeatWindowId } from "../routines/fire-window.js";

export function routineIdOf(ctx: BindableContext): string | undefined {
  try {
    const auth = ctx.session?.auth;
    return routineMarker(auth?.current?.attributes ?? auth?.initiator?.attributes)?.id;
  } catch {
    return undefined;
  }
}

export type DelegatableContext = BindableContext & {
  readonly session?: { readonly parent?: { readonly sessionId?: string; readonly callId?: string; readonly rootSessionId?: string } };
};

export function subagentParentOf(
  ctx: DelegatableContext,
  continuationToken?: unknown,
): { parentSessionId: string; callId: string; rootSessionId?: string } | undefined {
  try {
    const p = ctx.session?.parent;
    if (typeof p?.sessionId === "string" && p.sessionId.length > 0 && typeof p.callId === "string" && p.callId.length > 0) {
      return {
        parentSessionId: p.sessionId,
        callId: p.callId,
        ...(typeof p.rootSessionId === "string" && p.rootSessionId.length > 0 ? { rootSessionId: p.rootSessionId } : {}),
      };
    }
    const parsed = parseSubagentToken(continuationToken);
    return parsed ? { parentSessionId: parsed.parentSessionId, callId: parsed.callId } : undefined;
  } catch {
    return undefined;
  }
}

export function turnKind(ctx: DelegatableContext, continuationToken?: unknown): string {
  try {
    const auth = ctx.session?.auth;
    const attrs = auth?.current?.attributes ?? auth?.initiator?.attributes;
    if (routineMarker(attrs)) return "routine";
    if (isSupervisorToken(continuationToken)) return "supervisor";
    if (subagentParentOf(ctx, continuationToken)) return "subagent";
    return bindFrom(ctx).mode === "dm" ? "dm" : "channel";
  } catch {
    return "channel";
  }
}

export default defineHook({
  events: {
    "step.completed": async (event, ctx: HookContext) => {
      const usage = event.data?.usage as Usage | undefined;
      if (!usage || (usage.inputTokens == null && usage.outputTokens == null && usage.costUsd == null)) return;
      const p = resolvePartition(ctx);
      const token = bareTokenFromEveContext(ctx.channel?.continuationToken) ?? ctx.channel?.continuationToken;
      const routineId = routineIdOf(ctx);
      const delegatedFrom = subagentParentOf(ctx, token);
      const stampedModel = readModelStamp() ?? undefined;
      const model = stampedModel ?? UNKNOWN_MODEL;
      if (stampedModel === undefined) {
        console.warn(
          `[open-everywhere:spend] a token-bearing step carried NO model stamp — recording as model="${UNKNOWN_MODEL}" and SKIPPING rate-derived pricing ` +
            `(session=${ctx.session?.id ?? "?"} surface=${p.key} in=${usage.inputTokens ?? 0} out=${usage.outputTokens ?? 0}). ` +
            `Tokens and (where the gateway measured it) exact $ are still recorded; only the rate-derived $ is withheld, because nothing observed which model ran.`,
        );
      }

      const measuredUsd = typeof usage.costUsd === "number" && Number.isFinite(usage.costUsd) && usage.costUsd >= 0 ? usage.costUsd : undefined;

      const generationId = ((): string | undefined => {
        const raw = (event.data as { providerMetadata?: { gateway?: { generationId?: unknown } } } | undefined)?.providerMetadata?.gateway?.generationId;
        return typeof raw === "string" && raw.length > 0 ? raw : undefined;
      })();

      const delegationDepth = delegatedFrom ? delegationDepthOf(delegatedFrom.parentSessionId, delegatedFrom.rootSessionId) : 0;
      const rootSessionId = delegatedFrom?.rootSessionId ?? delegatedFrom?.parentSessionId ?? ctx.session.id;

      try {
        await recordSpend(p, {
          period: periodOf(new Date().toISOString()),
          usage,
          principalId: bindFrom(ctx).principalId,
          routineId,
          model,
          ...(measuredUsd !== undefined ? { measuredUsd } : {}),
        });
      } catch (err) {
        console.log(`[open-everywhere:spend] record skipped: ${String(err)}`);
      }

      try {
        await appendUsageEvent({
          org: p.org,
          surfaceKey: domainKeyOf(p),
          sessionId: delegatedFrom?.parentSessionId ?? ctx.session.id,
          principalId: bindFrom(ctx).principalId,
          kind: turnKind(ctx, token),
          ...((): { detail?: Readonly<Record<string, unknown>> } => {
            const detail = {
              ...(delegatedFrom
                ? stampSubagentRun({
                    callId: delegatedFrom.callId,
                    sessionId: ctx.session.id,
                    ...(delegatedFrom.rootSessionId !== undefined ? { rootSessionId: delegatedFrom.rootSessionId } : {}),
                    depth: delegationDepth,
                  })
                : {}),
              ...(generationId !== undefined ? { [GENERATION_ID_DETAIL_KEY]: generationId } : {}),
            };
            return Object.keys(detail).length > 0 ? { detail } : {};
          })(),
          ...(measuredUsd !== undefined ? { usdMicrosMeasured: Math.round(measuredUsd * 1_000_000), costSource: "measured" as const } : { costSource: "derived" as const }),
          delegationDepth,
          rootSessionId,
          ...(routineId !== undefined ? { routineId } : {}),
          model,
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          cacheReadTokens: usage.cacheReadTokens,
          cacheWriteTokens: usage.cacheWriteTokens,
        });
      } catch (err) {
        console.warn(`[open-everywhere:usage] event append skipped: ${String(err)}`);
      }

      if (isSupervisorToken(token)) {
        try {
          const delta = (usage.inputTokens ?? 0) + (usage.cacheReadTokens ?? 0);
          const registryKey = standingSeatRegistryKey(token, domainKeyOf(p)) ?? domainKeyOf(p);
          if (delta > 0) {
            const matched = await getOperationalStore().bumpChannelSessionUsage(p.org, registryKey, token, delta);
            const windowId = unifiedWindowFromToken(token);
            if (matched === 0 && !(windowId !== undefined && isRunFireSeatWindowId(windowId))) {
              console.warn(`[open-everywhere:spend] supervisor counter bump matched no row (org=${p.org} key=${registryKey} token=${token})`);
            }
          }
        } catch (err) {
          console.warn(`[open-everywhere:spend] supervisor token counter bump skipped: ${String(err)}`);
        }
      }

      const dmSeat = parseDmSeatToken(token);
      if (!dmSeat && !isSupervisorToken(token) && turnKind(ctx, token) === "dm") {
        console.warn(`[open-everywhere:spend] dm turn carried a token with no rotation lever (token=${JSON.stringify(token)}) — no seat counter bumped`);
      }
      if (dmSeat) {
        try {
          const delta = (usage.inputTokens ?? 0) + (usage.cacheReadTokens ?? 0);
          if (delta > 0) {
            const matched = await getOperationalStore().bumpChannelSessionUsage(p.org, dmSeatRegistryKey(dmSeat.channelId), token as string, delta);
            if (matched === 0) console.warn(`[open-everywhere:spend] dm-seat counter bump matched no row (org=${p.org} key=${dmSeatRegistryKey(dmSeat.channelId)} token=${token})`);
          }
        } catch (err) {
          console.warn(`[open-everywhere:spend] dm-seat token counter bump skipped: ${String(err)}`);
        }
      }
    },
  },
});
