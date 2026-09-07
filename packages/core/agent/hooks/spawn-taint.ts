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
  subagentCallTaintStatus,
  rememberTaskCall,
  rememberTaskAgent,
  taskCallLink,
  taskAgentLink,
  type TaskCallLink,
} from "../access/subagent-taint.js";
import { readTaskReceipt, taskViewsOf, terminalTaskNotification, terminalTaskViewsOf, type TaskReceipt, type TaskSummary } from "../access/background-tasks.js";
import { JOB_TAINT_ATTR } from "../access/job-posture.js";
import { beginTaintVerdictTurn, registerTaintVerdictSink, taintEnabled, taintMode, type TaintVerdictRow } from "../access/taint-enforcement.js";
import { appendAudit } from "../audit/audit.js";
import { currentTurnId, currentWakeId, deliveryStampOf, deploymentOrg, inheritedWakeStampOf, isSubagentChildContext, type BindableContext } from "../identity/binding.js";
import { resolveOwnWindowToken } from "../access/delegation-mount.js";
import { installTaskWake, openTaskWake } from "../channels/task-wake.js";
import { noteTurnBoundary } from "../access/task-wake-signal.js";
import { addressedWakeThisTurn, noteTaskDispatchedThisTurn } from "../access/dispatch-origin-signal.js";
import { notePendingDelegation, noteDelegationSettled } from "../access/pending-delegation-signal.js";
import { flushDirtyTreeAtTurnEnd, flushSettledMemory, noteTaskDispatched, noteTaskSettled, noteTaskViews } from "./settlement-flush.js";
import type { MemoryPersistContext } from "./memory.js";

export const TAINT_VERDICT_ACTION = "taint.verdict";

registerTaintVerdictSink((row: TaintVerdictRow) => {
  void appendAudit({
    org: deploymentOrg(),
    platform: "ingest",
    workspace: row.kind,
    action: TAINT_VERDICT_ACTION,
    detail: { ...row },
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

export const TAINT_MODE_ACTION = "taint.mode";

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
  const token = (ctx as { channel?: { continuationToken?: unknown } }).channel?.continuationToken;
  if (typeof token === "string") {
    const m = /^subagent:([^:]+):([^:]+)$/.exec(token);
    if (m !== null) return { sessionId: m[1]!, callId: m[2]! };
  }
  const parent = (ctx as { session?: { parent?: { sessionId?: unknown; callId?: unknown } } }).session?.parent;
  const sessionId = parent?.sessionId;
  const callId = parent?.callId;
  if (typeof sessionId === "string" && sessionId.length > 0 && typeof callId === "string" && callId.length > 0) {
    return { sessionId, callId };
  }
  return null;
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
  if (who.parent !== null) {
    void markSubagentCallTainted(who.org, who.parent.sessionId, who.parent.callId);
  }
});

registerTaintKindObserver(() => {
  recordTurnTaintForChildren();
});

export const TAINT_FORWARD_ACTION = "taint.forward";

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

export function recordDispatchTurnForChildren(): boolean {
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
    if (stamp.kinds.length === 0) markUntrustedIngestedThisTurn();
    else for (const kind of stamp.kinds) markUntrustedIngestedThisTurn(kind);
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
    const status = await subagentCallTaintStatus(deploymentOrg(), ownSessionId, callId);
    if (status === false) return false;
    markUntrustedIngestedThisTurn();
    return true;
  } catch {
    markUntrustedIngestedThisTurn();
    return true;
  }
}

export const TASK_STARTED_ACTION = "delegation.task_started";

export const TASK_SETTLED_ACTION = "delegation.task_settled";

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
        const fresh: TaskCallLink = { callId: receipt.callId, childToken: `subagent:${ownSessionId}:${receipt.callId}` };
        link = pinned ?? fresh;
        if (link.agentId === undefined && receipt.agentId !== null) link = { ...link, agentId: receipt.agentId };
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
  try {
    if (taintEnabled()) {
      const link = await taskCallLink(org, view.taskId);
      if (link === undefined) {
        marker = "lost";
      } else {
        const parentSession = parentSessionOfChildToken(link.childToken) ?? ownSessionId;
        const status = await subagentCallTaintStatus(org, parentSession, link.callId);
        marker = status === false ? "clean" : status === true ? "tainted" : "lost";
      }
      if (marker !== "clean") {
        markUntrustedIngestedThisTurn();
        adopted = true;
      }
    }
  } catch {
    marker = "lost";
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
    },
  }).catch(() => undefined);
  return adopted;
}

export async function applyTaskSettlement(views: readonly TaskSummary[], ownSessionId: string, ctx: HookContext): Promise<boolean> {
  if (views.length === 0) return false;
  const bind = ctx as unknown as BindableContext;
  const inheritedWakeId = inheritedWakeStampOf(bind);
  const wakeTurnId = currentTurnId(bind);
  for (const view of views) noteDelegationSettled(wakeTurnId, view.taskId);
  for (const view of views) {
    await installTaskWake({
      org: deploymentOrg(),
      taskId: view.taskId,
      status: view.status,
      sessionId: ownSessionId,
      turnId: wakeTurnId,
      inheritedWakeId,
    });
  }
  let any = false;
  for (const view of views) any = (await adoptTaskTaint(view, ownSessionId)) || any;
  if (any) recordTurnTaintForChildren();
  return any;
}

export async function settleFromTaskNotification(message: unknown, ownSessionId: string, ctx: HookContext): Promise<boolean> {
  const view = terminalTaskNotification(message);
  if (view === null) return false;
  let settled = view;
  try {
    const link = await taskCallLink(deploymentOrg(), view.taskId);
    if (link?.agentId !== undefined) settled = { ...view, agentId: link.agentId };
  } catch {
  }
  noteTaskSettled(settled);
  return applyTaskSettlement([settled], ownSessionId, ctx);
}

export default defineHook({
  events: {
    "turn.started": (_event, ctx) => {
      openTaintTurn(ctx);
      const bind = ctx as unknown as BindableContext;
      noteTurnBoundary(currentTurnId(bind), deliveryStampOf(bind));
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
          const dispatchWakeId = addressedWakeThisTurn(dispatchTurnId) ?? currentWakeId(bind);
          const minted = await openTaskWake({
            org: deploymentOrg(),
            taskId: receipt.taskId,
            parentWakeId: dispatchWakeId,
            windowToken: resolveOwnWindowToken(bind),
          });
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
