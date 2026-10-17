import { appendAudit } from "../audit/audit.js";
import { deploymentOrg, type BindableContext } from "../identity/binding.js";
import { getOperationalStore } from "../operational/provider.js";
import { markSurfaceSession, pinSurfaceSession, surfaceTurnOf, type SurfaceSessionPin, type SurfaceSessionStatus } from "./surface-session-state.js";
import { WAKE_TARGET_TTL_MS } from "./unified-window.js";
import { workChildLink } from "./work-stop-note.js";
import type { AuditDetail } from "../audit/scrubbed-text.js";

export const WORK_SURFACE_WAIT_ACTION = "work.surface_wait";

export type WorkWaitReason = "asked" | "sign-in";

export function settledJobWaitReason(input: { readonly signInResumable: boolean; readonly asked: boolean; readonly status: string; readonly stopped: boolean; readonly cancelRedeemed: boolean }): WorkWaitReason | undefined {
  if (input.signInResumable) return "sign-in";
  if (input.asked && input.status === "completed" && !input.stopped && !input.cancelRedeemed) return "asked";
  return undefined;
}

export interface WorkWaitStore {
  putTaskResult(org: string, key: string, json: string, at: string, ttlMs: number): Promise<void>;
  getTaskResult(org: string, key: string): Promise<string | null>;
  deleteTaskResult(org: string, key: string): Promise<boolean>;
}

export interface WaitingJob {
  readonly requestId: string;
  readonly taskId: string;
  readonly atIso: string;
}

const CONVERSATION_PREFIX = "oe-work-conversation:";
const ASKED_PREFIX = "oe-work-asked:";
const WAIT_PREFIX = "oe-surface-wait:";
const TTL_MS = WAKE_TARGET_TTL_MS;

function waitKey(pin: Pick<SurfaceSessionPin, "platform" | "id">): string {
  return `${WAIT_PREFIX}${pin.platform}:${pin.id}`;
}

export interface WorkWaitDeps {
  readonly org: () => string;
  readonly store: () => WorkWaitStore;
  readonly mark: (pin: SurfaceSessionPin, status: SurfaceSessionStatus) => Promise<unknown>;
  readonly audit: (row: Parameters<typeof appendAudit>[0]) => Promise<unknown>;
  readonly now: () => Date;
}

const LIVE_DEPS: WorkWaitDeps = {
  org: deploymentOrg,
  store: getOperationalStore,
  mark: (pin, status) => markSurfaceSession(pin.platform, pin.attributes, status),
  audit: appendAudit,
  now: () => new Date(),
};

function parsePin(raw: string | null): SurfaceSessionPin | undefined {
  if (raw === null) return undefined;
  try {
    const row = JSON.parse(raw) as Partial<SurfaceSessionPin> | null;
    if (row === null || typeof row.platform !== "string" || row.platform.length === 0 || typeof row.id !== "string" || row.id.length === 0) return undefined;
    const attrs = row.attributes;
    if (attrs === null || typeof attrs !== "object" || Object.values(attrs).some((v) => typeof v !== "string")) return undefined;
    return { platform: row.platform, id: row.id, attributes: { ...attrs } };
  } catch {
    return undefined;
  }
}

export async function readJobConversation(store: WorkWaitStore, org: string, requestId: string): Promise<SurfaceSessionPin | undefined> {
  try {
    return parsePin(await store.getTaskResult(org, `${CONVERSATION_PREFIX}${requestId}`));
  } catch {
    return undefined;
  }
}

export async function noteJobForwarded(
  input: { readonly requestId: string; readonly openingRequestId?: string; readonly taskId?: string; readonly ctx: unknown },
  deps: WorkWaitDeps = LIVE_DEPS,
): Promise<SurfaceSessionPin | undefined> {
  try {
    const own = pinSurfaceSession(surfaceTurnOf(input.ctx));
    if (own === undefined && input.openingRequestId === undefined) return undefined;
    const org = deps.org();
    const store = deps.store();
    const opening = input.openingRequestId !== undefined ? await readJobConversation(store, org, input.openingRequestId) : undefined;
    const pin = own ?? opening;
    if (pin !== undefined) await store.putTaskResult(org, `${CONVERSATION_PREFIX}${input.requestId}`, JSON.stringify(pin), deps.now().toISOString(), TTL_MS);
    if (input.taskId !== undefined && opening !== undefined) {
      await noteJobMovedOn({ pin: opening, taskId: input.taskId, requestId: input.requestId, shownByTurn: own !== undefined && own.platform === opening.platform && own.id === opening.id }, deps);
    }
    return pin;
  } catch (err) {
    console.warn(`[open-everywhere:work] job conversation not recorded for request ${input.requestId}: ${String(err)}`);
    return undefined;
  }
}

export async function readWaitingJobs(store: WorkWaitStore, org: string, pin: Pick<SurfaceSessionPin, "platform" | "id">, now: Date = new Date()): Promise<readonly WaitingJob[]> {
  try {
    const raw = await store.getTaskResult(org, waitKey(pin));
    if (raw === null) return [];
    const list = JSON.parse(raw) as unknown;
    if (!Array.isArray(list)) return [];
    const floor = now.getTime() - TTL_MS;
    return list.filter(
      (j): j is WaitingJob =>
        j !== null &&
        typeof j === "object" &&
        typeof (j as WaitingJob).requestId === "string" &&
        typeof (j as WaitingJob).taskId === "string" &&
        typeof (j as WaitingJob).atIso === "string" &&
        Date.parse((j as WaitingJob).atIso) > floor,
    );
  } catch {
    return [];
  }
}

const waitLocks = new Map<string, Promise<unknown>>();

async function withWaitLock<T>(key: string, run: () => Promise<T>): Promise<T> {
  const prev = waitLocks.get(key) ?? Promise.resolve();
  const next = prev.then(run, run);
  const settled = next.catch(() => undefined);
  waitLocks.set(key, settled);
  try {
    return await next;
  } finally {
    if (waitLocks.get(key) === settled) waitLocks.delete(key);
  }
}

async function writeWaitingJobs(store: WorkWaitStore, org: string, pin: SurfaceSessionPin, jobs: readonly WaitingJob[], atIso: string): Promise<void> {
  if (jobs.length === 0) await store.deleteTaskResult(org, waitKey(pin));
  else await store.putTaskResult(org, waitKey(pin), JSON.stringify(jobs), atIso, TTL_MS);
}

function auditWait(deps: WorkWaitDeps, org: string, pin: SurfaceSessionPin, detail: AuditDetail): Promise<unknown> {
  return deps.audit({ org, platform: pin.platform, workspace: "delegation", action: WORK_SURFACE_WAIT_ACTION, detail }).catch(() => undefined);
}

export async function noteJobMovedOn(
  input: { readonly pin: SurfaceSessionPin; readonly taskId: string; readonly requestId: string; readonly shownByTurn: boolean },
  deps: WorkWaitDeps = LIVE_DEPS,
): Promise<void> {
  try {
    const org = deps.org();
    const store = deps.store();
    const atIso = deps.now().toISOString();
    const cleared = await withWaitLock(waitKey(input.pin), async () => {
      const jobs = await readWaitingJobs(store, org, input.pin, deps.now());
      const rest = jobs.filter((j) => j.taskId !== input.taskId);
      if (rest.length === jobs.length) return undefined;
      await writeWaitingJobs(store, org, input.pin, rest, atIso);
      return rest.length === 0;
    });
    if (cleared === undefined) return;
    const set = cleared && !input.shownByTurn;
    if (set) await deps.mark(input.pin, "active");
    await auditWait(deps, org, input.pin, { requestId: input.requestId, taskId: input.taskId, state: "moved-on", left: cleared ? "none" : "some", set: set ? "active" : "none" });
  } catch (err) {
    console.warn(`[open-everywhere:work] job wait not cleared for task ${input.taskId}: ${String(err)}`);
  }
}

export async function noteJobSettledWait(
  input: { readonly requestId: string; readonly taskId: string; readonly waits: WorkWaitReason | undefined },
  deps: WorkWaitDeps = LIVE_DEPS,
): Promise<void> {
  try {
    const org = deps.org();
    const store = deps.store();
    const pin = await readJobConversation(store, org, input.requestId);
    if (pin === undefined) return;
    if (input.waits === undefined) {
      await noteJobMovedOn({ pin, taskId: input.taskId, requestId: input.requestId, shownByTurn: false }, deps);
      return;
    }
    const atIso = deps.now().toISOString();
    await withWaitLock(waitKey(pin), async () => {
      const jobs = await readWaitingJobs(store, org, pin, deps.now());
      const next = [...jobs.filter((j) => j.taskId !== input.taskId), { requestId: input.requestId, taskId: input.taskId, atIso }];
      await writeWaitingJobs(store, org, pin, next, atIso);
    });
    await deps.mark(pin, "suspended");
    await auditWait(deps, org, pin, { requestId: input.requestId, taskId: input.taskId, state: "suspended", reason: input.waits });
  } catch (err) {
    console.warn(`[open-everywhere:work] job wait not recorded for request ${input.requestId}: ${String(err)}`);
  }
}

export async function conversationHasWaitingJob(pin: SurfaceSessionPin | undefined, deps: Pick<WorkWaitDeps, "org" | "store" | "now"> = LIVE_DEPS): Promise<boolean> {
  if (pin === undefined) return false;
  try {
    return (await readWaitingJobs(deps.store(), deps.org(), pin, deps.now())).length > 0;
  } catch {
    return false;
  }
}

export async function rememberWorkAsked(ctx: BindableContext, store: WorkWaitStore = getOperationalStore()): Promise<boolean> {
  try {
    const link = workChildLink(ctx);
    if (link === undefined) return false;
    await store.putTaskResult(deploymentOrg(), `${ASKED_PREFIX}${link.childToken}`, JSON.stringify({ asked: true }), new Date().toISOString(), TTL_MS);
    return true;
  } catch {
    return false;
  }
}

export async function readWorkAsked(org: string, childToken: string, store: WorkWaitStore = getOperationalStore()): Promise<boolean> {
  try {
    if (!/^subagent:[^:]+:[^:]+$/.test(childToken)) return false;
    return (await store.getTaskResult(org, `${ASKED_PREFIX}${childToken}`)) !== null;
  } catch {
    return false;
  }
}

export async function forgetWorkAsked(org: string, childToken: string, store: WorkWaitStore = getOperationalStore()): Promise<void> {
  try {
    await store.deleteTaskResult(org, `${ASKED_PREFIX}${childToken}`);
  } catch {
  }
}
