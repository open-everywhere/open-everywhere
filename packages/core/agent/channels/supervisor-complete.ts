import { supervisorTextDelivery, isSupervisorProseLeak, type FinalMessageAction } from "./slack-events.js";
import { appendAudit } from "../audit/audit.js";

export interface SupervisorAuditRow {
  readonly org: string;
  readonly platform: string;
  readonly workspace: string;
  readonly surface?: string;
  readonly principalId?: string;
}

export interface SupervisorCompletionSpec {
  readonly action: FinalMessageAction;
  readonly sessionId?: string;
  readonly hasTarget: boolean;
  readonly midTurnPost: boolean;
  readonly proseLeak?: { readonly repliedThisTurn: boolean };
  readonly noReplyAction: string;
  readonly repliedAction: string;
  readonly contextRow: SupervisorAuditRow;
  readonly repliedRow: SupervisorAuditRow;
  readonly silentAnchor: Record<string, unknown>;
  readonly droppedAnchor: Record<string, unknown>;
  readonly repliedAnchor: Record<string, unknown>;
  readonly post: (text: string) => Promise<void>;
  readonly log: (msg: string) => void;
}

export async function completeSupervisorTurn(spec: SupervisorCompletionSpec): Promise<void> {
  const { action } = spec;
  if (action.kind === "buffer-tool-status") return;
  const sid = spec.sessionId ? { sessionId: spec.sessionId } : {};

  if (action.kind === "silent") {
    await appendAudit({
      org: spec.contextRow.org,
      platform: spec.contextRow.platform,
      workspace: spec.contextRow.workspace,
      surface: spec.contextRow.surface,
      principalId: spec.contextRow.principalId,
      action: spec.noReplyAction,
      detail: { ...spec.silentAnchor, reason: action.reason, ...sid },
    });
    return;
  }

  if (!spec.hasTarget) {
    spec.log("reply not posted — no per-turn target (turn.started snapshot empty); FAIL SAFE");
    return;
  }

  const delivery = supervisorTextDelivery(true, spec.midTurnPost);
  if (!delivery.postText) {
    const isLeak = spec.proseLeak ? isSupervisorProseLeak(true, spec.proseLeak.repliedThisTurn, false) : true;
    if (isLeak) {
      spec.log(`supervisor message-tool-only: DROPPED terminal prose (${action.text.length}c) — reply must come from the reply tool`);
      await appendAudit({
        org: spec.contextRow.org,
        platform: spec.contextRow.platform,
        workspace: spec.contextRow.workspace,
        surface: spec.contextRow.surface,
        principalId: spec.contextRow.principalId,
        action: "turn.supervisor_prose_dropped",
        detail: { ...spec.droppedAnchor, chars: action.text.length, ...sid },
      }).catch(() => undefined);
    }
    return;
  }

  try {
    await spec.post(action.text);
    await appendAudit({
      org: spec.repliedRow.org,
      platform: spec.repliedRow.platform,
      workspace: spec.repliedRow.workspace,
      surface: spec.repliedRow.surface,
      principalId: spec.repliedRow.principalId,
      action: spec.repliedAction,
      detail: { ...spec.repliedAnchor, chars: action.text.length, ...sid },
    });
  } catch (err) {
    spec.log(`reply delivery failed: ${String(err)}`);
  }
}

export async function auditSupervisorFailure(row: SupervisorAuditRow, action: string, detail: Record<string, unknown>): Promise<void> {
  await appendAudit({
    org: row.org,
    platform: row.platform,
    workspace: row.workspace,
    surface: row.surface,
    action,
    detail,
  }).catch(() => undefined);
}
