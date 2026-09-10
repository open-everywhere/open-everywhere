import { defineState } from "eve/context";
import type { ModelRoute } from "../memory/domain.js";
import { bareTokenFromEveContext } from "../channels/window-key.js";
import { bindFrom, currentSessionId, currentTurnId, type BindableContext } from "../identity/binding.js";
import { resolvePartition, domainKeyOf } from "../memory/partition.js";
import { appendAudit } from "../audit/audit.js";

export type ModelArm = "champion" | "challenger";

export interface ModelAbTest {
  readonly challenger: string;
  readonly percent: number;
}

export const MODEL_ARM_DETAIL_KEY = "modelArm";
export const MODEL_AB_BUCKET_DETAIL_KEY = "modelAbBucket";

export const MODEL_AB_ARM_ACTION = "model.ab_arm";
export const MODEL_AB_RATING_ACTION = "model.ab_rating";

export const MODEL_AB_RATING_MIN = 1;
export const MODEL_AB_RATING_MAX = 5;

export function assertModelAbTestValid(test: ModelAbTest): void {
  if (!Number.isInteger(test.percent) || test.percent < 0 || test.percent > 100) {
    throw new Error(`model A/B test: percent must be an integer 0-100, got ${JSON.stringify(test.percent)}.`);
  }
  if (test.percent > 0 && test.challenger.trim().length === 0) {
    throw new Error(`model A/B test: percent is ${test.percent} but no challenger model is declared.`);
  }
}

let registered: ModelAbTest | undefined;

export function registerModelAbTest(test: ModelAbTest | undefined): void {
  registered = test;
}

export function registeredModelAbTest(): ModelAbTest | undefined {
  return registered;
}

export function resetModelAbTest(): void {
  registered = undefined;
}

export function modelAbTestArmed(test: ModelAbTest | undefined): test is ModelAbTest {
  return test !== undefined && test.percent > 0 && test.challenger.trim().length > 0;
}

export function abBucketKey(surfaceKey: string, threadKey: string | undefined): string {
  return `${surfaceKey}::${threadKey ?? ""}`;
}

export function abThreadKey(ctx: BindableContext): string | undefined {
  try {
    const raw = ctx.channel?.continuationToken;
    return bareTokenFromEveContext(raw) ?? raw;
  } catch {
    return undefined;
  }
}

export function abBucket(bucketKey: string): number {
  const bytes = new TextEncoder().encode(bucketKey);
  let h = 0x811c9dc5;
  for (const b of bytes) {
    h ^= b;
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) % 100;
}

export function armForBucket(bucketKey: string, test: ModelAbTest | undefined): ModelArm {
  if (!modelAbTestArmed(test)) return "champion";
  return abBucket(bucketKey) < test.percent ? "challenger" : "champion";
}

export interface ModelAbInput {
  readonly test: ModelAbTest | undefined;
  readonly bucketKey: string;
}

export interface ModelAbDecision {
  readonly arm: ModelArm;
  readonly bucketKey: string;
  readonly requestedId?: string;
}

export function decideModelAb(route: ModelRoute, championId: string, input: ModelAbInput): ModelAbDecision | undefined {
  if (!modelAbTestArmed(input.test)) return undefined;
  if (route.id !== undefined && route.id !== championId) return undefined;
  if (route.tier !== undefined) return undefined;
  const arm = armForBucket(input.bucketKey, input.test);
  return arm === "challenger" ? { arm, bucketKey: input.bucketKey, requestedId: input.test.challenger } : { arm, bucketKey: input.bucketKey };
}

export function applyModelAb(route: ModelRoute, decision: ModelAbDecision | undefined): ModelRoute {
  if (decision?.requestedId === undefined) return route;
  return { ...route, id: decision.requestedId, tier: undefined };
}

export function resolveModelArm(decision: ModelAbDecision, resolvedId: string): ModelArm {
  if (decision.arm === "champion") return "champion";
  return resolvedId === decision.requestedId ? "challenger" : "champion";
}

export interface ModelArmStamp {
  readonly arm: ModelArm;
  readonly bucketKey: string;
  readonly modelId: string;
}

const armSlot = defineState<ModelArmStamp | null>("open-everywhere.model-ab-arm", () => null);

export function stampModelArm(stamp: ModelArmStamp | null): void {
  try {
    armSlot.update(() => stamp);
  } catch {
  }
}

export function readModelArm(): ModelArmStamp | null {
  try {
    return armSlot.get();
  } catch {
    return null;
  }
}

const armRowsWritten = new Set<string>();
const ARM_ROW_MEMORY = 2_000;

export function _resetModelAbArmRowsForTest(): void {
  armRowsWritten.clear();
}

export function noteModelAbArm(ctx: BindableContext, stamp: ModelArmStamp | null, event?: unknown, deps: { readonly appendAudit?: typeof appendAudit } = {}): void {
  try {
    if (stamp === null) return;
    const sessionId = currentSessionId(ctx);
    const turnId = currentTurnId(ctx) ?? eventTurnId(event);
    if (turnId === undefined) return;
    const key = `${sessionId ?? ""}:${turnId}`;
    if (armRowsWritten.has(key)) return;
    if (armRowsWritten.size >= ARM_ROW_MEMORY) armRowsWritten.delete(armRowsWritten.values().next().value as string);
    armRowsWritten.add(key);
    const p = resolvePartition(ctx);
    const b = bindFrom(ctx);
    void (deps.appendAudit ?? appendAudit)({
      org: p.org,
      platform: p.platform,
      workspace: p.workspace,
      surface: domainKeyOf(p),
      ...(b.principalId ? { principalId: b.principalId } : {}),
      action: MODEL_AB_ARM_ACTION,
      detail: {
        arm: stamp.arm,
        bucketKey: stamp.bucketKey,
        modelId: stamp.modelId,
        ...(sessionId !== undefined ? { sessionId } : {}),
        turnId,
      },
    });
  } catch (err) {
    console.warn(`[open-everywhere:model-ab] arm row skipped: ${String(err)}`);
  }
}

function eventTurnId(event: unknown): string | undefined {
  const turnId = (event as { data?: { turnId?: unknown } } | undefined)?.data?.turnId;
  return typeof turnId === "string" && turnId.length > 0 ? turnId : undefined;
}
