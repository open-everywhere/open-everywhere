import { defineHook, type HookContext } from "eve/hooks";
import { defineState } from "eve/context";
import { oneAttrValue, routineManualStamped, routineMarker } from "../routines/routine.js";
import { foldRoutineOutcome, type RoutineOutcomeMarker } from "../routines/outcome-fold.js";
import { isScheduleOriginatedAuth, isSubagentChildContext, type BindableContext } from "../identity/binding.js";
import { OE_WAKE_ID_ATTR } from "../channels/unified-window.js";

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
  readonly wakeKey: string;
}

const foldState = defineState<{ armed: ArmedFire | null; folded: Record<string, true> }>(
  "open-everywhere.routines.foldState",
  () => ({ armed: null, folded: {} }),
);

const NO_WAKE_KEY = "no-wake";

function log(msg: string): void {
  console.log(`[open-everywhere:routines] ${msg}`);
}

function armFireFold(ctx: HookContext, alreadyFolded: Readonly<Record<string, true>>): ArmedFire | null {
  if (isSubagentChildContext(ctx as unknown as BindableContext)) return null;
  const c = ctx as unknown as AuthSlotContext;
  const auth = (c.session?.auth?.current ?? c.session?.auth?.initiator ?? null) as
    | { authenticator?: unknown; principalId?: unknown; principalType?: unknown; attributes?: Record<string, string | readonly string[]> }
    | null;
  if (!isScheduleOriginatedAuth(auth)) return null;
  const marker = routineMarker(auth?.attributes);
  if (!marker) return null;
  const wakeKey = oneAttrValue(auth?.attributes?.[OE_WAKE_ID_ATTR]) ?? NO_WAKE_KEY;
  if (alreadyFolded[wakeKey] === true) return null;
  const sessionId = typeof c.session?.id === "string" && c.session.id.length > 0 ? c.session.id : undefined;
  return {
    marker,
    manual: routineManualStamped(auth?.attributes),
    wakeKey,
    ...(sessionId !== undefined ? { sessionId } : {}),
  };
}

function consumeArmedFire(): ArmedFire | null {
  try {
    const armed = foldState.get().armed;
    if (armed === null) return null;
    foldState.update((s) => ({ armed: null, folded: { ...s.folded, [armed.wakeKey]: true } }));
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
        foldState.update((s) => ({ ...s, armed: armFireFold(ctx, s.folded) }));
      } catch {
      }
    },
    "turn.completed": async () => {
      await record("ok");
    },
    "turn.cancelled": () => {
      try {
        const armed = foldState.get().armed;
        if (armed === null) return;
        foldState.update((s) => ({ armed: null, folded: { ...s.folded, [armed.wakeKey]: true } }));
        log(`fire cancelled for ${armed.marker.id} [${armed.marker.surfaceKey}] — no outcome recorded`);
      } catch {
      }
    },
    "turn.failed": async () => {
      await record("failed");
    },
    "session.failed": async () => {
      await record("failed");
    },
  },
});
