import { defineHook, type HookContext } from "eve/hooks";
import { defineState } from "eve/context";
import { routineManualStamped, routineMarker } from "../routines/routine.js";
import { foldRoutineOutcome, type RoutineOutcomeMarker } from "../routines/outcome-fold.js";
import { isScheduleOriginatedAuth } from "../identity/binding.js";

interface AuthSlotContext {
  readonly session?: {
    readonly id?: unknown;
    readonly auth?: { readonly current?: unknown; readonly initiator?: unknown } | null;
  };
}

interface ArmedFire {
  readonly marker: RoutineOutcomeMarker;
  readonly manual: boolean;
  readonly sessionId?: string;
}

const armedFire = defineState<{ fire: ArmedFire | null }>(
  "open-everywhere.routines.armedFire",
  () => ({ fire: null }),
);

function log(msg: string): void {
  console.log(`[open-everywhere:routines] ${msg}`);
}

export function armFireFold(ctx: HookContext): ArmedFire | null {
  const c = ctx as unknown as AuthSlotContext;
  const auth = (c.session?.auth?.current ?? c.session?.auth?.initiator ?? null) as
    | { authenticator?: unknown; principalId?: unknown; principalType?: unknown; attributes?: Record<string, string | readonly string[]> }
    | null;
  if (!isScheduleOriginatedAuth(auth)) return null;
  const marker = routineMarker(auth?.attributes);
  if (!marker) return null;
  const sessionId = typeof c.session?.id === "string" && c.session.id.length > 0 ? c.session.id : undefined;
  return {
    marker,
    manual: routineManualStamped(auth?.attributes),
    ...(sessionId !== undefined ? { sessionId } : {}),
  };
}

function consumeArmedFire(): ArmedFire | null {
  try {
    const armed = armedFire.get().fire;
    if (armed === null) return null;
    armedFire.update(() => ({ fire: null }));
    return armed;
  } catch {
    return null;
  }
}

async function record(outcome: "ok" | "failed"): Promise<void> {
  const armed = consumeArmedFire();
  if (!armed) return;

  try {
    const folded = await foldRoutineOutcome({
      marker: armed.marker,
      sessionOutcome: outcome,
      at: new Date(),
      ...(armed.sessionId !== undefined ? { sessionId: armed.sessionId } : {}),
      ...(armed.manual ? { manual: true } : {}),
    });
    if (!folded.folded) return;
    log(
      `outcome ${folded.outcome} for ${armed.marker.id} [${armed.marker.surfaceKey}] ` +
        `(fails=${folded.consecutiveFailures}${folded.disabled ? ", AUTO-DISABLED" : ""})`,
    );
  } catch (err) {
    log(`outcome record skipped for ${armed.marker.id}: ${String(err)}`);
  }
}

export default defineHook({
  events: {
    "turn.started": (_event, ctx) => {
      try {
        const fire = armFireFold(ctx);
        if (fire) armedFire.update(() => ({ fire }));
      } catch {
      }
    },
    "turn.completed": async () => {
      await record("ok");
    },
    "turn.failed": async () => {
      await record("failed");
    },
    "session.failed": async () => {
      await record("failed");
    },
  },
});
