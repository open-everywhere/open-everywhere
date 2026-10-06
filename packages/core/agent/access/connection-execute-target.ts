export const CONNECTION_EXECUTE_TOOL_NAME = "connection_execute";

export const CONNECTION_SEARCH_TOOL_NAME = "connection_search";

export interface ConnectionExecuteTarget {
  readonly connection: string;
  readonly tool: string;
}

const SAFE_TARGET_SEGMENT = /^[A-Za-z0-9_.:-]{1,128}$/u;

export function readConnectionExecuteTarget(input: unknown): ConnectionExecuteTarget | undefined {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return undefined;
  const { connection, tool } = input as Record<string, unknown>;
  if (typeof connection !== "string" || typeof tool !== "string") return undefined;
  if (!SAFE_TARGET_SEGMENT.test(connection) || !SAFE_TARGET_SEGMENT.test(tool)) return undefined;
  return { connection, tool };
}

export function qualifiedConnectorToolName(target: ConnectionExecuteTarget): string {
  return `${target.connection}__${target.tool}`;
}

const MAX_REMEMBERED_CALLS = 64;

const targetsByCallId = new Map<string, ConnectionExecuteTarget>();

export function rememberConnectionExecuteTarget(callId: unknown, input: unknown): void {
  try {
    if (typeof callId !== "string" || callId === "") return;
    const target = readConnectionExecuteTarget(input);
    if (target === undefined) return;
    targetsByCallId.delete(callId);
    targetsByCallId.set(callId, target);
    while (targetsByCallId.size > MAX_REMEMBERED_CALLS) {
      const oldest = targetsByCallId.keys().next();
      if (oldest.done === true) break;
      targetsByCallId.delete(oldest.value);
    }
  } catch {
  }
}

export function connectionExecuteTargetForCall(callId: unknown): ConnectionExecuteTarget | undefined {
  if (typeof callId !== "string" || callId === "") return undefined;
  return targetsByCallId.get(callId);
}

export function clearConnectionExecuteTargets(): void {
  targetsByCallId.clear();
}
