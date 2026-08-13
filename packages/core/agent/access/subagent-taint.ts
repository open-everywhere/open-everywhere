import { getOperationalStore } from "../operational/provider.js";

const MARKER_PREFIX = "oe-subagent-taint:";

export const SUBAGENT_TAINT_TTL_MS = 6 * 60 * 60 * 1000;

export function subagentTaintKey(childSessionId: string): string {
  return `${MARKER_PREFIX}${childSessionId}`;
}

export async function markSubagentTainted(org: string, childSessionId: string): Promise<void> {
  try {
    if (childSessionId.length === 0) return;
    await getOperationalStore().putTaskResult(
      org,
      subagentTaintKey(childSessionId),
      JSON.stringify({ tainted: true }),
      new Date().toISOString(),
      SUBAGENT_TAINT_TTL_MS,
      undefined,
    );
  } catch {
  }
}

export async function subagentWasTainted(org: string, childSessionId: string): Promise<boolean> {
  try {
    if (childSessionId.length === 0) return false;
    const raw = await getOperationalStore().getTaskResult(org, subagentTaintKey(childSessionId));
    if (raw === null) return false;
    const parsed: unknown = JSON.parse(raw);
    return (parsed as { tainted?: unknown } | null)?.tainted === true;
  } catch {
    return false;
  }
}

const CALL_MARKER_PREFIX = "oe-subagent-taint-by-call:";

export function subagentCallTaintKey(parentSessionId: string, callId: string): string {
  return `${CALL_MARKER_PREFIX}${parentSessionId}:${callId}`;
}

export async function claimSubagentCallClean(org: string, parentSessionId: string, callId: string): Promise<void> {
  try {
    if (parentSessionId.length === 0 || callId.length === 0) return;
    await getOperationalStore().putTaskResultIfAbsent(
      org,
      subagentCallTaintKey(parentSessionId, callId),
      JSON.stringify({ tainted: false }),
      new Date().toISOString(),
      SUBAGENT_TAINT_TTL_MS,
      undefined,
    );
  } catch {
  }
}

export async function markSubagentCallTainted(org: string, parentSessionId: string, callId: string): Promise<void> {
  try {
    if (parentSessionId.length === 0 || callId.length === 0) return;
    await getOperationalStore().putTaskResult(
      org,
      subagentCallTaintKey(parentSessionId, callId),
      JSON.stringify({ tainted: true }),
      new Date().toISOString(),
      SUBAGENT_TAINT_TTL_MS,
      undefined,
    );
  } catch {
  }
}

export async function subagentCallTaintStatus(
  org: string,
  parentSessionId: string,
  callId: string,
): Promise<boolean | undefined> {
  try {
    if (parentSessionId.length === 0 || callId.length === 0) return undefined;
    const raw = await getOperationalStore().getTaskResult(org, subagentCallTaintKey(parentSessionId, callId));
    if (raw === null) return undefined;
    const parsed: unknown = JSON.parse(raw);
    const tainted = (parsed as { tainted?: unknown } | null)?.tainted;
    return typeof tainted === "boolean" ? tainted : undefined;
  } catch {
    return undefined;
  }
}
