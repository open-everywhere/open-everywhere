import type { OperationalStore, ThreadSeatStateRow } from "../operational/store.js";
import { isUnifiedWakeOrigin, type UnifiedThreadRef, type UnifiedWakeOrigin } from "./unified-window.js";
import { THREAD_OWNER_TTL_MS } from "./thread-ownership.js";

export interface ThreadSeatStateStore {
  putThreadSeatState: OperationalStore["putThreadSeatState"];
  getThreadSeatState: OperationalStore["getThreadSeatState"];
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

export async function recordThreadSeatReport(
  store: ThreadSeatStateStore,
  org: string,
  ref: UnifiedThreadRef,
  report: string,
  atIso: string,
): Promise<ThreadSeatStateRow | null> {
  const existing = await store.getThreadSeatState(org, ref.channelKey, ref.threadKey).catch(() => null);
  if (!existing) return null;
  const closed: ThreadSeatStateRow = { ...existing, state: "completed", report, updatedAt: atIso };
  await store.putThreadSeatState(org, closed, atIso, THREAD_SEAT_STATE_TTL_MS);
  return closed;
}

export async function readThreadSeatState(store: ThreadSeatStateStore, org: string, ref: UnifiedThreadRef): Promise<ThreadSeatStateRow | null> {
  try {
    return await store.getThreadSeatState(org, ref.channelKey, ref.threadKey);
  } catch {
    return null;
  }
}
