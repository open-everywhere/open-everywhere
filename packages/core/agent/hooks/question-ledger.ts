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

function onMessage(event: HookEvent<"message.received">, ctx: HookContext): void {
  try {
    if (!captureEligible(ctx)) return;
    const entry = questionFromDelivery(event.data.message, bindFrom(ctx as unknown as BindableContext), new Date().toISOString());
    if (entry) holdQuestion(ctx.session?.id, event.data.turnId, entry);
  } catch {
  }
}

function turnOf(event: unknown): unknown {
  return (event as { data?: { turnId?: unknown } } | undefined)?.data?.turnId;
}

export default defineHook({
  events: {
    "message.received": (event, ctx) => onMessage(event, ctx),
    "action.result": async (event, ctx) => noteToolResult(ctx.session?.id, turnOf(event), (event as { data?: { result?: { kind?: string; toolName?: string } } } | undefined)?.data?.result),
    "turn.completed": async (event, ctx) => void (await settleQuestion(ctx.session?.id, turnOf(event), true)),
    "turn.failed": async (event, ctx) => void (await settleQuestion(ctx.session?.id, turnOf(event), false)),
    "turn.cancelled": async (event, ctx) => void (await settleQuestion(ctx.session?.id, turnOf(event), false)),
  },
});
