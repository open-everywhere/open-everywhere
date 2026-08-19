import type { AuditWireEntry } from "./audit-read.js";

export const GENERIC_READ_VERBS_SHA = "ea1b3c670d495466cb1bfc02c002c32a152e7f13";

export const DELEGATION_TASK_STARTED_ACTION = "delegation.task_started";
export const DELEGATION_TASK_SETTLED_ACTION = "delegation.task_settled";

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
