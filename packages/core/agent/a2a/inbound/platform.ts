import { registerIdentityMapper, type BindableContext, type IdentityMapper, type RawIdentity } from "../../identity/binding.js";
import { registerWakeOriginCodec, type WakeOriginCodec } from "../../channels/wake-origin-codec.js";
import type { UnifiedWakeOrigin } from "../../channels/unified-window.js";
import { A2A_INBOUND_PLATFORM, A2A_INBOUND_WORKSPACE } from "./declaration.js";

export const A2A_INBOUND_CALLER_ATTR = "oe_a2a_caller";
export const A2A_INBOUND_TASK_ATTR = "oe_a2a_task";

type A2aOrigin = Extract<UnifiedWakeOrigin, { platform: "a2a" }>;

const CALLER = /^[a-z][a-z0-9-]{0,63}$/u;
const TASK_ID = /^[A-Za-z0-9-]{1,128}$/u;

export const a2aWakeOriginCodec: WakeOriginCodec<A2aOrigin> = {
  validate: (o) => typeof o.caller === "string" && CALLER.test(o.caller) && typeof o.taskId === "string" && TASK_ID.test(o.taskId),
  threadRef: (o) => ({ channelKey: `a2a/${o.caller}`, threadKey: o.taskId }),
  isThreadScoped: () => false,
  containerId: (o) => o.taskId,
};

type AuthAttrs = Readonly<Record<string, string | readonly string[]>> | undefined;

function attr(a: AuthAttrs, key: string): string | undefined {
  const v = a?.[key];
  const first = Array.isArray(v) ? v[0] : v;
  return typeof first === "string" && first.length > 0 ? first : undefined;
}

export function a2aInboundIdentityAttributes(caller: string, taskId: string): Record<string, string> {
  return { [A2A_INBOUND_CALLER_ATTR]: caller, [A2A_INBOUND_TASK_ATTR]: taskId };
}

export const bindA2aInbound: IdentityMapper = (ctx: BindableContext): RawIdentity => {
  const auth = ctx.session?.auth?.current ?? ctx.session?.auth?.initiator ?? null;
  const a = auth?.attributes as AuthAttrs;
  const caller = attr(a, A2A_INBOUND_CALLER_ATTR);
  const taskId = attr(a, A2A_INBOUND_TASK_ATTR);
  const callerOk = caller !== undefined && CALLER.test(caller);
  return {
    workspace: callerOk ? A2A_INBOUND_WORKSPACE : undefined,
    surface: callerOk ? caller : undefined,
    mode: "channel",
    visibility: "private",
    trust: "external",
    ...(callerOk ? { principalId: `a2a:${caller}` } : {}),
    ...(callerOk && taskId !== undefined ? { target: { caller, taskId } } : {}),
  };
};

export function registerA2aInboundPlatform(): void {
  registerIdentityMapper(A2A_INBOUND_PLATFORM, bindA2aInbound);
  registerWakeOriginCodec("a2a", a2aWakeOriginCodec);
}

