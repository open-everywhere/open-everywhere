import type { AuditWireEntry } from "./audit-read.js";

export const GENERIC_READ_VERBS_SHA = "ea1b3c670d495466cb1bfc02c002c32a152e7f13";

export const DELEGATION_TASK_STARTED_ACTION = "delegation.task_started";
export const DELEGATION_TASK_SETTLED_ACTION = "delegation.task_settled";
export const REPLY_POST_ACTION = "reply.post";

export const dS = (e: AuditWireEntry, k: string): string | undefined => (typeof e.detail?.[k] === "string" ? (e.detail![k] as string) : undefined);

export type DelegatedReadVerdict =
  | { readonly kind: "delegated-completed"; readonly taskId: string; readonly detail: string }
  | { readonly kind: "delegated-failed"; readonly taskId: string; readonly status: string; readonly detail: string }
  | { readonly kind: "delegated-unsettled"; readonly taskId: string; readonly detail: string }
  | { readonly kind: "refused"; readonly action: string; readonly detail: string }
  | { readonly kind: "none"; readonly detail: string };

export interface SettlePollDeps {
  readonly sleep: (ms: number) => Promise<void>;
  readonly now: () => number;
  readonly fetchRows: () => Promise<readonly AuditWireEntry[]>;
}

export async function pollForDelegationSettlement(
  deps: SettlePollDeps,
  sessionId: string,
  platform: "slack" | "discord",
  timeoutMs: number,
  pollMs: number,
  first: DelegatedReadVerdict,
): Promise<DelegatedReadVerdict> {
  const deadline = deps.now() + timeoutMs;
  let verdict = first;
  let waitedMs = 0;
  while (verdict.kind === "delegated-unsettled" && deps.now() < deadline) {
    await deps.sleep(pollMs);
    waitedMs += pollMs;
    const rows = await deps.fetchRows();
    verdict = classifyDelegatedReadEvidence(rows, sessionId, platform);
  }
  if (verdict.kind !== "delegated-unsettled") return verdict;
  return {
    kind: "delegated-unsettled",
    taskId: verdict.taskId,
    detail: `${verdict.detail} — never settled within ${timeoutMs}ms (polled ~${waitedMs}ms for delegation.task_settled; a genuine settle timeout, distinct from the OPE-788 single-early-read misread)`,
  };
}

export type FinalReplyOutcome = {
  readonly kind: "settled-relay" | "quiet" | "timeout";
  readonly replyCount: number;
  readonly detail: string;
};

const turnReplies = (rows: readonly AuditWireEntry[], wakeId: string, sessionId: string): readonly AuditWireEntry[] =>
  rows.filter((r) => r.action === REPLY_POST_ACTION && (dS(r, "sessionId") === sessionId || dS(r, "wakeId") === wakeId));

const atOrAfter = (a: string, b: string): boolean => {
  const [x, y] = [Date.parse(a), Date.parse(b)];
  return Number.isFinite(x) && Number.isFinite(y) && x >= y;
};

export async function pollForFinalReply(
  deps: SettlePollDeps,
  wakeId: string,
  sessionId: string,
  timeoutMs: number,
  pollMs: number,
  quietMs: number,
): Promise<FinalReplyOutcome> {
  const start = deps.now();
  const deadline = start + timeoutMs;
  let count = -1;
  let lastChangeAt = start;
  while (deps.now() < deadline) {
    await deps.sleep(pollMs);
    const rows = await deps.fetchRows();
    const replies = turnReplies(rows, wakeId, sessionId);
    const settled = rows.find((r) => r.action === DELEGATION_TASK_SETTLED_ACTION && dS(r, "session") === sessionId);
    if (settled && replies.some((r) => atOrAfter(r.ts, settled.ts))) {
      return {
        kind: "settled-relay",
        replyCount: replies.length,
        detail: `a reply.post landed at or after delegation.task_settled for session ${sessionId} — the worker's answer, not the interim ack (${replies.length} reply row(s) this turn)`,
      };
    }
    if (replies.length !== count) {
      count = replies.length;
      lastChangeAt = deps.now();
      continue;
    }
    const outstanding = rows.some((r) => r.action === DELEGATION_TASK_STARTED_ACTION && dS(r, "session") === sessionId) && !settled;
    if (!outstanding && deps.now() - lastChangeAt >= quietMs) {
      return {
        kind: "quiet",
        replyCount: count,
        detail: `the reply count for session ${sessionId} held at ${count} for ${quietMs}ms with no delegation outstanding — the seat has stopped posting`,
      };
    }
  }
  return {
    kind: "timeout",
    replyCount: Math.max(count, 0),
    detail: `no settled relay and no ${quietMs}ms quiet period within ${timeoutMs}ms (last seen ${Math.max(count, 0)} reply row(s)) — reading the transcript anyway; the existing classification still decides the verdict`,
  };
}

export const readRefusalActions = (platform: "slack" | "discord"): readonly string[] => [`${platform}.sources_refused`, `${platform}.origin_refused`];

export function classifyDelegatedReadEvidence(
  rows: readonly AuditWireEntry[],
  sessionId: string,
  platform: "slack" | "discord",
): DelegatedReadVerdict {
  const refusal = rows.find((r) => readRefusalActions(platform).includes(r.action));
  if (refusal) {
    return {
      kind: "refused",
      action: refusal.action,
      detail: `a ${refusal.action} audit row fired — the read was ATTEMPTED and DENIED (topology/origin fence), not skipped by model choice. Best-effort correlation: this row is scoped to sinceIso and platform, not to session ${sessionId}, because the refusal fires inside the WORKER's own context (its session id is unobservable) — a concurrent same-platform run in the same window could in principle produce this row instead.`,
    };
  }

  const started = rows.filter((r) => r.action === DELEGATION_TASK_STARTED_ACTION && dS(r, "session") === sessionId);
  if (started.length === 0) {
    return { kind: "none", detail: `no delegation.task_started row carries session ${sessionId} — no background delegation was dispatched from this reply session` };
  }

  for (const s of started) {
    const taskId = dS(s, "task") ?? "";
    if (taskId.length === 0) continue;
    const settled = rows.find((r) => r.action === DELEGATION_TASK_SETTLED_ACTION && dS(r, "task") === taskId && dS(r, "session") === sessionId);
    if (!settled) {
      return { kind: "delegated-unsettled", taskId, detail: `delegation.task_started for task ${taskId} (session ${sessionId}) has no matching delegation.task_settled in this window — the background worker never reached a terminal state` };
    }
    const status = dS(settled, "status") ?? "";
    if (status !== "completed") {
      return { kind: "delegated-failed", taskId, status, detail: `delegation.task_settled for task ${taskId} reports status "${status || "(none)"}", not "completed" — the background worker did not finish cleanly` };
    }
    return {
      kind: "delegated-completed",
      taskId,
      detail: `delegation.task_started -> delegation.task_settled(status:"completed") for task ${taskId} (session ${sessionId}) — the background worker ran to completion. Its OWN tool calls are unobservable (eve strips the worker's session id from every task view, OPE-566), so this proves the delegation settled, not specifically that read_channel ran inside it.`,
    };
  }
  return { kind: "none", detail: `delegation.task_started row(s) exist for session ${sessionId} but none carry a usable taskId` };
}
