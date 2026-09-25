import { defineHook, type HookContext } from "eve/hooks";
import { defineState } from "eve/context";
import { OE_SPAWN_TAINTED_ATTR } from "../channels/unified.js";
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
  rememberTaskAgent,
  taskCallLink,
  taskAgentLink,
  type TaskCallLink,
} from "../access/subagent-taint.js";
import {
  readDelegationFailure,
  readTaskReceipt,
  taskNotificationFailure,
  taskNotificationStartsWithTerminal,
  taskViewsOf,
  terminalTaskNotifications,
  terminalTaskViewsOf,
  type DelegationFailure,
  type TaskNotificationFailure,
  type TaskReceipt,
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
  deliveryStampOf,
  deploymentOrg,
  inheritedWakeStampOf,
  isSubagentChildContext,
  isUnifiedWindowContext,
  type BindableContext,
} from "../identity/binding.js";
import { resolveOwnWindowToken } from "../access/delegation-mount.js";
import { advanceDelegatedTaskWake, delegatedTaskDispatchAuthority, installTaskWake, openTaskWake, rememberDelegatedTaskBinding, rememberDelegatedTaskWake } from "../channels/task-wake.js";
import { noteTurnBoundary, taskWakeThisTurn, uningressedTurn } from "../access/task-wake-signal.js";
import { clearStreamDropRetries, streamDropRetriesThisTurn } from "../model/stream-drop-retry.js";
import { addressedWakeThisTurn, exactDispatchWakeThisTurn, noteTaskDispatchedThisTurn } from "../access/dispatch-origin-signal.js";
import { requesterThisTurn } from "../access/requester-identity.js";
import { noteSettlementDispatchAuthority, settlementDispatchAuthorityThisTurn } from "../access/settlement-dispatch-signal.js";
import { claimPromisedReport, notePendingDelegation, noteDelegationSettled, noteSettlementReportOwed } from "../access/pending-delegation-signal.js";
import { clearGenerationDelegation, noteGenerationDelegation } from "../channels/generation-retirement.js";
import { delegatedSecondAddress, delegatingParentLink, settleDelegatedReads } from "../channels/delegated-provenance.js";
import { stampReadReach } from "../channels/read-reach.js";
import { resolvePartition } from "../memory/partition.js";
import { flushDirtyTreeAtTurnEnd, flushSettledMemory, noteTaskDispatched, noteTaskSettled, noteTaskViews } from "./settlement-flush.js";
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
        markUntrustedIngestedThisTurn();
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
  seedIfTainted(ctx);
  adoptParentTurnTaint(ctx);
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

registerTaintFlipObserver(() => {
  recordTurnTaintForChildren();

  let who: { org: string; sessionId: string; parent: { sessionId: string; callId: string } | null } | null = null;
  try {
    who = subagentIdentity.get();
  } catch {
    who = null;
  }
  if (who === null) return;
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

function laterTurnOfSameChild(ctx: HookContext): boolean {
  const seq = (ctx as { session?: { turn?: { sequence?: unknown } } }).session?.turn?.sequence;
  return typeof seq === "number" && seq > 0;
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
    if (!laterTurnOfSameChild(ctx)) {
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

export const DELEGATED_PROVENANCE_ACTION = "delegation.provenance_carried";

export const TASK_FAILED_ACTION = "delegation.task_failed";

type DelegationFailureEdge = "notification" | "settlement" | "result";

type DelegationFailureParse = TaskNotificationFailure["parse"] | "result";

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

function parentSessionOfChildToken(childToken: string): string | undefined {
  const m = /^subagent:([^:]+):([^:]+)$/.exec(childToken);
  return m === null ? undefined : m[1]!;
}

export async function noteTaskReceipt(receipt: TaskReceipt, ownSessionId: string): Promise<TaskCallLink | null> {
  const org = deploymentOrg();
  let link: TaskCallLink | null = null;
  let continuation = false;
  let replay = false;
  try {
    if (taintEnabled() && ownSessionId.length > 0) {
      const already = await taskCallLink(org, receipt.taskId);
      if (already !== undefined) {
        replay = true;
        link = already;
      } else {
        const pinned = receipt.agentId === null ? undefined : await taskAgentLink(org, ownSessionId, receipt.agentId);
        continuation = pinned !== undefined && pinned.callId !== receipt.callId;
        const fresh: TaskCallLink = {
          callId: receipt.callId,
          childToken: `subagent:${ownSessionId}:${receipt.callId}`,
          ...(receipt.tool.length > 0 ? { tool: receipt.tool } : {}),
        };
        link = pinned ?? fresh;
        if (link.agentId === undefined && receipt.agentId !== null) link = { ...link, agentId: receipt.agentId };
        if (link.tool === undefined && receipt.tool.length > 0) link = { ...link, tool: receipt.tool };
        if (receipt.agentId !== null && !continuation) await rememberTaskAgent(org, ownSessionId, receipt.agentId, link);
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
      agent: receipt.agentId ?? "",
      ...(ownSessionId.length > 0 ? { session: ownSessionId } : {}),
      continuation,
    },
  }).catch(() => undefined);
  return link;
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
        const parentSession = parentSessionOfChildToken(link.childToken) ?? ownSessionId;
        const record = await subagentCallTaintRecord(org, parentSession, link.callId);
        marker = record === undefined ? "lost" : record.tainted ? "tainted" : "clean";
        if (record?.tainted === true) kinds = record.kinds;
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

export type SettlementFromNotification = {
  readonly failure?: TaskNotificationFailure;
  readonly link?: TaskCallLink;
  readonly links?: ReadonlyMap<string, TaskCallLink | undefined>;
  readonly notification?: boolean;
  readonly authorizeRedispatch?: boolean;
};

export async function applyTaskSettlement(
  views: readonly TaskSummary[],
  ownSessionId: string,
  ctx: HookContext,
  settlement: SettlementFromNotification = {},
): Promise<boolean> {
  if (views.length === 0) return false;
  const failure = views.length === 1 ? settlement.failure : undefined;
  const edge: DelegationFailureEdge = settlement.notification === true || failure !== undefined ? "notification" : "settlement";
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
    if (edge === "notification" && settlement.authorizeRedispatch === true) {
      noteSettlementDispatchAuthority(
        wakeTurnId,
        view.taskId,
        install.outcome === "installed" || install.outcome === "already" ? install.dispatchAuthority : undefined,
      );
    }
    if (install.outcome === "installed" && claimPromisedReport(view.taskId)) {
      noteSettlementReportOwed(wakeTurnId, view.taskId, install.wakeId ?? undefined);
    }
    if (link !== undefined) {
      const reach = stampReadReach(bind, wakeTurnId, seatSurfaceKey);
      const wakeProvable = reach.proof !== "wake" || (install.wakeId !== null && reach.wakeId === install.wakeId);
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

export async function settleFromTaskNotification(message: unknown, ownSessionId: string, ctx: HookContext): Promise<boolean> {
  const views = terminalTaskNotifications(message);
  if (views.length === 0) return false;
  const settled: TaskSummary[] = [];
  const links = new Map<string, TaskCallLink | undefined>();
  for (const view of views) {
    let next = view;
    if (!links.has(view.taskId)) {
      try {
        links.set(view.taskId, await taskCallLink(deploymentOrg(), view.taskId));
      } catch {
        links.set(view.taskId, undefined);
      }
    }
    const link = links.get(view.taskId);
    if (link?.agentId !== undefined) next = { ...view, agentId: link.agentId };
    noteTaskSettled(next);
    settled.push(next);
  }
  return applyTaskSettlement(settled, ownSessionId, ctx, {
    notification: true,
    links,
    authorizeRedispatch: taskNotificationStartsWithTerminal(message),
    ...(settled.length === 1 ? { failure: taskNotificationFailure(message) } : {}),
  });
}

export default defineHook({
  events: {
    "turn.started": (_event, ctx) => {
      openTaintTurn(ctx);
      const bind = ctx as unknown as BindableContext;
      noteTurnBoundary(currentTurnId(bind), deliveryStampOf(bind));
      clearStreamDropRetries();
    },

    "message.received": async (event, ctx) => {
      try {
        if (isSubagentChildContext(ctx as unknown as BindableContext)) return;
        const ownSessionId = (ctx as { session?: { id?: string } }).session?.id;
        if (typeof ownSessionId !== "string" || ownSessionId.length === 0) return;
        await settleFromTaskNotification((event as { data?: { message?: unknown } }).data?.message, ownSessionId, ctx);
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
      const actions = (event.data as { actions?: readonly { kind?: unknown; callId?: unknown; toolName?: unknown }[] } | undefined)?.actions ?? [];
      for (const action of actions) {
        const delegated = action.kind === "subagent-call" || (action.kind === "tool-call" && action.toolName === "agent");
        if (delegated && typeof action.callId === "string" && action.callId.length > 0) {
          const settlement = settlementDispatchAuthorityThisTurn(turnId);
          const uningressedUnifiedTurn = isUnifiedWindowContext(bind) && uningressedTurn(turnId);
          const settlementTurn =
            uningressedUnifiedTurn && (settlement.kind !== "none" || taskWakeThisTurn(turnId) !== undefined);
          if (settlementTurn && settlement.kind !== "single") {
            throw new Error("delegated task dispatch authority is missing or ambiguous — refusing child launch before an exact wake is addressed");
          }
          const settlementAuthority = settlement.kind === "single" ? settlement.authority : undefined;
          const wakeId = settlementTurn
            ? settlementAuthority?.wakeId
            : addressedWakeThisTurn(turnId) ?? exactDispatchWakeThisTurn(turnId);
          if (wakeId !== undefined) {
            try {
              await rememberDelegatedTaskWake(deploymentOrg(), ownSessionId, action.callId, wakeId);
            } catch {
              throw new Error("delegated task dispatch authority is missing or ambiguous — refusing child launch before an exact wake is addressed");
            }
          }
          else if (!isUnifiedWindowContext(bind)) {
            const requester = requesterThisTurn(turnId);
            const nonMemberWake = (bind as { session?: { auth?: { current?: { attributes?: Record<string, unknown> } } } }).session?.auth?.current?.attributes?.[OE_CHAT_NONMEMBER_ATTR] === "true";
            await rememberDelegatedTaskBinding(deploymentOrg(), ownSessionId, action.callId, bindFrom(bind), requester, nonMemberWake);
          }
          else throw new Error("delegated task dispatch authority is missing or ambiguous — refusing child launch before an exact wake is addressed");
        }
      }
    },

    "action.result": async (event, ctx) => {
      try {
        if (isSubagentChildContext(ctx as unknown as BindableContext)) return;
        const result = (event.data as { result?: { kind?: unknown; callId?: unknown } } | undefined)?.result;
        const ownSessionId = (ctx as { session?: { id?: string } }).session?.id;
        if (typeof ownSessionId !== "string" || ownSessionId.length === 0) return;

        const receipt = readTaskReceipt(result);
        if (receipt !== null) {
          await noteTaskReceipt(receipt, ownSessionId);
          const bind = ctx as unknown as BindableContext;
          const dispatchTurnId = currentTurnId(bind);
          const prelaunchAuthority = await delegatedTaskDispatchAuthority(deploymentOrg(), ownSessionId, receipt.callId);
          if (isUnifiedWindowContext(bind) && prelaunchAuthority === undefined) {
            throw new Error("delegated task authority disappeared before receipt");
          }
          const dispatchWakeId = prelaunchAuthority?.wakeId;
          const ownWindowToken = resolveOwnWindowToken(bind);
          const minted = await openTaskWake({
            org: deploymentOrg(),
            taskId: receipt.taskId,
            parentWakeId: dispatchWakeId,
            windowToken: ownWindowToken,
          });
          if (minted !== null) {
            if (prelaunchAuthority === undefined) throw new Error("delegated task authority disappeared before receipt");
            await advanceDelegatedTaskWake(deploymentOrg(), ownSessionId, receipt.callId, receipt.taskId, minted, prelaunchAuthority);
          }
          await noteGenerationDelegation(deploymentOrg(), ownWindowToken, receipt.taskId);
          if (minted !== null) noteTaskDispatchedThisTurn(dispatchTurnId, receipt.taskId, minted);
          notePendingDelegation(dispatchTurnId, receipt.taskId, dispatchWakeId);
          noteTaskDispatched(receipt.taskId);
          return;
        }

        noteTaskViews(taskViewsOf(result));
        const terminal = terminalTaskViewsOf(result);
        if (terminal.length > 0) {
          await applyTaskSettlement(terminal, ownSessionId, ctx);
          await flushSettledMemory(ctx as unknown as MemoryPersistContext, "task-settled");
          return;
        }

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
