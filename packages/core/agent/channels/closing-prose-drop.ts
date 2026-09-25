import { appendAudit } from "../audit/audit.js";

export const CLOSING_PROSE_DROPPED_ACTION = "turn.supervisor_prose_dropped";

export interface ClosingProseDropRow {
  readonly org: string;
  readonly platform: string;
  readonly workspace: string;
  readonly surface?: string;
  readonly principalId?: string;
}

export interface ClosingProseDrop {
  readonly row: ClosingProseDropRow;
  readonly chars: number;
  readonly sessionId?: string;
  readonly anchor: Record<string, unknown>;
  readonly log: (msg: string) => void;
}

export async function dropClosingProse(drop: ClosingProseDrop): Promise<void> {
  drop.log(`closing prose DROPPED (${drop.chars}c) — nothing posted; a reply must come from the reply tool`);
  await appendAudit({
    org: drop.row.org,
    platform: drop.row.platform,
    workspace: drop.row.workspace,
    surface: drop.row.surface,
    principalId: drop.row.principalId,
    action: CLOSING_PROSE_DROPPED_ACTION,
    detail: { ...drop.anchor, chars: drop.chars, ...(drop.sessionId ? { sessionId: drop.sessionId } : {}) },
  }).catch(() => undefined);
}
