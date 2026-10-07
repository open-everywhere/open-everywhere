import { defineHook, type HookContext } from "eve/hooks";
import { defineState } from "eve/context";
import { OE_SPAWN_TAINTED_ATTR, OE_SPAWN_TAINT_KINDS_ATTR, dispatchWorkResult } from "../channels/unified.js";
import { OE_WORK_REQUEST_ATTR, OE_WORK_RESULT_ATTR, OE_WORK_RESULT_OWED_ATTR, OE_WORK_RESULT_READS_ATTR, WORK_RESULT_WAKE_ACTION, postWorkResultOnce, readWorkBrief, spendWorkReportPromise, workReportPromised, readWorkCall, readWorkRequest, rememberWorkCall, workLedgerId, readWorkTaskRequest, rememberWorkTask, renderWorkResultWake, workResultText, workTokenForSeat, workCancelRedeemed, type WorkRequestRow } from "../channels/work.js";
import { fireFoldOutcome, foldWorkFire } from "../routines/fire-work-fold.js";
import { noteWorkJobSettled, noteWorkJobStarted, settledWorkJobStateFor } from "./work-status.js";
import { currentWorkSessionToken } from "../access/lean-seat-state.js";
import { forgetWorkStop, readWorkStop } from "../channels/work-stop-note.js";
import { claimWorkCall, workRequestsThisTurn } from "../access/work-request-turn.js";
import { keyWorkTask, readWorkTaskKey, wakeSeatNeedsReissue } from "./work-task-key.js";
import { bareTokenFromEveContext } from "../channels/window-key.js";
import { isWorkSessionContext } from "../access/work-session.js";
import { getOperationalStore } from "../operational/provider.js";
import { mintWakeId } from "../channels/unified-window.js";
import {
  beginTaintTurn,
  markUntrustedIngestedThisTurn,
  registerTaintFlipObserver,
  registerTaintKindObserver,
  taintKindsThisTurn,
  untrustedIngestedThisTurn,
  OE_TAINTED_FIRE_ATTR,
  OE_CHAT_NONMEMBER_ATTR,
} from "../access/taint-signal.js";
import { INGESTION_KINDS, type IngestionKind } from "../access/taint-tiers.js";
import {
  markSubagentTainted,
  claimSubagentCallClean,
  markSubagentCallTainted,
  subagentCallTaintRecord,
  rememberTaskCall,
  taskCallLink,
  type TaskCallLink,
} from "../access/subagent-taint.js";
import {
  readAgentStarted,
  readDelegationFailure,
  readTaskSettled,
  readTaskStarted,
  settledTaskSummary,
  taskSettledFailure,
  type AgentStarted,
  type DelegationFailure,
  type TaskSettled,
  type TaskSettledFailure,
  type TaskStarted,
  type TaskSummary,
} from "../access/background-tasks.js";
import { JOB_TAINT_ATTR } from "../access/job-posture.js";
import { beginTaintVerdictTurn, registerTaintVerdictSink, taintEnabled, taintMode, type TaintVerdictRow } from "../access/taint-enforcement.js";
import { appendAudit } from "../audit/audit.js";
import { auditErrorDetail, auditErrorFrames } from "../audit/tool-action.js";
import {
  bindFrom,
  currentSessionId,
  currentTurnId,
  currentWakeId,
  deliveryStampOf,
  deploymentOrg,
  inheritedWakeStampOf,
  isSubagentChildContext,
  isUnifiedWindowContext,
  type BindableContext,
} from "../identity/binding.js";
import { resolveOwnWindowToken } from "../access/delegation-mount.js";
import { advanceDelegatedTaskWake, delegatedTaskDispatchAuthority, installTaskWake, openTaskWake, rememberDelegatedTaskBinding, rememberDelegatedTaskWake } from "../channels/task-wake.js";
import { noteStepDelivery, noteTurnBoundary, taskWakeThisTurn, uningressedTurn } from "../access/task-wake-signal.js";
import { liveAuthIsAnotherPrincipal, noteTurnOpeningPrincipal } from "../access/turn-opening-principal.js";
import { noteContinuationTurn } from "../access/continuation-turn-state.js";
import { noteTaskClaimDispatched, noteTaskProvenanceSettled, readTaskOpening, recordTaskOpening } from "../channels/task-provenance.js";
import { clearStreamDropRetries, streamDropRetriesThisTurn } from "../model/stream-drop-retry.js";
import { addressedWakeThisTurn, exactDispatchWakeThisTurn, noteTaskDispatchedThisTurn } from "../access/dispatch-origin-signal.js";
import { requesterThisTurn } from "../access/requester-identity.js";
import { noteSettlementDispatchAuthority, settlementDispatchAuthorityThisTurn } from "../access/settlement-dispatch-signal.js";
import { claimPromisedReport, notePendingDelegation, noteDelegationSettled, noteSettlementReportOwed, settlementReportOwedOn } from "../access/pending-delegation-signal.js";
import { clearGenerationDelegation, noteGenerationDelegation } from "../channels/generation-retirement.js";
import { delegatedSecondAddress, delegatingParentLink, heldTurnWakeProvable, settleDelegatedReads } from "../channels/delegated-provenance.js";
import { stampReadReach } from "../channels/read-reach.js";
import { resolvePartition } from "../memory/partition.js";
import { adoptCarriedWrites, factWritesThisTurn, OE_WORK_RESULT_WRITES_ATTR } from "../memory/write-evidence.js";
import { flushDirtyTreeAtTurnEnd, flushSettledMemory, noteTaskDispatched, noteTaskSettled } from "./settlement-flush.js";
import { flushWorkSettlement } from "./work-flush.js";
import { currentSeatToken, isSameWorkSession, workSessionLedgerId, workTokenHoldingTask } from "../channels/work-generation.js";
import type { MemoryPersistContext } from "./memory.js";

const TAINT_VERDICT_ACTION = "taint.verdict";

export function taintVerdictIdentityDetail(
  turn: { readonly sessionId?: string; readonly turnId?: string } | null | undefined,
  subagent: { readonly parent: { readonly sessionId?: string } | null } | null | undefined,
): { sessionId?: string; turnId?: string; parentSessionId?: string } {
  const out: { sessionId?: string; turnId?: string; parentSessionId?: string } = {};
  if (turn?.sessionId) out.sessionId = turn.sessionId;
  if (turn?.turnId) out.turnId = turn.turnId;
  const parent = subagent?.parent?.sessionId;
  if (parent && parent !== turn?.sessionId) out.parentSessionId = parent;
  return out;
}

function liveTaintVerdictIdentity(): { sessionId?: string; turnId?: string; parentSessionId?: string } {
  try {
    return taintVerdictIdentityDetail(turnIdentity.get(), subagentIdentity.get());
  } catch {
    return {};
  }
}

registerTaintVerdictSink((row: TaintVerdictRow) => {
  void appendAudit({
    org: deploymentOrg(),
    platform: "ingest",
    workspace: row.kind,
    action: TAINT_VERDICT_ACTION,
    detail: { ...row, ...liveTaintVerdictIdentity() },
  }).catch(() => undefined);
});

export const TAINT_SEED_ATTRS: readonly string[] = [
  OE_SPAWN_TAINTED_ATTR,
  OE_TAINTED_FIRE_ATTR,
  JOB_TAINT_ATTR,
  OE_CHAT_NONMEMBER_ATTR,
];

function currentAttrs(ctx: HookContext): Record<string, unknown> | undefined {
  return (ctx as { session?: { auth?: { current?: { attributes?: Record<string, unknown> } | null } } }).session?.auth?.current?.attributes;
}

function stampedTrue(v: unknown): boolean {
  const first = Array.isArray(v) ? v[0] : v;
  return first === "true" || first === true;
}

export function seedIfTainted(ctx: HookContext): void {
  try {
    const attrs = currentAttrs(ctx);
    for (const name of TAINT_SEED_ATTRS) {
      if (stampedTrue(attrs?.[name])) {
        const raw = attrs?.[OE_SPAWN_TAINT_KINDS_ATTR];
        const first = Array.isArray(raw) ? raw[0] : raw;
        const kinds = typeof first === "string" ? first.split(",").filter((k): k is IngestionKind => (INGESTION_KINDS as readonly string[]).includes(k)) : [];
        adoptKinds(kinds);
        return;
      }
    }
  } catch {
  }
}

export function openTaintTurn(ctx: HookContext): void {
  rememberSubagentIdentity(ctx);
  rememberTurnIdentity(ctx);
  let turnId: string | undefined;
  try {
    turnId = currentTurnId(ctx as unknown as BindableContext);
  } catch {
    turnId = undefined;
  }
  beginTaintTurn(turnId);
  beginTaintVerdictTurn(turnId);
  adoptParentTurnTaint(ctx);
  seedIfTainted(ctx);
  reseedStickyChildTaint();
  recordDispatchTurnForChildren();
  announceTaintOff(ctx);
}

const TAINT_MODE_ACTION = "taint.mode";

const taintModeAnnounced = defineState<boolean>("open-everywhere.taint-mode-announced", () => false);

export function announceTaintOff(ctx: HookContext): boolean {
  try {
    if (taintEnabled()) return false;
    let first = false;
    taintModeAnnounced.update((cur) => {
      if (cur === true) return true;
      first = true;
      return true;
    });
    if (!first) return false;
    const sessionId = (ctx as { session?: { id?: string } }).session?.id;
    void appendAudit({
      org: deploymentOrg(),
      platform: "ingest",
      workspace: "taint",
      action: TAINT_MODE_ACTION,
      detail: {
        mode: taintMode(),
        ...(typeof sessionId === "string" && sessionId.length > 0 ? { session: sessionId } : {}),
        marking: "disabled",
        fencing: "unchanged",
      },
    }).catch(() => undefined);
    return true;
  } catch {
    return false;
  }
}

const subagentIdentity = defineState<{ org: string; sessionId: string; parent: { sessionId: string; callId: string } | null } | null>(
  "open-everywhere.subagent-taint.identity",
  () => null,
);

function readParentLink(ctx: HookContext): { sessionId: string; callId: string } | null {
  return delegatingParentLink(ctx);
}

function rememberSubagentIdentity(ctx: HookContext): void {
  try {
    const c = ctx as unknown as BindableContext;
    const sessionId = (c as { session?: { id?: string } }).session?.id;
    const child = isSubagentChildContext(c) && typeof sessionId === "string" && sessionId.length > 0;
    const parent = child ? readParentLink(ctx) : null;
    let firstSightingWithParent = false;
    subagentIdentity.update((cur) => {
      if (!child) return null;
      firstSightingWithParent = cur === null && parent !== null;
      return { org: deploymentOrg(), sessionId, parent };
    });
    if (firstSightingWithParent && parent !== null) {
      void claimSubagentCallClean(deploymentOrg(), parent.sessionId, parent.callId);
    }
  } catch {
  }
}

const stickyChildTaint = defineState<readonly string[] | null>("open-everywhere.subagent-taint.sticky", () => null);

function recordStickyChildTaint(): void {
  try {
    if (subagentIdentity.get() === null) return;
    let kinds: readonly string[] = [];
    try {
      kinds = taintKindsThisTurn();
    } catch {
      kinds = [];
    }
    stickyChildTaint.update((cur) => [...new Set([...(cur ?? []), ...kinds])]);
  } catch {
  }
}

export function reseedStickyChildTaint(): boolean {
  if (!taintEnabled()) return false;
  try {
    if (subagentIdentity.get() === null) return false;
    const sticky = stickyChildTaint.get();
    if (sticky === null) return false;
    adoptKinds(sticky.filter((k): k is IngestionKind => (INGESTION_KINDS as readonly string[]).includes(k)));
    return true;
  } catch {
    return false;
  }
}

registerTaintFlipObserver(() => {
  recordTurnTaintForChildren();

  let who: { org: string; sessionId: string; parent: { sessionId: string; callId: string } | null } | null = null;
  try {
    who = subagentIdentity.get();
  } catch {
    who = null;
  }
  if (who === null) return;
  recordStickyChildTaint();
  void markSubagentTainted(who.org, who.sessionId);
  writeCallTaintMarker();
});

let callTaintMarkerQueue: Promise<unknown> = Promise.resolve();

function writeCallTaintMarker(): void {
  let who: { org: string; sessionId: string; parent: { sessionId: string; callId: string } | null } | null = null;
  try {
    who = subagentIdentity.get();
  } catch {
    who = null;
  }
  if (who === null || who.parent === null) return;
  let kinds: readonly string[] = [];
  try {
    kinds = taintKindsThisTurn();
  } catch {
    kinds = [];
  }
  const link = who.parent;
  const org = who.org;
  callTaintMarkerQueue = callTaintMarkerQueue.then(() => markSubagentCallTainted(org, link.sessionId, link.callId, kinds)).catch(() => undefined);
}

registerTaintKindObserver(() => {
  recordTurnTaintForChildren();
  recordStickyChildTaint();
  writeCallTaintMarker();
});

const TAINT_FORWARD_ACTION = "taint.forward";

export const OE_PARENT_TURN_TAINTED_ATTR = "oe_parent_turn_tainted";

export const OE_DISPATCH_TURN_ATTR = "oe_dispatch_turn";

interface ForwardStamp {
  readonly sessionId: string;
  readonly turnId: string;
  readonly kinds: readonly IngestionKind[];
  readonly raw: string;
}

function renderForwardStamp(sessionId: string, turnId: string, kinds: readonly string[]): string {
  const named = kinds.filter((k): k is IngestionKind => (INGESTION_KINDS as readonly string[]).includes(k));
  return named.length > 0 ? `${sessionId}|${turnId}|${named.join(",")}` : `${sessionId}|${turnId}`;
}

function parseForwardStamp(value: unknown): ForwardStamp | null {
  if (typeof value !== "string" || value.length === 0) return null;
  const parts = value.split("|");
  if (parts.length < 2 || parts.length > 3) return null;
  const [sessionId, turnId, tail] = parts;
  if (sessionId === undefined || sessionId.length === 0 || turnId === undefined || turnId.length === 0) return null;
  const kinds = (tail ?? "").split(",").filter((k): k is IngestionKind => (INGESTION_KINDS as readonly string[]).includes(k));
  return { sessionId, turnId, kinds, raw: value };
}

const turnIdentity = defineState<{ org: string; sessionId: string; turnId: string; attrs: Record<string, unknown> | null } | null>(
  "open-everywhere.taint-forward.turn-identity",
  () => null,
);

const turnTaintRecorded = defineState<string | null>("open-everywhere.taint-forward.recorded", () => null);

function writableAuthAttrs(ctx: HookContext): Record<string, unknown> | null {
  try {
    const current = (ctx as { session?: { auth?: { current?: { attributes?: unknown } } } }).session?.auth?.current;
    if (current === undefined || current === null) return null;
    const attrs = current.attributes;
    if (typeof attrs === "object" && attrs !== null) return attrs as Record<string, unknown>;
    const fresh: Record<string, unknown> = {};
    (current as { attributes?: unknown }).attributes = fresh;
    return (current as { attributes?: unknown }).attributes === fresh ? fresh : null;
  } catch {
    return null;
  }
}

function rememberTurnIdentity(ctx: HookContext): void {
  try {
    const c = ctx as unknown as BindableContext;
    const sessionId = (c as { session?: { id?: string } }).session?.id;
    const turnId = currentTurnId(c);
    const attrs = writableAuthAttrs(ctx);
    turnIdentity.update(() =>
      typeof sessionId === "string" && sessionId.length > 0 && typeof turnId === "string" && turnId.length > 0
        ? { org: deploymentOrg(), sessionId, turnId, attrs }
        : null,
    );
  } catch {
  }
}

function refreshTurnIdentity(ctx: HookContext): void {
  try {
    const attrs = writableAuthAttrs(ctx);
    if (attrs === null) return;
    turnIdentity.update((cur) => (cur === null ? cur : { ...cur, attrs }));
  } catch {
  }
}

export function recordTurnTaintForChildren(): boolean {
  try {
    if (!untrustedIngestedThisTurn()) return false;
    const who = turnIdentity.get();
    if (who === null || who.attrs === null) return false;
    const stamp = renderForwardStamp(who.sessionId, who.turnId, taintKindsThisTurn());
    who.attrs[OE_PARENT_TURN_TAINTED_ATTR] = stamp;
    if (who.attrs[OE_PARENT_TURN_TAINTED_ATTR] !== stamp) return false;
    let first = false;
    turnTaintRecorded.update((cur) => {
      if (cur === who.turnId) return cur;
      first = true;
      return who.turnId;
    });
    if (first) {
      void appendAudit({
        org: who.org,
        platform: "ingest",
        workspace: "taint",
        action: TAINT_FORWARD_ACTION,
        detail: { leg: "mark", session: who.sessionId, turn: who.turnId },
      }).catch(() => undefined);
    }
    return true;
  } catch {
    return false;
  }
}

function readParentSession(ctx: HookContext): string | null {
  const sessionId = (ctx as { session?: { parent?: { sessionId?: unknown } } }).session?.parent?.sessionId;
  if (typeof sessionId === "string" && sessionId.length > 0) return sessionId;
  return readParentLink(ctx)?.sessionId ?? null;
}

const adoptedForwardStamps = defineState<readonly string[]>("open-everywhere.taint-forward.adopted-stamps", () => []);

function memoKey(raw: string, turnId: string | undefined): string {
  return typeof turnId === "string" && turnId.length > 0 ? `${raw}@${turnId}` : raw;
}

const MAX_REMEMBERED_STAMPS = 16;

function matchingForwardStamp(ctx: HookContext): ForwardStamp | null {
  try {
    const parentSession = readParentSession(ctx);
    if (parentSession === null) return null;
    const raw = currentAttrs(ctx)?.[OE_PARENT_TURN_TAINTED_ATTR];
    const stamp = parseForwardStamp(Array.isArray(raw) ? raw[0] : raw);
    if (stamp === null || stamp.sessionId !== parentSession) return null;
    {
      const rawPin = currentAttrs(ctx)?.[OE_DISPATCH_TURN_ATTR];
      const pin = parseForwardStamp(Array.isArray(rawPin) ? rawPin[0] : rawPin);
      if (pin === null || pin.sessionId !== parentSession || pin.turnId !== stamp.turnId) return null;
    }
    let ownTurnId: string | undefined;
    try {
      ownTurnId = currentTurnId(ctx as unknown as BindableContext);
    } catch {
      ownTurnId = undefined;
    }
    const memo = adoptedForwardStamps.get();
    if (memo.includes(memoKey(stamp.raw, ownTurnId))) return stamp;
    return memo.some((k) => k === stamp.raw || k.startsWith(`${stamp.raw}@`)) ? null : stamp;
  } catch {
    return null;
  }
}

function recordDispatchTurnForChildren(): boolean {
  try {
    const who = turnIdentity.get();
    if (who === null || who.attrs === null) return false;
    const pin = renderForwardStamp(who.sessionId, who.turnId, []);
    who.attrs[OE_DISPATCH_TURN_ATTR] = pin;
    return who.attrs[OE_DISPATCH_TURN_ATTR] === pin;
  } catch {
    return false;
  }
}

const parentTurnTaintAdopted = defineState<string | null>("open-everywhere.taint-forward.adopted", () => null);

export function adoptedParentTurnTaintThisTurn(ctx: HookContext): boolean {
  try {
    const recorded = parentTurnTaintAdopted.get();
    if (recorded === null) return false;
    let turnId: string | undefined;
    try {
      turnId = currentTurnId(ctx as unknown as BindableContext);
    } catch {
      turnId = undefined;
    }
    if (recorded.length === 0 || typeof turnId !== "string" || turnId.length === 0) return true;
    return recorded === turnId;
  } catch {
    return false;
  }
}

function adoptKinds(kinds: readonly IngestionKind[]): void {
  if (kinds.length === 0) markUntrustedIngestedThisTurn();
  else for (const kind of kinds) markUntrustedIngestedThisTurn(kind);
}

export function adoptParentTurnTaint(ctx: HookContext): boolean {
  if (!taintEnabled()) return false;
  try {
    const stamp = matchingForwardStamp(ctx);
    if (stamp === null) return false;
    let ownTurnId: string | undefined;
    try {
      ownTurnId = currentTurnId(ctx as unknown as BindableContext);
    } catch {
      ownTurnId = undefined;
    }
    parentTurnTaintAdopted.update(() => (typeof ownTurnId === "string" ? ownTurnId : ""));
    adoptedForwardStamps.update((cur) => {
      const key = memoKey(stamp.raw, ownTurnId);
      return cur.includes(key) ? cur : [...cur, key].slice(-MAX_REMEMBERED_STAMPS);
    });
    adoptKinds(stamp.kinds);
    const sessionId = (ctx as { session?: { id?: string } }).session?.id;
    void appendAudit({
      org: deploymentOrg(),
      platform: "ingest",
      workspace: "taint",
      action: TAINT_FORWARD_ACTION,
      detail: {
        leg: "adopt",
        ...(typeof sessionId === "string" && sessionId.length > 0 ? { session: sessionId } : {}),
        parentSession: stamp.sessionId,
        parentTurn: stamp.turnId,
        kinds: [...stamp.kinds],
      },
    }).catch(() => undefined);
    return true;
  } catch {
    return false;
  }
}

export async function adoptSubagentTaint(callId: string, ownSessionId: string): Promise<boolean> {
  if (!taintEnabled()) return false;
  try {
    const record = await subagentCallTaintRecord(deploymentOrg(), ownSessionId, callId);
    if (record?.tainted === false) return false;
    adoptKinds(record?.kinds ?? []);
    return true;
  } catch {
    markUntrustedIngestedThisTurn();
    return true;
  }
}

export const TASK_STARTED_ACTION = "delegation.task_started";

export const TASK_SETTLED_ACTION = "delegation.task_settled";

export const TASK_UNREADABLE_ACTION = "delegation.task_unreadable";

export const DELEGATED_PROVENANCE_ACTION = "delegation.provenance_carried";

export const TASK_FAILED_ACTION = "delegation.task_failed";

type DelegationFailureEdge = "task-settled" | "settlement" | "result";

type DelegationFailureParse = TaskSettledFailure["parse"] | "result";

async function noteDelegationFailure(
  failure: Partial<DelegationFailure> & { readonly status: string },
  taskId: string,
  ownSessionId: string,
  turnId: string | undefined,
  edge: DelegationFailureEdge,
  parse: DelegationFailureParse,
): Promise<void> {
  await appendAudit({
    org: deploymentOrg(),
    platform: "ingest",
    workspace: "delegation",
    action: TASK_FAILED_ACTION,
    detail: {
      task: taskId,
      call: failure.callId ?? "",
      tool: failure.tool ?? "",
      error: auditErrorDetail(failure.errorText ?? "").error,
      errorClass: auditErrorDetail(failure.errorClass ?? "").error,
      parse,
      outcome: edge,
      status: failure.status,
      ...(ownSessionId.length > 0 ? { session: ownSessionId } : {}),
      ...(turnId !== undefined && turnId.length > 0 ? { turn: turnId } : {}),
    },
  }).catch(() => undefined);
}

const WORKER_TURN_FAILED_ACTION = "delegation.worker_turn_failed";

interface TurnFailedData {
  readonly code?: unknown;
  readonly message?: unknown;
  readonly details?: unknown;
}

function dispatchingParentSession(link: TaskCallLink, ownSessionId: string): string {
  return link.parentSessionId !== undefined && link.parentSessionId.length > 0 ? link.parentSessionId : ownSessionId;
}

export async function noteTaskStarted(receipt: TaskStarted, ownSessionId: string, workRequestId?: string): Promise<TaskCallLink | null> {
  const org = deploymentOrg();
  let link: TaskCallLink | null = null;
  let continuation = false;
  let replay = false;
  try {
    if (taintEnabled() && ownSessionId.length > 0) {
      const already = await taskCallLink(org, receipt.taskId);
      if (already !== undefined) {
        replay = already.callId === receipt.callId;
        continuation = !replay;
        link = already;
      } else {
        link = {
          callId: receipt.callId,
          childToken: `subagent:${ownSessionId}:${receipt.callId}`,
          parentSessionId: ownSessionId,
          kind: receipt.kind,
          ...(receipt.tool.length > 0 ? { tool: receipt.tool } : {}),
        };
        await rememberTaskCall(org, receipt.taskId, link);
      }
    }
  } catch {
  }
  if (replay) return link;
  void appendAudit({
    org,
    platform: "ingest",
    workspace: "delegation",
    action: TASK_STARTED_ACTION,
    detail: {
      task: receipt.taskId,
      call: receipt.callId,
      kind: receipt.kind,
      tool: receipt.tool,
      ...(ownSessionId.length > 0 ? { session: ownSessionId } : {}),
      continuation,
      ...(workRequestId !== undefined ? { request: workRequestId } : {}),
    },
  }).catch(() => undefined);
  return link;
}

export async function noteAgentStarted(opened: AgentStarted, ownSessionId: string): Promise<void> {
  try {
    if (!taintEnabled() || ownSessionId.length === 0 || opened.taskId === null) return;
    const org = deploymentOrg();
    const link = await taskCallLink(org, opened.taskId);
    if (link === undefined || link.agentId !== undefined) return;
    await rememberTaskCall(org, opened.taskId, { ...link, agentId: opened.sessionId });
  } catch {
  }
}

function noteUnreadableTaskEvent(edge: "task.started" | "task.settled", data: unknown, ownSessionId: string): void {
  const raw = data as { taskId?: unknown; status?: unknown; kind?: unknown } | null;
  const bounded = (v: unknown): string => (typeof v === "string" ? auditErrorDetail(v).error : "");
  void appendAudit({
    org: deploymentOrg(),
    platform: "ingest",
    workspace: "delegation",
    action: TASK_UNREADABLE_ACTION,
    detail: {
      edge,
      marker: "unreadable",
      adopted: false,
      task: bounded(raw?.taskId),
      status: bounded(raw?.status),
      kind: bounded(raw?.kind),
      ...(ownSessionId.length > 0 ? { session: ownSessionId } : {}),
    },
  }).catch(() => undefined);
}

export const DISPATCH_UNAUTHORIZED_ACTION = "delegation.dispatch_unauthorized";

function noteDispatchAuthorityLost(
  edge: "actions.requested" | "task.started",
  taskId: string,
  callId: string,
  ownSessionId: string,
  reason: string,
): void {
  console.warn(
    `[open-everywhere:spawn-taint] delegated dispatch has NO exact wake at ${edge} (${reason}) — ` +
      `no dispatch-authority row is written, so no task wake is minted and this settlement will ` +
      `install no reply address: the reply fence refuses it under \`task-wake-unread\`. Taint is ` +
      `unaffected and still carries on the call-keyed marker. The child still launches: eve 0.70 ` +
      `offers this seat no edge that can refuse it.`,
  );
  void appendAudit({
    org: deploymentOrg(),
    platform: "ingest",
    workspace: "delegation",
    action: DISPATCH_UNAUTHORIZED_ACTION,
    detail: {
      edge,
      reason,
      marker: "unauthorized",
      adopted: false,
      ...(taskId.length > 0 ? { task: taskId } : {}),
      call: callId,
      ...(ownSessionId.length > 0 ? { session: ownSessionId } : {}),
    },
  }).catch(() => undefined);
}

export async function adoptTaskTaint(view: TaskSummary, ownSessionId: string): Promise<boolean> {
  const org = deploymentOrg();
  let marker: "clean" | "tainted" | "lost" | "off" = "off";
  let adopted = false;
  let kinds: readonly IngestionKind[] = [];
  try {
    if (taintEnabled()) {
      const link = await taskCallLink(org, view.taskId);
      if (link === undefined) {
        marker = "lost";
      } else {
        const recorded = link.parentSessionId;
        if (recorded !== undefined && recorded.length > 0 && recorded !== ownSessionId) {
          marker = "lost";
        } else {
          const parentSession = dispatchingParentSession(link, ownSessionId);
          const record = await subagentCallTaintRecord(org, parentSession, link.callId);
          marker = record === undefined ? "lost" : record.tainted ? "tainted" : "clean";
          if (record?.tainted === true) kinds = record.kinds;
        }
      }
      if (marker !== "clean") {
        adoptKinds(kinds);
        adopted = true;
      }
    }
  } catch {
    marker = "lost";
    kinds = [];
    markUntrustedIngestedThisTurn();
    adopted = true;
  }
  void appendAudit({
    org,
    platform: "ingest",
    workspace: "delegation",
    action: TASK_SETTLED_ACTION,
    detail: {
      task: view.taskId,
      status: view.status,
      ...(ownSessionId.length > 0 ? { session: ownSessionId } : {}),
      agent: view.agentId ?? "",
      marker,
      adopted,
      kinds: [...kinds],
    },
  }).catch(() => undefined);
  return adopted;
}

export type SettlementFromEvent = {
  readonly failure?: TaskSettledFailure;
  readonly link?: TaskCallLink;
  readonly links?: ReadonlyMap<string, TaskCallLink | undefined>;
  readonly taskSettled?: boolean;
  readonly authorizeRedispatch?: boolean;
};

export async function applyTaskSettlement(
  views: readonly TaskSummary[],
  ownSessionId: string,
  ctx: HookContext,
  settlement: SettlementFromEvent = {},
): Promise<boolean> {
  if (views.length === 0) return false;
  const failure = views.length === 1 ? settlement.failure : undefined;
  const edge: DelegationFailureEdge = settlement.taskSettled === true || failure !== undefined ? "task-settled" : "settlement";
  const settlementLink = views.length === 1 ? settlement.link : undefined;
  const bind = ctx as unknown as BindableContext;
  const inheritedWakeId = inheritedWakeStampOf(bind);
  const wakeTurnId = currentTurnId(bind);
  for (const view of views) noteDelegationSettled(wakeTurnId, view.taskId);
  for (const view of views) await clearGenerationDelegation(deploymentOrg(), view.taskId);
  let seatSurfaceKey: string | undefined;
  try {
    seatSurfaceKey = resolvePartition(bind).surfaceKey;
  } catch {
    seatSurfaceKey = undefined;
  }
  for (const view of views) {
    const link = settlement.links?.has(view.taskId)
      ? settlement.links.get(view.taskId)
      : settlementLink !== undefined
        ? settlementLink
        : await taskCallLink(deploymentOrg(), view.taskId);
    const install = await installTaskWake({
      org: deploymentOrg(),
      taskId: view.taskId,
      status: view.status,
      sessionId: ownSessionId,
      turnId: wakeTurnId,
      inheritedWakeId,
    });
    if (edge === "task-settled" && settlement.authorizeRedispatch === true) {
      noteSettlementDispatchAuthority(
        wakeTurnId,
        view.taskId,
        install.outcome === "installed" || install.outcome === "already" ? install.dispatchAuthority : undefined,
      );
    }
    const armsReport =
      install.outcome === "installed" ||
      (install.outcome === "ingressed" && install.sameSession === true && settlementReportOwedOn(wakeTurnId) === undefined);
    if (armsReport && claimPromisedReport(view.taskId)) {
      noteSettlementReportOwed(wakeTurnId, view.taskId, install.wakeId ?? undefined);
    }
    const carriedBySeat = view.status === "completed" && isWorkSessionContext(bind);
    if (link !== undefined && !carriedBySeat) {
      const reach = stampReadReach(bind, wakeTurnId, seatSurfaceKey);
      const wakeProvable =
        reach.proof !== "wake" ||
        (install.wakeId !== null && reach.wakeId === install.wakeId) ||
        (await heldTurnWakeProvable({
          org: deploymentOrg(),
          outcome: install.outcome,
          sameSession: install.sameSession,
          taskWakeId: install.wakeId,
          turnWakeId: reach.wakeId,
        }));
      const provable = view.status === "completed" && wakeProvable;
      const alsoWakeId =
        provable && reach.proof === "wake"
          ? await delegatedSecondAddress({
              org: deploymentOrg(),
              taskWakeId: install.wakeId,
              inheritedWakeId,
              outcome: install.outcome,
            })
          : undefined;
      const spend = await settleDelegatedReads({
        org: deploymentOrg(),
        childToken: link.childToken,
        sessionId: currentSessionId(bind),
        turnId: wakeTurnId,
        reach: provable ? { ...reach, ...(alsoWakeId !== undefined ? { alsoWakeId } : {}) } : undefined,
      });
      if (spend.found > 0) {
        void appendAudit({
          org: deploymentOrg(),
          platform: "ingest",
          workspace: "delegation",
          action: DELEGATED_PROVENANCE_ACTION,
          detail: {
            task: view.taskId,
            call: link.callId,
            reads: spend.carried,
            found: spend.found,
            outcome: provable ? "carried" : view.status !== "completed" ? "not-completed" : "wake-unprovable",
            proof: reach.proof,
            ...(ownSessionId.length > 0 ? { session: ownSessionId } : {}),
            ...(wakeTurnId !== undefined && wakeTurnId.length > 0 ? { turn: wakeTurnId } : {}),
          },
        }).catch(() => undefined);
      }
    }
    if (view.status === "failed") {
      await noteDelegationFailure(
        {
          status: view.status,
          errorText: failure?.errorText ?? "",
          errorClass: failure?.errorClass ?? "",
          ...(link !== undefined ? { callId: link.callId, tool: link.tool ?? "" } : {}),
        },
        view.taskId,
        ownSessionId,
        wakeTurnId,
        edge,
        failure?.parse ?? "none",
      );
    }
  }
  let any = false;
  for (const view of views) any = (await adoptTaskTaint(view, ownSessionId)) || any;
  if (any) recordTurnTaintForChildren();
  return any;
}

export async function settleFromTaskSettled(settled: TaskSettled, ownSessionId: string, ctx: HookContext): Promise<boolean> {
  let view = settledTaskSummary(settled);
  const links = new Map<string, TaskCallLink | undefined>();
  try {
    links.set(view.taskId, await taskCallLink(deploymentOrg(), view.taskId));
  } catch {
    links.set(view.taskId, undefined);
  }
  const link = links.get(view.taskId);
  if (link?.agentId !== undefined) view = { ...view, agentId: link.agentId };
  noteTaskSettled(view);
  return applyTaskSettlement([view], ownSessionId, ctx, {
    taskSettled: true,
    links,
    authorizeRedispatch: true,
    failure: taskSettledFailure(settled),
  });
}

function deliveryAttr(ctx: BindableContext, key: string): string | undefined {
  const v = (ctx as { session?: { auth?: { current?: { attributes?: Record<string, unknown> } } } }).session?.auth?.current?.attributes?.[key];
  const first = Array.isArray(v) ? v[0] : v;
  return typeof first === "string" && first.length > 0 ? first : undefined;
}

function adoptWorkResultWrites(bind: BindableContext): void {
  try {
    if (isSubagentChildContext(bind) || isWorkSessionContext(bind)) return;
    if (deliveryAttr(bind, OE_WORK_RESULT_ATTR) === undefined) return;
    adoptCarriedWrites(currentTurnId(bind), deliveryAttr(bind, OE_WORK_RESULT_WRITES_ATTR));
  } catch {
  }
}

function noteWorkResultReportOwed(bind: BindableContext): void {
  try {
    if (isSubagentChildContext(bind) || isWorkSessionContext(bind)) return;
    const requestId = deliveryAttr(bind, OE_WORK_RESULT_ATTR);
    if (requestId === undefined) return;
    const promisedHere = claimPromisedReport(workLedgerId(requestId));
    const stamped = deliveryAttr(bind, OE_WORK_RESULT_OWED_ATTR) === "true";
    if (promisedHere || stamped) noteSettlementReportOwed(currentTurnId(bind), workLedgerId(requestId), currentWakeId(bind));
  } catch {
  }
}

async function spendWorkResultReads(bind: BindableContext, childToken: string, requestId: string): Promise<void> {
  const org = deploymentOrg();
  if (!/^subagent:[^:]+:[^:]+$/.test(childToken)) return;
  const turnId = currentTurnId(bind);
  const row = await readWorkRequest(getOperationalStore(), org, requestId).catch(() => undefined);
  if (row === undefined) return;
  const ownToken = resolveOwnWindowToken(bind);
  const ownWork = ownToken === undefined ? undefined : workTokenForSeat(ownToken);
  if (ownWork === undefined || workTokenForSeat(row.seatToken) !== ownWork) return;
  const reach = stampReadReach(bind, turnId, undefined);
  const alsoWakeId = reach.proof === "wake" && reach.wakeId !== row.wakeId ? row.wakeId : undefined;
  const sessionId = currentSessionId(bind);
  const spend = await settleDelegatedReads({
    org,
    childToken,
    sessionId,
    turnId,
    reach: reach.proof === "none" ? undefined : { ...reach, ...(alsoWakeId !== undefined ? { alsoWakeId } : {}) },
    ...(sessionId !== undefined && turnId !== undefined && turnId.length > 0 ? { replayKey: `${sessionId}:${turnId}` } : {}),
  });
  if (spend.found > 0) {
    void appendAudit({
      org,
      platform: "ingest",
      workspace: "delegation",
      action: DELEGATED_PROVENANCE_ACTION,
      detail: {
        request: requestId,
        reads: spend.carried,
        found: spend.found,
        outcome: spend.carried > 0 ? "carried" : "wake-unprovable",
        proof: reach.proof,
        ...(turnId !== undefined && turnId.length > 0 ? { turn: turnId } : {}),
      },
    }).catch(() => undefined);
  }
}

async function settleWorkJobStatus(settled: TaskSettled): Promise<void> {
  try {
    const org = deploymentOrg();
    const store = getOperationalStore();
    const requestId = await readWorkTaskRequest(store, org, settled.taskId);
    if (requestId === undefined) return;
    const row = await readWorkRequest(store, org, requestId).catch(() => undefined);
    const redeemed = await workCancelTicketRedeemed(org, store, row, settled);
    await noteWorkJobSettled({ requestId, taskId: settled.taskId, status: settledWorkJobStateFor(settled.status, redeemed) });
  } catch {
  }
}

async function workCancelTicketRedeemed(org: string, store: ReturnType<typeof getOperationalStore>, row: WorkRequestRow | undefined, settled: TaskSettled): Promise<boolean> {
  if (settled.status !== "completed") return false;
  const holding = row === undefined ? undefined : await workTokenHoldingTask(org, row.seatToken, settled.taskId, store).catch(() => undefined);
  const tokens = [...new Set([currentWorkSessionToken(), holding, row === undefined ? undefined : workTokenForSeat(row.seatToken)])].filter((t): t is string => t !== undefined);
  for (const t of tokens) if (await workCancelRedeemed(store, org, t, settled.taskId)) return true;
  return false;
}

async function wakeSeatWithWorkResult(settled: TaskSettled, event: unknown, ctx: HookContext): Promise<void> {
  const org = deploymentOrg();
  const store = getOperationalStore();
  const requestId = await readWorkTaskRequest(store, org, settled.taskId);
  const row = requestId === undefined ? undefined : await readWorkRequest(store, org, requestId);
  const audit = (detail: Record<string, unknown>) =>
    appendAudit({ org, platform: "unified", workspace: "delegation", action: WORK_RESULT_WAKE_ACTION, detail: { taskId: settled.taskId, ...(requestId !== undefined ? { requestId } : {}), status: settled.status, ...detail } }).catch(() => undefined);
  if (requestId === undefined || row === undefined) {
    await audit({ outcome: "skipped", reason: requestId === undefined ? "no-request-for-task" : "request-row-missing" });
    return;
  }
  const key = await readWorkTaskKey(store, org, settled.taskId);
  if (key === undefined || key.verdict !== "keyed" || key.requestId !== requestId) {
    await flushWorkSettlement(ctx, settled.taskId);
    await wakeSeatNeedsReissue({ requestId, edge: "task.started", reason: key?.reason ?? "stamp-absent", taskId: settled.taskId });
    await clearGenerationDelegation(org, workSessionLedgerId(requestId), store).catch(() => undefined);
    await audit({ outcome: "withheld", reason: key === undefined ? "task-unkeyed" : (key.reason ?? "key-mismatch") });
    return;
  }
  const status = settled.status === "completed" ? "completed" : settled.status === "cancelled" ? "cancelled" : "failed";
  console.log(`[open-everywhere:work] task ${settled.taskId} settled ${settled.status}${settled.cancelReason ? ` (cancel: ${settled.cancelReason})` : ""}${settled.errorText ? ` — ${settled.errorText.slice(0, 160)}` : ""} → result wake for request ${requestId}`);
  const output = (event as { data?: { output?: unknown } } | undefined)?.data?.output;
  const sequence = (event as { sequence?: unknown } | undefined)?.sequence;
  const settlementSeq = `${settled.callId}:${typeof sequence === "number" || typeof sequence === "string" ? String(sequence) : "0"}`;
  const tainted = row.tainted || untrustedIngestedThisTurn();
  const childToken = (await taskCallLink(org, settled.taskId).catch(() => undefined))?.childToken;
  const stop = childToken === undefined ? undefined : await readWorkStop(org, childToken, settled.callId);
  const readsToken = status === "completed" && stop === undefined ? childToken : undefined;
  const wakeId = row.fire !== undefined ? row.wakeId : mintWakeId();
  const seatToken = await currentSeatToken(org, row.seatToken, store);
  const bareToken = (t: string): string => (t.startsWith("unified:") ? t.slice("unified:".length) : t);
  const seatRotated = row.fire === undefined && bareToken(seatToken) !== bareToken(row.seatToken);
  const rotatedBrief = seatRotated ? await readWorkBrief(store, org, requestId) : undefined;
  await flushWorkSettlement(ctx, settled.taskId);
  const memoryWrites = factWritesThisTurn(currentTurnId(ctx as unknown as BindableContext));
  const silentFire = row.fire !== undefined && !row.fire.owesRoom;
  let delivered = false;
  let reportOwed = false;
  const ran = await postWorkResultOnce({
    org,
    taskId: settled.taskId,
    settlementSeq,
    requestId,
    run: async () => {
      const foldAs = row.fire === undefined ? undefined : fireFoldOutcome(status, stop !== undefined, await workCancelTicketRedeemed(org, store, row, settled));
      if (foldAs !== undefined) await foldWorkFire(row, foldAs, { org, sessionId: (ctx as { session?: { id?: string } }).session?.id ?? "" });
      if (silentFire) return;
      reportOwed = row.fire === undefined && (await workReportPromised(store, org, requestId));
      delivered = await dispatchWorkResult({
        seatToken,
        wakeId,
        message: renderWorkResultWake({
          wakeId,
          origin: row.origin,
          requestId,
          taskId: settled.taskId,
          status,
          text: stop === undefined ? workResultText(output, settled.errorText) : "[the host stopped the worker before it ran, so it reported nothing]",
          nowIso: new Date().toISOString(),
          dispatchWakeId: row.wakeId,
          ...(stop !== undefined ? { stopRefusal: stop.refusal } : {}),
          ...(row.fire !== undefined ? { fire: true as const } : {}),
          ...(seatRotated ? { rotated: { forwardedAtIso: row.atIso, ...(rotatedBrief !== undefined ? { brief: rotatedBrief } : {}) } } : {}),
        }),
        origin: row.origin,
        surfaceKey: row.surfaceKey,
        binding: row.binding,
        requester: row.requester,
        nonMemberWake: row.nonMemberWake,
        requestId,
        tainted,
        ...(tainted ? { taintKinds: taintKindsThisTurn() } : {}),
        ...(readsToken !== undefined && readsToken.length > 0 ? { readsToken } : {}),
        ...(row.fire?.posture !== undefined ? { invokerPosture: row.fire.posture } : {}),
        ...(row.fire?.creator !== undefined ? { fireCreator: row.fire.creator } : {}),
        ...(memoryWrites.length > 0 ? { memoryWrites } : {}),
        ...(reportOwed ? { reportOwed: true } : {}),
      });
    },
  });
  if (ran && delivered && reportOwed) await spendWorkReportPromise(store, org, requestId, new Date().toISOString()).catch(() => undefined);
  if (ran && delivered) await clearGenerationDelegation(org, workLedgerId(requestId), store);
  if (ran) await clearGenerationDelegation(org, workSessionLedgerId(requestId), store);
  if (ran && delivered && stop !== undefined && childToken !== undefined) await forgetWorkStop(org, childToken);
  await audit(
    !ran
      ? { outcome: "replay-skipped" }
      : silentFire
        ? { outcome: "silent-fire", fire: true }
        : { outcome: delivered ? "delivered" : "failed", wakeId, tainted, reportOwed, seatRotated, ...(row.fire !== undefined ? { fire: true } : {}), ...(stop !== undefined ? { stoppedBy: "egress-own-account", connector: stop.connector } : {}) },
  );
}

export default defineHook({
  events: {
    "turn.started": (_event, ctx) => {
      openTaintTurn(ctx);
      noteContinuationTurn(ctx as unknown as BindableContext);
      const bind = ctx as unknown as BindableContext;
      noteTurnBoundary(currentTurnId(bind), deliveryStampOf(bind));
      noteTurnOpeningPrincipal(bind);
      noteWorkResultReportOwed(bind);
      adoptWorkResultWrites(bind);
      clearStreamDropRetries();
    },

    "step.started": (_event, ctx) => {
      try {
        refreshTurnIdentity(ctx);
        recordDispatchTurnForChildren();
        recordTurnTaintForChildren();
      } catch {
      }
      try {
        const bind = ctx as unknown as BindableContext;
        noteStepDelivery(currentTurnId(bind), deliveryStampOf(bind));
      } catch {
      }
    },

    "task.started": async (event, ctx) => {
      try {
        if (isSubagentChildContext(ctx as unknown as BindableContext)) return;
        const ownSessionId = (ctx as { session?: { id?: string } }).session?.id;
        if (typeof ownSessionId !== "string" || ownSessionId.length === 0) return;
        const started = readTaskStarted((event as { data?: unknown }).data);
        if (started === null) {
          noteUnreadableTaskEvent("task.started", (event as { data?: unknown }).data, ownSessionId);
          return;
        }
        const workCtx = isWorkSessionContext(ctx as unknown as BindableContext);
        const joinedRequest = workCtx ? await readWorkCall(getOperationalStore(), deploymentOrg(), ownSessionId, started.callId) : undefined;
        const workRequestId = workCtx
          ? (joinedRequest ?? (workRequestsThisTurn(currentTurnId(ctx as unknown as BindableContext)).length === 0 ? deliveryAttr(ctx as unknown as BindableContext, OE_WORK_REQUEST_ATTR) : undefined))
          : undefined;
        await noteTaskStarted(started, ownSessionId, workRequestId);
        if (workRequestId !== undefined) {
          await rememberWorkTask(getOperationalStore(), deploymentOrg(), started.taskId, workRequestId, new Date().toISOString());
          await keyWorkTask({ taskId: started.taskId, callId: started.callId, workSessionId: ownSessionId, joined: workRequestId, stamped: deliveryAttr(ctx as unknown as BindableContext, OE_WORK_REQUEST_ATTR) });
          await noteWorkJobStarted({ requestId: workRequestId, taskId: started.taskId });
        }
        const bind = ctx as unknown as BindableContext;
        const dispatchTurnId = currentTurnId(bind);
        const prelaunchAuthority = await delegatedTaskDispatchAuthority(deploymentOrg(), ownSessionId, started.callId);
        if (isUnifiedWindowContext(bind) && prelaunchAuthority === undefined) {
          noteDispatchAuthorityLost("task.started", started.taskId, started.callId, ownSessionId, "authority-row-absent-at-task-started");
          return;
        }
        const dispatchWakeId = prelaunchAuthority?.wakeId;
        await recordTaskOpening({ org: deploymentOrg(), parentSessionId: ownSessionId, taskId: started.taskId, callId: started.callId, tool: started.tool, wakeId: dispatchWakeId });
        const ownWindowToken = resolveOwnWindowToken(bind);
        const minted = await openTaskWake({
          org: deploymentOrg(),
          taskId: started.taskId,
          parentWakeId: dispatchWakeId,
          windowToken: ownWindowToken,
        });
        if (minted !== null && prelaunchAuthority !== undefined) {
          await advanceDelegatedTaskWake(deploymentOrg(), ownSessionId, started.callId, started.taskId, minted, prelaunchAuthority);
          const opening = await readTaskOpening(deploymentOrg(), ownSessionId, started.taskId);
          if (opening !== undefined && opening.openingCallId !== started.callId) {
            await rememberDelegatedTaskWake(deploymentOrg(), ownSessionId, opening.openingCallId, minted);
          }
        }
        {
          const opening = await readTaskOpening(deploymentOrg(), ownSessionId, started.taskId);
          if (opening !== undefined && opening.openingCallId !== started.callId) {
            await noteTaskClaimDispatched(deploymentOrg(), ownSessionId, started.taskId, started.callId, dispatchTurnId);
          }
        }
        await noteGenerationDelegation(deploymentOrg(), ownWindowToken, started.taskId);
        if (minted !== null) noteTaskDispatchedThisTurn(dispatchTurnId, started.taskId, minted);
        notePendingDelegation(dispatchTurnId, started.taskId, dispatchWakeId);
        noteTaskDispatched(started.taskId);
      } catch {
      }
    },

    "agent.started": async (event, ctx) => {
      try {
        if (isSubagentChildContext(ctx as unknown as BindableContext)) return;
        const ownSessionId = (ctx as { session?: { id?: string } }).session?.id;
        if (typeof ownSessionId !== "string" || ownSessionId.length === 0) return;
        const opened = readAgentStarted((event as { data?: unknown }).data);
        if (opened === null || opened.taskId === null) return;
        await noteAgentStarted(opened, ownSessionId);
      } catch {
      }
    },

    "task.settled": async (event, ctx) => {
      try {
        if (isSubagentChildContext(ctx as unknown as BindableContext)) return;
        const ownSessionId = (ctx as { session?: { id?: string } }).session?.id;
        if (typeof ownSessionId !== "string" || ownSessionId.length === 0) return;
        const settled = readTaskSettled((event as { data?: unknown }).data);
        if (settled === null) {
          noteUnreadableTaskEvent("task.settled", (event as { data?: unknown }).data, ownSessionId);
          return;
        }
        await noteTaskProvenanceSettled(deploymentOrg(), ownSessionId, settled.taskId);
        await settleFromTaskSettled(settled, ownSessionId, ctx);
        if (isWorkSessionContext(ctx as unknown as BindableContext)) {
          try {
            await wakeSeatWithWorkResult(settled, event, ctx);
          } finally {
            await settleWorkJobStatus(settled);
          }
        }
      } catch {
      }
    },

    "turn.completed": async (_event, ctx) => {
      try {
        await flushDirtyTreeAtTurnEnd(ctx as unknown as MemoryPersistContext);
      } catch {
      }
    },

    "turn.failed": async (event, ctx) => {
      try {
        const bind = ctx as unknown as BindableContext;
        if (!isSubagentChildContext(bind)) return;
        const ownSessionId = (ctx as { session?: { id?: string } }).session?.id;
        const data = (event as { data?: TurnFailedData }).data;
        const turnId = currentTurnId(bind);
        await appendAudit({
          org: deploymentOrg(),
          platform: "ingest",
          workspace: "delegation",
          action: WORKER_TURN_FAILED_ACTION,
          detail: {
            code: auditErrorDetail(typeof data?.code === "string" ? data.code : "").error,
            error: auditErrorDetail(typeof data?.message === "string" ? data.message : "").error,
            frames: auditErrorFrames(data?.details),
            ...(typeof ownSessionId === "string" && ownSessionId.length > 0 ? { session: ownSessionId } : {}),
            ...(turnId !== undefined && turnId.length > 0 ? { turn: turnId } : {}),
            ...(streamDropRetriesThisTurn() > 0 ? { retried: streamDropRetriesThisTurn() } : {}),
          },
        }).catch(() => undefined);
      } catch {
      }
    },

    "actions.requested": async (event, ctx) => {
      if (isSubagentChildContext(ctx as unknown as BindableContext)) return;
      const ownSessionId = (ctx as { session?: { id?: string } }).session?.id;
      if (typeof ownSessionId !== "string" || ownSessionId.length === 0) return;
      const bind = ctx as unknown as BindableContext;
      const turnId = currentTurnId(bind);
      if (!isWorkSessionContext(bind)) {
        const readsToken = deliveryAttr(bind, OE_WORK_RESULT_READS_ATTR);
        const resultRequest = deliveryAttr(bind, OE_WORK_RESULT_ATTR);
        if (readsToken !== undefined && resultRequest !== undefined) {
          await spendWorkResultReads(bind, readsToken, resultRequest).catch(() => undefined);
        }
      }
      const actions = (event.data as { actions?: readonly { kind?: unknown; callId?: unknown; toolName?: unknown; input?: unknown }[] } | undefined)?.actions ?? [];
      for (const action of actions) {
        const delegated = action.kind === "subagent-call" || (action.kind === "tool-call" && action.toolName === "agent");
        if (delegated && typeof action.callId === "string" && action.callId.length > 0 && isWorkSessionContext(bind)) {
          const open = workRequestsThisTurn(turnId);
          if (open.length > 0) {
            const message = action.input !== null && typeof action.input === "object" ? (action.input as Record<string, unknown>)["message"] : undefined;
            const join = claimWorkCall(turnId, message, deliveryAttr(bind, OE_WORK_REQUEST_ATTR));
            if (join.kind !== "joined") {
              noteDispatchAuthorityLost("actions.requested", "", action.callId, ownSessionId, "work-request-unjoinable");
              continue;
            }
            const ownWorkToken = resolveOwnWindowToken(bind);
            const ownWorkBare = ownWorkToken === undefined ? undefined : (bareTokenFromEveContext(ownWorkToken) ?? ownWorkToken);
            const owned = await readWorkRequest(getOperationalStore(), deploymentOrg(), join.requestId).catch(() => undefined);
            if (owned === undefined || ownWorkBare === undefined || !isSameWorkSession(workTokenForSeat(owned.seatToken), ownWorkBare)) {
              noteDispatchAuthorityLost("actions.requested", "", action.callId, ownSessionId, "work-request-unowned");
              continue;
            }
            try {
              await rememberDelegatedTaskWake(deploymentOrg(), ownSessionId, action.callId, join.requestId);
              await rememberWorkCall(getOperationalStore(), deploymentOrg(), ownSessionId, action.callId, join.requestId, new Date().toISOString());
            } catch {
              noteDispatchAuthorityLost("actions.requested", "", action.callId, ownSessionId, "dispatch-wake-not-durable");
            }
            continue;
          }
        }
        if (delegated && typeof action.callId === "string" && action.callId.length > 0) {
          const settlement = settlementDispatchAuthorityThisTurn(turnId);
          const uningressedUnifiedTurn = isUnifiedWindowContext(bind) && uningressedTurn(turnId);
          const settlementTurn =
            uningressedUnifiedTurn && (settlement.kind !== "none" || taskWakeThisTurn(turnId) !== undefined);
          if (settlementTurn && settlement.kind !== "single") {
            noteDispatchAuthorityLost("actions.requested", "", action.callId, ownSessionId, settlement.kind === "none" ? "settlement-turn-no-authority" : "settlement-turn-ambiguous-authority");
            continue;
          }
          const settlementAuthority = settlement.kind === "single" ? settlement.authority : undefined;
          const wakeId = settlementTurn
            ? settlementAuthority?.wakeId
            : addressedWakeThisTurn(turnId) ?? exactDispatchWakeThisTurn(turnId);
          if (wakeId !== undefined) {
            try {
              await rememberDelegatedTaskWake(deploymentOrg(), ownSessionId, action.callId, wakeId);
            } catch {
              noteDispatchAuthorityLost("actions.requested", "", action.callId, ownSessionId, "dispatch-wake-not-durable");
              continue;
            }
          }
          else if (!isUnifiedWindowContext(bind)) {
            if (liveAuthIsAnotherPrincipal(bind)) {
              noteDispatchAuthorityLost("actions.requested", "", action.callId, ownSessionId, "in-turn-principal-swap");
              continue;
            }
            const requester = requesterThisTurn(turnId);
            const nonMemberWake = (bind as { session?: { auth?: { current?: { attributes?: Record<string, unknown> } } } }).session?.auth?.current?.attributes?.[OE_CHAT_NONMEMBER_ATTR] === "true";
            await rememberDelegatedTaskBinding(deploymentOrg(), ownSessionId, action.callId, bindFrom(bind), requester, nonMemberWake);
          }
          else {
            noteDispatchAuthorityLost("actions.requested", "", action.callId, ownSessionId, "unified-turn-no-wake");
            continue;
          }
        }
      }
    },

    "action.result": async (event, ctx) => {
      try {
        if (isSubagentChildContext(ctx as unknown as BindableContext)) return;
        const result = (event.data as { result?: { kind?: unknown; callId?: unknown } } | undefined)?.result;
        const ownSessionId = (ctx as { session?: { id?: string } }).session?.id;
        if (typeof ownSessionId !== "string" || ownSessionId.length === 0) return;

        const failure = readDelegationFailure(result);
        if (failure !== null) {
          await noteDelegationFailure(failure, "", ownSessionId, currentTurnId(ctx as unknown as BindableContext), "result", "result");
        }

        if (result?.kind !== "subagent-result" || typeof result.callId !== "string") return;
        if (await adoptSubagentTaint(result.callId, ownSessionId)) {
          recordTurnTaintForChildren();
        }
        await flushSettledMemory(ctx as unknown as MemoryPersistContext, "delegation-returned");
      } catch {
      }
    },
  },
});
