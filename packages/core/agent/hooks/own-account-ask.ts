import { defineHook, type HookContext, type HookEvent } from "eve/hooks";
import { credentialGrantConnectors } from "../access/credential-grant.js";
import { isWakeEnvelopeShaped, triggerMessageBody } from "../channels/wake-envelope.js";
import { OE_OWN_ACCOUNT_ASK_ATTR, renderOwnAccountStamp } from "../connections/own-account-carriage.js";
import { namedOwnAccountVendor, type OwnAccountAsk, type OwnAccountVendor } from "../connections/own-account-ask.js";
import { captureEligible } from "./requester-messages.js";

export function ownAccountVendors(): readonly OwnAccountVendor[] {
  return credentialGrantConnectors().map((connector) => ({ connector }));
}

function writableAuthAttrs(ctx: HookContext): Record<string, unknown> | null {
  try {
    const current = (ctx as { session?: { auth?: { current?: { attributes?: unknown } } } }).session?.auth?.current;
    if (current === undefined || current === null) return null;
    const attrs = current.attributes;
    if (typeof attrs === "object" && attrs !== null) return attrs as Record<string, unknown>;
    const fresh: Record<string, unknown> = {};
    (current as { attributes?: unknown }).attributes = fresh;
    return (current as { attributes?: unknown }).attributes === fresh ? fresh : null;
  } catch {
    return null;
  }
}

export function askBodyOf(text: string | undefined): string | undefined {
  if (text === undefined) return undefined;
  if (!isWakeEnvelopeShaped(text)) return text;
  return triggerMessageBody(text);
}

export function stampOwnAccountAsk(event: HookEvent<"message.received">, ctx: HookContext): OwnAccountAsk | undefined {
  try {
    if (!captureEligible(ctx)) return undefined;
    const { message } = event.data;
    if (typeof message !== "string") return undefined;
    const body = askBodyOf(message);
    if (body === undefined) return undefined;
    const ask = namedOwnAccountVendor([body], ownAccountVendors());
    if (ask === undefined) return undefined;
    const sessionId = (ctx as { session?: { id?: string } }).session?.id;
    if (typeof sessionId !== "string" || sessionId.length === 0) return undefined;
    const attrs = writableAuthAttrs(ctx);
    if (attrs === null) return undefined;
    attrs[OE_OWN_ACCOUNT_ASK_ATTR] = renderOwnAccountStamp(sessionId, ask);
    return ask;
  } catch {
    return undefined;
  }
}

export default defineHook({
  events: {
    "message.received": (event, ctx) => void stampOwnAccountAsk(event, ctx),
  },
});
