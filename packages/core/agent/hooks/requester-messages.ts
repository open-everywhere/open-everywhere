import { defineHook, type HookContext, type HookEvent } from "eve/hooks";
import { recordRequesterAsk, recordRequesterMessage, type RequesterAsk } from "../access/requester-messages.js";
import { adoptForwardedRequesterAsks } from "../access/forwarded-asks.js";
import { isWorkSessionContext } from "../access/work-session.js";
import { triggerAuthors, triggerMessageBody, wakeIdsFromEnvelope } from "../channels/wake-envelope.js";
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
  if (isWorkSessionContext(ctx as unknown as BindableContext)) return false;
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
    const turn = typeof turnId === "string" ? turnId : undefined;
    recordRequesterMessage(turn, message);
    const ask = requesterAskOf(message);
    if (ask !== undefined) recordRequesterAsk(turn, ask);
  } catch {
  }
}

export function requesterAskOf(text: string): RequesterAsk | undefined {
  const wakes = wakeIdsFromEnvelope(text);
  if (wakes.length !== 1) return undefined;
  const triggers = triggerAuthors(text);
  if (triggers.length !== 1) return undefined;
  const [author] = triggers;
  if (author === undefined || author.from !== "human" || author.authorId === undefined || author.authorId.length === 0) return undefined;
  const body = triggerMessageBody(text);
  if (body === undefined || body.trim().length === 0) return undefined;
  return { wakeId: wakes[0] as string, authorId: author.authorId, body };
}

export default defineHook({
  events: {
    "message.received": (event, ctx) => captureReceivedMessage(event, ctx),
    "turn.started": async (_event, ctx) => {
      try {
        await adoptForwardedRequesterAsks(ctx as unknown as BindableContext);
      } catch {
      }
    },
  },
});
