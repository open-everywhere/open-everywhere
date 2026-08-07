import { defineHook, type HookContext } from "eve/hooks";
import { resolveLeanSeatPosture, withheldFromLeanSeat } from "../access/lean-seat.js";
import { setLeanSeatWake } from "../access/lean-seat-state.js";
import { jobFireStamped } from "../access/job-posture.js";
import { canDelegateFromSeat } from "../access/delegation-mount.js";
import { domainLabelOf } from "../access/window-gated.js";
import { WINDOW_GATED_TOOLS, WINDOW_UNGATED_TOOLS } from "../access/window-gate-manifest.js";
import { auditWindowToolGate } from "../audit/window-tool-gate.js";
import { currentWakeId, deploymentOrg, windowGrainOf, FIRE_UNATTENDED_ATTR, type BindableContext, type WindowGrain } from "../identity/binding.js";
import { routineMarker } from "../routines/routine.js";

type Attrs = Readonly<Record<string, string | readonly string[]>> | undefined;

function attrsOf(ctx: HookContext): Attrs {
  const c = ctx as unknown as BindableContext;
  return c.session?.auth?.current?.attributes ?? c.session?.auth?.initiator?.attributes;
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

async function auditLeanSeatOnce(ctx: HookContext, grain: WindowGrain): Promise<void> {
  try {
    const c = ctx as unknown as BindableContext;
    const sessionId = (c as { session?: { id?: string } }).session?.id ?? domainLabelOf(c);
    if (auditedLeanSessions.has(sessionId)) return;
    auditedLeanSessions.add(sessionId);
    await auditWindowToolGate({
      org: deploymentOrg(),
      domain: domainLabelOf(c),
      grain,
      withheld: withheldFromLeanSeat(WINDOW_GATED_TOOLS, WINDOW_UNGATED_TOOLS),
      wakeId: currentWakeId(c) ?? null,
      sessionId: (c as { session?: { id?: string } }).session?.id ?? null,
      reason: "lean-seat",
    });
  } catch {
  }
}

async function classifyWake(ctx: HookContext): Promise<void> {
  setLeanSeatWake(false);
  const attrs = attrsOf(ctx);
  if (fireDelivery(attrs)) return;
  const c = ctx as unknown as BindableContext;
  const grain = grainOf(c);
  const posture = resolveLeanSeatPosture({ grain, canDelegate: canDelegateFromSeat(c), unattendedFire: false });
  if (posture !== "lean") return;
  setLeanSeatWake(true);
  await auditLeanSeatOnce(ctx, grain);
}

export default defineHook({
  events: {
    "turn.started": async (_event, ctx) => {
      await classifyWake(ctx);
    },
    "turn.completed": () => setLeanSeatWake(false),
    "turn.failed": () => setLeanSeatWake(false),
  },
});
