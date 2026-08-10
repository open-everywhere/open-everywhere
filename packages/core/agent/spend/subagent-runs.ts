import { usageForSession } from "./usage-events.js";
import { MAX_OBSERVABLE_DELEGATION_DEPTH, type UsageEventEntry } from "../operational/store.js";

export { MAX_OBSERVABLE_DELEGATION_DEPTH };

export const SUBAGENT_RUN_DETAIL_KEY = "subagentRun";

export interface SubagentRunStamp {
  readonly callId: string;
  readonly sessionId: string;
  readonly rootSessionId?: string;
  readonly depth?: number;
}

export function stampSubagentRun(run: SubagentRunStamp): Readonly<Record<string, unknown>> {
  return {
    [SUBAGENT_RUN_DETAIL_KEY]: {
      callId: run.callId,
      sessionId: run.sessionId,
      ...(run.rootSessionId !== undefined ? { rootSessionId: run.rootSessionId } : {}),
      ...(run.depth !== undefined ? { depth: run.depth } : {}),
    },
  };
}

export function subagentRunOf(row: { readonly detail?: Readonly<Record<string, unknown>> }): SubagentRunStamp | undefined {
  const raw = row.detail?.[SUBAGENT_RUN_DETAIL_KEY];
  if (typeof raw !== "object" || raw === null) return undefined;
  const { callId, sessionId, rootSessionId, depth } = raw as { callId?: unknown; sessionId?: unknown; rootSessionId?: unknown; depth?: unknown };
  if (typeof callId !== "string" || typeof sessionId !== "string" || sessionId.length === 0) return undefined;
  return {
    callId,
    sessionId,
    ...(typeof rootSessionId === "string" && rootSessionId.length > 0 ? { rootSessionId } : {}),
    ...(typeof depth === "number" && Number.isInteger(depth) && depth > 0 ? { depth } : {}),
  };
}

export function delegationDepthOf(parentSessionId: string, rootSessionId?: string): number {
  if (rootSessionId === undefined || rootSessionId === parentSessionId) return 1;
  return MAX_OBSERVABLE_DELEGATION_DEPTH;
}

export type NarrationAttestation =
  | {
      readonly kind: "ledger";
      readonly runs: number;
      readonly events: number;
      readonly firstTs: string;
      readonly lastTs: string;
    }
  | { readonly kind: "absent"; readonly reason: string };

export function attestSubagentRuns(rows: readonly UsageEventEntry[]): NarrationAttestation {
  const children = new Set<string>();
  let events = 0;
  let firstTs: string | undefined;
  let lastTs: string | undefined;
  for (const row of rows) {
    const stamp = subagentRunOf(row);
    if (!stamp) continue;
    children.add(stamp.sessionId);
    events++;
    if (firstTs === undefined || row.ts < firstTs) firstTs = row.ts;
    if (lastTs === undefined || row.ts > lastTs) lastTs = row.ts;
  }
  if (children.size === 0 || firstTs === undefined || lastTs === undefined) {
    return { kind: "absent", reason: "the spend ledger holds no delegated-subagent usage row for this session" };
  }
  return { kind: "ledger", runs: children.size, events, firstTs, lastTs };
}

export async function readSubagentAttestation(org: string, sessionId: string): Promise<NarrationAttestation> {
  try {
    return attestSubagentRuns(await usageForSession(org, sessionId));
  } catch (err) {
    return { kind: "absent", reason: `the spend ledger could not be read (${err instanceof Error ? err.message : String(err)})` };
  }
}
