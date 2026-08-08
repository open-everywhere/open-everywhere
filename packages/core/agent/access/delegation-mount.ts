import { bindFrom, currentWindowToken, type BindableContext } from "../identity/binding.js";
import { dmAnchorWindowKey, parseWindowToken, type WindowKey } from "../channels/window-key.js";
import { wakeOriginCodec } from "../channels/wake-origin-codec.js";
import { oneshotAgentEnabled } from "./delegation-flag.js";
import type { UnifiedWakeOrigin } from "../channels/unified-window.js";

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
    if (resolveOwnWindowToken(ctx)) return true;
    if (oneshotAgentEnabled() && resolveDmDelegationAnchor(ctx)) return true;
    const raw = ctx.channel?.continuationToken;
    return typeof raw !== "string" || raw.length === 0;
  } catch {
    return true;
  }
}

export interface DmDelegationAnchor {
  readonly key: WindowKey;
  readonly origin: UnifiedWakeOrigin;
  readonly surfaceKey: string;
}

export function resolveDmDelegationAnchor(ctx: BindableContext): DmDelegationAnchor | undefined {
  try {
    if (resolveOwnWindowToken(ctx)) return undefined;
    const b = bindFrom(ctx);
    if (b.mode !== "dm" && b.mode !== "mpim") return undefined;
    const origin = wakeOriginCodec(b.platform)?.dmOrigin?.({ surface: b.surface, threadTs: b.threadTs, mode: b.mode, target: b.target });
    if (!origin) return undefined;
    const surfaceKey = `${b.platform}/${b.workspace}/${b.domainSurface ?? b.surface}`;
    return { key: dmAnchorWindowKey(surfaceKey), origin, surfaceKey };
  } catch {
    return undefined;
  }
}
