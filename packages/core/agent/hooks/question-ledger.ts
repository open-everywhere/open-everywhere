import { defineHook, type HookContext, type HookEvent } from "eve/hooks";
import { actingPrincipalId, bindFrom, type BindableContext } from "../identity/binding.js";
import { tryPrincipalKey } from "../identity/principal-key.js";
import { readPersonOptOut } from "../identity/person-opt-out.js";
import { partitionOfBinding } from "../memory/partition.js";
import { getOperationalStore } from "../operational/provider.js";
import { toolUsageNames } from "../spend/tool-usage.js";
import { askedText, questionEntry, questionOf, questionPruneBefore } from "../personal-watch/questions.js";
import type { QuestionLedgerEntry } from "../operational/store.js";
import { captureEligible } from "./requester-messages.js";
import { call } from "eve/events";
import { optional } from "./control-refusal.js";
import { deliveredText } from "./event-reads.js";

const HELD = new Map<string, QuestionLedgerEntry>();
const HELD_MAX = 500;

function heldKey(sessionId: unknown, turnId: unknown): string | undefined {
  return typeof sessionId === "string" && sessionId.length > 0 && typeof turnId === "string" && turnId.length > 0 ? `${sessionId}|${turnId}` : undefined;
}

export function questionFromDelivery(message: unknown, binding: ReturnType<typeof bindFrom>, ts: string): QuestionLedgerEntry | undefined {
  if (typeof message !== "string" || binding.trust !== "internal") return undefined;
  if (binding.mode !== "dm" && binding.mode !== "channel") return undefined;
  const acting = actingPrincipalId(binding);
  if (!acting) return undefined;
  const text = askedText(message, binding.mode, acting);
  const question = text !== undefined ? questionOf(text) : undefined;
  if (!question) return undefined;
  return questionEntry({ org: binding.org, ts, surfaceKey: partitionOfBinding(binding).surfaceKey, mode: binding.mode, principalId: acting, question });
}

export function holdQuestion(sessionId: unknown, turnId: unknown, entry: QuestionLedgerEntry): void {
  const key = heldKey(sessionId, turnId);
  if (!key) return;
  HELD.delete(key);
  HELD.set(key, entry);
  if (HELD.size > HELD_MAX) HELD.delete(HELD.keys().next().value as string);
}

export function noteToolResult(sessionId: unknown, turnId: unknown, result: { readonly kind?: string; readonly toolName?: string } | undefined): void {
  const key = heldKey(sessionId, turnId);
  if (!key || !HELD.has(key)) return;
  const name = result?.toolName;
  if (result?.kind === "tool-result" && typeof name === "string" && toolUsageNames(name).connector.length > 0) HELD.delete(key);
}

export async function writeQuestion(entry: QuestionLedgerEntry): Promise<"written" | "opted-out"> {
  const [platform = "", tenant = ""] = entry.surfaceKey.split("/");
  const principalKey = tryPrincipalKey(platform, tenant, entry.principalId);
  if (!principalKey || (await readPersonOptOut(entry.org, principalKey)).optedOut) return "opted-out";
  await getOperationalStore().appendQuestion(entry, questionPruneBefore(entry.ts));
  return "written";
}

export async function settleQuestion(sessionId: unknown, turnId: unknown, answered: boolean): Promise<"written" | "opted-out" | "none"> {
  const key = heldKey(sessionId, turnId);
  if (!key) return "none";
  const entry = HELD.get(key);
  HELD.delete(key);
  if (!entry || !answered) return "none";
  try {
    return await writeQuestion(entry);
  } catch (err) {
    console.warn(`[open-everywhere:question-ledger] a question row did not land: ${String(err)}`);
    return "none";
  }
}

function onMessage(event: HookEvent<"delivery.consumed">, ctx: HookContext): void {
  if (!captureEligible(ctx)) return;
  const entry = questionFromDelivery(deliveredText(event.data), bindFrom(ctx as unknown as BindableContext), new Date().toISOString());
  if (entry) holdQuestion(ctx.session?.id, event.data.turnId, entry);
}

export default defineHook({
  events: {
    "delivery.consumed": optional("question-ledger", (event, ctx) => onMessage(event, ctx)),
    "call.settled": optional("question-ledger", (event, ctx) => {
      const observed = call(ctx.view, event.data.callId);
      if (observed === undefined || observed.kind !== "tool") return;
      noteToolResult(ctx.session?.id, observed.turnId ?? event.scope?.turnId, { kind: "tool-result", toolName: observed.name });
    }),
    "turn.settled": optional("question-ledger", async (event, ctx) => {
      switch (event.data.outcome) {
        case "completed":
          await settleQuestion(ctx.session?.id, event.data.turnId, true);
          return;
        default:
          await settleQuestion(ctx.session?.id, event.data.turnId, false);
      }
    }),
  },
});
