export interface AuditCursor {
  readonly mark: number;
  readonly wallMs: number;
  readonly monoMs: number;
}

export interface CursorSelectableRow {
  readonly seq?: number;
  readonly ts?: string;
}

export const AUDIT_CURSOR_LOOKBACK_MS = 10 * 60 * 1000;

export const AUDIT_CURSOR_MARK_LIMIT = 1000;

export function auditCursorSinceIso(cursor: AuditCursor): string {
  return new Date(cursor.wallMs - AUDIT_CURSOR_LOOKBACK_MS).toISOString();
}

export function markFromRows(rows: readonly CursorSelectableRow[]): number {
  let mark = 0;
  for (const row of rows) {
    if (typeof row.seq === "number" && row.seq > mark) mark = row.seq;
  }
  return mark;
}

export function selectRowsAfterCursor<T extends CursorSelectableRow>(rows: readonly T[], cursor: AuditCursor): T[] {
  const out: T[] = [];
  for (const row of rows) {
    if (typeof row.seq !== "number") {
      throw new Error(
        `integration harness: an audit row arrived with no numeric seq (got ${JSON.stringify(row.seq)}). ` +
          "GET /control/v1/audit serves `seq` on every row (OPE-1933); a row without one means the route and this harness disagree.",
      );
    }
    if (row.seq > cursor.mark) out.push(row);
  }
  return out;
}

export function cursorClockDriftMs(cursor: AuditCursor, nowWallMs: number, nowMonoMs: number): number {
  return nowWallMs - cursor.wallMs - (nowMonoMs - cursor.monoMs);
}
