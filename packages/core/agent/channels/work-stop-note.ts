import { delegatingParentLink } from "./delegated-provenance.js";
import { WAKE_TARGET_TTL_MS } from "./unified-window.js";
import { isWorkWindowToken } from "./window-key.js";
import { resolveOwnWindowToken } from "../access/delegation-mount.js";
import { deploymentOrg, isSubagentChildContext, type BindableContext } from "../identity/binding.js";
import { getOperationalStore } from "../operational/provider.js";

const WORK_STOP_PREFIX = "oe-work-stop:";

export const WORK_STOP_REFUSAL_MAX_CHARS = 2_000;

export interface WorkStopStore {
  putTaskResult(org: string, key: string, json: string, at: string, ttlMs: number): Promise<void>;
  getTaskResult(org: string, key: string): Promise<string | null>;
  deleteTaskResult(org: string, key: string): Promise<boolean>;
}

export interface WorkStopNote {
  readonly connector: string;
  readonly refusal: string;
}

interface WorkStopRow extends WorkStopNote {
  readonly callId: string;
}

function workStopKey(childToken: string): string {
  return `${WORK_STOP_PREFIX}${childToken}`;
}

export function workChildToken(ctx: BindableContext): string | undefined {
  return workChildLink(ctx)?.childToken;
}

function workChildLink(ctx: BindableContext): { readonly childToken: string; readonly callId: string } | undefined {
  try {
    if (!isSubagentChildContext(ctx)) return undefined;
    if (!isWorkWindowToken(resolveOwnWindowToken(ctx))) return undefined;
    const link = delegatingParentLink(ctx);
    return link === null ? undefined : { childToken: `subagent:${link.sessionId}:${link.callId}`, callId: link.callId };
  } catch {
    return undefined;
  }
}

export async function rememberWorkStop(ctx: BindableContext, note: WorkStopNote, phase: "session.started" | "turn.started", store: WorkStopStore = getOperationalStore()): Promise<boolean> {
  if (phase !== "session.started") return false;
  const link = workChildLink(ctx);
  if (link === undefined || note.refusal.length === 0 || note.connector.length === 0) return false;
  const refusal = note.refusal.length > WORK_STOP_REFUSAL_MAX_CHARS ? note.refusal.slice(0, WORK_STOP_REFUSAL_MAX_CHARS) : note.refusal;
  const row: WorkStopRow = { connector: note.connector, refusal, callId: link.callId };
  await store.putTaskResult(deploymentOrg(), workStopKey(link.childToken), JSON.stringify(row), new Date().toISOString(), WAKE_TARGET_TTL_MS);
  return true;
}

export async function readWorkStop(org: string, childToken: string, settledCallId: string, store: WorkStopStore = getOperationalStore()): Promise<WorkStopNote | undefined> {
  try {
    if (!/^subagent:[^:]+:[^:]+$/.test(childToken) || settledCallId.length === 0) return undefined;
    const raw = await store.getTaskResult(org, workStopKey(childToken));
    if (raw === null) return undefined;
    const row = JSON.parse(raw) as { connector?: unknown; refusal?: unknown; callId?: unknown } | null;
    if (typeof row?.connector !== "string" || row.connector.length === 0) return undefined;
    if (typeof row.refusal !== "string" || row.refusal.length === 0) return undefined;
    if (row.callId !== settledCallId) return undefined;
    return { connector: row.connector, refusal: row.refusal.slice(0, WORK_STOP_REFUSAL_MAX_CHARS) };
  } catch {
    return undefined;
  }
}

export async function forgetWorkStop(org: string, childToken: string, store: WorkStopStore = getOperationalStore()): Promise<void> {
  try {
    await store.deleteTaskResult(org, workStopKey(childToken));
  } catch {
  }
}
