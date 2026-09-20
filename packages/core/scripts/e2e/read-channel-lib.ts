import type { AuditWireEntry } from "./audit-read.js";
import { WAKE_INGRESS_ACTION, WAKE_TURN_START_ACTION } from "../../agent/channels/wake-timing.js";

export const GENERIC_READ_VERBS_SHA = "ea1b3c670d495466cb1bfc02c002c32a152e7f13";

export interface ShaAncestryProbe {
  objectPresent: boolean;
  shallowClone: boolean;
}

export function shouldAssertShaAncestry(probe: ShaAncestryProbe): boolean {
  return probe.objectPresent && !probe.shallowClone;
}

export const DELEGATION_TASK_STARTED_ACTION = "delegation.task_started";
export const DELEGATION_TASK_SETTLED_ACTION = "delegation.task_settled";
export const TASK_WAKE_ACTION = "unified.task_wake";
export const REPLY_POST_ACTION = "reply.post";
export const REPLY_EDIT_ACTION = "reply.edit";

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

const atOrAfter = (a: string, b: string): boolean => {
  const [x, y] = [Date.parse(a), Date.parse(b)];
  return Number.isFinite(x) && Number.isFinite(y) && x >= y;
};

const turnReplies = (rows: readonly AuditWireEntry[], wakeId: string, sessionId: string): readonly AuditWireEntry[] =>
  rows.filter((r) => r.action === REPLY_POST_ACTION && (dS(r, "sessionId") === sessionId || dS(r, "wakeId") === wakeId));

const turnEdits = (rows: readonly AuditWireEntry[], wakeId: string, sessionId: string): readonly AuditWireEntry[] =>
  rows.filter((r) => r.action === REPLY_EDIT_ACTION && (dS(r, "sessionId") === sessionId || dS(r, "wakeId") === wakeId));

function settlementEditOf(
  rows: readonly AuditWireEntry[],
  wakeId: string,
  sessionId: string,
  settledAt: string,
): AuditWireEntry | undefined {
  const ownIds = new Set(turnReplies(rows, wakeId, sessionId).map((r) => dS(r, "id")).filter((id): id is string => id !== undefined && id.length > 0));
  if (ownIds.size === 0) return undefined;
  return turnEdits(rows, wakeId, sessionId).find((e) => {
    const id = dS(e, "id");
    return id !== undefined && ownIds.has(id) && atOrAfter(e.ts, settledAt);
  });
}

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
  let settledFirstSeenAt: number | undefined;
  while (deps.now() < deadline) {
    await deps.sleep(pollMs);
    const rows = await deps.fetchRows();
    const replies = turnReplies(rows, wakeId, sessionId);
    const settled = rows.find((r) => r.action === DELEGATION_TASK_SETTLED_ACTION && dS(r, "session") === sessionId);
    if (settled && settledFirstSeenAt === undefined) {
      settledFirstSeenAt = deps.now();
      lastChangeAt = settledFirstSeenAt;
    }
    if (settled && replies.some((r) => atOrAfter(r.ts, settled.ts))) {
      return {
        kind: "settled-relay",
        replyCount: replies.length,
        detail: `a reply.post landed at or after delegation.task_settled for session ${sessionId} — the worker's answer, not the interim ack (${replies.length} reply row(s) this turn)`,
      };
    }
    const foldEdit = settled ? settlementEditOf(rows, wakeId, sessionId, settled.ts) : undefined;
    if (foldEdit) {
      return {
        kind: "settled-relay",
        replyCount: replies.length,
        detail:
          `a reply.edit of this turn's own reply id ${dS(foldEdit, "id") ?? "(none)"} landed at or after ` +
          `delegation.task_settled for session ${sessionId} — the settlement FOLDED into the ack, the product's ` +
          `designed shape while the ack is still the newest message (${replies.length} reply row(s) this turn)`,
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
        detail:
          `the reply count for session ${sessionId} held at ${count} for ${quietMs}ms with no delegation outstanding ` +
          `and no settlement edit of its own reply — the seat has stopped posting` +
          `${settledFirstSeenAt !== undefined ? " (clock measured from the settlement, not from the ack)" : ""}`,
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

export interface OwnWakeCandidate {
  readonly id: string;
  readonly atMs: number;
  readonly substantive: boolean;
}

export type OwnWakeReplyOutcome =
  | { readonly kind: "own-wake"; readonly id: string; readonly wakeId: string; readonly detail: string }
  | { readonly kind: "unattributed"; readonly id: string; readonly wakeId: string; readonly detail: string }
  | { readonly kind: "no-wake"; readonly detail: string }
  | { readonly kind: "timeout"; readonly wakeId: string; readonly detail: string };

export interface OwnWakeReplyDeps extends SettlePollDeps {
  readonly fetchCandidates: () => Promise<readonly OwnWakeCandidate[]>;
}

export interface OwnWakeDriverPost {
  readonly vendorMs: number;
  readonly surfaceKey?: string;
}

function ingressOfDriverPost(rows: readonly AuditWireEntry[], post: OwnWakeDriverPost): AuditWireEntry | undefined {
  return rows.find((r) => {
    if (r.action !== WAKE_INGRESS_ACTION) return false;
    if ((dS(r, "wakeId") ?? "").length === 0) return false;
    if (post.surfaceKey !== undefined && dS(r, "surfaceKey") !== post.surfaceKey) return false;
    const vendorTs = dS(r, "vendorTs");
    return vendorTs !== undefined && Date.parse(vendorTs) === post.vendorMs;
  });
}

function wakeLineage(rows: readonly AuditWireEntry[], wakeId: string, floorMs: number | undefined): ReadonlySet<string> {
  const lineage = new Set<string>([wakeId]);
  if (floorMs === undefined) return lineage;
  const dispatchedHere = new Set<string>();
  for (const r of rows) {
    if (r.action !== DELEGATION_TASK_STARTED_ACTION) continue;
    const task = dS(r, "task");
    const at = Date.parse(r.ts);
    if (task === undefined || task.length === 0) continue;
    if (!Number.isFinite(at) || at < floorMs) continue;
    dispatchedHere.add(task);
  }
  for (let grew = true; grew; ) {
    grew = false;
    for (const r of rows) {
      if (r.action !== TASK_WAKE_ACTION) continue;
      if (dS(r, "outcome") !== "installed") continue;
      const task = dS(r, "task");
      if (task === undefined || !dispatchedHere.has(task)) continue;
      const minted = dS(r, "wakeId");
      const inherited = dS(r, "inheritedWakeId");
      if (minted === undefined || minted.length === 0) continue;
      if (inherited === undefined || inherited.length === 0) continue;
      if (!lineage.has(inherited) || lineage.has(minted)) continue;
      lineage.add(minted);
      grew = true;
    }
  }
  return lineage;
}

function replyIdsByWake(rows: readonly AuditWireEntry[], wakeId: string, floorMs: number | undefined): { readonly mine: ReadonlyMap<string, string>; readonly foreign: ReadonlySet<string> } {
  const lineage = wakeLineage(rows, wakeId, floorMs);
  const mine = new Map<string, string>();
  const foreign = new Set<string>();
  for (const r of rows) {
    if (r.action !== REPLY_POST_ACTION) continue;
    const id = dS(r, "id");
    const rowWake = dS(r, "wakeId");
    if (id === undefined || id.length === 0 || rowWake === undefined || rowWake.length === 0) continue;
    if (lineage.has(rowWake)) mine.set(id, rowWake);
    else foreign.add(id);
  }
  return { mine, foreign };
}

export async function pollForOwnWakeReply(
  deps: OwnWakeReplyDeps,
  post: OwnWakeDriverPost,
  opts: { readonly timeoutMs: number; readonly pollMs: number },
): Promise<OwnWakeReplyOutcome> {
  const deadline = deps.now() + opts.timeoutMs;
  let wakeId: string | undefined;
  let floorMs: number | undefined;
  let standing = 0;
  let foreignSeen = 0;
  for (;;) {
    const rows = await deps.fetchRows();
    if (wakeId === undefined) {
      const ingress = ingressOfDriverPost(rows, post);
      if (ingress) wakeId = dS(ingress, "wakeId");
    }
    if (wakeId !== undefined) {
      if (floorMs === undefined) {
        const turnStart = rows.find((r) => r.action === WAKE_TURN_START_ACTION && dS(r, "wakeId") === wakeId);
        const parsed = turnStart === undefined ? Number.NaN : Date.parse(turnStart.ts);
        if (Number.isFinite(parsed)) floorMs = parsed;
      }
      const { mine, foreign } = replyIdsByWake(rows, wakeId, floorMs);
      const candidates = await deps.fetchCandidates();
      standing = candidates.length;
      foreignSeen = candidates.filter((c) => foreign.has(c.id)).length;
      for (const c of candidates) {
        if (!c.substantive) continue;
        const postedBy = mine.get(c.id);
        if (postedBy !== undefined) {
          return {
            kind: "own-wake",
            id: c.id,
            wakeId,
            detail:
              `a ${REPLY_POST_ACTION} row for wake ${postedBy} names message ${c.id} — this leg's own turn posted it` +
              (postedBy === wakeId ? "" : ` (the settlement of a task wake ${wakeId} dispatched, answering under the wake minted for that task)`),
          };
        }
        if (!foreign.has(c.id) && floorMs !== undefined && c.atMs >= floorMs) {
          return {
            kind: "unattributed",
            id: c.id,
            wakeId,
            detail:
              `message ${c.id} is attributed to no wake by any ${REPLY_POST_ACTION} row and stands at or after wake ${wakeId}'s own ` +
              `${WAKE_TURN_START_ACTION} — a host-posted answer, or a reply row that carried no wake`,
          };
        }
      }
    }
    if (deps.now() >= deadline) break;
    await deps.sleep(opts.pollMs);
  }
  if (wakeId === undefined) {
    return {
      kind: "no-wake",
      detail:
        `no ${WAKE_INGRESS_ACTION} row for this leg's own driver message (vendor instant ${new Date(post.vendorMs).toISOString()}` +
        `${post.surfaceKey !== undefined ? `, surface ${post.surfaceKey}` : ""}) was VISIBLE in the rows this read returned, within ` +
        `${opts.timeoutMs}ms. That is a statement about what was read, never about the deployment: the wake may have been declined ` +
        "before the ingress append (the window spend gate), the row may sit behind a capped page, or the best-effort append may have " +
        "been dropped. Either way there is no key, so nothing standing in the room can be attributed to this leg, and the " +
        "caller (`awaitOwnWakeReply`, scenarios.ts) scores the leg RED on this read",
    };
  }
  return {
    kind: "timeout",
    wakeId,
    detail:
      `wake ${wakeId} produced no reply row and no unattributed post after its turn start within ${opts.timeoutMs}ms ` +
      `(${standing} bot message(s) stood in the room, ${foreignSeen} of them attributed to ANOTHER wake — those never end this wait)`,
  };
}
