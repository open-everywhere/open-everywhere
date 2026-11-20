import { defineHook } from "eve/hooks";
import { domainKeyOf, resolvePartition } from "../memory/partition.js";
import { bareTokenFromEveContext, isWorkWindowToken } from "../channels/window-key.js";
import { isSubagentChildContext, type BindableContext } from "../identity/binding.js";
import { budgetSessionLimitPark, handleSessionLimitPark, type SessionLimitPark } from "../channels/session-park.js";
import { generationOwedTaskIds } from "../channels/generation-retirement.js";
import { markWorkSessionDead, requestIdOfWorkSessionLedgerId, retireFailedWorkSession } from "../channels/work-generation.js";
import { notifyLostWorkRequests } from "../channels/work-loss.js";
import { getSettings } from "../settings/settings.js";
import { optional } from "./control-refusal.js";
import { usage, type InteractionOpenedData, type SessionView } from "eve/events";

function configuredSessionBudget(): number | undefined {
  try {
    return getSettings().agent.sessionInputTokenBudget;
  } catch {
    return undefined;
  }
}

export function sessionUsageTotalOf(view: unknown): unknown {
  try {
    return usage(view as SessionView).total;
  } catch {
    return undefined;
  }
}

export function sessionLimitParkOf(data: InteractionOpenedData, sessionUsage: unknown): SessionLimitPark | undefined {
  return budgetSessionLimitPark({
    interactionId: data.interactionId,
    requestKind: data.request.kind,
    relayed: data.origin !== undefined,
    budget: configuredSessionBudget(),
    sessionUsage,
  });
}

export default defineHook({
  events: {
    "session.ended": optional("session-park", async (event, ctx) => {
      if (event.data.outcome !== "failed") return;
      try {
        const token = bareTokenFromEveContext(ctx.channel?.continuationToken);
        if (token === undefined || !isWorkWindowToken(token)) return;
        if (isSubagentChildContext(ctx as unknown as BindableContext)) return;
        const p = resolvePartition(ctx);
        const code = event.data.error?.code;
        const out = await retireFailedWorkSession({ org: p.org, token, ...(typeof code === "string" ? { code } : {}) });
        if (out.lostRequestIds.length > 0) await notifyLostWorkRequests({ org: p.org, requestIds: out.lostRequestIds, reason: "work-session failed", workToken: token });
        console.warn(`[open-everywhere:session-park] work session FAILED and was ${out.retired ? "retired" : "already rotated"} (token=${JSON.stringify(token)} lost=${out.lostRequestIds.length})`);
      } catch (err) {
        console.warn(`[open-everywhere:session-park] failed-work-session handling skipped: ${String(err)}`);
      }
    }),
    "interaction.opened": optional("session-park", async (event, ctx) => {
      try {
        const park = sessionLimitParkOf(event.data, sessionUsageTotalOf(ctx.view));
        if (!park) return;
        const p = resolvePartition(ctx);
        const token = bareTokenFromEveContext(ctx.channel?.continuationToken) ?? ctx.channel?.continuationToken;
        const sessionId = typeof ctx.session?.id === "string" && ctx.session.id.length > 0 ? ctx.session.id : undefined;
        const outcome = await handleSessionLimitPark(
          {
            org: p.org,
            platform: p.platform,
            workspace: p.workspace,
            surface: p.surface,
            domainKey: domainKeyOf(p),
            token,
            ...(sessionId !== undefined ? { sessionId } : {}),
          },
          park,
        );
        if (outcome.tier === "work" && typeof token === "string") {
          await markWorkSessionDead(p.org, token, "parked");
          const owed = await generationOwedTaskIds(p.org, token);
          const lost = owed.map(requestIdOfWorkSessionLedgerId).filter((id): id is string => id !== undefined);
          if (lost.length > 0) await notifyLostWorkRequests({ org: p.org, requestIds: lost, reason: "work-session parked at its session limit", workToken: token });
        }
        console.warn(
          `[open-everywhere:session-park] session hit eve's ${
            park.kind === "token-cost"
              ? `model token-COST bound${park.limitUsd !== undefined ? ` ($${park.limitUsd})` : ""}`
              : `${park.kind}-token bound${park.limit !== undefined ? ` (${park.limit})` : ""}`
          } and PARKED ` +
            `(org=${p.org} surface=${p.surfaceKey} token=${JSON.stringify(token)} remedy=${outcome.remedy} tier=${outcome.tier}` +
            `${outcome.registryKey ? ` key=${outcome.registryKey}` : ""}${outcome.audited ? "" : " audit=throttled"})`,
        );
      } catch (err) {
        console.warn(`[open-everywhere:session-park] park handling skipped: ${String(err)}`);
      }
    }),
  },
});
