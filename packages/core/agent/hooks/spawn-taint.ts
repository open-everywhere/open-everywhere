import { defineHook, type HookContext } from "eve/hooks";
import { defineState } from "eve/context";
import { OE_SPAWN_TAINTED_ATTR } from "../channels/unified.js";
import {
  beginTaintTurn,
  markUntrustedIngestedThisTurn,
  registerTaintFlipObserver,
  OE_TAINTED_FIRE_ATTR,
  OE_RESULT_TAINTED_ATTR,
} from "../access/taint-signal.js";
import { markSubagentTainted, subagentWasTainted } from "../access/subagent-taint.js";
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

export const TAINT_SEED_ATTRS: readonly string[] = [OE_SPAWN_TAINTED_ATTR, OE_TAINTED_FIRE_ATTR, OE_RESULT_TAINTED_ATTR, JOB_TAINT_ATTR];

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
  let turnId: string | undefined;
  try {
    turnId = currentTurnId(ctx as unknown as BindableContext);
  } catch {
    turnId = undefined;
  }
  beginTaintTurn(turnId);
  beginTaintVerdictTurn(turnId);
  seedIfTainted(ctx);
  rememberSubagentIdentity(ctx);
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

const subagentIdentity = defineState<{ org: string; sessionId: string } | null>(
  "open-everywhere.subagent-taint.identity",
  () => null,
);

function rememberSubagentIdentity(ctx: HookContext): void {
  try {
    const c = ctx as unknown as BindableContext;
    const sessionId = (c as { session?: { id?: string } }).session?.id;
    const child = isSubagentChildContext(c) && typeof sessionId === "string" && sessionId.length > 0;
    subagentIdentity.update(() => (child ? { org: deploymentOrg(), sessionId } : null));
  } catch {
  }
}

registerTaintFlipObserver(() => {
  let who: { org: string; sessionId: string } | null = null;
  try {
    who = subagentIdentity.get();
  } catch {
    who = null;
  }
  if (who === null) return;
  void markSubagentTainted(who.org, who.sessionId);
});

const dispatchedChildren = defineState<Record<string, string>>("open-everywhere.subagent-taint.children", () => ({}));

export function rememberDispatchedChild(callId: string, childSessionId: string): void {
  try {
    if (callId.length === 0 || childSessionId.length === 0) return;
    dispatchedChildren.update((cur) => ({ ...cur, [callId]: childSessionId }));
  } catch {
  }
}

export async function adoptSubagentTaint(callId: string): Promise<boolean> {
  if (!taintEnabled()) return false;
  try {
    const childSessionId = dispatchedChildren.get()[callId];
    if (childSessionId === undefined) return false;
    if (!(await subagentWasTainted(deploymentOrg(), childSessionId))) return false;
    markUntrustedIngestedThisTurn();
    return true;
  } catch {
    return false;
  }
}

export default defineHook({
  events: {
    "turn.started": (_event, ctx) => openTaintTurn(ctx),

    "subagent.called": (event, ctx) => {
      try {
        if (isSubagentChildContext(ctx as unknown as BindableContext)) return;
        const data = event.data as { callId?: unknown; childSessionId?: unknown } | undefined;
        if (typeof data?.callId === "string" && typeof data.childSessionId === "string") {
          rememberDispatchedChild(data.callId, data.childSessionId);
        }
      } catch {
      }
    },

    "action.result": async (event, ctx) => {
      try {
        if (isSubagentChildContext(ctx as unknown as BindableContext)) return;
        const result = (event.data as { result?: { kind?: unknown; callId?: unknown } } | undefined)?.result;
        if (result?.kind !== "subagent-result" || typeof result.callId !== "string") return;
        await adoptSubagentTaint(result.callId);
      } catch {
      }
    },
  },
});
