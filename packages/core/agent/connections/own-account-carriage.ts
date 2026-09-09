import { classifySessionId } from "../channels/window-key.js";
import { delegationRootSessionId, type BindableContext } from "../identity/binding.js";
import type { OwnAccountAsk } from "./own-account-ask.js";

export const OE_OWN_ACCOUNT_ASK_ATTR = "oe_own_account_ask";

const AMBIGUOUS_FLAG = "ambiguous";

export function renderOwnAccountStamp(sessionId: string, ask: OwnAccountAsk): string {
  return `${sessionId}|${ask.connector}${ask.ambiguous ? `|${AMBIGUOUS_FLAG}` : ""}`;
}

export function parseOwnAccountStamp(raw: string | undefined): { readonly sessionId: string; readonly ask: OwnAccountAsk } | undefined {
  if (raw === undefined) return undefined;
  const parts = raw.split("|");
  if (parts.length < 2 || parts.length > 3) return undefined;
  const [sessionId, connector, flag] = parts;
  if (!sessionId || !connector) return undefined;
  if (parts.length === 3 && flag !== AMBIGUOUS_FLAG) return undefined;
  return { ask: { ambiguous: flag === AMBIGUOUS_FLAG, connector }, sessionId };
}

function readOwnAccountAttr(ctx: BindableContext): string | undefined {
  const attrs = (ctx as { session?: { auth?: { current?: { attributes?: Record<string, unknown> } | null } } }).session?.auth?.current?.attributes;
  const raw = attrs?.[OE_OWN_ACCOUNT_ASK_ATTR];
  const first = Array.isArray(raw) ? raw[0] : raw;
  return typeof first === "string" && first.length > 0 ? first : undefined;
}

function adoptableSessions(ctx: BindableContext): readonly string[] {
  const out: string[] = [];
  const own = (ctx as { session?: { id?: string } }).session?.id;
  if (typeof own === "string" && own.length > 0) out.push(own);
  const root = delegationRootSessionId(ctx);
  if (root !== undefined && root.length > 0) out.push(root);
  const classified = classifySessionId(ctx.channel?.continuationToken);
  if (classified.kind === "subagent" && classified.parentSessionId.length > 0) out.push(classified.parentSessionId);
  return out;
}

export function adoptedOwnAccountAsk(ctx: BindableContext, vendors: readonly { readonly connector: string }[]): OwnAccountAsk | undefined {
  try {
    const stamp = parseOwnAccountStamp(readOwnAccountAttr(ctx));
    if (stamp === undefined) return undefined;
    if (!vendors.some((v) => v.connector === stamp.ask.connector)) return undefined;
    if (!adoptableSessions(ctx).includes(stamp.sessionId)) return undefined;
    return stamp.ask;
  } catch {
    return undefined;
  }
}
