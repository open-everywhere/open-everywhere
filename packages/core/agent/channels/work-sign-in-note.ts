import { workChildLink } from "./work-stop-note.js";
import { WAKE_TARGET_TTL_MS } from "./unified-window.js";
import { deploymentOrg, type BindableContext } from "../identity/binding.js";
import { getOperationalStore } from "../operational/provider.js";

const WORK_SIGN_IN_PREFIX = "oe-work-sign-in:";
const SIGN_IN_RESUME_PREFIX = "oe-sign-in-resume:";
const SIGN_IN_PENDING_PREFIX = "oe-sign-in-pending:";
const SIGN_IN_DONE_PREFIX = "oe-sign-in-done:";

export interface WorkSignInStore {
  putTaskResult(org: string, key: string, json: string, at: string, ttlMs: number): Promise<void>;
  getTaskResult(org: string, key: string): Promise<string | null>;
  deleteTaskResult(org: string, key: string): Promise<boolean>;
}

export interface WorkSignInNote {
  readonly connector: string;
  readonly delivered: boolean;
  readonly sameConversation: boolean;
  readonly detourId?: string;
  readonly principalId?: string;
  readonly surfaceKey?: string;
}

interface WorkSignInRow extends WorkSignInNote {
  readonly callId: string;
}

export interface SignInPending {
  readonly connector: string;
  readonly principalId: string;
  readonly surfaceKey: string;
}

export interface SignInResume {
  readonly requestId: string;
  readonly taskId: string;
  readonly connector: string;
}

function workSignInKey(childToken: string): string {
  return `${WORK_SIGN_IN_PREFIX}${childToken}`;
}

function signInResumeKey(detourId: string): string {
  return `${SIGN_IN_RESUME_PREFIX}${detourId}`;
}

export async function rememberWorkSignIn(ctx: BindableContext, note: WorkSignInNote, store: WorkSignInStore = getOperationalStore()): Promise<boolean> {
  try {
    const link = workChildLink(ctx);
    if (link === undefined || note.connector.length === 0) return false;
    const row: WorkSignInRow = {
      connector: note.connector,
      delivered: note.delivered,
      sameConversation: note.sameConversation,
      ...(note.detourId !== undefined && note.detourId.length > 0 ? { detourId: note.detourId } : {}),
      callId: link.callId,
    };
    const atIso = new Date().toISOString();
    await store.putTaskResult(deploymentOrg(), workSignInKey(link.childToken), JSON.stringify(row), atIso, WAKE_TARGET_TTL_MS);
    if (note.delivered && row.detourId !== undefined && note.principalId !== undefined && note.principalId.length > 0 && note.surfaceKey !== undefined) {
      const pending: SignInPending = { connector: note.connector, principalId: note.principalId, surfaceKey: note.surfaceKey };
      await store.putTaskResult(deploymentOrg(), `${SIGN_IN_PENDING_PREFIX}${row.detourId}`, JSON.stringify(pending), atIso, WAKE_TARGET_TTL_MS);
    }
    return true;
  } catch {
    return false;
  }
}

export async function readWorkSignIn(org: string, childToken: string, settledCallId: string, store: WorkSignInStore = getOperationalStore()): Promise<WorkSignInNote | undefined> {
  try {
    if (!/^subagent:[^:]+:[^:]+$/.test(childToken) || settledCallId.length === 0) return undefined;
    const raw = await store.getTaskResult(org, workSignInKey(childToken));
    if (raw === null) return undefined;
    const row = JSON.parse(raw) as Partial<WorkSignInRow> | null;
    if (typeof row?.connector !== "string" || row.connector.length === 0) return undefined;
    if (typeof row.delivered !== "boolean" || typeof row.sameConversation !== "boolean") return undefined;
    return {
      connector: row.connector,
      delivered: row.delivered,
      sameConversation: row.sameConversation,
      ...(typeof row.detourId === "string" && row.detourId.length > 0 ? { detourId: row.detourId } : {}),
    };
  } catch {
    return undefined;
  }
}

export async function forgetWorkSignIn(org: string, childToken: string, store: WorkSignInStore = getOperationalStore()): Promise<void> {
  try {
    await store.deleteTaskResult(org, workSignInKey(childToken));
  } catch {
  }
}

export async function rememberSignInResume(org: string, detourId: string, resume: SignInResume, store: WorkSignInStore = getOperationalStore()): Promise<boolean> {
  try {
    if (detourId.length === 0) return false;
    await store.putTaskResult(org, signInResumeKey(detourId), JSON.stringify(resume), new Date().toISOString(), WAKE_TARGET_TTL_MS);
    return true;
  } catch {
    return false;
  }
}

export async function takeSignInResume(org: string, detourId: string, store: WorkSignInStore = getOperationalStore()): Promise<SignInResume | undefined> {
  try {
    if (detourId.length === 0) return undefined;
    const key = signInResumeKey(detourId);
    const raw = await store.getTaskResult(org, key);
    if (raw === null) return undefined;
    if (!(await store.deleteTaskResult(org, key))) return undefined;
    const row = JSON.parse(raw) as Partial<SignInResume> | null;
    if (typeof row?.requestId !== "string" || row.requestId.length === 0) return undefined;
    if (typeof row.taskId !== "string" || row.taskId.length === 0) return undefined;
    if (typeof row.connector !== "string" || row.connector.length === 0) return undefined;
    return { requestId: row.requestId, taskId: row.taskId, connector: row.connector };
  } catch {
    return undefined;
  }
}

export async function readSignInPending(org: string, detourId: string, store: WorkSignInStore = getOperationalStore()): Promise<SignInPending | undefined> {
  try {
    if (detourId.length === 0) return undefined;
    const raw = await store.getTaskResult(org, `${SIGN_IN_PENDING_PREFIX}${detourId}`);
    if (raw === null) return undefined;
    const row = JSON.parse(raw) as Partial<SignInPending> | null;
    if (typeof row?.connector !== "string" || typeof row.principalId !== "string" || typeof row.surfaceKey !== "string") return undefined;
    return { connector: row.connector, principalId: row.principalId, surfaceKey: row.surfaceKey };
  } catch {
    return undefined;
  }
}

export async function forgetSignInMarkers(org: string, detourId: string, store: WorkSignInStore = getOperationalStore()): Promise<void> {
  for (const key of [`${SIGN_IN_PENDING_PREFIX}${detourId}`, `${SIGN_IN_DONE_PREFIX}${detourId}`]) {
    await store.deleteTaskResult(org, key).catch(() => false);
  }
}

export async function rememberSignInDone(org: string, detourId: string, store: WorkSignInStore = getOperationalStore()): Promise<boolean> {
  try {
    if (detourId.length === 0) return false;
    await store.putTaskResult(org, `${SIGN_IN_DONE_PREFIX}${detourId}`, JSON.stringify({ done: true }), new Date().toISOString(), WAKE_TARGET_TTL_MS);
    return true;
  } catch {
    return false;
  }
}

export async function takeSignInDone(org: string, detourId: string, store: WorkSignInStore = getOperationalStore()): Promise<boolean> {
  try {
    if (detourId.length === 0) return false;
    return await store.deleteTaskResult(org, `${SIGN_IN_DONE_PREFIX}${detourId}`);
  } catch {
    return false;
  }
}
