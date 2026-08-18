import { defineHook, type HookContext } from "eve/hooks";
import { defineState } from "eve/context";
import { oneAttrValue, routineFireIdStamped, routineManualStamped, routineMarker } from "../routines/routine.js";
import { foldRoutineOutcome, type RoutineOutcomeMarker } from "../routines/outcome-fold.js";
import { isScheduleOriginatedAuth, isSubagentChildContext, type BindableContext } from "../identity/binding.js";
import { OE_WAKE_ID_ATTR } from "../channels/unified-window.js";

export interface FireBagContext {
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

interface FoldState {
  readonly armed: ArmedFire | null;
  readonly folded: Record<string, true>;
  readonly lateOpen: Record<string, true>;
  readonly lateFold: ArmedFire | null;
}

const foldState = defineState<FoldState>("open-everywhere.routines.foldState", () => ({
  armed: null,
  folded: {},
  lateOpen: {},
  lateFold: null,
}));

const NO_WAKE_KEY = "no-wake";

function log(msg: string): void {
  console.log(`[open-everywhere:routines] ${msg}`);
}

function armFireFold(ctx: HookContext, alreadyFolded: Readonly<Record<string, true>>): ArmedFire | null {
  const fire = readFireBag(ctx as unknown as FireBagContext);
  if (fire === null) return null;
  if (alreadyFolded[fire.wakeKey] === true) return null;
  return fire;
}

function readFireBag(ctx: FireBagContext): ArmedFire | null {
  if (isSubagentChildContext(ctx as unknown as BindableContext)) return null;
  const c = ctx;
  const auth = (c.session?.auth?.current ?? c.session?.auth?.initiator ?? null) as
    | { authenticator?: unknown; principalId?: unknown; principalType?: unknown; attributes?: Record<string, string | readonly string[]> }
    | null;
  if (!isScheduleOriginatedAuth(auth)) return null;
  const marker = routineMarker(auth?.attributes);
  if (!marker) return null;
  const wakeKey =
    routineFireIdStamped(auth?.attributes) ?? oneAttrValue(auth?.attributes?.[OE_WAKE_ID_ATTR]) ?? NO_WAKE_KEY;
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
    foldState.update((s) => ({ ...s, armed: null, folded: { ...s.folded, [armed.wakeKey]: true } }));
    return armed;
  } catch {
    return null;
  }
}

function openLateFold(wakeKey: string): void {
  try {
    foldState.update((s) => ({ ...s, lateOpen: { ...(s.lateOpen ?? {}), [wakeKey]: true } }));
  } catch {
  }
}

function consumeLateFold(): ArmedFire | null {
  try {
    const late = foldState.get().lateFold ?? null;
    if (late === null) return null;
    foldState.update((s) => {
      const lateOpen = { ...(s.lateOpen ?? {}) };
      delete lateOpen[late.wakeKey];
      return { ...s, lateFold: null, lateOpen };
    });
    return late;
  } catch {
    return null;
  }
}

async function record(outcome: "ok" | "failed"): Promise<void> {
  const armed = consumeArmedFire();
  if (armed !== null) {
    await fold(armed, outcome, false);
    return;
  }
  const late = consumeLateFold();
  if (late !== null) await fold(late, "failed", true);
}

async function fold(fire: ArmedFire, outcome: "ok" | "failed", late: boolean): Promise<void> {
  try {
    const folded = await foldRoutineOutcome({
      marker: fire.marker,
      sessionOutcome: outcome,
      at: new Date(),
      ...(fire.sessionId !== undefined ? { sessionId: fire.sessionId } : {}),
      ...(fire.manual ? { manual: true } : {}),
      ...(late ? { late: true } : {}),
    });
    if (!folded.folded) return;
    if (!late && folded.outcome !== "failed") openLateFold(fire.wakeKey);
    log(
      `outcome ${folded.outcome}${late ? " (LATE declaration)" : ""} for ${fire.marker.id} [${fire.marker.surfaceKey}] ` +
        `(fails=${folded.consecutiveFailures}${folded.disabled ? ", AUTO-DISABLED" : ""})`,
    );
  } catch (err) {
    log(`outcome record skipped for ${fire.marker.id}: ${String(err)}`);
  }
}

export type DeclaredFailureFate =
  | "counted"
  | "counted-late"
  | "uncounted"
  | "unknown";

export function noteDeclaredRunFailure(ctx: FireBagContext): DeclaredFailureFate {
  try {
    const fire = readFireBag(ctx);
    if (fire === null) return "unknown";
    const s = foldState.get();
    if (s.armed !== null && s.armed.wakeKey === fire.wakeKey) return "counted";
    if (s.folded?.[fire.wakeKey] !== true) return "unknown";
    if (s.lateOpen?.[fire.wakeKey] !== true) return "uncounted";
    foldState.update((st) => ({ ...st, lateFold: fire }));
    return "counted-late";
  } catch {
    return "unknown";
  }
}

export default defineHook({
  events: {
    "turn.started": (_event, ctx) => {
      try {
        foldState.update((s) => ({ ...s, armed: armFireFold(ctx, s.folded), lateFold: null }));
      } catch {
      }
    },
    "turn.completed": async () => {
      await record("ok");
    },
    "turn.cancelled": () => {
      try {
        const armed = foldState.get().armed;
        foldState.update((s) => ({ ...s, lateFold: null }));
        if (armed === null) return;
        foldState.update((s) => ({ ...s, armed: null, folded: { ...s.folded, [armed.wakeKey]: true } }));
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
