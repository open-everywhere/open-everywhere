import { canDelegateFromSeat, resolveOwnWindowToken } from "./delegation-mount.js";
import { isSubagentChildContext, type BindableContext } from "../identity/binding.js";
import { classifySessionId, isWorkWindowToken } from "../channels/window-key.js";

export function isWorkSessionContext(ctx: BindableContext): boolean {
  try {
    if (isSubagentChildContext(ctx)) return false;
    return isWorkWindowToken(resolveOwnWindowToken(ctx));
  } catch {
    return false;
  }
}

export function isWorkSessionChildContext(ctx: BindableContext): boolean {
  try {
    return isSubagentChildContext(ctx) && isWorkWindowToken(resolveOwnWindowToken(ctx));
  } catch {
    return false;
  }
}

export function forwardsToWorkSession(ctx: BindableContext): boolean {
  try {
    if (isSubagentChildContext(ctx)) return false;
    const token = resolveOwnWindowToken(ctx);
    return token !== undefined && seatTokenForwardsWork(token);
  } catch {
    return false;
  }
}

export function seatTokenForwardsWork(token: string): boolean {
  try {
    const kind = classifySessionId(token).kind;
    return kind === "window" || kind === "thread-seat";
  } catch {
    return false;
  }
}

export function seatHoldsDelegationVerb(ctx: BindableContext): boolean {
  return canDelegateFromSeat(ctx) && (isWorkSessionContext(ctx) || forwardsToWorkSession(ctx));
}
