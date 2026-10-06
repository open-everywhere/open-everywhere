import type { OperationalStore } from "../operational/store.js";
import { getOperationalStore } from "../operational/provider.js";
import { appendAudit } from "../audit/audit.js";
import { formatWindowToken, parseWindowToken, isWorkWindowId, workWindowId, saltSupervisorGeneration, bareTokenFromEveContext } from "./window-key.js";
import { unifiedDomainSessionKey, standingSeatRegistryKey } from "./unified-supervisor.js";
import { rotationTrigger, type RotationTrigger } from "./turn-delivery.js";
import { claimRuntimeRotation, stampMintedRuntime } from "./runtime-rotation.js";
import { parkRotateDelta } from "./session-park.js";
import { isWorkSessionContext } from "../access/work-session.js";
import { resolveOwnWindowToken } from "../access/delegation-mount.js";
import { deploymentOrg, type BindableContext } from "../identity/binding.js";
import { generationOfTask, generationOwedDelegation, generationOwedTaskIds, noteGenerationForRetirement, GENERATION_DELEGATION_TTL_MS } from "./generation-retirement.js";

export const WORK_ROTATED_ACTION = "work.session_rotated";
export const WORK_ROTATION_DEFERRED_ACTION = "work.session_rotation_deferred";
export const WORK_REQUEST_LOST_ACTION = "work.request_lost";
const WORK_ROTATION_PRINCIPAL = "oe:work-rotation";

const WORK_SESSION_LEDGER_PREFIX = "work-session:";

export function workSessionLedgerId(requestId: string): string {
  return `${WORK_SESSION_LEDGER_PREFIX}${requestId}`;
}

export function requestIdOfWorkSessionLedgerId(id: string): string | undefined {
  return id.startsWith(WORK_SESSION_LEDGER_PREFIX) && id.length > WORK_SESSION_LEDGER_PREFIX.length ? id.slice(WORK_SESSION_LEDGER_PREFIX.length) : undefined;
}

function bare(token: string): string {
  return bareTokenFromEveContext(token) ?? token;
}

export function workRegistryKey(seatToken: string): string | undefined {
  const key = parseWindowToken(bare(seatToken));
  if (key === undefined || isWorkWindowId(key.windowId)) return undefined;
  return unifiedDomainSessionKey(workWindowId(key.windowId));
}

function firstWorkToken(seatToken: string): string | undefined {
  const key = parseWindowToken(bare(seatToken));
  if (key === undefined || isWorkWindowId(key.windowId)) return undefined;
  return formatWindowToken({ domain: key.domain, windowId: workWindowId(key.windowId), generation: 1 });
}

export function isSameWorkSession(a: string | undefined, b: string | undefined): boolean {
  if (a === undefined || b === undefined) return false;
  const ka = parseWindowToken(bare(a));
  const kb = parseWindowToken(bare(b));
  return ka !== undefined && kb !== undefined && isWorkWindowId(ka.windowId) && ka.domain === kb.domain && ka.windowId === kb.windowId;
}

export async function currentWorkToken(org: string, seatToken: string, store: Partial<Pick<OperationalStore, "getChannelSession">> = getOperationalStore()): Promise<string | undefined> {
  const key = workRegistryKey(seatToken);
  const first = firstWorkToken(seatToken);
  if (key === undefined || first === undefined) return undefined;
  if (store.getChannelSession === undefined) return first;
  try {
    const row = await store.getChannelSession(org, key);
    return row !== null && isSameWorkSession(row.token, first) ? row.token : first;
  } catch {
    return first;
  }
}

export async function workTokenHoldingTask(
  org: string,
  seatToken: string,
  taskId: string,
  store: Pick<OperationalStore, "getTaskResult"> & Partial<Pick<OperationalStore, "getChannelSession">> = getOperationalStore(),
): Promise<string | undefined> {
  const first = firstWorkToken(seatToken);
  if (first === undefined) return undefined;
  const noted = await generationOfTask(org, taskId, store);
  if (noted !== undefined && isSameWorkSession(noted, first)) return noted;
  return currentWorkToken(org, seatToken, store);
}

export async function currentSeatToken(org: string, recordedSeatToken: string, store: Pick<OperationalStore, "getChannelSession"> = getOperationalStore()): Promise<string> {
  const recorded = bare(recordedSeatToken);
  const key = parseWindowToken(recorded);
  if (key === undefined || isWorkWindowId(key.windowId)) return recordedSeatToken;
  const registryKey = standingSeatRegistryKey(recorded, "");
  if (registryKey === undefined || registryKey.length === 0) return recordedSeatToken;
  try {
    const row = await store.getChannelSession(org, registryKey);
    const live = row === null ? undefined : parseWindowToken(row.token);
    if (row === null || live === undefined || live.domain !== key.domain || live.windowId !== key.windowId) return recordedSeatToken;
    return row.token;
  } catch {
    return recordedSeatToken;
  }
}

const WORK_THRESHOLDS = { expiryMs: Number.POSITIVE_INFINITY, quietGapMs: Number.POSITIVE_INFINITY } as const;

function workDeadKey(token: string): string {
  return `oe-work-dead:${bare(token)}`;
}

export async function markWorkSessionDead(org: string, token: string, reason: "parked" | "failed", store: Pick<OperationalStore, "putTaskResult"> = getOperationalStore()): Promise<void> {
  try {
    await store.putTaskResult(org, workDeadKey(token), JSON.stringify({ reason }), new Date().toISOString(), GENERATION_DELEGATION_TTL_MS);
  } catch (err) {
    console.warn(`[open-everywhere:work] could not mark the work session ${bare(token)} ${reason}: ${String(err)}`);
  }
}

export async function workSessionMarkedDead(org: string, token: string, store: Pick<OperationalStore, "getTaskResult"> = getOperationalStore()): Promise<boolean> {
  try {
    return (await store.getTaskResult(org, workDeadKey(token))) !== null;
  } catch {
    return false;
  }
}

export interface WorkGeneration {
  readonly token: string;
  readonly generation: number;
  readonly minted?: true;
  readonly rotated?: { readonly from: string; readonly trigger: RotationTrigger | "parked"; readonly lostRequestIds: readonly string[]; readonly lostTaskIds: readonly string[] };
  readonly deferred?: { readonly trigger: RotationTrigger; readonly owed: number };
}

export interface WorkGenerationDeps {
  readonly store?: Pick<OperationalStore, "getChannelSession" | "rotateChannelSession" | "touchChannelSession" | "getTaskResult" | "stampChannelSessionRuntime">;
  readonly audit?: typeof appendAudit;
  readonly claimRuntime?: () => Promise<boolean>;
  readonly stampRuntime?: () => Promise<void>;
  readonly salt?: (token: string) => string;
}

export async function resolveWorkGeneration(
  input: { readonly org: string; readonly seatToken: string; readonly surfaceKey: string; readonly atIso: string },
  deps: WorkGenerationDeps = {},
): Promise<WorkGeneration> {
  const registryKey = workRegistryKey(input.seatToken);
  const first = firstWorkToken(input.seatToken);
  const domainName = parseWindowToken(bare(input.seatToken))?.domain;
  if (registryKey === undefined || first === undefined || domainName === undefined) {
    throw new Error("work: this seat has no window token, so it has no work session.");
  }
  const store = deps.store ?? getOperationalStore();
  const audit = deps.audit ?? appendAudit;
  const scope = { org: input.org, registryKey, surfaceKey: input.surfaceKey, domainName, atIso: input.atIso };
  const runtimeChanged = await (deps.claimRuntime ?? (() => claimRuntimeRotation(scope, { store })))();
  const existing = await store.getChannelSession(input.org, registryKey);

  if (existing === null) {
    const row = await store.rotateChannelSession(input.org, registryKey, first, input.atIso);
    await (deps.stampRuntime ?? (() => stampMintedRuntime(scope, { store })))();
    await store.touchChannelSession(input.org, registryKey, input.atIso);
    return { token: row.token, generation: row.generation, minted: true };
  }

  const parked = await workSessionMarkedDead(input.org, existing.token, store);
  const trigger: RotationTrigger | "parked" | null = runtimeChanged ? "runtime-changed" : parked ? "parked" : rotationTrigger(existing, input.atIso, WORK_THRESHOLDS);
  if (trigger === null) {
    await store.touchChannelSession(input.org, registryKey, input.atIso);
    return { token: existing.token, generation: existing.generation };
  }

  const owed = await generationOwedTaskIds(input.org, existing.token, store);
  const hard = trigger === "runtime-changed" || trigger === "parked" || trigger === "operator-marked";
  if (!hard && owed.length > 0) {
    await audit({
      org: input.org,
      platform: "unified",
      workspace: domainName,
      principalId: WORK_ROTATION_PRINCIPAL,
      action: WORK_ROTATION_DEFERRED_ACTION,
      detail: { registryKey, token: existing.token, generation: existing.generation, trigger, owed: owed.length },
    }).catch(() => undefined);
    await store.touchChannelSession(input.org, registryKey, input.atIso);
    return { token: existing.token, generation: existing.generation, deferred: { trigger, owed: owed.length } };
  }

  const next = (deps.salt ?? saltSupervisorGeneration)(formatWindowToken({ domain: domainName, windowId: parseWindowToken(first)!.windowId, generation: existing.generation + 1 }));
  const row = await store.rotateChannelSession(input.org, registryKey, next, input.atIso);
  await store.touchChannelSession(input.org, registryKey, input.atIso);
  noteGenerationForRetirement({ org: input.org, registryKey, token: existing.token });
  const lostRequestIds = owed.map(requestIdOfWorkSessionLedgerId).filter((id): id is string => id !== undefined);
  const lostTaskIds = owed.filter((id) => requestIdOfWorkSessionLedgerId(id) === undefined);
  await audit({
    org: input.org,
    platform: "unified",
    workspace: domainName,
    principalId: WORK_ROTATION_PRINCIPAL,
    action: WORK_ROTATED_ACTION,
    detail: {
      registryKey,
      from: existing.token,
      to: row.token,
      generation: row.generation,
      trigger,
      lostRequests: lostRequestIds.length,
      lostTasks: lostTaskIds.length,
      note: "the work session rotated: its sandbox and any task still running in it are gone; durable memory is in the store",
    },
  }).catch(() => undefined);
  return { token: row.token, generation: row.generation, rotated: { from: existing.token, trigger, lostRequestIds, lostTaskIds } };
}

export async function workSessionIdle(org: string, workToken: string, store: Pick<OperationalStore, "getTaskResult"> = getOperationalStore()): Promise<{ readonly idle: boolean; readonly owed: readonly string[] }> {
  const token = bare(workToken);
  const state = await generationOwedDelegation(org, token, store);
  if (state === "unreadable") return { idle: false, owed: [] };
  if (state === "none") return { idle: true, owed: [] };
  return { idle: false, owed: await generationOwedTaskIds(org, token, store) };
}

export async function workSessionSandboxState(ctx: BindableContext, store?: Pick<OperationalStore, "getTaskResult">): Promise<{ readonly work: false } | { readonly work: true; readonly idle: boolean; readonly owed: readonly string[]; readonly token: string }> {
  if (!isWorkSessionContext(ctx)) return { work: false };
  const token = resolveOwnWindowToken(ctx);
  if (token === undefined) return { work: true, idle: false, owed: [], token: "" };
  const state = await workSessionIdle(deploymentOrg(), token, store);
  return { work: true, ...state, token: bare(token) };
}

export const WORK_SESSION_FAILED_ACTION = "work.session_failed";

export async function retireFailedWorkSession(
  input: { readonly org: string; readonly token: string; readonly code?: string },
  deps: { readonly store?: Pick<OperationalStore, "bumpChannelSessionUsage" | "getTaskResult" | "putTaskResult">; readonly audit?: typeof appendAudit } = {},
): Promise<{ readonly retired: boolean; readonly lostRequestIds: readonly string[] }> {
  const token = bare(input.token);
  const key = parseWindowToken(token);
  if (key === undefined || !isWorkWindowId(key.windowId)) return { retired: false, lostRequestIds: [] };
  const store = deps.store ?? getOperationalStore();
  const registryKey = unifiedDomainSessionKey(key.windowId);
  let retired = false;
  try {
    retired = (await store.bumpChannelSessionUsage(input.org, registryKey, token, parkRotateDelta())) > 0;
  } catch (err) {
    console.warn(`[open-everywhere:work] could not retire the failed work session ${token}: ${String(err)}`);
  }
  await markWorkSessionDead(input.org, token, "failed", store);
  const owed = await generationOwedTaskIds(input.org, token, store);
  const lostRequestIds = owed.map(requestIdOfWorkSessionLedgerId).filter((id): id is string => id !== undefined);
  await (deps.audit ?? appendAudit)({
    org: input.org,
    platform: "unified",
    workspace: key.domain,
    principalId: WORK_ROTATION_PRINCIPAL,
    action: WORK_SESSION_FAILED_ACTION,
    detail: {
      registryKey,
      token,
      retired,
      lostRequests: lostRequestIds.length,
      ...(input.code !== undefined ? { code: input.code.slice(0, 120) } : {}),
      note: retired
        ? "the work session failed; its generation was retired, so the next forward re-mints it with a fresh sandbox"
        : "the work session failed, and no live registry row matched its token (it had already rotated)",
    },
  }).catch(() => undefined);
  return { retired, lostRequestIds };
}
