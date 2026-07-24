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
