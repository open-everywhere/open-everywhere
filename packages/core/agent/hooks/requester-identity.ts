import { defineHook, type HookContext, type HookEvent } from "eve/hooks";
import { recordRequesterIdentity } from "../access/requester-identity.js";
import type { BindableContext } from "../identity/binding.js";
import { recordDeliveredWakes } from "../access/dispatch-origin-signal.js";
import { recordEngagedQuestionThisTurn } from "../channels/engaged-question-signal.js";
import { recordWorkRequestsThisTurn } from "../access/work-request-turn.js";
import { isWorkSessionContext } from "../access/work-session.js";
import { optional } from "./control-refusal.js";
import { deliveredText } from "./event-reads.js";

function captureRequesterIdentity(event: HookEvent<"delivery.consumed">, ctx: HookContext): void {
  try {
    const { turnId } = event.data;
    const message = deliveredText(event.data);
    recordDeliveredWakes(typeof turnId === "string" ? turnId : undefined, typeof message === "string" ? message : undefined);
    const { deliveryId } = event.data as { readonly deliveryId?: unknown };
    recordEngagedQuestionThisTurn(
      typeof turnId === "string" ? turnId : undefined,
      typeof deliveryId === "string" ? deliveryId : undefined,
      typeof message === "string" ? message : undefined,
    );
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
    "delivery.consumed": optional("requester-identity", (event, ctx) => captureRequesterIdentity(event, ctx)),
  },
});
