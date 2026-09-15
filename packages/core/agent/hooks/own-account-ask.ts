import { defineHook, type HookContext, type HookEvent } from "eve/hooks";
import { appendAudit } from "../audit/audit.js";
import { isWakeEnvelopeShaped, triggerMessageBody } from "../channels/wake-envelope.js";
import { OE_OWN_ACCOUNT_ASK_ATTR, parseOwnAccountStamp, renderOwnAccountStamp } from "../connections/own-account-carriage.js";
import {
  CONNECTOR_OWN_ACCOUNT_ASK_ACTION,
  namedOwnAccountVendor,
  ownAccountAskAuditDetail,
  type OwnAccountAsk,
  type OwnAccountVendor,
} from "../connections/own-account-ask.js";
import { credentialGrantVendors, ownAccountAskVendors } from "../connections/own-account-vendors.js";
import { currentTurnId, type BindableContext } from "../identity/binding.js";
import { resolvePartition } from "../memory/partition.js";
import type { AuditInput } from "../operational/store.js";
import { captureEligible } from "./requester-messages.js";

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

function clearOwnStamp(attrs: Record<string, unknown>, sessionId: string): void {
  const raw = attrs[OE_OWN_ACCOUNT_ASK_ATTR];
  const first = Array.isArray(raw) ? raw[0] : raw;
  if (typeof first !== "string") return;
  const stamp = parseOwnAccountStamp(first);
  if (stamp === undefined || stamp.sessionId !== sessionId) return;
  delete attrs[OE_OWN_ACCOUNT_ASK_ATTR];
}

export interface OwnAccountAskRecognition {
  readonly ask: OwnAccountAsk;
  readonly stamped: boolean;
}

export function stampOwnAccountAsk(event: HookEvent<"message.received">, ctx: HookContext): OwnAccountAskRecognition | undefined {
  try {
    if (!captureEligible(ctx)) return undefined;
    const { message } = event.data;
    if (typeof message !== "string") return undefined;
    const body = askBodyOf(message);
    if (body === undefined) return undefined;
    let vendors: readonly OwnAccountVendor[];
    let degraded = false;
    try {
      vendors = ownAccountAskVendors();
    } catch (err) {
      degraded = true;
      vendors = credentialGrantVendors();
      console.error(`[open-everywhere:own-account] grading this delivery with the credential-grant connectors only, and clearing no stamp: ${err instanceof Error ? err.message : String(err)}`);
    }
    const ask = namedOwnAccountVendor([body], vendors);
    const raw = (ctx as { session?: { id?: string } }).session?.id;
    const sessionId = typeof raw === "string" && raw.length > 0 ? raw : undefined;
    const attrs = sessionId === undefined ? null : writableAuthAttrs(ctx);
    if (ask === undefined) {
      if (!degraded && attrs !== null && sessionId !== undefined) clearOwnStamp(attrs, sessionId);
      return undefined;
    }
    if (attrs === null || sessionId === undefined) return { ask, stamped: false };
    attrs[OE_OWN_ACCOUNT_ASK_ATTR] = renderOwnAccountStamp(sessionId, currentTurnId(ctx as unknown as BindableContext), ask);
    return { ask, stamped: true };
  } catch {
    return undefined;
  }
}

export function ownAccountAskAuditEntry(recognition: OwnAccountAskRecognition, ctx: HookContext): AuditInput | undefined {
  try {
    const p = resolvePartition(ctx as unknown as BindableContext);
    return {
      action: CONNECTOR_OWN_ACCOUNT_ASK_ACTION,
      detail: ownAccountAskAuditDetail(recognition.ask, recognition.stamped),
      org: p.org,
      platform: p.platform,
      surface: p.surface,
      workspace: p.workspace,
    };
  } catch {
    return undefined;
  }
}

export async function auditOwnAccountAsk(
  event: HookEvent<"message.received">,
  ctx: HookContext,
  write: (entry: AuditInput) => Promise<void> = appendAudit,
): Promise<OwnAccountAskRecognition | undefined> {
  const recognition = stampOwnAccountAsk(event, ctx);
  if (recognition === undefined) return undefined;
  const entry = ownAccountAskAuditEntry(recognition, ctx);
  if (entry !== undefined) await write(entry).catch(() => undefined);
  return recognition;
}

export default defineHook({
  events: {
    "message.received": (event, ctx) => void auditOwnAccountAsk(event, ctx).catch(() => undefined),
  },
});
