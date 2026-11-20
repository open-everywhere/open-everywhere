import { appendAudit } from "./audit.js";
import type { WorkerToolsetClaim, WorkerToolsetIdentity } from "../access/worker-toolset-state.js";

export const WORKER_TOOLSET_ACTION = "worker.toolset";

export const MAX_RECORDED_NAMES = 256;

/**
 * Where the offered names came from, relative to the seat cut. `outsideSeatCut` names each offered
 * tool that the seat cut never evaluated: eve mounts it from its own defaults (`eve__*`, `agent`), a
 * static slot or a declared subagent. It is `null` when the recorder could not see the cut's round.
 * The row then also writes `seatCutSeen: false`, and its `withheld` list is empty because no round
 * was visible, not because the cut removed nothing. `refused` names each offered tool that a
 * call-time gate refuses whatever its input.
 *
 * `throughEveTool` names each deferred entry that the seat cut mounted for the worker in this turn so
 * far. eve's step catalog keeps a deferred entry out of the offered list, so `tools` never names it,
 * and the worker calls it by name through `eve__tool`. A connector operation is such an entry. It is
 * `null` when no round was visible, and the row then writes `throughEveToolCount: null`. It is empty
 * when the offered list holds no `eve__tool`. One path is not covered: `eve__tool` also reaches each
 * operation of an eve connection that an app mounts (`step-catalog.js#connectionEntryNamed`). Such an
 * operation passes no seat cut, so this list does not name it. No shipped connection is one.
 */
export interface WorkerToolsetProvenance {
  readonly outsideSeatCut?: readonly string[] | null;
  readonly refused?: readonly string[];
  readonly throughEveTool?: readonly string[] | null;
}

export async function auditWorkerToolset(
  input: {
    readonly who: WorkerToolsetIdentity;
    readonly reason: WorkerToolsetClaim;
    readonly tools: readonly string[];
    readonly withheld: readonly string[];
  } & WorkerToolsetProvenance,
): Promise<void> {
  const tools = [...input.tools].sort();
  const withheld = [...input.withheld].sort();
  const outsideSeatCut = input.outsideSeatCut === undefined || input.outsideSeatCut === null ? null : [...input.outsideSeatCut].sort();
  const refused = [...(input.refused ?? [])].sort();
  const throughEveTool = input.throughEveTool === undefined || input.throughEveTool === null ? null : [...input.throughEveTool].sort();
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
      seatCutSeen: outsideSeatCut !== null,
      outsideSeatCut: outsideSeatCut === null ? null : outsideSeatCut.slice(0, MAX_RECORDED_NAMES),
      outsideSeatCutCount: outsideSeatCut === null ? null : outsideSeatCut.length,
      refused: refused.slice(0, MAX_RECORDED_NAMES),
      throughEveTool: throughEveTool === null ? null : throughEveTool.slice(0, MAX_RECORDED_NAMES),
      throughEveToolCount: throughEveTool === null ? null : throughEveTool.length,
    },
  });
}
