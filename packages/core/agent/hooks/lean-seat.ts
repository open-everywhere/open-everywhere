import { defineHook, type HookContext } from "eve/hooks";
import { resolveLeanSeatPosture, withheldFromLeanSeat } from "../access/lean-seat.js";
import { setLeanSeatWake } from "../access/lean-seat-state.js";
import { setNativeDelegationSeat } from "../access/native-delegation-state.js";
import { setWorkerWake } from "../access/worker-seat-state.js";
import { jobFireStamped } from "../access/job-posture.js";
import { nativeSubagentEnabled, oneshotAgentEnabled } from "../access/delegation-flag.js";
import { canDelegateFromSeat } from "../access/delegation-mount.js";
import { domainLabelOf } from "../access/window-gated.js";
import { WINDOW_GATED_TOOLS, WINDOW_UNGATED_TOOLS } from "../access/window-gate-manifest.js";
import { auditWindowToolGate } from "../audit/window-tool-gate.js";
import { bindFrom, currentWakeId, deploymentOrg, isSubagentChildContext, windowGrainOf, FIRE_UNATTENDED_ATTR, type BindableContext, type WindowGrain } from "../identity/binding.js";
import { routineMarker } from "../routines/routine.js";

type Attrs = Readonly<Record<string, string | readonly string[]>> | undefined;

function attrsOf(ctx: HookContext): Attrs {
  const c = ctx as unknown as BindableContext;
  return c.session?.auth?.current?.attributes;
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

function classifyNativeDelegationSeat(ctx: HookContext): void {
  if (!nativeSubagentEnabled()) return;
  const c = ctx as unknown as BindableContext;
  try {
    if (isSubagentChildContext(c)) {
      setNativeDelegationSeat("leaf");
      return;
    }
    const grain = grainOf(c);
    const admitted = WINDOW_GATED_TOOLS["agent"]?.includes(grain) === true;
    setNativeDelegationSeat(admitted && oneshotAgentEnabled() && canDelegateFromSeat(c) ? "allow" : "no-seat");
  } catch {
    setNativeDelegationSeat("unclassified");
  }
}

function classifyWorkerSeat(ctx: HookContext): void {
  setWorkerWake(grainOf(ctx as unknown as BindableContext) === "task");
}

async function classifyWake(ctx: HookContext): Promise<void> {
  setNativeDelegationSeat("unclassified");
  classifyNativeDelegationSeat(ctx);
  setWorkerWake(false);
  classifyWorkerSeat(ctx);
  setLeanSeatWake(false);
  const attrs = attrsOf(ctx);
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
    "turn.started": async (_event, ctx) => {
      await classifyWake(ctx);
    },
    "turn.completed": () => {
      setLeanSeatWake(false);
      setNativeDelegationSeat("unclassified");
      setWorkerWake(false);
    },
    "turn.failed": () => {
      setLeanSeatWake(false);
      setNativeDelegationSeat("unclassified");
      setWorkerWake(false);
    },
  },
});
