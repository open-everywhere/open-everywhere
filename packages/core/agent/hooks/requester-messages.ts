import { defineHook, type HookContext, type HookEvent } from "eve/hooks";
import { recordRequesterAsk, recordRequesterMessage, type RequesterAsk } from "../access/requester-messages.js";
import { adoptForwardedRequesterAsks } from "../access/forwarded-asks.js";
import { isWorkSessionContext } from "../access/work-session.js";
import { triggerAuthors, triggerMessageBody, wakeIdsFromEnvelope } from "../channels/wake-envelope.js";
import { botAskRelayTurn } from "../channels/bot-ask.js";
import { jobFireStamped } from "../access/job-posture.js";
import { inheritedDeliveryThisTurn } from "../access/task-wake-signal.js";
import { currentTurnId, deliveryStampOf, FIRE_UNATTENDED_ATTR, isSubagentChildContext, type BindableContext } from "../identity/binding.js";
import { OE_CHAT_NONMEMBER_ATTR } from "../identity/non-member.js";
import { carriesNonRequesterStamp } from "../identity/non-requester.js";
import { optional } from "./control-refusal.js";
import { deliveredText } from "./event-reads.js";

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
  if (jobFireStamped(attrs as Parameters<typeof jobFireStamped>[0])) return false;
  if (stampedTrue(attrs?.[OE_CHAT_NONMEMBER_ATTR])) return false;
  if (botAskRelayTurn(attrs)) return false;
  if (carriesNonRequesterStamp(attrs)) return false;
  const bind = ctx as unknown as BindableContext;
  if (inheritedDeliveryThisTurn(currentTurnId(bind), deliveryStampOf(bind))) return false;
  return true;
}

function captureReceivedMessage(event: HookEvent<"delivery.consumed">, ctx: HookContext): void {
  try {
    if (!captureEligible(ctx)) return;
    const { turnId } = event.data;
    const message = deliveredText(event.data);
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
    "delivery.consumed": optional("requester-messages", (event, ctx) => captureReceivedMessage(event, ctx)),
    "turn.started": optional("requester-messages", async (_event, ctx) => {
      await adoptForwardedRequesterAsks(ctx as unknown as BindableContext);
    }),
  },
});
