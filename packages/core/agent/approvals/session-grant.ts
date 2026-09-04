import type { PendingActionRow } from "./types.js";

const PR_OPEN_KIND = "pr.open";

export const CONNECTOR_OP_KIND_PREFIX = "connector.op:";

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

export function declarationForPermissionKind(kind: string): string | undefined {
  if (kind === PR_OPEN_KIND) return PR_OPEN_KIND;
  if (!kind.startsWith(CONNECTOR_TOOL_KIND_PREFIX)) return undefined;
  const declaration = `${CONNECTOR_TOOL_DECLARATION_PREFIX}${kind.slice(CONNECTOR_TOOL_KIND_PREFIX.length)}`;
  return routinePermissionKind(declaration) === kind ? declaration : undefined;
}

export interface RoutinePermissionMemoParts {
  readonly marker: "asked" | "declined";
  readonly grantKind: string;
}

export function routinePermissionMemoParts(kind: string): RoutinePermissionMemoParts | undefined {
  for (const [prefix, marker] of [
    [ROUTINE_CARD_ASKED_PREFIX, "asked"],
    [ROUTINE_CARD_DECLINED_PREFIX, "declined"],
  ] as const) {
    if (!kind.startsWith(prefix)) continue;
    const grantKind = kind.slice(prefix.length);
    return grantKind.length > 0 ? { marker, grantKind } : undefined;
  }
  return undefined;
}

export function isRoutinePermissionMemoKind(kind: string): boolean {
  return kind.startsWith(ROUTINE_CARD_ASKED_PREFIX) || kind.startsWith(ROUTINE_CARD_DECLINED_PREFIX);
}

export function isLegacyConnectorOpKind(kind: string): boolean {
  return kind.startsWith(CONNECTOR_OP_KIND_PREFIX);
}

export function sessionGrantKind(row: Pick<PendingActionRow, "kind" | "argsJson">): string | null {
  if (row.kind === PR_OPEN_KIND) return PR_OPEN_KIND;
  return null;
}

export const ROUTINE_PERMISSION_PREFIX = "oe-routine:";

export function permissionLifetime(memoSessionId: string | undefined): "routine" | "session" {
  return memoSessionId !== undefined && memoSessionId.startsWith(ROUTINE_PERMISSION_PREFIX) ? "routine" : "session";
}

export function grantButtonLabel(row: Pick<PendingActionRow, "argsJson">): string {
  let sessionId: string | undefined;
  try {
    const parsed = JSON.parse(row.argsJson) as { sessionId?: unknown };
    if (typeof parsed.sessionId === "string") sessionId = parsed.sessionId;
  } catch {
  }
  return permissionLifetime(sessionId) === "routine" ? "Approve for this routine (standing)" : "Approve for session";
}

const CONNECTOR_TOOL_DECLARATION_PREFIX = "tool:";

const TOOL_NAME_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9_-]*$/u;

const RESERVED_TOOL_NAMESPACE = "grant";

function namesReservedNamespace(head: string): boolean {
  return head.toLowerCase() === RESERVED_TOOL_NAMESPACE;
}

export function routinePermissionKind(declared: string): string | null {
  if (declared === PR_OPEN_KIND) return PR_OPEN_KIND;
  if (!declared.startsWith(CONNECTOR_TOOL_DECLARATION_PREFIX)) return null;
  const tool = declared.slice(CONNECTOR_TOOL_DECLARATION_PREFIX.length);
  const segments = tool.split("__");
  if (segments.length < 2) return null;
  if (namesReservedNamespace(segments[0] ?? "")) return null;
  if (!segments.every((segment) => TOOL_NAME_SEGMENT.test(segment))) return null;
  return connectorToolPermissionKind(tool);
}

export function routinePermissionRefusal(declared: string): string | undefined {
  if (declared === PR_OPEN_KIND) return undefined;
  if (!declared.startsWith(CONNECTOR_TOOL_DECLARATION_PREFIX)) {
    return `it is neither "pr.open" nor a "tool:<qualified connector tool>" declaration`;
  }
  const tool = declared.slice(CONNECTOR_TOOL_DECLARATION_PREFIX.length);
  const segments = tool.split("__");
  if (segments.length < 2) {
    return `"${tool}" is a single segment, so it names a connection or a bare verb rather than a tool — a declaration must name the tool exactly as it is called, e.g. "tool:notion__share_page"`;
  }
  if (namesReservedNamespace(segments[0] ?? "")) {
    return `"${segments[0]}" is the credential-grant plane's reserved namespace, which a routine may never declare a standing permission on`;
  }
  const bad = segments.find((segment) => !TOOL_NAME_SEGMENT.test(segment));
  if (bad !== undefined) {
    return `the segment "${bad}" is not a legal tool-name segment — each "__"-delimited segment must start with a letter or a digit and then carry only letters, digits, "_" or "-"`;
  }
  return undefined;
}

export function describeLegacyConnectorOpKind(kind: string): string {
  return `nothing — "${kind.slice(CONNECTOR_OP_KIND_PREFIX.length)}" is a legacy per-connector row that lifts no tool`;
}

export function describeDeclaredPermissionKind(kind: string): string {
  if (kind === PR_OPEN_KIND) return "open pull requests";
  if (kind.startsWith(CONNECTOR_TOOL_KIND_PREFIX)) {
    return `use the "${kind.slice(CONNECTOR_TOOL_KIND_PREFIX.length)}" tool`;
  }
  if (kind.startsWith(CONNECTOR_OP_KIND_PREFIX)) return describeLegacyConnectorOpKind(kind);
  return kind;
}
