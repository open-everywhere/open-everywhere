import { defineHook, type HookContext } from "eve/hooks";
import { recordApprovalRaised } from "../access/approval-dedupe.js";

interface ToolApprovalRequestShape {
  readonly kind?: unknown;
  readonly action?: {
    readonly toolName?: unknown;
    readonly input?: unknown;
  };
}

export default defineHook({
  events: {
    "input.requested": async (event, ctx: HookContext) => {
      const requests = (event.data as { requests?: unknown } | undefined)?.requests;
      if (!Array.isArray(requests)) return;
      const sessionId = typeof ctx.session?.id === "string" && ctx.session.id.length > 0 ? ctx.session.id : undefined;
      if (!sessionId) return;

      for (const raw of requests) {
        const request = raw as ToolApprovalRequestShape;
        if (request?.kind !== "tool-approval") continue;
        const toolName = request.action?.toolName;
        if (typeof toolName !== "string" || toolName.length === 0) continue;
        try {
          await recordApprovalRaised(sessionId, toolName, request.action?.input);
        } catch {
        }
      }
    },
  },
});
