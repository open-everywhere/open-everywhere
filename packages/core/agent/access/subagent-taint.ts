import { getOperationalStore } from "../operational/provider.js";
import { INGESTION_KINDS, type IngestionKind } from "./taint-tiers.js";

const MARKER_PREFIX = "oe-subagent-taint:";

const SUBAGENT_TAINT_TTL_MS = 6 * 60 * 60 * 1000;

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
    );
  } catch {
  }
}

export async function markSubagentCallTainted(
  org: string,
  parentSessionId: string,
  callId: string,
  kinds: readonly string[] = [],
): Promise<void> {
  try {
    if (parentSessionId.length === 0 || callId.length === 0) return;
    await getOperationalStore().putTaskResult(
      org,
      subagentCallTaintKey(parentSessionId, callId),
      JSON.stringify(kinds.length === 0 ? { tainted: true } : { tainted: true, kinds: [...kinds] }),
      new Date().toISOString(),
      SUBAGENT_TAINT_TTL_MS,
    );
  } catch {
  }
}

export { rememberTaskCall, taskCallKey, taskCallLink, type TaskCallLink } from "./task-call-link.js";

export async function subagentCallTaintStatus(
  org: string,
  parentSessionId: string,
  callId: string,
): Promise<boolean | undefined> {
  return (await subagentCallTaintRecord(org, parentSessionId, callId))?.tainted;
}

export interface SubagentCallTaint {
  readonly tainted: boolean;
  readonly kinds: readonly IngestionKind[];
}

export async function subagentCallTaintRecord(
  org: string,
  parentSessionId: string,
  callId: string,
): Promise<SubagentCallTaint | undefined> {
  try {
    if (parentSessionId.length === 0 || callId.length === 0) return undefined;
    const raw = await getOperationalStore().getTaskResult(org, subagentCallTaintKey(parentSessionId, callId));
    if (raw === null) return undefined;
    const parsed: unknown = JSON.parse(raw);
    const tainted = (parsed as { tainted?: unknown } | null)?.tainted;
    if (typeof tainted !== "boolean") return undefined;
    const rawKinds = (parsed as { kinds?: unknown } | null)?.kinds;
    const kinds = Array.isArray(rawKinds)
      ? rawKinds.filter((k): k is IngestionKind => typeof k === "string" && (INGESTION_KINDS as readonly string[]).includes(k))
      : [];
    return { tainted, kinds };
  } catch {
    return undefined;
  }
}
