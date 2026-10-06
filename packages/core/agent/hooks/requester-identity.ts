import { defineHook, type HookContext, type HookEvent } from "eve/hooks";
import { recordRequesterIdentity } from "../access/requester-identity.js";
import type { BindableContext } from "../identity/binding.js";
import { recordDeliveredWakes } from "../access/dispatch-origin-signal.js";
import { recordWorkRequestsThisTurn } from "../access/work-request-turn.js";
import { isWorkSessionContext } from "../access/work-session.js";

function captureRequesterIdentity(event: HookEvent<"message.received">, ctx: HookContext): void {
  try {
    const { message, turnId } = event.data;
    recordDeliveredWakes(typeof turnId === "string" ? turnId : undefined, typeof message === "string" ? message : undefined);
    if (isWorkSessionContext(ctx as unknown as BindableContext)) {
      recordWorkRequestsThisTurn(typeof turnId === "string" ? turnId : undefined, typeof message === "string" ? message : undefined);
    }
    recordRequesterIdentity(
      ctx as unknown as BindableContext,
      typeof turnId === "string" ? turnId : undefined,
      typeof message === "string" ? message : undefined,
    );
  } catch {
  }
}

export default defineHook({
  events: {
    "message.received": (event, ctx) => captureRequesterIdentity(event, ctx),
  },
});
