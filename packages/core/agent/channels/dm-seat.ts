import { getOperationalStore } from "../operational/provider.js";
import type { ChannelSessionRow, OperationalStore } from "../operational/store.js";
import { shouldRotate, rotationClockMsFromDays, type RotationThresholds } from "./turn-delivery.js";
import { claimRuntimeRotation } from "./runtime-rotation.js";
import { recordHandoffNoteLoss } from "../model/rotation-handoff.js";
import { dmSeatRegistryKey, dmWindowKey, formatWindowToken, saltSupervisorGeneration } from "./window-key.js";
import { dmWindowRegistryKey } from "./unified-supervisor.js";

export const DM_SEAT_ROTATE_EXPIRY_MS = rotationClockMsFromDays(process.env.OE_DM_SEAT_ROTATE_EXPIRY_DAYS, 30);

export const DM_SEAT_ROTATE_TURN_BUDGET = Number(process.env.OE_DM_SEAT_ROTATE_TURN_BUDGET) || 50;

export const DM_SEAT_ROTATE_TOKEN_BUDGET = Number(process.env.OE_DM_SEAT_ROTATE_TOKEN_BUDGET) || 5_000_000;

export const DM_SEAT_ROTATE_QUIET_GAP_HOURS = Number(process.env.OE_DM_SEAT_ROTATE_QUIET_GAP_HOURS) || 0;

export function dmSeatThresholds(): Required<Omit<RotationThresholds, "runtimeChanged">> {
  const hours = DM_SEAT_ROTATE_QUIET_GAP_HOURS;
  return {
    quietGapMs: hours > 0 ? hours * 3_600_000 : Number.POSITIVE_INFINITY,
    turnBudget: DM_SEAT_ROTATE_TURN_BUDGET,
    tokenBudget: DM_SEAT_ROTATE_TOKEN_BUDGET,
    expiryMs: DM_SEAT_ROTATE_EXPIRY_MS,
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
  readonly thresholds?: RotationThresholds;
  readonly distillHandoff?: (scope: string, outgoing: ChannelSessionRow) => Promise<string | undefined>;
  readonly claimRuntimeRotation?: typeof claimRuntimeRotation;
}

export interface DmSeatRef {
  readonly surfaceKey: string;
  readonly channelId?: string;
  readonly legacyChannelId?: string;
}

export async function getOrCreateDmSeat(org: string, dm: DmSeatRef, atIso: string, deps: DmSeatDeps = {}): Promise<DmSeat> {
  const store = deps.store ?? getOperationalStore();
  const key = dmWindowRegistryKey(dm.surfaceKey);
  const thresholds = deps.thresholds ?? dmSeatThresholds();
  const mint = (generation: number): string => saltSupervisorGeneration(formatWindowToken(dmWindowKey(dm.surfaceKey, generation)));
  const runtimeChanged = await (deps.claimRuntimeRotation ?? claimRuntimeRotation)(
    { org, registryKey: key, surfaceKey: dm.surfaceKey, atIso },
    deps.store ? { store: deps.store } : {},
  );
  const existing = await store.getChannelSession(org, key);
  if (!existing) {
    const legacy = dm.legacyChannelId
      ? await store.getChannelSession(org, dmSeatRegistryKey(dm.legacyChannelId)).catch(async (err: unknown) => {
          await recordHandoffNoteLoss({ org, scope: dm.surfaceKey, reason: "legacy-note-read-error", error: err });
          return null;
        })
      : null;
    const row = await store.rotateChannelSession(org, key, mint(1), atIso, legacy?.handoffNote ?? undefined);
    return { token: row.token, generation: row.generation, freshGeneration: true, handoffNote: row.handoffNote };
  }
  if (shouldRotate(existing, atIso, { ...thresholds, runtimeChanged })) {
    const note = deps.distillHandoff
      ? await deps.distillHandoff(dm.surfaceKey, existing).catch(async (err: unknown) => {
          await recordHandoffNoteLoss({ org, scope: dm.surfaceKey, reason: "distiller-error", generation: existing.generation, error: err });
          return undefined;
        })
      : undefined;
    const row = await store.rotateChannelSession(org, key, mint(existing.generation + 1), atIso, note);
    return { token: row.token, generation: row.generation, freshGeneration: true, handoffNote: row.handoffNote };
  }
  return {
    token: existing.token,
    generation: existing.generation,
    freshGeneration: existing.firstWakeAt == null,
    handoffNote: existing.handoffNote,
  };
}

export async function touchDmSeat(org: string, dmSurfaceKey: string, atIso: string, store: OperationalStore = getOperationalStore()): Promise<void> {
  await store.touchChannelSession(org, dmWindowRegistryKey(dmSurfaceKey), atIso);
}
