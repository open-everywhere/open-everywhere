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
