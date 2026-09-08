import { appendAudit } from "./audit.js";
import type { WorkerToolsetClaim, WorkerToolsetIdentity } from "../access/worker-toolset-state.js";

export const WORKER_TOOLSET_ACTION = "worker.toolset";

export const MAX_RECORDED_NAMES = 256;

export async function auditWorkerToolset(input: {
  readonly who: WorkerToolsetIdentity;
  readonly reason: WorkerToolsetClaim;
  readonly tools: readonly string[];
  readonly withheld: readonly string[];
}): Promise<void> {
  const tools = [...input.tools].sort();
  const withheld = [...input.withheld].sort();
  await appendAudit({
    org: input.who.org,
    platform: "unified",
    workspace: input.who.domain,
    action: WORKER_TOOLSET_ACTION,
    detail: {
      worker: input.who.worker,
      parentSession: input.who.parentSession,
      parentCallId: input.who.parentCallId,
      rootSession: input.who.rootSession,
      turn: input.who.turn,
      grain: "task",
      reason: input.reason,
      tools: tools.slice(0, MAX_RECORDED_NAMES),
      namesTruncated: tools.length > MAX_RECORDED_NAMES,
      toolCount: tools.length,
      withheld: withheld.slice(0, MAX_RECORDED_NAMES),
      withheldCount: withheld.length,
    },
  });
}
