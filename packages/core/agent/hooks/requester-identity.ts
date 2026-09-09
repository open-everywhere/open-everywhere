import { defineHook, type HookContext, type HookEvent } from "eve/hooks";
import { recordRequesterIdentity } from "../access/requester-identity.js";
import type { BindableContext } from "../identity/binding.js";

function captureRequesterIdentity(event: HookEvent<"message.received">, ctx: HookContext): void {
  try {
    const { message, turnId } = event.data;
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
