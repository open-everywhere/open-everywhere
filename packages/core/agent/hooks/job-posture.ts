import { defineHook, type HookContext } from "eve/hooks";
import { jobFireStamped, jobTaintStamped, withheldFromJobWake } from "../access/job-posture.js";
import { markJobSession, setJobWakeEscalated, isJobSession } from "../access/job-session-state.js";
import { markUntrustedIngestedThisTurn } from "../access/taint-signal.js";
import { auditWindowToolGate } from "../audit/window-tool-gate.js";
import { currentTurnAddressing, currentWakeId, deploymentOrg, windowGrainOf, type BindableContext } from "../identity/binding.js";
import { routineMarker } from "../routines/routine.js";

function attrsOf(ctx: HookContext): Readonly<Record<string, string | readonly string[]>> | undefined {
  const c = ctx as unknown as BindableContext;
  return c.session?.auth?.current?.attributes ?? c.session?.auth?.initiator?.attributes;
}

function humanPrincipalInTurn(ctx: HookContext): boolean {
  try {
    const c = ctx as unknown as BindableContext;
    if (currentTurnAddressing(c) === "direct-mention") return true;
    const pid = c.session?.auth?.current?.principalId;
    return typeof pid === "string" && pid.length > 0;
  } catch {
    return false;
  }
}

async function auditRestrictedJobWake(ctx: HookContext): Promise<void> {
  try {
    const c = ctx as unknown as BindableContext;
    const marker = routineMarker(attrsOf(ctx));
    await auditWindowToolGate({
      org: marker?.org ?? deploymentOrg(),
      domain: marker?.surfaceKey ?? "unknown",
      grain: windowGrainOf(c),
      withheld: withheldFromJobWake(),
      wakeId: currentWakeId(c) ?? null,
      sessionId: null,
      reason: "job-wake",
    });
  } catch {
  }
}

async function classifyWake(ctx: HookContext): Promise<void> {
  setJobWakeEscalated(false);
  let stamped = false;
  try {
    stamped = jobFireStamped(attrsOf(ctx));
  } catch {
    stamped = false;
  }
  if (stamped) {
    markJobSession();
    try {
      if (jobTaintStamped(attrsOf(ctx))) markUntrustedIngestedThisTurn();
    } catch {
    }
    await auditRestrictedJobWake(ctx);
    return;
  }
  if (!isJobSession()) return;
  if (humanPrincipalInTurn(ctx)) {
    setJobWakeEscalated(true);
    return;
  }
  await auditRestrictedJobWake(ctx);
}

export default defineHook({
  events: {
    "turn.started": async (_event, ctx) => {
      await classifyWake(ctx);
    },
    "turn.completed": () => setJobWakeEscalated(false),
    "turn.failed": () => setJobWakeEscalated(false),
  },
});
