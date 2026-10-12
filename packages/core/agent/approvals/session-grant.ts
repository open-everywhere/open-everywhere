import { friendlyWhen } from "../channels/person-text.js";
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

const CONVERSATION_GRANT_PREFIX = "oe-grant:";

const ROOM_CALL_SUFFIX = ":call";

export interface GrantableBinding {
  readonly platform: string;
  readonly workspace: string;
  readonly surface: string;
  readonly domainSurface?: string;
  readonly mode: string;
  readonly threadTs?: string;
  readonly anchorChannelId?: string;
}

export type GrantReach = "routine" | "thread" | "dm" | "call";

function nonEmpty(v: string | undefined): v is string {
  return typeof v === "string" && v.length > 0;
}

function conversationGrantRoom(b: GrantableBinding): string {
  return `${b.platform}/${b.workspace}/${nonEmpty(b.domainSurface) ? b.domainSurface : b.surface}`;
}

function conversationThreadId(b: GrantableBinding): string | undefined {
  if (nonEmpty(b.threadTs)) return b.threadTs;
  if (b.mode !== "mpim" && nonEmpty(b.anchorChannelId)) return b.anchorChannelId;
  if (nonEmpty(b.domainSurface) && b.domainSurface !== b.surface) return b.surface;
  return undefined;
}

export function conversationGrantKey(b: GrantableBinding): string | undefined {
  const room = conversationGrantRoom(b);
  if (b.mode === "dm") return `${CONVERSATION_GRANT_PREFIX}${room}:dm`;
  const thread = conversationThreadId(b);
  return thread === undefined ? undefined : `${CONVERSATION_GRANT_PREFIX}${room}:thread:${thread}`;
}

export function roomCallGrantKey(b: GrantableBinding): string {
  return `${CONVERSATION_GRANT_PREFIX}${conversationGrantRoom(b)}${ROOM_CALL_SUFFIX}`;
}

export function conversationGrantRoomPrefix(surfaceKey: string): string {
  return `${CONVERSATION_GRANT_PREFIX}${surfaceKey}:`;
}

export function grantReach(key: string | undefined): GrantReach | undefined {
  if (!nonEmpty(key)) return undefined;
  if (key.startsWith(ROUTINE_PERMISSION_PREFIX)) return "routine";
  if (!key.startsWith(CONVERSATION_GRANT_PREFIX)) return undefined;
  const rest = key.slice(CONVERSATION_GRANT_PREFIX.length);
  const colon = rest.indexOf(":");
  if (colon <= 0) return undefined;
  const tail = rest.slice(colon);
  if (tail === ":dm") return "dm";
  if (tail === ROOM_CALL_SUFFIX) return "call";
  return tail.startsWith(":thread:") && tail.length > ":thread:".length ? "thread" : undefined;
}

function frozenGrantKey(row: Pick<PendingActionRow, "argsJson">): string | undefined {
  try {
    const parsed = JSON.parse(row.argsJson) as { sessionId?: unknown };
    return typeof parsed.sessionId === "string" ? parsed.sessionId : undefined;
  } catch {
    return undefined;
  }
}

export function grantableFrozenKey(row: Pick<PendingActionRow, "argsJson">): string | undefined {
  const key = frozenGrantKey(row);
  return grantReach(key) === "routine" ? key : undefined;
}

export function grantButtonLabel(row: Pick<PendingActionRow, "argsJson">, routineGrantTtlHours: number): string | undefined {
  return grantableFrozenKey(row) === undefined ? undefined : `Approve for this routine (up to ${routineGrantTtlHours} h)`;
}

export const ROUTINE_PERMISSION_NO_EXPIRY = "9999-12-31T23:59:59.999Z";

export function pendingCardExpiryClause(expiresAt: string): string {
  if (expiresAt === ROUTINE_PERMISSION_NO_EXPIRY) return "open until the routine changes";
  return `expires ${shortUtc(expiresAt)}`;
}

export function shortUtc(iso: string): string {
  return Number.isNaN(new Date(iso).getTime()) ? iso : friendlyWhen(iso);
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
