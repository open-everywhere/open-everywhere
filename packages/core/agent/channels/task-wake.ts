import { appendAudit } from "../audit/audit.js";
import { getOperationalStore } from "../operational/provider.js";
import { adoptTaskWakeThisTurn, uningressedTurn } from "../access/task-wake-signal.js";
import type { DispatchedTaskWake } from "../access/dispatch-origin-signal.js";
import {
  mintWakeId,
  isWakeSurfaceBinding,
  registerUnifiedWakeTarget,
  resolveUnifiedWakeAuthority,
  resolveUnifiedWakeBinding,
  resolveUnifiedWakeSurfaceKey,
  resolveUnifiedWakeTarget,
  sameUnifiedConversation,
  sameUnifiedPlacement,
  withCarriedPlacement,
  WAKE_TARGET_TTL_MS,
  type ResolvedUnifiedWakeAuthority,
} from "./unified-window.js";
import { adoptDelegatedAuthority, adoptDelegatedRootSession, delegatedAuthorityResolvedFor, delegatedBindingAdopted, pinDelegatedBindingToTurn, refreshDelegatedAuthority, type DelegatedDispatchAuthority } from "../identity/delegated-binding.js";
import { currentTurnId, delegationRootSessionId, deploymentOrg, isSubagentChildContext, subagentParentSessionId, type BindableContext, type SurfaceBinding } from "../identity/binding.js";
import { isRequesterVerdict, type RequesterVerdict } from "../access/requester-identity.js";
import type { SettlementDispatchAuthority } from "../access/settlement-dispatch-signal.js";

export const TASK_WAKE_ACTION = "unified.task_wake";

export const TASK_WAKE_RETARGET_ACTION = "unified.task_wake_retarget";

export const TASK_WAKE_UNREAD_REFUSAL_REASON = "task-wake-unread";

export function taskWakeUnreadRefusalMessage(): string {
  return (
    "reply: this turn was woken by delegated work finishing, and it has NO reply address — nothing was posted. " +
    "The wake-id from the previous message belongs to a different conversation, so replying under it would answer a room that asked nothing. " +
    "No tool call can recover the address: the task's own wake record is missing or expired. " +
    "Call `no_reply` to end this turn, and say what the worker found the next time that conversation asks."
  );
}

const TASK_WAKE_PREFIX = "oe-task-wake:";
const DELEGATED_TASK_WAKE_PREFIX = "oe-delegated-task-wake:";

const TASK_WAKE_TTL_MS = WAKE_TARGET_TTL_MS;

export function taskWakeKey(taskId: string): string {
  return `${TASK_WAKE_PREFIX}${taskId}`;
}

const TASK_START_WAKE_PREFIX = "oe-task-start-wake:";

function taskStartWakeKey(parentSessionId: string, callId: string, taskId: string): string {
  return `${TASK_START_WAKE_PREFIX}${parentSessionId}:${callId}:${taskId}`;
}

function delegatedTaskWakeKey(parentSessionId: string, callId: string): string {
  return `${DELEGATED_TASK_WAKE_PREFIX}${parentSessionId}:${callId}`;
}

export async function rememberDelegatedTaskWake(
  org: string,
  parentSessionId: string,
  callId: string,
  wakeId: string,
  _requester?: RequesterVerdict,
  _nonMemberWake?: boolean,
): Promise<void> {
  if (parentSessionId.length === 0 || callId.length === 0 || wakeId.length === 0) {
    throw new Error("delegated task wake pointer requires parent session, call, and wake ids");
  }
  const authority = await resolveUnifiedWakeAuthority(getOperationalStore(), org, wakeId);
  if (authority === undefined) throw new Error("delegated task wake pointer requires exact per-wake authority");
  await getOperationalStore().putTaskResult(
    org,
    delegatedTaskWakeKey(parentSessionId, callId),
    JSON.stringify({ wakeId, requester: authority.requester, nonMemberWake: authority.nonMemberWake }),
    new Date().toISOString(),
    TASK_WAKE_TTL_MS,
  );
}

export async function rememberDelegatedTaskBinding(
  org: string,
  parentSessionId: string,
  callId: string,
  binding: SurfaceBinding,
  requester: RequesterVerdict,
  nonMemberWake: boolean,
): Promise<void> {
  if (parentSessionId.length === 0 || callId.length === 0 || !isWakeSurfaceBinding(binding) || binding.org !== org || !isRequesterVerdict(requester)) {
    throw new Error("delegated task binding pointer requires a valid parent, call, and binding");
  }
  await getOperationalStore().putTaskResult(
    org,
    delegatedTaskWakeKey(parentSessionId, callId),
    JSON.stringify({ binding, requester, nonMemberWake }),
    new Date().toISOString(),
    TASK_WAKE_TTL_MS,
  );
}

type DelegatedTaskAuthority = ({ readonly wakeId: string } | { readonly binding: SurfaceBinding }) & { readonly requester: RequesterVerdict; readonly nonMemberWake: boolean };

async function readDelegatedTaskAuthority(org: string, parentSessionId: string, callId: string): Promise<DelegatedTaskAuthority | undefined> {
  try {
    if (parentSessionId.length === 0 || callId.length === 0) return undefined;
    const raw = await getOperationalStore().getTaskResult(org, delegatedTaskWakeKey(parentSessionId, callId));
    if (raw === null) return undefined;
    const parsed = JSON.parse(raw) as { wakeId?: unknown; binding?: unknown; requester?: unknown; nonMemberWake?: unknown } | null;
    if (!isRequesterVerdict(parsed?.requester) || typeof parsed?.nonMemberWake !== "boolean") return undefined;
    if (typeof parsed?.wakeId === "string" && parsed.wakeId.length > 0) return { wakeId: parsed.wakeId, requester: parsed.requester, nonMemberWake: parsed.nonMemberWake };
    if (isWakeSurfaceBinding(parsed?.binding) && parsed.binding.org === org) return { binding: parsed.binding, requester: parsed.requester, nonMemberWake: parsed.nonMemberWake };
    return undefined;
  } catch {
    return undefined;
  }
}

export interface ResolvedDelegatedTaskAuthority extends ResolvedUnifiedWakeAuthority {
  readonly wakeId: string;
}

export async function resolveDelegatedTaskAuthority(ctx: BindableContext): Promise<ResolvedDelegatedTaskAuthority | undefined> {
  if (!isSubagentChildContext(ctx)) return undefined;
  const parentSessionId = subagentParentSessionId(ctx);
  const callId = ctx.session?.parent?.callId;
  if (parentSessionId === undefined || typeof callId !== "string" || callId.length === 0) return undefined;
  const org = deploymentOrg();
  const pointer = await readDelegatedTaskAuthority(org, parentSessionId, callId);
  if (pointer === undefined || !("wakeId" in pointer)) return undefined;
  const authority = await resolveUnifiedWakeAuthority(getOperationalStore(), org, pointer.wakeId);
  if (
    authority === undefined ||
    JSON.stringify(authority.requester) !== JSON.stringify(pointer.requester) ||
    authority.nonMemberWake !== pointer.nonMemberWake
  ) return undefined;
  return { wakeId: pointer.wakeId, ...authority };
}

export async function delegatedTaskDispatchAuthority(
  org: string,
  parentSessionId: string,
  callId: string,
): Promise<SettlementDispatchAuthority | undefined> {
  const pointer = await readDelegatedTaskAuthority(org, parentSessionId, callId);
  if (pointer === undefined || !("wakeId" in pointer)) return undefined;
  const authority = await resolveUnifiedWakeAuthority(getOperationalStore(), org, pointer.wakeId);
  if (
    authority === undefined ||
    JSON.stringify(authority.requester) !== JSON.stringify(pointer.requester) ||
    authority.nonMemberWake !== pointer.nonMemberWake
  ) return undefined;
  return { wakeId: pointer.wakeId, requester: authority.requester, nonMemberWake: authority.nonMemberWake };
}

export async function advanceDelegatedTaskWake(
  org: string,
  parentSessionId: string,
  callId: string,
  taskId: string,
  wakeId: string,
  expected: SettlementDispatchAuthority,
): Promise<void> {
  const authority = await readDelegatedTaskAuthority(org, parentSessionId, callId);
  if (
    authority === undefined ||
    !("wakeId" in authority) ||
    JSON.stringify({ wakeId: authority.wakeId, requester: authority.requester, nonMemberWake: authority.nonMemberWake }) !== JSON.stringify(expected)
  ) {
    throw new Error("delegated task authority changed before receipt");
  }
  await getOperationalStore().putTaskResult(
    org,
    taskStartWakeKey(parentSessionId, callId, taskId),
    JSON.stringify({ wakeId, parentWakeId: expected.wakeId }),
    new Date().toISOString(),
    TASK_WAKE_TTL_MS,
  );
  await rememberDelegatedTaskWake(org, parentSessionId, callId, wakeId, authority.requester, authority.nonMemberWake);
  await getOperationalStore().putTaskResult(
    org,
    taskWakeKey(taskId),
    JSON.stringify({ wakeId, parentSessionId, callId, requester: authority.requester, nonMemberWake: authority.nonMemberWake }),
    new Date().toISOString(),
    TASK_WAKE_TTL_MS,
  );
}

/**
 * The wakes one task start wrote: the minted task wake and the dispatch wake it was minted under.
 * `advanceDelegatedTaskWake` writes this row for one call of one task, BEFORE it points the call's
 * authority row at the minted wake, because after that point the authority row no longer names the
 * dispatch wake. The row is per call: another start of the same task writes its own row, while it
 * overwrites the task-wide wake row. The read returns `undefined` when the row is absent or unparseable.
 * A store read that fails throws, because the caller must not read a failed read as an absent row.
 */
export async function startedTaskWake(
  org: string,
  taskId: string,
  parentSessionId: string,
  callId: string,
): Promise<{ readonly wakeId: string; readonly parentWakeId: string } | undefined> {
  if (taskId.length === 0 || parentSessionId.length === 0 || callId.length === 0) return undefined;
  const raw = await getOperationalStore().getTaskResult(org, taskStartWakeKey(parentSessionId, callId, taskId));
  if (raw === null) return undefined;
  try {
    const parsed = JSON.parse(raw) as { wakeId?: unknown; parentWakeId?: unknown } | null;
    if (typeof parsed?.wakeId !== "string" || parsed.wakeId.length === 0) return undefined;
    if (typeof parsed.parentWakeId !== "string" || parsed.parentWakeId.length === 0) return undefined;
    return { wakeId: parsed.wakeId, parentWakeId: parsed.parentWakeId };
  } catch {
    return undefined;
  }
}

async function readDelegatedSnapshot(org: string, parentSessionId: string, callId: string): Promise<DelegatedDispatchAuthority | "no-row" | "no-binding"> {
  const authority = await readDelegatedTaskAuthority(org, parentSessionId, callId);
  if (authority === undefined) return "no-row";
  const resolved = "wakeId" in authority ? await resolveUnifiedWakeAuthority(getOperationalStore(), org, authority.wakeId) : undefined;
  if (
    resolved !== undefined &&
    (JSON.stringify(resolved.requester) !== JSON.stringify(authority.requester) || resolved.nonMemberWake !== authority.nonMemberWake)
  ) return "no-binding";
  const binding = "binding" in authority ? authority.binding : resolved?.binding;
  if (binding === undefined) return "no-binding";
  return {
    binding,
    requester: authority.requester,
    nonMemberWake: authority.nonMemberWake,
    ...("wakeId" in authority ? { wakeId: authority.wakeId } : {}),
  };
}

async function restoreDelegatedTaskBinding(input: {
  readonly org: string;
  readonly parentSessionId: string;
  readonly callId: string;
  readonly turnId: string | undefined;
  readonly laterTurn: boolean;
}): Promise<"adopted" | "already" | "refreshed" | "no-row" | "no-binding"> {
  if (delegatedBindingAdopted()) {
    pinDelegatedBindingToTurn(input.turnId);
    if (!input.laterTurn || input.turnId === undefined || delegatedAuthorityResolvedFor(input.turnId)) return "already";
    const refreshed = await readDelegatedSnapshot(input.org, input.parentSessionId, input.callId);
    if (typeof refreshed === "string") return refreshed;
    return refreshDelegatedAuthority(refreshed, input.turnId) ? "refreshed" : "no-binding";
  }
  const snapshot = await readDelegatedSnapshot(input.org, input.parentSessionId, input.callId);
  if (typeof snapshot === "string") return snapshot;
  return adoptDelegatedAuthority(snapshot, input.turnId) ? "adopted" : "no-binding";
}

export class DelegatedTaskBindingUnavailableError extends Error {
  readonly outcome: "no-row" | "no-binding";

  constructor(outcome: "no-row" | "no-binding") {
    super(`delegated task binding unavailable: ${outcome}`);
    this.name = "DelegatedTaskBindingUnavailableError";
    this.outcome = outcome;
  }
}

export async function ensureDelegatedTaskBinding(ctx: BindableContext): Promise<void> {
  if (!isSubagentChildContext(ctx)) return;
  const parentSessionId = subagentParentSessionId(ctx);
  const callId = ctx.session?.parent?.callId;
  if (parentSessionId === undefined || typeof callId !== "string" || callId.length === 0) return;
  const sequence = (ctx as { session?: { turn?: { sequence?: unknown } } }).session?.turn?.sequence;
  const laterTurn = typeof sequence === "number" && sequence > 0;
  const outcome = await restoreDelegatedTaskBinding({ org: deploymentOrg(), parentSessionId, callId, turnId: currentTurnId(ctx), laterTurn });
  if (outcome === "no-row" || outcome === "no-binding") throw new DelegatedTaskBindingUnavailableError(outcome);
  const root = delegationRootSessionId(ctx);
  if (root !== undefined) adoptDelegatedRootSession(root);
}

export async function openTaskWake(input: {
  readonly org: string;
  readonly taskId: string;
  readonly parentWakeId: string | undefined;
  readonly windowToken: string | undefined;
}): Promise<string | null> {
  try {
    if (input.taskId.length === 0) return null;
    if (input.parentWakeId === undefined || input.parentWakeId.length === 0) return null;
    const store = getOperationalStore();
    const origin = await resolveUnifiedWakeTarget(store, input.org, input.parentWakeId);
    if (origin === null) return null;
    const authority = await resolveUnifiedWakeAuthority(store, input.org, input.parentWakeId);
    const frozenAuthority = authority === undefined
      ? undefined
      : { binding: authority.binding, requester: authority.requester, nonMemberWake: authority.nonMemberWake };
    const binding = authority?.binding ?? await resolveUnifiedWakeBinding(store, input.org, input.parentWakeId);
    const surfaceKey = authority?.surfaceKey ?? await resolveUnifiedWakeSurfaceKey(store, input.org, input.parentWakeId);
    const wakeId = mintWakeId();
    const at = new Date().toISOString();
    await registerUnifiedWakeTarget(store, input.org, wakeId, origin, at, input.windowToken, undefined, undefined, surfaceKey, binding, frozenAuthority);
    await store.putTaskResult(input.org, taskWakeKey(input.taskId), JSON.stringify({ wakeId }), at, TASK_WAKE_TTL_MS);
    return wakeId;
  } catch {
    return null;
  }
}

export async function retargetTaskWakes(input: {
  readonly org: string;
  readonly tasks: readonly DispatchedTaskWake[];
  readonly addressedWakeId: string;
  readonly windowToken: string | undefined;
  readonly turnId: string | undefined;
}): Promise<number> {
  try {
    if (input.tasks.length === 0) return 0;
    if (input.addressedWakeId.length === 0) return 0;
    const store = getOperationalStore();
    const origin = await resolveUnifiedWakeTarget(store, input.org, input.addressedWakeId);
    if (origin === null) return 0;
    const addressedAuthority = await resolveUnifiedWakeAuthority(store, input.org, input.addressedWakeId);
    const frozenAddressedAuthority = addressedAuthority === undefined
      ? undefined
      : { binding: addressedAuthority.binding, requester: addressedAuthority.requester, nonMemberWake: addressedAuthority.nonMemberWake };
    const addressedBinding = addressedAuthority?.binding ?? await resolveUnifiedWakeBinding(store, input.org, input.addressedWakeId);
    const addressedSurfaceKey = addressedAuthority?.surfaceKey ?? await resolveUnifiedWakeSurfaceKey(store, input.org, input.addressedWakeId);
    let moved = 0;
    for (const task of input.tasks) {
      const current = await resolveUnifiedWakeTarget(store, input.org, task.wakeId);
      const currentBinding = await resolveUnifiedWakeBinding(store, input.org, task.wakeId);
      if (
        current !== null &&
        sameUnifiedConversation(current, origin) &&
        sameUnifiedPlacement(current, origin) &&
        JSON.stringify(currentBinding) === JSON.stringify(addressedBinding)
      )
        continue;
      const at = new Date().toISOString();
      const next = current !== null && sameUnifiedConversation(current, origin) ? withCarriedPlacement(origin, current) : origin;
      await registerUnifiedWakeTarget(
        store,
        input.org,
        task.wakeId,
        next,
        at,
        input.windowToken,
        undefined,
        undefined,
        addressedSurfaceKey,
        addressedBinding,
        frozenAddressedAuthority,
      );
      moved++;
      void appendAudit({
        org: input.org,
        platform: "unified",
        workspace: "delegation",
        action: TASK_WAKE_RETARGET_ACTION,
        detail: {
          task: task.taskId,
          wakeId: task.wakeId,
          addressedWakeId: input.addressedWakeId,
          originPlatform: origin.platform,
          ...(input.turnId !== undefined && input.turnId.length > 0 ? { turnId: input.turnId } : {}),
        },
      }).catch(() => undefined);
    }
    return moved;
  } catch (err) {
    console.error(`retargetTaskWakes failed (org=${input.org}, addressedWake=${input.addressedWakeId}): ${err instanceof Error ? err.message : String(err)}`);
    return 0;
  }
}

type TaskWakeRecord = {
  readonly wakeId: string;
  readonly parentSessionId?: string;
  readonly callId?: string;
  readonly authority?: SettlementDispatchAuthority;
};

async function taskWakeRecord(org: string, taskId: string): Promise<TaskWakeRecord | undefined> {
  try {
    if (taskId.length === 0) return undefined;
    const raw = await getOperationalStore().getTaskResult(org, taskWakeKey(taskId));
    if (raw === null) return undefined;
    const parsed = JSON.parse(raw) as { wakeId?: unknown; parentSessionId?: unknown; callId?: unknown; requester?: unknown; nonMemberWake?: unknown } | null;
    const wakeId = parsed?.wakeId;
    if (typeof wakeId !== "string" || wakeId.length === 0) return undefined;
    const parentSessionId = typeof parsed?.parentSessionId === "string" && parsed.parentSessionId.length > 0 ? parsed.parentSessionId : undefined;
    const callId = typeof parsed?.callId === "string" && parsed.callId.length > 0 ? parsed.callId : undefined;
    const pointerAuthority =
      parentSessionId !== undefined && callId !== undefined
        ? await delegatedTaskDispatchAuthority(org, parentSessionId, callId)
        : undefined;
    const authority =
      pointerAuthority !== undefined &&
      pointerAuthority.wakeId === wakeId &&
      isRequesterVerdict(parsed?.requester) &&
      typeof parsed?.nonMemberWake === "boolean" &&
      JSON.stringify(pointerAuthority.requester) === JSON.stringify(parsed.requester) &&
      pointerAuthority.nonMemberWake === parsed.nonMemberWake
        ? pointerAuthority
        : undefined;
    return {
      wakeId,
      ...(parentSessionId !== undefined ? { parentSessionId } : {}),
      ...(callId !== undefined ? { callId } : {}),
      ...(authority !== undefined && parentSessionId !== undefined && callId !== undefined ? { authority } : {}),
    };
  } catch {
    return undefined;
  }
}

export async function taskWakeId(org: string, taskId: string): Promise<string | undefined> {
  return (await taskWakeRecord(org, taskId))?.wakeId;
}

export type TaskWakeInstall = {
  readonly outcome: "installed" | "already" | "no-row" | "no-turn" | "ingressed" | "wrong-session";
  readonly wakeId: string | null;
  readonly sameSession?: boolean;
  readonly dispatchAuthority?: SettlementDispatchAuthority;
};

export async function installTaskWake(input: {
  readonly org: string;
  readonly taskId: string;
  readonly status: string;
  readonly sessionId: string;
  readonly turnId: string | undefined;
  readonly inheritedWakeId: string | undefined;
  readonly adopt?: (turnId: string | undefined, taskId: string, wakeId: string) => boolean;
  readonly uningressed?: (turnId: string | undefined) => boolean;
}): Promise<TaskWakeInstall> {
  let result: TaskWakeInstall = { outcome: "no-row", wakeId: null };
  try {
    const record = await taskWakeRecord(input.org, input.taskId);
    const wakeId = record?.wakeId;
    if (record === undefined || wakeId === undefined) {
      result = { outcome: "no-row", wakeId: null };
    } else if (input.turnId === undefined || input.turnId.length === 0) {
      result = { outcome: "no-turn", wakeId };
    } else if (!(input.uningressed ?? uningressedTurn)(input.turnId)) {
      result = { outcome: "ingressed", wakeId, sameSession: record.parentSessionId === undefined || record.parentSessionId === input.sessionId };
    } else if (record.parentSessionId !== undefined && record.parentSessionId !== input.sessionId) {
      result = { outcome: "wrong-session", wakeId };
    } else {
      const adopt = input.adopt ?? adoptTaskWakeThisTurn;
      result = {
        outcome: adopt(input.turnId, input.taskId, wakeId) ? "installed" : "already",
        wakeId,
        ...(record.authority !== undefined ? { dispatchAuthority: record.authority } : {}),
      };
    }
  } catch {
    result = { outcome: "no-row", wakeId: null };
  }
  void appendAudit({
    org: input.org,
    platform: "unified",
    workspace: "delegation",
    action: TASK_WAKE_ACTION,
    detail: {
      task: input.taskId,
      status: input.status,
      outcome: result.outcome,
      wakeId: result.wakeId,
      inheritedWakeId: input.inheritedWakeId ?? null,
      ...(input.sessionId.length > 0 ? { sessionId: input.sessionId } : {}),
      ...(input.turnId !== undefined && input.turnId.length > 0 ? { turnId: input.turnId } : {}),
    },
  }).catch(() => undefined);
  return result;
}
