import type { PendingUnifiedWake } from "./unified-window.js";
import { WAKE_TARGET_TTL_MS, wakeAddressingFromTargetJson } from "./unified-window.js";

export interface WakeAccountingStore {
  getUnifiedWakeRecord(org: string, wakeId: string): Promise<{ readonly createdAt: string } | null>;
  listUnauditedUnifiedWakes(org: string, windowToken: string, limit: number): Promise<readonly PendingUnifiedWake[]>;
  markUnifiedWakesAudited(org: string, wakeIds: readonly string[], at: string): Promise<void>;
}

export const MAX_ACCOUNTING_WAKES = 50;

export const UNACCOUNTED_WAKES_AUDIT_ACTION = "turn.unaccounted_wakes";

export type WakeAddressingClass = "addressed" | "ambient";

export interface UnaccountedWake {
  readonly wakeId: string;
  readonly addressing: WakeAddressingClass;
}

export function addressingClassOf(targetJson: string): WakeAddressingClass {
  return wakeAddressingFromTargetJson(targetJson) === "direct-mention" ? "addressed" : "ambient";
}

export function unaccountedWakes(
  pending: readonly PendingUnifiedWake[],
  accounted: ReadonlySet<string>,
): readonly UnaccountedWake[] {
  const out: UnaccountedWake[] = [];
  for (const row of pending) {
    if (accounted.has(row.wakeId)) continue;
    out.push({ wakeId: row.wakeId, addressing: addressingClassOf(row.targetJson) });
  }
  return out;
}

export async function loadUnaccountedWakeCandidates(
  store: WakeAccountingStore,
  org: string,
  windowToken: string,
  turnWake: string,
  nowMs?: number,
): Promise<readonly PendingUnifiedWake[]> {
  let anchorMs: number;
  try {
    const anchorRow = await store.getUnifiedWakeRecord(org, turnWake);
    if (!anchorRow) return [];
    anchorMs = Date.parse(anchorRow.createdAt);
    if (!Number.isFinite(anchorMs)) return [];
  } catch {
    return [];
  }
  let rows: readonly PendingUnifiedWake[];
  try {
    rows = await store.listUnauditedUnifiedWakes(org, windowToken, MAX_ACCOUNTING_WAKES);
  } catch {
    return [];
  }
  const now = nowMs ?? Date.now();
  return rows.filter((row) => {
    const at = Date.parse(row.createdAt);
    if (!Number.isFinite(at) || at > anchorMs) return false;
    if (now - at > WAKE_TARGET_TTL_MS) return false;
    return true;
  });
}

export async function settleWakeAccounting(
  store: WakeAccountingStore,
  org: string,
  input: { readonly windowToken: string; readonly turnWake: string },
  accounted: ReadonlySet<string>,
  nowMs?: number,
): Promise<readonly UnaccountedWake[]> {
  const candidates = await loadUnaccountedWakeCandidates(store, org, input.windowToken, input.turnWake, nowMs);
  const leftover = unaccountedWakes(candidates, accounted);
  if (candidates.length > 0) {
    await store
      .markUnifiedWakesAudited(org, candidates.map((row) => row.wakeId), new Date(nowMs ?? Date.now()).toISOString())
      .catch(() => undefined);
  }
  return leftover;
}
