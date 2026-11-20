import { defineHook } from "eve/hooks";
import type { SessionView } from "eve/events";
import { appendAudit } from "../audit/audit.js";
import { nonMemberAnsweredIds, QUESTION_REQUEST_KIND } from "../access/held-question.js";
import { auditSurfaceModeFrom, currentSessionId, currentTurnId, type BindableContext } from "../identity/binding.js";
import { deploymentOrg } from "../identity/deployment-identity.js";
import { resolvePartition } from "../memory/partition.js";
import { getOperationalStore } from "../operational/provider.js";
import { optional } from "./control-refusal.js";
import { interactionKindOf } from "./event-reads.js";

export const NONMEMBER_ANSWER_MARKED_AUDIT_ACTION = "input_response.nonmember_marked";

export function resolvedQuestionIds(data: unknown, view: SessionView | undefined): readonly string[] {
  const d = data as { readonly interactionId?: unknown; readonly outcome?: unknown } | null | undefined;
  if (typeof d?.interactionId !== "string" || d.interactionId.length === 0) return [];
  if (d.outcome !== "accepted" && d.outcome !== "declined") return [];
  return interactionKindOf(view, d.interactionId) === QUESTION_REQUEST_KIND ? [d.interactionId] : [];
}

export default defineHook({
  events: {
    "interaction.settled": optional("held-question", async (event, ctx) => {
      const ids = resolvedQuestionIds(event.data, ctx.view);
      if (ids.length === 0) return;
      const org = deploymentOrg();
      const stamped = await nonMemberAnsweredIds(getOperationalStore(), org, ids);
      if (stamped.length === 0) return;
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
    }),
  },
});
