import { defineHook, type HookContext } from "eve/hooks";
import { defineState } from "eve/context";
import { OE_SPAWN_TAINTED_ATTR } from "../channels/unified.js";
import {
  beginTaintTurn,
  markUntrustedIngestedThisTurn,
  registerTaintFlipObserver,
  untrustedIngestedThisTurn,
  OE_TAINTED_FIRE_ATTR,
  OE_RESULT_TAINTED_ATTR,
  OE_CHAT_NONMEMBER_ATTR,
} from "../access/taint-signal.js";
import { markSubagentTainted, claimSubagentCallClean, markSubagentCallTainted, subagentCallTaintStatus } from "../access/subagent-taint.js";
import { JOB_TAINT_ATTR } from "../access/job-posture.js";
import { beginTaintVerdictTurn, registerTaintVerdictSink, taintEnabled, taintMode, type TaintVerdictRow } from "../access/taint-enforcement.js";
import { appendAudit } from "../audit/audit.js";
import { currentTurnId, deploymentOrg, isSubagentChildContext, type BindableContext } from "../identity/binding.js";

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
  OE_RESULT_TAINTED_ATTR,
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

export const TAINT_FORWARD_ACTION = "taint.forward";

export const OE_PARENT_TURN_TAINTED_ATTR = "oe_parent_turn_tainted";

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
    const stamp = `${who.sessionId}|${who.turnId}`;
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

function readParentTurn(ctx: HookContext): { sessionId: string; turnId: string } | null {
  const session = (ctx as { session?: { turn?: { sequence?: unknown }; parent?: { sessionId?: unknown; turn?: { id?: unknown } } } }).session;
  const ownSequence = session?.turn?.sequence;
  if (typeof ownSequence === "number" && ownSequence > 0) return null;
  const sessionId = session?.parent?.sessionId;
  const turnId = session?.parent?.turn?.id;
  if (typeof sessionId === "string" && sessionId.length > 0 && typeof turnId === "string" && turnId.length > 0) {
    return { sessionId, turnId };
  }
  return null;
}

function parentTurnTaintStampMatches(ctx: HookContext): boolean {
  try {
    const parent = readParentTurn(ctx);
    if (parent === null) return false;
    const raw = currentAttrs(ctx)?.[OE_PARENT_TURN_TAINTED_ATTR];
    const value = Array.isArray(raw) ? raw[0] : raw;
    return typeof value === "string" && value === `${parent.sessionId}|${parent.turnId}`;
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
    if (!parentTurnTaintStampMatches(ctx)) return false;
    let ownTurnId: string | undefined;
    try {
      ownTurnId = currentTurnId(ctx as unknown as BindableContext);
    } catch {
      ownTurnId = undefined;
    }
    parentTurnTaintAdopted.update(() => (typeof ownTurnId === "string" ? ownTurnId : ""));
    markUntrustedIngestedThisTurn();
    const parent = readParentTurn(ctx);
    const sessionId = (ctx as { session?: { id?: string } }).session?.id;
    void appendAudit({
      org: deploymentOrg(),
      platform: "ingest",
      workspace: "taint",
      action: TAINT_FORWARD_ACTION,
      detail: {
        leg: "adopt",
        ...(typeof sessionId === "string" && sessionId.length > 0 ? { session: sessionId } : {}),
        parentSession: parent?.sessionId ?? "",
        parentTurn: parent?.turnId ?? "",
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

export default defineHook({
  events: {
    "turn.started": (_event, ctx) => openTaintTurn(ctx),

    "action.result": async (event, ctx) => {
      try {
        if (isSubagentChildContext(ctx as unknown as BindableContext)) return;
        const result = (event.data as { result?: { kind?: unknown; callId?: unknown } } | undefined)?.result;
        if (result?.kind !== "subagent-result" || typeof result.callId !== "string") return;
        const ownSessionId = (ctx as { session?: { id?: string } }).session?.id;
        if (typeof ownSessionId !== "string" || ownSessionId.length === 0) return;
        if (await adoptSubagentTaint(result.callId, ownSessionId)) {
          recordTurnTaintForChildren();
        }
      } catch {
      }
    },
  },
});
