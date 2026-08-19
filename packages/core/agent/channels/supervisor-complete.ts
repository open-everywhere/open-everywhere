import { supervisorTextDelivery, type FinalMessageAction } from "./turn-delivery.js";
import { appendAudit } from "../audit/audit.js";
import { consumeRepliedThisTurn } from "./reply-signal.js";

export function consumeSupervisorReplyMark(ctx: unknown): boolean {
  return consumeRepliedThisTurn((ctx as { session?: { turn?: { id?: string } } } | undefined)?.session?.turn?.id);
}

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
  readonly repliedViaTool: boolean;
  readonly midTurnPost: boolean;
  readonly noReplyAction: string;
  readonly repliedAction: string;
  readonly contextRow: SupervisorAuditRow;
  readonly repliedRow: SupervisorAuditRow;
  readonly silentAnchor: Record<string, unknown>;
  readonly droppedAnchor: Record<string, unknown>;
  readonly repliedAnchor: Record<string, unknown>;
  readonly log: (msg: string) => void;
}

export const SUPERVISOR_REPLIED_ROUTE = "tool";

export async function completeSupervisorTurn(spec: SupervisorCompletionSpec): Promise<void> {
  const { action } = spec;
  if (action.kind === "buffer-tool-status") return;
  const sid = spec.sessionId ? { sessionId: spec.sessionId } : {};

  if (spec.repliedViaTool) {
    await appendAudit({
      org: spec.repliedRow.org,
      platform: spec.repliedRow.platform,
      workspace: spec.repliedRow.workspace,
      surface: spec.repliedRow.surface,
      principalId: spec.repliedRow.principalId,
      action: spec.repliedAction,
      detail: { ...spec.repliedAnchor, route: SUPERVISOR_REPLIED_ROUTE, ...sid },
    });
    return;
  }

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

  const delivery = supervisorTextDelivery(true, spec.midTurnPost);
  if (!delivery.postText) {
    spec.log(`supervisor message-tool-only: DROPPED terminal prose (${action.text.length}c) — reply must come from the reply tool`);
    await appendAudit({
      org: spec.contextRow.org,
      platform: spec.contextRow.platform,
      workspace: spec.contextRow.workspace,
      surface: spec.contextRow.surface,
      principalId: spec.contextRow.principalId,
      action: "turn.supervisor_prose_dropped",
      detail: { ...spec.droppedAnchor, chars: action.text.length, ...sid },
    });
    return;
  }

  spec.log(
    `supervisor terminal prose (${action.text.length}c) NOT delivered — this surface declares no mid-turn post route, so nothing can post it; wire a post arm (channels/post-arms.ts) or the answer is lost`,
  );
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
