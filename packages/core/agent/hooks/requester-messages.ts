import { defineHook, type HookContext, type HookEvent } from "eve/hooks";
import { recordRequesterMessage } from "../access/requester-messages.js";
import { FIRE_UNATTENDED_ATTR, isSubagentChildContext, type BindableContext } from "../identity/binding.js";
import { adoptedParentTurnTaintThisTurn, TAINT_SEED_ATTRS } from "./spawn-taint.js";

function currentAttrs(ctx: HookContext): Record<string, unknown> | undefined {
  return (ctx as { session?: { auth?: { current?: { attributes?: Record<string, unknown> } | null } } }).session?.auth?.current?.attributes;
}

function stampedTrue(v: unknown): boolean {
  const first = Array.isArray(v) ? v[0] : v;
  return first === "true" || first === true;
}

export function captureEligible(ctx: HookContext): boolean {
  if (isSubagentChildContext(ctx as unknown as BindableContext)) return false;
  const attrs = currentAttrs(ctx);
  if (stampedTrue(attrs?.[FIRE_UNATTENDED_ATTR])) return false;
  for (const name of TAINT_SEED_ATTRS) {
    if (stampedTrue(attrs?.[name])) return false;
  }
  if (adoptedParentTurnTaintThisTurn(ctx)) return false;
  return true;
}

function captureReceivedMessage(event: HookEvent<"message.received">, ctx: HookContext): void {
  try {
    if (!captureEligible(ctx)) return;
    const { message, turnId } = event.data;
    if (typeof message !== "string") return;
    recordRequesterMessage(typeof turnId === "string" ? turnId : undefined, message);
  } catch {
  }
}

export default defineHook({
  events: {
    "message.received": (event, ctx) => captureReceivedMessage(event, ctx),
  },
});
