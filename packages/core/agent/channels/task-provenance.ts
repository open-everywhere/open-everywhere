import { appendAudit } from "../audit/audit.js";
import { getOperationalStore } from "../operational/provider.js";
import { isUnifiedWakeOrigin, resolveUnifiedWakeTarget, sameUnifiedContainer, WAKE_TARGET_TTL_MS, type UnifiedWakeOrigin } from "./unified-window.js";
import { rememberDelegatedTaskWake } from "./task-wake.js";

const TASK_CONTINUATION_REFUSED_ACTION = "delegation.continuation_refused";

const TASK_CONTINUATION_ADMITTED_ACTION = "delegation.continuation_admitted";

export const TASK_CONTINUATION_REFUSAL_MESSAGE =
  "This task was opened in a different room, so it cannot be continued from this one. Start a new task by calling the tool again without `taskId`, and put everything it needs in the message.";

export const TASK_CONTINUATION_BUSY_MESSAGE =
  "This task is still working on an earlier message. Wait for its result, then call the tool again with the same `taskId`.";

export const TASK_CONTINUATION_UNAVAILABLE_MESSAGE =
  "This task cannot be continued here. Start a new task by calling the tool again without `taskId`, and put everything it needs in the message.";

export function taskContinuationRefusalMessage(reason: TaskContinuationRefusal): string {
  if (reason === "cross-room") return TASK_CONTINUATION_REFUSAL_MESSAGE;
  if (reason === "task-working") return TASK_CONTINUATION_BUSY_MESSAGE;
  return TASK_CONTINUATION_UNAVAILABLE_MESSAGE;
}

export type TaskContinuationRefusal =
  | "not-unified"
  | "no-turn"
  | "no-continuing-wake"
  | "continuing-origin-unresolvable"
  | "no-provenance"
  | "cross-room"
  | "task-working"
  | "tool-mismatch"
  | "authority-not-durable";

export type TaskContinuationVerdict =
  | { readonly admit: true; readonly openingCallId: string }
  | { readonly admit: false; readonly reason: TaskContinuationRefusal };

interface TaskOpening {
  readonly openingCallId: string;
  readonly origin: UnifiedWakeOrigin;
  readonly tool: string;
  readonly generation: number;
}

const TASK_CLAIM_PREFIX = "oe-task-claim:";

function taskClaimKey(parentSessionId: string, taskId: string, generation: number): string {
  return `${TASK_CLAIM_PREFIX}${parentSessionId}:${taskId}:${generation}`;
}

const TASK_PROVENANCE_PREFIX = "oe-task-provenance:";

const TASK_PROVENANCE_TTL_MS = WAKE_TARGET_TTL_MS;

export function taskProvenanceKey(parentSessionId: string, taskId: string): string {
  return `${TASK_PROVENANCE_PREFIX}${parentSessionId}:${taskId}`;
}

function parseOpening(raw: string | null): TaskOpening | undefined {
  if (raw === null) return undefined;
  try {
    const parsed = JSON.parse(raw) as { openingCallId?: unknown; origin?: unknown } | null;
    if (typeof parsed?.openingCallId !== "string" || parsed.openingCallId.length === 0) return undefined;
    if (!isUnifiedWakeOrigin(parsed.origin)) return undefined;
    const generation = (parsed as { generation?: unknown }).generation;
    const tool = (parsed as { tool?: unknown }).tool;
    if (typeof tool !== "string" || tool.length === 0) return undefined;
    return { openingCallId: parsed.openingCallId, origin: parsed.origin, tool, generation: typeof generation === "number" && Number.isInteger(generation) && generation >= 0 ? generation : 0 };
  } catch {
    return undefined;
  }
}

export async function recordTaskOpening(input: {
  readonly org: string;
  readonly parentSessionId: string;
  readonly taskId: string;
  readonly callId: string;
  readonly tool: string;
  readonly wakeId: string | undefined;
}): Promise<boolean> {
  try {
    if (input.parentSessionId.length === 0 || input.taskId.length === 0 || input.callId.length === 0) return false;
    if (input.wakeId === undefined || input.wakeId.length === 0) return false;
    const store = getOperationalStore();
    const origin = await resolveUnifiedWakeTarget(store, input.org, input.wakeId);
    if (origin === null) return false;
    if (input.tool.length === 0) return false;
    const opening: TaskOpening = { openingCallId: input.callId, origin, tool: input.tool, generation: 0 };
    const fresh = await store.putTaskResultIfAbsent(
      input.org,
      taskProvenanceKey(input.parentSessionId, input.taskId),
      JSON.stringify(opening),
      new Date().toISOString(),
      TASK_PROVENANCE_TTL_MS,
    );
    if (fresh) await store.putTaskResultIfAbsent(input.org, taskClaimKey(input.parentSessionId, input.taskId, 0), JSON.stringify({ turn: "opening", call: input.callId }), new Date().toISOString(), TASK_PROVENANCE_TTL_MS);
    return true;
  } catch {
    return false;
  }
}

const TASK_CONTINUATION_WAKE_PREFIX = "oe-task-continuation-wake:";

function continuationWakeKey(parentSessionId: string, openingCallId: string): string {
  return `${TASK_CONTINUATION_WAKE_PREFIX}${parentSessionId}:${openingCallId}`;
}

export interface ContinuationWake {
  readonly wakeId: string;
  readonly generation: number;
}

export async function readContinuationWake(org: string, parentSessionId: string, openingCallId: string): Promise<ContinuationWake | undefined> {
  try {
    const raw = await getOperationalStore().getTaskResult(org, continuationWakeKey(parentSessionId, openingCallId));
    if (raw === null) return undefined;
    const parsed = JSON.parse(raw) as { wakeId?: unknown; generation?: unknown } | null;
    const wakeId = parsed?.wakeId;
    const generation = parsed?.generation;
    if (typeof wakeId !== "string" || wakeId.length === 0) return undefined;
    if (typeof generation !== "number" || !Number.isInteger(generation) || generation < 0) return undefined;
    return { wakeId, generation };
  } catch {
    return undefined;
  }
}

export async function readTaskOpening(org: string, parentSessionId: string, taskId: string): Promise<{ readonly openingCallId: string } | undefined> {
  try {
    const opening = parseOpening(await getOperationalStore().getTaskResult(org, taskProvenanceKey(parentSessionId, taskId)));
    return opening === undefined ? undefined : { openingCallId: opening.openingCallId };
  } catch {
    return undefined;
  }
}

export async function noteTaskProvenanceSettled(org: string, parentSessionId: string, taskId: string): Promise<void> {
  try {
    const store = getOperationalStore();
    const key = taskProvenanceKey(parentSessionId, taskId);
    const opening = parseOpening(await store.getTaskResult(org, key));
    if (opening === undefined) return;
    await store.putTaskResult(org, key, JSON.stringify({ ...opening, generation: opening.generation + 1 }), new Date().toISOString(), TASK_PROVENANCE_TTL_MS);
  } catch {
  }
}

export function continuationAdmitted(opening: UnifiedWakeOrigin, continuing: UnifiedWakeOrigin): boolean {
  try {
    return sameUnifiedContainer(opening, continuing);
  } catch {
    return false;
  }
}

interface TaskClaim {
  readonly turn: string;
  readonly call?: string;
}

function parseClaim(raw: string | null): TaskClaim | undefined {
  if (raw === null) return undefined;
  try {
    const parsed = JSON.parse(raw) as { turn?: unknown; call?: unknown } | null;
    if (typeof parsed?.turn !== "string") return undefined;
    return { turn: parsed.turn, ...(typeof parsed.call === "string" && parsed.call.length > 0 ? { call: parsed.call } : {}) };
  } catch {
    return undefined;
  }
}

function claimState(claim: TaskClaim | undefined, turnId: string): "free" | "ours" | "stale" | "busy" {
  if (claim === undefined) return "free";
  if (claim.turn === turnId) return "ours";
  return claim.call === undefined ? "stale" : "busy";
}

export interface TaskContinuationCheck {
  readonly openingCallId: string;
  readonly generation: number;
  readonly continuingWakeId: string;
}

export async function checkTaskContinuation(input: {
  readonly org: string;
  readonly parentSessionId: string;
  readonly taskId: string;
  readonly toolName: string;
  readonly continuingWakeId: string | undefined;
  readonly continuingTurnId: string;
}): Promise<{ readonly admit: true; readonly check: TaskContinuationCheck } | { readonly admit: false; readonly reason: TaskContinuationRefusal }> {
  try {
    const continuingWakeId = input.continuingWakeId;
    if (continuingWakeId === undefined || continuingWakeId.length === 0) return { admit: false, reason: "no-continuing-wake" };
    const store = getOperationalStore();
    const opening = parseOpening(await store.getTaskResult(input.org, taskProvenanceKey(input.parentSessionId, input.taskId)));
    if (opening === undefined) return { admit: false, reason: "no-provenance" };
    if (opening.tool !== input.toolName) return { admit: false, reason: "tool-mismatch" };
    const continuing = await resolveUnifiedWakeTarget(store, input.org, continuingWakeId);
    if (continuing === null) return { admit: false, reason: "continuing-origin-unresolvable" };
    if (!continuationAdmitted(opening.origin, continuing)) return { admit: false, reason: "cross-room" };
    const claim = parseClaim(await store.getTaskResult(input.org, taskClaimKey(input.parentSessionId, input.taskId, opening.generation)));
    if (claimState(claim, input.continuingTurnId) === "busy") return { admit: false, reason: "task-working" };
    return { admit: true, check: { openingCallId: opening.openingCallId, generation: opening.generation, continuingWakeId } };
  } catch {
    return { admit: false, reason: "no-provenance" };
  }
}

export async function commitTaskContinuation(input: {
  readonly org: string;
  readonly parentSessionId: string;
  readonly taskId: string;
  readonly continuingTurnId: string;
  readonly check: TaskContinuationCheck;
}): Promise<TaskContinuationVerdict> {
  try {
    const store = getOperationalStore();
    const key = taskClaimKey(input.parentSessionId, input.taskId, input.check.generation);
    const mine = JSON.stringify({ turn: input.continuingTurnId });
    const at = new Date().toISOString();
    if (!(await store.putTaskResultIfAbsent(input.org, key, mine, at, TASK_PROVENANCE_TTL_MS))) {
      const state = claimState(parseClaim(await store.getTaskResult(input.org, key)), input.continuingTurnId);
      if (state === "busy") return { admit: false, reason: "task-working" };
      if (state === "stale") await store.putTaskResult(input.org, key, mine, at, TASK_PROVENANCE_TTL_MS);
    }
    try {
      await rememberDelegatedTaskWake(input.org, input.parentSessionId, input.check.openingCallId, input.check.continuingWakeId);
    } catch {
      return { admit: false, reason: "authority-not-durable" };
    }
    await store
      .putTaskResult(
        input.org,
        continuationWakeKey(input.parentSessionId, input.check.openingCallId),
        JSON.stringify({ wakeId: input.check.continuingWakeId, generation: input.check.generation }),
        at,
        TASK_PROVENANCE_TTL_MS,
      )
      .catch(() => undefined);
    return { admit: true, openingCallId: input.check.openingCallId };
  } catch {
    return { admit: false, reason: "authority-not-durable" };
  }
}

export async function noteTaskClaimDispatched(org: string, parentSessionId: string, taskId: string, callId: string, turnId: string | undefined): Promise<void> {
  try {
    if (turnId === undefined || turnId.length === 0) return;
    const store = getOperationalStore();
    const opening = parseOpening(await store.getTaskResult(org, taskProvenanceKey(parentSessionId, taskId)));
    if (opening === undefined) return;
    await store.putTaskResult(org, taskClaimKey(parentSessionId, taskId, opening.generation), JSON.stringify({ turn: turnId, call: callId }), new Date().toISOString(), TASK_PROVENANCE_TTL_MS);
  } catch {
  }
}

export function auditTaskContinuation(input: {
  readonly org: string;
  readonly parentSessionId: string;
  readonly turnId: string | undefined;
  readonly taskId: string;
  readonly verdict: TaskContinuationVerdict;
}): void {
  try {
    const ids = {
      task: input.taskId,
      session: input.parentSessionId,
      ...(input.turnId !== undefined && input.turnId.length > 0 ? { turn: input.turnId } : {}),
    };
    const row = input.verdict.admit
      ? appendAudit({ org: input.org, platform: "ingest", workspace: "delegation", action: TASK_CONTINUATION_ADMITTED_ACTION, detail: { ...ids, openingCall: input.verdict.openingCallId } })
      : appendAudit({ org: input.org, platform: "ingest", workspace: "delegation", action: TASK_CONTINUATION_REFUSED_ACTION, detail: { ...ids, reason: input.verdict.reason } });
    void row.catch(() => undefined);
  } catch {
  }
}
