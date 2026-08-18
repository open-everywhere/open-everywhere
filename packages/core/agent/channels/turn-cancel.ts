import { appendAudit, readAudit } from "../audit/audit.js";
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
  readonly via: "reaction" | "command" | "tool";
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
    await auditCancel(input, { outcome: "error", anchorSurfaceKey: anchor.surfaceKey, note: String(err), sessionId: anchor.sessionId, turnId: anchor.turnId });
    return { outcome: "error", message: "Couldn't reach that turn to stand it down — try again in a moment.", sessionId: anchor.sessionId, turnId: anchor.turnId };
  }

  const outcome: CancelOutcome = status === "no_active_turn" ? "no_active_turn" : "requested";
  await auditCancel(input, { outcome, anchorSurfaceKey: anchor.surfaceKey, sessionId: anchor.sessionId, turnId: anchor.turnId, ...(status ? { status } : {}) });
  return {
    outcome,
    message: outcome === "no_active_turn" ? NOTHING_RUNNING : STANDING_DOWN,
    sessionId: anchor.sessionId,
    turnId: anchor.turnId,
  };
}

const NOTHING_RUNNING = "Nothing running here right now — I'm already waiting on you.";

const STANDING_DOWN = "Standing down — I'll stop this turn where it is.";

const CANCEL_REQUEST_SCAN = 50;

const PLAIN_PRINCIPAL_ID = /^[A-Za-z0-9._:@|+-]{1,64}$/;

export async function findCancelRequester(org: string, turnId: string): Promise<string | undefined> {
  try {
    const rows = await readAudit({ org, action: TURN_CANCEL_ACTION, limit: CANCEL_REQUEST_SCAN });
    for (const row of rows) {
      const rowTurnId = row.detail?.["turnId"];
      if (typeof rowTurnId !== "string" || rowTurnId !== turnId) continue;
      const by = row.principalId;
      return typeof by === "string" && PLAIN_PRINCIPAL_ID.test(by) ? by : undefined;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

async function auditCancel(
  input: CancelAnchoredTurnInput,
  detail: { outcome: CancelOutcome; anchorSurfaceKey?: string; status?: string; note?: string; sessionId?: string; turnId?: string },
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
        ...(detail.sessionId ? { sessionId: detail.sessionId } : {}),
        ...(detail.turnId ? { turnId: detail.turnId } : {}),
        ...(detail.anchorSurfaceKey ? { surfaceKey: detail.anchorSurfaceKey } : {}),
        ...(detail.status ? { eveStatus: detail.status } : {}),
        ...(detail.note ? { note: detail.note } : {}),
      },
    });
  } catch {
  }
}
