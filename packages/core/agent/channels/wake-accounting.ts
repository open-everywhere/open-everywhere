import type { PendingUnifiedWake } from "./unified-window.js";
import { WAKE_TARGET_TTL_MS, wakeAddressingFromTargetJson } from "./unified-window.js";

export interface WakeAccountingStore {
  getUnifiedWakeRecord(org: string, wakeId: string): Promise<{ readonly createdAt: string } | null>;
  listPendingUnifiedWakes(org: string, windowToken: string, afterIso: string, limit: number): Promise<readonly PendingUnifiedWake[]>;
}

export const MAX_ACCOUNTING_WAKES = 50;

export const ACCOUNTING_EPOCH_ISO = "1970-01-01T00:00:00.000Z";

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
    rows = await store.listPendingUnifiedWakes(org, windowToken, ACCOUNTING_EPOCH_ISO, MAX_ACCOUNTING_WAKES);
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

export async function auditableUnaccountedWakes(
  store: WakeAccountingStore,
  org: string,
  input: { readonly windowToken: string; readonly turnWake: string },
  accounted: ReadonlySet<string>,
  nowMs?: number,
): Promise<readonly UnaccountedWake[]> {
  const candidates = await loadUnaccountedWakeCandidates(store, org, input.windowToken, input.turnWake, nowMs);
  return unaccountedWakes(candidates, accounted);
}
