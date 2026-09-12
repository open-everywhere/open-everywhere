import { getOperationalStore } from "../operational/provider.js";
import { INGESTION_KINDS, type IngestionKind } from "./taint-tiers.js";

const MARKER_PREFIX = "oe-subagent-taint:";

const SUBAGENT_TAINT_TTL_MS = 6 * 60 * 60 * 1000;

export function subagentTaintKey(childToken: string): string {
  return `${MARKER_PREFIX}${childToken}`;
}

export async function markSubagentTainted(org: string, childToken: string): Promise<void> {
  try {
    if (childToken.length === 0) return;
    await getOperationalStore().putTaskResult(
      org,
      subagentTaintKey(childToken),
      JSON.stringify({ tainted: true }),
      new Date().toISOString(),
      SUBAGENT_TAINT_TTL_MS,
    );
  } catch {
  }
}

export async function subagentWasTainted(org: string, childToken: string): Promise<boolean> {
  try {
    if (childToken.length === 0) return false;
    const raw = await getOperationalStore().getTaskResult(org, subagentTaintKey(childToken));
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

const TASK_CALL_PREFIX = "oe-task-call:";

const TASK_AGENT_PREFIX = "oe-task-agent:";

export type TaskCallLink = { callId: string; childToken: string; agentId?: string; tool?: string };

export function taskCallKey(taskId: string): string {
  return `${TASK_CALL_PREFIX}${taskId}`;
}

export function taskAgentKey(parentSessionId: string, agentId: string): string {
  return `${TASK_AGENT_PREFIX}${parentSessionId}:${agentId}`;
}

function parseTaskCallLink(raw: string | null): TaskCallLink | undefined {
  if (raw === null) return undefined;
  const parsed = JSON.parse(raw) as { callId?: unknown; childToken?: unknown; agentId?: unknown; tool?: unknown } | null;
  const callId = parsed?.callId;
  const childToken = parsed?.childToken;
  const agentId = parsed?.agentId;
  const tool = parsed?.tool;
  if (typeof callId !== "string" || callId.length === 0) return undefined;
  if (typeof childToken !== "string" || childToken.length === 0) return undefined;
  return {
    callId,
    childToken,
    ...(typeof agentId === "string" && agentId.length > 0 ? { agentId } : {}),
    ...(typeof tool === "string" && tool.length > 0 ? { tool } : {}),
  };
}

export async function rememberTaskCall(org: string, taskId: string, link: TaskCallLink): Promise<void> {
  try {
    if (taskId.length === 0 || link.callId.length === 0 || link.childToken.length === 0) return;
    await getOperationalStore().putTaskResult(
      org,
      taskCallKey(taskId),
      JSON.stringify(link),
      new Date().toISOString(),
      SUBAGENT_TAINT_TTL_MS,
    );
  } catch {
  }
}

export async function taskCallLink(org: string, taskId: string): Promise<TaskCallLink | undefined> {
  try {
    if (taskId.length === 0) return undefined;
    return parseTaskCallLink(await getOperationalStore().getTaskResult(org, taskCallKey(taskId)));
  } catch {
    return undefined;
  }
}

export async function rememberTaskAgent(org: string, parentSessionId: string, agentId: string, link: TaskCallLink): Promise<void> {
  try {
    if (parentSessionId.length === 0 || agentId.length === 0 || link.childToken.length === 0) return;
    await getOperationalStore().putTaskResultIfAbsent(
      org,
      taskAgentKey(parentSessionId, agentId),
      JSON.stringify(link),
      new Date().toISOString(),
      SUBAGENT_TAINT_TTL_MS,
    );
  } catch {
  }
}

export async function taskAgentLink(org: string, parentSessionId: string, agentId: string): Promise<TaskCallLink | undefined> {
  try {
    if (parentSessionId.length === 0 || agentId.length === 0) return undefined;
    return parseTaskCallLink(await getOperationalStore().getTaskResult(org, taskAgentKey(parentSessionId, agentId)));
  } catch {
    return undefined;
  }
}

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
