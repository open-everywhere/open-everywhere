import { defineHook, type HookContext } from "eve/hooks";
import { resolveLeanSeatPosture, withheldFromLeanSeat } from "../access/lean-seat.js";
import { setLeanSeatWake, setWorkSessionToken, setWorkTierWake } from "../access/lean-seat-state.js";
import { resolveOwnWindowToken } from "../access/delegation-mount.js";
import { forwardsToWorkSession, isWorkSessionChildContext, isWorkSessionContext, seatMemoryRecallRoute } from "../access/work-session.js";
import { setNativeDelegationSeat, type NativeDelegationVerdict } from "../access/native-delegation-state.js";
import { setWorkerWake } from "../access/worker-seat-state.js";
import { setWorkerToolsetIdentity, type WorkerToolsetIdentity } from "../access/worker-toolset-state.js";
import { INVOKER_POSTURE_ATTR, resolveInvokerPosture } from "../access/invoker-posture.js";
import { setInvokerPosture } from "../access/invoker-posture-state.js";
import { WEBHOOK_MARKER_ATTR } from "../routines/fire-auth.js";
import { jobFireStamped } from "../access/job-posture.js";
import { canDelegateFromSeat } from "../access/delegation-mount.js";
import { domainLabelOf } from "../access/window-gated.js";
import { WINDOW_GATED_TOOLS, WINDOW_UNGATED_TOOLS } from "../access/window-gate-manifest.js";
import { auditWindowToolGate } from "../audit/window-tool-gate.js";
import { bindFrom, currentTurnId, currentWakeId, delegationRootSessionId, deploymentOrg, isSubagentChildContext, subagentParentSessionId, windowGrainOf, FIRE_UNATTENDED_ATTR, type BindableContext, type WindowGrain } from "../identity/binding.js";
import { routineManualStamped, routineMarker } from "../routines/routine.js";
import { optional } from "./control-refusal.js";
import { dropWorkerRound } from "../access/seat-cut.js";

type Attrs = Readonly<Record<string, string | readonly string[]>> | undefined;

function attrsOf(ctx: HookContext): Attrs {
  try {
    const c = ctx as unknown as BindableContext;
    return c.session?.auth?.current?.attributes;
  } catch {
    return undefined;
  }
}

function unattendedStamped(attributes: Attrs): boolean {
  const v = attributes?.[FIRE_UNATTENDED_ATTR];
  const first = typeof v === "string" ? v : Array.isArray(v) ? v[0] : undefined;
  return first === "true";
}

function fireDelivery(attributes: Attrs): boolean {
  try {
    return unattendedStamped(attributes) || jobFireStamped(attributes) || routineMarker(attributes) !== null;
  } catch {
    return false;
  }
}

function grainOf(ctx: BindableContext): WindowGrain {
  try {
    return windowGrainOf(ctx);
  } catch {
    return "standing";
  }
}

const auditedLeanSessions = new Set<string>();

async function auditLeanSeatOnce(ctx: HookContext, grain: WindowGrain, dmSeat: boolean): Promise<void> {
  try {
    const c = ctx as unknown as BindableContext;
    const sessionId = (c as { session?: { id?: string } }).session?.id ?? domainLabelOf(c);
    if (auditedLeanSessions.has(sessionId)) return;
    auditedLeanSessions.add(sessionId);
    await auditWindowToolGate({
      org: deploymentOrg(),
      domain: domainLabelOf(c),
      grain,
      withheld: withheldFromLeanSeat(WINDOW_GATED_TOOLS, WINDOW_UNGATED_TOOLS, dmSeat),
      wakeId: currentWakeId(c) ?? null,
      sessionId: (c as { session?: { id?: string } }).session?.id ?? null,
      reason: "lean-seat",
    });
  } catch {
  }
}

/**
 * The per-wake verdict for eve's built-in `agent`. It reads the same predicate as the seat's memory
 * route (`seatMemoryRecallRoute`): the verdict is `allow` exactly when that route is `agent`.
 */
export function nativeDelegationVerdictFor(c: BindableContext): NativeDelegationVerdict {
  if (isSubagentChildContext(c)) return "leaf";
  return seatMemoryRecallRoute(c) === "agent" ? "allow" : "no-seat";
}

function classifyNativeDelegationSeat(ctx: HookContext): void {
  try {
    setNativeDelegationSeat(nativeDelegationVerdictFor(ctx as unknown as BindableContext));
  } catch {
    setNativeDelegationSeat("unclassified");
  }
}

function classifyWorkerSeat(ctx: HookContext): void {
  const c = ctx as unknown as BindableContext;
  const worker = grainOf(c) === "task";
  setWorkerWake(worker);
  setWorkerToolsetIdentity(worker ? workerToolsetIdentity(c) : null);
}

function parentCallIdOf(ctx: BindableContext): string | null {
  try {
    const id = (ctx as unknown as { session?: { parent?: { callId?: unknown } } }).session?.parent?.callId;
    return typeof id === "string" && id.length > 0 ? id : null;
  } catch {
    return null;
  }
}

function workerToolsetIdentity(c: BindableContext): WorkerToolsetIdentity | null {
  try {
    const sessionId = (c as { session?: { id?: string } }).session?.id;
    if (typeof sessionId !== "string" || sessionId.length === 0) return null;
    return {
      org: deploymentOrg(),
      domain: domainLabelOf(c),
      worker: sessionId,
      parentSession: subagentParentSessionId(c) ?? null,
      parentCallId: parentCallIdOf(c),
      rootSession: delegationRootSessionId(c) ?? null,
      turn: currentTurnId(c) ?? null,
    };
  } catch {
    return null;
  }
}

function classifyInvokerPosture(ctx: HookContext, attrs: Attrs): void {
  try {
    const auth = (ctx as unknown as BindableContext).session?.auth?.current as { authenticator?: unknown; principalId?: unknown } | undefined;
    const principalId = typeof auth?.principalId === "string" ? auth.principalId : "";
    setInvokerPosture(
      resolveInvokerPosture({
        webhookFire: auth?.authenticator === "webhook" || attrs?.[WEBHOOK_MARKER_ATTR] !== undefined,
        eventSubFire: principalId.endsWith(":webhook"),
        unattendedFire: fireDelivery(attrs),
        manualFire: routineManualStamped(attrs),
        stamped: attrs?.[INVOKER_POSTURE_ATTR],
      }),
    );
  } catch {
    setInvokerPosture("untrusted-remote");
  }
}

function classifyWorkTier(ctx: HookContext): void {
  const c = ctx as unknown as BindableContext;
  try {
    const work = isWorkSessionContext(c);
    const workChild = !work && isWorkSessionChildContext(c);
    setWorkTierWake(work ? "work" : workChild ? "child" : forwardsToWorkSession(c) ? "forwards" : "none");
    setWorkSessionToken(work && !isSubagentChildContext(c) ? resolveOwnWindowToken(c) : undefined);
  } catch {
    setWorkTierWake("none");
    setWorkSessionToken(undefined);
  }
}

async function classifyWake(ctx: HookContext): Promise<void> {
  setWorkTierWake("none");
  classifyWorkTier(ctx);
  setInvokerPosture("untrusted-remote");
  setNativeDelegationSeat("unclassified");
  classifyNativeDelegationSeat(ctx);
  setWorkerWake(false);
  setWorkerToolsetIdentity(null);
  classifyWorkerSeat(ctx);
  setLeanSeatWake(false);
  const attrs = attrsOf(ctx);
  classifyInvokerPosture(ctx, attrs);
  if (fireDelivery(attrs)) return;
  const c = ctx as unknown as BindableContext;
  const grain = grainOf(c);
  const posture = resolveLeanSeatPosture({ grain, canDelegate: canDelegateFromSeat(c), unattendedFire: false });
  if (posture !== "lean") return;
  let dmSeat = false;
  try {
    const mode = bindFrom(c).mode;
    dmSeat = mode === "dm" || mode === "mpim";
  } catch {
    dmSeat = false;
  }
  setLeanSeatWake(true, dmSeat);
  await auditLeanSeatOnce(ctx, grain, dmSeat);
}

export default defineHook({
  events: {
    "turn.started": optional("lean-seat", async (_event, ctx) => {
      await classifyWake(ctx);
    }),
    "turn.settled": optional("lean-seat", (_event, ctx) => {
      setLeanSeatWake(false);
      setWorkTierWake("none");
      setNativeDelegationSeat("unclassified");
      setWorkerWake(false);
      setWorkerToolsetIdentity(null);
      setInvokerPosture("untrusted-remote");
      dropWorkerRound((ctx as unknown as { session?: { id?: string } } | undefined)?.session?.id);
    }),
  },
});
