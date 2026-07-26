import type { PendingActionRow } from "./types.js";

const PR_OPEN_KIND = "pr.open";
const EXECUTOR_OP_KIND = "executor.op";

export function connectorSessionKind(connector: string): string {
  return `connector.op:${connector}`;
}

export function sessionGrantKind(row: Pick<PendingActionRow, "kind" | "argsJson">): string | null {
  if (row.kind === PR_OPEN_KIND) return PR_OPEN_KIND;
  if (row.kind === EXECUTOR_OP_KIND) {
    let parsed: { tier?: unknown; tainted?: unknown; connector?: unknown };
    try {
      parsed = JSON.parse(row.argsJson) as typeof parsed;
    } catch {
      return null;
    }
    if (parsed.tier !== "write") return null;
    if (parsed.tainted === true) return null;
    if (typeof parsed.connector !== "string" || parsed.connector.length === 0) return null;
    return connectorSessionKind(parsed.connector);
  }
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

export function routinePermissionKind(declared: string): string | null {
  if (declared === PR_OPEN_KIND) return PR_OPEN_KIND;
  const connector = declared.startsWith("connector:") ? declared.slice("connector:".length) : null;
  if (connector !== null && /^[a-z0-9][a-z0-9_-]*$/u.test(connector)) return connectorSessionKind(connector);
  return null;
}

export function describeGrantKind(kind: string): string {
  if (kind === PR_OPEN_KIND) return "open pull requests";
  if (kind.startsWith("connector.op:")) return `write to ${kind.slice("connector.op:".length)}`;
  return kind;
}
