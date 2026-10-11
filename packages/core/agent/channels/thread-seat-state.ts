import type { OperationalStore, ThreadSeatState, ThreadSeatStateRow } from "../operational/store.js";
import { isUnifiedWakeOrigin, type UnifiedThreadRef, type UnifiedWakeOrigin } from "./unified-window.js";
import { THREAD_OWNER_TTL_MS } from "./thread-ownership.js";

export interface ThreadSeatStateStore {
  putThreadSeatState: OperationalStore["putThreadSeatState"];
  getThreadSeatState: OperationalStore["getThreadSeatState"];
  closeThreadSeatState: OperationalStore["closeThreadSeatState"];
}

const THREAD_SEAT_STATE_TTL_MS = THREAD_OWNER_TTL_MS;

export async function recordThreadSeatOpen(
  store: ThreadSeatStateStore,
  org: string,
  ref: UnifiedThreadRef,
  input: { readonly seatToken: string; readonly parentRegistryKey: string; readonly origin: UnifiedWakeOrigin; readonly atIso: string },
): Promise<void> {
  await store.putThreadSeatState(
    org,
    {
      channelKey: ref.channelKey,
      threadKey: ref.threadKey,
      seatToken: input.seatToken,
      parentRegistryKey: input.parentRegistryKey,
      state: "open",
      originJson: JSON.stringify(input.origin),
      openedAt: input.atIso,
    },
    input.atIso,
    THREAD_SEAT_STATE_TTL_MS,
  );
}

export function threadSeatOrigin(row: { readonly originJson: string }): UnifiedWakeOrigin | undefined {
  try {
    const parsed: unknown = JSON.parse(row.originJson);
    return isUnifiedWakeOrigin(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export interface ThreadSeatCloseRecord {
  readonly row: ThreadSeatStateRow;
  readonly closedNow: boolean;
  readonly foreign: boolean;
  readonly priorState: ThreadSeatState;
  readonly lastActiveAt: string;
}

export async function recordThreadSeatClose(
  store: ThreadSeatStateStore,
  org: string,
  ref: UnifiedThreadRef,
  input: { readonly seatToken: string; readonly state: Exclude<ThreadSeatState, "open">; readonly report?: string; readonly atIso: string },
): Promise<ThreadSeatCloseRecord | null> {
  const existing = await store.getThreadSeatState(org, ref.channelKey, ref.threadKey).catch(() => null);
  if (!existing) return null;
  const base = { priorState: existing.state, lastActiveAt: existing.updatedAt };
  if (existing.seatToken !== input.seatToken) return { row: existing, closedNow: false, foreign: true, ...base };
  const closedNow = await store.closeThreadSeatState(org, ref.channelKey, ref.threadKey, input.seatToken, input.state, input.report ?? null, input.atIso);
  if (!closedNow) {
    const now = await store.getThreadSeatState(org, ref.channelKey, ref.threadKey).catch(() => null);
    return { row: now ?? existing, closedNow: false, foreign: false, ...base };
  }
  const { report: priorReport, ...rest } = existing;
  const report = input.report ?? priorReport;
  const row: ThreadSeatStateRow = { ...rest, state: input.state, ...(report !== undefined ? { report } : {}), updatedAt: input.atIso };
  return { row, closedNow: true, foreign: false, ...base };
}

export async function touchThreadSeatActivity(store: Pick<OperationalStore, "touchThreadSeat">, org: string, ref: UnifiedThreadRef, atIso: string): Promise<boolean> {
  try {
    return await store.touchThreadSeat(org, ref.channelKey, ref.threadKey, atIso);
  } catch {
    return false;
  }
}

export async function readThreadSeatState(store: ThreadSeatStateStore, org: string, ref: UnifiedThreadRef): Promise<ThreadSeatStateRow | null> {
  try {
    return await store.getThreadSeatState(org, ref.channelKey, ref.threadKey);
  } catch {
    return null;
  }
}
