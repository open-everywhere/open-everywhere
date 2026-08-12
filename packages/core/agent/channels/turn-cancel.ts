import { appendAudit } from "../audit/audit.js";
import { resolveTurnAnchor, type TurnAnchorQuery } from "./turn-registry.js";

export const TURN_CANCEL_ACTION = "turn.cancel_requested";

export type AttachSessionForCancel = (sessionId: string) => {
  cancel(options?: { turnId?: string }): Promise<{ readonly status?: string } | undefined>;
};

export type CancelOutcome =
  | "requested"
  | "no_active_turn"
  | "no_turn_found"
  | "error";

export interface CancelResult {
  readonly outcome: CancelOutcome;
  readonly message: string;
  readonly sessionId?: string;
  readonly turnId?: string;
}

export interface CancelAnchoredTurnInput {
  readonly org: string;
  readonly platform: string;
  readonly workspace: string;
  readonly requestedBy?: string;
  readonly via: "reaction" | "command";
  readonly query: TurnAnchorQuery;
  readonly attachSession: AttachSessionForCancel;
}

export async function cancelAnchoredTurn(input: CancelAnchoredTurnInput): Promise<CancelResult> {
  const anchor = await resolveTurnAnchor(input.org, input.query);
  if (!anchor) {
    await auditCancel(input, { outcome: "no_turn_found" });
    return { outcome: "no_turn_found", message: NOTHING_RUNNING };
  }

  let status: string | undefined;
  try {
    const res = await input.attachSession(anchor.sessionId).cancel({ turnId: anchor.turnId });
    status = typeof res?.status === "string" ? res.status : undefined;
  } catch (err) {
    await auditCancel(input, { outcome: "error", anchorSurfaceKey: anchor.surfaceKey, note: String(err) });
    return { outcome: "error", message: "Couldn't reach that turn to stand it down — try again in a moment.", sessionId: anchor.sessionId, turnId: anchor.turnId };
  }

  const outcome: CancelOutcome = status === "no_active_turn" ? "no_active_turn" : "requested";
  await auditCancel(input, { outcome, anchorSurfaceKey: anchor.surfaceKey, ...(status ? { status } : {}) });
  return {
    outcome,
    message: outcome === "no_active_turn" ? NOTHING_RUNNING : STANDING_DOWN,
    sessionId: anchor.sessionId,
    turnId: anchor.turnId,
  };
}

const NOTHING_RUNNING = "Nothing running here right now — I'm already waiting on you.";

const STANDING_DOWN = "Standing down — I'll stop this turn where it is.";

async function auditCancel(
  input: CancelAnchoredTurnInput,
  detail: { outcome: CancelOutcome; anchorSurfaceKey?: string; status?: string; note?: string },
): Promise<void> {
  try {
    await appendAudit({
      org: input.org,
      platform: input.platform,
      workspace: input.workspace,
      action: TURN_CANCEL_ACTION,
      ...(input.requestedBy ? { principalId: input.requestedBy } : {}),
      detail: {
        via: input.via,
        outcome: detail.outcome,
        ...(detail.anchorSurfaceKey ? { surfaceKey: detail.anchorSurfaceKey } : {}),
        ...(detail.status ? { eveStatus: detail.status } : {}),
        ...(detail.note ? { note: detail.note } : {}),
      },
    });
  } catch {
  }
}
