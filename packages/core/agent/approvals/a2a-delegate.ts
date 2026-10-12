import { QUOTE_MAX, plainQuote } from "./plain-text.js";
import { requesterWords } from "../channels/friendly-ids.js";
import { createHash } from "node:crypto";
import { appendAudit } from "../audit/audit.js";
import { getOperationalStore } from "../operational/provider.js";
import { registerActionKind, whereFromScope } from "./actions.js";
import type { ActionKind } from "./types.js";
import { plainValue } from "./plain-text.js";

const A2A_DELEGATE_KIND = "a2a.delegate";

export const A2A_DELEGATE_APPROVAL_TTL_HOURS = 24;

export interface A2aDelegateArgs {
  readonly org: string;
  readonly scopeKey: string;
  readonly agent: string;
  readonly host: string;
  readonly message: string;
  readonly sessionKey: string;
  readonly memoKind: string;
  readonly requestedBy: string;
  readonly tainted?: boolean;
  readonly answerIn?: string;
}

export function a2aDelegateMemoKind(agent: string, requestedBy: string, message: string): string {
  return `${A2A_DELEGATE_KIND}:${createHash("sha256").update(`${agent}\u0000${requestedBy}\u0000${message}`).digest("hex")}`;
}

function summarizeDelegate(args: A2aDelegateArgs): string[] {
  const lines = [
    `Delegate one task to the A2A agent "${args.agent}" (${args.host}) — approves this one call, with exactly this text, sent with the asker's identity`,
    `Task: ${args.message}`,
    ...(args.answerIn !== undefined ? [`The agent's answer will be posted in: ${args.answerIn}`] : []),
  ];
  if (args.tainted) lines.push("⚠ proposed in a turn that read external content — review before approving");
  return lines;
}

const a2aDelegate: ActionKind<A2aDelegateArgs> = {
  kind: A2A_DELEGATE_KIND,
  policy: "member",
  approvalArmsCall: true,
  plainSummary(args) {
    return `Send one task to the outside agent ${plainValue(args.agent, 30)} at ${plainValue(args.host, 40)}, with ${requesterWords(args.requestedBy, args.scopeKey)}'s identity`;
  },
  consequence: (args) => plainQuote(args.message, QUOTE_MAX - 2),
  consequenceQuotes: true,
  summarize: (args) => summarizeDelegate(args),
  async execute(args, decidedBy) {
    const now = new Date();
    await getOperationalStore().setSessionApproval({
      org: args.org,
      sessionId: args.sessionKey,
      kind: args.memoKind,
      grantedBy: decidedBy,
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + A2A_DELEGATE_APPROVAL_TTL_HOURS * 60 * 60 * 1000).toISOString(),
    });
    await appendAudit({
      ...whereFromScope(args.org, args.scopeKey),
      principalId: decidedBy,
      action: "a2a.delegate_approved",
      detail: { agent: args.agent, host: args.host, requestedBy: args.requestedBy, tainted: Boolean(args.tainted) },
    });
    return decidedBy.startsWith("chain:")
      ? `the task goes to ${args.agent} once, with exactly this text`
      : `the task may go to ${args.agent} once, with exactly this text`;
  },
};

registerActionKind(a2aDelegate);

type SpendStore = Pick<ReturnType<typeof getOperationalStore>, "getSessionApproval" | "markEventSeen" | "hasEventSeen">;

export type A2aDelegateSpend =
  | { readonly outcome: "spent"; readonly grantedBy: string; readonly sendKey: string; readonly ttlMs: number }
  | { readonly outcome: "absent" | "taken" | "lift-only" };

export async function spendA2aDelegateApproval(
  store: SpendStore,
  org: string,
  sessionKey: string,
  memoKind: string,
  callId: string | undefined,
  nowIso: string,
  chainMemo: "refuse" | "spend" = "refuse",
): Promise<A2aDelegateSpend> {
  const memo = await store.getSessionApproval(org, sessionKey, memoKind, nowIso).catch(() => null);
  if (memo === null) return { outcome: "absent" };
  if (chainMemo === "refuse" && memo.grantedBy.startsWith("chain:")) return { outcome: "lift-only" };
  const ttlMs = Math.max(1, Date.parse(memo.expiresAt) - Date.parse(nowIso));
  const spendKey = `a2a-delegate-spent:${sessionKey}:${memoKind}:${memo.createdAt}`;
  const callKey = callId !== undefined && callId.length > 0 ? `${spendKey}:call:${callId}` : undefined;
  const sendKey = `${spendKey}:sent`;
  if (callKey !== undefined && (await store.hasEventSeen(org, callKey, nowIso, ttlMs).catch(() => false))) {
    return { outcome: "spent", grantedBy: memo.grantedBy, sendKey, ttlMs };
  }
  const spent = await store.markEventSeen(org, spendKey, nowIso, ttlMs).catch(() => false);
  if (!spent) return { outcome: "taken" };
  if (callKey !== undefined) await store.markEventSeen(org, callKey, nowIso, ttlMs).catch(() => false);
  return { outcome: "spent", grantedBy: memo.grantedBy, sendKey, ttlMs };
}

export async function claimA2aDelegateSend(
  store: Pick<SpendStore, "markEventSeen">,
  org: string,
  spend: { readonly sendKey: string; readonly ttlMs: number },
  nowIso: string,
): Promise<boolean> {
  return store.markEventSeen(org, spend.sendKey, nowIso, spend.ttlMs).catch(() => false);
}

export function a2aDelegateMessageId(sendKey: string): string {
  const h = createHash("sha256").update(sendKey).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

export function a2aDelegateCaller(input: {
  readonly where: { readonly platform: string; readonly workspace: string };
  readonly requestedBy: string;
  readonly grantedBy: string;
}): { platform: string; workspace: string; principalId: string; approvedBy?: string; approvedByPolicy?: string } {
  const base = { platform: input.where.platform, workspace: input.where.workspace, principalId: input.requestedBy };
  return input.grantedBy.startsWith("chain:")
    ? { ...base, approvedByPolicy: input.grantedBy.slice("chain:".length) }
    : { ...base, approvedBy: input.grantedBy };
}

export interface A2aSendPlan {
  readonly sendKey: string;
  readonly ttlMs: number;
  readonly caller: ReturnType<typeof a2aDelegateCaller>;
  readonly messageId: string;
}

export function a2aSendPlanFromSpend(
  where: { readonly platform: string; readonly workspace: string },
  requestedBy: string,
  spent: { readonly sendKey: string; readonly ttlMs: number; readonly grantedBy: string },
): A2aSendPlan {
  return {
    sendKey: spent.sendKey,
    ttlMs: spent.ttlMs,
    caller: a2aDelegateCaller({ where, requestedBy, grantedBy: spent.grantedBy }),
    messageId: a2aDelegateMessageId(spent.sendKey),
  };
}

export function a2aSendPlanFromLift(
  where: { readonly platform: string; readonly workspace: string },
  requestedBy: string,
  lift: { readonly pendingId: string; readonly resolvedBy: string; readonly grantedBy?: string },
): A2aSendPlan {
  const sendKey = `a2a-delegate-sent:wedge:${lift.pendingId}`;
  return {
    sendKey,
    ttlMs: A2A_DELEGATE_APPROVAL_TTL_HOURS * 60 * 60 * 1000,
    caller: a2aDelegateCaller({ where, requestedBy, grantedBy: lift.grantedBy ?? `chain:${lift.resolvedBy}` }),
    messageId: a2aDelegateMessageId(sendKey),
  };
}

export type LiftedSendClaim = "claimed" | "no-turn-identity" | "not-spent" | "taken";

export async function claimLiftedA2aSend(
  store: SpendStore,
  org: string,
  input: {
    readonly sessionKey: string;
    readonly memoKind: string;
    readonly callId: string | undefined;
    readonly nowIso: string;
    readonly plan: A2aSendPlan;
    readonly hasTurnIdentity: boolean;
  },
): Promise<LiftedSendClaim> {
  const lifted = await spendA2aDelegateApproval(store, org, input.sessionKey, input.memoKind, input.callId, input.nowIso, "spend");
  if (lifted.outcome !== "spent") return "not-spent";
  if (!(await claimA2aDelegateSend(store, org, lifted, input.nowIso))) return "taken";
  if (!input.hasTurnIdentity) return "no-turn-identity";
  if (!(await claimA2aDelegateSend(store, org, input.plan, input.nowIso))) return "taken";
  return "claimed";
}

export async function a2aTaskOwnedBy(
  store: Pick<SpendStore, "hasEventSeen">,
  org: string,
  sessionKey: string,
  agent: string,
  taskId: string,
  nowIso: string,
): Promise<boolean> {
  return store.hasEventSeen(org, a2aTaskOwnerKey(sessionKey, agent, taskId), nowIso, A2A_TASK_FOLLOW_TTL_MS).catch(() => false);
}

export const A2A_TASK_FOLLOW_TTL_MS = 24 * 60 * 60 * 1000;

export function a2aTaskOwnerKey(sessionKey: string, agent: string, taskId: string): string {
  return `a2a-task:${sessionKey}:${agent}:${taskId}`;
}
