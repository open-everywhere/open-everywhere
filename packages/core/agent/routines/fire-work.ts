import type { RouteHandlerArgs } from "eve/channels";
import { bindingForDivert, dispatchWorkRequest } from "../channels/unified.js";
import { isUnifiedWakeOrigin, OE_GRAIN_ATTR, type UnifiedWakeOrigin } from "../channels/unified-window.js";
import { grainUsesUnifiedWindow, supervisorGrainFor, supervisorTokenForGrain } from "../channels/unified-supervisor.js";
import { parseWindowToken } from "../channels/window-key.js";
import { renderWorkRequest, rememberWorkRequest, workLedgerId, workRequestIdFor, workTokenForSeat, WORK_FORWARDED_ACTION, type WorkFireRow, type WorkRequestRow, type WorkRowStore } from "../channels/work.js";
import { resolveWorkGeneration, workSessionLedgerId, type WorkGeneration } from "../channels/work-generation.js";
import { notifyLostWorkRequests } from "../channels/work-loss.js";
import { noteGenerationDelegation } from "../channels/generation-retirement.js";
import { rememberWorkForward } from "../hooks/work-task-key.js";
import { outboundKey, postOnce } from "../operational/post-once.js";
import { getOperationalStore } from "../operational/provider.js";
import type { OperationalStore } from "../operational/store.js";
import { appendAudit } from "../audit/audit.js";
import { OE_REQUESTER_CANDIDATES_ATTR, OE_REQUESTER_ATTR, REQUESTER_UNVERIFIED, type RequesterVerdict } from "../access/requester-identity.js";
import { INVOKER_POSTURE_ATTR, resolveInvokerPosture, type InvokerPosture } from "../access/invoker-posture.js";
import { OE_TAINTED_FIRE_ATTR } from "../access/taint-signal.js";
import { JOB_TAINT_ATTR } from "../access/job-posture.js";
import { FIRE_PRINCIPAL_ATTR, type SurfaceBinding } from "../identity/binding.js";
import type { Domain } from "../memory/domain.js";
import { oneAttrValue, routineManualStamped, routineMarker, routineSilentStamped } from "./routine.js";
import { WEBHOOK_MARKER_ATTR } from "./fire-auth.js";

export const FIRE_REQUESTER_REASON = "routine-fire";

export const FIRE_REQUESTER: RequesterVerdict = { kind: "unverified", reason: FIRE_REQUESTER_REASON };

export interface FireWorkPlan {
  readonly seatToken: string;
  readonly workToken: string;
  readonly domain: string;
}

export function planFireWork(input: {
  readonly surfaceKey: string;
  readonly origin: UnifiedWakeOrigin;
  readonly domains: readonly Domain[];
  readonly seatRowToken: string | undefined;
  readonly armed: boolean;
}): FireWorkPlan | null {
  if (!input.armed) return null;
  if (!isUnifiedWakeOrigin(input.origin)) return null;
  const grain = supervisorGrainFor(input.surfaceKey, input.domains);
  if (!grain.unified || grain.domainName === undefined || !grainUsesUnifiedWindow(grain)) return null;
  const derived = supervisorTokenForGrain(grain, 1, () => {
    throw new Error("planFireWork: a per-container token is unreachable behind the unified grain guard");
  });
  const derivedKey = parseWindowToken(derived);
  const rowKey = input.seatRowToken === undefined ? undefined : parseWindowToken(input.seatRowToken);
  const sameWindow = rowKey !== undefined && derivedKey !== undefined && rowKey.domain === derivedKey.domain && rowKey.windowId === derivedKey.windowId;
  const seatToken = sameWindow ? (input.seatRowToken as string) : derived;
  const workToken = workTokenForSeat(seatToken);
  if (workToken === undefined) return null;
  return { seatToken, workToken, domain: grain.domainName };
}

export function fireRowOf(attributes: Readonly<Record<string, unknown>>): WorkFireRow {
  const attrs = attributes as Record<string, string | readonly string[]>;
  const marker = routineMarker(attrs);
  const creator = oneAttrValue(attrs[FIRE_PRINCIPAL_ATTR]);
  return {
    owesRoom: !routineSilentStamped(attrs),
    manual: routineManualStamped(attrs),
    ...(marker !== null ? { marker } : {}),
    ...(creator !== undefined && creator.length > 0 ? { creator } : {}),
  };
}

export function fireTainted(attributes: Readonly<Record<string, unknown>>): boolean {
  const attrs = attributes as Record<string, string | readonly string[]>;
  return oneAttrValue(attrs[OE_TAINTED_FIRE_ATTR]) === "true" || oneAttrValue(attrs[JOB_TAINT_ATTR]) === "true";
}

export function firePosture(auth: { readonly authenticator?: string; readonly principalId?: string; readonly attributes?: Readonly<Record<string, unknown>> }): InvokerPosture {
  const attrs = (auth.attributes ?? {}) as Record<string, string | readonly string[]>;
  const principalId = typeof auth.principalId === "string" ? auth.principalId : "";
  return resolveInvokerPosture({
    webhookFire: auth.authenticator === "webhook" || attrs[WEBHOOK_MARKER_ATTR] !== undefined,
    eventSubFire: principalId.endsWith(":webhook"),
    unattendedFire: true,
    manualFire: routineManualStamped(attrs),
    stamped: attrs[INVOKER_POSTURE_ATTR],
  });
}

export interface FireWorkDeps {
  readonly org: string;
  readonly store: WorkRowStore & Pick<OperationalStore, "getChannelSession">;
  readonly dispatch: typeof dispatchWorkRequest;
  readonly resolveWork: (input: { readonly org: string; readonly seatToken: string; readonly surfaceKey: string; readonly atIso: string }) => Promise<WorkGeneration>;
  readonly noteLedger: (org: string, token: string, ledgerId: string) => Promise<void>;
  readonly notifyLost: typeof notifyLostWorkRequests;
  readonly binding: typeof bindingForDivert;
  readonly audit: (row: Parameters<typeof appendAudit>[0]) => Promise<unknown>;
  readonly now: () => string;
}

export function liveFireWorkDeps(org: string): FireWorkDeps {
  return {
    org,
    store: getOperationalStore(),
    dispatch: dispatchWorkRequest,
    resolveWork: (input) => resolveWorkGeneration(input),
    noteLedger: (o, token, id) => noteGenerationDelegation(o, token, id),
    notifyLost: notifyLostWorkRequests,
    binding: bindingForDivert,
    audit: appendAudit,
    now: () => new Date().toISOString(),
  };
}

export async function fireSeatRowToken(org: string, surfaceKey: string, domains: readonly Domain[], store: Pick<OperationalStore, "getChannelSession">): Promise<string | undefined> {
  const grain = supervisorGrainFor(surfaceKey, domains);
  if (!grain.unified) return undefined;
  try {
    return (await store.getChannelSession(org, grain.registryKey))?.token ?? undefined;
  } catch {
    return undefined;
  }
}

export async function forwardFireToWork(
  receive: RouteHandlerArgs["to"],
  plan: FireWorkPlan,
  input: {
    readonly message: string;
    readonly surfaceKey: string;
    readonly origin: UnifiedWakeOrigin;
    readonly auth: { readonly authenticator?: string; readonly principalId?: string; readonly attributes?: Record<string, unknown> };
    readonly wakeId: string;
  },
  deps: FireWorkDeps,
): Promise<boolean> {
  const org = deps.org;
  const requestId = workRequestIdFor(`fire:${input.wakeId}`);
  const fireAttributes: Record<string, unknown> = { ...(input.auth.attributes ?? {}) };
  delete fireAttributes[OE_REQUESTER_ATTR];
  delete fireAttributes[OE_REQUESTER_CANDIDATES_ATTR];
  const binding: SurfaceBinding | undefined = deps.binding({
    attributes: { ...fireAttributes, [OE_GRAIN_ATTR]: "standing", [OE_REQUESTER_ATTR]: REQUESTER_UNVERIFIED },
    origin: input.origin,
    wakeId: requestId,
    token: plan.workToken,
  });
  if (binding === undefined) {
    console.warn(`[open-everywhere:fire-work] fire ${input.wakeId} on ${input.surfaceKey} names no surface, so it keeps the native send`);
    return false;
  }
  const posture = firePosture(input.auth);
  const fire: WorkFireRow = { ...fireRowOf(fireAttributes), posture };
  const tainted = fireTainted(fireAttributes);
  const atIso = deps.now();
  const row: WorkRequestRow = {
    requestId,
    seatToken: plan.seatToken,
    wakeId: input.wakeId,
    origin: input.origin,
    surfaceKey: input.surfaceKey,
    binding,
    requester: FIRE_REQUESTER,
    nonMemberWake: false,
    tainted,
    atIso,
    fire,
  };
  await rememberWorkRequest(deps.store, org, row);
  if (fire.owesRoom) await deps.noteLedger(org, plan.seatToken, workLedgerId(requestId));
  const generation = await deps.resolveWork({ org, seatToken: plan.seatToken, surfaceKey: input.surfaceKey, atIso });
  if (generation.rotated !== undefined) {
    const lost = generation.rotated.lostRequestIds.filter((id) => id !== requestId);
    if (lost.length > 0) await deps.notifyLost({ org, requestIds: lost, reason: `work-session ${generation.rotated.trigger}`, workToken: generation.rotated.from });
  }
  await deps.noteLedger(org, generation.token, workSessionLedgerId(requestId));
  const forward: Parameters<typeof dispatchWorkRequest>[0] = {
    token: generation.token,
    requestId,
    message: renderWorkRequest({ requestId, brief: input.message, origin: input.origin, nowIso: atIso }),
    origin: input.origin,
    surfaceKey: input.surfaceKey,
    binding,
    requester: FIRE_REQUESTER,
    nonMemberWake: false,
    seatWakeId: input.wakeId,
    tainted,
    invokerPosture: posture,
    fireAttributes,
  };
  await rememberWorkForward(deps.store, org, forward, atIso).catch(() => undefined);
  await postOnce({
    org,
    key: outboundKey({ surface: "work", action: "work.forward", stableId: requestId, payload: plan.workToken }),
    run: () => deps.dispatch(forward, receive),
  });
  await deps
    .audit({
      org,
      platform: "unified",
      workspace: plan.domain,
      surface: input.surfaceKey,
      action: WORK_FORWARDED_ACTION,
      detail: {
        requestId,
        wakeId: input.wakeId,
        workToken: generation.token,
        workGeneration: generation.generation,
        ...(generation.runtime !== undefined ? { workRuntime: generation.runtime } : {}),
        briefLen: input.message.length,
        tainted,
        fire: true,
        owesRoom: fire.owesRoom,
        ...(fire.marker !== undefined ? { routineId: fire.marker.id } : {}),
      },
    })
    .catch(() => undefined);
  return true;
}
