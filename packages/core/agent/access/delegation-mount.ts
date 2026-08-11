import { currentWindowToken, isSubagentChildContext, type BindableContext } from "../identity/binding.js";
import { parseWindowToken } from "../channels/window-key.js";

export function resolveOwnWindowToken(ctx: BindableContext): string | undefined {
  const raw = ctx.channel?.continuationToken;
  if (typeof raw === "string" && raw.length > 0) {
    const stripped = raw.startsWith("unified:") ? raw.slice("unified:".length) : raw;
    if (parseWindowToken(stripped)) return stripped;
  }
  const stamped = currentWindowToken(ctx);
  return stamped && parseWindowToken(stamped) ? stamped : undefined;
}

export function canDelegateFromSeat(ctx: BindableContext): boolean {
  try {
    if (isSubagentChildContext(ctx)) return false;
    if (resolveOwnWindowToken(ctx)) return true;
    const raw = ctx.channel?.continuationToken;
    return typeof raw !== "string" || raw.length === 0;
  } catch {
    return true;
  }
}
