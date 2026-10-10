import { getOperationalStore } from "../operational/provider.js";
import type { ChannelSessionRow, OperationalStore } from "../operational/store.js";
import { shouldRotate, supervisorRotateContextSize, type RotationThresholds } from "./turn-delivery.js";
import { claimRuntimeRotation, stampMintedRuntime } from "./runtime-rotation.js";
import { carryTailForward } from "./session-tail-record.js";
import type { WakeMessageInput } from "./wake-envelope.js";
import { dmWindowKey, formatWindowToken, saltSupervisorGeneration } from "./window-key.js";
import { dmWindowRegistryKey } from "./unified-supervisor.js";

export const DM_SEAT_ROTATE_EXPIRY_MS = 30 * 86_400_000;

export const DM_SEAT_ROTATE_TURN_BUDGET = 50;

export const DM_SEAT_ROTATE_TOKEN_BUDGET = 5_000_000;

export function dmSeatThresholds(): Required<Omit<RotationThresholds, "runtimeChanged">> {
  return {
    quietGapMs: Number.POSITIVE_INFINITY,
    turnBudget: DM_SEAT_ROTATE_TURN_BUDGET,
    tokenBudget: DM_SEAT_ROTATE_TOKEN_BUDGET,
    expiryMs: DM_SEAT_ROTATE_EXPIRY_MS,
    contextSizeTokens: supervisorRotateContextSize(),
  };
}

export interface DmSeat {
  readonly token: string;
  readonly generation: number;
  readonly freshGeneration: boolean;
  readonly tail: readonly WakeMessageInput[];
}

export interface DmSeatDeps {
  readonly store?: OperationalStore;
  readonly thresholds?: RotationThresholds;
  readonly claimRuntimeRotation?: typeof claimRuntimeRotation;
  readonly stampMintedRuntime?: typeof stampMintedRuntime;
}

export interface DmSeatRef {
  readonly surfaceKey: string;
  readonly channelId?: string;
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
    const row = await store.rotateChannelSession(org, key, mint(1), atIso);
    await (deps.stampMintedRuntime ?? stampMintedRuntime)({ org, registryKey: key, surfaceKey: dm.surfaceKey, atIso }, deps.store ? { store: deps.store } : {});
    return { token: row.token, generation: row.generation, freshGeneration: true, tail: [] };
  }
  if (shouldRotate(existing, atIso, { ...thresholds, runtimeChanged })) {
    const tail = await carryTailForward(org, key, existing.token, store);
    const row = await store.rotateChannelSession(org, key, mint(existing.generation + 1), atIso);
    return { token: row.token, generation: row.generation, freshGeneration: true, tail };
  }
  return {
    token: existing.token,
    generation: existing.generation,
    freshGeneration: existing.firstWakeAt == null,
    tail: [],
  };
}

export async function touchDmSeat(org: string, dmSurfaceKey: string, atIso: string, store: OperationalStore = getOperationalStore()): Promise<void> {
  await store.touchChannelSession(org, dmWindowRegistryKey(dmSurfaceKey), atIso);
}
