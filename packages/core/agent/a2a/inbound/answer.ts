import { appendAudit } from "../../audit/audit.js";
import { truncateMemoryCitationPaths } from "../../channels/turn-delivery.js";
import { A2A_ANSWER_SINK, filterOutboundText } from "../../access/outbound-filter.js";
import type { WorkRowStore } from "../../channels/work.js";
import { A2A_INBOUND_PLATFORM, A2A_INBOUND_WORKSPACE } from "./declaration.js";
import { settleA2aInboundTask } from "./task-store.js";

const A2A_INBOUND_ANSWERED_ACTION = "a2a.inbound_answered";

const FAILED_TEXT = "The task failed before it produced an answer.";
const CANCELED_TEXT = "The task was cancelled before it produced an answer.";

export function inboundAnswerOf(input: { readonly status: "completed" | "failed" | "cancelled"; readonly stopped: boolean; readonly resultText: string }): { readonly outcome: "completed" | "failed" | "canceled"; readonly text: string } {
  if (input.stopped || input.status === "failed") return { outcome: "failed", text: FAILED_TEXT };
  if (input.status === "cancelled") return { outcome: "canceled", text: CANCELED_TEXT };
  return { outcome: "completed", text: filterOutboundText(truncateMemoryCitationPaths(input.resultText), A2A_ANSWER_SINK, { asked: () => [] }) };
}

export type InboundAnswerWrite = "written" | "gone" | "error";

export async function answerA2aInboundTask(input: {
  readonly org: string;
  readonly store: WorkRowStore;
  readonly caller: string;
  readonly taskId: string;
  readonly requestId: string;
  readonly status: "completed" | "failed" | "cancelled";
  readonly stopped: boolean;
  readonly resultText: string;
  readonly nowIso?: string;
  readonly audit?: typeof appendAudit;
}): Promise<InboundAnswerWrite> {
  const answer = inboundAnswerOf(input);
  const nowIso = input.nowIso ?? new Date().toISOString();
  let write: InboundAnswerWrite;
  try {
    write = (await settleA2aInboundTask(input.store, input.org, { caller: input.caller, taskId: input.taskId, outcome: answer.outcome, text: answer.text, nowIso })) ? "written" : "gone";
  } catch (err) {
    console.warn(`[open-everywhere:a2a-inbound] task ${input.taskId}: the answer was not written — ${err instanceof Error ? err.name : "error"}`);
    write = "error";
  }
  await (input.audit ?? appendAudit)({
    org: input.org,
    platform: A2A_INBOUND_PLATFORM,
    workspace: A2A_INBOUND_WORKSPACE,
    surface: input.caller,
    principalId: `a2a:${input.caller}`,
    action: A2A_INBOUND_ANSWERED_ACTION,
    detail: { caller: input.caller, taskId: input.taskId, requestId: input.requestId, outcome: answer.outcome, chars: answer.text.length, written: write === "written", write },
  }).catch(() => undefined);
  return write;
}

export async function failLostInboundTask(input: {
  readonly org: string;
  readonly store: WorkRowStore;
  readonly requestId: string;
  readonly fire: { readonly a2a?: { readonly caller: string; readonly taskId: string } };
  readonly audit?: typeof appendAudit;
}): Promise<void> {
  const a2a = input.fire.a2a;
  if (a2a === undefined) return;
  await answerA2aInboundTask({ org: input.org, store: input.store, caller: a2a.caller, taskId: a2a.taskId, requestId: input.requestId, status: "failed", stopped: false, resultText: "", ...(input.audit !== undefined ? { audit: input.audit } : {}) });
}
