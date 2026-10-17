import { defineHook, type HookContext } from "eve/hooks";
import { appendAudit } from "../audit/audit.js";
import { nonMemberAnsweredIds, QUESTION_REQUEST_KIND } from "../access/held-question.js";
import { markUntrustedIngestedThisTurn } from "../access/taint-signal.js";
import { auditSurfaceModeFrom, currentSessionId, currentTurnId, type BindableContext } from "../identity/binding.js";
import { deploymentOrg } from "../identity/deployment-identity.js";
import { resolvePartition } from "../memory/partition.js";
import { getOperationalStore } from "../operational/provider.js";

export const NONMEMBER_ANSWER_MARKED_AUDIT_ACTION = "input_response.nonmember_marked";

export function resolvedQuestionIds(data: unknown): readonly string[] {
  const resolutions = (data as { resolutions?: unknown } | undefined)?.resolutions;
  if (!Array.isArray(resolutions)) return [];
  const out: string[] = [];
  for (const r of resolutions as readonly unknown[]) {
    if (r === null || typeof r !== "object") continue;
    const res = r as { kind?: unknown; requestId?: unknown };
    if (res.kind === QUESTION_REQUEST_KIND && typeof res.requestId === "string" && res.requestId.length > 0) out.push(res.requestId);
  }
  return out;
}

export default defineHook({
  events: {
    "input.resolved": async (event, ctx: HookContext) => {
      const ids = resolvedQuestionIds(event.data);
      if (ids.length === 0) return;
      try {
        const org = deploymentOrg();
        const stamped = await nonMemberAnsweredIds(getOperationalStore(), org, ids);
        if (stamped.length === 0) return;
        markUntrustedIngestedThisTurn("chat-message");
        const bind = ctx as unknown as BindableContext;
        const sessionId = currentSessionId(bind);
        const turnId = currentTurnId(bind);
        let p: { org: string; platform: string; workspace: string; surface?: string };
        try {
          p = resolvePartition(bind);
        } catch {
          p = { org, platform: "unified", workspace: "unknown" };
        }
        await appendAudit({
          org: p.org,
          platform: p.platform,
          workspace: p.workspace,
          ...(p.surface === undefined ? {} : { surface: p.surface, ...auditSurfaceModeFrom(bind) }),
          action: NONMEMBER_ANSWER_MARKED_AUDIT_ACTION,
          detail: { requestIds: [...stamped], ...(sessionId ? { sessionId } : {}), ...(turnId ? { turnId } : {}) },
        }).catch(() => undefined);
      } catch (err) {
        markUntrustedIngestedThisTurn("chat-message");
        console.warn(`[open-everywhere:held-question] nonmember read failed — the turn is marked (fail closed): ${String(err)}`);
      }
    },
  },
});
