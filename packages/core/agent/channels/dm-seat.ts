import { getOperationalStore } from "../operational/provider.js";
import type { ChannelSessionRow, OperationalStore } from "../operational/store.js";
import { shouldRotate } from "./slack-events.js";
import { dmSeatRegistryKey, formatDmSeatToken } from "./window-key.js";

export function dmSeatRotationEnabled(): boolean {
  return (process.env.OE_DM_SEAT_ROTATION ?? "1") !== "0";
}

export const DM_SEAT_ROTATE_TURN_BUDGET = Number(process.env.OE_DM_SEAT_ROTATE_TURN_BUDGET) || 50;

export const DM_SEAT_ROTATE_TOKEN_BUDGET = Number(process.env.OE_DM_SEAT_ROTATE_TOKEN_BUDGET) || 200_000;

export const DM_SEAT_ROTATE_QUIET_GAP_HOURS = Number(process.env.OE_DM_SEAT_ROTATE_QUIET_GAP_HOURS) || 0;

export function dmSeatThresholds(): { quietGapMs: number; turnBudget: number; tokenBudget: number } {
  const hours = DM_SEAT_ROTATE_QUIET_GAP_HOURS;
  return {
    quietGapMs: hours > 0 ? hours * 3_600_000 : Number.POSITIVE_INFINITY,
    turnBudget: DM_SEAT_ROTATE_TURN_BUDGET,
    tokenBudget: DM_SEAT_ROTATE_TOKEN_BUDGET,
  };
}

export interface DmSeat {
  readonly token: string;
  readonly generation: number;
  readonly freshGeneration: boolean;
  readonly handoffNote: string | null;
}

export interface DmSeatDeps {
  readonly store?: OperationalStore;
  readonly now?: () => string;
  readonly thresholds?: { quietGapMs?: number; turnBudget?: number; tokenBudget?: number };
  readonly distillHandoff?: (dmChannelId: string, outgoing: ChannelSessionRow) => Promise<string | undefined>;
}

export async function getOrCreateDmSeat(org: string, dmChannelId: string, atIso: string, deps: DmSeatDeps = {}): Promise<DmSeat> {
  const store = deps.store ?? getOperationalStore();
  const key = dmSeatRegistryKey(dmChannelId);
  const thresholds = deps.thresholds ?? dmSeatThresholds();
  const existing = await store.getChannelSession(org, key);
  if (!existing) {
    const token = formatDmSeatToken(dmChannelId, 1);
    const row = await store.rotateChannelSession(org, key, token, atIso);
    return { token: row.token, generation: row.generation, freshGeneration: true, handoffNote: row.handoffNote };
  }
  if (shouldRotate(existing, atIso, thresholds)) {
    const note = deps.distillHandoff ? await deps.distillHandoff(dmChannelId, existing).catch(() => undefined) : undefined;
    const token = formatDmSeatToken(dmChannelId, existing.generation + 1);
    const row = await store.rotateChannelSession(org, key, token, atIso, note);
    return { token: row.token, generation: row.generation, freshGeneration: true, handoffNote: row.handoffNote };
  }
  return {
    token: existing.token,
    generation: existing.generation,
    freshGeneration: existing.firstWakeAt == null,
    handoffNote: existing.handoffNote,
  };
}

export async function touchDmSeat(org: string, dmChannelId: string, atIso: string, store: OperationalStore = getOperationalStore()): Promise<void> {
  await store.touchChannelSession(org, dmSeatRegistryKey(dmChannelId), atIso);
}
