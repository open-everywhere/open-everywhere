import { canDelegateFromSeat, resolveOwnWindowToken } from "./delegation-mount.js";
import { isSubagentChildContext, windowGrainOf, type BindableContext } from "../identity/binding.js";
import { classifySessionId, isWorkWindowToken } from "../channels/window-key.js";
import { memoryRecallRouteFor, type DelegationVerb, type MemoryRecallRoute } from "./window-gate-manifest.js";

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

/**
 * The hand-off verb this session holds, or `undefined` when it holds none. A work session hands a job
 * to a worker with eve's `agent`, and its per-wake `agent` verdict admits that call. A seat that
 * forwards to its work session hands a job off with `work`. Its `agent` verdict is `no-seat`, and
 * the root approval policy refuses its `agent` call (`access/native-delegation-gate.ts`).
 */
export function seatDelegationVerb(ctx: BindableContext): DelegationVerb | undefined {
  if (!canDelegateFromSeat(ctx)) return undefined;
  if (isWorkSessionContext(ctx)) return "agent";
  if (forwardsToWorkSession(ctx)) return "work";
  return undefined;
}

export function seatHoldsDelegationVerb(ctx: BindableContext): boolean {
  return seatDelegationVerb(ctx) !== undefined;
}

/** The memory road a seat reads in its instructions. It names the same hand-off verb the seat holds. */
export function seatMemoryRecallRoute(ctx: BindableContext): MemoryRecallRoute {
  const verb = seatDelegationVerb(ctx);
  return memoryRecallRouteFor(windowGrainOf(ctx), undefined, undefined, verb !== undefined, verb);
}
