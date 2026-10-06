import type { WorkRequestRow } from "../channels/work.js";
import { WORK_RESULT_DEDUPE_TTL_MS } from "../channels/work.js";
import { outboundKey, postOnce, type MarkEventSeen } from "../operational/post-once.js";
import { deploymentOrg } from "../identity/binding.js";
import { foldRoutineOutcome } from "./outcome-fold.js";

function fireFoldKey(requestId: string): string {
  return outboundKey({ surface: "work", action: "work.fire_fold", stableId: requestId, payload: requestId });
}

export interface FoldWorkFireOptions {
  readonly fold?: typeof foldRoutineOutcome;
  readonly sessionId?: string;
  readonly org?: string;
  readonly markEventSeen?: MarkEventSeen;
}

export async function foldWorkFire(row: WorkRequestRow, outcome: "ok" | "failed", opts: FoldWorkFireOptions = {}): Promise<boolean> {
  const marker = row.fire?.marker;
  if (marker === undefined) return false;
  const fold = opts.fold ?? foldRoutineOutcome;
  let folded = false;
  try {
    await postOnce({
      org: opts.org ?? deploymentOrg(),
      key: fireFoldKey(row.requestId),
      ttlMs: WORK_RESULT_DEDUPE_TTL_MS,
      ...(opts.markEventSeen ? { markEventSeen: opts.markEventSeen } : {}),
      run: async () => {
        folded = true;
        await fold({ marker, sessionOutcome: outcome, manual: row.fire?.manual === true, ...(opts.sessionId !== undefined && opts.sessionId.length > 0 ? { sessionId: opts.sessionId } : {}) });
      },
    });
  } catch (err) {
    console.warn(`[open-everywhere:fire-work] the outcome fold for routine ${marker.id} failed: ${String(err).slice(0, 160)}`);
  }
  return folded;
}

export function fireFoldOutcome(status: "completed" | "failed" | "cancelled", stopped: boolean, cancelRedeemed = false): "ok" | "failed" | undefined {
  if (stopped || status === "failed") return "failed";
  if (status === "cancelled" || cancelRedeemed) return undefined;
  return "ok";
}
