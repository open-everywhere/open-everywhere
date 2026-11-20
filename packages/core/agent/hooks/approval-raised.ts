import { defineHook } from "eve/hooks";
import { call, type InteractionOpenedData } from "eve/events";
import { recordApprovalRaised } from "../access/approval-dedupe.js";
import { optional } from "./control-refusal.js";

export function approvalCallOf(data: InteractionOpenedData, view: Parameters<typeof call>[0] | undefined): { readonly toolName: string; readonly input: unknown } | undefined {
  if (data.request.kind !== "approval") return undefined;
  const relayed = data.origin?.call;
  if (relayed !== undefined) return relayed.name.length > 0 ? { toolName: relayed.name, input: relayed.input } : undefined;
  const subject = data.subject as { readonly callId?: unknown };
  const observed = typeof subject.callId === "string" && view !== undefined ? call(view, subject.callId) : undefined;
  if (observed === undefined || observed.name.length === 0) return undefined;
  return { toolName: observed.name, input: observed.input };
}

export default defineHook({
  events: {
    "interaction.opened": optional("approval-raised", async (event, ctx) => {
      const sessionId = typeof ctx.session?.id === "string" && ctx.session.id.length > 0 ? ctx.session.id : undefined;
      if (!sessionId) return;
      const approval = approvalCallOf(event.data, ctx.view);
      if (approval === undefined) return;
      await recordApprovalRaised(sessionId, approval.toolName, approval.input);
    }),
  },
});
