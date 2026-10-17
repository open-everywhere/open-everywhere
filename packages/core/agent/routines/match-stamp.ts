import { getOperationalStore } from "../operational/provider.js";
import { updateRoutine } from "./store.js";
import type { Routine } from "./routine.js";
import type { NormalizedEvent } from "./event-model.js";
import { replayEventFor } from "./test-run.js";

const MATCH_STAMP_WINDOW_MS = 60_000;

function matchStampThrottleKey(routineId: string): string {
  return `routinematch:${routineId}`;
}

export interface MatchStampDeps {
  readonly update?: (org: string, surfaceKey: string, id: string, patch: Partial<Routine>) => Promise<unknown>;
  readonly markSeen?: (org: string, key: string, atIso: string, ttlMs: number) => Promise<boolean>;
  readonly now?: () => Date;
}

export async function stampSubscriptionMatch(r: Routine, deps: MatchStampDeps = {}): Promise<boolean> {
  const nowIso = (deps.now?.() ?? new Date()).toISOString();
  const key = matchStampThrottleKey(r.id);
  let first = true;
  try {
    const markSeen =
      deps.markSeen ?? ((o: string, k: string, at: string, ttl: number) => getOperationalStore().markEventSeen(o, k, at, ttl));
    first = await markSeen(r.org, key, nowIso, MATCH_STAMP_WINDOW_MS);
  } catch {
    first = true;
  }
  if (!first) return false;
  const patch: Partial<Routine> = { lastMatchAt: nowIso, ...(r.firstMatchAt === undefined ? { firstMatchAt: nowIso } : {}) };
  try {
    await (deps.update ?? updateRoutine)(r.org, r.surfaceKey, r.id, patch);
  } catch (err) {
    console.warn(`[open-everywhere:routines] match stamp skipped for ${r.id}: ${String(err)}`);
    return false;
  }
  return true;
}

const REPLAY_EVENT_WINDOW_MS = 60_000;

export async function captureReplayEvent(r: Routine, ev: NormalizedEvent, deps: MatchStampDeps = {}): Promise<boolean> {
  const nowIso = (deps.now?.() ?? new Date()).toISOString();
  const kept = replayEventFor(ev, nowIso);
  if (kept === undefined) return false;
  let first = true;
  try {
    const markSeen =
      deps.markSeen ?? ((o: string, k: string, at: string, ttl: number) => getOperationalStore().markEventSeen(o, k, at, ttl));
    first = await markSeen(r.org, `routinereplay:${r.id}`, nowIso, REPLAY_EVENT_WINDOW_MS);
  } catch {
    first = true;
  }
  if (!first) return false;
  try {
    await (deps.update ?? updateRoutine)(r.org, r.surfaceKey, r.id, { lastEvent: kept });
  } catch (err) {
    console.warn(`[open-everywhere:routines] replay event not kept for ${r.id}: ${String(err)}`);
    return false;
  }
  return true;
}
