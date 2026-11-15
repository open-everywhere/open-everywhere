import { getOperationalStore } from "../operational/provider.js";

const TASK_CALL_TTL_MS = 6 * 60 * 60 * 1000;

const TASK_CALL_PREFIX = "oe-task-call:";

export type TaskCallLink = {
  callId: string;
  childToken: string;
  agentId?: string;
  tool?: string;
  parentSessionId?: string;
  kind?: string;
  taintOff?: true;
};

export function taskCallKey(taskId: string): string {
  return `${TASK_CALL_PREFIX}${taskId}`;
}

function parseTaskCallLink(raw: string | null): TaskCallLink | undefined {
  if (raw === null) return undefined;
  const parsed = JSON.parse(raw) as { callId?: unknown; childToken?: unknown; agentId?: unknown; tool?: unknown; parentSessionId?: unknown; kind?: unknown; taintOff?: unknown } | null;
  const callId = parsed?.callId;
  const childToken = parsed?.childToken;
  const agentId = parsed?.agentId;
  const tool = parsed?.tool;
  const parentSessionId = parsed?.parentSessionId;
  if (typeof callId !== "string" || callId.length === 0) return undefined;
  if (typeof childToken !== "string" || childToken.length === 0) return undefined;
  return {
    callId,
    childToken,
    ...(typeof agentId === "string" && agentId.length > 0 ? { agentId } : {}),
    ...(typeof tool === "string" && tool.length > 0 ? { tool } : {}),
    ...(typeof parentSessionId === "string" && parentSessionId.length > 0 ? { parentSessionId } : {}),
    ...(typeof parsed?.kind === "string" && parsed.kind.length > 0 ? { kind: parsed.kind } : {}),
    ...(parsed?.taintOff === true ? { taintOff: true as const } : {}),
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
      TASK_CALL_TTL_MS,
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
