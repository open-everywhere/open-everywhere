import type { PendingActionRow } from "./types.js";

const PR_OPEN_KIND = "pr.open";

const CONNECTOR_OP_KIND_PREFIX = "connector.op:";

export function connectorSessionKind(connector: string): string {
  return `${CONNECTOR_OP_KIND_PREFIX}${connector}`;
}

const CONNECTOR_TOOL_KIND_PREFIX = "connector.tool:";

export function connectorToolPermissionKind(tool: string): string {
  return `${CONNECTOR_TOOL_KIND_PREFIX}${tool}`;
}

const ROUTINE_CARD_ASKED_PREFIX = "routine.permission.asked:";
const ROUTINE_CARD_DECLINED_PREFIX = "routine.permission.declined:";

export function routinePermissionAskedMemo(grantKind: string): string {
  return `${ROUTINE_CARD_ASKED_PREFIX}${grantKind}`;
}

export function routinePermissionDeclinedMemo(grantKind: string): string {
  return `${ROUTINE_CARD_DECLINED_PREFIX}${grantKind}`;
}

export function isRoutinePermissionMemoKind(kind: string): boolean {
  return kind.startsWith(ROUTINE_CARD_ASKED_PREFIX) || kind.startsWith(ROUTINE_CARD_DECLINED_PREFIX);
}

export function sessionGrantKind(row: Pick<PendingActionRow, "kind" | "argsJson">): string | null {
  if (row.kind === PR_OPEN_KIND) return PR_OPEN_KIND;
  return null;
}

const ROUTINE_GRANT_PREFIX = "oe-routine:";

export function grantLifetime(memoSessionId: string | undefined): "routine" | "session" {
  return memoSessionId !== undefined && memoSessionId.startsWith(ROUTINE_GRANT_PREFIX) ? "routine" : "session";
}

export function grantButtonLabel(row: Pick<PendingActionRow, "argsJson">): string {
  let sessionId: string | undefined;
  try {
    const parsed = JSON.parse(row.argsJson) as { sessionId?: unknown };
    if (typeof parsed.sessionId === "string") sessionId = parsed.sessionId;
  } catch {
  }
  return grantLifetime(sessionId) === "routine" ? "Approve for this routine (standing)" : "Approve for session";
}

const CONNECTOR_TOOL_DECLARATION_PREFIX = "tool:";

const TOOL_NAME_SEGMENT = /^[a-z0-9][a-z0-9_-]*$/u;

const RESERVED_TOOL_NAMESPACE = "grant";

export function routinePermissionKind(declared: string): string | null {
  if (declared === PR_OPEN_KIND) return PR_OPEN_KIND;
  if (!declared.startsWith(CONNECTOR_TOOL_DECLARATION_PREFIX)) return null;
  const tool = declared.slice(CONNECTOR_TOOL_DECLARATION_PREFIX.length);
  const segments = tool.split("__");
  if (segments.length < 2) return null;
  if (segments[0] === RESERVED_TOOL_NAMESPACE) return null;
  if (!segments.every((segment) => TOOL_NAME_SEGMENT.test(segment))) return null;
  return connectorToolPermissionKind(tool);
}

export function describeGrantKind(kind: string): string {
  if (kind === PR_OPEN_KIND) return "open pull requests";
  if (kind.startsWith(CONNECTOR_TOOL_KIND_PREFIX)) {
    return `use the "${kind.slice(CONNECTOR_TOOL_KIND_PREFIX.length)}" tool`;
  }
  if (kind.startsWith(CONNECTOR_OP_KIND_PREFIX)) {
    return `nothing — "${kind.slice(CONNECTOR_OP_KIND_PREFIX.length)}" is a legacy row that lifts no tool`;
  }
  return kind;
}
